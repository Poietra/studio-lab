import { describe, expect, it } from "vitest";

import { samplePropertyValue } from "./property-sampling";

describe("property sampling", () => {
  it("interpolates Rectangle corner radius in both directions", () => {
    const sample = (from: number, to: number) =>
      samplePropertyValue(
        [
          {
            easing: "linear" as const,
            from: { cornerRadius: from, height: 2, width: 4 },
            interval: { end: 1, start: 0 },
            kind: "animated" as const,
            provenanceId: "resize-rounded-rectangle",
            value: { cornerRadius: to, height: 2, width: 4 },
          },
        ],
        0.5,
      );

    expect(sample(0, 1)).toEqual({ cornerRadius: 0.5, height: 2, width: 4 });
    expect(sample(1, 0)).toEqual({ cornerRadius: 0.5, height: 2, width: 4 });
  });
});
