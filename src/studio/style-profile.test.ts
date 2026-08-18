import { describe, expect, it } from "vitest";

import { STUDIO_STYLE_PROFILE, styleProfileSchema } from "./style-profile";

describe("Studio StyleProfile", () => {
  it("owns the shared authoring spacing unit", () => {
    expect(styleProfileSchema.parse(STUDIO_STYLE_PROFILE).spacingUnitPx).toBe(24);
  });
});
