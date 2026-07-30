import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs module with a sibling .d.ts; vitest resolves it at runtime.
import { makeBenchmarkBuildManifest } from "../scripts/benchmark-build-manifest.mjs";
import { adapterEvidenceFixtureV1, measuredTelemetryFixtureV1 } from "../src/engine/canvas-telemetry-test-fixtures";
import {
  type CanvasAdapterEvidenceV1,
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
      source: "windows-system-power-status+powercfg",
      status: "available",
    },
    windowsBuild: { ...profile.windowsBuild, source: "windows-cim", status: "available" },
  };
}

function referenceWorkerAdapter(referenceHost: PinnedReferenceHostProfile = REFERENCE_HOST): WorkerAdapterIdentity {
  return {
    ...referenceHost.profile.selectedWorkerAdapter,
    driver: "",
    driverInfo: "",
    name: "NVIDIA reference adapter",
    subgroupMaxSize: 128,
    subgroupMinSize: 4,
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
      driver: "SwiftShader",
      driverInfo: "software rasterizer",
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
  architecture: "reference-hardware",
  description: "reference adapter",
  device: REFERENCE_HOST.profile.selectedWorkerAdapter.deviceId.toString(16),
  kind: "available",
  vendor: REFERENCE_HOST.profile.selectedWorkerAdapter.vendorId.toString(16),
} as const;

function reportEnvelopeFixture(reportSchema: string, reportVersion: number) {
  return {
    contracts: {
      canvasWorkerProtocolVersion: 1,
      engineContractVersion: 1,
      reportSchema,
      reportVersion,
      telemetryAbiVersion: 3,
    },
    decisionEligibility: { eligible: true, reasons: [] },
    environment: {
      browserLaunch: { args: [], channel: "msedge" },
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
    configuration: { lane: "production-build-static-server", retries: { projectRetries: 0, testRetry: 0 } },
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
      lane: "production-build-static-server",
      retries: { projectRetries: 0, testRetry: 0 },
      telemetryFrames: ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT,
      warmupFrames: ENGINE_STAGE_TELEMETRY_WARMUP_COUNT,
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

describe("benchmark provenance", () => {
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
      browserVersions: ["fixture-browser"],
      grade: "non-decision-grade-dirty-tree",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: "swiftshader",
      referenceHost: REFERENCE_HOST,
      workerAdapters: [softwareAdapter],
    });
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join("\n")).toMatch(/dirty/);
    expect(assessment.reasons.join("\n")).toMatch(/software adapter/);
    expect(assessment.reasons.join("\n")).toMatch(/swiftshader/);
    expect(assessment.reasons.join("\n")).toMatch(/host platform is linux/);

    const linuxHardware = assessDecisionEligibility({
      browserChannel: "chromium",
      browserVersions: [REFERENCE_HOST.profile.browser.version],
      grade: "clean-commit",
      host: collectHostEnvironment(),
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

    const changed = assessDecisionEligibility({
      browserChannel: "msedge",
      browserVersions: [REFERENCE_HOST.profile.browser.version, "0.0.0.0"],
      grade: "clean-commit",
      host: referenceHostEnvironment(),
      pageAdapterHintArchitecture: null,
      referenceHost: REFERENCE_HOST,
      workerAdapters: [hardwareAdapter, { ...hardwareAdapter, name: "another physical adapter" }],
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
    expect(invocation.env).toMatchObject({
      Path: String.raw`C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`,
      PSModulePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
    });
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).not.toMatch(/\$env:|GetEnvironmentVariable|&\s+powercfg\.exe/u);
    expect(WINDOWS_HOST_EVIDENCE_SCRIPT).toContain(String.raw`C:\Windows\System32\powercfg.exe`);
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
  });

  it("verifies the checked-in profile bytes against the separate reviewed hash", () => {
    expect(readPinnedReferenceHostProfile()).toEqual(REFERENCE_HOST);
    expect(() => readPinnedReferenceHostProfile(Buffer.from("{}"), "0".repeat(64))).toThrow(/hashes to/);
  });

  it("requires the selected Worker adapter to belong to the pinned GPU-controller inventory", () => {
    expect(referenceHostProfileSchema.safeParse(REFERENCE_HOST.profile).success).toBe(true);
    expect(
      referenceHostProfileSchema.safeParse({
        ...REFERENCE_HOST.profile,
        selectedWorkerAdapter: {
          ...REFERENCE_HOST.profile.selectedWorkerAdapter,
          deviceId: 1,
          vendorId: 1,
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
          browserLaunch: { args: readonly string[]; channel: string };
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
          browserLaunch: { args: [], channel: "chromium" },
        },
      };
      expect(reportCase.schema.safeParse(linux).success, `${reportCase.name}: Linux host`).toBe(false);
      expect(reportCase.schema.safeParse(chromium).success, `${reportCase.name}: Chromium channel`).toBe(false);
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

  it("requires benchmark v3 cold-run indexes, browser versions, and complete adapter identity to agree", () => {
    const report = benchmarkReportFixture();
    expect(engineWebgpuBenchmarkReportSchema.safeParse(report).success).toBe(true);

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
      { deviceId: report.coldRuns[0]!.workerDeviceAdapter.adapter.deviceId + 1 },
      { driver: "different-driver" },
      { deviceType: "IntegratedGpu" },
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

  it("executes the stress report schema for canonical vector and PNG definitions", () => {
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
    expect(
      engineWebgpuStressReportSchema.safeParse(stressReportFixture(oversizedWorkloads)).success,
    ).toBe(false);

    const overRequestedWorkloads = completeStressWorkloadFixtures();
    overRequestedWorkloads[1] = stressWorkloadFixture(1_000, 129);
    expect(
      engineWebgpuStressReportSchema.safeParse(stressReportFixture(overRequestedWorkloads)).success,
    ).toBe(false);
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
});
