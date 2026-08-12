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
assert.equal(engine.poietraCanvasTelemetryAbiVersion(), 4);
assert.equal(typeof engine.moveSceneEntityV1, "function");
assert.equal(typeof engine.rotateSceneEntityV1, "function");
assert.equal(typeof engine.setSubtreeVectorPaintAlphaV1, "function");
assert.equal(typeof engine.transformSceneEntityV1, "function");
assert.equal(typeof engine.uniformScaleSceneEntityV1, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.create, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.applySceneDelta, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.adapterEvidence, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.replaceSnapshot, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.render, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.renderWithTelemetry, "function");

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

const rotatedBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    engine.rotateSceneEntityV1(
      snapshot,
      encoder.encode(
        JSON.stringify({
          angleRadians: Math.PI / 2,
          entityId: "later",
          expectedBaseRevision: "a".repeat(64),
          nextRevision: "b".repeat(64),
          pivot: { x: 0, y: 0 },
          provenance: {
            evidence: ["engine WASM smoke rotation"],
            id: "wasm-smoke-rotation",
            origin: "studio-edit-program",
          },
          schema: "poietra.rotate-scene-entity",
          version: 1,
        }),
      ),
    ),
  ),
);
const rotatedEntity = rotatedBundle.scene.entities.find(({ id }) => id === "later");
assert.ok(rotatedEntity, "rotation response lost its target");
assert.ok(Math.abs(rotatedEntity.transform.m11) < 1e-12);
assert.ok(Math.abs(rotatedEntity.transform.m12 + 1) < 1e-12);
assert.ok(Math.abs(rotatedEntity.transform.m21 - 1) < 1e-12);
assert.ok(Math.abs(rotatedEntity.transform.m22) < 1e-12);
assert.equal(rotatedEntity.provenanceId, "wasm-smoke-rotation");
assert.equal(rotatedBundle.scene.source.revisionHash, "b".repeat(64));

const movedBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    engine.moveSceneEntityV1(
      snapshot,
      encoder.encode(
        JSON.stringify({
          delta: { x: 1.25, y: -0.5 },
          entityId: "later",
          expectedBaseRevision: "a".repeat(64),
          nextRevision: "c".repeat(64),
          provenance: {
            evidence: ["engine WASM smoke move"],
            id: "wasm-smoke-move",
            origin: "studio-edit-program",
          },
          schema: "poietra.move-scene-entity",
          version: 1,
        }),
      ),
    ),
  ),
);
const movedEntity = movedBundle.scene.entities.find(({ id }) => id === "later");
assert.ok(movedEntity, "move response lost its target");
assert.equal(movedEntity.transform.tx, 1.25);
assert.equal(movedEntity.transform.ty, -0.5);
assert.equal(movedEntity.provenanceId, "wasm-smoke-move");
assert.equal(movedBundle.scene.source.revisionHash, "c".repeat(64));

const scaledBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    engine.uniformScaleSceneEntityV1(
      snapshot,
      encoder.encode(
        JSON.stringify({
          entityId: "later",
          expectedBaseRevision: "a".repeat(64),
          factor: 1.5,
          nextRevision: "d".repeat(64),
          pivot: { x: 1, y: -0.5 },
          provenance: {
            evidence: ["engine WASM smoke uniform scale"],
            id: "wasm-smoke-uniform-scale",
            origin: "studio-edit-program",
          },
          schema: "poietra.uniform-scale-scene-entity",
          version: 1,
        }),
      ),
    ),
  ),
);
const scaledEntity = scaledBundle.scene.entities.find(({ id }) => id === "later");
assert.ok(scaledEntity, "uniform-scale response lost its target");
assert.equal(scaledEntity.transform.m11, 1.5);
assert.equal(scaledEntity.transform.m22, 1.5);
assert.equal(scaledEntity.transform.tx, -0.5);
assert.equal(scaledEntity.transform.ty, 0.25);
assert.equal(scaledEntity.provenanceId, "wasm-smoke-uniform-scale");
assert.equal(scaledBundle.scene.source.revisionHash, "d".repeat(64));

const transformedBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    engine.transformSceneEntityV1(
      snapshot,
      encoder.encode(
        JSON.stringify({
          delta: { x: 1.25, y: -0.5 },
          entityId: "later",
          expectedBaseRevision: "a".repeat(64),
          nextRevision: "f".repeat(64),
          provenance: {
            evidence: ["engine WASM smoke atomic transform"],
            id: "wasm-smoke-atomic-transform",
            origin: "studio-edit-program",
          },
          schema: "poietra.transform-scene-entity",
          uniformScale: { factor: 1.5, pivot: { x: 1, y: -0.5 } },
          version: 1,
        }),
      ),
    ),
  ),
);
const transformedEntity = transformedBundle.scene.entities.find(({ id }) => id === "later");
assert.ok(transformedEntity, "atomic-transform response lost its target");
assert.equal(transformedEntity.transform.m11, 1.5);
assert.equal(transformedEntity.transform.m22, 1.5);
assert.equal(transformedEntity.transform.tx, 0.75);
assert.equal(transformedEntity.transform.ty, -0.25);
assert.equal(transformedEntity.provenanceId, "wasm-smoke-atomic-transform");
assert.equal(transformedBundle.scene.source.revisionHash, "f".repeat(64));

const paintAlphaBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    engine.setSubtreeVectorPaintAlphaV1(
      snapshot,
      encoder.encode(
        JSON.stringify({
          alpha: 0.25,
          expectedBaseRevision: "a".repeat(64),
          nextRevision: "e".repeat(64),
          provenance: {
            evidence: ["engine WASM smoke subtree vector paint alpha"],
            id: "wasm-smoke-subtree-vector-paint-alpha",
            origin: "studio-edit-program",
          },
          rootEntityId: "stroke",
          schema: "poietra.set-subtree-vector-paint-alpha",
          version: 1,
        }),
      ),
    ),
  ),
);
const paintAlphaEntity = paintAlphaBundle.scene.entities.find(({ id }) => id === "stroke");
assert.ok(paintAlphaEntity, "subtree paint-alpha response lost its target");
assert.equal(paintAlphaEntity.appearance.fill, null);
assert.equal(paintAlphaEntity.appearance.stroke.color.alpha, 0.25);
assert.equal(paintAlphaEntity.provenanceId, "wasm-smoke-subtree-vector-paint-alpha");
assert.equal(paintAlphaBundle.scene.source.revisionHash, "e".repeat(64));

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
