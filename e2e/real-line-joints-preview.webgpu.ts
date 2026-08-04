import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

const FIXTURE_PATH = "fixtures/engine-v1/real-line-joints-v10.json";
const EXPECTED_JOINS = ["miter", "round", "bevel"] as const;

type LineJointsFixtureV10 = Readonly<{
  assets: SceneIrBundleV1["assets"];
  id: string;
  samples: readonly Readonly<{
    packetId: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>[];
  scene: SceneIrBundleV1["scene"];
}>;

async function renderLineJoints(page: Page, fixture: LineJointsFixtureV10, entityIds: readonly string[]) {
  await page.goto("/");
  return page.evaluate(
    async ({ assets, entityIds, sample, scene }) => {
      const canvas = Object.assign(document.createElement("canvas"), {
        height: sample.viewport.heightPx,
        width: sample.viewport.widthPx,
      });
      const [{ PoietraCanvasWorkerClient }, { createCanvasWorkerClientEvidenceAdapterV1 }] = await Promise.all([
        import("/src/engine/canvas-worker-client.ts") as Promise<typeof import("../src/engine/canvas-worker-client")>,
        import("/src/engine/canvas-worker-evidence.ts") as Promise<
          typeof import("../src/engine/canvas-worker-evidence")
        >,
      ]);
      const revision = scene.source.kind === "imported-manim-server-snapshot" ? scene.source.snapshotHash : "";
      if (!revision) throw new Error("LineJoints V10 must retain its sealed snapshot revision.");
      const asFraction = ({ x, y }: Readonly<{ x: number; y: number }>) => ({
        fractionX: 0.5 + (x - scene.camera.view.center.x) / scene.camera.view.frameWidth,
        fractionY: 0.5 - (y - scene.camera.view.center.y) / scene.camera.view.frameHeight,
      });
      const leafSamples = scene.entities.slice(1).map((entity) => {
        if (entity.geometry.kind !== "cubic-path") throw new Error("Every LineJoints leaf must be a cubic path.");
        const subpath = entity.geometry.path.subpaths[0];
        const bottom = subpath?.segments[1];
        if (!subpath || !bottom) throw new Error("Every LineJoints leaf must retain its triangular outline.");
        return asFraction({
          x: (subpath.segments[0]!.end.x + bottom.end.x) / 2,
          y: (subpath.segments[0]!.end.y + bottom.end.y) / 2,
        });
      });
      const leafInteriors = scene.entities.slice(1).map((entity) => {
        if (entity.geometry.kind !== "cubic-path") throw new Error("Every LineJoints leaf must be a cubic path.");
        const subpath = entity.geometry.path.subpaths[0];
        if (!subpath) throw new Error("Every LineJoints leaf must retain one closed subpath.");
        const vertices = [subpath.start, ...subpath.segments.map(({ end }) => end)];
        return asFraction({
          x: vertices.reduce((sum, { x }) => sum + x, 0) / vertices.length,
          y: vertices.reduce((sum, { y }) => sum + y, 0) / vertices.length,
        });
      });
      const evidencePoints = [
        ...leafSamples,
        ...leafInteriors,
        { fractionX: 0.02, fractionY: 0.02 },
        { fractionX: 0.98, fractionY: 0.98 },
      ];
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({ canvas, revision, snapshot: { assets, scene } });
        const frame = await client.render({
          interactionEntityIds: entityIds,
          revision,
          sampleTime: sample.sampleTime,
          viewport: sample.viewport,
        });
        const evidence = await client.captureFrameEvidence({ revision, samples: evidencePoints });
        return { evidence, frame };
      } finally {
        client.dispose();
      }
    },
    { assets: fixture.assets, entityIds, sample: fixture.samples[0]!, scene: fixture.scene },
  );
}

function isOpaqueBlack(pixel: readonly number[]) {
  return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
}

function isVisibleStroke(pixel: readonly number[]) {
  return Math.max(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0) > 8 && pixel[3] === 255;
}

test("renders official LineJoints V10 through retained WASM browser WebGPU", async ({ page }) => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as LineJointsFixtureV10;
  const [sample] = fixture.samples;
  expect(sample).toBeDefined();
  expect(fixture.id).toBe("eng-v1-real-line-joints-v10");
  expect(fixture.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotVersion: 10,
  });
  expect(fixture.scene.entities).toHaveLength(4);

  const [group, ...leaves] = fixture.scene.entities;
  if (!group || leaves.length !== 3) throw new Error("LineJoints V10 must retain one group and three leaves.");
  expect(group).toMatchObject({ appearance: { kind: "group" }, geometry: { kind: "group" }, parentId: null });
  expect(
    leaves.map((entity) => ({
      join: entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null,
      parentId: entity.parentId,
    })),
  ).toEqual(EXPECTED_JOINS.map((join) => ({ join, parentId: group.id })));

  const entityIds = fixture.scene.entities.map(({ id }) => id);
  const { evidence, frame } = await renderLineJoints(page, fixture, entityIds);
  expect(frame).toMatchObject({
    interaction: { space: "clip-v1", status: "available" },
    kind: "frame-presented",
    revision: fixture.scene.source.kind === "imported-manim-server-snapshot" ? fixture.scene.source.snapshotHash : "",
    sampleTime: sample!.sampleTime,
    viewport: sample!.viewport,
  });
  expect(evidence).toMatchObject({
    packetId: frame.packetId,
    revision: frame.revision,
    sampleTime: sample!.sampleTime,
    viewport: sample!.viewport,
  });
  expect(evidence.surfaceFormat).toMatch(/^(bgra|rgba)8unorm$/);

  expect(frame.interaction.entries).toHaveLength(4);
  expect(frame.interaction.entries[0]).toEqual({ status: "empty" });
  const leafBounds = frame.interaction.entries.slice(1).map((entry) => {
    expect(entry.status).toBe("present");
    if (entry.status !== "present") throw new Error("Every LineJoints leaf must expose browser interaction bounds.");
    expect(entry.bounds).toHaveLength(4);
    return entry.bounds;
  });
  expect(leafBounds[0]![2]).toBeLessThan(leafBounds[1]![0]);
  expect(leafBounds[1]![2]).toBeLessThan(leafBounds[2]![0]);

  expect(evidence.samples.slice(0, 3).every(isVisibleStroke)).toBe(true);
  expect(evidence.samples.slice(3, 6).every(isOpaqueBlack)).toBe(true);
  expect(evidence.samples.slice(6).every(isOpaqueBlack)).toBe(true);
});
