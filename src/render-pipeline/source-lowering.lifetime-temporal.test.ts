import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { importManimScene } from "./source-import";
import {
  findSceneMotionAnchors,
  lowerCanonicalProgramBatchSource,
  lowerCanonicalProgramSource,
} from "./source-lowering";
import {
  canonicalProgram,
  latestPosition,
  motionOperation,
  motionProgramAt,
  operationBase,
  request,
  roundTripSource,
  source,
  temporalMetadataSource,
  transformOperation,
} from "./source-lowering.test-fixtures";

describe("Canonical EditProgram source lowering", () => {
  it("lowers an immediate lifetime end to self.remove without a zero-duration play", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("trim-lifetime", 7),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };

    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram([remove], "trim-lifetime")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.remove(equation)");
    expect(lowered.insertedCode).not.toContain("self.play(");
    expect(
      imported?.runtimeSceneState.objectGraph.entities["source:examples/relativity.py#GroupedEquation:equation"]
        ?.lifetime,
    ).toEqual([{ end: 7, start: 0 }]);
  });

  it.each([
    "self.play(FadeIn(equation), run_time=1)",
    "self.add(equation)",
    "self.play(equation.animate.shift(RIGHT), run_time=1)",
    'self.add(globals()[f"equation"])',
  ])("rejects persistent removal before a source suffix reference: %s", (suffix) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const sourceWithReference = source.replace("self.wait(1)", suffix);

    expect(() =>
      lowerCanonicalProgramSource(
        sourceWithReference,
        request(canonicalProgram([remove], "persistent-delete")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/equation is referenced after the selected anchor/i);
  });

  it.each([
    ["direct alias", "alias = equation", "self.add(alias)", "alias"],
    ["Manim container", "group = VGroup(equation)", "self.add(group)", "group"],
    ["list container", "items = [equation]", "self.add(items[0])", "items"],
    ["dict container", 'lookup = {"primary": equation}', 'self.add(lookup["primary"])', "lookup"],
    ["attribute", "self.cached_equation = equation", "self.add(self.cached_equation)", "self.cached_equation"],
    ["subscript assignment", 'cache = {}\n        cache["primary"] = equation', 'self.add(cache["primary"])', "cache"],
    ["globals binding", 'globals()["cached_equation"] = equation', "self.add(cached_equation)", "cached_equation"],
    [
      "prefixed globals binding",
      'globals()[f"cached_equation"] = equation',
      "self.add(cached_equation)",
      "cached_equation",
    ],
    [
      "globals subscript",
      'globals()["cached_equation"] = equation',
      'self.add(globals()["cached_equation"])',
      "globals",
    ],
    ["container mutation", "items = []\n        items.append(equation)", "self.add(items[0])", "items"],
    [
      "nested container mutation",
      'buckets = {"primary": []}\n        buckets["primary"].append(equation)',
      'self.add(buckets["primary"][0])',
      "buckets",
    ],
    ["for binding", "for alias in [equation]:\n            pass", "self.add(alias)", "alias"],
    ["with binding", "with nullcontext(equation) as alias:\n            pass", "self.add(alias)", "alias"],
    ["assignment expression", "if (alias := equation):\n            pass", "self.add(alias)", "alias"],
    ["function body", "def revive():\n            self.add(equation)", "revive()", "revive"],
    ["function return", "def get():\n            return equation", "self.add(get())", "get"],
    ["async function body", "async def revive():\n            self.add(equation)", "self.add(revive)", "revive"],
    ["function default", "def revive(value=equation):\n            return value", "self.add(revive())", "revive"],
    ["class body", "class Holder:\n            cached = equation", "self.add(Holder.cached)", "Holder"],
    [
      "function return alias",
      "def retrieve():\n            return equation\n        alias = retrieve()",
      "self.add(alias)",
      "alias",
    ],
    [
      "class instance alias",
      "class Holder:\n            def __new__(cls):\n                return equation\n        holder = Holder()",
      "self.add(holder)",
      "holder",
    ],
    [
      "globals get alias",
      'globals()["cached_equation"] = equation\n        alias = globals().get("cached_equation")',
      "self.add(alias)",
      "alias",
    ],
    ["shallow list copy", "items = [equation]\n        copied = items.copy()", "self.add(copied[0])", "copied"],
    [
      "shallow dict copy",
      'items = {"primary": equation}\n        copied = items.copy()',
      'self.add(copied["primary"])',
      "copied",
    ],
    ["animation alias", "entrance = FadeIn(equation)", "self.play(entrance)", "entrance"],
    ["animation list", "entrances = [FadeIn(equation)]", "self.play(*entrances)", "entrances"],
    ["nested animation group", "entrance = AnimationGroup(FadeIn(equation))", "self.play(entrance)", "entrance"],
    ["self-returning scale", "alias = equation.scale(2)", "self.add(alias)", "alias"],
    ["self-returning shift", "alias = equation.shift(RIGHT)", "self.add(alias)", "alias"],
    ["self-returning rotate", "alias = equation.rotate(PI / 2)", "self.add(alias)", "alias"],
    ["self-returning placement", "alias = equation.next_to(ORIGIN)", "self.add(alias)", "alias"],
    ["animation builder alias", "motion = equation.animate.shift(RIGHT)", "self.play(motion)", "motion"],
    ["animation builder container", "motions = [equation.animate.shift(RIGHT)]", "self.play(*motions)", "motions"],
    ["submobjects projection", "parts = equation.submobjects", "self.add(parts[0])", "parts"],
    ["target projection", "target = equation.target", "self.add(target)", "target"],
  ])("rejects persistent removal through a pre-anchor %s", (_label, setup, suffix, reference) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-alias", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const aliasedSource = source
      .replace("        # poietra:anchor 7.000", `        ${setup}\n        # poietra:anchor 7.000`)
      .replace("self.wait(1)", suffix);

    expect(() =>
      lowerCanonicalProgramSource(
        aliasedSource,
        request(canonicalProgram([remove], "persistent-delete-alias")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(new RegExp(`${reference.replaceAll(".", "\\.")} is referenced after the selected anchor`, "i"));
  });

  it("tracks multi-hop alias and container closure before persistent removal", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-closure", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const aliasedSource = source
      .replace(
        "        # poietra:anchor 7.000",
        '        alias = equation\n        group = VGroup(alias)\n        registry = {"primary": group}\n        # poietra:anchor 7.000',
      )
      .replace("self.wait(1)", 'self.add(registry["primary"])');

    expect(() =>
      lowerCanonicalProgramSource(
        aliasedSource,
        request(canonicalProgram([remove], "persistent-delete-closure")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/registry is referenced after the selected anchor/i);
  });

  it.each([
    'make_registry()["primary"] = equation',
    "globals()[dynamic_key] = equation",
    "make_registry().append(equation)",
    "with nullcontext(equation) as make_holder().value:\n            pass",
  ])("fails closed when a target-retaining assignment cannot be tracked: %s", (setup) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-unknown-alias", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const ambiguousSource = source.replace(
      "        # poietra:anchor 7.000",
      `        ${setup}\n        # poietra:anchor 7.000`,
    );

    expect(() =>
      lowerCanonicalProgramSource(
        ambiguousSource,
        request(canonicalProgram([remove], "persistent-delete-unknown-alias")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/cannot track (?:an alias\/container assignment|a container mutation) target/i);
  });

  it.each([
    ["unknown function", "remember(equation)", "self.add(recall())", "remember"],
    ["setattr", 'setattr(holder, "cached", equation)', "self.add(holder.cached)", "setattr"],
    ["queue mutation", "queue.put(equation)", "self.add(queue.get())", "queue\\.put"],
    ["parenthesized method", "(queue.put)(equation)", "self.add(queue.get())", "queue\\.put"],
    ["dynamic callable", 'getattr(queue, "put")(equation)', "self.add(queue.get())", "a dynamic callable"],
    ["unknown outer wrapper", "remember(VGroup(equation))", "self.add(recall())", "remember"],
    ["unknown outer queue sink", "queue.put(VGroup(equation))", "self.add(queue.get())", "queue\\.put"],
    ["unknown outer setattr sink", 'setattr(holder, "cached", VGroup(equation))', "self.add(holder.cached)", "setattr"],
    [
      "default sink",
      "def revive(value=remember(equation)):\n            return value",
      "self.add(revive())",
      "remember",
    ],
    [
      "decorator sink",
      "@remember(equation)\n        def revive():\n            pass",
      "self.add(revive())",
      "remember",
    ],
    ["postfix wrapper method", "VGroup(equation).register()", "self.add(recall())", "postfix call register"],
    ["postfix wrapper sink", "VGroup(equation).put_into(queue)", "self.add(queue.get())", "postfix call put_into"],
    ["postfix subscript method", "VGroup(equation)[0].register()", "self.add(recall())", "postfix call register"],
    ["postfix self-return method", "equation.scale(2).register()", "self.add(recall())", "postfix call register"],
    ["postfix grouped method", "(equation).register()", "self.add(recall())", "postfix call register"],
    ["postfix before self.add", "self.add(VGroup(equation).register())", "self.add(recall())", "postfix call register"],
    [
      "postfix before self.play",
      "self.play(AnimationGroup(FadeIn(equation)).register())",
      "self.add(recall())",
      "postfix call register",
    ],
    ["dynamic width getter", "value = equation.get_width()", "self.wait(value)", "postfix call get_width"],
  ])("fails closed when a pre-anchor %s may retain the removed object", (_label, setup, suffix, call) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-unknown-call", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const ambiguousSource = source
      .replace("        # poietra:anchor 7.000", `        ${setup}\n        # poietra:anchor 7.000`)
      .replace("self.wait(1)", suffix);

    expect(() =>
      lowerCanonicalProgramSource(
        ambiguousSource,
        request(canonicalProgram([remove], "persistent-delete-unknown-call")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(new RegExp(`cannot prove whether ${call} retains source reference equation`, "i"));
  });

  it("does not treat derived Manim geometry as a persistent alias", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-derived-geometry", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const derivedSource = source
      .replace(
        "        # poietra:anchor 7.000",
        `        self.play(FadeIn(equation))
        self.play(equation.animate.shift(RIGHT))
        clone = equation.copy().shift(RIGHT)
        label = Text("energy").next_to(equation, DOWN)
        arrow = Arrow(label.get_top(), equation.get_bottom())
        proof_box = SurroundingRectangle(equation)
        # poietra:anchor 7.000`,
      )
      .replace("self.wait(1)", "self.add(clone, label, arrow, proof_box)");

    expect(
      lowerCanonicalProgramSource(
        derivedSource,
        request(canonicalProgram([remove], "persistent-delete-derived-geometry")),
        { height: 8, width: 14.222 },
        null,
      ).insertedCode,
    ).toContain("FadeOut(equation)");
  });

  it.each([
    ["width property", "equation.width", null],
    ["height property", "equation.height", null],
    ["depth property", "equation.depth", null],
    ["color property", "equation.color", null],
    ["fill opacity property", "equation.fill_opacity", null],
    ["stroke color property", "equation.stroke_color", null],
    ["MathTex string property", "equation.tex_string", null],
    ["Text string property", "equation.text", 'Text("energy")'],
    ["x getter", "equation.get_x()", null],
    ["y getter", "equation.get_y()", null],
    ["z getter", "equation.get_z()", null],
    ["color getter", "equation.get_color()", null],
    ["fill opacity getter", "equation.get_fill_opacity()", null],
    ["stroke color getter", "equation.get_stroke_color()", null],
    ["MathTex string getter", "equation.get_tex_string()", null],
  ])("does not retain the removed object through a derived %s", (_label, expression, constructor) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-derived-value", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const sourceWithConstructor = constructor ? source.replace('MathTex("E", "=", "m", "c^2")', constructor) : source;
    const derivedSource = sourceWithConstructor
      .replace("        # poietra:anchor 7.000", `        value = ${expression}\n        # poietra:anchor 7.000`)
      .replace("self.wait(1)", "self.add(Text(str(value)))");

    expect(
      lowerCanonicalProgramSource(
        derivedSource,
        request(canonicalProgram([remove], "persistent-delete-derived-value")),
        { height: 8, width: 14.222 },
        null,
      ).insertedCode,
    ).toContain("FadeOut(equation)");
  });

  it("does not inspect an unrelated sibling expression as a tainted postfix chain", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-sibling-expression", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const siblingSource = source.replace(
      "        # poietra:anchor 7.000",
      `        temporary = VGroup(equation, Text("x").set_color(BLUE))
        # poietra:anchor 7.000`,
    );

    expect(
      lowerCanonicalProgramSource(
        siblingSource,
        request(canonicalProgram([remove], "persistent-delete-sibling-expression")),
        { height: 8, width: 14.222 },
        null,
      ).insertedCode,
    ).toContain("FadeOut(equation)");
  });

  it.each(["f", "r", "b"])(
    "does not confuse the %s string prefix with a removed one-letter source variable",
    (sourceVariable) => {
      const remove: CanonicalEditOperation = {
        ...operationBase("persistent-delete-string-prefix", 7, 7.4),
        effect: "remove",
        entityId: "equation_1",
        kind: "ChangePresence",
        persistent: true,
      };
      const prefixSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        ${sourceVariable} = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        message = ${sourceVariable}"equation"
        self.wait(1)
`;

      expect(
        lowerCanonicalProgramSource(
          prefixSource,
          request(canonicalProgram([remove], "persistent-delete-string-prefix"), [
            { entityId: "equation_1", sourceVariable },
          ]),
          { height: 8, width: 14.222 },
          null,
        ).insertedCode,
      ).toContain(`FadeOut(${sourceVariable})`);
    },
  );

  it("ignores source-variable text in comments and strings when guarding persistent removal", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("safe-delete", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const safeSuffix = source.replace(
      "self.wait(1)",
      'documentation = "equation"\n        # self.add(equation)\n        self.wait(1)',
    );

    expect(
      lowerCanonicalProgramSource(
        safeSuffix,
        request(canonicalProgram([remove], "safe-delete")),
        { height: 8, width: 14.222 },
        null,
      ).insertedCode,
    ).toContain("FadeOut(equation)");
  });

  it("guards the original source alias when a transformed target is persistently removed", () => {
    const targetEntityId = "tx:transform-delete/entity:target";
    const transform = transformOperation("transform", 7, "equation_1", targetEntityId, ["F", "=", "m", "a"]);
    const remove: CanonicalEditOperation = {
      ...operationBase("delete-target", 8, 8.4),
      dependsOn: [transform.id],
      effect: "remove",
      entityId: targetEntityId,
      kind: "ChangePresence",
      persistent: true,
    };
    const sourceWithReference = source.replace("self.wait(1)", "self.add(equation)");

    expect(() =>
      lowerCanonicalProgramSource(
        sourceWithReference,
        request(canonicalProgram([transform, remove], "transform-delete")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/equation is referenced after the selected anchor/i);
  });

  it("rejects a non-transition operation at or after a Scene boundary", () => {
    const boundary: CanonicalEditOperation = {
      ...operationBase("boundary", 7),
      at: 7,
      destination: "next-scene",
      kind: "InsertSceneBoundary",
    };
    const motion = motionOperation({
      id: "motion-after-boundary",
      interval: { end: 8, start: 7 },
    });

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        {
          ...request(canonicalProgram([boundary, motion], "boundary-first")),
          destination: { sceneName: "Next", sourcePath: "scene.py" },
        },
        { height: 8, width: 14.222 },
        { initialization: [], visibleSourceVariables: [] },
      ),
    ).toThrow(/Scene boundary must be terminal/i);
  });

  it("advances the consumed anchor so a second commit appends in playback order", () => {
    const firstProgram = canonicalProgram([motionOperation()], "first-commit");
    const first = lowerCanonicalProgramSource(source, request(firstProgram), { height: 8, width: 14.222 }, null);
    const secondOperation = motionOperation({
      id: "tx:second-commit/operation:motion",
      interval: { end: 10, start: 8.5 },
    });
    const secondProgram: CanonicalEditProgram = {
      ...canonicalProgram([secondOperation], "second-commit"),
      anchor: {
        capturedPlayhead: 8.5,
        evidence: ["captured-playhead:8.500"],
        resolvedSeconds: 8.5,
        source: { kind: "playhead", referenceSeconds: 8.5 },
      },
    };
    const second = lowerCanonicalProgramSource(
      first.source,
      request(secondProgram),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(second.source, "examples/relativity.py", "GroupedEquation");
    const samples =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.filter((sample) => sample.kind === "animated") ?? [];

    expect(first.source).toContain("# poietra:cursor 7");
    expect(findSceneMotionAnchors(first.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([8.5]);
    expect(second.source.indexOf('poietra:transaction "first-commit"')).toBeLessThan(
      second.source.indexOf('poietra:transaction "second-commit"'),
    );
    expect(findSceneMotionAnchors(second.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([10]);
    expect(samples.map((sample) => sample.interval)).toEqual([
      { end: 8.5, start: 7 },
      { end: 10, start: 8.5 },
    ]);
  });

  it("shifts downstream source anchors by the inserted duration", () => {
    const sourceWithDownstreamAnchor = source.replace(
      "        self.wait(1)",
      "        self.wait(3)\n        # poietra:anchor 10.000\n        self.wait(1)",
    );

    const lowered = lowerCanonicalProgramSource(
      sourceWithDownstreamAnchor,
      request(),
      { height: 8, width: 14.222 },
      null,
    );

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      8.5, 11.5,
    ]);
  });

  it("shifts every safe downstream temporal marker and reimports execution-aligned timing", () => {
    const lowered = lowerCanonicalProgramSource(
      temporalMetadataSource,
      request(motionProgramAt(5, 1, "temporal-single")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const motion = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/position"
    ]?.samples.find((sample) => sample.kind === "animated");
    const boundary = imported?.runtimeSceneState.eventTrack.events.find((event) => event.kind === "scene-boundary");

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([6, 9]);
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":9,"destination":"scene.py#Next"}');
    expect(motion?.interval).toEqual({ end: 6, start: 5 });
    expect(boundary).toMatchObject({ at: 9, kind: "scene-boundary" });
    expect(imported?.runtimeSceneState.duration).toBe(10);
  });

  it("moves original metadata at the exact insertion boundary and remains stable across repeated insertion", () => {
    const sourceWithEqualMetadata = temporalMetadataSource
      .replace(
        "        self.wait(5)\n        # poietra:anchor 5.000",
        [
          "        self.wait(5)",
          "        # poietra:cursor 5.000",
          '        # poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}',
          "        # poietra:anchor 5.000",
        ].join("\n"),
      )
      .replace(
        "        # poietra:anchor 5.000",
        [
          "        # poietra:anchor 5.000",
          "        # poietra:cursor 5.000",
          '        # poietra:scene-boundary {"at":5,"destination":"scene.py#AfterAnchor"}',
        ].join("\n"),
      );
    const first = lowerCanonicalProgramSource(
      sourceWithEqualMetadata,
      request(motionProgramAt(5, 1, "temporal-first")),
      { height: 8, width: 14.222 },
      null,
    );
    const second = lowerCanonicalProgramSource(
      first.source,
      request(motionProgramAt(6, 0.75, "temporal-second")),
      { height: 8, width: 14.222 },
      null,
    );

    expect(first.source.match(/# poietra:cursor [0-9.]+/g)).toEqual([
      "# poietra:cursor 5.000",
      "# poietra:cursor 5",
      "# poietra:cursor 6",
      "# poietra:cursor 8",
    ]);
    expect(first.source).toContain('# poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}');
    expect(first.source).toContain('# poietra:scene-boundary {"at":6,"destination":"scene.py#AfterAnchor"}');
    expect(second.source.match(/# poietra:cursor [0-9.]+/g)).toEqual([
      "# poietra:cursor 5.000",
      "# poietra:cursor 5",
      "# poietra:cursor 6",
      "# poietra:cursor 6.75",
      "# poietra:cursor 8.75",
    ]);
    expect(second.source).toContain('# poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}');
    expect(second.source).toContain('# poietra:scene-boundary {"at":6.75,"destination":"scene.py#AfterAnchor"}');
    expect(second.source).toContain('# poietra:scene-boundary {"at":9.75,"destination":"scene.py#Next"}');
    expect(findSceneMotionAnchors(second.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      6.75, 9.75,
    ]);
  });

  it("applies the same cumulative temporal rewrite to distinct source anchors in a batch", () => {
    const earlier = motionProgramAt(5, 1, "temporal-batch-earlier");
    const later = motionProgramAt(9, 1.25, "temporal-batch-later");
    const lowered = lowerCanonicalProgramBatchSource(
      temporalMetadataSource,
      request(earlier),
      [
        { program: later, sourceAnchor: 8 },
        { program: earlier, sourceAnchor: 5 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      6, 10.25,
    ]);
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain("# poietra:cursor 9");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":10.25,"destination":"scene.py#Next"}');
    expect(imported?.runtimeSceneState.eventTrack.events).toContainEqual(
      expect.objectContaining({
        at: 10.25,
        kind: "scene-boundary",
      }),
    );
  });

  it("leaves string, nested, and malformed temporal markers inert while shifting valid markers", () => {
    const sourceWithUnsafeMetadata = temporalMetadataSource.replace(
      "        self.add(equation)",
      `        self.add(equation)
        documentation = """
        # poietra:cursor 70.000
        # poietra:scene-boundary {"at":80,"destination":"scene.py#String"}
        """
        if False:
            # poietra:cursor 60.000
            # poietra:scene-boundary {"at":70,"destination":"scene.py#Nested"}
        # poietra:cursor later
        # poietra:scene-boundary {"at":7}`,
    );
    const lowered = lowerCanonicalProgramSource(
      sourceWithUnsafeMetadata,
      request(motionProgramAt(5, 1, "temporal-safe-only")),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.source).toContain("        # poietra:cursor 70.000");
    expect(lowered.source).toContain('        # poietra:scene-boundary {"at":80,"destination":"scene.py#String"}');
    expect(lowered.source).toContain("            # poietra:cursor 60.000");
    expect(lowered.source).toContain('            # poietra:scene-boundary {"at":70,"destination":"scene.py#Nested"}');
    expect(lowered.source).toContain("        # poietra:cursor later");
    expect(lowered.source).toContain('        # poietra:scene-boundary {"at":7');
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":9,"destination":"scene.py#Next"}');
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
      {
        ...operationBase("create-text", 7),
        entity: {
          content: { displayLines: ["Energy"], text: "Energy" },
          id: textId,
          lifetime: { end: null, start: 7 },
          type: "Text",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("place-text", 7),
        kind: "SetRelation",
        mode: "snapshot",
        offset: { x: 145, y: 0 },
        placement: "right",
        relation: "next-to",
        sourceEntityId: textId,
        targetEntityId: equationId,
      },
      {
        ...operationBase("position-text", 7),
        entityId: textId,
        key: "position",
        kind: "SetProperty",
        value: { x: 320, y: 180 },
      },
      {
        ...operationBase("show-equation", 7, 8),
        effect: "fade-in",
        entityId: equationId,
        kind: "ChangePresence",
        persistent: true,
      },
      {
        ...operationBase("show-text", 7, 8),
        effect: "fade-in",
        entityId: textId,
        kind: "ChangePresence",
        persistent: true,
      },
      {
        ...operationBase("create-overlay", 8),
        entity: {
          content: { displayLines: ["sky circle"] },
          id: overlayId,
          lifetime: { end: 9, start: 8 },
          type: "TransitionOverlay:circle:sky",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("cover", 8, 8.5),
        effect: "cover",
        entityId: overlayId,
        kind: "ChangePresence",
        persistent: false,
      },
      { ...operationBase("boundary", 8.5), at: 8.5, destination: "next-scene", kind: "InsertSceneBoundary" },
      {
        ...operationBase("reveal", 8.5, 9),
        dependsOn: ["boundary"],
        effect: "reveal",
        entityId: overlayId,
        kind: "ChangePresence",
        persistent: true,
      },
    ];
    const program = {
      ...canonicalProgram(operations, "compound"),
      intentCount: 3,
      schedule: { edges: [], mode: "sequence" as const, order: operations.map((operation) => operation.id) },
    };
    const lowered = lowerCanonicalProgramBatchSource(
      source,
      { ...request(program, []), destination: { sceneName: "Next", sourcePath: "scene.py" } },
      [{ program, sourceAnchor: 7 }],
      { height: 8, width: 14.222 },
      {
        initialization: ['title = Text("Next")'],
        visibleSourceVariables: ["title"],
      },
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain('MathTex("E", "=", "m", "c^2")');
    expect(lowered.insertedCode).toContain('Text("Energy")');
    expect(lowered.insertedCode).toContain(".get_center() + 3.2222 * RIGHT");
    expect(lowered.insertedCode.indexOf(".get_center() + 3.2222 * RIGHT")).toBeLessThan(
      lowered.insertedCode.indexOf(".move_to((0, 0, 0))"),
    );
    expect(lowered.insertedCode).toContain("FadeIn(");
    expect(lowered.insertedCode).toContain("self.clear()");
    expect(lowered.insertedCode).toContain('# poietra:scene-boundary {"at":8.5,"destination":"scene.py#Next"}');
    expect(lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(lowered.insertedCode).toContain('title = Text("Next")');
    expect(lowered.insertedCode).toContain("return  # The imported next Scene now owns the composition.");
    expect(lowered.insertedCode.match(/# poietra:entity/g)).toHaveLength(2);
    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(2);
    expect(imported).not.toBeNull();
    if (imported) expect(latestPosition(imported, textId)).toEqual({ x: 320, y: 180 });
  });
});
