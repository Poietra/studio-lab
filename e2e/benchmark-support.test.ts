import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs module with a sibling .d.ts; vitest resolves it at runtime.
import { makeBenchmarkBuildManifest } from "../scripts/benchmark-build-manifest.mjs";
import { adapterEvidenceFixtureV1, measuredTelemetryFixtureV1 } from "../src/engine/canvas-telemetry-test-fixtures";
import { MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES } from "../src/engine/canvas-worker-protocol";
import {
  assessDecisionEligibility,
  collectCommitIdentity,
  collectHostEnvironment,
  requireStableCommitIdentity,
  resolveBenchmarkProvenance,
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
  engineWebgpuStageTelemetryReportSchema,
  engineWebgpuStressReportSchema,
} from "./benchmark-report-schemas";
import {
  STAGE_TELEMETRY_COUNT_NAMES,
  STAGE_TELEMETRY_PHASE_NAMES,
  summarizeByteLengths,
  summarizeSignedTiming,
  summarizeTiming,
} from "./engine-stress-workloads";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

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

function stressWorkloadFixture(sceneEntityCount: 100 | 1_000, requestedEntityCount: number, responseBytes = 1_000) {
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
    definition: {
      entityCount: sceneEntityCount,
      id: `shape-primitives-${sceneEntityCount}`,
      profile: "shape-primitives",
      revision: "1".repeat(64),
    },
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
    workerDeviceAdapter: { evidence: adapterEvidenceFixtureV1(), kind: "available" },
  };
}

function stressReportFixture(workloads: readonly unknown[]) {
  const unavailable = { reason: "not observable in this harness", status: "unavailable" } as const;
  const commitIdentity = { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 } as const;
  return {
    baseFixtureId: "eng-v1-shared-circle-opacity",
    capturedAt: "2026-07-28T00:00:00.000Z",
    configuration: { lane: "production-build-static-server", retries: { projectRetries: 0, testRetry: 0 } },
    contracts: {
      canvasWorkerProtocolVersion: 1,
      engineContractVersion: 1,
      reportSchema: "poietra.engine-webgpu-stress-benchmark",
      reportVersion: 3,
      telemetryAbiVersion: 3,
    },
    decisionEligibility: { eligible: false, reasons: ["reference host is not pinned"] },
    environment: {
      browserLaunch: { args: [], channel: "chromium" },
      host: {
        commitIdentity,
        cpu: { logicalCores: 1, model: "fixture CPU" },
        gpuDriver: unavailable,
        osKernel: { platform: "linux", release: "fixture", version: "fixture" },
        powerMode: unavailable,
      },
      wasm: { byteLength: 1, gzipByteLength: 1, path: "fixture.wasm", sha256: "3".repeat(64) },
    },
    evidenceLevel: "exploratory",
    provenance: { commitIdentity, grade: "clean-commit" },
    provenanceStableThroughRun: true,
    schema: "poietra.engine-webgpu-stress-benchmark",
    version: 3,
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

function stageReportFixture() {
  const unavailable = { reason: "not observable in this harness", status: "unavailable" } as const;
  const commitIdentity = { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 } as const;
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
  const workload = {
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
    definition: {
      entityCount: 100,
      id: "shape-primitives-100",
      profile: "shape-primitives",
      revision: "1".repeat(64),
    },
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
    workerDeviceAdapter: { evidence: adapterEvidenceFixtureV1(), kind: "available" },
  };
  return {
    baseFixtureId: "eng-v1-shared-circle-opacity",
    capturedAt: "2026-07-28T00:00:00.000Z",
    configuration: {
      lane: "production-build-static-server",
      retries: { projectRetries: 0, testRetry: 0 },
      telemetryFrames: frameCount,
      warmupFrames: ENGINE_STAGE_TELEMETRY_WARMUP_COUNT,
    },
    contracts: {
      canvasWorkerProtocolVersion: 1,
      engineContractVersion: 1,
      reportSchema: "poietra.engine-webgpu-stage-telemetry",
      reportVersion: 2,
      telemetryAbiVersion: 3,
    },
    decisionEligibility: { eligible: false, reasons: ["reference host is not pinned"] },
    environment: {
      browserLaunch: { args: [], channel: "chromium" },
      host: {
        commitIdentity,
        cpu: { logicalCores: 1, model: "fixture CPU" },
        gpuDriver: unavailable,
        osKernel: { platform: "linux", release: "fixture", version: "fixture" },
        powerMode: unavailable,
      },
      wasm: { byteLength: 1, gzipByteLength: 1, path: "fixture.wasm", sha256: "3".repeat(64) },
    },
    evidenceLevel: "exploratory",
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
    provenance: { commitIdentity, grade: "clean-commit" },
    provenanceStableThroughRun: true,
    schema: "poietra.engine-webgpu-stage-telemetry",
    version: 2,
    workloads: [workload],
  };
}

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
  const hardwareAdapter = { backend: "BrowserWebGpu", deviceType: "DiscreteGpu", name: "Radeon" };

  it("flags software adapters, missing evidence, and unpinned reference profiles machine-readably", () => {
    const assessment = assessDecisionEligibility({
      grade: "non-decision-grade-dirty-tree",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: "swiftshader",
      workerAdapters: [{ backend: "BrowserWebGpu", deviceType: "Cpu", name: "" }],
    });
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join("\n")).toMatch(/dirty/);
    expect(assessment.reasons.join("\n")).toMatch(/software adapter/);
    expect(assessment.reasons.join("\n")).toMatch(/swiftshader/);
    expect(assessment.reasons.join("\n")).toMatch(/reference adapter\/host\/driver\/power-mode/);

    // Even a clean hardware run stays ineligible until a reference profile is
    // pinned; the reasons say exactly why.
    const cleanest = assessDecisionEligibility({
      grade: "clean-commit",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: null,
      workerAdapters: [hardwareAdapter],
    });
    expect(cleanest.eligible).toBe(false);
    expect(cleanest.reasons.every((reason) => reason.length > 0)).toBe(true);
  });

  it("requires at least one worker adapter evidence entry", () => {
    const assessment = assessDecisionEligibility({
      grade: "clean-commit",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: null,
      workerAdapters: [],
    });
    expect(assessment.reasons.join("\n")).toMatch(/no Worker device adapter evidence/);
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

  it("executes the stress report v3 schema for 100/128 IDs and rejects oversized evidence", () => {
    const report = stressReportFixture([
      stressWorkloadFixture(100, 100),
      stressWorkloadFixture(1_000, 128, MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES),
    ]);
    const parsed = engineWebgpuStressReportSchema.parse(report);
    expect(parsed.version).toBe(3);
    expect(parsed.workloads.map((workload) => workload.interactionBounds.requestedEntityCount)).toEqual([100, 128]);

    expect(engineWebgpuStressReportSchema.safeParse({ ...report, version: 2 }).success).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse(
        stressReportFixture([stressWorkloadFixture(1_000, 128, MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES + 1)]),
      ).success,
    ).toBe(false);
    expect(
      engineWebgpuStressReportSchema.safeParse(stressReportFixture([stressWorkloadFixture(1_000, 129)])).success,
    ).toBe(false);
  });

  it("accepts a complete stage report v2 memory series", () => {
    const parsed = engineWebgpuStageTelemetryReportSchema.parse(stageReportFixture());
    expect(parsed.version).toBe(2);
    expect(parsed.workloads[0]?.memory.samples).toHaveLength(ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT);
    expect(parsed.workloads[0]?.memory.peakRetainedBoundaryBytes).toBe(
      30_000_000 + ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT - 1,
    );
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
});
