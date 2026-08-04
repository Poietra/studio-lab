import { deflateSync, inflateSync } from "node:zlib";

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

function paethPredictor(left: number, up: number, upperLeft: number) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

/**
 * Decodes the bounded PNG subset emitted by the pinned Cairo/Pillow reference
 * lane: non-interlaced, 8-bit RGBA. The expected dimensions bound inflation
 * before these bytes are admitted to a full-frame comparison.
 */
export function decodeRgbaPngV1(png: Uint8Array, widthPx: number, heightPx: number): Uint8Array {
  const rowBytes = widthPx * 4;
  const expectedBytes = rowBytes * heightPx;
  if (!Number.isSafeInteger(expectedBytes) || widthPx <= 0 || heightPx <= 0) {
    throw new Error(`Invalid expected RGBA PNG dimensions ${widthPx}x${heightPx}.`);
  }
  if (png.byteLength < PNG_SIGNATURE.byteLength || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new Error("RGBA PNG input has an invalid signature.");
  }

  let offset = PNG_SIGNATURE.byteLength;
  let sawHeader = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset < png.byteLength) {
    if (offset + 12 > png.byteLength) throw new Error("RGBA PNG input contains a truncated chunk.");
    const view = Buffer.from(png.buffer, png.byteOffset + offset, png.byteLength - offset);
    const length = view.readUInt32BE(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.byteLength) throw new Error("RGBA PNG input contains a truncated chunk payload.");
    const type = Buffer.from(png.buffer, png.byteOffset + offset + 4, 4).toString("ascii");
    const data = Buffer.from(png.buffer, png.byteOffset + offset + 8, length);
    const expectedCrc = Buffer.from(png.buffer, png.byteOffset + offset + 8 + length, 4).readUInt32BE(0);
    const actualCrc = crc32(Buffer.from(png.buffer, png.byteOffset + offset + 4, length + 4));
    if (actualCrc !== expectedCrc) throw new Error(`RGBA PNG ${type} chunk has an invalid CRC.`);

    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("RGBA PNG input must contain one canonical IHDR chunk.");
      sawHeader = true;
      if (data.readUInt32BE(0) !== widthPx || data.readUInt32BE(4) !== heightPx) {
        throw new Error(`RGBA PNG dimensions do not equal ${widthPx}x${heightPx}.`);
      }
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("RGBA PNG input must be non-interlaced 8-bit RGBA.");
      }
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) throw new Error("RGBA PNG IDAT chunks must follow IHDR and precede IEND.");
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || sawEnd) throw new Error("RGBA PNG input has an invalid IEND chunk.");
      sawEnd = true;
      if (chunkEnd !== png.byteLength) throw new Error("RGBA PNG input contains bytes after IEND.");
    }
    offset = chunkEnd;
  }
  if (!sawHeader || compressed.length === 0 || !sawEnd) {
    throw new Error("RGBA PNG input is missing IHDR, IDAT, or IEND.");
  }

  const scanlines = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes + heightPx });
  if (scanlines.byteLength !== expectedBytes + heightPx) {
    throw new Error("RGBA PNG scanline bytes do not match the expected dimensions.");
  }
  const rgba = new Uint8Array(expectedBytes);
  for (let row = 0; row < heightPx; row += 1) {
    const scanlineOffset = row * (rowBytes + 1);
    const rowOffset = row * rowBytes;
    const filter = scanlines[scanlineOffset];
    if (filter === undefined || filter > 4) throw new Error(`RGBA PNG row ${row} has an unsupported filter.`);
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = scanlines[scanlineOffset + 1 + column]!;
      const left = column >= 4 ? rgba[rowOffset + column - 4]! : 0;
      const up = row > 0 ? rgba[rowOffset - rowBytes + column]! : 0;
      const upperLeft = row > 0 && column >= 4 ? rgba[rowOffset - rowBytes + column - 4]! : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paethPredictor(left, up, upperLeft);
      rgba[rowOffset + column] = (encoded + predictor) & 0xff;
    }
  }
  return rgba;
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
