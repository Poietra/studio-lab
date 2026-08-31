import { describe, expect, it, vi } from "vitest";

import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";
import {
  cloneProjectAudioTrack,
  ingestProjectAudioWav,
  projectAudioTimingSeconds,
  updateProjectAudioTiming,
} from "./project-audio-track";

describe("project audio track", () => {
  it("admits a bounded File through the canonical WAV validator", async () => {
    const validate = vi.fn(async () => 19_200);
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "narration.wav", { type: "audio/wav" });

    const track = await ingestProjectAudioWav(file, validate);

    expect(track.fileName).toBe("narration.wav");
    expect(track).toMatchObject({
      sourceSampleFrames: 19_200,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 19_200,
      trimStartSampleFrames: 0,
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
      fileName: "voice.wav",
      sourceSampleFrames: 3,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 3,
      trimStartSampleFrames: 0,
      wavBytes: new Uint8Array([1, 2, 3]).buffer,
    };
    const copy = cloneProjectAudioTrack(source);

    expect(copy.wavBytes).not.toBe(source.wavBytes);
    expect(new Uint8Array(copy.wavBytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("converts bounded second edits to exact 48 kHz sample frames", () => {
    const track = {
      fileName: "voice.wav",
      sourceSampleFrames: 48_000,
      timelineOffsetSampleFrames: 0,
      trimEndSampleFrames: 48_000,
      trimStartSampleFrames: 0,
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
});
