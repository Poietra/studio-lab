import { describe, expect, it, vi } from "vitest";
import { alignProjectAudioElement } from "./project-audio-playback";
import type { StudioPlaybackClockSnapshot } from "./studio-playback-clock";

function snapshot(currentTime: number, playing: boolean): StudioPlaybackClockSnapshot {
  return { currentTime, duration: 4, playing, sceneKey: "scene" };
}

const track = {
  sourceSampleFrames: 48_000,
  timelineOffsetSampleFrames: 4_800,
  trimEndSampleFrames: 28_800,
  trimStartSampleFrames: 9_600,
  volumePercent: 50,
  wavBytes: new ArrayBuffer(1),
} as const;

describe("project audio playback alignment", () => {
  it.each([
    [0, 0],
    [50, 0.5],
    [100, 1],
  ])("maps %i percent project volume onto the audio element", (volumePercent, expected) => {
    const audio = { currentTime: 0, pause: vi.fn(), paused: true, play: vi.fn(), volume: 1 };

    alignProjectAudioElement(audio, snapshot(0.25, false), { ...track, volumePercent });

    expect(audio.volume).toBe(expected);
  });

  it("seeks and pauses with the stopped Studio clock", () => {
    const audio = { currentTime: 0, pause: vi.fn(), paused: false, play: vi.fn(), volume: 1 };

    expect(alignProjectAudioElement(audio, snapshot(0.25, false), track)).toBe(false);

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBeCloseTo(0.35);
    expect(audio.volume).toBe(0.5);
  });

  it("starts a paused element and only corrects material playback drift", () => {
    const audio = { currentTime: 1, pause: vi.fn(), paused: true, play: vi.fn(), volume: 1 };

    expect(alignProjectAudioElement(audio, snapshot(0.25, true), track)).toBe(true);
    expect(audio.currentTime).toBeCloseTo(0.35);

    audio.paused = false;
    expect(alignProjectAudioElement(audio, snapshot(0.45, true), track)).toBe(false);
    expect(audio.currentTime).toBeCloseTo(0.55);
  });

  it("seeks a paused element to trim in before starting playback", () => {
    const audio = { currentTime: 0, pause: vi.fn(), paused: true, play: vi.fn(), volume: 1 };
    const shortTrim = {
      ...track,
      timelineOffsetSampleFrames: 0,
      trimStartSampleFrames: 4_800,
    };

    expect(alignProjectAudioElement(audio, snapshot(0, true), shortTrim)).toBe(true);
    expect(audio.currentTime).toBeCloseTo(0.1);
  });

  it("pauses outside the placed interval and keeps the legacy full-source mapping", () => {
    const audio = { currentTime: 0.4, pause: vi.fn(), paused: false, play: vi.fn(), volume: 1 };

    expect(alignProjectAudioElement(audio, snapshot(0.05, true), track)).toBe(false);
    expect(audio.pause).toHaveBeenCalledOnce();
    audio.paused = false;
    expect(alignProjectAudioElement(audio, snapshot(0.51, true), track)).toBe(false);
    expect(audio.pause).toHaveBeenCalledTimes(2);

    const legacy = {
      sourceSampleFrames: null,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: null,
      trimStartSampleFrames: 0,
      volumePercent: 100,
      wavBytes: new ArrayBuffer(1),
    } as const;
    audio.paused = true;
    expect(alignProjectAudioElement(audio, snapshot(1.25, false), legacy)).toBe(false);
    expect(audio.currentTime).toBe(1.25);
  });
});
