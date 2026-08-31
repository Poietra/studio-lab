import { describe, expect, it, vi } from "vitest";

import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";
import {
  cloneProjectAudioTrack,
  ingestProjectAudioWav,
  projectAudioMixSettings,
  projectAudioTimelineTimingAtDelta,
  projectAudioTimingSeconds,
  updateProjectAudioMix,
  updateProjectAudioTiming,
} from "./project-audio-track";

describe("project audio track", () => {
  it("admits a bounded File through the canonical WAV validator", async () => {
    const validate = vi.fn(async () => 19_200);
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "narration.wav", { type: "audio/wav" });

    const track = await ingestProjectAudioWav(file, validate);

    expect(track.fileName).toBe("narration.wav");
    expect(track).toMatchObject({
      fadeInSampleFrames: 0,
      fadeOutSampleFrames: 0,
      sourceSampleFrames: 19_200,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 19_200,
      trimStartSampleFrames: 0,
      volumePercent: 100,
    });
    expect(new Uint8Array(track.wavBytes)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    expect(validate).toHaveBeenCalledOnce();
  });

  it("rejects empty and oversized input before loading the validator", async () => {
    const validate = vi.fn(async () => 1);
    const oversized = {
      arrayBuffer: vi.fn(),
      name: "large.wav",
      size: MAX_EXPORT_WAV_BYTES + 1,
    } as unknown as File;

    await expect(ingestProjectAudioWav(new File([], "empty.wav"), validate)).rejects.toThrow("non-empty WAV");
    await expect(ingestProjectAudioWav(oversized, validate)).rejects.toThrow("64 MiB");
    expect(validate).not.toHaveBeenCalled();
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });

  it("clones owned bytes", () => {
    const source = {
      fadeInSampleFrames: 0,
      fadeOutSampleFrames: 0,
      fileName: "voice.wav",
      sourceSampleFrames: 3,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 3,
      trimStartSampleFrames: 0,
      volumePercent: 100,
      wavBytes: new Uint8Array([1, 2, 3]).buffer,
    };
    const copy = cloneProjectAudioTrack(source);

    expect(copy.wavBytes).not.toBe(source.wavBytes);
    expect(new Uint8Array(copy.wavBytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("converts bounded second edits to exact 48 kHz sample frames", () => {
    const track = {
      fadeInSampleFrames: 0,
      fadeOutSampleFrames: 0,
      fileName: "voice.wav",
      sourceSampleFrames: 48_000,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 48_000,
      trimStartSampleFrames: 0,
      volumePercent: 100,
      wavBytes: new ArrayBuffer(1),
    };

    const updated = updateProjectAudioTiming(track, { offset: 0.25, trimEnd: 0.75, trimStart: 0.1 });

    expect(updated).toMatchObject({
      timelineOffsetSampleFrames: 12_000,
      trimEndSampleFrames: 36_000,
      trimStartSampleFrames: 4_800,
    });
    expect(projectAudioTimingSeconds(updated)).toEqual({ offset: 0.25, trimEnd: 0.75, trimStart: 0.1 });
    expect(() => updateProjectAudioTiming(track, { offset: 0, trimEnd: 0.1, trimStart: 0.1 })).toThrow(
      "later than trim in",
    );
    expect(() => updateProjectAudioTiming(track, { offset: 0, trimEnd: 1.01, trimStart: 0 })).toThrow("cannot exceed");
  });

  it("updates bounded volume and fade durations on the 48 kHz grid", () => {
    const track = {
      fadeInSampleFrames: 0,
      fadeOutSampleFrames: 0,
      fileName: "voice.wav",
      sourceSampleFrames: 48_000,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 48_000,
      trimStartSampleFrames: 0,
      volumePercent: 100,
      wavBytes: new ArrayBuffer(1),
    };

    const updated = updateProjectAudioMix(track, {
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.2,
      volumePercent: 50,
    });
    expect(updated).toMatchObject({ fadeInSampleFrames: 4_800, fadeOutSampleFrames: 9_600, volumePercent: 50 });
    expect(projectAudioMixSettings(updated)).toEqual({
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.2,
      volumePercent: 50,
    });
    expect(updateProjectAudioMix(track, { fadeInSeconds: 0, fadeOutSeconds: 0, volumePercent: 0 }).volumePercent).toBe(
      0,
    );
    expect(() => updateProjectAudioMix(track, { fadeInSeconds: 0, fadeOutSeconds: 0, volumePercent: -1 })).toThrow(
      "0 to 100",
    );
    expect(() => updateProjectAudioMix(track, { fadeInSeconds: 0, fadeOutSeconds: 0, volumePercent: 101 })).toThrow(
      "0 to 100",
    );
    expect(() => updateProjectAudioMix(track, { fadeInSeconds: 0, fadeOutSeconds: 0, volumePercent: 50.5 })).toThrow(
      "integer",
    );
    expect(() => updateProjectAudioMix(track, { fadeInSeconds: -1, fadeOutSeconds: 0, volumePercent: 100 })).toThrow(
      "non-negative",
    );
  });

  it("moves a Timeline clip start within the Scene without changing its source trim", () => {
    const track = {
      sourceSampleFrames: 96_000,
      timelineOffsetSampleFrames: 24_000,
      trimEndSampleFrames: 60_000,
      trimStartSampleFrames: 12_000,
    };

    expect(projectAudioTimelineTimingAtDelta(track, 2, 1, "body")).toEqual({
      offset: 1.5,
      trimEnd: 1.25,
      trimStart: 0.25,
    });
    expect(projectAudioTimelineTimingAtDelta(track, 2, -1, "body")).toEqual({
      offset: 0,
      trimEnd: 1.25,
      trimStart: 0.25,
    });
  });

  it("moves audio longer than the Scene and clamps only its start", () => {
    const track = {
      sourceSampleFrames: 96_000,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: null,
      trimStartSampleFrames: 0,
    };

    expect(projectAudioTimelineTimingAtDelta(track, 1, 0.25, "body")).toEqual({
      offset: 0.25,
      trimEnd: null,
      trimStart: 0,
    });
    expect(projectAudioTimelineTimingAtDelta(track, 1, 2, "body")).toEqual({
      offset: 47_999 / 48_000,
      trimEnd: null,
      trimStart: 0,
    });
  });

  it("links the left edge offset and trim-in while keeping the Timeline end fixed", () => {
    const track = {
      sourceSampleFrames: 96_000,
      timelineOffsetSampleFrames: 24_000,
      trimEndSampleFrames: 60_000,
      trimStartSampleFrames: 12_000,
    };

    expect(projectAudioTimelineTimingAtDelta(track, 2, 0.2, "left")).toEqual({
      offset: 0.7,
      trimEnd: 1.25,
      trimStart: 0.45,
    });
    expect(projectAudioTimelineTimingAtDelta(track, 2, -0.4, "left")).toEqual({
      offset: 0.25,
      trimEnd: 1.25,
      trimStart: 0,
    });
  });

  it("keeps the original timing when the left edge has no safe Scene range", () => {
    expect(
      projectAudioTimelineTimingAtDelta(
        {
          sourceSampleFrames: 96_000,
          timelineOffsetSampleFrames: 96_000,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 0,
        },
        1,
        -0.5,
        "left",
      ),
    ).toEqual({ offset: 2, trimEnd: null, trimStart: 0 });
  });

  it("clamps the right edge to the source and Scene bounds", () => {
    const track = {
      sourceSampleFrames: 96_000,
      timelineOffsetSampleFrames: 24_000,
      trimEndSampleFrames: 60_000,
      trimStartSampleFrames: 12_000,
    };

    expect(projectAudioTimelineTimingAtDelta(track, 2, 2, "right")).toEqual({
      offset: 0.5,
      trimEnd: 1.75,
      trimStart: 0.25,
    });
    expect(projectAudioTimelineTimingAtDelta(track, 2, -2, "right")).toEqual({
      offset: 0.5,
      trimEnd: 12_001 / 48_000,
      trimStart: 0.25,
    });
    expect(projectAudioTimelineTimingAtDelta({ ...track, trimEndSampleFrames: null }, 3, 0, "right")).toEqual({
      offset: 0.5,
      trimEnd: null,
      trimStart: 0.25,
    });
    expect(
      projectAudioTimelineTimingAtDelta(
        {
          sourceSampleFrames: 96_000,
          timelineOffsetSampleFrames: 48_000,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 0,
        },
        0.5,
        0,
        "right",
      ),
    ).toEqual({ offset: 1, trimEnd: null, trimStart: 0 });
    expect(
      projectAudioTimelineTimingAtDelta(
        {
          sourceSampleFrames: 96_000,
          timelineOffsetSampleFrames: 48_000,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 0,
        },
        0.5,
        -0.25,
        "right",
      ),
    ).toEqual({ offset: 1, trimEnd: null, trimStart: 0 });
  });

  it("moves the visible right handle when the source clip extends past the Scene", () => {
    const track = {
      sourceSampleFrames: 96_000,
      timelineOffsetSampleFrames: 24_000,
      trimEndSampleFrames: null,
      trimStartSampleFrames: 0,
    };

    expect(projectAudioTimelineTimingAtDelta(track, 1, -0.1, "right")).toEqual({
      offset: 0.5,
      trimEnd: 0.4,
      trimStart: 0,
    });
    expect(projectAudioTimelineTimingAtDelta(track, 1, 0.1, "right")).toEqual({
      offset: 0.5,
      trimEnd: null,
      trimStart: 0,
    });
  });
});
