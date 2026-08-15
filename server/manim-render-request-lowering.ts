import type { StudioTimelineEditTransformV1 } from "../src/engine/scene-authoring";
import { type ProgramRenderRequest, renderRequestPrograms } from "../src/render-pipeline/contracts";
import {
  type LoweredProgramBatchSource,
  lowerCanonicalProgramBatchSource,
  lowerRuntimeTraceEditSource,
  ProgramLoweringError,
} from "../src/render-pipeline/source-lowering";
import type { RuntimeSceneState } from "../src/studio/model";
import {
  type CanonicalEditProgram,
  isSceneDurationOperation,
  isStaticRootTransformOperation,
} from "../src/studio/operations";
import {
  isExactStudioMathTexTransformProgramBatch,
  isExactStudioMotionProgramBatch,
  studioCreationMathTexParts,
} from "../src/studio/scene-authoring-wire";
import { isSceneDurationProgramBatch, projectTimelineProgramBatch } from "../src/studio/timeline-projection";
import { HttpError } from "./http/json";
import { importedScene, importSourceSnapshot, sceneView } from "./manim-workspace";

export type ManimRenderRequestLoweringInput = Readonly<{
  snapshotProgramAuthorizer: SnapshotProgramAuthorizer | null;
  frame: Readonly<{ height: number; width: number }>;
  originalSource: string;
  projectId: string;
  request: ProgramRenderRequest;
}>;

export type SnapshotProgramAuthorizer = (
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    programs: readonly CanonicalEditProgram[];
    projectId: string;
    request: ProgramRenderRequest;
    runtimeSceneState: RuntimeSceneState;
  }>,
) => Promise<void>;

export type ManimRenderRequestLoweringResult = Readonly<{
  lowered: LoweredProgramBatchSource;
  renderRequest: ProgramRenderRequest;
}>;

function isStudioCreationProgramBatch(programs: readonly CanonicalEditProgram[]) {
  const operations = programs.flatMap((program) => program.operations);
  const createdEntityIds = new Set(
    operations.flatMap((operation) => (operation.kind === "CreateEntity" ? [operation.entity.id] : [])),
  );
  if (createdEntityIds.size === 0) return false;
  return operations.every((operation) => {
    if (operation.kind === "CreateEntity") {
      const { dimensions, type } = operation.entity;
      if (type === "Circle") {
        return (
          typeof dimensions?.radius === "number" &&
          Number.isFinite(dimensions.radius) &&
          dimensions.radius > 0 &&
          dimensions.width === undefined &&
          dimensions.height === undefined
        );
      }
      if (type === "Rectangle") {
        return (
          typeof dimensions?.width === "number" &&
          Number.isFinite(dimensions.width) &&
          dimensions.width > 0 &&
          typeof dimensions.height === "number" &&
          Number.isFinite(dimensions.height) &&
          dimensions.height > 0 &&
          dimensions.radius === undefined
        );
      }
      return type === "MathTex" && studioCreationMathTexParts(operation.entity.content) !== null;
    }
    if (operation.kind === "CreateMotion") return true;
    if (!("entityId" in operation) || !createdEntityIds.has(operation.entityId)) return false;
    return (
      operation.kind === "ResizeEntity" ||
      (operation.kind === "SetProperty" && operation.key === "position") ||
      (operation.kind === "AnimateProperty" && operation.key === "scale") ||
      (operation.kind === "ChangePresence" &&
        (operation.effect === "fade-in" || (operation.effect === "remove" && operation.persistent)))
    );
  });
}

export async function lowerManimRenderRequest({
  snapshotProgramAuthorizer,
  frame,
  originalSource,
  projectId,
  request,
}: ManimRenderRequestLoweringInput): Promise<ManimRenderRequestLoweringResult> {
  const importedSnapshot = importSourceSnapshot(originalSource, request.sourcePath, frame);
  const activeScene = sceneView(importedSnapshot.view, request.sceneName);
  if (!activeScene) {
    throw new HttpError(`${request.sceneName} is not an imported Scene in ${request.sourcePath}.`, 400);
  }
  if (activeScene.sourceHash !== request.sourceHash) {
    throw new HttpError("The source changed while Studio was lowering the program. Reimport and try again.", 409);
  }
  for (const binding of request.sourceBindings) {
    if (activeScene.sourceVariables[binding.entityId] !== binding.sourceVariable) {
      throw new HttpError(
        `Source target binding ${binding.entityId} → ${binding.sourceVariable} does not match the imported Scene.`,
        400,
      );
    }
  }
  const orderedPrograms = renderRequestPrograms(request)
    .map((program, inputIndex) => ({ inputIndex, program, sourceAnchor: program.anchor.resolvedSeconds }))
    .sort((left, right) => left.sourceAnchor - right.sourceAnchor || left.inputIndex - right.inputIndex);
  if (orderedPrograms.some(({ program }) => program.loweringStatus !== "supported")) {
    throw new HttpError("Every Program in a render batch must have supported source lowering.", 400);
  }
  const sourceOrderedPrograms = orderedPrograms.map(({ program }) => program);
  const containsPersistentRemove = sourceOrderedPrograms.some((program) =>
    program.operations.some(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent,
    ),
  );
  const isStaticRootTransformBatch =
    sourceOrderedPrograms.length > 0 &&
    sourceOrderedPrograms.every(
      (program) => program.operations.length > 0 && program.operations.every(isStaticRootTransformOperation),
    );
  const isStudioMotionBatch = isExactStudioMotionProgramBatch(sourceOrderedPrograms);
  const isStudioMathTexTransformBatch = isExactStudioMathTexTransformProgramBatch(sourceOrderedPrograms);
  const isStudioCreationBatch = isStudioCreationProgramBatch(sourceOrderedPrograms);
  if (request.sourceValidation === "runtime-trace") {
    if (containsPersistentRemove) {
      throw new HttpError("Runtime Trace does not authorize persistent remove Programs.", 400);
    }
    try {
      const runtimeTraceEdit = lowerRuntimeTraceEditSource(
        originalSource,
        request,
        orderedPrograms.map(({ program, sourceAnchor }) => ({ program, sourceAnchor })),
        frame,
        null,
      );
      if (!runtimeTraceEdit) {
        throw new HttpError("The requested Runtime Trace validation does not support this edit.", 400);
      }
      return { lowered: runtimeTraceEdit, renderRequest: request };
    } catch (error) {
      if (error instanceof ProgramLoweringError) throw new HttpError(error.message, 400);
      throw error;
    }
  }
  const containsSceneDurationOperation = sourceOrderedPrograms.some((program) =>
    program.operations.some(isSceneDurationOperation),
  );
  let validatedPrograms: readonly CanonicalEditProgram[];
  let timelineTransforms: readonly StudioTimelineEditTransformV1[] | null = null;
  if (isSceneDurationProgramBatch(sourceOrderedPrograms)) {
    try {
      const projected = await projectTimelineProgramBatch(
        activeScene.runtimeSceneState.duration,
        sourceOrderedPrograms,
      );
      validatedPrograms = projected.programs;
      timelineTransforms = projected.projection.transforms;
    } catch (error) {
      throw new HttpError(
        `The Rust core rejected the Scene duration Program batch: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
  } else if (
    (containsPersistentRemove ||
      isStaticRootTransformBatch ||
      isStudioMotionBatch ||
      isStudioMathTexTransformBatch ||
      isStudioCreationBatch) &&
    !containsSceneDurationOperation
  ) {
    if (!snapshotProgramAuthorizer) {
      throw new HttpError("This Program batch requires verified Rust Scene authorization.", 400);
    }
    try {
      await snapshotProgramAuthorizer({
        frame,
        programs: sourceOrderedPrograms,
        projectId,
        request,
        runtimeSceneState: activeScene.runtimeSceneState,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        `The Rust core rejected the snapshot Program batch: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    // Rust owns Scene admission and lifetime semantics. Python alias and
    // reference safety remain in the source lowerer below.
    validatedPrograms = sourceOrderedPrograms;
  } else {
    if (containsSceneDurationOperation) {
      throw new HttpError(
        "Scene duration Programs cannot be mixed with another operation family in one render batch.",
        400,
      );
    }
    throw new HttpError("The Rust Scene core does not support this complete Program batch.", 400);
  }
  const renderRequest: ProgramRenderRequest = request.programs
    ? { ...request, program: validatedPrograms[0]!, programs: validatedPrograms }
    : { ...request, program: validatedPrograms[0]! };
  const boundaryProgramIndexes = validatedPrograms.flatMap((program, index) =>
    program.operations.some((operation) => operation.kind === "InsertSceneBoundary") ? [index] : [],
  );
  if (
    boundaryProgramIndexes.length > 1 ||
    (boundaryProgramIndexes.length === 1 && boundaryProgramIndexes[0] !== validatedPrograms.length - 1)
  ) {
    throw new HttpError("A Scene-boundary Program must be the final Program in a render batch.", 400);
  }
  const hasSceneBoundary = boundaryProgramIndexes.length === 1;
  let incoming: Readonly<{
    initialization: readonly string[];
    visibleSourceVariables: readonly string[];
  }> | null = null;
  if (hasSceneBoundary) {
    if (!activeScene.nextSceneId || !renderRequest.destination) {
      throw new HttpError("This Scene transition requires the imported next Scene destination.", 400);
    }
    const destinationScene = sceneView(importedSnapshot.view, renderRequest.destination.sceneName);
    if (
      renderRequest.destination.sourcePath !== request.sourcePath ||
      !destinationScene ||
      destinationScene.sceneId !== activeScene.nextSceneId
    ) {
      throw new HttpError("The requested transition destination is not the active Scene's next imported Scene.", 400);
    }
    const importedDestination = importedScene(importedSnapshot.importedScenes, destinationScene.name);
    if (!importedDestination) {
      throw new HttpError("The next Scene could not be imported for transition preview.", 400);
    }
    incoming = {
      initialization: importedDestination.initialization,
      visibleSourceVariables: importedDestination.initialVisibleSourceVariables,
    };
  } else if (renderRequest.destination) {
    throw new HttpError("A render without a Scene boundary must not include a destination Scene.", 400);
  }
  try {
    const lowered = lowerCanonicalProgramBatchSource(
      originalSource,
      renderRequest,
      validatedPrograms.map((program, index) => ({
        program,
        sourceAnchor: orderedPrograms[index].sourceAnchor,
      })),
      frame,
      incoming,
      timelineTransforms,
    );
    return { lowered, renderRequest };
  } catch (error) {
    if (error instanceof ProgramLoweringError) throw new HttpError(error.message, 400);
    throw error;
  }
}
