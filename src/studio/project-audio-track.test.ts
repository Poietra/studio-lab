import { describe, expect, it, vi } from "vitest";

import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";
import { cloneProjectAudioTrack, ingestProjectAudioWav } from "./project-audio-track";

describe("project audio track", () => {
  it("admits a bounded File through the canonical WAV validator", async () => {
    const validate = vi.fn(async () => undefined);
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "narration.wav", { type: "audio/wav" });

    const track = await ingestProjectAudioWav(file, validate);

    expect(track.fileName).toBe("narration.wav");
    expect(new Uint8Array(track.wavBytes)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    expect(validate).toHaveBeenCalledOnce();
  });

  it("rejects empty and oversized input before loading the validator", async () => {
    const validate = vi.fn(async () => undefined);
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
    const source = { fileName: "voice.wav", wavBytes: new Uint8Array([1, 2, 3]).buffer };
    const copy = cloneProjectAudioTrack(source);

    expect(copy.wavBytes).not.toBe(source.wavBytes);
    expect(new Uint8Array(copy.wavBytes)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
