import { canonicalJsonV1 } from "./canonical-json";
import type { SceneIrBundleV1 } from "./contracts";

export type { CanonicalJsonSinkV1 } from "./canonical-json";
export { canonicalJsonV1, writeCanonicalJsonV1 } from "./canonical-json";

const ZERO_SHA256 = "0".repeat(64);

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
