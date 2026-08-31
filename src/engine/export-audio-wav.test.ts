import { describe, expect, it, vi } from "vitest";

import { createExportAudioWavValidator, validateExportAudioWav } from "./export-audio-wav";

function monoPcmWav(sampleRate = 48_000) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return bytes.buffer;
}

describe("export WAV validation", () => {
  it("uses the production Rust/WASM parser", async () => {
    await expect(validateExportAudioWav(monoPcmWav())).resolves.toBe(1);
    await expect(validateExportAudioWav(monoPcmWav(44_100))).rejects.toThrow("44100 Hz is not 48000 Hz");
  });

  it("passes exact bytes to the canonical Rust validator", async () => {
    const validateExportAudioWavV1 = vi.fn((_bytes: Uint8Array) => 12);
    const validate = createExportAudioWavValidator(async () => ({ validateExportAudioWavV1 }));
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;

    await validate(wavBytes);

    expect(validateExportAudioWavV1).toHaveBeenCalledOnce();
    expect(validateExportAudioWavV1.mock.calls[0]?.[0]).toEqual(new Uint8Array(wavBytes));
  });

  it("preserves the Rust admission diagnostic", async () => {
    const validate = createExportAudioWavValidator(async () => ({
      validateExportAudioWavV1() {
        throw new Error("WAV sample rate 44100 Hz is not 48000 Hz");
      },
    }));

    await expect(validate(new ArrayBuffer(44))).rejects.toThrow("WAV sample rate 44100 Hz is not 48000 Hz");
  });
});
