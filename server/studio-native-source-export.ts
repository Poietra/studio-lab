import { createHash } from "node:crypto";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import { importManimScene } from "../src/render-pipeline/source-import";
import {
  lowerCanonicalProgramBatchSource,
  loweredProgramDuration,
  ProgramLoweringError,
} from "../src/render-pipeline/source-lowering";
import type { EntityContent, EntityDimensions } from "../src/studio/model";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../src/studio/operation-registry";
import { sourceTimeToWorkingTime } from "../src/studio/program-composition";
import type { SceneEdit } from "../src/studio/scene-edit-contract";
import { sceneEditSchema } from "../src/studio/scene-edit-contract";

const TIME_EPSILON = 0.0005;
const SOURCE_PATH = "poietra_scene.py";
const SCENE_NAME = "PoietraScene";

export type StudioNativeSourceExportInput = Readonly<{
  duration: number;
  frame: Readonly<{ height: number; width: number }>;
  programs: readonly SceneEdit[];
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

type ExpectedEntity = Readonly<{
  content: EntityContent | undefined;
  dimensions: EntityDimensions | undefined;
  id: string;
  lifetimeEnd: number;
  lifetimeStart: number;
  position: Readonly<{ x: number; y: number }> | null;
  type: string;
}>;

function assertPositiveSize(value: Readonly<{ height: number; width: number }>, label: string) {
  if (!Number.isFinite(value.height) || value.height <= 0 || !Number.isFinite(value.width) || value.width <= 0) {
    throw new TypeError(`${label} must have finite positive dimensions.`);
  }
}

function admittedPrograms(programs: readonly SceneEdit[], sceneDuration: number): readonly ScheduledProgram[] {
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
    if (
      result.data.operations.some(
        (operation) =>
          operation.kind === "InsertSceneBoundary" ||
          operation.kind === "InsertTimelineEvent" ||
          operation.kind === "TrimSceneDuration" ||
          (operation.kind === "CreateEntity" && operation.entity.type.startsWith("TransitionOverlay:")) ||
          (operation.kind === "ChangePresence" && (operation.effect === "cover" || operation.effect === "reveal")),
      )
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "Studio-native source export derives duration from the canonical Scene and does not admit source timeline or Scene-boundary operations yet.",
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

  const baseDuration = sceneDuration - parsed.reduce((total, entry) => total + entry.duration, 0);
  if (baseDuration < -TIME_EPSILON) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Studio-native Program durations exceed the canonical Scene duration.",
    );
  }

  const ordered = parsed.sort(
    (left, right) =>
      left.program.anchor.resolvedSeconds - right.program.anchor.resolvedSeconds || left.inputIndex - right.inputIndex,
  );
  return ordered.map((entry) => {
    const sourceAnchor = entry.program.anchor.resolvedSeconds;
    if (sourceAnchor < -TIME_EPSILON || sourceAnchor + entry.duration > baseDuration + TIME_EPSILON) {
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

function sourceScaffold(sceneName: string, duration: number, programs: readonly ScheduledProgram[]) {
  const totalInsertedDuration = programs.reduce((total, program) => total + program.duration, 0);
  const baseDuration = duration - totalInsertedDuration;
  if (baseDuration < -TIME_EPSILON) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Studio-native Program durations exceed the canonical Scene duration.",
    );
  }

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
  const orderedPrograms = programs.map(({ program }) => program);
  const persistentRemovalEnds = new Map<string, number>();
  programs.forEach(({ program }, programIndex) => {
    const precedingPrograms = orderedPrograms.slice(0, programIndex);
    const workingOffset =
      sourceTimeToWorkingTime(precedingPrograms, program.anchor.resolvedSeconds) - program.anchor.resolvedSeconds;
    for (const operation of program.operations) {
      if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
        persistentRemovalEnds.set(operation.entityId, operation.interval.end + workingOffset);
      }
    }
  });
  const expectedEntities = programs.flatMap(({ program }, programIndex) => {
    const precedingPrograms = orderedPrograms.slice(0, programIndex);
    return program.operations.flatMap((operation): readonly ExpectedEntity[] => {
      if (operation.kind === "CreateEntity") {
        const sourceEnd = operation.entity.lifetime.end;
        const programsBeforeEnd =
          sourceEnd === null
            ? orderedPrograms
            : orderedPrograms.filter((candidate) => candidate.anchor.resolvedSeconds < sourceEnd - TIME_EPSILON);
        const position = program.operations.find(
          (candidate) =>
            candidate.kind === "SetProperty" &&
            candidate.entityId === operation.entity.id &&
            candidate.key === "position" &&
            typeof candidate.value === "object" &&
            candidate.value !== null &&
            "x" in candidate.value &&
            "y" in candidate.value,
        );
        return [
          {
            content: operation.entity.content,
            dimensions: operation.entity.dimensions,
            id: operation.entity.id,
            lifetimeEnd:
              persistentRemovalEnds.get(operation.entity.id) ??
              (sourceEnd === null ? duration : sourceTimeToWorkingTime(programsBeforeEnd, sourceEnd)),
            lifetimeStart: sourceTimeToWorkingTime(precedingPrograms, operation.entity.lifetime.start),
            position:
              position?.kind === "SetProperty" &&
              typeof position.value === "object" &&
              position.value !== null &&
              "x" in position.value &&
              "y" in position.value &&
              typeof position.value.x === "number" &&
              typeof position.value.y === "number"
                ? { x: position.value.x, y: position.value.y }
                : null,
            type: operation.entity.type,
          },
        ];
      }
      if (operation.kind === "TransformContent") {
        return [
          {
            content: operation.replacement,
            dimensions: undefined,
            id: operation.targetEntityId,
            lifetimeEnd: persistentRemovalEnds.get(operation.targetEntityId) ?? duration,
            lifetimeStart: sourceTimeToWorkingTime(precedingPrograms, operation.interval.start),
            position: null,
            type: operation.targetType ?? "MathTex",
          },
        ];
      }
      return [];
    });
  });
  for (const expected of expectedEntities) {
    const entity = imported.runtimeSceneState.objectGraph.entities[expected.id];
    if (!entity || entity.type !== expected.type) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not reimport ${expected.id} as ${expected.type}.`,
      );
    }
    const actualLifetimeStart = entity.lifetime[0]?.start;
    const actualLifetimeEnd = entity.lifetime.at(-1)?.end;
    if (
      !Number.isFinite(actualLifetimeStart) ||
      Math.abs((actualLifetimeStart ?? Number.NaN) - expected.lifetimeStart) >= TIME_EPSILON
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the ${expected.lifetimeStart.toFixed(4)}s lifetime start for ${expected.id}.`,
      );
    }
    if (
      !Number.isFinite(actualLifetimeEnd) ||
      Math.abs((actualLifetimeEnd ?? Number.NaN) - expected.lifetimeEnd) >= TIME_EPSILON
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the ${expected.lifetimeEnd.toFixed(4)}s lifetime end for ${expected.id}.`,
      );
    }
    if (
      expected.position &&
      (entity.geometry?.position.kind !== "known" ||
        Math.abs(entity.geometry.position.value.x - expected.position.x) >= TIME_EPSILON ||
        Math.abs(entity.geometry.position.value.y - expected.position.y) >= TIME_EPSILON)
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the initial position for ${expected.id}.`,
      );
    }
    const actualDimensions = entity.geometry?.dimensions.kind === "known" ? entity.geometry.dimensions.value : null;
    if (
      expected.dimensions &&
      (!actualDimensions ||
        Object.entries(expected.dimensions).some(([key, value]) => {
          const actual = actualDimensions[key as keyof EntityDimensions];
          return (
            typeof value === "number" &&
            (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(actual - value) >= TIME_EPSILON)
          );
        }))
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the initial dimensions for ${expected.id}.`,
      );
    }
    if (expected.content?.text !== undefined && entity.content?.text !== expected.content.text) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the Text content for ${expected.id}.`,
      );
    }
    if (
      expected.content?.texParts !== undefined &&
      JSON.stringify(entity.content?.texParts) !== JSON.stringify(expected.content.texParts)
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the MathTex content for ${expected.id}.`,
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
  assertPositiveSize(input.frame, "The Manim frame");
  assertPositiveSize(input.viewport, "The Studio viewport");
  const sceneName = SCENE_NAME;
  const admitted = admittedPrograms(input.programs, input.duration);
  const programs = admitted;
  const source = sourceScaffold(sceneName, input.duration, programs);
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
  );
  verifyRoundTrip(lowered.source, sceneName, input.duration, input.frame, admitted);
  return { sceneName, source: lowered.source };
}
