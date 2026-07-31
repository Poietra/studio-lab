import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import { CANVAS_TELEMETRY_ADDITIVE_PHASES } from "../src/engine/canvas-worker-protocol";
import {
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
import { summarizeByteLengths, summarizeSignedTiming, summarizeTiming } from "./engine-stress-workloads";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function deterministicGzip(bytes: Uint8Array): Uint8Array {
  const compressed = new Uint8Array(gzipSync(bytes, { level: 9 }));
  // zlib writes a platform-specific gzip OS byte (Windows=10, Unix=3).
  // Normalize advisory header fields so promotion is byte-identical across hosts.
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return compressed;
}

const fixedBudget = (limitMs: number) =>
  z.strictObject({
    limitMs: z.literal(limitMs),
    met: z.boolean(),
  });

const benchmarkDecisionFieldsSchema = z.looseObject({
  budgets: z.strictObject({
    coldClientImportToSceneReady: fixedBudget(1_000),
    scrubAck: fixedBudget(50),
    warmFrame: fixedBudget(16.7),
  }),
});

const requiredMeasuredStagePhases = [
  "evaluate",
  "prepare",
  "surfaceAcquire",
  "commandEncodeTotal",
  "drawRecord",
  "submit",
  "present",
  "gpuErrorScopeResolution",
  "gpuQueueSubmittedWorkDone",
] as const;

const requiredUnavailableStagePhases = ["gpuExecution", "browserComposite"] as const;

const evidenceSetManifestSchema = z.strictObject({
  benchmarkRunId: z.string().uuid(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  profile: z.strictObject({ id: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  reports: z.tuple([
    z.strictObject({
      filename: z.literal("benchmark.json.gz"),
      schema: z.literal(ENGINE_WEBGPU_BENCHMARK_REPORT_SCHEMA),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      version: z.literal(ENGINE_WEBGPU_BENCHMARK_REPORT_VERSION),
    }),
    z.strictObject({
      filename: z.literal("stress.json.gz"),
      schema: z.literal(ENGINE_WEBGPU_STRESS_REPORT_SCHEMA),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      version: z.literal(ENGINE_WEBGPU_STRESS_REPORT_VERSION),
    }),
    z.strictObject({
      filename: z.literal("stage-telemetry.json.gz"),
      schema: z.literal(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      version: z.literal(ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION),
    }),
  ]),
  runBuildPath: z.string().min(1),
  schema: z.literal("poietra.engine-webgpu-evidence-set"),
  version: z.literal(1),
  wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

type EvidenceSetInput = Readonly<{
  benchmark: unknown;
  stageTelemetry: unknown;
  stress: unknown;
}>;

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} is not consistent with its raw evidence`);
  }
}

function requirePromotableReport(
  report: Readonly<{
    decisionEligibility: Readonly<{ eligible: boolean; reasons: readonly string[] }>;
    evidenceLevel: string;
    provenance: Readonly<{
      commitIdentity: Readonly<{ treeState: string; uncommittedPathCount: number }>;
      grade: string;
    }>;
  }>,
  label: string,
): void {
  if (
    report.evidenceLevel !== "decision-candidate" ||
    !report.decisionEligibility.eligible ||
    report.decisionEligibility.reasons.length !== 0 ||
    report.provenance.grade !== "clean-commit" ||
    report.provenance.commitIdentity.treeState !== "clean" ||
    report.provenance.commitIdentity.uncommittedPathCount !== 0
  ) {
    throw new Error(`${label} is not decision-candidate evidence from a clean commit`);
  }
}

function verifyBenchmarkReport(raw: unknown) {
  const report = engineWebgpuBenchmarkReportSchema.parse(raw);
  const decisionFields = benchmarkDecisionFieldsSchema.parse(report);
  const expectedCounts = {
    coldBrowserLaunch: 20,
    coldClientImportToSceneReady: 20,
    coldPageLoad: 20,
    scrubAck: 300,
    warmFrame: 300,
  } as const;
  for (const [name, expectedCount] of Object.entries(expectedCounts) as readonly [
    keyof typeof expectedCounts,
    number,
  ][]) {
    const summary = report.metrics[name];
    requireEqual(summary, summarizeTiming(summary.samplesMs, expectedCount), `benchmark.metrics.${name}`);
  }
  requireEqual(
    report.metrics.coldClientImportToSceneReady.samplesMs,
    report.coldRuns.map(({ sceneReadyMs }) => sceneReadyMs),
    "benchmark cold scene-ready samples",
  );
  const expectedBudgetState = {
    coldClientImportToSceneReady: {
      limitMs: 1_000,
      met: report.metrics.coldClientImportToSceneReady.p95Ms <= 1_000,
    },
    scrubAck: { limitMs: 50, met: report.metrics.scrubAck.p95Ms <= 50 },
    warmFrame: { limitMs: 16.7, met: report.metrics.warmFrame.p95Ms <= 16.7 },
  };
  requireEqual(decisionFields.budgets, expectedBudgetState, "benchmark.budgets");
  requirePromotableReport(report, "benchmark report");
  return report;
}

function verifyStressReport(raw: unknown) {
  const report = engineWebgpuStressReportSchema.parse(raw);
  const configuration = report.configuration;
  for (const [index, workload] of report.workloads.entries()) {
    const prefix = `stress.workloads[${index}]`;
    const summaries = [
      ["interactionBounds.acknowledgement", workload.interactionBounds.acknowledgement, configuration.measuredFrames],
      ["randomSeekAck", workload.randomSeekAck, configuration.measuredFrames],
      ["pacedPresentation.acknowledgement", workload.pacedPresentation.acknowledgement, configuration.pacedFrames],
      [
        "pacedPresentation.presentationAckInterval",
        workload.pacedPresentation.presentationAckInterval,
        configuration.pacedFrames - 1,
      ],
    ] as const;
    for (const [name, summary, expectedCount] of summaries) {
      requireEqual(summary, summarizeTiming(summary.samplesMs, expectedCount), `${prefix}.${name}`);
    }
    const byteSummary = workload.interactionBounds.logicalResponseJsonBytes;
    requireEqual(
      byteSummary,
      summarizeByteLengths(byteSummary.samplesBytes, configuration.measuredFrames),
      `${prefix}.interactionBounds.logicalResponseJsonBytes`,
    );
    const expectedRequestedEntities = Math.min(workload.definition.entityCount, 128);
    const expectedEntries = expectedRequestedEntities * configuration.measuredFrames;
    requireEqual(
      workload.interactionBounds.sceneEntityCount,
      workload.definition.entityCount,
      `${prefix}.interactionBounds.sceneEntityCount`,
    );
    requireEqual(
      workload.interactionBounds.requestedEntityCount,
      expectedRequestedEntities,
      `${prefix}.interactionBounds.requestedEntityCount`,
    );
    requireEqual(
      workload.interactionBounds.responses,
      { available: configuration.measuredFrames, missing: 0, unavailable: 0 },
      `${prefix}.interactionBounds.responses`,
    );
    requireEqual(
      workload.interactionBounds.entries,
      {
        observedTotal: expectedEntries,
        statuses: { empty: 0, inactive: 0, present: expectedEntries, unavailable: 0 },
      },
      `${prefix}.interactionBounds.entries`,
    );
    requireEqual(
      workload.budgets,
      {
        interactionBoundsAcknowledgement: {
          limitMs: 33.3,
          met: workload.interactionBounds.acknowledgement.p95Ms <= 33.3,
        },
        randomSeekAcknowledgement: { limitMs: 50, met: workload.randomSeekAck.p95Ms <= 50 },
        stressRenderAcknowledgement: { limitMs: 33.3, met: workload.randomSeekAck.p95Ms <= 33.3 },
      },
      `${prefix}.budgets`,
    );
    const intervals = workload.pacedPresentation.presentationAckInterval.samplesMs;
    requireEqual(
      workload.pacedPresentation.effectivePresentationAckFps,
      1_000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length),
      `${prefix}.pacedPresentation.effectivePresentationAckFps`,
    );
    requireEqual(
      workload.pacedPresentation.longPresentationAckIntervalsOver25Ms,
      intervals.filter((value) => value > 25).length,
      `${prefix}.pacedPresentation.longPresentationAckIntervalsOver25Ms`,
    );
    requireEqual(
      workload.pacedPresentation.estimatedMissed60HzSlotsProxy,
      intervals.reduce((total, value) => total + Math.max(0, Math.round(value / (1_000 / 60)) - 1), 0),
      `${prefix}.pacedPresentation.estimatedMissed60HzSlotsProxy`,
    );
    requireEqual(workload.continuousScrub.requestedRequests, configuration.scrubFrames, `${prefix}.scrub count`);
    requireEqual(
      workload.continuousScrub.fulfilledRequests + workload.continuousScrub.supersededRequests,
      configuration.scrubFrames,
      `${prefix}.scrub outcomes`,
    );
    if (
      workload.continuousScrub.otherErrors.length !== 0 ||
      workload.continuousScrub.latestFulfilledSampleTime !== workload.continuousScrub.finalSampleTime
    ) {
      throw new Error(`${prefix}.continuousScrub is incomplete`);
    }
  }
  requirePromotableReport(report, "stress report");
  return report;
}

function verifyStageTelemetryReport(raw: unknown) {
  const report = engineWebgpuStageTelemetryReportSchema.parse(raw);
  const configuration = report.configuration;
  for (const [index, workload] of report.workloads.entries()) {
    const prefix = `stageTelemetry.workloads[${index}]`;
    if (workload.attributionViolations.length !== 0 || workload.correlation.length !== configuration.telemetryFrames) {
      throw new Error(`${prefix} has incomplete or invalid frame attribution`);
    }
    requireEqual(
      workload.telemetryAck,
      summarizeTiming(
        workload.correlation.map(({ ackMs }) => ackMs),
        configuration.telemetryFrames,
      ),
      `${prefix}.telemetryAck`,
    );
    requireEqual(
      workload.totalMsSummary,
      summarizeTiming(
        workload.correlation.map(({ totalMs }) => totalMs),
        configuration.telemetryFrames,
      ),
      `${prefix}.totalMsSummary`,
    );
    requireEqual(
      workload.residual,
      summarizeSignedTiming(
        workload.correlation.map(({ residualMs }) => residualMs),
        configuration.telemetryFrames,
      ),
      `${prefix}.residual`,
    );
    const requestIds = new Set<number>();
    let previousRequestId = 0;
    for (const [frameIndex, frame] of workload.correlation.entries()) {
      if (frame.frameIndex !== frameIndex) {
        throw new Error(`${prefix}.correlation frameIndex must be contiguous and ordered`);
      }
      if (requestIds.has(frame.requestId) || frame.requestId <= previousRequestId) {
        throw new Error(`${prefix}.correlation requestId must be unique and strictly increasing`);
      }
      if (frame.packetId !== `canvas:${frame.requestId}`) {
        throw new Error(`${prefix}.correlation packetId does not match requestId`);
      }
      if (frame.sampleTime !== frame.requestedSampleTime) {
        throw new Error(`${prefix}.correlation sampleTime does not match the requested sample time`);
      }
      if (frame.residualMs < -configuration.attributionToleranceMs || frame.residualMs > frame.totalMs) {
        throw new Error(`${prefix}.correlation residualMs violates the attribution bounds`);
      }
      requestIds.add(frame.requestId);
      previousRequestId = frame.requestId;
    }
    for (const [name, counts] of Object.entries(workload.counts)) {
      if (counts.perFrame.length !== configuration.telemetryFrames) {
        throw new Error(`${prefix}.counts.${name} has an invalid sample count`);
      }
      requireEqual(counts.minimum, Math.min(...counts.perFrame), `${prefix}.counts.${name}.minimum`);
      requireEqual(counts.maximum, Math.max(...counts.perFrame), `${prefix}.counts.${name}.maximum`);
    }
    if (workload.caches.perFrame.length !== configuration.telemetryFrames) {
      throw new Error(`${prefix}.caches has an invalid sample count`);
    }
    for (const [frameIndex, frame] of workload.caches.perFrame.entries()) {
      if (frame.frameIndex !== frameIndex) {
        throw new Error(`${prefix}.caches frameIndex must be contiguous and ordered`);
      }
    }
    for (const name of [
      "imageSamplerBinding",
      "imageTexture",
      "pipeline",
      "preparedGeometry",
      "surfaceConfiguration",
    ] as const) {
      const recomputed: Record<string, number> = {};
      for (const frame of workload.caches.perFrame) {
        recomputed[frame[name]] = (recomputed[frame[name]] ?? 0) + 1;
      }
      requireEqual(workload.caches.summary[name], recomputed, `${prefix}.caches.summary.${name}`);
    }
    for (const [name, phase] of Object.entries(workload.phases)) {
      const observedFrames = phase.availability.measured + phase.availability.skipped + phase.availability.unavailable;
      requireEqual(observedFrames, configuration.telemetryFrames, `${prefix}.phases.${name}.availability`);
      requireEqual(phase.samplesMs.length, phase.availability.measured, `${prefix}.phases.${name}.samplesMs`);
      const expectedSummary =
        phase.availability.measured === configuration.telemetryFrames
          ? summarizeTiming(phase.samplesMs, configuration.telemetryFrames)
          : null;
      requireEqual(phase.summary, expectedSummary, `${prefix}.phases.${name}.summary`);
      if (phase.availability.unavailable === 0) {
        requireEqual(phase.unavailableReasons, [], `${prefix}.phases.${name}.unavailableReasons`);
      } else if (phase.unavailableReasons.length === 0) {
        throw new Error(`${prefix}.phases.${name} must record why samples are unavailable`);
      }
    }
    for (const name of CANVAS_TELEMETRY_ADDITIVE_PHASES) {
      const phase = workload.phases[name];
      if (phase.availability.unavailable !== 0) {
        throw new Error(`${prefix}.phases.${name} additive attribution must never be unavailable`);
      }
    }
    for (const name of requiredMeasuredStagePhases) {
      const phase = workload.phases[name];
      requireEqual(
        phase.availability,
        { measured: configuration.telemetryFrames, skipped: 0, unavailable: 0 },
        `${prefix}.phases.${name}.required-measured availability`,
      );
      requireEqual(phase.unavailableReasons, [], `${prefix}.phases.${name}.required-measured reasons`);
    }
    for (const name of requiredUnavailableStagePhases) {
      const phase = workload.phases[name];
      requireEqual(
        phase.availability,
        { measured: 0, skipped: 0, unavailable: configuration.telemetryFrames },
        `${prefix}.phases.${name}.required-unavailable availability`,
      );
    }
  }
  requirePromotableReport(report, "stage telemetry report");
  return report;
}

export function verifyBenchmarkEvidenceSetV1(input: EvidenceSetInput) {
  const benchmark = verifyBenchmarkReport(input.benchmark);
  const stress = verifyStressReport(input.stress);
  const stageTelemetry = verifyStageTelemetryReport(input.stageTelemetry);
  const reports = [benchmark, stress, stageTelemetry] as const;
  const sharedFields = [
    ["benchmark run id", reports.map(({ benchmarkRunId }) => benchmarkRunId)],
    ["commit identity", reports.map(({ provenance }) => provenance.commitIdentity)],
    ["host", reports.map(({ environment }) => environment.host)],
    ["browser launch", reports.map(({ environment }) => environment.browserLaunch)],
    ["browser version", reports.map(({ environment }) => environment.browserVersion)],
    ["reference-host profile", reports.map(({ environment }) => environment.referenceHostProfile)],
    ["run-specific WASM", reports.map(({ environment }) => environment.wasm)],
  ] as const;
  for (const [name, values] of sharedFields) {
    for (const value of values.slice(1)) requireEqual(value, values[0], `cross-report ${name}`);
  }
  requireEqual(stress.baseFixtureIds[0], benchmark.baseFixtureId, "cross-report benchmark/vector base fixture");
  requireEqual(stageTelemetry.baseFixtureIds, stress.baseFixtureIds, "cross-report stress/stage base fixtures");
  for (const stressWorkload of stress.workloads) {
    const stageWorkload = stageTelemetry.workloads.find(
      ({ definition }) => definition.id === stressWorkload.definition.id,
    );
    if (!stageWorkload) throw new Error(`stage telemetry is missing workload ${stressWorkload.definition.id}`);
    requireEqual(
      { bytes: stageWorkload.snapshotBytes, sha256: stageWorkload.snapshotSha256 },
      { bytes: stressWorkload.snapshotBytes, sha256: stressWorkload.snapshotSha256 },
      `cross-report workload snapshot ${stressWorkload.definition.id}`,
    );
  }
  return {
    benchmark,
    identity: {
      benchmarkRunId: benchmark.benchmarkRunId,
      commit: benchmark.provenance.commitIdentity.headCommit,
      profileId: benchmark.environment.referenceHostProfile.id,
      profileSha256: benchmark.environment.referenceHostProfile.sha256,
      runBuildPath: benchmark.environment.wasm.path,
      wasmSha256: benchmark.environment.wasm.sha256,
    },
    stageTelemetry,
    stress,
  } as const;
}

type PromotionInput = Readonly<{
  benchmarkPath: string;
  outputRoot?: string;
  stageTelemetryPath: string;
  stressPath: string;
}>;

function safePathComponent(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`${label} is not a safe path component`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function promoteBenchmarkEvidenceSetV1(input: PromotionInput) {
  const sourceEntries = [
    ["benchmark.json.gz", input.benchmarkPath],
    ["stress.json.gz", input.stressPath],
    ["stage-telemetry.json.gz", input.stageTelemetryPath],
  ] as const;
  const sourceBytes = await Promise.all(sourceEntries.map(async ([, path]) => new Uint8Array(await readFile(path))));
  const storedBytes = sourceBytes.map(deterministicGzip);
  const parsed = sourceBytes.map((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  const verified = verifyBenchmarkEvidenceSetV1({ benchmark: parsed[0], stress: parsed[1], stageTelemetry: parsed[2] });
  const profileId = safePathComponent(verified.identity.profileId, "profile id");
  const commit = safePathComponent(verified.identity.commit, "commit identity");
  const outputRoot = input.outputRoot ?? "docs/evidence/engine-webgpu";
  const profileRoot = join(outputRoot, profileId);
  const destination = join(profileRoot, commit);
  await mkdir(profileRoot, { recursive: true });
  if (await pathExists(destination)) throw new Error(`evidence destination already exists: ${destination}`);
  const temporary = await mkdtemp(join(profileRoot, `.${commit}.tmp-`));
  try {
    const reports = sourceEntries.map(([filename], index) => ({
      filename,
      schema: [verified.benchmark.schema, verified.stress.schema, verified.stageTelemetry.schema][index]!,
      sha256: sha256(storedBytes[index]!),
      version: [verified.benchmark.version, verified.stress.version, verified.stageTelemetry.version][index]!,
    }));
    await Promise.all(
      sourceEntries.map(([filename], index) => writeFile(join(temporary, filename), storedBytes[index]!)),
    );
    const manifest = evidenceSetManifestSchema.parse({
      benchmarkRunId: verified.identity.benchmarkRunId,
      commit,
      profile: { id: profileId, sha256: verified.identity.profileSha256 },
      reports,
      runBuildPath: verified.identity.runBuildPath,
      schema: "poietra.engine-webgpu-evidence-set",
      version: 1,
      wasmSha256: verified.identity.wasmSha256,
    });
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
    return { destination, manifest } as const;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

export async function verifyPromotedBenchmarkEvidenceSetV1(directory: string) {
  const manifest = evidenceSetManifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  const sourceBytes = await Promise.all(
    manifest.reports.map(async ({ filename, sha256: expectedSha256 }) => {
      const storedBytes = new Uint8Array(await readFile(join(directory, filename)));
      if (sha256(storedBytes) !== expectedSha256) {
        throw new Error(`${filename} does not match its manifest SHA-256`);
      }
      return new Uint8Array(gunzipSync(storedBytes));
    }),
  );
  const parsed = sourceBytes.map((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  const verified = verifyBenchmarkEvidenceSetV1({ benchmark: parsed[0], stress: parsed[1], stageTelemetry: parsed[2] });
  requireEqual(verified.identity.commit, manifest.commit, "manifest commit");
  requireEqual(verified.identity.benchmarkRunId, manifest.benchmarkRunId, "manifest benchmark run id");
  requireEqual(verified.identity.profileId, manifest.profile.id, "manifest profile id");
  requireEqual(verified.identity.profileSha256, manifest.profile.sha256, "manifest profile SHA-256");
  requireEqual(verified.identity.runBuildPath, manifest.runBuildPath, "manifest run build path");
  requireEqual(verified.identity.wasmSha256, manifest.wasmSha256, "manifest WASM SHA-256");
  return { manifest, verified } as const;
}

export async function verifyCheckedInBenchmarkEvidenceV1(
  root = "docs/evidence/engine-webgpu",
): Promise<readonly string[]> {
  let profiles;
  try {
    profiles = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("checked-in engine WebGPU evidence must contain exactly one current evidence set");
    }
    throw error;
  }
  const candidateDirectories: Readonly<{ commit: string; directory: string; profile: string }>[] = [];
  for (const profile of profiles
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const profileName = safePathComponent(profile.name, "checked-in evidence profile directory");
    const profileDirectory = join(root, profile.name);
    const commits = await readdir(profileDirectory, { withFileTypes: true });
    for (const commit of commits
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!/^[0-9a-f]{40}$/.test(commit.name)) {
        throw new Error(`checked-in evidence commit directory is invalid: ${commit.name}`);
      }
      candidateDirectories.push({
        commit: commit.name,
        directory: join(profileDirectory, commit.name),
        profile: profileName,
      });
    }
  }
  // Keep one rolling current set rather than an unverifiable archive of
  // obsolete schema/profile versions.
  if (candidateDirectories.length !== 1) {
    throw new Error("checked-in engine WebGPU evidence must contain exactly one current evidence set");
  }
  const verifiedDirectories: string[] = [];
  for (const candidate of candidateDirectories) {
    const { manifest } = await verifyPromotedBenchmarkEvidenceSetV1(candidate.directory);
    requireEqual(manifest.profile.id, candidate.profile, "evidence profile directory");
    requireEqual(manifest.commit, candidate.commit, "evidence commit directory");
    verifiedDirectories.push(candidate.directory);
  }
  return verifiedDirectories;
}
