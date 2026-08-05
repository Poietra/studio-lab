import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs module with a sibling .d.ts; vitest resolves it at runtime.
import { makeBenchmarkBuildManifest } from "../scripts/benchmark-build-manifest.mjs";
import { adapterEvidenceFixtureV1, measuredTelemetryFixtureV1 } from "../src/engine/canvas-telemetry-test-fixtures";
import {
  CANVAS_TELEMETRY_ADDITIVE_PHASES,
  type CanvasAdapterEvidenceV1,
  MAX_CANVAS_INTERACTION_ENTITY_IDS,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
} from "../src/engine/canvas-worker-protocol";
import { sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  assessDecisionEligibility,
  collectCommitIdentity,
  collectHostEnvironment,
  type HostEnvironment,
  type PinnedReferenceHostProfile,
  readPinnedReferenceHostProfile,
  referenceHostProfileSchema,
  requireBenchmarkRunId,
  requireReferenceHostPreflight,
  requireStableCommitIdentity,
  requireStableReferenceHostEnvironment,
  resolveBenchmarkProvenance,
  WINDOWS_HOST_EVIDENCE_SCRIPT,
  WINDOWS_POWERSHELL_EXECUTABLE,
  type WorkerAdapterIdentity,
  windowsHostEvidenceInvocation,
} from "./benchmark-environment";
import {
  promoteBenchmarkEvidenceSetV1,
  verifyBenchmarkEvidenceSetV1,
  verifyCheckedInBenchmarkEvidenceV1,
  verifyPromotedBenchmarkEvidenceSetV1,
} from "./benchmark-evidence-set";
import {
  BENCHMARK_BUILD_MANIFEST_PATH,
  benchmarkBuildManifestSchema,
  manifestFileMismatch,
  sha256Hex,
  verifyServedBuildManifest,
} from "./benchmark-manifest";
import {
  ENGINE_MEMORY_BUDGET_BYTES,
  ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT,
  ENGINE_STAGE_TELEMETRY_WARMUP_COUNT,
  ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA,
  ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION,
  ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA,
  ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
  ENGINE_WEBGPU_STRESS_REPORT_SCHEMA,
  ENGINE_WEBGPU_STRESS_REPORT_VERSION,
  engineWebgpuBenchmarkReportSchema,
  engineWebgpuStageTelemetryReportSchema,
  engineWebgpuStressReportSchema,
} from "./benchmark-report-schemas";
import {
  IMAGE_GEOMETRY_UPLOAD_BYTES_PER_DRAW,
  STAGE_TELEMETRY_COUNT_NAMES,
  STAGE_TELEMETRY_PHASE_NAMES,
  STRESS_DEFINITIONS,
  stressBundle,
  summarizeByteLengths,
  summarizeSignedTiming,
  summarizeTiming,
} from "./engine-stress-workloads";
import { webgpuBrowserLaunch } from "./webgpu-launch";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const BENCHMARK_RUN_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_HOST = readPinnedReferenceHostProfile();

function fakeGit(headCommit: string, porcelain: string) {
  return (args: readonly string[]) => {
    if (args[0] === "rev-parse") return `${headCommit}\n`;
    if (args[0] === "status") return porcelain;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

function timingSummary(sample = 1) {
  return { maximumMs: sample, p50Ms: sample, p95Ms: sample, p99Ms: sample, samplesMs: [sample] };
}

function referenceHostEnvironment(referenceHost: PinnedReferenceHostProfile = REFERENCE_HOST): HostEnvironment {
  const profile = referenceHost.profile;
  return {
    browserInstallation: {
      channel: profile.browser.channel,
      executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      productVersion: profile.browser.version,
      source: "windows-file-version",
      status: "available",
    },
    commitIdentity: { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 },
    cpu: profile.cpu,
    gpuDriver: {
      controllers: profile.gpuControllers.map((controller, index) => ({
        ...controller,
        pnpDeviceId: `PCI\\REFERENCE-${index}`,
      })),
      source: "windows-cim",
      status: "available",
    },
    osKernel: { platform: "win32", release: profile.windowsBuild.version, version: "fixture Windows kernel" },
    powerMode: {
      ...profile.power,
      source: "windows-system-power-status+powercfg+powrprof",
      status: "available",
    },
    windowsBuild: { ...profile.windowsBuild, source: "windows-cim", status: "available" },
  };
}

function referenceWorkerAdapter(referenceHost: PinnedReferenceHostProfile = REFERENCE_HOST): WorkerAdapterIdentity {
  return {
    ...referenceHost.profile.selectedWorkerAdapter,
    deviceId: 0,
    driver: "",
    driverInfo: "",
    vendorId: 0,
  };
}

function referenceAdapterEvidenceFixture(): CanvasAdapterEvidenceV1 {
  return {
    ...adapterEvidenceFixtureV1(),
    adapter: referenceWorkerAdapter(),
  };
}

function cpuAdapterEvidence(evidence: CanvasAdapterEvidenceV1): CanvasAdapterEvidenceV1 {
  return {
    ...evidence,
    adapter: { ...evidence.adapter, deviceType: "Cpu", name: "forged CPU adapter" },
  };
}

function softwareAdapterEvidence(evidence: CanvasAdapterEvidenceV1): CanvasAdapterEvidenceV1 {
  return {
    ...evidence,
    adapter: {
      ...evidence.adapter,
      deviceType: "Other",
      name: "Google SwiftShader",
    },
  };
}

type StressProfile = "animated-cubic-paths" | "png-images" | "shape-primitives";

function stressDefinitionFixture(profile: StressProfile, entityCount: 100 | 1_000) {
  const definition = STRESS_DEFINITIONS.find(
    (candidate) => candidate.profile === profile && candidate.entityCount === entityCount,
  );
  if (!definition) throw new Error(`missing canonical ${profile}-${entityCount} stress definition`);
  return definition;
}

function stressWorkloadFixture(
  sceneEntityCount: 100 | 1_000,
  requestedEntityCount: number,
  responseBytes = 1_000,
  profile: StressProfile = "shape-primitives",
) {
  const timing = timingSummary();
  return {
    budgets: {
      interactionBoundsAcknowledgement: { limitMs: 33.3, met: true },
      randomSeekAcknowledgement: { limitMs: 50, met: true },
      stressRenderAcknowledgement: { limitMs: 33.3, met: true },
    },
    continuousScrub: {
      burstDurationMs: 1,
      finalSampleTime: 0,
      fulfilledRequests: 1,
      latestFulfilledSampleTime: 0,
      otherErrors: [],
      requestedRequests: 1,
      settleDurationMs: 0,
      supersededRequests: 0,
    },
    definition: stressDefinitionFixture(profile, sceneEntityCount),
    interactionBounds: {
      acknowledgement: timing,
      entries: {
        observedTotal: requestedEntityCount,
        statuses: { empty: 0, inactive: 0, present: requestedEntityCount, unavailable: 0 },
      },
      logicalResponseJsonBytes: {
        maximumBytes: responseBytes,
        minimumBytes: responseBytes,
        p50Bytes: responseBytes,
        p95Bytes: responseBytes,
        p99Bytes: responseBytes,
        samplesBytes: [responseBytes],
      },
      requestedEntityCount,
      responses: { available: 1, missing: 0, unavailable: 0 },
      sceneEntityCount,
    },
    installMs: 1,
    pacedPresentation: {
      acknowledgement: timing,
      effectivePresentationAckFps: 60,
      estimatedMissed60HzSlotsProxy: 0,
      longPresentationAckIntervalsOver25Ms: 0,
      presentationAckInterval: timing,
    },
    randomSeekAck: timing,
    snapshotBytes: 1,
    snapshotSha256: "2".repeat(64),
    workerDeviceAdapter: { evidence: referenceAdapterEvidenceFixture(), kind: "available" },
  };
}

function completeStressWorkloadFixtures() {
  return STRESS_DEFINITIONS.map((definition) => ({
    ...stressWorkloadFixture(definition.entityCount, Math.min(definition.entityCount, 128)),
    definition,
  }));
}

const FIXTURE_COMMIT_IDENTITY = { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 } as const;
const FIXTURE_PAGE_ADAPTER_HINT = {
  architecture: REFERENCE_HOST.profile.selectedWorkerAdapter.browserArchitecture,
  description: "",
  device: "",
  kind: "available",
  vendor: REFERENCE_HOST.profile.selectedWorkerAdapter.browserVendor,
} as const;

function reportEnvelopeFixture(reportSchema: string, reportVersion: number) {
  return {
    benchmarkRunId: BENCHMARK_RUN_ID,
    contracts: {
      canvasWorkerProtocolVersion: 1,
      engineContractVersion: 1,
      reportSchema,
      reportVersion,
      telemetryAbiVersion: 4,
    },
    decisionEligibility: { eligible: true, reasons: [] },
    environment: {
      browserLaunch: { channel: "msedge", configuredArgs: [] },
      browserVersion: REFERENCE_HOST.profile.browser.version,
      host: referenceHostEnvironment(),
      pageAdapterHint: FIXTURE_PAGE_ADAPTER_HINT,
      referenceHostProfile: REFERENCE_HOST.evidence,
      wasm: { byteLength: 1, gzipByteLength: 1, path: "fixture.wasm", sha256: "3".repeat(64) },
    },
    evidenceLevel: "decision-candidate",
    provenance: { commitIdentity: FIXTURE_COMMIT_IDENTITY, grade: "clean-commit" },
    provenanceStableThroughRun: true,
    schema: reportSchema,
    version: reportVersion,
  };
}

function fixtureDecisionFields(input: {
  browserChannel?: string;
  browserLaunchArgs?: readonly string[];
  browserVersions: readonly string[];
  grade?: "clean-commit" | "non-decision-grade-dirty-tree";
  host?: HostEnvironment;
  pageAdapterHintArchitecture?: string | null;
  requiredBrowserVersionSamples?: number;
  requiredWorkerAdapterSamples: number;
  workerAdapters: readonly WorkerAdapterIdentity[];
}) {
  const decisionEligibility = assessDecisionEligibility({
    browserChannel: input.browserChannel ?? "msedge",
    browserLaunchArgs: input.browserLaunchArgs ?? [],
    browserVersions: input.browserVersions,
    grade: input.grade ?? "clean-commit",
    host: input.host ?? referenceHostEnvironment(),
    pageAdapterHintArchitecture:
      input.pageAdapterHintArchitecture === undefined
        ? FIXTURE_PAGE_ADAPTER_HINT.architecture
        : input.pageAdapterHintArchitecture,
    referenceHost: REFERENCE_HOST,
    ...(input.requiredBrowserVersionSamples === undefined
      ? {}
      : { requiredBrowserVersionSamples: input.requiredBrowserVersionSamples }),
    requiredWorkerAdapterSamples: input.requiredWorkerAdapterSamples,
    workerAdapters: input.workerAdapters,
  });
  return {
    decisionEligibility,
    evidenceLevel: decisionEligibility.eligible ? ("decision-candidate" as const) : ("exploratory" as const),
  };
}

function stressReportFixture(workloads: readonly ReturnType<typeof stressWorkloadFixture>[]) {
  const decision = fixtureDecisionFields({
    browserVersions: [REFERENCE_HOST.profile.browser.version],
    requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
    workerAdapters: workloads.map((workload) => workload.workerDeviceAdapter.evidence.adapter),
  });
  return {
    ...reportEnvelopeFixture(ENGINE_WEBGPU_STRESS_REPORT_SCHEMA, ENGINE_WEBGPU_STRESS_REPORT_VERSION),
    ...decision,
    baseFixtureIds: ["eng-v1-shared-circle-opacity", "eng-v1-png-alpha-edge-camera"],
    capturedAt: "2026-07-28T00:00:00.000Z",
    configuration: {
      frameBudgetMs: 1_000 / 60,
      interactionEntityIdCap: MAX_CANVAS_INTERACTION_ENTITY_IDS,
      lane: "production-build-static-server",
      longFrameThresholdMs: 25,
      measuredFrames: 300,
      pacedFrames: 301,
      retries: { projectRetries: 0, testRetry: 0 },
      scrubFrames: 120,
      viewport: { heightPx: 1_080, widthPx: 1_920 },
      warmupFrames: 30,
    },
    workloads,
  };
}

function measuredMemorySample(frameIndex: number, retainedBoundaryPeakBytes: number) {
  const memory = measuredTelemetryFixtureV1().memory;
  if (memory.kind !== "measured") throw new Error("measured telemetry fixture must include measured memory");
  return {
    frameIndex,
    memory: {
      ...memory,
      retainedBoundaryTotal: {
        ...memory.retainedBoundaryTotal,
        peakBytes: retainedBoundaryPeakBytes,
      },
    },
  };
}

function benchmarkReportFixture() {
  const adapter = referenceAdapterEvidenceFixture();
  const envelope = reportEnvelopeFixture(ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA, ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION);
  const decision = fixtureDecisionFields({
    browserVersions: Array.from({ length: 21 }, () => REFERENCE_HOST.profile.browser.version),
    requiredBrowserVersionSamples: 21,
    requiredWorkerAdapterSamples: 21,
    workerAdapters: Array.from({ length: 21 }, () => adapter.adapter),
  });
  return {
    ...envelope,
    ...decision,
    baseFixtureId: "eng-v1-shared-circle-opacity",
    capturedAt: "2026-07-28T00:00:00.000Z",
    coldRuns: Array.from({ length: 20 }, (_, run) => ({
      browserVersion: REFERENCE_HOST.profile.browser.version,
      run,
      sceneReadyMs: 1,
      workerDeviceAdapter: adapter,
    })),
    configuration: {
      coldProcessRuns: 20,
      lane: "production-build-static-server",
      measuredFrames: 300,
      retries: { projectRetries: 0, testRetry: 0 },
      viewport: { heightPx: 90, widthPx: 160 },
      warmupFrames: 30,
    },
    environment: {
      ...envelope.environment,
      pageAdapterHint: {
        architecture: FIXTURE_PAGE_ADAPTER_HINT.architecture,
        description: FIXTURE_PAGE_ADAPTER_HINT.description,
        device: FIXTURE_PAGE_ADAPTER_HINT.device,
        vendor: FIXTURE_PAGE_ADAPTER_HINT.vendor,
      },
      workerDeviceAdapter: { evidence: adapter, kind: "available" },
    },
    metrics: {
      coldBrowserLaunch: timingSummary(),
      coldClientImportToSceneReady: timingSummary(),
      coldPageLoad: timingSummary(),
      scrubAck: timingSummary(),
      warmFrame: timingSummary(),
    },
    snapshotSha256: "4".repeat(64),
  };
}

function stageTelemetryWorkloadFixture(definition = STRESS_DEFINITIONS[0]!) {
  const frameCount = ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT;
  const frameIndices = Array.from({ length: frameCount }, (_, frameIndex) => frameIndex);
  const timing = { ...timingSummary(), samplesMs: frameIndices.map(() => 1) };
  const phases = Object.fromEntries(
    STAGE_TELEMETRY_PHASE_NAMES.map((name) => [
      name,
      {
        availability: { measured: frameCount, skipped: 0, unavailable: 0 },
        samplesMs: frameIndices.map(() => 1),
        summary: timing,
        unavailableReasons: [],
      },
    ]),
  );
  const counts = Object.fromEntries(
    STAGE_TELEMETRY_COUNT_NAMES.map((name) => [name, { maximum: 1, minimum: 1, perFrame: frameIndices.map(() => 1) }]),
  );
  const memorySamples = frameIndices.map((frameIndex) => measuredMemorySample(frameIndex, 30_000_000 + frameIndex));
  return {
    attributionViolations: [],
    caches: {
      perFrame: frameIndices.map((frameIndex) => ({
        frameIndex,
        imageSamplerBinding: "hit",
        imageTexture: "hit",
        pipeline: "retained",
        preparedGeometry: "hit",
        surfaceConfiguration: "hit",
        surfaceConfigurations: 0,
      })),
      summary: {
        imageSamplerBinding: { hit: frameCount },
        imageTexture: { hit: frameCount },
        pipeline: { retained: frameCount },
        preparedGeometry: { hit: frameCount },
        surfaceConfiguration: { hit: frameCount },
      },
    },
    correlation: frameIndices.map((frameIndex) => ({
      ackMs: 1,
      frameIndex,
      packetId: `packet-${frameIndex}`,
      requestId: frameIndex + 1,
      requestedSampleTime: frameIndex,
      residualMs: 0,
      sampleTime: frameIndex,
      suboptimal: false,
      totalMs: 1,
    })),
    counts,
    definition,
    installMs: 1,
    memory: {
      budget: { limitBytes: ENGINE_MEMORY_BUDGET_BYTES, met: true },
      peakRetainedBoundaryBytes: 30_000_000 + frameCount - 1,
      samples: memorySamples,
    },
    phases,
    residual: timing,
    snapshotBytes: 1,
    snapshotSha256: "2".repeat(64),
    telemetryAck: timing,
    totalMsSummary: timing,
    workerDeviceAdapter: { evidence: referenceAdapterEvidenceFixture(), kind: "available" },
  };
}

function stageTelemetryReportFixture() {
  const workloads = STRESS_DEFINITIONS.map((definition) => stageTelemetryWorkloadFixture(definition));
  const decision = fixtureDecisionFields({
    browserVersions: [REFERENCE_HOST.profile.browser.version],
    requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
    workerAdapters: workloads.map((workload) => workload.workerDeviceAdapter.evidence.adapter),
  });
  return {
    ...reportEnvelopeFixture(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA, ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION),
    ...decision,
    baseFixtureIds: ["eng-v1-shared-circle-opacity", "eng-v1-png-alpha-edge-camera"],
    capturedAt: "2026-07-28T00:00:00.000Z",
    configuration: {
      additivePhases: CANVAS_TELEMETRY_ADDITIVE_PHASES,
      attributionToleranceMs: 2,
      interFrameYield:
        "one requestAnimationFrame before every warmup and telemetry frame, outside all measured intervals",
      lane: "production-build-static-server",
      retries: { projectRetries: 0, testRetry: 0 },
      telemetryFrames: ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT,
      viewport: { heightPx: 1_080, widthPx: 1_920 },
      warmupFrames: ENGINE_STAGE_TELEMETRY_WARMUP_COUNT,
      warmupPath: "renderTelemetry with awaited GPU queue fence per warmup frame",
      workloadCount: STRESS_DEFINITIONS.length,
    },
    memoryAccounting: {
      exclusions: [
        "browser-js-dom",
        "transient-per-frame-image-vertex-index-buffers-up-to-64-mib",
        "surface-pipeline-bind-group-sampler-and-driver-allocations-not-byte-accounted",
      ],
      observation: "post-gpu-fence-pre-response-serialization-boundary",
      peak: "maximum-raw-retained-boundary-total-peak-never-component-peak-sum",
      scope: "retained-response-boundary-logical-bytes-not-intra-frame-peak-or-process-rss",
      total: "wasm-linear-plus-logical-gpu-resident",
      wasmBreakdown: "informational-subsets-already-contained-in-wasm-linear",
    },
    workloads,
  };
}

const stageReportFixture = stageTelemetryReportFixture;

function promotableEvidenceSetFixture() {
  const benchmark = benchmarkReportFixture();
  const coldTiming = summarizeTiming(
    Array.from({ length: 20 }, () => 1),
    20,
  );
  const measuredTiming = summarizeTiming(
    Array.from({ length: 300 }, () => 1),
    300,
  );
  const benchmarkReport = {
    ...benchmark,
    budgets: {
      coldClientImportToSceneReady: { limitMs: 1_000, met: true },
      scrubAck: { limitMs: 50, met: true },
      warmFrame: { limitMs: 16.7, met: true },
    },
    metrics: {
      coldBrowserLaunch: coldTiming,
      coldClientImportToSceneReady: coldTiming,
      coldPageLoad: coldTiming,
      scrubAck: measuredTiming,
      warmFrame: measuredTiming,
    },
  };

  const pacedTiming = summarizeTiming(
    Array.from({ length: 301 }, () => 1),
    301,
  );
  const byteSummary = summarizeByteLengths(
    Array.from({ length: 300 }, () => 1_000),
    300,
  );
  const stressReport = stressReportFixture(completeStressWorkloadFixtures());
  const stress = {
    ...stressReport,
    configuration: {
      ...stressReport.configuration,
      measuredFrames: 300,
      pacedFrames: 301,
      scrubFrames: 120,
    },
    workloads: stressReport.workloads.map((workload) => {
      const requestedEntityCount = Math.min(workload.definition.entityCount, 128);
      const expectedEntries = requestedEntityCount * 300;
      return {
        ...workload,
        continuousScrub: {
          ...workload.continuousScrub,
          fulfilledRequests: 120,
          requestedRequests: 120,
        },
        interactionBounds: {
          ...workload.interactionBounds,
          acknowledgement: measuredTiming,
          entries: {
            observedTotal: expectedEntries,
            statuses: { empty: 0, inactive: 0, present: expectedEntries, unavailable: 0 },
          },
          logicalResponseJsonBytes: byteSummary,
          requestedEntityCount,
          responses: { available: 300, missing: 0, unavailable: 0 },
        },
        pacedPresentation: {
          ...workload.pacedPresentation,
          acknowledgement: pacedTiming,
          effectivePresentationAckFps: 1_000,
          presentationAckInterval: measuredTiming,
        },
        randomSeekAck: measuredTiming,
      };
    }),
  };

  const stageReport = stageTelemetryReportFixture();
  const correlation = Array.from({ length: 300 }, (_, frameIndex) => ({
    ackMs: 1,
    frameIndex,
    packetId: `canvas:${frameIndex + 1}`,
    requestId: frameIndex + 1,
    requestedSampleTime: frameIndex,
    residualMs: 0,
    sampleTime: frameIndex,
    suboptimal: false,
    totalMs: 1,
  }));
  const countSample = { maximum: 1, minimum: 1, perFrame: Array.from({ length: 300 }, () => 1) };
  const phaseSample = {
    availability: { measured: 300, skipped: 0, unavailable: 0 },
    samplesMs: measuredTiming.samplesMs,
    summary: measuredTiming,
    unavailableReasons: [],
  };
  const unavailablePhaseSample = {
    availability: { measured: 0, skipped: 0, unavailable: 300 },
    samplesMs: [],
    summary: null,
    unavailableReasons: ["The architecture does not observe this phase."],
  };
  const cachePerFrame = Array.from({ length: 300 }, (_, frameIndex) => ({
    frameIndex,
    imageSamplerBinding: "miss" as const,
    imageTexture: "miss" as const,
    pipeline: "miss" as const,
    preparedGeometry: "miss" as const,
    surfaceConfiguration: "miss" as const,
    surfaceConfigurations: 1,
  }));
  const cacheSummary = {
    imageSamplerBinding: { miss: 300 },
    imageTexture: { miss: 300 },
    pipeline: { miss: 300 },
    preparedGeometry: { miss: 300 },
    surfaceConfiguration: { miss: 300 },
  };
  const stageTelemetry = {
    ...stageReport,
    configuration: { ...stageReport.configuration, telemetryFrames: 300 },
    workloads: stageReport.workloads.map((workload) => ({
      ...workload,
      caches: { perFrame: cachePerFrame, summary: cacheSummary },
      correlation,
      counts: Object.fromEntries(STAGE_TELEMETRY_COUNT_NAMES.map((name) => [name, countSample])),
      phases: Object.fromEntries(
        STAGE_TELEMETRY_PHASE_NAMES.map((name) => {
          const sample = name === "gpuExecution" || name === "browserComposite" ? unavailablePhaseSample : phaseSample;
          return [
            name,
            {
              ...sample,
              availability: { ...sample.availability },
              samplesMs: [...sample.samplesMs],
              unavailableReasons: [...sample.unavailableReasons],
            },
          ];
        }),
      ),
      residual: summarizeSignedTiming(
        Array.from({ length: 300 }, () => 0),
        300,
      ),
      telemetryAck: measuredTiming,
      totalMsSummary: measuredTiming,
    })),
  };
  return { benchmark: benchmarkReport, stageTelemetry, stress };
}

describe("benchmark provenance", () => {
  it("requires a canonical runner nonce", () => {
    expect(requireBenchmarkRunId({ POIETRA_BENCHMARK_RUN_ID: BENCHMARK_RUN_ID })).toBe(BENCHMARK_RUN_ID);
    expect(() => requireBenchmarkRunId({})).toThrow(/RUN_ID/);
    expect(() => requireBenchmarkRunId({ POIETRA_BENCHMARK_RUN_ID: "not-a-uuid" })).toThrow(/RUN_ID/);
  });

  it("derives clean/dirty identity from git and fails closed when git is unavailable", () => {
    expect(collectCommitIdentity(fakeGit(COMMIT_A, ""))).toEqual({
      headCommit: COMMIT_A,
      treeState: "clean",
      uncommittedPathCount: 0,
    });
    expect(collectCommitIdentity(fakeGit(COMMIT_A, " M a.ts\n?? b.ts\n"))).toEqual({
      headCommit: COMMIT_A,
      treeState: "dirty",
      uncommittedPathCount: 2,
    });
    expect(
      collectCommitIdentity(() => {
        throw new Error("no git");
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("aborts the decision lane on a dirty tree unless the smoke override is set", () => {
    expect(resolveBenchmarkProvenance({}, fakeGit(COMMIT_A, ""))).toEqual({
      commitIdentity: { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 },
      grade: "clean-commit",
    });
    expect(() => resolveBenchmarkProvenance({}, fakeGit(COMMIT_A, "?? x\n"))).toThrow(/clean working tree/);
    expect(resolveBenchmarkProvenance({ POIETRA_BENCHMARK_ALLOW_DIRTY: "1" }, fakeGit(COMMIT_A, "?? x\n")).grade).toBe(
      "non-decision-grade-dirty-tree",
    );
  });

  it("rejects HEAD or tree-state drift between run start and run end", () => {
    const start = { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 } as const;
    expect(requireStableCommitIdentity(start, fakeGit(COMMIT_A, ""))).toEqual(start);
    expect(() => requireStableCommitIdentity(start, fakeGit(COMMIT_B, ""))).toThrow(/changed during the benchmark run/);
    expect(() => requireStableCommitIdentity(start, fakeGit(COMMIT_A, " M drift.ts\n"))).toThrow(/disqualified/);
  });
});

describe("decision eligibility", () => {
  const hardwareAdapter = referenceWorkerAdapter();
  const softwareAdapter: WorkerAdapterIdentity = {
    backend: "BrowserWebGpu",
    browserArchitecture: "swiftshader",
    browserVendor: "google",
    deviceId: 0,
    deviceType: "Cpu",
    driver: "",
    driverInfo: "",
    name: "Google SwiftShader",
    source: "worker-wgpu-adapter-info",
    subgroupMaxSize: 128,
    subgroupMinSize: 4,
    vendorId: 0,
  };

  it("keeps Linux/SwiftShader and dirty evidence decision-ineligible", () => {
    const assessment = assessDecisionEligibility({
      browserChannel: "chromium",
      browserLaunchArgs: ["--use-angle=swiftshader"],
      browserVersions: ["fixture-browser"],
      grade: "non-decision-grade-dirty-tree",
      host: collectHostEnvironment({ platform: "linux" }),
      pageAdapterHintArchitecture: "swiftshader",
      referenceHost: REFERENCE_HOST,
      workerAdapters: [softwareAdapter],
    });
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join("\n")).toMatch(/dirty/);
    expect(assessment.reasons.join("\n")).toMatch(/software adapter/);
    expect(assessment.reasons.join("\n")).toMatch(/swiftshader/);
    expect(assessment.reasons.join("\n")).toMatch(/host platform is linux/);
    expect(assessment.reasons.join("\n")).toMatch(/renderer overrides/);

    const linuxHardware = assessDecisionEligibility({
      browserChannel: "chromium",
      browserLaunchArgs: [],
      browserVersions: [REFERENCE_HOST.profile.browser.version],
      grade: "clean-commit",
      host: collectHostEnvironment({ platform: "linux" }),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      workerAdapters: [hardwareAdapter],
    });
    expect(linuxHardware.eligible).toBe(false);
    expect(linuxHardware.reasons.every((reason) => reason.length > 0)).toBe(true);
  });

  it("requires the exact sample count and makes only the pinned Windows host eligible", () => {
    const assessment = assessDecisionEligibility({
      browserChannel: "msedge",
      browserLaunchArgs: [],
      browserVersions: [],
      grade: "clean-commit",
      host: referenceHostEnvironment(),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      requiredBrowserVersionSamples: 21,
      requiredWorkerAdapterSamples: 21,
      workerAdapters: [],
    });
    expect(assessment.reasons.join("\n")).toMatch(/no Worker device adapter evidence/);
    expect(assessment.reasons.join("\n")).toMatch(/required exactly 21/);

    const exact = assessDecisionEligibility({
      browserChannel: "msedge",
      browserLaunchArgs: [],
      browserVersions: Array.from({ length: 21 }, () => REFERENCE_HOST.profile.browser.version),
      grade: "clean-commit",
      host: referenceHostEnvironment(),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      requiredBrowserVersionSamples: 21,
      requiredWorkerAdapterSamples: 21,
      workerAdapters: Array.from({ length: 21 }, () => hardwareAdapter),
    });
    expect(exact).toEqual({ eligible: true, reasons: [] });

    const redacted = assessDecisionEligibility({
      browserChannel: "msedge",
      browserLaunchArgs: [],
      browserVersions: [REFERENCE_HOST.profile.browser.version],
      grade: "clean-commit",
      host: referenceHostEnvironment(),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      workerAdapters: [{ ...hardwareAdapter, browserArchitecture: "", browserVendor: "" }],
    });
    expect(redacted.eligible).toBe(false);
    expect(redacted.reasons.join("\n")).toMatch(/vendor\/architecture identity is unavailable/);

    const changed = assessDecisionEligibility({
      browserChannel: "msedge",
      browserLaunchArgs: [],
      browserVersions: [REFERENCE_HOST.profile.browser.version, "0.0.0.0"],
      grade: "clean-commit",
      host: referenceHostEnvironment(),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      workerAdapters: [hardwareAdapter, { ...hardwareAdapter, browserArchitecture: "another-architecture" }],
    });
    expect(changed.eligible).toBe(false);
    expect(changed.reasons.join("\n")).toMatch(/browser version/);
    expect(changed.reasons.join("\n")).toMatch(/identity changed/);
  });

  it("uses platform-owned launch settings and rejects non-OS host assertions", () => {
    expect(webgpuBrowserLaunch("win32")).toEqual({ args: [], channel: "msedge" });
    expect(webgpuBrowserLaunch("linux")).toEqual({
      args: ["--disable-vulkan-surface", "--enable-features=Vulkan", "--enable-unsafe-webgpu", "--use-angle=vulkan"],
      channel: "chromium",
    });

    const unavailable = collectHostEnvironment({
      platform: "win32",
      windowsHostEvidence: () => {
        throw new Error("PowerShell unavailable");
      },
    });
    expect(unavailable.gpuDriver).toMatchObject({ status: "unavailable" });
    expect(unavailable.browserInstallation).toMatchObject({ status: "unavailable" });
    expect(unavailable.powerMode).toMatchObject({ status: "unavailable" });
    expect(unavailable.windowsBuild).toMatchObject({ status: "unavailable" });
    expect(() =>
      requireReferenceHostPreflight({
        browserLaunch: webgpuBrowserLaunch("win32"),
        host: unavailable,
        referenceHost: REFERENCE_HOST,
      }),
    ).toThrow(/preflight failed/);

    const expected = referenceHostEnvironment();
    const measured = collectHostEnvironment({
      platform: "win32",
      windowsHostEvidence: () =>
        JSON.stringify({
          browserInstallation: expected.browserInstallation,
          gpuDriver: expected.gpuDriver,
          powerMode: expected.powerMode,
          windowsBuild: expected.windowsBuild,
        }),
    });
    expect(measured.gpuDriver).toEqual(expected.gpuDriver);
    expect(measured.browserInstallation).toEqual(expected.browserInstallation);
    expect(measured.powerMode).toEqual(expected.powerMode);
    expect(measured.windowsBuild).toEqual(expected.windowsBuild);
  });

  it("pins Windows evidence commands and discovery independently of caller environment variables", () => {
    const invocation = windowsHostEvidenceInvocation("Write-Output canonical");
    expect(invocation.executablePath).toBe(WINDOWS_POWERSHELL_EXECUTABLE);
    expect(invocation.executablePath).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(invocation.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output canonical"]);
    expect(invocation.env).toEqual({
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      Path: String.raw`C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PSModulePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
      SystemRoot: String.raw`C:\Windows`,
      TEMP: String.raw`C:\Windows\Temp`,
      TMP: String.raw`C:\Windows\Temp`,
      WINDIR: String.raw`C:\Windows`,
    });
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).not.toMatch(/GetEnvironmentVariable|&\s+powercfg\.exe/u);
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain("$env:TEMP = $userTemp");
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain("$env:TMP = $userTemp");
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain(
      "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
    );
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain(String.raw`C:\Windows\System32\powercfg.exe`);
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain("PowerGetUserConfiguredACPowerMode");
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain(
      String.raw`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`,
    );
  });

  it("requires AC power and stable OS-owned evidence before publishing a Windows run", () => {
    const host = referenceHostEnvironment();
    expect(() =>
      requireReferenceHostPreflight({
        browserLaunch: webgpuBrowserLaunch("win32"),
        host,
        referenceHost: REFERENCE_HOST,
      }),
    ).not.toThrow();

    const offline = {
      ...host,
      powerMode: { ...host.powerMode, acLineStatus: "offline" as const },
    };
    expect(() =>
      requireReferenceHostPreflight({
        browserLaunch: webgpuBrowserLaunch("win32"),
        host: offline,
        referenceHost: REFERENCE_HOST,
      }),
    ).toThrow(/not connected to AC power/);
    expect(() => requireStableReferenceHostEnvironment(host, offline)).toThrow(/changed during/);

    const differentPowerMode = {
      ...host,
      powerMode: {
        ...host.powerMode,
        userConfiguredAcPowerModeGuid: "00000000-0000-0000-0000-000000000000",
      },
    };
    expect(() =>
      requireReferenceHostPreflight({
        browserLaunch: webgpuBrowserLaunch("win32"),
        host: differentPowerMode,
        referenceHost: REFERENCE_HOST,
      }),
    ).toThrow(/user-configured Windows AC power mode/);
    expect(() => requireStableReferenceHostEnvironment(host, differentPowerMode)).toThrow(/changed during/);
  });

  it("verifies the checked-in profile bytes against the separate reviewed hash", () => {
    expect(readPinnedReferenceHostProfile()).toEqual(REFERENCE_HOST);
    expect(() => readPinnedReferenceHostProfile(Buffer.from("{}"), "0".repeat(64))).toThrow(/hashes to/);
  });

  it("separates the selected OS controller from the same-device browser identity", () => {
    expect(referenceHostProfileSchema.safeParse(REFERENCE_HOST.profile).success).toBe(true);
    expect(
      referenceHostProfileSchema.safeParse({
        ...REFERENCE_HOST.profile,
        selectedGpuController: { ...REFERENCE_HOST.profile.selectedGpuController, deviceId: 1 },
      }).success,
    ).toBe(false);
    expect(
      referenceHostProfileSchema.safeParse({
        ...REFERENCE_HOST.profile,
        selectedWorkerAdapter: { ...REFERENCE_HOST.profile.selectedWorkerAdapter, browserVendor: "" },
      }).success,
    ).toBe(false);
    expect(
      referenceHostProfileSchema.safeParse({
        ...REFERENCE_HOST.profile,
        selectedWorkerAdapter: {
          ...REFERENCE_HOST.profile.selectedWorkerAdapter,
          subgroupMaxSize: 4,
          subgroupMinSize: 128,
        },
      }).success,
    ).toBe(false);
  });
});

describe("build manifest", () => {
  it("hashes the served executable set and detects swapped or truncated files", () => {
    const distDir = mkdtempSync(join(tmpdir(), "poietra-manifest-"));
    try {
      mkdirSync(join(distDir, "assets"));
      mkdirSync(join(distDir, "engine-wasm"));
      writeFileSync(join(distDir, "benchmark.html"), "<html>bench</html>");
      writeFileSync(join(distDir, "assets", "benchmark-abc.js"), "entry();");
      writeFileSync(join(distDir, "assets", "canvas-worker-client-def.js"), "client();");
      writeFileSync(join(distDir, "engine-wasm", "poietra_wasm.js"), "glue();");
      writeFileSync(join(distDir, "engine-wasm", "poietra_wasm_bg.wasm"), Buffer.from([0, 97, 115, 109]));

      const manifest = benchmarkBuildManifestSchema.parse(
        makeBenchmarkBuildManifest(distDir, { commit: COMMIT_A, treeState: "clean" }),
      );
      expect(manifest.files.map((file) => file.path)).toEqual([
        "assets/benchmark-abc.js",
        "assets/canvas-worker-client-def.js",
        "benchmark.html",
        "engine-wasm/poietra_wasm.js",
        "engine-wasm/poietra_wasm_bg.wasm",
      ]);

      const entry = manifest.files.find((file) => file.path === "assets/benchmark-abc.js")!;
      expect(manifestFileMismatch(entry, new TextEncoder().encode("entry();"))).toBeNull();
      expect(manifestFileMismatch(entry, new TextEncoder().encode("swapped();"))).toMatch(/hashes to|bytes/);
      expect(manifestFileMismatch(entry, new TextEncoder().encode("entry()"))).toMatch(/bytes/);
      expect(sha256Hex(new TextEncoder().encode("entry();"))).toBe(entry.sha256);
    } finally {
      rmSync(distDir, { force: true, recursive: true });
    }
  });
});

describe("served build manifest verification", () => {
  function servedFixture(treeState: "clean" | "dirty") {
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([
      ["benchmark.html", encoder.encode("<html>bench</html>")],
      ["assets/benchmark-abc.js", encoder.encode("entry();")],
      ["engine-wasm/poietra_wasm.js", encoder.encode("glue();")],
      ["engine-wasm/poietra_wasm_bg.wasm", new Uint8Array([0, 97, 115, 109])],
    ]);
    const manifest = {
      commit: COMMIT_A,
      files: [...files.entries()]
        .map(([path, bytes]) => ({ byteLength: bytes.byteLength, path, sha256: sha256Hex(bytes) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      generatedAtEpochMs: 1,
      schema: "poietra.benchmark-build-manifest",
      treeState,
      version: 1,
    };
    const fetchServedFile = async (path: string) => {
      if (path === BENCHMARK_BUILD_MANIFEST_PATH) return new TextEncoder().encode(JSON.stringify(manifest));
      const bytes = files.get(path);
      if (!bytes) throw new Error(`unexpected fetch: ${path}`);
      return bytes;
    };
    return { fetchServedFile, files };
  }

  it("accepts a served build whose commit AND tree state match the run's provenance", async () => {
    const { fetchServedFile } = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).resolves.toMatchObject({ commit: COMMIT_A, treeState: "clean" });
  });

  it("rejects a dirty-built manifest at the same HEAD during a clean-tree run", async () => {
    // Same commit, but the served bytes were produced from a dirty tree: a
    // clean (decision-candidate) run must never attribute them to its commit.
    const { fetchServedFile } = servedFixture("dirty");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).rejects.toThrow(/built from a dirty tree.*this run's tree is clean/);
    // And the inverse: a clean-built manifest does not match a dirty run.
    const clean = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(clean.fetchServedFile, { headCommit: COMMIT_A, treeState: "dirty" }),
    ).rejects.toThrow(/built from a clean tree.*this run's tree is dirty/);
  });

  it("rejects a manifest built at a different commit or with swapped served bytes", async () => {
    const { fetchServedFile, files } = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_B, treeState: "clean" }),
    ).rejects.toThrow(/stale build/);
    files.set("assets/benchmark-abc.js", new TextEncoder().encode("tampered();"));
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).rejects.toThrow(/verification failed/);
  });
});

describe("report summaries", () => {
  it("builds both canonical PNG workloads from one unchanged caller-owned asset", () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/engine-v1/png-alpha-edge-camera.json"), "utf8"),
    ) as { assets: unknown; scene: unknown };
    const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    const originalAssets = structuredClone(base.assets);
    const definitions = STRESS_DEFINITIONS.filter(({ profile }) => profile === "png-images");

    expect(IMAGE_GEOMETRY_UPLOAD_BYTES_PER_DRAW).toBe(104);
    expect(definitions.map(({ entityCount, id, revision }) => ({ entityCount, id, revision }))).toEqual([
      { entityCount: 100, id: "png-images-100", revision: "5".repeat(64) },
      { entityCount: 1_000, id: "png-images-1000", revision: "6".repeat(64) },
    ]);
    for (const definition of definitions) {
      const bundle = stressBundle(base, definition);
      const asset = originalAssets.assets[0]!;
      expect(bundle.assets).toEqual(originalAssets);
      expect(bundle.scene.animationChannels).toEqual([]);
      expect(bundle.scene.camera.view).toEqual({ center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 });
      expect(bundle.scene.requiredCapabilities).toEqual(["png-image"]);
      expect(bundle.scene.entities).toHaveLength(definition.entityCount);
      expect(new Set(bundle.scene.entities.map(({ id }) => id)).size).toBe(definition.entityCount);
      const samplers: Record<"linear" | "nearest", number> = { linear: 0, nearest: 0 };
      for (const [index, entity] of bundle.scene.entities.entries()) {
        expect(entity.id).toBe(`stress:image:${index}`);
        expect(entity.appearance).toEqual({ kind: "image", opacity: 1 });
        expect(entity.geometry).toMatchObject({
          asset: { assetId: asset.id, sha256: asset.sha256 },
          kind: "image",
        });
        if (entity.geometry.kind !== "image") throw new Error("PNG workload entity must use image geometry");
        samplers[entity.geometry.sampler] += 1;
      }
      expect(samplers).toEqual({ linear: definition.entityCount / 2, nearest: definition.entityCount / 2 });
    }
    expect(base.assets).toEqual(originalAssets);

    const assetlessFixture = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/engine-v1/shared-circle-opacity.json"), "utf8"),
    ) as { assets: unknown; scene: unknown };
    const assetlessBase = sceneIrBundleV1Schema.parse({
      assets: assetlessFixture.assets,
      scene: assetlessFixture.scene,
    });
    expect(() => stressBundle(assetlessBase, definitions[0]!)).toThrow(/exactly one verified PNG asset/);
  });

  it("rejects short, non-finite, or negative series and keeps signed residuals unclamped", () => {
    expect(() => summarizeTiming([1, 2], 3)).toThrow(/exactly 3/);
    expect(() => summarizeTiming([1, -0.5, 2], 3)).toThrow(/invalid/);
    expect(() => summarizeTiming([1, Number.NaN, 2], 3)).toThrow(/invalid/);
    expect(summarizeTiming([3, 1, 2], 3).p50Ms).toBe(2);

    expect(() => summarizeSignedTiming([0.1, Number.POSITIVE_INFINITY], 2)).toThrow(/invalid/);
    const signed = summarizeSignedTiming([-0.4, 0.2, 0.1], 3);
    expect(signed.p50Ms).toBe(0.1);
    expect(Math.min(...signed.samplesMs)).toBe(-0.4);
  });

  it("fails closed on invalid response byte samples and uses nearest-rank percentiles", () => {
    expect(() => summarizeByteLengths([100, 200], 3)).toThrow(/exactly 3/);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES + 1]) {
      expect(() => summarizeByteLengths([invalid], 1)).toThrow(/outside the canvas response budget/);
    }
    expect(summarizeByteLengths([MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES], 1).maximumBytes).toBe(
      MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
    );

    expect(summarizeByteLengths([400, 100, 300, 200], 4)).toEqual({
      maximumBytes: 400,
      minimumBytes: 100,
      p50Bytes: 200,
      p95Bytes: 400,
      p99Bytes: 400,
      samplesBytes: [400, 100, 300, 200],
    });
  });

  it("dispatches all three breaking report contracts by their next exact versions", () => {
    const benchmark = benchmarkReportFixture();
    const stress = stressReportFixture(completeStressWorkloadFixtures());
    const stage = stageTelemetryReportFixture();

    expect(engineWebgpuBenchmarkReportSchema.parse(benchmark).version).toBe(ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION);
    expect(engineWebgpuStressReportSchema.parse(stress).version).toBe(ENGINE_WEBGPU_STRESS_REPORT_VERSION);
    expect(engineWebgpuStageTelemetryReportSchema.parse(stage).version).toBe(
      ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
    );
    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...benchmark,
        version: ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION - 1,
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({ ...stress, version: ENGINE_WEBGPU_STRESS_REPORT_VERSION - 1 }).success,
    ).toBe(false);
    expect(
      engineWebgpuStageTelemetryReportSchema.safeParse({
        ...stage,
        version: ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION - 1,
      }).success,
    ).toBe(false);
  });

  it("recomputes eligibility from every report's host, browser, profile hash, and Worker evidence", () => {
    const benchmark = benchmarkReportFixture();
    const stress = stressReportFixture(completeStressWorkloadFixtures());
    const stage = stageTelemetryReportFixture();
    const benchmarkWithAdapters = (transform: (evidence: CanvasAdapterEvidenceV1) => CanvasAdapterEvidenceV1) => ({
      ...benchmark,
      coldRuns: benchmark.coldRuns.map((coldRun) => ({
        ...coldRun,
        workerDeviceAdapter: transform(coldRun.workerDeviceAdapter),
      })),
      environment: {
        ...benchmark.environment,
        workerDeviceAdapter: {
          evidence: transform(benchmark.environment.workerDeviceAdapter.evidence),
          kind: "available" as const,
        },
      },
    });
    const stressWithAdapters = (transform: (evidence: CanvasAdapterEvidenceV1) => CanvasAdapterEvidenceV1) => ({
      ...stress,
      workloads: stress.workloads.map((workload) => ({
        ...workload,
        workerDeviceAdapter: {
          evidence: transform(workload.workerDeviceAdapter.evidence),
          kind: "available" as const,
        },
      })),
    });
    const stageWithAdapters = (transform: (evidence: CanvasAdapterEvidenceV1) => CanvasAdapterEvidenceV1) => ({
      ...stage,
      workloads: stage.workloads.map((workload) => ({
        ...workload,
        workerDeviceAdapter: {
          evidence: transform(workload.workerDeviceAdapter.evidence),
          kind: "available" as const,
        },
      })),
    });
    const cases = [
      {
        cpuReport: benchmarkWithAdapters(cpuAdapterEvidence),
        name: "benchmark",
        pageSoftwareReport: {
          ...benchmark,
          environment: {
            ...benchmark.environment,
            pageAdapterHint: { ...benchmark.environment.pageAdapterHint, architecture: "SwiftShader" },
          },
        },
        report: benchmark,
        schema: engineWebgpuBenchmarkReportSchema,
        softwareReport: benchmarkWithAdapters(softwareAdapterEvidence),
      },
      {
        cpuReport: stressWithAdapters(cpuAdapterEvidence),
        name: "stress",
        pageSoftwareReport: {
          ...stress,
          environment: {
            ...stress.environment,
            pageAdapterHint: { ...stress.environment.pageAdapterHint, architecture: "SwiftShader" },
          },
        },
        report: stress,
        schema: engineWebgpuStressReportSchema,
        softwareReport: stressWithAdapters(softwareAdapterEvidence),
      },
      {
        cpuReport: stageWithAdapters(cpuAdapterEvidence),
        name: "stage",
        pageSoftwareReport: {
          ...stage,
          environment: {
            ...stage.environment,
            pageAdapterHint: { ...stage.environment.pageAdapterHint, architecture: "SwiftShader" },
          },
        },
        report: stage,
        schema: engineWebgpuStageTelemetryReportSchema,
        softwareReport: stageWithAdapters(softwareAdapterEvidence),
      },
    ] as const;

    for (const reportCase of cases) {
      expect(reportCase.report.decisionEligibility, reportCase.name).toEqual({ eligible: true, reasons: [] });
      expect(reportCase.report.provenance.grade, reportCase.name).toBe("clean-commit");
      expect(reportCase.schema.safeParse(reportCase.report).success, reportCase.name).toBe(true);

      const common = reportCase.report as typeof reportCase.report & {
        environment: {
          browserLaunch: { channel: string; configuredArgs: readonly string[] };
          browserVersion: string;
          host: HostEnvironment;
          referenceHostProfile: PinnedReferenceHostProfile["evidence"];
        };
      };
      const linux = {
        ...common,
        environment: {
          ...common.environment,
          host: {
            ...common.environment.host,
            osKernel: { ...common.environment.host.osKernel, platform: "linux" },
          },
        },
      };
      const chromium = {
        ...common,
        environment: {
          ...common.environment,
          browserLaunch: { channel: "chromium", configuredArgs: [] },
        },
      };
      const swiftShaderLaunch = {
        ...common,
        environment: {
          ...common.environment,
          browserLaunch: { channel: "msedge", configuredArgs: ["--use-angle=swiftshader"] },
        },
      };
      expect(reportCase.schema.safeParse(linux).success, `${reportCase.name}: Linux host`).toBe(false);
      expect(reportCase.schema.safeParse(chromium).success, `${reportCase.name}: Chromium channel`).toBe(false);
      expect(
        reportCase.schema.safeParse(swiftShaderLaunch).success,
        `${reportCase.name}: SwiftShader launch args`,
      ).toBe(false);
      expect(reportCase.schema.safeParse(reportCase.cpuReport).success, `${reportCase.name}: CPU adapter`).toBe(false);
      expect(
        reportCase.schema.safeParse(reportCase.softwareReport).success,
        `${reportCase.name}: software adapter`,
      ).toBe(false);
      expect(
        reportCase.schema.safeParse(reportCase.pageSoftwareReport).success,
        `${reportCase.name}: page software hint`,
      ).toBe(false);
      expect(
        reportCase.schema.safeParse({
          ...common,
          environment: {
            ...common.environment,
            referenceHostProfile: { ...common.environment.referenceHostProfile, sha256: "0".repeat(64) },
          },
        }).success,
        `${reportCase.name}: forged reference-profile hash`,
      ).toBe(false);
      expect(
        reportCase.schema.safeParse({
          ...common,
          environment: { ...common.environment, browserVersion: "0.0.0.0" },
        }).success,
        `${reportCase.name}: browser-version mismatch`,
      ).toBe(false);
    }
  });

  it("requires benchmark v4 cold-run indexes, browser versions, and complete adapter identity to agree", () => {
    const report = benchmarkReportFixture();
    expect(engineWebgpuBenchmarkReportSchema.safeParse(report).success).toBe(true);

    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...report,
        contracts: { ...report.contracts, telemetryAbiVersion: 3 },
      }).success,
    ).toBe(false);

    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...report,
        coldRuns: report.coldRuns.map((coldRun, index) => (index === 19 ? { ...coldRun, run: 18 } : coldRun)),
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...report,
        coldRuns: report.coldRuns.map((coldRun, index) => (index === 19 ? { ...coldRun, run: 20 } : coldRun)),
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...report,
        coldRuns: report.coldRuns.map((coldRun, index) =>
          index === 0 ? { ...coldRun, browserVersion: "0.0.0.0" } : coldRun,
        ),
      }).success,
    ).toBe(false);

    for (const adapterPatch of [
      { browserArchitecture: "another-architecture" },
      { browserVendor: "another-vendor" },
      { browserVendor: undefined },
      { subgroupMaxSize: report.coldRuns[0]!.workerDeviceAdapter.adapter.subgroupMaxSize + 1 },
      { deviceType: "Cpu" },
    ]) {
      expect(
        engineWebgpuBenchmarkReportSchema.safeParse({
          ...report,
          coldRuns: report.coldRuns.map((coldRun, index) =>
            index === 0
              ? {
                  ...coldRun,
                  workerDeviceAdapter: {
                    ...coldRun.workerDeviceAdapter,
                    adapter: { ...coldRun.workerDeviceAdapter.adapter, ...adapterPatch },
                  },
                }
              : coldRun,
          ),
        }).success,
      ).toBe(false);
    }
  });

  it("executes the stress report v5 schema for 100/128 IDs and rejects oversized evidence", () => {
    const report = stressReportFixture(completeStressWorkloadFixtures());
    const parsed = engineWebgpuStressReportSchema.parse(report);
    expect(parsed.version).toBe(ENGINE_WEBGPU_STRESS_REPORT_VERSION);
    expect(parsed.workloads.map((workload) => workload.definition.id)).toEqual([
      "shape-primitives-100",
      "shape-primitives-1000",
      "animated-cubic-paths-100",
      "animated-cubic-paths-1000",
      "png-images-100",
      "png-images-1000",
    ]);
    expect(parsed.workloads.map((workload) => workload.interactionBounds.requestedEntityCount)).toEqual([
      100, 128, 100, 128, 100, 128,
    ]);

    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        version: ENGINE_WEBGPU_STRESS_REPORT_VERSION - 1,
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        contracts: { ...report.contracts, reportVersion: ENGINE_WEBGPU_STRESS_REPORT_VERSION - 1 },
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        baseFixtureIds: ["eng-v1-png-alpha-edge-camera", "eng-v1-shared-circle-opacity"],
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({ ...report, workloads: report.workloads.slice(0, -1) }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        workloads: [
          {
            ...stressWorkloadFixture(100, 100, 1_000, "png-images"),
            definition: { ...stressDefinitionFixture("png-images", 100), revision: "6".repeat(64) },
          },
        ],
      }).success,
    ).toBe(false);

    const oversizedWorkloads = completeStressWorkloadFixtures();
    oversizedWorkloads[1] = stressWorkloadFixture(1_000, 128, MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES + 1);
    expect(engineWebgpuStressReportSchema.safeParse(stressReportFixture(oversizedWorkloads)).success).toBe(false);

    const overRequestedWorkloads = completeStressWorkloadFixtures();
    overRequestedWorkloads[1] = stressWorkloadFixture(1_000, 129);
    expect(engineWebgpuStressReportSchema.safeParse(stressReportFixture(overRequestedWorkloads)).success).toBe(false);
  });

  it("accepts a complete stage report memory series", () => {
    const parsed = engineWebgpuStageTelemetryReportSchema.parse(stageReportFixture());
    expect(parsed.version).toBe(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION);
    expect(parsed.workloads[0]?.memory.samples).toHaveLength(ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT);
    expect(parsed.workloads[0]?.memory.peakRetainedBoundaryBytes).toBe(
      30_000_000 + ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT - 1,
    );
    const mismatchedContract = stageReportFixture();
    mismatchedContract.contracts.reportSchema = "poietra.engine-webgpu-stress-benchmark";
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(mismatchedContract).success).toBe(false);
  });

  it("rejects missing or non-contiguous stage memory samples", () => {
    const missing = stageReportFixture();
    missing.workloads[0]!.memory.samples.pop();
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(missing).success).toBe(false);

    const nonContiguous = stageReportFixture();
    nonContiguous.workloads[0]!.memory.samples[1]!.frameIndex = 7;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(nonContiguous).success).toBe(false);

    const forgedShortRun = stageReportFixture();
    forgedShortRun.configuration.telemetryFrames = 2;
    forgedShortRun.workloads[0]!.memory.samples.splice(2);
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(forgedShortRun).success).toBe(false);

    const forgedShortWarmup = stageReportFixture();
    forgedShortWarmup.configuration.warmupFrames = 1;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(forgedShortWarmup).success).toBe(false);
  });

  it("rejects inconsistent memory arithmetic and forged aggregate fields", () => {
    const inconsistentCurrent = stageReportFixture();
    inconsistentCurrent.workloads[0]!.memory.samples[0]!.memory.retainedBoundaryTotal.currentBytes += 1;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(inconsistentCurrent).success).toBe(false);

    const forgedPeak = stageReportFixture();
    forgedPeak.workloads[0]!.memory.peakRetainedBoundaryBytes = 1;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(forgedPeak).success).toBe(false);

    const forgedBudget = stageReportFixture();
    forgedBudget.workloads[0]!.memory.budget.met = false;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(forgedBudget).success).toBe(false);
  });

  it("rejects a regressing memory high-water sequence", () => {
    const report = stageReportFixture();
    report.workloads[0]!.memory.samples[1]!.memory.retainedBoundaryTotal.peakBytes = 29_000_000;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(report).success).toBe(false);

    const regressingMultisampleTarget = stageReportFixture();
    regressingMultisampleTarget.workloads[0]!.memory
      .samples[0]!.memory.logicalGpuBreakdown.multisampleColorTarget.peakBytes += 1;
    expect(engineWebgpuStageTelemetryReportSchema.safeParse(regressingMultisampleTarget).success).toBe(false);
  });

  it("pins the canonical viewport, retry, warmup, and stage-attribution configuration", () => {
    const benchmark = benchmarkReportFixture();
    expect(
      engineWebgpuBenchmarkReportSchema.safeParse({
        ...benchmark,
        configuration: { ...benchmark.configuration, viewport: { heightPx: 90, widthPx: 161 } },
      }).success,
    ).toBe(false);

    const stress = stressReportFixture(completeStressWorkloadFixtures());
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...stress,
        configuration: { ...stress.configuration, warmupFrames: 1 },
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...stress,
        configuration: { ...stress.configuration, viewport: { heightPx: 720, widthPx: 1_280 } },
      }).success,
    ).toBe(false);

    const stage = stageTelemetryReportFixture();
    expect(
      engineWebgpuStageTelemetryReportSchema.safeParse({
        ...stage,
        configuration: { ...stage.configuration, additivePhases: [...stage.configuration.additivePhases].reverse() },
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStageTelemetryReportSchema.safeParse({
        ...stage,
        configuration: { ...stage.configuration, retries: { projectRetries: 1, testRetry: 0 } },
      }).success,
    ).toBe(false);
  });

  it("requires the exact pinned workload order and available adapters in stress and stage reports", () => {
    const cases = [
      {
        name: "stress",
        report: stressReportFixture(completeStressWorkloadFixtures()),
        schema: engineWebgpuStressReportSchema,
      },
      { name: "stage", report: stageTelemetryReportFixture(), schema: engineWebgpuStageTelemetryReportSchema },
    ] as const;

    for (const reportCase of cases) {
      const { report, schema } = reportCase;
      expect(schema.safeParse(report).success, `${reportCase.name}: baseline`).toBe(true);
      const duplicate = report.workloads.map((workload, index) =>
        index === report.workloads.length - 1 ? { ...workload, definition: report.workloads[0]!.definition } : workload,
      );
      const missing = report.workloads.slice(0, -1);
      const staleRevision = report.workloads.map((workload, index) =>
        index === 0 ? { ...workload, definition: { ...workload.definition, revision: "f".repeat(64) } } : workload,
      );
      const reversed = [...report.workloads].reverse();
      const unavailable = report.workloads.map((workload, index) =>
        index === 0
          ? {
              ...workload,
              workerDeviceAdapter: { kind: "unavailable", reason: "adapter evidence was not collected" },
            }
          : workload,
      );

      for (const [name, workloads] of [
        ["duplicate", duplicate],
        ["missing", missing],
        ["reversed", reversed],
        ["stale revision", staleRevision],
        ["unavailable adapter", unavailable],
      ] as const) {
        expect(schema.safeParse({ ...report, workloads }).success, `${reportCase.name}: ${name}`).toBe(false);
      }
    }
  });

  it("rejects contradictory eligibility, evidence-level, and provenance claims", () => {
    const report = stressReportFixture(completeStressWorkloadFixtures());
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        decisionEligibility: { eligible: true, reasons: ["contradiction"] },
        evidenceLevel: "decision-candidate",
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        decisionEligibility: { eligible: false, reasons: [] },
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        decisionEligibility: { eligible: false, reasons: ["forged evidence-derived reason"] },
      }).success,
    ).toBe(false);
    expect(engineWebgpuStressReportSchema.safeParse({ ...report, evidenceLevel: "exploratory" }).success).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        provenance: { ...report.provenance, grade: "non-decision-grade-dirty-tree" },
      }).success,
    ).toBe(false);

    const dirtyCommitIdentity = { headCommit: COMMIT_A, treeState: "dirty", uncommittedPathCount: 1 } as const;
    const dirtyHost = { ...report.environment.host, commitIdentity: dirtyCommitIdentity };
    const dirtyDecision = fixtureDecisionFields({
      browserVersions: [report.environment.browserVersion],
      grade: "non-decision-grade-dirty-tree",
      host: dirtyHost,
      requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
      workerAdapters: report.workloads.map((workload) => workload.workerDeviceAdapter.evidence.adapter),
    });
    const consistentDirtyReport = {
      ...report,
      ...dirtyDecision,
      environment: {
        ...report.environment,
        host: dirtyHost,
      },
      provenance: { commitIdentity: dirtyCommitIdentity, grade: "non-decision-grade-dirty-tree" },
    };
    expect(engineWebgpuStressReportSchema.safeParse(consistentDirtyReport).success).toBe(true);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...consistentDirtyReport,
        decisionEligibility: { eligible: true, reasons: [] },
        evidenceLevel: "decision-candidate",
      }).success,
    ).toBe(false);
  });

  it("requires report contracts and host commit identity to match their enclosing provenance", () => {
    const report = stressReportFixture(completeStressWorkloadFixtures());
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        contracts: { ...report.contracts, reportSchema: ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA },
      }).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse({
        ...report,
        environment: {
          ...report.environment,
          host: {
            ...report.environment.host,
            commitIdentity: { ...FIXTURE_COMMIT_IDENTITY, headCommit: COMMIT_B },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("recomputes decision-driving benchmark evidence and rejects mixed runs", () => {
    const evidence = promotableEvidenceSetFixture();
    expect(verifyBenchmarkEvidenceSetV1(evidence).identity).toMatchObject({
      benchmarkRunId: BENCHMARK_RUN_ID,
      commit: COMMIT_A,
      profileId: REFERENCE_HOST.profile.id,
      runBuildPath: "fixture.wasm",
    });

    const wrongSummary = structuredClone(evidence);
    wrongSummary.benchmark.metrics.warmFrame = { ...wrongSummary.benchmark.metrics.warmFrame, p95Ms: 99 };
    expect(() => verifyBenchmarkEvidenceSetV1(wrongSummary)).toThrow(/benchmark.metrics.warmFrame/);

    const missingSamples = structuredClone(evidence);
    missingSamples.stress.workloads[0]!.randomSeekAck.samplesMs.pop();
    expect(() => verifyBenchmarkEvidenceSetV1(missingSamples)).toThrow(/exactly 300 timing samples/);

    const forgedBudget = structuredClone(evidence);
    forgedBudget.stress.workloads[0]!.budgets.randomSeekAcknowledgement.met = false;
    expect(() => verifyBenchmarkEvidenceSetV1(forgedBudget)).toThrow(/budgets/);

    const forgedCache = structuredClone(evidence);
    forgedCache.stageTelemetry.workloads[0]!.caches.summary.pipeline = { hit: 300 };
    expect(() => verifyBenchmarkEvidenceSetV1(forgedCache)).toThrow(/caches.summary.pipeline/);

    const forgedInteraction = structuredClone(evidence);
    forgedInteraction.stress.workloads[0]!.interactionBounds.responses.available = 299;
    expect(() => verifyBenchmarkEvidenceSetV1(forgedInteraction)).toThrow(/interactionBounds.responses/);

    const mixedSnapshot = structuredClone(evidence);
    mixedSnapshot.stageTelemetry.workloads[0]!.snapshotSha256 = "f".repeat(64);
    expect(() => verifyBenchmarkEvidenceSetV1(mixedSnapshot)).toThrow(/cross-report workload snapshot/);

    const mixedRun = structuredClone(evidence);
    mixedRun.stageTelemetry.benchmarkRunId = "22222222-2222-4222-8222-222222222222";
    expect(() => verifyBenchmarkEvidenceSetV1(mixedRun)).toThrow(/cross-report benchmark run id/);
  });

  it("rejects forged stage frame correlation, cache ordering, and required phase availability", () => {
    const nonContiguousCorrelation = promotableEvidenceSetFixture();
    nonContiguousCorrelation.stageTelemetry.workloads[0]!.correlation[1]!.frameIndex = 7;
    expect(() => verifyBenchmarkEvidenceSetV1(nonContiguousCorrelation)).toThrow(/correlation frameIndex/);

    const duplicateRequest = promotableEvidenceSetFixture();
    duplicateRequest.stageTelemetry.workloads[0]!.correlation[1]!.requestId = 1;
    duplicateRequest.stageTelemetry.workloads[0]!.correlation[1]!.packetId = "canvas:1";
    expect(() => verifyBenchmarkEvidenceSetV1(duplicateRequest)).toThrow(/requestId must be unique/);

    const mismatchedPacket = promotableEvidenceSetFixture();
    mismatchedPacket.stageTelemetry.workloads[0]!.correlation[0]!.packetId = "canvas:999";
    expect(() => verifyBenchmarkEvidenceSetV1(mismatchedPacket)).toThrow(/packetId does not match/);

    const mismatchedSample = promotableEvidenceSetFixture();
    mismatchedSample.stageTelemetry.workloads[0]!.correlation[0]!.sampleTime = 0.5;
    expect(() => verifyBenchmarkEvidenceSetV1(mismatchedSample)).toThrow(/sampleTime does not match/);

    const nonContiguousCache = promotableEvidenceSetFixture();
    nonContiguousCache.stageTelemetry.workloads[0]!.caches.perFrame[1]!.frameIndex = 7;
    expect(() => verifyBenchmarkEvidenceSetV1(nonContiguousCache)).toThrow(/caches frameIndex/);

    const invalidResidual = promotableEvidenceSetFixture();
    invalidResidual.stageTelemetry.workloads[0]!.correlation[0]!.residualMs = -3;
    invalidResidual.stageTelemetry.workloads[0]!.residual = summarizeSignedTiming(
      invalidResidual.stageTelemetry.workloads[0]!.correlation.map(({ residualMs }) => residualMs),
      300,
    );
    expect(() => verifyBenchmarkEvidenceSetV1(invalidResidual)).toThrow(/residualMs violates/);

    const observedGpuExecution = promotableEvidenceSetFixture();
    observedGpuExecution.stageTelemetry.workloads[0]!.phases.gpuExecution = structuredClone(
      observedGpuExecution.stageTelemetry.workloads[0]!.phases.evaluate,
    );
    expect(() => verifyBenchmarkEvidenceSetV1(observedGpuExecution)).toThrow(/required-unavailable availability/);

    const skippedEvaluate = promotableEvidenceSetFixture();
    const evaluate = skippedEvaluate.stageTelemetry.workloads[0]!.phases.evaluate;
    evaluate.availability = { measured: 299, skipped: 1, unavailable: 0 };
    evaluate.samplesMs.pop();
    evaluate.summary = null;
    expect(() => verifyBenchmarkEvidenceSetV1(skippedEvaluate)).toThrow(/required-measured availability/);

    const unavailableAdditivePhase = promotableEvidenceSetFixture();
    unavailableAdditivePhase.stageTelemetry.workloads[0]!.phases.tessellate = {
      availability: { measured: 0, skipped: 299, unavailable: 1 },
      samplesMs: [],
      summary: null,
      unavailableReasons: ["forged missing attribution"],
    };
    expect(() => verifyBenchmarkEvidenceSetV1(unavailableAdditivePhase)).toThrow(
      /additive attribution must never be unavailable/,
    );
  });

  it("promotes exactly one verified report set without overwriting evidence", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "poietra-benchmark-evidence-"));
    try {
      const evidence = promotableEvidenceSetFixture();
      const benchmarkPath = join(temporary, "source-benchmark.json");
      const stressPath = join(temporary, "source-stress.json");
      const stageTelemetryPath = join(temporary, "source-stage.json");
      writeFileSync(benchmarkPath, `${JSON.stringify(evidence.benchmark)}\n`);
      writeFileSync(stressPath, `${JSON.stringify(evidence.stress)}\n`);
      writeFileSync(stageTelemetryPath, `${JSON.stringify(evidence.stageTelemetry)}\n`);
      const input = {
        benchmarkPath,
        outputRoot: join(temporary, "checked-in-root"),
        stageTelemetryPath,
        stressPath,
      };
      const promoted = await promoteBenchmarkEvidenceSetV1(input);
      expect(promoted.manifest).toMatchObject({
        benchmarkRunId: BENCHMARK_RUN_ID,
        commit: COMMIT_A,
        profile: { id: REFERENCE_HOST.profile.id },
        runBuildPath: "fixture.wasm",
        schema: "poietra.engine-webgpu-evidence-set",
        version: 1,
      });
      const promotedBenchmark = readFileSync(join(promoted.destination, "benchmark.json.gz"));
      expect(promotedBenchmark[9]).toBe(255);
      expect(gunzipSync(promotedBenchmark)).toEqual(readFileSync(benchmarkPath));
      expect(JSON.parse(readFileSync(join(promoted.destination, "manifest.json"), "utf8"))).toEqual(promoted.manifest);
      expect((await verifyPromotedBenchmarkEvidenceSetV1(promoted.destination)).verified.identity.commit).toBe(
        COMMIT_A,
      );
      await expect(promoteBenchmarkEvidenceSetV1(input)).rejects.toThrow(/already exists/);
      writeFileSync(join(promoted.destination, "stress.json.gz"), "{}\n");
      await expect(verifyPromotedBenchmarkEvidenceSetV1(promoted.destination)).rejects.toThrow(/manifest SHA-256/);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("binds the rolling checked-in evidence directory to its manifest identity", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "poietra-benchmark-evidence-layout-"));
    try {
      const evidence = promotableEvidenceSetFixture();
      const benchmarkPath = join(temporary, "benchmark.json");
      const stressPath = join(temporary, "stress.json");
      const stageTelemetryPath = join(temporary, "stage.json");
      const outputRoot = join(temporary, "checked-in-root");
      writeFileSync(benchmarkPath, `${JSON.stringify(evidence.benchmark)}\n`);
      writeFileSync(stressPath, `${JSON.stringify(evidence.stress)}\n`);
      writeFileSync(stageTelemetryPath, `${JSON.stringify(evidence.stageTelemetry)}\n`);
      const promoted = await promoteBenchmarkEvidenceSetV1({
        benchmarkPath,
        outputRoot,
        stageTelemetryPath,
        stressPath,
      });
      await expect(verifyCheckedInBenchmarkEvidenceV1(outputRoot)).resolves.toEqual([promoted.destination]);

      const profileRoot = join(outputRoot, REFERENCE_HOST.profile.id);
      const wrongProfileRoot = join(outputRoot, "wrong-profile");
      renameSync(profileRoot, wrongProfileRoot);
      await expect(verifyCheckedInBenchmarkEvidenceV1(outputRoot)).rejects.toThrow(/evidence profile directory/);
      renameSync(wrongProfileRoot, profileRoot);

      const commitRoot = join(profileRoot, COMMIT_A);
      const wrongCommitRoot = join(profileRoot, COMMIT_B);
      renameSync(commitRoot, wrongCommitRoot);
      await expect(verifyCheckedInBenchmarkEvidenceV1(outputRoot)).rejects.toThrow(/evidence commit directory/);
      renameSync(wrongCommitRoot, commitRoot);

      mkdirSync(join(outputRoot, "second-profile", COMMIT_B), { recursive: true });
      await expect(verifyCheckedInBenchmarkEvidenceV1(outputRoot)).rejects.toThrow(/exactly one current evidence set/);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("revalidates every checked-in benchmark evidence set in the normal unit lane", async () => {
    const verified = await verifyCheckedInBenchmarkEvidenceV1();
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatch(/^docs\/evidence\/engine-webgpu\//);
  });
});
