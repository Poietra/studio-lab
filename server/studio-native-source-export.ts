import { createHash } from "node:crypto";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import { manimSceneNameSchema } from "../src/render-pipeline/manim-identity-contract";
import { importManimScene } from "../src/render-pipeline/source-import";
import {
  lowerCanonicalProgramBatchSource,
  loweredProgramDuration,
  ProgramLoweringError,
} from "../src/render-pipeline/source-lowering";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../src/studio/operation-registry";
import type { SceneEdit } from "../src/studio/scene-edit-contract";
import { sceneEditSchema } from "../src/studio/scene-edit-contract";

const TIME_EPSILON = 0.0005;
const SOURCE_PATH = "poietra_scene.py";

export type StudioNativeSourceExportInput = Readonly<{
  duration: number;
  frame: Readonly<{ height: number; width: number }>;
  programs: readonly SceneEdit[];
  sceneName?: string;
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
    const start = result.data.anchor.resolvedSeconds;
    const end = start + duration;
    if (start < -TIME_EPSILON || end > sceneDuration + TIME_EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Program ${result.data.transactionId} extends outside the ${sceneDuration.toFixed(3)}s Studio Scene.`,
      );
    }
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
  let occupiedUntil = 0;
  let insertedDuration = 0;
  return ordered.map((entry) => {
    const start = entry.program.anchor.resolvedSeconds;
    if (entry.duration > TIME_EPSILON && start < occupiedUntil - TIME_EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Program ${entry.program.transactionId} overlaps another positive-duration Program; Studio-native Manim export does not serialize concurrent Program intervals.`,
      );
    }
    if (entry.duration <= TIME_EPSILON && start < occupiedUntil - TIME_EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Program ${entry.program.transactionId} occurs inside another Program interval; Studio-native Manim export cannot preserve that concurrent edit.`,
      );
    }
    const sourceAnchor = start - insertedDuration;
    if (sourceAnchor < -TIME_EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Program ${entry.program.transactionId} cannot be mapped to a non-negative Manim source time.`,
      );
    }
    occupiedUntil = Math.max(occupiedUntil, start + entry.duration);
    insertedDuration += entry.duration;
    return { ...entry, sourceAnchor: Math.max(0, sourceAnchor) };
  });
}

function programsOnSourceTimeline(
  programs: readonly ScheduledProgram[],
  sceneDuration: number,
): readonly ScheduledProgram[] {
  return programs.map((entry) => ({
    ...entry,
    program: {
      ...entry.program,
      operations: entry.program.operations.map((operation) => {
        if (operation.kind !== "CreateEntity" || operation.entity.lifetime.end === null) return operation;
        const finalEnd = operation.entity.lifetime.end;
        if (finalEnd <= operation.entity.lifetime.start + TIME_EPSILON || finalEnd > sceneDuration + TIME_EPSILON) {
          throw new ProgramLoweringError(
            "operation-unsupported",
            `Created lifetime for ${operation.entity.id} must end inside the ${sceneDuration.toFixed(3)}s Studio Scene.`,
          );
        }
        const concurrent = programs.find(({ duration, program }) => {
          const start = program.anchor.resolvedSeconds;
          return (
            duration > TIME_EPSILON && finalEnd > start + TIME_EPSILON && finalEnd < start + duration - TIME_EPSILON
          );
        });
        if (concurrent) {
          throw new ProgramLoweringError(
            "operation-unsupported",
            `Created lifetime for ${operation.entity.id} ends inside Program ${concurrent.program.transactionId}; Studio-native Manim export cannot serialize that concurrent interval.`,
          );
        }
        const insertedBeforeEnd = programs.reduce((total, candidate) => {
          const candidateEnd = candidate.program.anchor.resolvedSeconds + candidate.duration;
          return candidateEnd <= finalEnd + TIME_EPSILON ? total + candidate.duration : total;
        }, 0);
        const sourceEnd = finalEnd - insertedBeforeEnd;
        const rebaseOffset = entry.program.anchor.resolvedSeconds - entry.sourceAnchor;
        return {
          ...operation,
          entity: {
            ...operation.entity,
            lifetime: { ...operation.entity.lifetime, end: sourceEnd + rebaseOffset },
          },
        };
      }),
    },
  }));
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

  const finiteLifetimeAnchors = programs.flatMap(({ program, sourceAnchor }) => {
    const rebaseOffset = program.anchor.resolvedSeconds - sourceAnchor;
    return program.operations.flatMap((operation) =>
      operation.kind === "CreateEntity" && operation.entity.lifetime.end !== null
        ? [operation.entity.lifetime.end - rebaseOffset]
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
  } else if (programs.length === 0) {
    lines.push(`        self.wait(${formatSeconds(duration)})`);
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
    program.operations.flatMap(
      (operation): readonly Readonly<{ id: string; lifetimeEnd: number | null; type: string }>[] => {
        if (operation.kind === "CreateEntity") {
          return [
            {
              id: operation.entity.id,
              lifetimeEnd: operation.entity.lifetime.end,
              type: operation.entity.type,
            },
          ];
        }
        if (operation.kind === "TransformContent") {
          return [{ id: operation.targetEntityId, lifetimeEnd: null, type: operation.targetType ?? "MathTex" }];
        }
        return [];
      },
    ),
  );
  for (const expected of expectedEntities) {
    const entity = imported.runtimeSceneState.objectGraph.entities[expected.id];
    if (!entity || entity.type !== expected.type) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not reimport ${expected.id} as ${expected.type}.`,
      );
    }
    if (
      expected.lifetimeEnd !== null &&
      Math.abs((entity.lifetime.at(-1)?.end ?? Number.NaN) - expected.lifetimeEnd) >= TIME_EPSILON
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Studio-native Manim source did not preserve the ${expected.lifetimeEnd.toFixed(4)}s lifetime end for ${expected.id}.`,
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
  const sceneName = manimSceneNameSchema.parse(input.sceneName ?? "PoietraScene");
  const admitted = admittedPrograms(input.programs, input.duration);
  const programs = programsOnSourceTimeline(admitted, input.duration);
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
