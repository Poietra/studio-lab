import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"));
const boundEntityFixture = JSON.parse(await readFile("fixtures/engine-v1/real-line-joints-v10.json", "utf8"));
const glueBytes = await readFile("public/engine-wasm/poietra_wasm.js");
const wasmBytes = await readFile("public/engine-wasm/poietra_wasm_bg.wasm");
const engine = await import("../public/engine-wasm/poietra_wasm.js");

await engine.default({ module_or_path: wasmBytes });
assert.equal(engine.poietraEngineAbiVersion(), 24);
assert.equal(engine.poietraCanvasAbiVersion(), 5);
assert.equal(engine.poietraCanvasTelemetryAbiVersion(), 4);
assert.equal(typeof engine.validateSceneIrBundleV1, "function");
assert.equal(typeof engine.applyStaticRootTransformEditV1, "function");
assert.equal(typeof engine.applyStudioBoundEntityEditV1, "function");
assert.equal(typeof engine.applyStudioCreationEditV1, "function");
assert.equal(typeof engine.projectStudioCreationEditV1, "function");
assert.equal(typeof engine.applyStudioTimelineEditV1, "function");
assert.equal(typeof engine.applyStudioMotionEditV1, "function");
assert.equal(typeof engine.projectStudioMathTexTransformV1, "function");
assert.equal(typeof engine.projectStudioMotionEditV1, "function");
assert.equal(typeof engine.projectStudioTimelineV1, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.create, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.adapterEvidence, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.replaceSnapshot, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.render, "function");
assert.equal(typeof engine.PoietraCanvasEngineV1.prototype.renderWithTelemetry, "function");

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const snapshot = encoder.encode(JSON.stringify({ assets: fixture.assets, scene: fixture.scene }));
assert.ok(snapshot.byteLength <= 5 * 1024 * 1024, "shared snapshot exceeds the adoption budget");
engine.validateSceneIrBundleV1(snapshot);
assert.throws(
  () =>
    engine.validateSceneIrBundleV1(
      encoder.encode(JSON.stringify({ assets: fixture.assets, scene: { ...fixture.scene, duration: -1 } })),
    ),
  /contract validation failed/,
);

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
  response = JSON.parse(decoder.decode(session.sample(request)));
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

const boundScene = boundEntityFixture.scene;
const boundRoot = boundScene.entities.find(({ parentId }) => parentId === null);
assert.ok(boundRoot, "bound endpoint smoke fixture has no root entity");
const boundSnapshot = encoder.encode(JSON.stringify({ assets: boundEntityFixture.assets, scene: boundScene }));
const boundResult = JSON.parse(
  decoder.decode(
    engine.applyStudioBoundEntityEditV1(
      boundSnapshot,
      encoder.encode(
        JSON.stringify({
          candidates: [
            {
              baseCenter: { x: 320, y: 180 },
              baseOpacity: null,
              capabilities: { paintOpacity: true, rotation: true, uniformScale: true },
              evidenceId: "line-joints:root",
              phase: "construction",
              sceneEntityId: boundRoot.id,
              sourceAnchor: 0,
              studioEntityId: "source:root",
            },
          ],
          expectedBaseRevision: boundScene.source.snapshotHash,
          frame: { height: boundScene.camera.view.frameHeight, width: boundScene.camera.view.frameWidth },
          nextRevision: "e".repeat(64),
          programs: [
            {
              anchorCapturedPlayhead: 0,
              anchorResolvedSeconds: 0,
              anchorSource: { kind: "absolute", seconds: 0 },
              intentCount: 1,
              loweringSupported: true,
              operations: [
                {
                  dependsOn: [],
                  entityId: "source:root",
                  id: "move-root",
                  interval: { end: 0, start: 0 },
                  kind: "move",
                  origin: "direct-manipulation",
                  position: { x: 360, y: 180 },
                },
              ],
              origin: "direct-manipulation",
              requestedExecution: "parallel",
              scheduleEdgeCount: 0,
              scheduleMode: "parallel",
              scheduleOrder: ["move-root"],
              transactionId: "move-root",
            },
          ],
          schema: "poietra.apply-studio-bound-entity-edit",
          version: 1,
          viewport: { height: 360, width: 640 },
        }),
      ),
    ),
  ),
);
const movedRoot = boundResult.scene.entities.find(({ id }) => id === boundRoot.id);
assert.ok(movedRoot, "bound endpoint response lost its root entity");
assert.ok(Math.abs(movedRoot.transform.tx - boundScene.camera.view.frameWidth / 16) < 1e-12);
assert.equal(boundResult.scene.source.revisionHash, "e".repeat(64));

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
