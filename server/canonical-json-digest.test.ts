import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1, writeCanonicalJsonV1 } from "../src/engine/canonical-json";
import { digestCanonicalJsonV1 } from "./canonical-json-digest";

function written(value: unknown) {
  let text = "";
  writeCanonicalJsonV1(value, {
    update(chunk) {
      text += chunk;
    },
  });
  return text;
}

function reference(value: unknown) {
  return createHash("sha256").update(canonicalJsonV1(value), "utf8").digest("hex");
}

const CORPUS: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  1e21,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  "",
  "plain",
  '"quoted"',
  "back\\slash",
  "line\nbreak\ttab",
  "\u0001\u001f",
  "日本語",
  "\u{1f600}",
  [],
  {},
  [1, [2, [3, [4]]]],
  { b: 1, a: 2, c: { z: 1, y: [1, 2, 3] } },
  { "": "empty key", "\u0000": "nul key", "\\": "escaped key" },
  { a: [{ b: -0 }, { b: 0 }] },
  [{ nested: { deeply: { with: [null, true, "x", 2.5] } } }],
];

describe("streaming canonical JSON digest", () => {
  it("writes exactly the characters canonicalJsonV1 returns", () => {
    for (const value of CORPUS) {
      expect(written(value)).toBe(canonicalJsonV1(value));
    }
  });

  it("digests byte-identically to hashing the materialized canonical document", () => {
    for (const value of CORPUS) {
      expect(digestCanonicalJsonV1(value)).toBe(reference(value));
    }
  });

  it("stays byte-identical across the flush boundary", () => {
    // The sink flushes at 1 MiB, so this corpus crosses it repeatedly and
    // proves chunk boundaries never change the hashed bytes.
    for (const width of [1, 2, 3]) {
      const wide = {
        frames: Array.from({ length: 900 }, (_, frame) => ({
          draws: Array.from({ length: width }, (_, draw) => ({
            id: `draw-${frame}-${draw}`,
            transform: { a: 1.000000000000001, b: -0, c: 0, d: frame / 3 },
          })),
          index: frame,
        })),
      };
      expect(written(wide)).toBe(canonicalJsonV1(wide));
      expect(digestCanonicalJsonV1(wide)).toBe(reference(wide));
    }
  });

  it("preserves the sort order, -0 normalization, and rejection of non-JSON values", () => {
    expect(written({ b: 1, B: 2, a: 3, A: 4, "1": 5 })).toBe('{"1":5,"A":4,"B":2,"a":3,"b":1}');
    expect(written([-0, 0])).toBe("[0,0]");
    expect(() => written(Number.NaN)).toThrow(/finite numbers/);
    expect(() => written(Number.POSITIVE_INFINITY)).toThrow(/finite numbers/);
    expect(() => written(undefined)).toThrow(/non-JSON value/);
    expect(() => written(() => 1)).toThrow(/non-JSON value/);
    expect(() => written(1n)).toThrow(/non-JSON value/);
    expect(() => digestCanonicalJsonV1({ a: undefined })).toThrow(/non-JSON value/);
  });

  it("matches the existing canonicalizer for sparse arrays", () => {
    const sparse = [1, 2, 3];
    delete sparse[1];
    for (const value of [Array(1), Array(2), sparse]) {
      expect(written(value)).toBe(canonicalJsonV1(value));
      expect(digestCanonicalJsonV1(value)).toBe(reference(value));
    }
  });

  it("never hands the sink more than one scalar token at a time", () => {
    // The structural property the memory win rests on: the writer emits one
    // token per call and never concatenates a subtree, so no caller ever has to
    // hold a whole frame, let alone the whole trace.
    const trace = {
      frames: Array.from({ length: 900 }, (_, frame) => ({
        draws: Array.from({ length: 10 }, (_, draw) => ({
          appearanceId: `appearance-${draw}`,
          pathId: `path-${draw}`,
          transform: { a: 1 + draw / 1000, b: 0, c: 0, d: 1 + frame / 1000, tx: frame / 7, ty: draw / 11 },
        })),
        index: frame,
      })),
    };
    const canonical = canonicalJsonV1(trace);
    let widestChunk = 0;
    let chunks = 0;
    writeCanonicalJsonV1(trace, {
      update(chunk) {
        widestChunk = Math.max(widestChunk, chunk.length);
        chunks += 1;
      },
    });

    expect(canonical.length).toBeGreaterThan(1_000_000);
    expect(chunks).toBeGreaterThan(100_000);
    // `"appearanceId":` is the longest token this document produces.
    expect(widestChunk).toBeLessThanOrEqual(32);
    expect(widestChunk * chunks).toBeGreaterThan(canonical.length);
    expect(digestCanonicalJsonV1(trace)).toBe(reference(trace));
  });
});
