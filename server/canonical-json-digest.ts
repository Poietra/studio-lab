import { createHash } from "node:crypto";

import { writeCanonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

/**
 * Chunks are flushed into the hash at this size. Large enough that a 900-frame
 * Runtime Trace costs thousands of `Hash.update` calls instead of millions,
 * small enough that peak retention stays a rounding error next to the trace.
 */
const CANONICAL_JSON_DIGEST_FLUSH_CHARS_V1 = 1 << 20;

/**
 * SHA-256 of the exact canonical JSON of `value`, streamed instead of built.
 * Byte-identical to `createHash("sha256").update(canonicalJsonV1(value))`, but
 * it never holds the whole canonical document — the peak cost is one flush
 * buffer rather than the document plus one transient copy per nesting level.
 */
export function digestCanonicalJsonV1(value: unknown) {
  const hash = createHash("sha256");
  let buffered = "";
  writeCanonicalJsonV1(value, {
    update(chunk) {
      buffered += chunk;
      if (buffered.length >= CANONICAL_JSON_DIGEST_FLUSH_CHARS_V1) {
        hash.update(buffered, "utf8");
        buffered = "";
      }
    },
  });
  if (buffered.length > 0) hash.update(buffered, "utf8");
  return hash.digest("hex");
}
