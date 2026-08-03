import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { applyEngineEasingV1 } from "./easing";

type ManimSmoothFixture = Readonly<{
  reference: Readonly<{ inflection: number; manimVersion: string; symbol: string }>;
  samples: readonly Readonly<{ progress: number; value: number }>[];
  tolerance: number;
}>;

describe("Poietra Engine easing v1", () => {
  it("samples linear and smooth easing with their fixed formulas", () => {
    expect(applyEngineEasingV1({ kind: "linear" }, 0.25)).toBe(0.25);
    expect(applyEngineEasingV1({ kind: "smooth" }, 0.25)).toBe(0.15625);
    expect(applyEngineEasingV1({ kind: "smooth" }, 0.5)).toBe(0.5);
  });

  it("matches fixed Python Manim default smooth samples", async () => {
    const path = new URL("../../fixtures/engine-v1/manim-smooth-easing.json", import.meta.url);
    const fixture = JSON.parse(await readFile(path, "utf8")) as ManimSmoothFixture;

    expect(fixture.reference).toEqual({
      inflection: 10,
      manimVersion: "0.20.1",
      symbol: "manim.utils.rate_functions.smooth",
    });
    for (const { progress, value } of fixture.samples) {
      expect(Math.abs(applyEngineEasingV1({ kind: "manim-smooth" }, progress) - value)).toBeLessThanOrEqual(
        fixture.tolerance,
      );
    }
  });

  it("solves a CSS-style cubic bezier deterministically", () => {
    expect(applyEngineEasingV1({ kind: "cubic-bezier", x1: 0, x2: 1, y1: 0, y2: 1 }, 0.3)).toBeCloseTo(0.3, 6);
    expect(applyEngineEasingV1({ kind: "cubic-bezier", x1: 0.42, x2: 1, y1: 0, y2: 1 }, 0.5)).toBeCloseTo(0.3153568, 6);
    expect(applyEngineEasingV1({ kind: "cubic-bezier", x1: 0.25, x2: 0.75, y1: 0.1, y2: 1 }, 0)).toBe(0);
    expect(applyEngineEasingV1({ kind: "cubic-bezier", x1: 0.25, x2: 0.75, y1: 0.1, y2: 1 }, 1)).toBe(1);
  });

  it("bounds progress before evaluating", () => {
    expect(applyEngineEasingV1({ kind: "linear" }, -1)).toBe(0);
    expect(applyEngineEasingV1({ kind: "linear" }, 2)).toBe(1);
  });
});
