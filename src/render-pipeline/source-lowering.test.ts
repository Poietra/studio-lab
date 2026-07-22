import { describe, expect, it } from "vitest";

import { programRenderRequestSchema, type ProgramRenderRequest } from "./contracts";
import {
  findMotionAnchors,
  findSceneMotionAnchors,
  lowerCanonicalProgramSource,
  ProgramLoweringError,
} from "./source-lowering";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";

const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        self.wait(1)
`;

function canonicalProgram(
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

function motionOperation(overrides: Partial<Extract<CanonicalEditOperation, { kind: "CreateMotion" }>> = {}) {
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

function request(
  program = canonicalProgram([motionOperation()]),
  sourceBindings: ProgramRenderRequest["sourceBindings"] = [{ entityId: "equation_1", sourceVariable: "equation" }],
): ProgramRenderRequest {
  return {
    destination: null,
    program,
    sceneName: "GroupedEquation",
    sourceBindings,
    sourceHash: "a".repeat(64),
    sourcePath: "examples/relativity.py",
    viewport: { height: 360, width: 640 },
  };
}

function operationBase(id: string, start: number, end = start) {
  return {
    dependsOn: [],
    id,
    interval: { end, start },
    provenance: { evidence: [], origin: "remote-model" as const },
  };
}

describe("Canonical EditProgram source lowering", () => {
  it("discovers explicit source anchors inside their Scene", () => {
    expect(findMotionAnchors(source)).toEqual([{ line: 6, seconds: 7 }]);
    expect(findSceneMotionAnchors(source, "GroupedEquation")).toEqual([{ line: 6, seconds: 7 }]);
  });

  it("converts a canonical screen-space motion at the exact anchor", () => {
    const lowered = lowerCanonicalProgramSource(source, request(), { height: 8, width: 14.222 }, null);

    expect(lowered.anchorLine).toBe(6);
    expect(lowered.insertedCode).toContain("equation.animate.shift(1.4222 * RIGHT + 1 * UP)");
    expect(lowered.insertedCode).toContain("run_time=1.5");
    expect(lowered.source.indexOf("# poietra:anchor 7.000")).toBeLessThan(lowered.source.indexOf("self.play("));
  });

  it("lowers equation, explanation, and an actual imported Scene boundary as one transaction", () => {
    const equationId = "tx:compound/entity:new-equation";
    const textId = "tx:compound/entity:explanation";
    const overlayId = "tx:compound/entity:overlay";
    const operations: CanonicalEditOperation[] = [
      {
        ...operationBase("create-equation", 7),
        entity: {
          content: { displayLines: ["E = mc^2"], label: "equation", texParts: ["E", "=", "m", "c^2"] },
          id: equationId,
          lifetime: { end: null, start: 7 },
          type: "MathTex",
        },
        kind: "CreateEntity",
      },
      { ...operationBase("position-equation", 7), entityId: equationId, key: "position", kind: "SetProperty", value: { x: 320, y: 180 } },
      { ...operationBase("create-text", 7), entity: { content: { displayLines: ["Energy"], text: "Energy" }, id: textId, lifetime: { end: null, start: 7 }, type: "Text" }, kind: "CreateEntity" },
      { ...operationBase("place-text", 7), kind: "SetRelation", mode: "snapshot", offset: { x: 145, y: 0 }, placement: "right", relation: "next-to", sourceEntityId: textId, targetEntityId: equationId },
      { ...operationBase("show-equation", 7, 8), effect: "fade-in", entityId: equationId, kind: "ChangePresence", persistent: true },
      { ...operationBase("show-text", 7, 8), effect: "fade-in", entityId: textId, kind: "ChangePresence", persistent: true },
      { ...operationBase("create-overlay", 8), entity: { content: { displayLines: ["sky circle"] }, id: overlayId, lifetime: { end: 9, start: 8 }, type: "TransitionOverlay:circle:sky" }, kind: "CreateEntity" },
      { ...operationBase("cover", 8, 8.5), effect: "cover", entityId: overlayId, kind: "ChangePresence", persistent: false },
      { ...operationBase("boundary", 8.5), at: 8.5, destination: "next-scene", kind: "InsertSceneBoundary" },
      { ...operationBase("reveal", 8.5, 9), effect: "reveal", entityId: overlayId, kind: "ChangePresence", persistent: true },
    ];
    const program = {
      ...canonicalProgram(operations, "compound"),
      intentCount: 3,
      schedule: { edges: [], mode: "sequence" as const, order: operations.map((operation) => operation.id) },
    };
    const lowered = lowerCanonicalProgramSource(
      source,
      { ...request(program, []), destination: { sceneName: "Next", sourcePath: "scene.py" } },
      { height: 8, width: 14.222 },
      {
        initialization: ["title = Text(\"Next\")"],
        visibleSourceVariables: ["title"],
      },
    );

    expect(lowered.insertedCode).toContain("MathTex(\"E\", \"=\", \"m\", \"c^2\")");
    expect(lowered.insertedCode).toContain("Text(\"Energy\")");
    expect(lowered.insertedCode).toContain(".get_center() + 3.2222 * RIGHT");
    expect(lowered.insertedCode).toContain("FadeIn(");
    expect(lowered.insertedCode).toContain("self.clear()");
    expect(lowered.insertedCode).toContain('# poietra:scene-boundary {"at":8.5,"destination":"scene.py#Next"}');
    expect(lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(lowered.insertedCode).toContain("title = Text(\"Next\")");
    expect(lowered.insertedCode).toContain("return  # The imported next Scene now owns the composition.");
    expect(lowered.insertedCode.match(/# poietra:entity/g)).toHaveLength(2);
  });

  it("rejects curved motion instead of claiming a reproducible render", () => {
    const operation = motionOperation({ controlOffset: { x: 0, y: -20 } });
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([operation])),
      { height: 8, width: 14.222 },
      null,
    )).toThrowError(new ProgramLoweringError(
      "operation-unsupported",
      "Rendered validation currently supports straight CreateMotion paths only.",
    ));
  });

  it("rejects operations that do not have truthful source lowering instead of dropping them", () => {
    const unsupported: CanonicalEditOperation = {
      ...operationBase("modify", 7, 8),
      controlOffset: { x: 0, y: 10 },
      kind: "ModifyMotion",
      motionId: "source-motion",
      preserve: ["start", "end", "duration"],
    };
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([unsupported])),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/ModifyMotion has no truthful source lowering/);
  });

  it("rejects live relations because a one-shot move cannot preserve that constraint", () => {
    const liveRelation: CanonicalEditOperation = {
      ...operationBase("live-relation", 7),
      kind: "SetRelation",
      mode: "live",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: "label_1",
      targetEntityId: "equation_1",
    };
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([liveRelation]), [
        { entityId: "equation_1", sourceVariable: "equation" },
        { entityId: "label_1", sourceVariable: "label" },
      ]),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/SetRelation live has no truthful source lowering/);
  });

  it("requires imported source identity and an exact source anchor", () => {
    expect(() => lowerCanonicalProgramSource(source, request(canonicalProgram([motionOperation()]), []), { height: 8, width: 14.222 }, null))
      .toThrow(/no imported Python source identity/i);
    const program = {
      ...canonicalProgram([motionOperation()]),
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "playhead" as const, referenceSeconds: 5 },
      },
    };
    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null))
      .toThrow(/No # poietra:anchor 5.000/);
  });

  it("keeps transaction text data-only while generating safe Python variables", () => {
    const unsafeId = "unsafe\nself.remove(equation)";
    const program = canonicalProgram([motionOperation()], unsafeId);
    expect(programRenderRequestSchema.safeParse(request(program)).success).toBe(true);
    const lowered = lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null);
    expect(lowered.insertedCode).toContain("unsafe\\nself.remove(equation)");
    expect(lowered.insertedCode).not.toContain("\nself.remove(equation)\n");
  });
});
