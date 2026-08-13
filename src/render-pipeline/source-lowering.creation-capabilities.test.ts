import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { programRenderRequestSchema } from "./contracts";
import { importManimScene } from "./source-import";
import {
  findSceneMotionAnchors,
  lowerCanonicalProgramBatchSource,
  lowerCanonicalProgramSource,
} from "./source-lowering";
import {
  canonicalProgram,
  durationTrimProgram,
  durationWaitProgram,
  latestPosition,
  motionOperation,
  operationBase,
  request,
  roundTripSource,
  source,
  transformOperation,
} from "./source-lowering.test-fixtures";

describe("Canonical EditProgram source lowering", () => {
  it("lowers manually inserted geometry with safe default constructors", () => {
    const types = ["Circle", "Rectangle", "Square", "Line", "Arrow"] as const;
    const operations = types.flatMap((type, index): CanonicalEditOperation[] => {
      const entityId = `tx:manual-shapes/entity:shape-${index}`;
      const createId = `tx:manual-shapes/operation:create-${index}`;
      const positionId = `tx:manual-shapes/operation:position-${index}`;
      return [
        {
          ...operationBase(createId, 7),
          entity: {
            content: { displayLines: [type], label: type },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type,
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(positionId, 7),
          dependsOn: [createId],
          entityId,
          key: "position",
          kind: "SetProperty",
          value: { x: 120 + index * 80, y: 180 },
        },
        {
          ...operationBase(`tx:manual-shapes/operation:show-${index}`, 7, 7.4),
          dependsOn: [positionId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ];
    });
    const program = canonicalProgram(operations, "manual-shapes");
    const lowered = lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null);

    expect(lowered.insertedCode).toContain("Circle(radius=1)");
    expect(lowered.insertedCode).toContain("Rectangle(width=4, height=2)");
    expect(lowered.insertedCode).toContain("Square(side_length=2)");
    expect(lowered.insertedCode).toContain("Line(LEFT, RIGHT)");
    expect(lowered.insertedCode).toContain("Arrow(LEFT, RIGHT, buff=0)");
    expect(lowered.insertedCode.match(/FadeIn\(/g)).toHaveLength(types.length);
  });

  it("lowers a Scene duration extension to an explicit wait", () => {
    const wait: CanonicalEditOperation = {
      ...operationBase("extend-duration", 7, 10),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "Extend Scene to 11s",
    };
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([wait], "extend-duration"), []),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(3)");
    expect(imported?.runtimeSceneState.duration).toBe(11);
  });

  it("rejects an inserted wait that shares its source bucket", () => {
    const position: CanonicalEditOperation = {
      ...operationBase("position-with-wait", 7),
      entityId: "equation_1",
      key: "position",
      kind: "SetProperty",
      value: { x: 320, y: 180 },
    };
    const wait: CanonicalEditOperation = {
      ...operationBase("shared-wait", 7, 8),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "wait",
    };

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([position, wait])),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow("An inserted wait must occupy its own source interval.");
  });

  it("lowers a Scene duration trim by reducing only its referenced Studio wait", () => {
    const extension = durationWaitProgram(3, "duration-extension");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(1, 10, [wait.id], "duration-trim");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(2)");
    expect(lowered.insertedCode).not.toContain("self.wait(3)");
    expect(lowered.source).not.toContain('poietra:transaction "duration-trim"');
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([9]);
    expect(imported?.runtimeSceneState.duration).toBe(10);
  });

  it("restores the original source exactly when a Scene duration wait is fully removed", () => {
    const extension = durationWaitProgram(3, "duration-to-remove");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(3, 8, [wait.id], "remove-duration-wait");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.source).toBe(source);
    expect(lowered.insertedCode).toBe("");
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([7]);
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation")?.runtimeSceneState.duration,
    ).toBe(8);
  });

  it("refuses a Scene duration trim that cannot be proven against a Studio wait", () => {
    const trim = durationTrimProgram(1, 7, ["missing-wait"], "unproven-duration-trim");

    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(trim),
        [{ program: trim, sourceAnchor: 7 }],
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/does not reference an earlier Studio duration wait/i);
  });

  it("lowers a quadratic screen-space motion to an exact Manim cubic path", () => {
    const operation = motionOperation({ controlOffset: { x: 32, y: 45 } });
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([operation])),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain(
      '# poietra:motion {"motions":[{"controlOffset":{"x":32,"y":45},"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}',
    );
    expect(lowered.insertedCode).toContain(
      "MoveAlongPath(equation, CubicBezier(equation.get_center(), equation.get_center() + 0.9481 * RIGHT + 0.3333 * DOWN, equation.get_center() + 1.4222 * RIGHT, equation.get_center() + 1.4222 * RIGHT + 1 * UP))",
    );
    expect(lowered.insertedCode).not.toContain("equation.animate.shift(");
    expect(sample).toMatchObject({
      control: { x: 384, y: 202.5 },
      from: { x: 320, y: 180 },
      interval: { end: 8.5, start: 7 },
      value: { x: 384, y: 135 },
    });
  });

  it("preserves curved zero-displacement paths and tiny straight displacements", () => {
    const curved = lowerCanonicalProgramSource(
      source,
      request(
        canonicalProgram([
          motionOperation({
            controlOffset: { x: 0, y: 30 },
            delta: { x: 0, y: 0 },
          }),
        ]),
      ),
      { height: 8, width: 14.222 },
      null,
    );
    const tiny = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation({ delta: { x: 0.001, y: 0 } })])),
      { height: 8, width: 14.222 },
      null,
    );

    expect(curved.insertedCode).toContain("MoveAlongPath(equation, CubicBezier(");
    expect(tiny.insertedCode).toContain("equation.animate.shift(0.00002222 * RIGHT)");
  });

  it("rejects CameraFocus camera changes through the shared capability contract", () => {
    const cameraFocus: CanonicalEditOperation = {
      ...operationBase("camera-focus", 7, 8),
      kind: "ChangeCamera",
      property: "scale",
      value: 1.35,
    };
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([cameraFocus]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/CameraFocus can be previewed.*ChangeCamera cannot yet be lowered/);
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
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([liveRelation]), [
          { entityId: "equation_1", sourceVariable: "equation" },
          { entityId: "label_1", sourceVariable: "label" },
        ]),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/SetRelation live has no truthful source lowering/);
  });

  it("requires imported source identity and an exact source anchor", () => {
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([motionOperation()]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/no imported Python source identity/i);
    const program = {
      ...canonicalProgram([motionOperation()]),
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "playhead" as const, referenceSeconds: 5 },
      },
    };
    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null)).toThrow(
      /No # poietra:anchor 5.000/,
    );
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
      '        poietra_collision_1 = Text("Existing")\n        equation = MathTex',
    );
    const create: CanonicalEditOperation = {
      ...operationBase("create", 7),
      entity: {
        content: { displayLines: ["x"], texParts: ["x"] },
        id: "tx:collision/entity:new",
        lifetime: { end: null, start: 7 },
        type: "MathTex",
      },
      kind: "CreateEntity",
    };
    const code = lowerCanonicalProgramSource(
      collisionSource,
      request(canonicalProgram([create], "collision"), []),
      { height: 8, width: 14.222 },
      null,
    ).insertedCode;

    expect(code).toContain('poietra_collision_1_2 = MathTex("x")');
    expect(code).not.toContain('poietra_collision_1 = MathTex("x")');
  });

  it("orders same-bucket dependencies and carries chained transform identities", () => {
    const firstTarget = "tx:chain/entity:first";
    const secondTarget = "tx:chain/entity:second";
    const explanationId = "tx:chain/entity:explanation";
    const relation: CanonicalEditOperation = {
      ...operationBase("place-explanation", 7),
      kind: "SetRelation",
      mode: "snapshot",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: explanationId,
      targetEntityId: firstTarget,
    };
    const explanation: CanonicalEditOperation = {
      ...operationBase("create-explanation", 7),
      entity: {
        content: { displayLines: ["Explanation"], text: "Explanation" },
        id: explanationId,
        lifetime: { end: null, start: 7 },
        type: "Text",
      },
      kind: "CreateEntity",
    };
    const operations: CanonicalEditOperation[] = [
      explanation,
      transformOperation("first-transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"]),
      relation,
      transformOperation("second-transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"]),
    ];
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram(operations, "chain")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const targetVariable = imported?.sourceVariables[firstTarget];
    const explanationVariable = imported?.sourceVariables[explanationId];

    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(3);
    expect(lowered.insertedCode).toContain("equation = poietra_chain_3");
    expect(lowered.insertedCode.indexOf(`${targetVariable} = MathTex(`)).toBeLessThan(
      lowered.insertedCode.indexOf(`${explanationVariable}.move_to(${targetVariable}.get_center()`),
    );
    expect(imported?.sourceVariables).toMatchObject({
      [explanationId]: "poietra_chain_1",
      [firstTarget]: "poietra_chain_2",
      [secondTarget]: "poietra_chain_3",
    });
    expect(
      [firstTarget, secondTarget].map((id) => imported?.runtimeSceneState.objectGraph.entities[id]?.lifetime),
    ).toEqual([[{ end: 9, start: 7 }], [{ end: 10, start: 8 }]]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    expect(sourcePosition).toMatchObject({ x: expect.closeTo(410, 2), y: 135 });
    expect(latestPosition(imported, firstTarget)).toEqual(sourcePosition);
    expect(latestPosition(imported, secondTarget)).toEqual(sourcePosition);
    const explanationPosition = latestPosition(imported, explanationId);
    expect(explanationPosition).toMatchObject({
      x: expect.closeTo(sourcePosition.x + 145, 1),
      y: expect.closeTo(sourcePosition.y, 2),
    });
  });

  it("carries transform alias lineage across Programs in one batch", () => {
    const firstTarget = "tx:alias-a/entity:first";
    const secondTarget = "tx:alias-b/entity:second";
    const first = canonicalProgram(
      [transformOperation("tx:alias-a/operation:transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"])],
      "alias-a",
    );
    const secondBase = canonicalProgram(
      [transformOperation("tx:alias-b/operation:transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"])],
      "alias-b",
    );
    const second: CanonicalEditProgram = {
      ...secondBase,
      anchor: {
        capturedPlayhead: 8,
        evidence: [],
        resolvedSeconds: 8,
        source: { kind: "playhead", referenceSeconds: 8 },
      },
    };
    const laterMotion = motionOperation({
      id: "tx:alias-motion/operation:motion",
      interval: { end: 10, start: 9 },
      targetEntityIds: ["equation_1"],
    });
    const motionBase = canonicalProgram([laterMotion], "alias-motion");
    const motion: CanonicalEditProgram = {
      ...motionBase,
      anchor: {
        capturedPlayhead: 9,
        evidence: [],
        resolvedSeconds: 9,
        source: { kind: "playhead", referenceSeconds: 9 },
      },
    };

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(first),
      [first, second, motion].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("poietra_alias_a_1 = poietra_alias_b_1");
    expect(lowered.insertedCode).toContain("equation = poietra_alias_b_1");
    expect(lowered.insertedCode.lastIndexOf("equation = poietra_alias_b_1")).toBeLessThan(
      lowered.insertedCode.indexOf("equation.animate.shift("),
    );
  });

  it("lowers a finite Studio-created lifetime at separate safe anchors", () => {
    const finiteSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const entityId = "tx:finite-owned/entity:circle";
    const createId = "tx:finite-owned/operation:create";
    const appearId = "tx:finite-owned/operation:appear";
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "absolute", seconds: 5 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          ...operationBase(createId, 5),
          entity: {
            content: { displayLines: ["Circle"], label: "Circle" },
            id: entityId,
            lifetime: { end: 7, start: 5 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(appearId, 5, 5.4),
          dependsOn: [createId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: {
        edges: [{ from: createId, reason: "explicit", to: appearId }],
        mode: "sequence",
        order: [createId, appearId],
      },
      transactionId: "finite-owned",
      version: 1,
    };

    expect(() =>
      lowerCanonicalProgramSource(finiteSource, request(program, []), { height: 8, width: 14.222 }, null),
    ).toThrow(/batch source pipeline/i);

    const lowered = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [{ program, sourceAnchor: 5 }],
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.anchorLines).toHaveLength(2);
    expect(lowered.source.indexOf("Circle(radius=1)")).toBeLessThan(lowered.source.indexOf("self.remove("));
    expect(lowered.source).toContain("# poietra:anchor 5.4");
    expect(lowered.source).toContain("# poietra:anchor 7.4");
    const imported = importManimScene(lowered.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 });
    expect(imported?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([{ end: 7.4, start: 5 }]);

    const endWait = canonicalProgram(
      [
        {
          ...operationBase("end-anchor-wait/operation/wait", 7, 8),
          eventKind: "wait",
          kind: "InsertTimelineEvent",
          label: "Wait at lifetime end",
        },
      ],
      "end-anchor-wait",
    );
    const sameAnchor = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [
        { program, sourceAnchor: 5 },
        { program: endWait, sourceAnchor: 7 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    expect(sameAnchor.insertedCode.indexOf("self.remove(")).toBeLessThan(
      sameAnchor.insertedCode.indexOf('# poietra:transaction "end-anchor-wait"'),
    );
    expect(
      importManimScene(sameAnchor.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 })
        ?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime,
    ).toEqual([{ end: 7.4, start: 5 }]);
  });
});
