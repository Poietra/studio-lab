import { z } from "zod";

import {
  canvasAdapterEvidenceV1Schema,
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
    telemetryAbiVersion: z.literal(1),
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
          pipeline: cacheOutcome,
          preparedGeometry: cacheOutcome,
          surfaceConfiguration: cacheOutcome,
          surfaceConfigurations: count.nullable(),
        }),
      )
      .min(1),
    summary: strictObject({ pipeline: cacheCounts, preparedGeometry: cacheCounts, surfaceConfiguration: cacheCounts }),
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

export const engineWebgpuStageTelemetryReportSchema = z.looseObject({
  ...evidenceEnvelope,
  baseFixtureId: z.string().min(1),
  capturedAt: z.string().datetime(),
  configuration: z.looseObject({
    lane: z.literal("production-build-static-server"),
    retries,
    telemetryFrames: positiveCount,
    warmupFrames: positiveCount,
  }),
  environment: z.looseObject({ browserLaunch, host: hostEnvironment, wasm: wasmEvidence }),
  schema: z.literal("poietra.engine-webgpu-stage-telemetry"),
  version: z.literal(1),
  workloads: z.array(stageWorkload).min(1),
});
