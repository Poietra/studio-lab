import { z } from "zod";

import {
  CANVAS_TELEMETRY_ADDITIVE_PHASES,
  canvasAdapterEvidenceV1Schema,
  canvasMeasuredMemoryTelemetryV1Schema,
  MAX_CANVAS_INTERACTION_ENTITY_IDS,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
} from "../src/engine/canvas-worker-protocol";
import {
  assessDecisionEligibility,
  type DecisionEligibility,
  hostEnvironmentSchema,
  type PinnedReferenceHostProfile,
  readPinnedReferenceHostProfile,
  referenceHostProfileEvidenceSchema,
  type WorkerAdapterIdentity,
  workerAdapterIdentityEquals,
} from "./benchmark-environment";
import {
  STAGE_TELEMETRY_COUNT_NAMES,
  STAGE_TELEMETRY_PHASE_NAMES,
  STRESS_DEFINITIONS,
} from "./engine-stress-workloads";

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
export const ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA = "poietra.engine-webgpu-benchmark";
export const ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION = 4;
export const ENGINE_WEBGPU_STRESS_REPORT_SCHEMA = "poietra.engine-webgpu-stress-benchmark";
export const ENGINE_WEBGPU_STRESS_REPORT_VERSION = 5;
export const ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA = "poietra.engine-webgpu-stage-telemetry";
export const ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION = 4;
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
const commitIdentity = strictObject({
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  treeState: z.enum(["clean", "dirty"]),
  uncommittedPathCount: count,
}).superRefine((identity, context) => {
  const countMatchesTreeState =
    identity.treeState === "clean" ? identity.uncommittedPathCount === 0 : identity.uncommittedPathCount > 0;
  if (!countMatchesTreeState) {
    context.addIssue({
      code: "custom",
      message: "treeState and uncommittedPathCount must describe the same working-tree state",
      path: ["uncommittedPathCount"],
    });
  }
});
const benchmarkWorkerAdapterEvidence = canvasAdapterEvidenceV1Schema.extend({
  adapter: canvasAdapterEvidenceV1Schema.shape.adapter.extend({
    browserArchitecture: z.string().max(256),
    browserVendor: z.string().max(256),
  }),
});
const availableWorkerAdapter = strictObject({
  evidence: benchmarkWorkerAdapterEvidence,
  kind: z.literal("available"),
});
const workerAdapter = z.discriminatedUnion("kind", [
  availableWorkerAdapter,
  strictObject({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
]);
const evidenceEnvelope = {
  benchmarkRunId: z.string().uuid(),
  contracts: strictObject({
    canvasWorkerProtocolVersion: z.literal(1),
    engineContractVersion: z.literal(1),
    reportSchema: z.string().min(1),
    reportVersion: positiveCount,
    telemetryAbiVersion: z.literal(4),
  }),
  decisionEligibility: strictObject({ eligible: z.boolean(), reasons: z.array(z.string().min(1)) }),
  evidenceLevel: z.enum(["decision-candidate", "exploratory"]),
  provenance: strictObject({
    commitIdentity,
    grade: z.enum(["clean-commit", "non-decision-grade-dirty-tree"]),
  }),
  provenanceStableThroughRun: z.literal(true),
};
const browserLaunch = strictObject({
  channel: z.enum(["chromium", "msedge"]),
  configuredArgs: z.array(z.string()),
});
const browserVersion = z.string().min(1);
const browserAdapterInfoString = z.string().max(256);
const availablePageAdapterHint = strictObject({
  architecture: browserAdapterInfoString,
  description: browserAdapterInfoString,
  device: browserAdapterInfoString,
  kind: z.literal("available"),
  vendor: browserAdapterInfoString,
});
const pageAdapterHint = z.discriminatedUnion("kind", [
  availablePageAdapterHint,
  strictObject({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
]);
const benchmarkPageAdapterHint = z.union([availablePageAdapterHint.omit({ kind: true }), z.null()]);
const wasmEvidence = strictObject({
  byteLength: positiveCount,
  gzipByteLength: positiveCount,
  path: z.string().min(1),
  sha256,
});
const retries = strictObject({ projectRetries: z.literal(0), testRetry: z.literal(0) });
const benchmarkViewport = strictObject({ heightPx: z.literal(90), widthPx: z.literal(160) });
const stressViewport = strictObject({ heightPx: z.literal(1_080), widthPx: z.literal(1_920) });
const stageAdditivePhases = z
  .array(z.enum(CANVAS_TELEMETRY_ADDITIVE_PHASES))
  .length(CANVAS_TELEMETRY_ADDITIVE_PHASES.length)
  .superRefine((phases, context) => {
    for (const [index, expected] of CANVAS_TELEMETRY_ADDITIVE_PHASES.entries()) {
      if (phases[index] !== expected) {
        context.addIssue({ code: "custom", message: `additive phase ${index} must be ${expected}`, path: [index] });
      }
    }
  });

type EvidenceEnvelopeReport = Readonly<{
  benchmarkRunId: string;
  contracts: Readonly<{
    reportSchema: string;
    reportVersion: number;
  }>;
  decisionEligibility: Readonly<{ eligible: boolean; reasons: readonly string[] }>;
  environment: Readonly<{ host: z.infer<typeof hostEnvironmentSchema> }>;
  evidenceLevel: "decision-candidate" | "exploratory";
  provenance: Readonly<{
    commitIdentity: z.infer<typeof commitIdentity>;
    grade: "clean-commit" | "non-decision-grade-dirty-tree";
  }>;
}>;

type EnvelopeIssue = Readonly<{ message: string; path: readonly (number | string)[] }>;
type AddEnvelopeIssue = (issue: { code: "custom"; message: string; path: (number | string)[] }) => void;

const PINNED_REFERENCE_HOST = readPinnedReferenceHostProfile();

function evidenceEnvelopeIssues(
  report: EvidenceEnvelopeReport,
  expectedSchema: string,
  expectedVersion: number,
): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  if (report.contracts.reportSchema !== expectedSchema) {
    issues.push({
      message: `contracts.reportSchema must equal ${expectedSchema}`,
      path: ["contracts", "reportSchema"],
    });
  }
  if (report.contracts.reportVersion !== expectedVersion) {
    issues.push({
      message: `contracts.reportVersion must equal ${expectedVersion}`,
      path: ["contracts", "reportVersion"],
    });
  }
  const reasonsAreEmpty = report.decisionEligibility.reasons.length === 0;
  if (report.decisionEligibility.eligible !== reasonsAreEmpty) {
    issues.push({
      message: "eligible must be true exactly when decisionEligibility.reasons is empty",
      path: ["decisionEligibility"],
    });
  }
  const expectedEvidenceLevel = report.decisionEligibility.eligible ? "decision-candidate" : "exploratory";
  if (report.evidenceLevel !== expectedEvidenceLevel) {
    issues.push({
      message: `evidenceLevel must be ${expectedEvidenceLevel} for this eligibility result`,
      path: ["evidenceLevel"],
    });
  }
  const expectedGrade =
    report.provenance.commitIdentity.treeState === "clean" ? "clean-commit" : "non-decision-grade-dirty-tree";
  if (report.provenance.grade !== expectedGrade) {
    issues.push({
      message: `provenance.grade must be ${expectedGrade} for this commit identity`,
      path: ["provenance", "grade"],
    });
  }
  if (report.decisionEligibility.eligible && report.provenance.grade !== "clean-commit") {
    issues.push({
      message: "decision-eligible evidence requires clean-commit provenance",
      path: ["decisionEligibility", "eligible"],
    });
  }
  const hostCommitIdentity = report.environment.host.commitIdentity;
  if ("status" in hostCommitIdentity) {
    issues.push({
      message: "benchmark reports require OS-environment commit identity to remain available",
      path: ["environment", "host", "commitIdentity"],
    });
  } else if (
    hostCommitIdentity.headCommit !== report.provenance.commitIdentity.headCommit ||
    hostCommitIdentity.treeState !== report.provenance.commitIdentity.treeState ||
    hostCommitIdentity.uncommittedPathCount !== report.provenance.commitIdentity.uncommittedPathCount
  ) {
    issues.push({
      message: "environment.host.commitIdentity must equal provenance.commitIdentity",
      path: ["environment", "host", "commitIdentity"],
    });
  }
  return issues;
}

function addEvidenceEnvelopeIssues(
  report: EvidenceEnvelopeReport,
  expectedSchema: string,
  expectedVersion: number,
  addIssue: AddEnvelopeIssue,
) {
  for (const issue of evidenceEnvelopeIssues(report, expectedSchema, expectedVersion)) {
    addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
  }
}

function referenceHostEvidenceEquals(
  evidence: z.infer<typeof referenceHostProfileEvidenceSchema>,
  pinned: PinnedReferenceHostProfile,
): boolean {
  return (
    evidence.id === pinned.evidence.id &&
    evidence.path === pinned.evidence.path &&
    evidence.sha256 === pinned.evidence.sha256 &&
    evidence.status === pinned.evidence.status
  );
}

function decisionEligibilityEquals(left: DecisionEligibility, right: DecisionEligibility): boolean {
  return (
    left.eligible === right.eligible &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index])
  );
}

function addRecomputedDecisionEligibilityIssues(
  input: Omit<Parameters<typeof assessDecisionEligibility>[0], "referenceHost"> &
    Readonly<{
      referenceHostEvidence: z.infer<typeof referenceHostProfileEvidenceSchema>;
      reported: DecisionEligibility;
    }>,
  addIssue: AddEnvelopeIssue,
) {
  if (!referenceHostEvidenceEquals(input.referenceHostEvidence, PINNED_REFERENCE_HOST)) {
    addIssue({
      code: "custom",
      message: "environment.referenceHostProfile must exactly identify the checked-in profile bytes",
      path: ["environment", "referenceHostProfile"],
    });
  }
  const recomputed = assessDecisionEligibility({
    browserChannel: input.browserChannel,
    browserLaunchArgs: input.browserLaunchArgs,
    browserVersions: input.browserVersions,
    grade: input.grade,
    host: input.host,
    pageAdapterHintArchitecture: input.pageAdapterHintArchitecture,
    referenceHost: PINNED_REFERENCE_HOST,
    requiredBrowserVersionSamples: input.requiredBrowserVersionSamples,
    requiredWorkerAdapterSamples: input.requiredWorkerAdapterSamples,
    workerAdapters: input.workerAdapters,
  });
  if (!decisionEligibilityEquals(input.reported, recomputed)) {
    addIssue({
      code: "custom",
      message: `decisionEligibility must exactly equal the evidence-derived assessment: ${JSON.stringify(recomputed)}`,
      path: ["decisionEligibility"],
    });
  }
}

function availableAdapterIdentities(samples: readonly z.infer<typeof workerAdapter>[]): WorkerAdapterIdentity[] {
  return samples.flatMap((sample) => (sample.kind === "available" ? [sample.evidence.adapter] : []));
}

export const engineWebgpuBenchmarkReportSchema = z
  .looseObject({
    ...evidenceEnvelope,
    baseFixtureId: z.string().min(1),
    capturedAt: z.string().datetime(),
    coldRuns: z
      .array(
        strictObject({
          browserVersion,
          run: count,
          sceneReadyMs: nonnegative,
          workerDeviceAdapter: benchmarkWorkerAdapterEvidence,
        }),
      )
      .length(20),
    configuration: z.looseObject({
      coldProcessRuns: z.literal(20),
      lane: z.literal("production-build-static-server"),
      measuredFrames: z.literal(300),
      retries,
      viewport: benchmarkViewport,
      warmupFrames: z.literal(30),
    }),
    environment: z.looseObject({
      browserLaunch,
      browserVersion,
      host: hostEnvironmentSchema,
      pageAdapterHint: benchmarkPageAdapterHint,
      referenceHostProfile: referenceHostProfileEvidenceSchema,
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
    schema: z.literal(ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA),
    snapshotSha256: sha256,
    version: z.literal(ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION),
  })
  .superRefine((report, context) => {
    addEvidenceEnvelopeIssues(
      report,
      ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA,
      ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION,
      (issue) => context.addIssue(issue),
    );
    const runIndexes = new Set(report.coldRuns.map((run) => run.run));
    if (runIndexes.size !== 20 || [...runIndexes].some((run) => run < 0 || run >= 20)) {
      context.addIssue({
        code: "custom",
        message: "coldRuns.run must contain every unique index from 0 through 19",
        path: ["coldRuns"],
      });
    }
    for (const [index, coldRun] of report.coldRuns.entries()) {
      if (coldRun.browserVersion !== report.environment.browserVersion) {
        context.addIssue({
          code: "custom",
          message: "cold-run browserVersion must equal environment.browserVersion",
          path: ["coldRuns", index, "browserVersion"],
        });
      }
    }
    const primaryAdapter =
      report.environment.workerDeviceAdapter.kind === "available"
        ? report.environment.workerDeviceAdapter.evidence.adapter
        : null;
    if (primaryAdapter) {
      for (const [index, coldRun] of report.coldRuns.entries()) {
        if (!workerAdapterIdentityEquals(coldRun.workerDeviceAdapter.adapter, primaryAdapter)) {
          context.addIssue({
            code: "custom",
            message: "cold-run Worker adapter identity must equal the primary Worker adapter identity",
            path: ["coldRuns", index, "workerDeviceAdapter", "adapter"],
          });
        }
      }
    }
    addRecomputedDecisionEligibilityIssues(
      {
        browserChannel: report.environment.browserLaunch.channel,
        browserLaunchArgs: report.environment.browserLaunch.configuredArgs,
        browserVersions: [...report.coldRuns.map((run) => run.browserVersion), report.environment.browserVersion],
        grade: report.provenance.grade,
        host: report.environment.host,
        pageAdapterHintArchitecture: report.environment.pageAdapterHint?.architecture ?? null,
        referenceHostEvidence: report.environment.referenceHostProfile,
        reported: report.decisionEligibility,
        requiredBrowserVersionSamples: 21,
        requiredWorkerAdapterSamples: 21,
        workerAdapters: [
          ...report.coldRuns.map((run) => run.workerDeviceAdapter.adapter),
          ...availableAdapterIdentities([report.environment.workerDeviceAdapter]),
        ],
      },
      (issue) => context.addIssue(issue),
    );
  });

function canonicalStressDefinition(
  entityCount: 100 | 1_000,
  id: string,
  profile: "animated-cubic-paths" | "png-images" | "shape-primitives",
  revisionDigit: string,
) {
  return strictObject({
    entityCount: z.literal(entityCount),
    id: z.literal(id),
    profile: z.literal(profile),
    revision: z.literal(revisionDigit.repeat(64)),
  });
}

const stressDefinition = z.union([
  canonicalStressDefinition(100, "shape-primitives-100", "shape-primitives", "1"),
  canonicalStressDefinition(1_000, "shape-primitives-1000", "shape-primitives", "2"),
  canonicalStressDefinition(100, "animated-cubic-paths-100", "animated-cubic-paths", "3"),
  canonicalStressDefinition(1_000, "animated-cubic-paths-1000", "animated-cubic-paths", "4"),
  canonicalStressDefinition(100, "png-images-100", "png-images", "5"),
  canonicalStressDefinition(1_000, "png-images-1000", "png-images", "6"),
]);
const canonicalStressWorkloadIds = [
  "shape-primitives-100",
  "shape-primitives-1000",
  "animated-cubic-paths-100",
  "animated-cubic-paths-1000",
  "png-images-100",
  "png-images-1000",
] as const;
const stressBaseFixtureIds = z.tuple([
  z.literal("eng-v1-shared-circle-opacity"),
  z.literal("eng-v1-png-alpha-edge-camera"),
]);
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
  workerDeviceAdapter: availableWorkerAdapter,
});

function requireCanonicalStressWorkloadOrder(
  workloads: readonly Readonly<{ definition: Readonly<{ id: string }> }>[],
  context: z.core.$RefinementCtx<unknown>,
) {
  if (workloads.length !== canonicalStressWorkloadIds.length) {
    context.addIssue({
      code: "custom",
      message: "report must contain every canonical stress workload exactly once",
      path: ["workloads"],
    });
    return;
  }
  for (const [index, expectedId] of canonicalStressWorkloadIds.entries()) {
    if (workloads[index]?.definition.id !== expectedId) {
      context.addIssue({
        code: "custom",
        message: `canonical workload ${index} must be ${expectedId}`,
        path: ["workloads", index, "definition", "id"],
      });
    }
  }
}

export const engineWebgpuStressReportSchema = z
  .looseObject({
    ...evidenceEnvelope,
    baseFixtureIds: stressBaseFixtureIds,
    capturedAt: z.string().datetime(),
    configuration: z.looseObject({
      frameBudgetMs: z.literal(1_000 / 60),
      interactionEntityIdCap: z.literal(MAX_CANVAS_INTERACTION_ENTITY_IDS),
      lane: z.literal("production-build-static-server"),
      longFrameThresholdMs: z.literal(25),
      measuredFrames: z.literal(300),
      pacedFrames: z.literal(301),
      retries,
      scrubFrames: z.literal(120),
      viewport: stressViewport,
      warmupFrames: z.literal(30),
    }),
    environment: z.looseObject({
      browserLaunch,
      browserVersion,
      host: hostEnvironmentSchema,
      pageAdapterHint,
      referenceHostProfile: referenceHostProfileEvidenceSchema,
      wasm: wasmEvidence,
    }),
    schema: z.literal(ENGINE_WEBGPU_STRESS_REPORT_SCHEMA),
    version: z.literal(ENGINE_WEBGPU_STRESS_REPORT_VERSION),
    workloads: z.array(stressWorkload),
  })
  .superRefine((report, context) => {
    addEvidenceEnvelopeIssues(
      report,
      ENGINE_WEBGPU_STRESS_REPORT_SCHEMA,
      ENGINE_WEBGPU_STRESS_REPORT_VERSION,
      (issue) => context.addIssue(issue),
    );
    requireCanonicalStressWorkloadOrder(report.workloads, context);
    addRecomputedDecisionEligibilityIssues(
      {
        browserChannel: report.environment.browserLaunch.channel,
        browserLaunchArgs: report.environment.browserLaunch.configuredArgs,
        browserVersions: [report.environment.browserVersion],
        grade: report.provenance.grade,
        host: report.environment.host,
        pageAdapterHintArchitecture:
          report.environment.pageAdapterHint.kind === "available"
            ? report.environment.pageAdapterHint.architecture
            : null,
        referenceHostEvidence: report.environment.referenceHostProfile,
        reported: report.decisionEligibility,
        requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
        workerAdapters: availableAdapterIdentities(report.workloads.map((workload) => workload.workerDeviceAdapter)),
      },
      (issue) => context.addIssue(issue),
    );
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
  workerDeviceAdapter: availableWorkerAdapter,
});

export const engineWebgpuStageTelemetryReportSchema = z
  .looseObject({
    ...evidenceEnvelope,
    baseFixtureIds: stressBaseFixtureIds,
    capturedAt: z.string().datetime(),
    configuration: z.looseObject({
      additivePhases: stageAdditivePhases,
      attributionToleranceMs: z.literal(2),
      interFrameYield: z.literal(
        "one requestAnimationFrame before every warmup and telemetry frame, outside all measured intervals",
      ),
      lane: z.literal("production-build-static-server"),
      retries,
      telemetryFrames: z.literal(ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT),
      viewport: stressViewport,
      warmupFrames: z.literal(ENGINE_STAGE_TELEMETRY_WARMUP_COUNT),
      warmupPath: z.literal("renderTelemetry with awaited GPU queue fence per warmup frame"),
      workloadCount: z.literal(6),
    }),
    environment: z.looseObject({
      browserLaunch,
      browserVersion,
      host: hostEnvironmentSchema,
      pageAdapterHint,
      referenceHostProfile: referenceHostProfileEvidenceSchema,
      wasm: wasmEvidence,
    }),
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
    schema: z.literal(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA),
    version: z.literal(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION),
    workloads: z.array(stageWorkload),
  })
  .superRefine((report, context) => {
    addEvidenceEnvelopeIssues(
      report,
      ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA,
      ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
      (issue) => context.addIssue(issue),
    );
    requireCanonicalStressWorkloadOrder(report.workloads, context);
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
        ["logicalGpuBreakdown", "multisampleColorTarget"],
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
          sample.memory.logicalGpuBreakdown.multisampleColorTarget.peakBytes,
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
    addRecomputedDecisionEligibilityIssues(
      {
        browserChannel: report.environment.browserLaunch.channel,
        browserLaunchArgs: report.environment.browserLaunch.configuredArgs,
        browserVersions: [report.environment.browserVersion],
        grade: report.provenance.grade,
        host: report.environment.host,
        pageAdapterHintArchitecture:
          report.environment.pageAdapterHint.kind === "available"
            ? report.environment.pageAdapterHint.architecture
            : null,
        referenceHostEvidence: report.environment.referenceHostProfile,
        reported: report.decisionEligibility,
        requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
        workerAdapters: availableAdapterIdentities(report.workloads.map((workload) => workload.workerDeviceAdapter)),
      },
      (issue) => context.addIssue(issue),
    );
  });
