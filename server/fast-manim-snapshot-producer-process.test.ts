import { describe, expect, it } from "vitest";

import { resolveProducerProcessTimings } from "./fast-manim-snapshot-producer-process";

describe("fast-manim producer supervision timings", () => {
  it("keeps the production kill and pipe-close grace windows", () => {
    expect(resolveProducerProcessTimings()).toEqual({ closeGraceMs: 5_000, killGraceMs: 2_000 });
  });

  it("accepts bounded test or embedding overrides without changing the defaults", () => {
    expect(resolveProducerProcessTimings({ closeGraceMs: 150, killGraceMs: 75 })).toEqual({
      closeGraceMs: 150,
      killGraceMs: 75,
    });
    expect(resolveProducerProcessTimings()).toEqual({ closeGraceMs: 5_000, killGraceMs: 2_000 });
  });

  it.each([0, -1, 60_001, 1.5, Number.NaN])("rejects an invalid grace window of %s", (value) => {
    expect(() => resolveProducerProcessTimings({ closeGraceMs: value })).toThrow(/positive integer/i);
    expect(() => resolveProducerProcessTimings({ killGraceMs: value })).toThrow(/positive integer/i);
  });
});
