import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_VERIFIED_EXPORT_MP4_BYTES_V1, verifyExportMp4V1 } from "./export-mp4-verification";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures", "client-export", "tiny-client-export.mp4");

describe("verifyExportMp4V1", () => {
  it("verifies the committed muxer fixture and extracts its provenance through the shared WASM core", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
    const result = await verifyExportMp4V1(bytes);
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") return;
    expect(result.structure.widthPx).toBe(854);
    expect(result.structure.heightPx).toBe(480);
    expect(result.structure.timescale).toBe(1_000_000);
    expect(result.structure.sampleCount).toBeGreaterThan(0);
    expect(result.provenance).toEqual({
      engineAbiVersion: 27,
      exportProfileHash: "a".repeat(64),
      sceneId: "fixture-scene",
      sceneRevisionHash: "b".repeat(64),
    });
  });

  it("refuses bytes that are not a Poietra export container", async () => {
    const result = await verifyExportMp4V1(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.code).toBe("malformed-container");
  });

  it("refuses truncated and trailing bytes through the Rust verifier", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
    const truncated = await verifyExportMp4V1(bytes.slice(0, -10));
    expect(truncated.kind).toBe("refused");
    if (truncated.kind === "refused") expect(truncated.code).toBe("malformed-container");

    const trailingBytes = new Uint8Array(bytes.byteLength + 4);
    trailingBytes.set(bytes);
    trailingBytes.set(new TextEncoder().encode("tail"), bytes.byteLength);
    const trailing = await verifyExportMp4V1(trailingBytes);
    expect(trailing.kind).toBe("refused");
    if (trailing.kind === "refused") expect(trailing.code).toBe("malformed-container");
  });

  it("refuses a missing provenance box with a named code", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
    // Renaming the uuid fourcc removes the provenance box without disturbing
    // any other atom boundary.
    const uuidIndex = bytes.findIndex(
      (_, index) =>
        bytes[index] === 0x75 && bytes[index + 1] === 0x75 && bytes[index + 2] === 0x69 && bytes[index + 3] === 0x64,
    );
    expect(uuidIndex).toBeGreaterThan(0);
    const mutated = bytes.slice();
    mutated.set(new TextEncoder().encode("free"), uuidIndex);
    const result = await verifyExportMp4V1(mutated);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.code).toBe("provenance-missing");
  });

  it("refuses provenance that claims a different engine ABI", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
    const marker = new TextEncoder().encode('"engineAbiVersion":27');
    const markerIndex = bytes.findIndex((_, index) =>
      marker.every((byte, markerOffset) => bytes[index + markerOffset] === byte),
    );
    expect(markerIndex).toBeGreaterThan(0);
    const mutated = bytes.slice();
    mutated[markerIndex + marker.length - 1] = "6".charCodeAt(0);
    const result = await verifyExportMp4V1(mutated);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.code).toBe("provenance-invalid");
  });

  it("refuses an oversize input before crossing the boundary", async () => {
    const oversize = new Uint8Array(MAX_VERIFIED_EXPORT_MP4_BYTES_V1 + 1);
    const result = await verifyExportMp4V1(oversize);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.code).toBe("input-too-large");
  });
});
