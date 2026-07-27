import { describe, expect, it } from "vitest";

import { type AssetManifestV1, assetManifestV1Schema, digestAssetManifestV1 } from "./asset-manifest";
import { canonicalEngineBenchmarkJsonV1, runEngineBenchmarkV1 } from "./benchmark";
import { type SceneIrV1, sceneIrV1Schema } from "./scene-ir";

const ZERO_HASH = "0".repeat(64);
const REVISION_HASH = "a".repeat(64);

async function fixture(): Promise<{ assets: AssetManifestV1; scene: SceneIrV1 }> {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_HASH,
    manifestId: "benchmark-empty",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  const assets = { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
  const scene = sceneIrV1Schema.parse({
    animationChannels: [],
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      view: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
    },
    coordinateSpace: {
      cpuPrecision: "f64",
      kind: "cartesian-2d",
      origin: "center",
      unit: "scene-unit",
      xAxis: "right",
      yAxis: "up",
    },
    duration: 1,
    entities: [],
    fidelity: { kind: "exact" },
    provenance: [{ evidence: ["benchmark fixture"], id: "fixture", origin: "fixture" }],
    requiredCapabilities: [],
    sceneId: "benchmark-empty",
    schema: "poietra.scene-ir",
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: REVISION_HASH },
    version: 1,
  });
  return { assets, scene };
}

const environment = {
  browserBuild: "Playwright Chromium fixture",
  commit: REVISION_HASH,
  cpu: "fixture CPU",
  driver: "fixture driver",
  gpu: "fixture GPU",
  osKernel: "fixture OS",
  powerMode: "fixture power mode",
  viewport: { heightPx: 1_080, widthPx: 1_920 },
};

function fixedStepClock(step: number) {
  let time = 0;
  return () => {
    const current = time;
    time += step;
    return current;
  };
}

describe("Poietra Engine benchmark harness v1", () => {
  it("records the fixed protocol and a reproducible semantic packet digest", async () => {
    const input = await fixture();
    const first = await runEngineBenchmarkV1({
      ...input,
      clock: fixedStepClock(0.25),
      environment,
      fixtureId: "eng-v1-001-empty-camera",
      frameBudgetMs: 16.7,
      sampleTimes: [0],
    });
    const second = await runEngineBenchmarkV1({
      ...input,
      clock: fixedStepClock(0.25),
      environment,
      fixtureId: "eng-v1-001-empty-camera",
      frameBudgetMs: 16.7,
      sampleTimes: [0],
    });

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("Expected benchmark reports.");
    expect(first.report).toMatchObject({
      budget: { frameMs: 16.7, met: true },
      evaluate: { maximum: 0.25, p50: 0.25, p95: 0.25 },
      measuredFrames: 300,
      warmupFrames: 30,
    });
    expect(first.report.evaluate.samplesMs).toHaveLength(300);
    expect(first.report.sampledPacketDigests).toHaveLength(300);
    expect(first.report.semanticDigest).toBe(second.report.semanticDigest);
  });

  it("canonicalizes object keys and negative zero before hashing", () => {
    expect(canonicalEngineBenchmarkJsonV1({ b: 1, a: -0, nested: { z: 2, c: 3 } })).toBe(
      '{"a":0,"b":1,"nested":{"c":3,"z":2}}',
    );
  });

  it("fails closed for protocol violations and frames that cannot compile", async () => {
    const input = await fixture();
    await expect(
      runEngineBenchmarkV1({
        ...input,
        environment,
        fixtureId: "eng-v1-001-empty-camera",
        frameBudgetMs: 16.7,
        measuredFrames: 299,
        sampleTimes: [0],
      }),
    ).resolves.toMatchObject({ code: "invalid-config", kind: "error" });
    await expect(
      runEngineBenchmarkV1({
        ...input,
        environment,
        fixtureId: "eng-v1-001-empty-camera",
        frameBudgetMs: 16.7,
        sampleTimes: [2],
      }),
    ).resolves.toMatchObject({ code: "frame-compilation-failed", frameIndex: 0, kind: "error", stage: "warmup" });
  });
});
