import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  deriveSquareToCircleV8PositionPlan,
  SquareToCircleV8CandidateSourceError,
} from "./fast-manim-square-to-circle-v8-candidate";

const source = await readFile(
  new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const anchor = "        circle.set_fill(PINK, opacity=0.5)\n";

function edited(lines: readonly string[]) {
  return source.replace(anchor, `${anchor}${lines.join("\n")}\n`);
}

describe("SquareToCircle V8 candidate source", () => {
  it("derives the only paired initial-position edit and admits the official source as empty", () => {
    expect(deriveSquareToCircleV8PositionPlan(source, "SquareToCircle")).toEqual({ moveTo: null });
    expect(
      deriveSquareToCircleV8PositionPlan(
        edited(["        square.move_to((2, 1, 0))", "        circle.move_to((2, 1, 0))"]),
        "SquareToCircle",
      ),
    ).toEqual({ moveTo: { x: 2, y: 1 } });
  });

  it.each([
    ["missing hidden target closure", ["        square.move_to((2, 1, 0))"]],
    ["reversed dependency order", ["        circle.move_to((2, 1, 0))", "        square.move_to((2, 1, 0))"]],
    ["unequal target positions", ["        square.move_to((2, 1, 0))", "        circle.move_to((2, -1, 0))"]],
    ["a no-op", ["        square.move_to((0, 0, 0))", "        circle.move_to((0, 0, 0))"]],
    ["noncanonical numeric spelling", ["        square.move_to((2.0, 1, 0))", "        circle.move_to((2.0, 1, 0))"]],
    ["an expression", ["        square.move_to((2 + 1, 1, 0))", "        circle.move_to((2 + 1, 1, 0))"]],
    [
      "an out-of-range coordinate",
      ["        square.move_to((1000000001, 1, 0))", "        circle.move_to((1000000001, 1, 0))"],
    ],
    [
      "an extra direct statement",
      ["        square.move_to((2, 1, 0))", "        circle.move_to((2, 1, 0))", "        square.set_opacity(0.5)"],
    ],
  ])("rejects %s before producer execution", (_label, lines) => {
    expect(() => deriveSquareToCircleV8PositionPlan(edited(lines), "SquareToCircle")).toThrow(
      SquareToCircleV8CandidateSourceError,
    );
  });

  it("rejects sibling edits and a different selected Scene", () => {
    const candidate = edited(["        square.move_to((2, 1, 0))", "        circle.move_to((2, 1, 0))"]);
    expect(() =>
      deriveSquareToCircleV8PositionPlan(
        candidate.replace("self.play(FadeOut(square))", "self.play(FadeOut(circle))"),
        "SquareToCircle",
      ),
    ).toThrow(SquareToCircleV8CandidateSourceError);
    expect(() => deriveSquareToCircleV8PositionPlan(candidate, "WarpSquare")).toThrow(
      SquareToCircleV8CandidateSourceError,
    );
  });

  it("rejects visually similar lines outside the audited insertion boundary", () => {
    const candidate = source.replace(
      "        self.play(FadeOut(square))\n",
      [
        "        self.play(FadeOut(square))",
        "        square.move_to((2, 1, 0))",
        "        circle.move_to((2, 1, 0))",
        "",
      ].join("\n"),
    );
    expect(() => deriveSquareToCircleV8PositionPlan(candidate, "SquareToCircle")).toThrow(
      SquareToCircleV8CandidateSourceError,
    );
  });
});
