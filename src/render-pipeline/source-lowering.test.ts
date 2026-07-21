import { describe, expect, it } from "vitest";

import { createMotionRenderRequestSchema, type CreateMotionRenderRequest } from "./contracts";
import { findMotionAnchors, findSceneMotionAnchors, lowerCreateMotionSource, MotionLoweringError } from "./source-lowering";

const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        self.wait(1)
`;

function request(overrides: Partial<CreateMotionRenderRequest["operation"]> = {}): CreateMotionRenderRequest {
  return {
    operation: {
      controlOffsetPixels: { x: 0, y: 0 },
      deltaPixels: { x: 64, y: -45 },
      interval: { end: 8.5, start: 7 },
      kind: "CreateMotion",
      targets: [{ entityId: "equation_1", sourceVariable: "equation" }],
      transactionId: "render-test",
      viewport: { height: 360, width: 640 },
      ...overrides,
    },
    sceneName: "GroupedEquation",
    sourcePath: "examples/relativity.py",
  };
}

describe("CreateMotion source lowering", () => {
  it("discovers explicit source anchors", () => {
    expect(findMotionAnchors(source)).toEqual([{ line: 6, seconds: 7 }]);
    expect(findSceneMotionAnchors(source, "GroupedEquation")).toEqual([{ line: 6, seconds: 7 }]);
  });

  it("does not use an anchor from another Scene", () => {
    const twoScenes = `${source}\nclass OtherScene(Scene):\n    def construct(self):\n        dot = Dot()\n        # poietra:anchor 9.000\n`;
    expect(findSceneMotionAnchors(twoScenes, "GroupedEquation")).toEqual([{ line: 6, seconds: 7 }]);
    expect(findSceneMotionAnchors(twoScenes, "OtherScene")).toEqual([{ line: 12, seconds: 9 }]);
  });

  it("converts screen pixels to Manim world directions at the exact anchor", () => {
    const lowered = lowerCreateMotionSource(source, request(), { height: 8, width: 14.222 });

    expect(lowered.anchorLine).toBe(6);
    expect(lowered.insertedCode).toContain("equation.animate.shift(1.4222 * RIGHT + 1 * UP)");
    expect(lowered.insertedCode).toContain("run_time=1.5");
    expect(lowered.source.indexOf("# poietra:anchor 7.000")).toBeLessThan(lowered.source.indexOf("self.play("));
    expect(lowered.source.indexOf("self.play(")).toBeLessThan(lowered.source.indexOf("self.wait(1)"));
  });

  it("preserves every known target in one canonical CreateMotion play", () => {
    const multiTargetSource = source.replace(
      "        # poietra:anchor 7.000",
      "        label = Text(\"energy\")\n        # poietra:anchor 7.000",
    );
    const lowered = lowerCreateMotionSource(multiTargetSource, request({
      targets: [
        { entityId: "equation_1", sourceVariable: "equation" },
        { entityId: "label_1", sourceVariable: "label" },
      ],
    }), { height: 8, width: 14.222 });

    expect(lowered.insertedCode).toContain("equation.animate.shift");
    expect(lowered.insertedCode).toContain("label.animate.shift");
  });

  it("rejects a curved path instead of claiming unsupported lowering", () => {
    expect(() => lowerCreateMotionSource(source, request({ controlOffsetPixels: { x: 0, y: -20 } }), { height: 8, width: 14.222 }))
      .toThrowError(new MotionLoweringError(
        "curved-path-unsupported",
        "Rendered validation currently supports straight CreateMotion paths only; reset the bend handle first.",
      ));
  });

  it("requires a source variable before the marker", () => {
    expect(() => lowerCreateMotionSource(source, request({ targets: [{ entityId: "missing_1", sourceVariable: "missing" }] }), { height: 8, width: 14.222 }))
      .toThrowError(/Source variable missing is not defined/);
  });

  it("requires an exact resolved-time marker", () => {
    expect(() => lowerCreateMotionSource(source, request({ interval: { end: 6.5, start: 5 } }), { height: 8, width: 14.222 }))
      .toThrowError(/No # poietra:anchor 5.000 marker/);
  });

  it("rejects values that could inject source through transaction comments", () => {
    expect(createMotionRenderRequestSchema.safeParse(request({ transactionId: "unsafe\nself.remove(equation)" })).success).toBe(false);
  });
});
