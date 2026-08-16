import { z } from "zod";

import { assetManifestV1Schema } from "./asset-manifest";
import { loadPoietraWasmModule } from "./poietra-wasm-module";
import { sceneIrV1Schema } from "./scene-ir";

export * from "./asset-manifest";
export * from "./export-profile";
export * from "./primitives";
export * from "./render-packet";
export * from "./scene-ir";

/** Type and fixture decoder only; trust boundaries must use parseVerifiedSceneIrBundleV1. */
export const sceneIrBundleV1Schema = z
  .object({
    assets: assetManifestV1Schema,
    scene: sceneIrV1Schema,
  })
  .strict();

export type SceneIrBundleV1 = z.infer<typeof sceneIrBundleV1Schema>;

/** Admits a Scene bundle through the canonical Rust core. */
export async function parseVerifiedSceneIrBundleV1(value: unknown): Promise<SceneIrBundleV1> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("The Scene IR bundle is not JSON serializable.");
  const module = await loadPoietraWasmModule();
  if (typeof module.validateSceneIrBundleV1 !== "function") {
    throw new Error("The Poietra WASM module does not export Scene IR validation.");
  }
  module.validateSceneIrBundleV1(new TextEncoder().encode(json));
  return JSON.parse(json) as SceneIrBundleV1;
}
