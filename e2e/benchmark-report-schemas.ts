import { z } from "zod";

import {
  canvasAdapterEvidenceV1Schema,
  canvasMeasuredMemoryTelemetryV1Schema,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
} from "../src/engine/canvas-worker-protocol";
import { STAGE_TELEMETRY_COUNT_NAMES, STAGE_TELEMETRY_PHASE_NAMES } from "./engine-stress-workloads";

/** Strict schemas for the raw measurement bodies; envelopes may add descriptive metadata. */
const strictObject = z.strictObject;
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const count = z.number().int().nonnegative();
const positiveCount = count.positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const byteCount = count.max(Number.MAX_SAFE_INTEGER);
export const ENGINE_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
export const ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT = 300;
export const ENGINE_STAGE_TELEMETRY_WARMUP_COUNT = 30;
const timingSummary = (sample: z.ZodNumber) =>
  strictObject({
    maximumMs: sample,
    p50Ms: sample,
    p95Ms: sample,
    p99Ms: sample,
    samplesMs: z.array(sample).min(1),
  });
const nonnegativeTimingSummary = timingSummary(nonnegative);
const signedTimingSummary = timingSummary(finite);
const byteLength = positiveCount.max(MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES);
const byteLengthSummary = strictObject({
  maximumBytes: byteLength,
  minimumBytes: byteLength,
  p50Bytes: byteLength,
  p95Bytes: byteLength,
  p99Bytes: byteLength,
  samplesBytes: z.array(byteLength).min(1),
});
const unavailable = strictObject({ reason: z.string().min(1), status: z.literal("unavailable") });
const commitIdentity = strictObject({
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  treeState: z.enum(["clean", "dirty"]),
  uncommittedPathCount: count,
});
const hostEnvironment = strictObject({
  commitIdentity: z.union([commitIdentity, unavailable]),
  cpu: z.union([strictObject({ logicalCores: positiveCount, model: z.string() }), unavailable]),
  gpuDriver: unavailable,
  osKernel: strictObject({ platform: z.string(), release: z.string(), version: z.string() }),
  powerMode: unavailable,
});
const workerAdapter = z.discriminatedUnion("kind", [
  strictObject({ evidence: canvasAdapterEvidenceV1Schema, kind: z.literal("available") }),
  strictObject({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
]);
const evidenceEnvelope = {
  contracts: strictObject({
    canvasWorkerProtocolVersion: z.literal(1),
    engineContractVersion: z.literal(1),
    reportSchema: z.string().min(1),
    reportVersion: positiveCount,
    telemetryAbiVersion: z.literal(3),
  }),
  decisionEligibility: strictObject({ eligible: z.boolean(), reasons: z.array(z.string().min(1)) }),
  evidenceLevel: z.enum(["decision-candidate", "exploratory"]),
  provenance: strictObject({
    commitIdentity,
    grade: z.enum(["clean-commit", "non-decision-grade-dirty-tree"]),
  }),
  provenanceStableThroughRun: z.literal(true),
};
const browserLaunch = strictObject({ args: z.array(z.string()), channel: z.string().min(1) });
const wasmEvidence = strictObject({
  byteLength: positiveCount,
  gzipByteLength: positiveCount,
  path: z.string().min(1),
  sha256,
});
const retries = strictObject({ projectRetries: z.literal(0), testRetry: z.literal(0) });

export const engineWebgpuBenchmarkReportSchema = z.looseObject({
  ...evidenceEnvelope,
  baseFixtureId: z.string().min(1),
  capturedAt: z.string().datetime(),
  coldRuns: z
    .array(
      strictObject({
        run: count,
        sceneReadyMs: nonnegative,
        workerDeviceAdapter: canvasAdapterEvidenceV1Schema,
      }),
    )
    .min(1),
  configuration: z.looseObject({
    coldProcessRuns: positiveCount,
    lane: z.literal("production-build-static-server"),
    retries,
  }),
  environment: z.looseObject({
    browserLaunch,
    host: hostEnvironment,
    wasm: wasmEvidence,
    workerDeviceAdapter: workerAdapter,
  }),
  metrics: strictObject({
    coldBrowserLaunch: nonnegativeTimingSummary,
    coldClientImportToSceneReady: nonnegativeTimingSummary,
    coldPageLoad: nonnegativeTimingSummary,
    scrubAck: nonnegativeTimingSummary,
    warmFrame: nonnegativeTimingSummary,
  }),
  schema: z.literal("poietra.engine-webgpu-benchmark"),
  snapshotSha256: sha256,
  version: z.literal(2),
});

const stressDefinition = strictObject({
  entityCount: z.union([z.literal(100), z.literal(1_000)]),
  id: z.string().min(1),
  profile: z.enum(["animated-cubic-paths", "shape-primitives"]),
  revision: sha256,
});
const budget = strictObject({ limitMs: nonnegative, met: z.boolean() });
const interactionEntityCount = z.union([z.literal(100), z.literal(128)]);
const stressWorkload = strictObject({
  budgets: strictObject({
    interactionBoundsAcknowledgement: budget,
    randomSeekAcknowledgement: budget,
    stressRenderAcknowledgement: budget,
  }),
  continuousScrub: strictObject({
    burstDurationMs: nonnegative,
    finalSampleTime: nonnegative,
    fulfilledRequests: count,
    latestFulfilledSampleTime: nonnegative.nullable(),
    otherErrors: z.array(z.string()),
    requestedRequests: count,
    settleDurationMs: nonnegative,
    supersededRequests: count,
  }),
  definition: stressDefinition,
  interactionBounds: strictObject({
    acknowledgement: nonnegativeTimingSummary,
    entries: strictObject({
      observedTotal: count,
      statuses: strictObject({ empty: count, inactive: count, present: count, unavailable: count }),
    }),
    logicalResponseJsonBytes: byteLengthSummary,
    requestedEntityCount: interactionEntityCount,
    responses: strictObject({ available: count, missing: count, unavailable: count }),
    sceneEntityCount: z.union([z.literal(100), z.literal(1_000)]),
  }),
  installMs: nonnegative,
  pacedPresentation: strictObject({
    acknowledgement: nonnegativeTimingSummary,
    effectivePresentationAckFps: nonnegative,
    estimatedMissed60HzSlotsProxy: count,
    longPresentationAckIntervalsOver25Ms: count,
    presentationAckInterval: nonnegativeTimingSummary,
  }),
  randomSeekAck: nonnegativeTimingSummary,
  snapshotBytes: positiveCount,
  snapshotSha256: sha256,
  workerDeviceAdapter: workerAdapter,
});

export const engineWebgpuStressReportSchema = z.looseObject({
  ...evidenceEnvelope,
  baseFixtureId: z.string().min(1),
  capturedAt: z.string().datetime(),
  configuration: z.looseObject({ lane: z.literal("production-build-static-server"), retries }),
  environment: z.looseObject({ browserLaunch, host: hostEnvironment, wasm: wasmEvidence }),
  schema: z.literal("poietra.engine-webgpu-stress-benchmark"),
  version: z.literal(3),
  workloads: z.array(stressWorkload).min(1),
});

const cacheOutcome = z.enum(["absent", "hit", "miss", "retained", "skipped"]);
const cacheCounts = z.partialRecord(cacheOutcome, count);
const stageMemorySample = strictObject({ frameIndex: count, memory: canvasMeasuredMemoryTelemetryV1Schema });
const stageMemory = strictObject({
  budget: strictObject({ limitBytes: z.literal(ENGINE_MEMORY_BUDGET_BYTES), met: z.boolean() }),
  peakRetainedBoundaryBytes: byteCount,
  samples: z.array(stageMemorySample).min(1),
});
const stageWorkload = strictObject({
  attributionViolations: z.array(
    strictObject({
      frameIndex: count,
      violation: strictObject({
        additiveSumMs: nonnegative.nullable(),
        reason: z.string().min(1),
        residualMs: finite.nullable(),
        totalMs: nonnegative.nullable(),
      }),
    }),
  ),
  caches: strictObject({
    perFrame: z
      .array(
        strictObject({
          frameIndex: count,
          imageSamplerBinding: cacheOutcome,
          imageTexture: cacheOutcome,
          pipeline: cacheOutcome,
          preparedGeometry: cacheOutcome,
          surfaceConfiguration: cacheOutcome,
          surfaceConfigurations: count.nullable(),
        }),
      )
      .min(1),
    summary: strictObject({
      imageSamplerBinding: cacheCounts,
      imageTexture: cacheCounts,
      pipeline: cacheCounts,
      preparedGeometry: cacheCounts,
      surfaceConfiguration: cacheCounts,
    }),
  }),
  correlation: z
    .array(
      strictObject({
        ackMs: nonnegative,
        frameIndex: count,
        packetId: z.string().min(1),
        requestId: positiveCount,
        requestedSampleTime: nonnegative,
        residualMs: finite,
        sampleTime: nonnegative,
        suboptimal: z.boolean(),
        totalMs: nonnegative,
      }),
    )
    .min(1),
  counts: z.record(
    z.enum(STAGE_TELEMETRY_COUNT_NAMES),
    strictObject({ maximum: count, minimum: count, perFrame: z.array(count).min(1) }),
  ),
  definition: stressDefinition,
  installMs: nonnegative,
  memory: stageMemory,
  phases: z.record(
    z.enum(STAGE_TELEMETRY_PHASE_NAMES),
    strictObject({
      availability: strictObject({ measured: count, skipped: count, unavailable: count }),
      samplesMs: z.array(nonnegative),
      summary: nonnegativeTimingSummary.nullable(),
      unavailableReasons: z.array(z.string().min(1)),
    }),
  ),
  residual: signedTimingSummary,
  snapshotBytes: positiveCount,
  snapshotSha256: sha256,
  telemetryAck: nonnegativeTimingSummary,
  totalMsSummary: nonnegativeTimingSummary,
  workerDeviceAdapter: workerAdapter,
});

export const engineWebgpuStageTelemetryReportSchema = z
  .looseObject({
    ...evidenceEnvelope,
    baseFixtureId: z.string().min(1),
    capturedAt: z.string().datetime(),
    configuration: z.looseObject({
      lane: z.literal("production-build-static-server"),
      retries,
      telemetryFrames: z.literal(ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT),
      warmupFrames: z.literal(ENGINE_STAGE_TELEMETRY_WARMUP_COUNT),
    }),
    environment: z.looseObject({ browserLaunch, host: hostEnvironment, wasm: wasmEvidence }),
    memoryAccounting: strictObject({
      exclusions: z.tuple([
        z.literal("browser-js-dom"),
        z.literal("transient-per-frame-image-vertex-index-buffers-up-to-64-mib"),
        z.literal("surface-pipeline-bind-group-sampler-and-driver-allocations-not-byte-accounted"),
      ]),
      observation: z.literal("post-gpu-fence-pre-response-serialization-boundary"),
      peak: z.literal("maximum-raw-retained-boundary-total-peak-never-component-peak-sum"),
      scope: z.literal("retained-response-boundary-logical-bytes-not-intra-frame-peak-or-process-rss"),
      total: z.literal("wasm-linear-plus-logical-gpu-resident"),
      wasmBreakdown: z.literal("informational-subsets-already-contained-in-wasm-linear"),
    }),
    schema: z.literal("poietra.engine-webgpu-stage-telemetry"),
    version: z.literal(2),
    workloads: z.array(stageWorkload).min(1),
  })
  .superRefine((report, context) => {
    for (const [workloadIndex, workload] of report.workloads.entries()) {
      const path = ["workloads", workloadIndex, "memory"] as const;
      if (workload.memory.samples.length !== report.configuration.telemetryFrames) {
        context.addIssue({
          code: "custom",
          message: "memory samples must cover every telemetry frame",
          path: [...path, "samples"],
        });
        continue;
      }
      const highWaterPaths = [
        ["retainedBoundaryTotal"],
        ["logicalGpuBreakdown", "geometryBufferArena"],
        ["logicalGpuBreakdown", "retainedImageTextures"],
        ["logicalGpuResident"],
        ["wasmLinear"],
        ["wasmLinearBreakdown", "decodedImageAssets"],
        ["wasmLinearBreakdown", "preparedGeometryCache"],
        ["wasmLinearBreakdown", "retainedSceneIndex"],
      ] as const;
      let previousPeaks: number[] | null = null;
      for (const [sampleIndex, sample] of workload.memory.samples.entries()) {
        if (sample.frameIndex !== sampleIndex) {
          context.addIssue({
            code: "custom",
            message: "memory sample frameIndex must be contiguous and ordered",
            path: [...path, "samples", sampleIndex, "frameIndex"],
          });
        }
        const peaks = [
          sample.memory.retainedBoundaryTotal.peakBytes,
          sample.memory.logicalGpuBreakdown.geometryBufferArena.peakBytes,
          sample.memory.logicalGpuBreakdown.retainedImageTextures.peakBytes,
          sample.memory.logicalGpuResident.peakBytes,
          sample.memory.wasmLinear.peakBytes,
          sample.memory.wasmLinearBreakdown.decodedImageAssets.peakBytes,
          sample.memory.wasmLinearBreakdown.preparedGeometryCache.peakBytes,
          sample.memory.wasmLinearBreakdown.retainedSceneIndex.peakBytes,
        ];
        if (previousPeaks) {
          for (const [peakIndex, peak] of peaks.entries()) {
            if (peak < previousPeaks[peakIndex]!) {
              context.addIssue({
                code: "custom",
                message: "memory high-water values must be nondecreasing",
                path: [...path, "samples", sampleIndex, "memory", ...highWaterPaths[peakIndex]!, "peakBytes"],
              });
            }
          }
        }
        previousPeaks = peaks;
      }
      const recomputedPeak = Math.max(
        ...workload.memory.samples.map(({ memory }) => memory.retainedBoundaryTotal.peakBytes),
      );
      if (workload.memory.peakRetainedBoundaryBytes !== recomputedPeak) {
        context.addIssue({
          code: "custom",
          message: "peakRetainedBoundaryBytes must be recomputed from raw retainedBoundaryTotal peak samples",
          path: [...path, "peakRetainedBoundaryBytes"],
        });
      }
      if (workload.memory.budget.met !== recomputedPeak <= ENGINE_MEMORY_BUDGET_BYTES) {
        context.addIssue({
          code: "custom",
          message: "memory budget status must be derived from the recomputed peak",
          path: [...path, "budget", "met"],
        });
      }
    }
  });
