import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { inspectProjectPngBytesV1, MAX_PROJECT_PNG_BYTES_V1 } from "./project-png-storage";

function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data = new Uint8Array()) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return result;
}

function png(width = 1, height = 1, extraChunks: readonly Buffer[] = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...extraChunks,
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND"),
  ]);
}

describe("inspectProjectPngBytesV1", () => {
  it("accepts a bounded static PNG and returns stable dimensions and digest", () => {
    const bytes = png(12, 7);
    const inspected = inspectProjectPngBytesV1(bytes);
    expect(inspected).toMatchObject({ byteSize: bytes.byteLength, height: 7, width: 12 });
    expect(inspected.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(inspected.bytes).not.toBe(bytes);
  });

  it("rejects signature, chunk boundary, CRC, IDAT, and trailing-byte corruption", () => {
    const signature = png();
    signature[0] = 0;
    expect(() => inspectProjectPngBytesV1(signature)).toThrow(/signature/i);

    const boundary = png();
    boundary.writeUInt32BE(0xffff_ffff, 8);
    expect(() => inspectProjectPngBytesV1(boundary)).toThrow(/boundary/i);

    const crc = png();
    crc[29] ^= 1;
    expect(() => inspectProjectPngBytesV1(crc)).toThrow(/CRC/i);

    const noIdat = Buffer.concat([png().subarray(0, 33), chunk("IEND")]);
    expect(() => inspectProjectPngBytesV1(noIdat)).toThrow(/IEND/i);

    expect(() => inspectProjectPngBytesV1(Buffer.concat([png(), Buffer.of(0)]))).toThrow(/IEND/i);
  });

  it("rejects APNG chunks, invalid dimensions, and oversized files", () => {
    expect(() => inspectProjectPngBytesV1(png(1, 1, [chunk("acTL", Buffer.alloc(8))]))).toThrow(/Animated PNG/i);
    expect(() => inspectProjectPngBytesV1(png(2_049, 1))).toThrow(/dimensions/i);
    expect(() => inspectProjectPngBytesV1(png(0, 1))).toThrow(/dimensions/i);
    expect(() => inspectProjectPngBytesV1(new Uint8Array(MAX_PROJECT_PNG_BYTES_V1 + 1))).toThrow(/512 KiB/i);
  });
});
