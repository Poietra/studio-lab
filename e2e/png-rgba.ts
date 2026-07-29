import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

export function encodeRgbaPngV1(rgba: Uint8Array, widthPx: number, heightPx: number): Uint8Array {
  const rowBytes = widthPx * 4;
  const expectedBytes = rowBytes * heightPx;
  if (!Number.isSafeInteger(expectedBytes) || widthPx <= 0 || heightPx <= 0 || rgba.byteLength !== expectedBytes) {
    throw new Error(
      `RGBA PNG input has ${rgba.byteLength} bytes; expected ${expectedBytes} for ${widthPx}x${heightPx}.`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(widthPx, 0);
  ihdr.writeUInt32BE(heightPx, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * heightPx);
  for (let y = 0; y < heightPx; y += 1) {
    const scanlineOffset = y * (rowBytes + 1);
    scanlines[scanlineOffset] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * rowBytes, rowBytes).copy(scanlines, scanlineOffset + 1);
  }
  const compressed = deflateSync(scanlines, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
}
