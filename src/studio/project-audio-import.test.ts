import { describe, expect, it, vi } from "vitest";

import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";
import { ingestProjectAudioFile } from "./project-audio-import";

function wavHeader(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const ascii = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(bytes, offset, length));
  const channels = view.getUint16(22, true);
  return {
    bitsPerSample: view.getUint16(34, true),
    channels,
    dataBytes: view.getUint32(40, true),
    dataTag: ascii(36, 4),
    format: view.getUint16(20, true),
    riff: ascii(0, 4),
    sampleFrames: view.getUint32(40, true) / (channels * 2),
    sampleRate: view.getUint32(24, true),
    wave: ascii(8, 4),
  };
}

describe("project audio file import", () => {
  it("keeps the existing WAV path byte-exact and never starts the MP3 decoder", async () => {
    const source = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const validateWav = vi.fn(async (bytes: ArrayBuffer) => {
      expect(new Uint8Array(bytes)).toEqual(source);
      return 19_200;
    });
    const decodeMp3 = vi.fn();

    const track = await ingestProjectAudioFile(new File([source], "narration.wav", { type: "audio/wav" }), {
      decodeMp3,
      validateWav,
    });

    expect(track.fileName).toBe("narration.wav");
    expect(track.sourceSampleFrames).toBe(19_200);
    expect(new Uint8Array(track.wavBytes)).toEqual(source);
    expect(validateWav).toHaveBeenCalledOnce();
    expect(decodeMp3).not.toHaveBeenCalled();
  });

  it("decodes mono 44.1 kHz MP3 and resamples it to canonical 48 kHz PCM16 WAV", async () => {
    const sourceSamples = Float32Array.from({ length: 441 }, (_, index) => index / 220.5 - 1);
    let canonicalBytes: ArrayBuffer | null = null;
    const validateWav = vi.fn(async (bytes: ArrayBuffer) => {
      canonicalBytes = bytes;
      return wavHeader(bytes).sampleFrames;
    });
    const decodeMp3 = vi.fn(async () => ({
      getChannelData: (channel: number) => {
        expect(channel).toBe(0);
        return sourceSamples;
      },
      length: sourceSamples.length,
      numberOfChannels: 1,
      sampleRate: 44_100,
    }));

    const track = await ingestProjectAudioFile(
      new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], "voice.mp3", { type: "audio/mpeg" }),
      { decodeMp3, validateWav },
    );

    expect(decodeMp3).toHaveBeenCalledOnce();
    expect(canonicalBytes).not.toBeNull();
    expect(wavHeader(canonicalBytes!)).toEqual({
      bitsPerSample: 16,
      channels: 1,
      dataBytes: 960,
      dataTag: "data",
      format: 1,
      riff: "RIFF",
      sampleFrames: 480,
      sampleRate: 48_000,
      wave: "WAVE",
    });
    expect(track).toMatchObject({
      fileName: "voice.mp3",
      sourceSampleFrames: 480,
      trimEndSampleFrames: 480,
    });
    expect(new Uint8Array(track.wavBytes)).toEqual(new Uint8Array(canonicalBytes!));
  });

  it("interleaves decoded stereo samples in canonical signed PCM16 order", async () => {
    let canonicalBytes: ArrayBuffer | null = null;
    const channels = [Float32Array.from([-1, 0.5]), Float32Array.from([1, -0.5])];
    await ingestProjectAudioFile(new File([new Uint8Array([0xff, 0xfb])], "stereo.MP3"), {
      decodeMp3: async () => ({
        getChannelData: (channel) => channels[channel]!,
        length: 2,
        numberOfChannels: 2,
        sampleRate: 48_000,
      }),
      validateWav: async (bytes) => {
        canonicalBytes = bytes;
        return 2;
      },
    });

    expect(wavHeader(canonicalBytes!).channels).toBe(2);
    const samples = new DataView(canonicalBytes!);
    expect([44, 46, 48, 50].map((offset) => samples.getInt16(offset, true))).toEqual([
      -32_768, 32_767, 16_384, -16_384,
    ]);
  });

  it("keeps unsupported containers out of the bounded browser import", async () => {
    const decodeMp3 = vi.fn();
    const oversizedMp3 = new File([], "large.mp3", { type: "audio/mpeg" });
    Object.defineProperty(oversizedMp3, "size", { value: MAX_EXPORT_WAV_BYTES + 1 });
    await expect(
      ingestProjectAudioFile(new File([new Uint8Array([1])], "voice.m4a", { type: "audio/mp4" }), { decodeMp3 }),
    ).rejects.toThrow("WAV or MP3");
    await expect(ingestProjectAudioFile(oversizedMp3, { decodeMp3 })).rejects.toThrow("64 MiB");
    expect(decodeMp3).not.toHaveBeenCalled();
  });
});
