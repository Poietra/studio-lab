import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { lowerCanonicalProgramSource } from "./source-lowering";
import type { importManimScene } from "./source-import";

export const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        self.wait(1)
`;

export const roundTripSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.play(equation.animate.shift(2 * RIGHT + UP), run_time=1)
        self.wait(6)
        # poietra:anchor 7.000
        self.wait(1)
`;

export const temporalMetadataSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:cursor 7.000
        self.wait(1)
        # poietra:anchor 8.000
        # poietra:scene-boundary {"at":8,"destination":"scene.py#Next"}
        self.wait(1)
`;

export function canonicalProgram(
  operations: readonly CanonicalEditOperation[],
  transactionId = "render-test",
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 7,
      evidence: ["captured-playhead:7.000"],
      resolvedSeconds: 7,
      source: { kind: "playhead", referenceSeconds: 7 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: operations.map((operation) => operation.id) },
    transactionId,
    version: 1,
  };
}

export function motionOperation(overrides: Partial<Extract<CanonicalEditOperation, { kind: "CreateMotion" }>> = {}) {
  return {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: -45 },
    dependsOn: [],
    easing: "smooth",
    id: "tx:render-test/operation:motion",
    interval: { end: 8.5, start: 7 },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: ["equation_1"],
    ...overrides,
  } satisfies CanonicalEditOperation;
}

export function motionProgramAt(anchor: number, duration: number, transactionId: string) {
  const operation = motionOperation({
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + duration, start: anchor },
  });
  return {
    ...canonicalProgram([operation], transactionId),
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead" as const, referenceSeconds: anchor },
    },
  } satisfies CanonicalEditProgram;
}

export function request(
  program = canonicalProgram([motionOperation()]),
  sourceBindings: ProgramRenderRequest["sourceBindings"] = [{ entityId: "equation_1", sourceVariable: "equation" }],
): ProgramRenderRequest {
  return {
    destination: null,
    program,
    projectId: "default",
    sceneName: "GroupedEquation",
    sourceBindings,
    sourceHash: "a".repeat(64),
    sourcePath: "examples/relativity.py",
    viewport: { height: 360, width: 640 },
  };
}

export function operationBase(id: string, start: number, end = start) {
  return {
    dependsOn: [],
    id,
    interval: { end, start },
    provenance: { evidence: [], origin: "remote-model" as const },
  };
}

export function lowerTextContentSource(source: string, transactionId: string) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`set-${transactionId}`, 7),
    entityId: "label_1",
    key: "content",
    kind: "SetProperty",
    value: { displayLines: ["after"], text: "after" },
  };
  return lowerCanonicalProgramSource(
    source,
    request(canonicalProgram([operation], transactionId), [{ entityId: "label_1", sourceVariable: "label" }]),
    { height: 8, width: 14.222 },
    null,
  );
}

export function durationWaitProgram(duration: number, transactionId: string) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:duration-wait`, 7, 7 + duration),
    eventKind: "wait",
    kind: "InsertTimelineEvent",
    label: `Extend Scene by ${duration}s`,
    purpose: "scene-duration",
    provenance: { evidence: ["Scene duration control"], origin: "studio-default" },
  };
  return {
    ...canonicalProgram([operation], transactionId),
    provenance: { evidence: ["manual Scene duration"], origin: "studio-default" as const },
  };
}

export function durationTrimProgram(
  removedDuration: number,
  targetDuration: number,
  waitOperationIds: readonly string[],
  transactionId: string,
) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:duration-trim`, 7),
    kind: "TrimSceneDuration",
    provenance: { evidence: ["Scene duration control"], origin: "studio-default" },
    removedDuration,
    targetDuration,
    waitOperationIds,
  };
  return {
    ...canonicalProgram([operation], transactionId),
    provenance: { evidence: ["manual Scene duration"], origin: "studio-default" as const },
  };
}

export function transformOperation(
  id: string,
  start: number,
  sourceEntityId: string,
  targetEntityId: string,
  texParts: readonly string[],
): CanonicalEditOperation {
  return {
    ...operationBase(id, start, start + 1),
    kind: "TransformContent",
    replacement: { displayLines: [texParts.join(" ")], texParts },
    sourceEntityId,
    strategy: "transform-matching-tex",
    targetEntityId,
    targetType: "MathTex",
  };
}

export function latestPosition(imported: NonNullable<ReturnType<typeof importManimScene>>, entityId: string) {
  return imported.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)?.value as Readonly<{
    x: number;
    y: number;
  }>;
}
