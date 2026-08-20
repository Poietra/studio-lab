import { describe, expect, it } from "vitest";

import { projectProposedState } from "./evaluator";
import { createFixtureProposedState } from "./fixture";

describe("timeline projection", () => {
  it("marks source-owned animation channels read-only with an actionable reason", () => {
    const track = projectProposedState(createFixtureProposedState(), 5).timeline.objectTracks.find(
      ({ entityId }) => entityId === "equation_1",
    );

    expect(track?.animatedChannels).toContainEqual(
      expect.objectContaining({
        key: "position",
        readOnlyReason: expect.stringMatching(/imported Manim source.*Edit the Python source/i),
      }),
    );
  });
});
