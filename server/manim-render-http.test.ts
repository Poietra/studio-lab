import { describe, expect, it } from "vitest";

import { resolveByteRange } from "./manim-render-http";

describe("Manim video byte ranges", () => {
  it("supports full, bounded, open-ended, and suffix requests", () => {
    expect(resolveByteRange(undefined, 1_000)).toEqual({ kind: "full" });
    expect(resolveByteRange("bytes=10-19", 1_000)).toEqual({ end: 19, kind: "partial", start: 10 });
    expect(resolveByteRange("bytes=900-", 1_000)).toEqual({ end: 999, kind: "partial", start: 900 });
    expect(resolveByteRange("bytes=-100", 1_000)).toEqual({ end: 999, kind: "partial", start: 900 });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(resolveByteRange("items=0-1", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=-", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=1000-", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=20-10", 1_000)).toEqual({ kind: "invalid" });
  });
});
