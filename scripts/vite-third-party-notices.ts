import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Plugin } from "vite";

export const THIRD_PARTY_NOTICE_OUTPUT = "THIRD_PARTY_NOTICES.txt";
export const THIRD_PARTY_NOTICE_SOURCE = "engine/crates/poietra-mathtex-outline/PACKAGE-LICENSES.txt";

/** Emits the canonical package-license bytes into each externally shipped Vite bundle. */
export function thirdPartyNotices(root = process.cwd()): Plugin {
  return {
    apply: "build",
    async buildStart() {
      this.emitFile({
        fileName: THIRD_PARTY_NOTICE_OUTPUT,
        source: await readFile(resolve(root, THIRD_PARTY_NOTICE_SOURCE)),
        type: "asset",
      });
    },
    name: "poietra-third-party-notices",
  };
}
