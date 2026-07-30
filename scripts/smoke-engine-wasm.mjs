import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"));
const glueBytes = await readFile("public/engine-wasm/poietra_wasm.js");
const wasmBytes = await readFile("public/engine-wasm/poietra_wasm_bg.wasm");
const engine = await import("../public/engine-wasm/poietra_wasm.js");

await engine.default({ module_or_path: wasmBytes });
assert.equal(engine.poietraEngineAbiVersion(), 1);
assert.equal(engine.poietraCanvasAbiVersion(), 4);
assert.equal(typeof engine.PoietraCanvasEngineV1, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.create, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.applySceneDelta, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.replaceSnapshot, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.render, "function");

const encoder = new TextEncoder();
const snapshot = encoder.encode(JSON.stringify({ assets: fixture.assets, scene: fixture.scene }));
assert.ok(snapshot.byteLength <= 5 * 1024 * 1024, "shared snapshot exceeds the adoption budget");

const session = new engine.PoietraEngineSessionV1(snapshot);
let response;
try {
  const request = encoder.encode(
    JSON.stringify({
      ...fixture.sample,
      schema: "poietra.engine-sample-request",
      version: 1,
    }),
  );
  response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(session.sample(request)));
} finally {
  session.free();
}

assert.equal(response.schema, "poietra.engine-worker-response");
assert.equal(response.version, 1);
assert.equal(response.result.kind, "ready");
assert.deepEqual(
  response.result.packet.draws.map((draw) => draw.entityId),
  fixture.expected.drawEntityIds,
);

const gzipBytes = gzipSync(Buffer.concat([glueBytes, wasmBytes])).byteLength;
assert.ok(gzipBytes <= 3 * 1024 * 1024, "compressed engine payload exceeds the adoption budget");
console.log(
  JSON.stringify({
    drawEntityIds: fixture.expected.drawEntityIds,
    fixtureId: fixture.id,
    gzipBytes,
    snapshotBytes: snapshot.byteLength,
    wasmBytes: wasmBytes.byteLength,
  }),
);
