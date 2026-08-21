import { describe, expect, it } from "vitest";

import { importStudioSvgPathAsset, studioSvgPathAssetsMatchingQuery } from "./studio-svg-assets";

function svgFile(source: string, name = "diagram.svg") {
  return new File([source], name, { type: "image/svg+xml" });
}

describe("Studio SVG path assets", () => {
  it("imports only metadata returned by the canonical Rust parser", async () => {
    const asset = await importStudioSvgPathAsset(
      svgFile(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><path d="M10 70 L60 10 Q90 5 110 30 C100 60 80 75 10 70 Z" fill="#38bdf8" stroke="white" stroke-width="3"/></svg>',
      ),
    );

    expect(asset).toMatchObject({
      dimensions: { height: 2, width: 3 },
      hasFill: true,
      hasStroke: true,
      label: "diagram.svg",
      segmentCount: 3,
      subpathCount: 1,
    });
    expect(studioSvgPathAssetsMatchingQuery([asset], "3 segments")).toEqual([asset]);
  });

  it("surfaces unsupported SVG instead of creating a fallback asset", async () => {
    await expect(
      importStudioSvgPathAsset(svgFile('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>')),
    ).rejects.toThrow(/element <circle> is unsupported/);
  });
});
