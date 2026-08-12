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
assert.equal(typeof engine.editSceneTimelineV1, "function");
assert.equal(typeof engine.rotateSceneEntityV1, "function");
assert.equal(typeof engine.setSubtreeVectorPaintAlphaV1, "function");
assert.equal(typeof engine.transformSceneEntityV1, "function");
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

for (const [name, delta, scale, expected] of [
  ["move", { x: 1.25, y: -0.5 }, undefined, [1, 1, 1.25, -0.5]],
  ["axis-scale", { x: 0, y: 0 }, { pivot: { x: 1, y: -0.5 }, xFactor: 1.5, yFactor: 0.75 }, [1.5, 0.75, -0.5, -0.125]],
  ["combined", { x: 1.25, y: -0.5 }, { pivot: { x: 1, y: -0.5 }, xFactor: 1.5, yFactor: 1.5 }, [1.5, 1.5, 0.75, -0.25]],
]) {
  const revision = name === "move" ? "c" : name === "axis-scale" ? "d" : "f";
  const transformedBundle = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      engine.transformSceneEntityV1(
        snapshot,
        encoder.encode(
          JSON.stringify({
            delta,
            entityId: "later",
            expectedBaseRevision: "a".repeat(64),
            nextRevision: revision.repeat(64),
            provenance: {
              evidence: [`engine WASM smoke atomic ${name}`],
              id: `wasm-smoke-atomic-${name}`,
              origin: "studio-edit-program",
            },
            schema: "poietra.transform-scene-entity",
            ...(scale ? { scale } : {}),
            version: 1,
          }),
        ),
      ),
    ),
  );
  const transformed = transformedBundle.scene.entities.find(({ id }) => id === "later");
  assert.ok(transformed, `atomic ${name} response lost its target`);
  assert.deepEqual(
    [transformed.transform.m11, transformed.transform.m22, transformed.transform.tx, transformed.transform.ty],
    expected,
  );
  assert.equal(transformed.provenanceId, `wasm-smoke-atomic-${name}`);
  assert.equal(transformedBundle.scene.source.revisionHash, revision.repeat(64));
}

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
