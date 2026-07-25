import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import type { SceneIrBundleV1 } from "../src/engine/contracts";

type SharedFixture = Readonly<{
  assets: SceneIrBundleV1["assets"];
  expected: Readonly<{ drawEntityIds: readonly string[] }>;
  sample: Readonly<{ sampleTime: number; viewport: Readonly<{ heightPx: number; widthPx: number }> }>;
  scene: SceneIrBundleV1["scene"];
}>;

test("samples the shared golden Scene through the real browser Worker and WASM glue", async ({ page }) => {
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as SharedFixture;
  await page.goto("/");

  const sampled = await page.evaluate(async ({ assets, scene, sample }) => {
    const clientModuleUrl = "/src/engine/preview-worker-client.ts";
    const { PoietraPreviewWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/preview-worker-client");
    const client = new PoietraPreviewWorkerClient({ requestTimeoutMs: 10_000 });
    try {
      await client.installScene({
        revision: scene.source.revisionHash,
        snapshot: { assets, scene },
      });
      const packet = await client.sample({
        revision: scene.source.revisionHash,
        sampleTime: sample.sampleTime,
        viewport: sample.viewport,
      });
      return {
        drawEntityIds: packet.draws.map((draw) => draw.entityId),
        packetId: packet.packetId,
        sampleTime: packet.sampleTime,
      };
    } finally {
      client.dispose();
    }
  }, fixture);

  expect(sampled).toEqual({
    drawEntityIds: fixture.expected.drawEntityIds,
    packetId: "preview:2",
    sampleTime: fixture.sample.sampleTime,
  });
});
