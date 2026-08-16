import { describe, expect, it } from "vitest";

import { MAX_EXPORT_OUTPUT_BYTES } from "../src/engine/export-profile";
import { MAX_VIDEO_SAVE_BYTES, MAX_VIDEO_SAVE_FILE_NAME_LENGTH, parseSaveVideoFileRequestV1 } from "./save-video-file";

const VALID_BYTES = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);

function request(overrides: Record<string, unknown> = {}) {
  return { bytes: VALID_BYTES, fileName: "scene.mp4", ...overrides };
}

describe("parseSaveVideoFileRequestV1", () => {
  it("admits a plain-basename .mp4 name with bounded bytes", () => {
    const parsed = parseSaveVideoFileRequestV1(request());
    expect(parsed.fileName).toBe("scene.mp4");
    expect(parsed.bytes).toBe(VALID_BYTES);
    expect(parseSaveVideoFileRequestV1(request({ fileName: "Scene.MP4" })).fileName).toBe("Scene.MP4");
  });

  it("caps the saved bytes at the canonical ExportProfileV1 output ceiling", () => {
    expect(MAX_VIDEO_SAVE_BYTES).toBe(MAX_EXPORT_OUTPUT_BYTES);
    expect(MAX_VIDEO_SAVE_BYTES).toBe(134_217_728);
  });

  it("rejects non-object envelopes", () => {
    for (const input of [null, undefined, "scene.mp4", 7, [request()]]) {
      expect(() => parseSaveVideoFileRequestV1(input)).toThrow(/Video export input is invalid/);
    }
  });

  it("rejects names that are not a plain basename", () => {
    for (const fileName of ["../scene.mp4", "nested/scene.mp4", "/tmp/scene.mp4", ".", "..", ""]) {
      expect(() => parseSaveVideoFileRequestV1(request({ fileName }))).toThrow(/Video export input is invalid/);
    }
    expect(() => parseSaveVideoFileRequestV1(request({ fileName: 7 }))).toThrow(/Video export input is invalid/);
  });

  it("rejects non-.mp4 suffixes and overlong names", () => {
    for (const fileName of ["scene.py", "scene.mp4.exe", "scene", "scene.mov"]) {
      expect(() => parseSaveVideoFileRequestV1(request({ fileName }))).toThrow(/Video export input is invalid/);
    }
    const overlong = `${"a".repeat(MAX_VIDEO_SAVE_FILE_NAME_LENGTH - 3)}.mp4`;
    expect(overlong.length).toBe(MAX_VIDEO_SAVE_FILE_NAME_LENGTH + 1);
    expect(() => parseSaveVideoFileRequestV1(request({ fileName: overlong }))).toThrow(/Video export input is invalid/);
    const exact = `${"a".repeat(MAX_VIDEO_SAVE_FILE_NAME_LENGTH - 4)}.mp4`;
    expect(parseSaveVideoFileRequestV1(request({ fileName: exact })).fileName).toBe(exact);
  });

  it("rejects missing, empty, foreign-typed, and oversized bytes", () => {
    for (const bytes of [undefined, [], "bytes", new ArrayBuffer(8), new Uint8Array()]) {
      expect(() => parseSaveVideoFileRequestV1(request({ bytes }))).toThrow(/Video export input is invalid/);
    }
    const oversized = { byteLength: MAX_VIDEO_SAVE_BYTES + 1 };
    Object.setPrototypeOf(oversized, Uint8Array.prototype);
    expect(() => parseSaveVideoFileRequestV1(request({ bytes: oversized }))).toThrow(/Video export input is invalid/);
  });
});
