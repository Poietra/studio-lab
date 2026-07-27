import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus, release, version } from "node:os";
import { gzipSync } from "node:zlib";

import { canonicalEngineBenchmarkJsonV1 } from "../src/engine/benchmark";
import {
  POIETRA_CANVAS_TELEMETRY_ABI_VERSION,
  POIETRA_CANVAS_WORKER_VERSION,
} from "../src/engine/canvas-worker-protocol";
import { POIETRA_ENGINE_CONTRACT_VERSION } from "../src/engine/primitives";

/**
 * Host and commit-identity evidence shared by every benchmark report.
 *
 * Fields the harness genuinely cannot observe are explicit
 * `{ status: "unavailable", reason }` records instead of being omitted, and a
 * dirty working tree is never silently attributed to its HEAD commit.
 */
export type UnavailableEvidence = Readonly<{ reason: string; status: "unavailable" }>;

export type CommitIdentity = Readonly<{
  /** HEAD commit the tree is based on; the run is only reproducible from it when treeState is "clean". */
  headCommit: string;
  /** Files reported by `git status --porcelain` when the tree is dirty. */
  uncommittedPathCount: number;
  treeState: "clean" | "dirty";
}>;

export type HostEnvironment = Readonly<{
  commitIdentity: CommitIdentity | UnavailableEvidence;
  cpu: Readonly<{ logicalCores: number; model: string }> | UnavailableEvidence;
  gpuDriver: UnavailableEvidence;
  osKernel: Readonly<{ platform: NodeJS.Platform; release: string; version: string }>;
  powerMode: UnavailableEvidence;
}>;

/** Injectable git runner so identity logic is unit-testable without a repo. */
export type GitRunner = (args: readonly string[]) => string;

const defaultGitRunner: GitRunner = (args) => execFileSync("git", [...args], { encoding: "utf8" });

export function collectCommitIdentity(git: GitRunner = defaultGitRunner): CommitIdentity | UnavailableEvidence {
  try {
    const headCommit = git(["rev-parse", "HEAD"]).trim();
    const porcelain = git(["status", "--porcelain"])
      .split("\n")
      .filter((line) => line.trim().length > 0);
    return {
      headCommit,
      treeState: porcelain.length === 0 ? "clean" : "dirty",
      uncommittedPathCount: porcelain.length,
    };
  } catch (error) {
    return {
      reason: `git identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      status: "unavailable",
    };
  }
}

/**
 * Re-collects the commit identity and requires it to be byte-identical to the
 * identity captured before measurement: a HEAD change or any tree-state drift
 * during a run disqualifies the evidence outright.
 */
export function requireStableCommitIdentity(start: CommitIdentity, git: GitRunner = defaultGitRunner): CommitIdentity {
  const end = collectCommitIdentity(git);
  if ("status" in end) {
    throw new Error(`commit identity became unavailable during the run: ${end.reason}`);
  }
  if (
    end.headCommit !== start.headCommit ||
    end.treeState !== start.treeState ||
    end.uncommittedPathCount !== start.uncommittedPathCount
  ) {
    throw new Error(
      `the working tree changed during the benchmark run (start ${start.headCommit} ${start.treeState}/${start.uncommittedPathCount}, end ${end.headCommit} ${end.treeState}/${end.uncommittedPathCount}); the evidence is disqualified`,
    );
  }
  return end;
}

export type BenchmarkProvenance = Readonly<{
  commitIdentity: CommitIdentity;
  grade: "clean-commit" | "non-decision-grade-dirty-tree";
}>;

/**
 * Resolves the provenance a benchmark run is allowed to claim.
 *
 * The decision-grade lane requires a clean tree (tracked AND untracked): a
 * dirty tree cannot be reproduced from the HEAD commit, so the run aborts.
 * Setting `POIETRA_BENCHMARK_ALLOW_DIRTY=1` permits development smokes only,
 * and the resulting report is permanently graded non-decision-grade.
 */
export function resolveBenchmarkProvenance(
  env: Readonly<Record<string, string | undefined>> = process.env,
  git: GitRunner = defaultGitRunner,
): BenchmarkProvenance {
  const commitIdentity = collectCommitIdentity(git);
  if ("status" in commitIdentity) {
    throw new Error(`the benchmark lane requires commit identity: ${commitIdentity.reason}`);
  }
  if (commitIdentity.treeState === "dirty") {
    if (env.POIETRA_BENCHMARK_ALLOW_DIRTY === "1") {
      return { commitIdentity, grade: "non-decision-grade-dirty-tree" };
    }
    throw new Error(
      `the decision-grade benchmark lane requires a clean working tree, but ${commitIdentity.uncommittedPathCount} tracked/untracked paths are uncommitted; commit them or set POIETRA_BENCHMARK_ALLOW_DIRTY=1 for a non-decision-grade development smoke`,
    );
  }
  return { commitIdentity, grade: "clean-commit" };
}

/**
 * Machine-readable decision eligibility shared by every benchmark report.
 *
 * A run may only claim decision-grade eligibility when its provenance is a
 * clean commit, no measured adapter is a software rasterizer, and the pinned
 * reference host expectations are all satisfied. No reference host profile is
 * pinned yet, so today every run carries that reason and stays exploratory.
 */
export type DecisionEligibility = Readonly<{ eligible: boolean; reasons: readonly string[] }>;

const SOFTWARE_ADAPTER_PATTERN = /swiftshader|llvmpipe|lavapipe|software|warp/i;

export function assessDecisionEligibility(input: {
  grade: BenchmarkProvenance["grade"];
  host: HostEnvironment;
  pageAdapterHintArchitecture?: string | null;
  workerAdapters: readonly Readonly<{ backend: string; deviceType: string; name: string }>[];
}): DecisionEligibility {
  const reasons: string[] = [];
  if (input.grade !== "clean-commit") {
    reasons.push(`provenance grade is ${input.grade}; decision evidence requires a clean commit`);
  }
  if (input.workerAdapters.length === 0) {
    reasons.push("no Worker device adapter evidence was collected");
  }
  for (const adapter of input.workerAdapters) {
    if (adapter.deviceType === "Cpu" || SOFTWARE_ADAPTER_PATTERN.test(adapter.name)) {
      reasons.push(
        `the Worker rendered on a software adapter (deviceType ${adapter.deviceType}, name "${adapter.name}")`,
      );
      break;
    }
  }
  if (input.pageAdapterHintArchitecture && SOFTWARE_ADAPTER_PATTERN.test(input.pageAdapterHintArchitecture)) {
    reasons.push(`the page adapter hint reports a software architecture (${input.pageAdapterHintArchitecture})`);
  }
  if ("status" in input.host.gpuDriver) {
    reasons.push("the GPU driver identity is unavailable from this harness");
  }
  if ("status" in input.host.powerMode) {
    reasons.push("the host power mode is unavailable from this harness");
  }
  reasons.push("no reference adapter/host/driver/power-mode profile is pinned for this project yet");
  return { eligible: reasons.length === 0, reasons };
}

export type ServedWasmEvidence = Readonly<{
  byteLength: number;
  gzipByteLength: number;
  path: string;
  sha256: string;
}>;

/**
 * Hashes the WASM binary the static benchmark server actually serves (the
 * production `dist/` copy), so every report records the bytes the Worker
 * loaded rather than a source-tree file that might differ.
 */
export function benchmarkDistDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const distDir = env.POIETRA_BENCHMARK_DIST;
  if (!distDir) {
    throw new Error(
      "POIETRA_BENCHMARK_DIST is not set; run benchmarks through `pnpm benchmark:engine:webgpu` so a run-specific build directory exists.",
    );
  }
  return distDir;
}

export async function readServedWasmEvidence(): Promise<ServedWasmEvidence> {
  const path = `${benchmarkDistDir()}/engine-wasm/poietra_wasm_bg.wasm`;
  const bytes = await readFile(path);
  return {
    byteLength: bytes.byteLength,
    gzipByteLength: gzipSync(bytes, { level: 9 }).byteLength,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * The contract/versions a benchmark report was produced against, so every
 * report is reproducible without consulting the harness source.
 */
export function reportContracts(reportSchema: string, reportVersion: number) {
  return {
    canvasWorkerProtocolVersion: POIETRA_CANVAS_WORKER_VERSION,
    engineContractVersion: POIETRA_ENGINE_CONTRACT_VERSION,
    reportSchema,
    reportVersion,
    telemetryAbiVersion: POIETRA_CANVAS_TELEMETRY_ABI_VERSION,
  } as const;
}

/**
 * Canonical (key-sorted) JSON SHA-256 of a generated Scene bundle, pinning
 * the exact workload content a report measured.
 */
export function canonicalSceneBundleSha256(bundle: unknown): string {
  return createHash("sha256").update(canonicalEngineBenchmarkJsonV1(bundle)).digest("hex");
}

export function collectHostEnvironment(): HostEnvironment {
  const [firstCpu] = cpus();
  return {
    commitIdentity: collectCommitIdentity(),
    cpu: firstCpu
      ? { logicalCores: cpus().length, model: firstCpu.model.trim() }
      : { reason: "node:os reported no CPU entries", status: "unavailable" },
    gpuDriver: {
      reason:
        "the GPU driver identity is not queryable from the Node harness; adapter identity is limited to pageAdapterHint and the Worker's device adapter evidence",
      status: "unavailable",
    },
    osKernel: { platform: process.platform, release: release(), version: version() },
    powerMode: {
      reason: "the host power profile is not queryable from this harness",
      status: "unavailable",
    },
  };
}
