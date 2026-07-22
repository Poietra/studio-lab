import { describe, expect, it } from "vitest";

import { programRenderRequestSchema, type ProgramRenderRequest } from "./contracts";
import {
  findMotionAnchors,
  findSceneMotionAnchors,
  lowerCanonicalProgramSource,
  ProgramLoweringError,
} from "./source-lowering";
import { importManimScene } from "./source-import";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { STUDIO_FIXTURE_SCENE } from "../studio/fixture";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { canonicalizeSuggestionProgram } from "../studio/suggestion-program";

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

function latestPosition(
  imported: NonNullable<ReturnType<typeof importManimScene>>,
  entityId: string,
) {
  const value = imported.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)?.value;
  if (
    typeof value !== "object"
    || value === null
    || !("x" in value)
    || !("y" in value)
    || typeof value.x !== "number"
    || typeof value.y !== "number"
  ) {
    throw new Error(`No imported position exists for ${entityId}.`);
  }
  return { x: value.x, y: value.y };
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

  it("does not overwrite an existing Python identifier when allocating transaction variables", () => {
    const collisionSource = source.replace(
      "        equation = MathTex",
      "        poietra_collision_1 = Text(\"Existing\")\n        equation = MathTex",
    );
    const entityId = "tx:collision/entity:new";
    const operations: CanonicalEditOperation[] = [
      {
        ...operationBase("create", 7),
        entity: {
          content: { displayLines: ["x"], label: "x", texParts: ["x"] },
          id: entityId,
          lifetime: { end: null, start: 7 },
          type: "MathTex",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("show", 7, 8),
        effect: "fade-in",
        entityId,
        kind: "ChangePresence",
        persistent: true,
      },
    ];
    const lowered = lowerCanonicalProgramSource(
      collisionSource,
      request(canonicalProgram(operations, "collision"), []),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("poietra_collision_1_2 = MathTex(\"x\")");
    expect(lowered.insertedCode).not.toContain("poietra_collision_1 = MathTex(\"x\")");
  });

  it("carries transformed identities into later transforms with distinct source variables", () => {
    const roundTripSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const firstTarget = "tx:chain/entity:first";
    const secondTarget = "tx:chain/entity:second";
    const operations: CanonicalEditOperation[] = [
      {
        ...operationBase("first-transform", 7, 8),
        kind: "TransformContent",
        replacement: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] },
        sourceEntityId: "equation_1",
        strategy: "transform-matching-tex",
        targetEntityId: firstTarget,
        targetType: "MathTex",
      },
      {
        ...operationBase("second-transform", 8, 9),
        kind: "TransformContent",
        replacement: { displayLines: ["p = mv"], texParts: ["p", "=", "m", "v"] },
        sourceEntityId: firstTarget,
        strategy: "transform-matching-tex",
        targetEntityId: secondTarget,
        targetType: "MathTex",
      },
    ];
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram(operations, "chain")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(
      lowered.source,
      "examples/relativity.py",
      "GroupedEquation",
    );

    expect(lowered.insertedCode).toContain(`{"id":"${firstTarget}","variable":"poietra_chain_1"}`);
    expect(lowered.insertedCode).toContain(`{"id":"${secondTarget}","variable":"poietra_chain_2"}`);
    expect(lowered.insertedCode).toContain("poietra_chain_1.move_to(equation.get_center())");
    expect(lowered.insertedCode).toContain("poietra_chain_2.move_to(poietra_chain_1.get_center())");
    expect(lowered.insertedCode).toContain("TransformMatchingTex(equation, poietra_chain_1");
    expect(lowered.insertedCode).toContain("TransformMatchingTex(poietra_chain_1, poietra_chain_2");
    expect(lowered.insertedCode).toContain("equation = poietra_chain_2");
    expect(imported?.sourceVariables[firstTarget]).toBe("poietra_chain_1");
    expect(imported?.sourceVariables[secondTarget]).toBe("poietra_chain_2");
    expect(imported?.runtimeSceneState.objectGraph.entities[firstTarget]?.lifetime)
      .toEqual([{ end: 9, start: 7 }]);
    expect(imported?.runtimeSceneState.objectGraph.entities[secondTarget]?.lifetime)
      .toEqual([{ end: 10, start: 8 }]);
    const presentAfterSecondTransform = [firstTarget, secondTarget].filter((entityId) => (
      imported?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime.some((interval) => (
        interval.start <= 9.5 && 9.5 < interval.end
      ))
    ));
    expect(presentAfterSecondTransform).toEqual([secondTarget]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    expect(latestPosition(imported, firstTarget)).toEqual(sourcePosition);
    expect(latestPosition(imported, secondTarget)).toEqual(sourcePosition);
  });

  it("places a transform target at the shifted source center and preserves it after import", () => {
    const shiftedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.play(equation.animate.shift(2 * RIGHT + UP), run_time=1)
        self.wait(6)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const targetId = "tx:position/entity:target";
    const transform: CanonicalEditOperation = {
      ...operationBase("transform", 7, 8),
      kind: "TransformContent",
      replacement: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] },
      sourceEntityId: "equation_1",
      strategy: "transform-matching-tex",
      targetEntityId: targetId,
      targetType: "MathTex",
    };
    const lowered = lowerCanonicalProgramSource(
      shiftedSource,
      request(canonicalProgram([transform], "position")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("poietra_position_1.move_to(equation.get_center())");
    expect(lowered.insertedCode.indexOf("poietra_position_1 = MathTex("))
      .toBeLessThan(lowered.insertedCode.indexOf("poietra_position_1.move_to(equation.get_center())"));
    expect(lowered.insertedCode.indexOf("poietra_position_1.move_to(equation.get_center())"))
      .toBeLessThan(lowered.insertedCode.indexOf("self.play("));
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    const targetPosition = latestPosition(imported, targetId);
    expect(sourcePosition).toMatchObject({ x: expect.closeTo(260, 2), y: 90 });
    expect(targetPosition).toEqual(sourcePosition);
  });

  it("lowers a transform and explanation relation against the produced identity in one bucket", () => {
    const compositeSuggestion: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 7 },
      execution: "parallel",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 8,
          identityAfter: "target-replaces-source",
          kind: "create-transform",
          mismatchMode: "transform",
          sourceObjectId: "equation_1",
          start: 7,
          strategy: "transform-matching-tex",
          target: {
            displayLines: ["F = ma"],
            kind: "mathtex",
            label: "Newton's second law",
            texParts: ["F", "=", "m", "a"],
          },
        },
        {
          animation: "fade-in",
          end: 8,
          kind: "create-explanation",
          objectKind: "text",
          placement: "right",
          start: 7,
          targetObjectId: "equation_1",
          text: "Force equals mass times acceleration.",
        },
      ],
    };
    const validation = canonicalizeSuggestionProgram(compositeSuggestion, {
      capturedPlayhead: 7,
      origin: "remote-model",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "composite",
    });
    expect(validation.kind).toBe("valid");
    const transform = validation.program.operations.find((operation) => operation.kind === "TransformContent");
    const explanation = validation.program.operations.find((operation) => operation.kind === "CreateEntity");
    const relation = validation.program.operations.find((operation) => operation.kind === "SetRelation");
    expect(transform?.kind).toBe("TransformContent");
    expect(explanation?.kind).toBe("CreateEntity");
    expect(relation?.kind).toBe("SetRelation");
    if (transform?.kind !== "TransformContent" || explanation?.kind !== "CreateEntity" || relation?.kind !== "SetRelation") return;
    expect(relation.targetEntityId).toBe(transform.targetEntityId);

    const roundTripSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(validation.program),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const targetVariable = imported?.sourceVariables[transform.targetEntityId];
    const explanationVariable = imported?.sourceVariables[explanation.entity.id];

    expect(targetVariable).toBeTruthy();
    expect(explanationVariable).toBeTruthy();
    expect(targetVariable).not.toBe(explanationVariable);
    expect(lowered.insertedCode.indexOf(`${targetVariable} = MathTex(`))
      .toBeLessThan(lowered.insertedCode.indexOf(`${explanationVariable}.move_to(${targetVariable}.get_center()`));
    expect(lowered.insertedCode).toContain(`TransformMatchingTex(equation, ${targetVariable}`);
    expect(lowered.insertedCode).toContain(`${explanationVariable}.move_to(${targetVariable}.get_center() + 3.2222 * RIGHT)`);
    expect(imported?.runtimeSceneState.objectGraph.entities[transform.targetEntityId]?.lifetime)
      .toEqual([{ end: 9, start: 7 }]);
    expect(imported?.runtimeSceneState.objectGraph.entities[explanation.entity.id]?.lifetime)
      .toEqual([{ end: 9, start: 7 }]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    const transformedPosition = latestPosition(imported, transform.targetEntityId);
    const explanationPosition = latestPosition(imported, explanation.entity.id);
    expect(transformedPosition).toEqual(sourcePosition);
    expect(explanationPosition).toMatchObject({
      x: expect.closeTo(transformedPosition.x + 145, 1),
      y: expect.closeTo(transformedPosition.y, 2),
    });
  });
});
