import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("../dist-server/engine-wasm/mathtex-outline/poietra_mathtex_wasm.js", import.meta.url);
const wasmUrl = new URL("poietra_mathtex_wasm_bg.wasm", moduleUrl);
const [outline, wasmBytes] = await Promise.all([import(moduleUrl.href), readFile(wasmUrl)]);

await outline.default({ module_or_path: wasmBytes });
assert.equal(outline.poietraMathTexOutlineAbiVersion(), 1);

const request = new TextEncoder().encode(
  JSON.stringify({
    schema: "poietra.mathtex-outline-request",
    texParts: [String.raw`\frac{a}{b}`],
    version: 1,
  }),
);
const response = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(outline.compileMathTexOutlineV1(request)));
assert.equal(response.result.kind, "compiled");
