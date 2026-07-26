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
