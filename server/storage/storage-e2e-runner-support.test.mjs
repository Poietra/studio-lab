import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  assertStorageE2eNotInterrupted,
  BoundedUtf8OutputTail,
  STORAGE_E2E_OUTPUT_TRUNCATION_MARKER,
} from "../../scripts/storage-e2e-runner-support.mjs";

describe("storage E2E runner support", () => {
  it("preserves a UTF-8 code point split across process output chunks", () => {
    const output = new BoundedUtf8OutputTail(256);
    const encoded = Buffer.from("before🙂after", "utf8");
    output.append(encoded.subarray(0, 8));
    output.append(encoded.subarray(8));

    expect(output.truncated).toBe(false);
    expect(output.text()).toBe("before🙂after");
  });

  it("truncates on a UTF-8 boundary and emits one marker within the byte cap", () => {
    const payloadLimit = 7;
    const maximumBytes = Buffer.byteLength(STORAGE_E2E_OUTPUT_TRUNCATION_MARKER) + payloadLimit;
    const output = new BoundedUtf8OutputTail(maximumBytes);
    output.append(Buffer.from(`${"discarded-".repeat(8)}X🙂tail`, "utf8"));

    expect(output.truncated).toBe(true);
    expect(output.text()).toBe(`${STORAGE_E2E_OUTPUT_TRUNCATION_MARKER}tail`);
    expect(Buffer.byteLength(output.text())).toBeLessThanOrEqual(maximumBytes);
    expect(output.text()).not.toContain("�");
  });

  it("blocks the pre-spawn path after a signal has been observed", () => {
    let spawned = false;
    const start = (signal) => {
      assertStorageE2eNotInterrupted(signal);
      spawned = true;
    };

    expect(() => start("SIGTERM")).toThrow("Interrupted by SIGTERM.");
    expect(spawned).toBe(false);
    expect(() => start(null)).not.toThrow();
    expect(spawned).toBe(true);
  });
});
