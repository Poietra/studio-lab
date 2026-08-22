import { describe, expect, it, vi } from "vitest";

import { createStudioPlaybackClock } from "./studio-playback-clock";

function createFrameDriver() {
  let nowMs = 0;
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requested = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  const canceled = vi.fn((handle: number) => callbacks.delete(handle));

  return {
    callbacks,
    cancelFrame: canceled,
    canceled,
    now: () => nowMs,
    requestFrame: requested,
    run(now: number) {
      nowMs = now;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(now);
    },
    setNow(now: number) {
      nowMs = now;
    },
  };
}

function start(clock: ReturnType<typeof createStudioPlaybackClock>, sceneKey = "scene:a") {
  const onEnded = vi.fn();
  clock.play({ currentTime: 0, duration: 10, onEnded, sceneKey });
  return onEnded;
}

describe("Studio playback clock", () => {
  it("caps high-refresh display notifications at 60Hz", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    const listener = vi.fn();
    clock.subscribe(listener);
    start(clock);

    for (let frame = 1; frame <= 144; frame += 1) driver.run((frame * 1_000) / 144);

    expect(listener).toHaveBeenCalledTimes(61);
    expect(clock.getSnapshot().currentTime).toBeCloseTo(1, 10);
  });

  it("drops missed UI samples without slowing the wall-clock playhead", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    start(clock);

    driver.run(5_101);
    expect(clock.getSnapshot().currentTime).toBe(5.101);

    driver.run(5_110);
    expect(clock.getSnapshot().currentTime).toBe(5.101);

    driver.run(5_200);
    expect(clock.getSnapshot().currentTime).toBe(5.2);
  });

  it("pauses at the exact wall-clock sample even between publication deadlines", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    start(clock);

    driver.setNow(253);
    const paused = clock.pause();

    expect(paused.wasPlaying).toBe(true);
    expect(paused.snapshot).toEqual({ currentTime: 0.253, duration: 10, playing: false, sceneKey: "scene:a" });
    expect(driver.canceled).toHaveBeenCalledTimes(1);
  });

  it("clamps the terminal frame and invokes onEnded exactly once", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    const onEnded = vi.fn();
    clock.play({ currentTime: 9.9, duration: 10, onEnded, sceneKey: "scene:a" });

    driver.run(200);
    driver.run(400);

    expect(clock.getSnapshot()).toEqual({ currentTime: 10, duration: 10, playing: false, sceneKey: "scene:a" });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not create another rAF for a repeated active play request", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    const firstEnded = start(clock);
    const replacementEnded = vi.fn();

    clock.play({ currentTime: 0, duration: 10, onEnded: replacementEnded, sceneKey: "scene:a" });

    expect(driver.requestFrame).toHaveBeenCalledTimes(1);
    driver.run(10_000);
    expect(firstEnded).not.toHaveBeenCalled();
    expect(replacementEnded).toHaveBeenCalledTimes(1);
  });

  it("invalidates callbacks from the prior scene after reset", () => {
    const driver = createFrameDriver();
    const clock = createStudioPlaybackClock(driver);
    start(clock);
    const staleCallback = [...driver.callbacks.values()][0];
    expect(staleCallback).toBeDefined();

    clock.reset({ currentTime: 2, duration: 8, sceneKey: "scene:b" });
    staleCallback?.(5_000);

    expect(clock.getSnapshot()).toEqual({ currentTime: 2, duration: 8, playing: false, sceneKey: "scene:b" });
    expect(driver.callbacks.size).toBe(0);
  });
});
