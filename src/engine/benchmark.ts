import { z } from "zod";

import type { AssetManifestV1 } from "./asset-manifest";
import {
  ENGINE_GOLDEN_FIXTURE_CATALOG,
  engineGoldenFixtureIdSchema,
  engineGoldenWorkloadCategorySchema,
  type EngineGoldenFixture,
} from "./golden-fixture-catalog";
import { POIETRA_ENGINE_CONTRACT_VERSION, sha256V1Schema } from "./primitives";
import { compileEngineFrameV1 } from "./reference-evaluator";
import type { SceneIrV1 } from "./scene-ir";

const boundedMetadata = z.string().trim().min(1).max(500);
const viewportSchema = z
  .object({ heightPx: z.number().int().positive(), widthPx: z.number().int().positive() })
  .strict();

export const engineBenchmarkEnvironmentV1Schema = z
  .object({
    browserBuild: boundedMetadata,
    commit: boundedMetadata,
    cpu: boundedMetadata,
    driver: boundedMetadata,
    gpu: boundedMetadata,
    osKernel: boundedMetadata,
    powerMode: boundedMetadata,
    viewport: viewportSchema,
  })
  .strict();

const timingSummarySchema = z
  .object({
    maximum: z.number().finite().nonnegative(),
    p50: z.number().finite().nonnegative(),
    p95: z.number().finite().nonnegative(),
    samplesMs: z.array(z.number().finite().nonnegative()).min(300).max(10_000),
  })
  .strict();

export const engineBenchmarkReportV1Schema = z
  .object({
    budget: z.object({ frameMs: z.number().finite().positive(), met: z.boolean() }).strict(),
    contractVersion: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
    environment: engineBenchmarkEnvironmentV1Schema,
    evaluate: timingSummarySchema,
    fixtureId: engineGoldenFixtureIdSchema,
    measuredFrames: z.number().int().min(300).max(10_000),
    renderer: z.literal("typescript-reference"),
    sampledPacketDigests: z.array(sha256V1Schema).min(300).max(10_000),
    semanticDigest: sha256V1Schema,
    schema: z.literal("poietra.engine-benchmark-report"),
    version: z.literal(1),
    warmupFrames: z.number().int().min(30).max(10_000),
    workloadCategories: z.array(engineGoldenWorkloadCategorySchema).min(1),
  })
  .strict();

export type EngineBenchmarkEnvironmentV1 = z.infer<typeof engineBenchmarkEnvironmentV1Schema>;
export type EngineBenchmarkReportV1 = z.infer<typeof engineBenchmarkReportV1Schema>;

export type RunEngineBenchmarkV1Options = Readonly<{
  assets: AssetManifestV1;
  clock?: () => number;
  environment: EngineBenchmarkEnvironmentV1;
  fixtureId: EngineGoldenFixture["id"];
  frameBudgetMs: number;
  measuredFrames?: number;
  sampleTimes: readonly number[];
  scene: SceneIrV1;
  warmupFrames?: number;
}>;

export type RunEngineBenchmarkV1Result =
  | Readonly<{
      code: "frame-compilation-failed" | "invalid-config" | "invalid-report";
      frameIndex?: number;
      kind: "error";
      message: string;
      stage?: "measurement" | "warmup";
    }>
  | Readonly<{ kind: "ready"; report: EngineBenchmarkReportV1 }>;

const benchmarkConfigSchema = z
  .object({
    environment: engineBenchmarkEnvironmentV1Schema,
    fixtureId: engineGoldenFixtureIdSchema,
    frameBudgetMs: z.number().finite().positive(),
    measuredFrames: z.number().int().min(300).max(10_000),
    sampleTimes: z.array(z.number().finite().nonnegative()).min(1).max(1_001),
    warmupFrames: z.number().int().min(30).max(10_000),
  })
  .strict();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJsonValue(value: unknown): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

export function canonicalEngineBenchmarkJsonV1(value: unknown) {
  return JSON.stringify(canonicalJsonValue(value));
}

async function digestText(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function percentile(sorted: readonly number[], fraction: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function fixture(fixtureId: EngineGoldenFixture["id"]) {
  return ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures.find(({ id }) => id === fixtureId)!;
}

export async function runEngineBenchmarkV1(options: RunEngineBenchmarkV1Options): Promise<RunEngineBenchmarkV1Result> {
  const configResult = benchmarkConfigSchema.safeParse({
    environment: options.environment,
    fixtureId: options.fixtureId,
    frameBudgetMs: options.frameBudgetMs,
    measuredFrames: options.measuredFrames ?? 300,
    sampleTimes: [...options.sampleTimes],
    warmupFrames: options.warmupFrames ?? 30,
  });
  if (!configResult.success) {
    return { code: "invalid-config", kind: "error", message: configResult.error.message };
  }
  const config = configResult.data;
  let benchmarkInput: Readonly<{ assets: AssetManifestV1; scene: SceneIrV1 }>;
  try {
    benchmarkInput = structuredClone({ assets: options.assets, scene: options.scene });
  } catch (error) {
    return { code: "invalid-config", kind: "error", message: errorMessage(error) };
  }
  const clock = options.clock ?? (() => performance.now());
  const measured: number[] = [];
  const packetDigests: string[] = [];

  for (const stage of ["warmup", "measurement"] as const) {
    const count = stage === "warmup" ? config.warmupFrames : config.measuredFrames;
    for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
      const sampleTime = config.sampleTimes[frameIndex % config.sampleTimes.length];
      const started = clock();
      const compiled = await compileEngineFrameV1({
        assets: benchmarkInput.assets,
        evidence: [`golden fixture ${config.fixtureId}`, `benchmark ${stage}`],
        packetId: `${config.fixtureId}:${stage}:${frameIndex}`,
        sampleTime,
        scene: benchmarkInput.scene,
        viewport: config.environment.viewport,
      });
      const elapsed = clock() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        return { code: "invalid-config", kind: "error", message: "Benchmark clock must be finite and monotonic." };
      }
      if (compiled.kind === "error") {
        return {
          code: "frame-compilation-failed",
          frameIndex,
          kind: "error",
          message: compiled.message,
          stage,
        };
      }
      if (stage === "measurement") {
        measured.push(elapsed);
        packetDigests.push(await digestText(canonicalEngineBenchmarkJsonV1(compiled.frame.packet)));
      }
    }
  }

  const sorted = [...measured].sort((left, right) => left - right);
  const p95 = percentile(sorted, 0.95);
  const reportResult = engineBenchmarkReportV1Schema.safeParse({
    budget: { frameMs: config.frameBudgetMs, met: p95 <= config.frameBudgetMs },
    contractVersion: POIETRA_ENGINE_CONTRACT_VERSION,
    environment: config.environment,
    evaluate: {
      maximum: sorted.at(-1)!,
      p50: percentile(sorted, 0.5),
      p95,
      samplesMs: measured,
    },
    fixtureId: config.fixtureId,
    measuredFrames: config.measuredFrames,
    renderer: "typescript-reference",
    sampledPacketDigests: packetDigests,
    semanticDigest: await digestText(canonicalEngineBenchmarkJsonV1(packetDigests)),
    schema: "poietra.engine-benchmark-report",
    version: 1,
    warmupFrames: config.warmupFrames,
    workloadCategories: [...fixture(config.fixtureId).workloadCategories],
  });
  return reportResult.success
    ? { kind: "ready", report: reportResult.data }
    : { code: "invalid-report", kind: "error", message: errorMessage(reportResult.error) };
}
