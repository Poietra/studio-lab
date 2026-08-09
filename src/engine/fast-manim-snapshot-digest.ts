import type { SceneIrBundleV1 } from "./contracts";

const ZERO_SHA256 = "0".repeat(64);

export function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Snapshot canonicalization requires finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonV1(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Snapshot canonicalization received a non-JSON value.");
}

export type CanonicalJsonSinkV1 = Readonly<{ update: (chunk: string) => void }>;

/**
 * Writes the exact characters `canonicalJsonV1` would return, without ever
 * materializing the whole document. A 900-frame Runtime Trace canonicalizes to
 * tens of MiB, and building that string only to hash it costs a transient copy
 * per nesting level. This is the same traversal in the same order, so the two
 * must stay byte-identical; `canonical-json-digest.test.ts` pins that.
 */
export function writeCanonicalJsonV1(value: unknown, sink: CanonicalJsonSinkV1): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    sink.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Snapshot canonicalization requires finite numbers.");
    sink.update(JSON.stringify(Object.is(value, -0) ? 0 : value));
    return;
  }
  if (Array.isArray(value)) {
    sink.update("[");
    // Array#map snapshots length before visiting entries; do the same so an
    // accessor cannot change the byte sequence by resizing its outer array.
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      if (index > 0) sink.update(",");
      // `canonicalJsonV1` uses Array#map + join, which leaves sparse slots
      // empty. Preserve that behavior so existing digests remain identical
      // even for values outside the dense JSON graphs used by Runtime Trace.
      if (index in value) writeCanonicalJsonV1(value[index], sink);
    }
    sink.update("]");
    return;
  }
  if (typeof value === "object") {
    sink.update("{");
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [index, [key, entry]] of entries.entries()) {
      if (index > 0) sink.update(",");
      sink.update(`${JSON.stringify(key)}:`);
      writeCanonicalJsonV1(entry, sink);
    }
    sink.update("}");
    return;
  }
  throw new TypeError("Snapshot canonicalization received a non-JSON value.");
}

/** Canonical bytes covered by the Studio-owned fast-manim snapshot seal. */
export function canonicalFastManimSnapshotBundleJsonV1(bundle: SceneIrBundleV1) {
  if (bundle.scene.source.kind !== "imported-manim-server-snapshot") {
    throw new TypeError("A fast-manim snapshot must carry server snapshot source evidence.");
  }
  return canonicalJsonV1({
    ...bundle,
    scene: {
      ...bundle.scene,
      source: { ...bundle.scene.source, snapshotHash: ZERO_SHA256 },
    },
  });
}

export async function digestFastManimSnapshotBundleInBrowserV1(bundle: SceneIrBundleV1) {
  const bytes = new TextEncoder().encode(canonicalFastManimSnapshotBundleJsonV1(bundle));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
