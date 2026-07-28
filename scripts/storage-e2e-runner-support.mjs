import { Buffer } from "node:buffer";

export const STORAGE_E2E_OUTPUT_TRUNCATION_MARKER = "[storage-e2e output truncated; showing tail]\n";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(STORAGE_E2E_OUTPUT_TRUNCATION_MARKER);

export function assertStorageE2eNotInterrupted(signal) {
  if (signal) throw new Error(`Interrupted by ${signal}.`);
}

function utf8Tail(bytes, maximumBytes) {
  let start = Math.max(0, bytes.length - maximumBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return Buffer.from(bytes.subarray(start));
}

export class BoundedUtf8OutputTail {
  #maximumBytes;
  #tail = Buffer.alloc(0);
  #truncated = false;

  constructor(maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= TRUNCATION_MARKER_BYTES) {
      throw new RangeError("The output-tail byte limit must leave room for its truncation marker.");
    }
    this.#maximumBytes = maximumBytes;
  }

  get truncated() {
    return this.#truncated;
  }

  append(chunk) {
    const incoming = Buffer.from(chunk);
    if (incoming.length === 0) return;
    const combined = Buffer.concat([this.#tail, incoming]);
    if (!this.#truncated && combined.length <= this.#maximumBytes) {
      this.#tail = combined;
      return;
    }
    this.#truncated = true;
    this.#tail = utf8Tail(combined, this.#maximumBytes - TRUNCATION_MARKER_BYTES);
  }

  text() {
    const tail = this.#tail.toString("utf8");
    return this.#truncated ? `${STORAGE_E2E_OUTPUT_TRUNCATION_MARKER}${tail}` : tail;
  }
}
