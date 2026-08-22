import { describe, expect, it } from "vitest";

import {
  planStudioPlaybackUpdate,
  STUDIO_PLAYBACK_MAX_UPDATES_PER_SECOND,
  studioPlaybackSampleTime,
} from "./playback-scheduler";

describe("Studio playback scheduler", () => {
  it("caps high-refresh displays without accumulating catch-up updates", () => {
    const displayFrameMs = 1_000 / 144;
    let nextUpdateAtMs = 0;
    let updates = 0;

    for (let frame = 1; frame <= 144; frame += 1) {
      const plan = planStudioPlaybackUpdate(nextUpdateAtMs, frame * displayFrameMs);
      nextUpdateAtMs = plan.nextUpdateAtMs;
      if (plan.publish) updates += 1;
    }

    expect(updates).toBeLessThanOrEqual(STUDIO_PLAYBACK_MAX_UPDATES_PER_SECOND + 1);
    expect(updates).toBeGreaterThanOrEqual(STUDIO_PLAYBACK_MAX_UPDATES_PER_SECOND - 1);

    const afterLongPause = planStudioPlaybackUpdate(nextUpdateAtMs, 5_000);
    expect(afterLongPause.publish).toBe(true);
    expect(afterLongPause.nextUpdateAtMs).toBeGreaterThan(5_000);
  });

  it("uses elapsed wall time and clamps the terminal sample", () => {
    expect(studioPlaybackSampleTime(1_000, 2, 1_250, 10)).toBe(2.25);
    expect(studioPlaybackSampleTime(1_000, 2, 900, 10)).toBe(2);
    expect(studioPlaybackSampleTime(1_000, 9.9, 1_500, 10)).toBe(10);
  });
});
