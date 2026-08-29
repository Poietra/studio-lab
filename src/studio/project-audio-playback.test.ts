import { describe, expect, it, vi } from "vitest";
import { alignProjectAudioElement } from "./project-audio-playback";
import type { StudioPlaybackClockSnapshot } from "./studio-playback-clock";

function snapshot(currentTime: number, playing: boolean): StudioPlaybackClockSnapshot {
  return { currentTime, duration: 4, playing, sceneKey: "scene" };
}

describe("project audio playback alignment", () => {
  it("seeks and pauses with the stopped Studio clock", () => {
    const audio = { currentTime: 0, pause: vi.fn(), paused: false, play: vi.fn() };

    expect(alignProjectAudioElement(audio, snapshot(1.25, false))).toBe(false);

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(1.25);
  });

  it("starts a paused element and only corrects material playback drift", () => {
    const audio = { currentTime: 1, pause: vi.fn(), paused: true, play: vi.fn() };

    expect(alignProjectAudioElement(audio, snapshot(1.05, true))).toBe(true);
    expect(audio.currentTime).toBe(1);

    audio.paused = false;
    expect(alignProjectAudioElement(audio, snapshot(1.25, true))).toBe(false);
    expect(audio.currentTime).toBe(1.25);
  });
});
