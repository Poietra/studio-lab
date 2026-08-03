import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assetManifestV1Schema } from "./asset-manifest";
import { canonicalEngineBenchmarkJsonV1 } from "./benchmark";
import { compileEngineFrameV1 } from "./reference-evaluator";
import type { RenderPacketV1 } from "./render-packet";
import { sceneIrV1Schema } from "./scene-ir";

const SEMANTIC_NUMBER_SCALE = 1_000_000_000;

type ExpectedSample = Readonly<{
  camera: readonly [number, number, number, number];
  drawDigest: string;
  drawEntityIds: readonly string[];
  opacities: readonly number[];
  semanticDigest: string;
  worldTransforms: readonly Readonly<{
    entityId: string;
    values: readonly [number, number, number, number, number, number];
  }>[];
}>;

type DynamicFixture = Readonly<{
  assets: unknown;
  id: string;
  samples: readonly Readonly<{
    expected: ExpectedSample;
    id: string;
    packetId: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>[];
  scene: unknown;
  timelineProof: Readonly<{
    sampleCount: number;
    sampleRateHz: number;
    semanticDigest: string;
    shuffleStride: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>;
}>;

async function loadFixture(): Promise<DynamicFixture> {
  const url = new URL("../../fixtures/engine-v1/dynamic-affine-camera.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as DynamicFixture;
}

function transformValues(transform: RenderPacketV1["draws"][number]["transform"]) {
  return [transform.m11, transform.m12, transform.m21, transform.m22, transform.tx, transform.ty] as const;
}

function normalizeSemanticNumbers(value: unknown): unknown {
  // Rust and JavaScript cubic evaluation may differ by a few ULPs. Hash at a
  // precision that keeps those values equal while pinning meaningful changes.
  if (typeof value === "number") return Math.sign(value) * Math.round(Math.abs(value) * SEMANTIC_NUMBER_SCALE);
  if (Array.isArray(value)) return value.map(normalizeSemanticNumbers);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeSemanticNumbers(entry)]));
  }
  return value;
}

function digestSemanticValue(value: unknown) {
  const canonical = canonicalEngineBenchmarkJsonV1(normalizeSemanticNumbers(value));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function summarize(packet: RenderPacketV1) {
  const camera = [packet.camera.bottom, packet.camera.left, packet.camera.right, packet.camera.top] as const;
  return {
    camera,
    drawDigest: digestSemanticValue(packet.draws),
    drawEntityIds: packet.draws.map((draw) => draw.entityId),
    opacities: packet.draws.map((draw) => draw.opacity),
    semanticDigest: digestSemanticValue({ camera: packet.camera, draws: packet.draws }),
    worldTransforms: packet.draws.map((draw) => ({ entityId: draw.entityId, values: transformValues(draw.transform) })),
  } satisfies ExpectedSample;
}

function expectNumbersClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 12));
}

function timelineOrders(sampleCount: number, shuffleStride: number) {
  const ordered = Array.from({ length: sampleCount }, (_, index) => index);
  const shuffled = ordered.map((index) => (index * shuffleStride) % sampleCount);
  const continuousScrub = [...ordered].reverse();
  expect(new Set(shuffled).size).toBe(sampleCount);
  expect(
    continuousScrub.every((index, position) => position === 0 || continuousScrub[position - 1]! - index === 1),
  ).toBe(true);
  return { continuousScrub, ordered, shuffled };
}

async function timelineSemanticDigest(
  fixture: DynamicFixture,
  assets: ReturnType<typeof assetManifestV1Schema.parse>,
  scene: ReturnType<typeof sceneIrV1Schema.parse>,
  order: readonly number[],
) {
  const digests = new Array<string | undefined>(fixture.timelineProof.sampleCount);
  for (const sampleIndex of order) {
    const sampleTime = sampleIndex / fixture.timelineProof.sampleRateHz;
    const result = await compileEngineFrameV1({
      assets,
      evidence: [fixture.id, `timeline:${sampleIndex}`],
      packetId: `dynamic:timeline:${sampleIndex}`,
      sampleTime,
      scene,
      viewport: fixture.timelineProof.viewport,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(`timeline:${sampleIndex}: ${result.message}`);
    expect(digests[sampleIndex]).toBeUndefined();
    digests[sampleIndex] = summarize(result.frame.packet).semanticDigest;
  }
  expect(digests.every((digest) => digest !== undefined)).toBe(true);
  const hash = createHash("sha256");
  for (const digest of digests) hash.update(digest!, "ascii");
  return hash.digest("hex");
}

describe("shared dynamic affine/camera fixture", () => {
  it("pins pivot folding and executes unordered A-B-A seeks through the existing evaluator", async () => {
    const fixture = await loadFixture();
    const assets = assetManifestV1Schema.parse(fixture.assets);
    const scene = sceneIrV1Schema.parse(fixture.scene);
    expect(fixture.samples.map(({ sampleTime }) => sampleTime)).toEqual([0.75, 0, 0.5, 0.25, 0.75, 60, 0.75]);
    expect(scene.duration).toBe(60);
    expect(scene.animationChannels.map(({ kind }) => kind).sort()).toEqual([
      "affine-transform",
      "camera",
      "motion-path",
      "opacity",
      "path-morph",
      "path-trim",
    ]);

    const child = scene.entities.find(({ id }) => id === "asymmetric-child");
    const lifetimeChild = scene.entities.find(({ id }) => id === "trim-motion-child");
    expect(child?.parentId).toBe("dynamic-parent");
    expect(child?.transform).toEqual({ m11: 1, m12: 0.3, m21: -0.2, m22: 0.8, tx: 0.5, ty: -0.25 });
    expect(lifetimeChild?.lifetimes).toEqual([{ end: 60, start: 0.25 }]);

    const affine = scene.animationChannels.find((channel) => channel.kind === "affine-transform");
    expect(affine?.kind).toBe("affine-transform");
    if (affine?.kind !== "affine-transform") throw new Error("The dynamic fixture must contain its affine channel.");
    const folded = affine.keyframes[0]!.value;
    expect(folded.m11 * folded.m22 - folded.m12 * folded.m21).toBeLessThan(0);
    expect(Math.abs(folded.m12)).toBeGreaterThan(0);
    expect(Math.abs(folded.m21)).toBeGreaterThan(0);
    expect(Math.abs(folded.m11)).not.toBeCloseTo(Math.abs(folded.m22), 12);
    expectNumbersClose(
      [folded.m11 * 2 + folded.m12 * -1 + folded.tx, folded.m21 * 2 + folded.m22 * -1 + folded.ty],
      [5, 3],
    );

    const summaries = new Map<string, ExpectedSample>();
    for (const sample of fixture.samples) {
      const result = await compileEngineFrameV1({
        assets,
        evidence: [fixture.id, sample.id],
        packetId: sample.packetId,
        sampleTime: sample.sampleTime,
        scene,
        viewport: sample.viewport,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error(`${sample.id}: ${result.message}`);
      const summary = summarize(result.frame.packet);
      summaries.set(sample.id, summary);
      expect(summary.drawDigest).toBe(sample.expected.drawDigest);
      expect(summary.semanticDigest).toBe(sample.expected.semanticDigest);
      expect(summary.drawEntityIds).toEqual(sample.expected.drawEntityIds);
      expectNumbersClose(summary.camera, sample.expected.camera);
      expectNumbersClose(summary.opacities, sample.expected.opacities);
      expect(summary.worldTransforms.map(({ entityId }) => entityId)).toEqual(
        sample.expected.worldTransforms.map(({ entityId }) => entityId),
      );
      summary.worldTransforms.forEach(({ values }, index) => {
        const expected = sample.expected.worldTransforms[index];
        expect(expected).toBeDefined();
        if (expected !== undefined) expectNumbersClose(values, expected.values);
      });
    }

    expect(summaries.get("b-start")?.drawEntityIds).toEqual(["dynamic-parent", "asymmetric-child"]);
    expect(summaries.get("duration-end")?.drawEntityIds).toEqual([]);
    expect(summaries.get("a-repeat")).toEqual(summaries.get("a-first"));
    expect(summaries.get("a-after-end")).toEqual(summaries.get("a-first"));
  });

  it("keeps the 60-second semantic timeline history-free across playback, shuffled seek, and continuous scrub", async () => {
    const fixture = await loadFixture();
    const assets = assetManifestV1Schema.parse(fixture.assets);
    const scene = sceneIrV1Schema.parse(fixture.scene);
    const proof = fixture.timelineProof;
    expect(scene.duration * proof.sampleRateHz + 1).toBe(proof.sampleCount);
    const orders = timelineOrders(proof.sampleCount, proof.shuffleStride);

    for (const order of [orders.ordered, orders.shuffled, orders.continuousScrub]) {
      await expect(timelineSemanticDigest(fixture, assets, scene, order)).resolves.toBe(proof.semanticDigest);
    }
  });
});
