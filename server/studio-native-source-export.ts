import { createHash } from "node:crypto";

import type { StudioTimelineEditTransformV1 } from "../src/engine/scene-authoring";
import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import { importManimScene } from "../src/render-pipeline/source-import";
import {
  lowerCanonicalProgramBatchSource,
  loweredProgramDuration,
  ProgramLoweringError,
} from "../src/render-pipeline/source-lowering";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../src/studio/operation-registry";
import type { SceneEdit, SceneEditOperation } from "../src/studio/scene-edit-contract";
import { sceneEditSchema } from "../src/studio/scene-edit-contract";

const TIME_EPSILON = 0.0005;
const SOURCE_PATH = "poietra_scene.py";
const SCENE_NAME = "PoietraScene";

export type StudioNativeSourceExportInput = Readonly<{
  baseDuration: number;
  duration: number;
  frame: Readonly<{ height: number; width: number }>;
  programs: readonly SceneEdit[];
  timelineTransforms: readonly StudioTimelineEditTransformV1[];
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type StudioNativeSourceExport = Readonly<{
  sceneName: string;
  source: string;
}>;

type ScheduledProgram = Readonly<{
  duration: number;
  inputIndex: number;
  program: SceneEdit;
  sourceAnchor: number;
}>;

function assertPositiveSize(value: Readonly<{ height: number; width: number }>, label: string) {
  if (!Number.isFinite(value.height) || value.height <= 0 || !Number.isFinite(value.width) || value.width <= 0) {
    throw new TypeError(`${label} must have finite positive dimensions.`);
  }
}

function isStudioNativeDurationOperation(operation: SceneEditOperation) {
  return (
    operation.kind === "TrimSceneDuration" ||
    (operation.kind === "InsertTimelineEvent" &&
      operation.eventKind === "wait" &&
      operation.purpose === "scene-duration")
  );
}

function admittedPrograms(programs: readonly SceneEdit[], baseDuration: number): readonly ScheduledProgram[] {
  if (programs.length > 32) throw new TypeError("A Studio-native source export accepts at most 32 Programs.");

  const parsed = programs.map((program, index) => {
    const result = sceneEditSchema.safeParse(program);
    if (!result.success) {
      throw new TypeError(`Studio-native Program ${index + 1} does not match the canonical schema.`);
    }
    const execution = programExecutionCapabilities(result.data);
    if (execution.lowering !== "supported" || execution.apply !== "supported") {
      const unsupportedOperation = result.data.operations.find(
        (operation) => operationExecutionCapabilities(operation).lowering !== "supported",
      );
      throw new ProgramLoweringError(
        "operation-unsupported",
        execution.applyBlocker ??
          `Studio-native ${unsupportedOperation?.kind ?? "Program"} in ${result.data.transactionId} has no truthful Manim source lowering.`,
      );
    }
    const containsTimelineOperation = result.data.operations.some(
      (operation) =>
        operation.kind === "InsertSceneBoundary" ||
        operation.kind === "InsertTimelineEvent" ||
        operation.kind === "TrimSceneDuration",
    );
    if (
      (containsTimelineOperation && !result.data.operations.every(isStudioNativeDurationOperation)) ||
      result.data.operations.some(
        (operation) =>
          (operation.kind === "CreateEntity" && operation.entity.type.startsWith("TransitionOverlay:")) ||
          (operation.kind === "ChangePresence" && (operation.effect === "cover" || operation.effect === "reveal")),
      )
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "Studio-native source export admits only Rust-authorized Scene duration waits and trims from the timeline operation family.",
      );
    }
    const duration = loweredProgramDuration(result.data);
    return { duration, inputIndex: index, program: result.data };
  });
  if (parsed.reduce((total, entry) => total + entry.program.operations.length, 0) > 256) {
    throw new TypeError("A Studio-native source export accepts at most 256 operations.");
  }
  if (parsed.reduce((total, entry) => total + entry.program.intentCount, 0) > 64) {
    throw new TypeError("A Studio-native source export accepts at most 64 composed intents.");
  }
  if (new Set(parsed.map(({ program }) => program.transactionId)).size !== parsed.length) {
    throw new TypeError("A Studio-native source export requires unique Program transaction IDs.");
  }

  const ordered = parsed.sort(
    (left, right) =>
      left.program.anchor.resolvedSeconds - right.program.anchor.resolvedSeconds || left.inputIndex - right.inputIndex,
  );
  return ordered.map((entry) => {
    const sourceAnchor = entry.program.anchor.resolvedSeconds;
    const durationProgram = entry.program.operations.every(isStudioNativeDurationOperation);
    if (
      sourceAnchor < -TIME_EPSILON ||
      sourceAnchor > baseDuration + TIME_EPSILON ||
      (!durationProgram && sourceAnchor + entry.duration > baseDuration + TIME_EPSILON)
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Program ${entry.program.transactionId} extends outside the ${baseDuration.toFixed(3)}s Studio source timeline.`,
      );
    }
    return { ...entry, sourceAnchor: Math.max(0, sourceAnchor) };
  });
}

function formatSeconds(value: number) {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return Number(normalized.toFixed(4)).toString();
}

function sourceScaffold(sceneName: string, baseDuration: number, programs: readonly ScheduledProgram[]) {
  const finiteLifetimeAnchors = programs.flatMap(({ program }) => {
    return program.operations.flatMap((operation) =>
      operation.kind === "CreateEntity" && operation.entity.lifetime.end !== null
        ? [operation.entity.lifetime.end]
        : [],
    );
  });
  const anchors = [
    ...new Set([...programs.map(({ sourceAnchor }) => sourceAnchor), ...finiteLifetimeAnchors].map(formatSeconds)),
  ]
    .map(Number)
    .sort((left, right) => left - right);
  const lines = ["from manim import *", "", `class ${sceneName}(Scene):`, "    def construct(self):"];
  let cursor = 0;
  for (const anchor of anchors) {
    if (anchor > cursor + TIME_EPSILON) lines.push(`        self.wait(${formatSeconds(anchor - cursor)})`);
    lines.push(`        # poietra:anchor ${formatSeconds(anchor)}`);
    cursor = anchor;
  }
  if (baseDuration > cursor + TIME_EPSILON) {
    lines.push(`        self.wait(${formatSeconds(baseDuration - cursor)})`);
  }
  return `${lines.join("\n")}\n`;
}

function verifyRoundTrip(
  source: string,
  sceneName: string,
  duration: number,
  frame: Readonly<{ height: number; width: number }>,
  programs: readonly ScheduledProgram[],
) {
  const imported = importManimScene(source, SOURCE_PATH, sceneName, frame);
  if (!imported) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Studio-native Manim source could not be reimported after lowering.",
    );
  }
  if (Math.abs(imported.runtimeSceneState.duration - duration) >= TIME_EPSILON) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      `Studio-native Manim source reimported at ${imported.runtimeSceneState.duration.toFixed(4)}s instead of ${duration.toFixed(4)}s.`,
    );
  }
  const expectedEntities = programs.flatMap(({ program }) =>
    program.operations.flatMap((operation): readonly Readonly<{ id: string; type: string }>[] => {
      if (operation.kind === "CreateEntity") {
        return [{ id: operation.entity.id, type: operation.entity.type }];
      }
      if (operation.kind === "TransformContent") {
        return [{ id: operation.targetEntityId, type: operation.targetType ?? "MathTex" }];
      }
      return [];
    }),
  );
  for (const expected of expectedEntities) {
    const entity = imported.runtimeSceneState.objectGraph.entities[expected.id];
    if (!entity || entity.type !== expected.type) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not reimport ${expected.id} as ${expected.type}.`,
      );
    }
  }
}

/**
 * Emits a bounded Manim Scene from source-free Studio history. The existing
 * source lowerer remains the only Python emitter; this adapter supplies the
 * idle source timeline that its insertion semantics require.
 */
export function exportStudioNativeManimSource(input: StudioNativeSourceExportInput): StudioNativeSourceExport {
  if (!Number.isFinite(input.duration) || input.duration < 0.1) {
    throw new TypeError("Studio-native source export requires a finite Scene duration of at least 0.1s.");
  }
  if (!Number.isFinite(input.baseDuration) || input.baseDuration < 0.1) {
    throw new TypeError("Studio-native source export requires a finite base Scene duration of at least 0.1s.");
  }
  assertPositiveSize(input.frame, "The Manim frame");
  assertPositiveSize(input.viewport, "The Studio viewport");
  const sceneName = SCENE_NAME;
  const admitted = admittedPrograms(input.programs, input.baseDuration);
  const programs = admitted;
  const source = sourceScaffold(sceneName, input.baseDuration, programs);
  if (programs.length === 0) {
    verifyRoundTrip(source, sceneName, input.duration, input.frame, admitted);
    return { sceneName, source };
  }

  const request: ProgramRenderRequest = {
    destination: null,
    program: programs[0]!.program,
    ...(programs.length > 1 ? { programs: programs.map(({ program }) => program) } : {}),
    projectId: "native-export",
    sceneName,
    sourceBindings: [],
    sourceHash: createHash("sha256").update(source, "utf8").digest("hex"),
    sourcePath: SOURCE_PATH,
    viewport: input.viewport,
  };
  const lowered = lowerCanonicalProgramBatchSource(
    source,
    request,
    programs.map(({ program, sourceAnchor }) => ({ program, sourceAnchor })),
    input.frame,
    null,
    input.timelineTransforms,
  );
  verifyRoundTrip(lowered.source, sceneName, input.duration, input.frame, admitted);
  return { sceneName, source: lowered.source };
}
