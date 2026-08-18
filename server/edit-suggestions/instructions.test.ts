import { describe, expect, it } from "vitest";

import { EDIT_SUGGESTION_INSTRUCTIONS } from "./instructions";

describe("edit suggestion style instructions", () => {
  it("uses the request style profile instead of duplicated default values", () => {
    expect(EDIT_SUGGESTION_INSTRUCTIONS).toContain("styleProfile.durationSeconds.deliberate");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).toContain("styleProfile.durationSeconds.standard");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).toContain("styleProfile.durationSeconds.brief");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).toContain("styleProfile.easing");

    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("create-motion 1.5 seconds");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("create-explanation 1.0 second");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("delete-objects 0.4 seconds");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("otherwise use 1.5 seconds");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("defaults to one second");
    expect(EDIT_SUGGESTION_INSTRUCTIONS).not.toContain("Use smooth easing");
  });
});
