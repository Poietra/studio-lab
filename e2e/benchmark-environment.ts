import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, release, version } from "node:os";
import { gzipSync } from "node:zlib";
import { z } from "zod";

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

const unavailableEvidenceSchema = z.strictObject({ reason: z.string().min(1), status: z.literal("unavailable") });
const availableBrowserInstallationSchema = z.strictObject({
  channel: z.literal("msedge"),
  executablePath: z.string().min(1),
  productVersion: z.string().regex(/^\d+(?:\.\d+){3}$/),
  source: z.literal("windows-file-version"),
  status: z.literal("available"),
});
const availableWindowsBuildSchema = z.strictObject({
  buildNumber: z.string().regex(/^\d+$/),
  caption: z.string().min(1),
  source: z.literal("windows-cim"),
  status: z.literal("available"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
const gpuControllerSchema = z.strictObject({
  deviceId: z.number().int().positive(),
  driverVersion: z.string().min(1),
  name: z.string().min(1),
  pnpDeviceId: z.string().min(1),
  vendorId: z.number().int().positive(),
  vendorName: z.string().min(1),
});
const availableGpuDriverSchema = z.strictObject({
  controllers: z.array(gpuControllerSchema).min(1),
  source: z.literal("windows-cim"),
  status: z.literal("available"),
});
const availablePowerModeSchema = z.strictObject({
  acLineStatus: z.enum(["offline", "online", "unknown"]),
  activeSchemeGuid: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
  source: z.literal("windows-system-power-status+powercfg"),
  status: z.literal("available"),
});

export type CommitIdentity = Readonly<{
  /** HEAD commit the tree is based on; the run is only reproducible from it when treeState is "clean". */
  headCommit: string;
  /** Files reported by `git status --porcelain` when the tree is dirty. */
  uncommittedPathCount: number;
  treeState: "clean" | "dirty";
}>;

const commitIdentitySchema = z.strictObject({
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  treeState: z.enum(["clean", "dirty"]),
  uncommittedPathCount: z.number().int().nonnegative(),
});

/** Strict report schema for OS-derived host evidence. */
export const hostEnvironmentSchema = z.strictObject({
  browserInstallation: z.union([availableBrowserInstallationSchema, unavailableEvidenceSchema]),
  commitIdentity: z.union([commitIdentitySchema, unavailableEvidenceSchema]),
  cpu: z.union([
    z.strictObject({ logicalCores: z.number().int().positive(), model: z.string().min(1) }),
    unavailableEvidenceSchema,
  ]),
  gpuDriver: z.union([availableGpuDriverSchema, unavailableEvidenceSchema]),
  osKernel: z.strictObject({ platform: z.string().min(1), release: z.string(), version: z.string() }),
  powerMode: z.union([availablePowerModeSchema, unavailableEvidenceSchema]),
  windowsBuild: z.union([availableWindowsBuildSchema, unavailableEvidenceSchema]),
});

export type HostEnvironment = z.infer<typeof hostEnvironmentSchema>;

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

/** Canonical runner nonce shared by all three reports from one invocation. */
export function requireBenchmarkRunId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const parsed = z.string().uuid().safeParse(env.POIETRA_BENCHMARK_RUN_ID);
  if (!parsed.success) {
    throw new Error(
      "POIETRA_BENCHMARK_RUN_ID is missing or invalid; run benchmarks through `pnpm benchmark:engine:webgpu`.",
    );
  }
  return parsed.data;
}

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

export const PINNED_REFERENCE_HOST_PROFILE_PATH = "fixtures/engine-benchmark-v1/windows-d3d12-reference-host.json";
export const PINNED_REFERENCE_HOST_PROFILE_HASH_PATH = `${PINNED_REFERENCE_HOST_PROFILE_PATH}.sha256`;

const referenceGpuControllerSchema = gpuControllerSchema.omit({ pnpDeviceId: true });
const workerAdapterIdentitySchema = z.strictObject({
  backend: z.literal("BrowserWebGpu"),
  browserArchitecture: z.string().max(256),
  browserVendor: z.string().max(256),
  deviceId: z.literal(0),
  deviceType: z.enum(["Cpu", "Other"]),
  driver: z.literal(""),
  driverInfo: z.literal(""),
  name: z.string(),
  source: z.literal("worker-wgpu-adapter-info"),
  subgroupMaxSize: z.number().int().nonnegative(),
  subgroupMinSize: z.number().int().nonnegative(),
  vendorId: z.literal(0),
});
const referenceWorkerAdapterIdentitySchema = workerAdapterIdentitySchema
  .pick({
    backend: true,
    browserArchitecture: true,
    browserVendor: true,
    deviceType: true,
    name: true,
    source: true,
    subgroupMaxSize: true,
    subgroupMinSize: true,
  })
  .extend({
    browserArchitecture: z.string().min(1).max(256),
    browserVendor: z.string().min(1).max(256),
    deviceType: z.literal("Other"),
    name: z.literal(""),
    subgroupMaxSize: z.number().int().positive(),
    subgroupMinSize: z.number().int().positive(),
  });

/** The one reviewable host/browser/adapter configuration allowed to become decision evidence. */
export const referenceHostProfileSchema = z
  .strictObject({
    browser: z.strictObject({ channel: z.literal("msedge"), version: z.string().regex(/^\d+(?:\.\d+){3}$/) }),
    cpu: z.strictObject({ logicalCores: z.number().int().positive(), model: z.string().min(1) }),
    gpuControllers: z.array(referenceGpuControllerSchema).min(1),
    id: z.string().min(1),
    platform: z.literal("win32"),
    power: z.strictObject({
      acLineStatus: z.literal("online"),
      activeSchemeGuid: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
    }),
    schema: z.literal("poietra.engine-webgpu-reference-host"),
    selectedGpuController: referenceGpuControllerSchema.pick({ deviceId: true, vendorId: true }),
    selectedWorkerAdapter: referenceWorkerAdapterIdentitySchema,
    version: z.literal(1),
    windowsBuild: availableWindowsBuildSchema.omit({ source: true, status: true }),
  })
  .superRefine((profile, context) => {
    const selectedControllers = profile.gpuControllers.filter(
      (controller) =>
        controller.deviceId === profile.selectedGpuController.deviceId &&
        controller.vendorId === profile.selectedGpuController.vendorId,
    );
    if (selectedControllers.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "selectedGpuController must identify exactly one controller in gpuControllers",
        path: ["selectedGpuController"],
      });
    }
    if (profile.selectedWorkerAdapter.subgroupMinSize > profile.selectedWorkerAdapter.subgroupMaxSize) {
      context.addIssue({
        code: "custom",
        message: "selectedWorkerAdapter subgroup bounds must be ordered",
        path: ["selectedWorkerAdapter", "subgroupMinSize"],
      });
    }
  });

export type ReferenceHostProfile = z.infer<typeof referenceHostProfileSchema>;
export type WorkerAdapterIdentity = z.infer<typeof workerAdapterIdentitySchema>;

export const referenceHostProfileEvidenceSchema = z.strictObject({
  id: z.string().min(1),
  path: z.literal(PINNED_REFERENCE_HOST_PROFILE_PATH),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.literal("verified"),
});

export type PinnedReferenceHostProfile = Readonly<{
  evidence: z.infer<typeof referenceHostProfileEvidenceSchema>;
  profile: ReferenceHostProfile;
}>;

/**
 * Loads only the checked-in profile and verifies its separately reviewed byte
 * hash. Environment variables cannot replace either the profile or its hash.
 */
export function readPinnedReferenceHostProfile(
  profileBytes: Buffer = readFileSync(PINNED_REFERENCE_HOST_PROFILE_PATH),
  hashFile = readFileSync(PINNED_REFERENCE_HOST_PROFILE_HASH_PATH, "utf8"),
): PinnedReferenceHostProfile {
  const sha256 = createHash("sha256").update(profileBytes).digest("hex");
  const recordedSha256 = hashFile.trim().split(/\s+/u)[0];
  if (!recordedSha256 || !/^[0-9a-f]{64}$/.test(recordedSha256)) {
    throw new Error(`the pinned reference-host hash file is malformed: ${PINNED_REFERENCE_HOST_PROFILE_HASH_PATH}`);
  }
  if (sha256 !== recordedSha256) {
    throw new Error(
      `the pinned reference-host profile hashes to ${sha256}, expected ${recordedSha256}; update the reviewed profile and hash together`,
    );
  }
  const profile = referenceHostProfileSchema.parse(JSON.parse(profileBytes.toString("utf8")));
  return {
    evidence: {
      id: profile.id,
      path: PINNED_REFERENCE_HOST_PROFILE_PATH,
      sha256,
      status: "verified",
    },
    profile,
  };
}

/**
 * Machine-readable decision eligibility shared by every benchmark report.
 *
 * A run may only claim decision-grade eligibility when its provenance is a
 * clean commit, every measured adapter is the same hardware adapter, and the
 * checked-in Windows/Edge/driver/power reference profile matches exactly.
 */
export type DecisionEligibility = Readonly<{ eligible: boolean; reasons: readonly string[] }>;

const SOFTWARE_ADAPTER_PATTERN = /swiftshader|llvmpipe|lavapipe|software|warp/i;

function comparableGpuControllers(host: HostEnvironment): readonly z.infer<typeof referenceGpuControllerSchema>[] {
  if (host.gpuDriver.status === "unavailable") return [];
  return host.gpuDriver.controllers.map(({ deviceId, driverVersion, name, vendorId, vendorName }) => ({
    deviceId,
    driverVersion,
    name,
    vendorId,
    vendorName,
  }));
}

function hostProfileMismatchReasons(host: HostEnvironment, profile: ReferenceHostProfile): string[] {
  const reasons: string[] = [];
  if (host.osKernel.platform !== profile.platform) {
    reasons.push(`host platform is ${host.osKernel.platform}; reference profile requires ${profile.platform}`);
  }
  if (host.browserInstallation.status === "unavailable") {
    reasons.push("the installed Edge version is unavailable");
  } else if (
    host.browserInstallation.channel !== profile.browser.channel ||
    host.browserInstallation.productVersion !== profile.browser.version
  ) {
    reasons.push("the installed Edge channel/version does not exactly match the pinned reference profile");
  }
  if ("status" in host.cpu) {
    reasons.push("the CPU identity is unavailable");
  } else if (JSON.stringify(host.cpu) !== JSON.stringify(profile.cpu)) {
    reasons.push("the CPU identity does not exactly match the pinned reference profile");
  }
  if (host.windowsBuild.status === "unavailable") {
    reasons.push("the Windows build identity is unavailable");
  } else {
    const { buildNumber, caption, version: buildVersion } = host.windowsBuild;
    if (JSON.stringify({ buildNumber, caption, version: buildVersion }) !== JSON.stringify(profile.windowsBuild)) {
      reasons.push("the Windows build does not exactly match the pinned reference profile");
    }
  }
  if (host.gpuDriver.status === "unavailable") {
    reasons.push("the GPU controller/driver identity is unavailable");
  } else if (JSON.stringify(comparableGpuControllers(host)) !== JSON.stringify(profile.gpuControllers)) {
    reasons.push("the GPU controller/driver inventory does not exactly match the pinned reference profile");
  }
  if (host.powerMode.status === "unavailable") {
    reasons.push("the AC state and active power plan are unavailable");
  } else {
    if (host.powerMode.acLineStatus !== "online") reasons.push("the Windows host is not connected to AC power");
    if (host.powerMode.activeSchemeGuid !== profile.power.activeSchemeGuid) {
      reasons.push("the active Windows power plan does not match the pinned reference profile");
    }
  }
  return reasons;
}

function adapterIdentity(adapter: WorkerAdapterIdentity): WorkerAdapterIdentity {
  return workerAdapterIdentitySchema.parse(adapter);
}

/** Exact identity used to prove that every sample rendered on one adapter. */
export function workerAdapterIdentityEquals(left: WorkerAdapterIdentity, right: WorkerAdapterIdentity): boolean {
  return (
    left.backend === right.backend &&
    left.browserArchitecture === right.browserArchitecture &&
    left.browserVendor === right.browserVendor &&
    left.deviceId === right.deviceId &&
    left.deviceType === right.deviceType &&
    left.driver === right.driver &&
    left.driverInfo === right.driverInfo &&
    left.name === right.name &&
    left.source === right.source &&
    left.subgroupMaxSize === right.subgroupMaxSize &&
    left.subgroupMinSize === right.subgroupMinSize &&
    left.vendorId === right.vendorId
  );
}

function referenceAdapterIdentityEquals(
  adapter: WorkerAdapterIdentity,
  reference: ReferenceHostProfile["selectedWorkerAdapter"],
): boolean {
  return (
    adapter.backend === reference.backend &&
    adapter.browserArchitecture === reference.browserArchitecture &&
    adapter.browserVendor === reference.browserVendor &&
    adapter.deviceType === reference.deviceType &&
    adapter.name === reference.name &&
    adapter.source === reference.source &&
    adapter.subgroupMaxSize === reference.subgroupMaxSize &&
    adapter.subgroupMinSize === reference.subgroupMinSize
  );
}

export function assessDecisionEligibility(input: {
  browserChannel: string;
  browserLaunchArgs: readonly string[];
  browserVersions: readonly string[];
  grade: BenchmarkProvenance["grade"];
  host: HostEnvironment;
  pageAdapterHintArchitecture?: string | null;
  referenceHost: PinnedReferenceHostProfile;
  requiredBrowserVersionSamples?: number;
  requiredWorkerAdapterSamples?: number;
  workerAdapters: readonly WorkerAdapterIdentity[];
}): DecisionEligibility {
  const reasons = hostProfileMismatchReasons(input.host, input.referenceHost.profile);
  if (input.grade !== "clean-commit") {
    reasons.push(`provenance grade is ${input.grade}; decision evidence requires a clean commit`);
  }
  if (input.browserChannel !== input.referenceHost.profile.browser.channel) {
    reasons.push(
      `browser channel is ${input.browserChannel}; reference profile requires ${input.referenceHost.profile.browser.channel}`,
    );
  }
  if (input.browserLaunchArgs.length !== 0) {
    reasons.push("decision evidence forbids project-supplied browser renderer overrides");
  }
  if (input.browserVersions.length === 0) reasons.push("no launched browser version was collected");
  for (const browserVersion of input.browserVersions) {
    if (browserVersion !== input.referenceHost.profile.browser.version) {
      reasons.push(
        `browser version ${browserVersion} does not exactly match reference ${input.referenceHost.profile.browser.version}`,
      );
      break;
    }
  }
  if (
    input.requiredWorkerAdapterSamples !== undefined &&
    input.workerAdapters.length !== input.requiredWorkerAdapterSamples
  ) {
    reasons.push(
      `collected ${input.workerAdapters.length} Worker adapter samples; required exactly ${input.requiredWorkerAdapterSamples}`,
    );
  }
  if (
    input.requiredBrowserVersionSamples !== undefined &&
    input.browserVersions.length !== input.requiredBrowserVersionSamples
  ) {
    reasons.push(
      `collected ${input.browserVersions.length} browser-version samples; required exactly ${input.requiredBrowserVersionSamples}`,
    );
  }
  if (input.workerAdapters.length === 0) {
    reasons.push("no Worker device adapter evidence was collected");
  }
  const firstAdapter = input.workerAdapters[0];
  for (const candidate of input.workerAdapters) {
    const adapter = adapterIdentity(candidate);
    if (adapter.browserArchitecture.length === 0 || adapter.browserVendor.length === 0) {
      reasons.push("the Worker browser adapter vendor/architecture identity is unavailable");
      break;
    }
    if (
      adapter.deviceType === "Cpu" ||
      SOFTWARE_ADAPTER_PATTERN.test(
        `${adapter.browserArchitecture} ${adapter.browserVendor} ${adapter.name} ${adapter.driver} ${adapter.driverInfo}`,
      )
    ) {
      reasons.push(
        `the Worker rendered on a software adapter (deviceType ${adapter.deviceType}, name "${adapter.name}")`,
      );
      break;
    }
    if (firstAdapter && !workerAdapterIdentityEquals(adapter, adapterIdentity(firstAdapter))) {
      reasons.push("Worker adapter identity changed between benchmark samples");
      break;
    }
  }
  if (
    firstAdapter &&
    !referenceAdapterIdentityEquals(adapterIdentity(firstAdapter), input.referenceHost.profile.selectedWorkerAdapter)
  ) {
    reasons.push("the selected Worker adapter does not exactly match the pinned reference profile");
  }
  if (input.pageAdapterHintArchitecture && SOFTWARE_ADAPTER_PATTERN.test(input.pageAdapterHintArchitecture)) {
    reasons.push(`the page adapter hint reports a software architecture (${input.pageAdapterHintArchitecture})`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Windows decision runs fail before measurement when OS-owned evidence is not canonical. */
export function requireReferenceHostPreflight(input: {
  browserLaunch: Readonly<{ args: readonly string[]; channel: string }>;
  host: HostEnvironment;
  referenceHost: PinnedReferenceHostProfile;
}): void {
  if (input.host.osKernel.platform !== "win32") return;
  const reasons = hostProfileMismatchReasons(input.host, input.referenceHost.profile);
  if (input.browserLaunch.channel !== "msedge" || input.browserLaunch.args.length !== 0) {
    reasons.push("Windows decision runs require native Edge with no project-supplied Vulkan/ANGLE renderer flags");
  }
  if (reasons.length > 0) throw new Error(`reference-host preflight failed:\n- ${reasons.join("\n- ")}`);
}

/** AC, power-plan, build, and driver evidence must remain stable through measurement. */
export function requireStableReferenceHostEnvironment(start: HostEnvironment, end: HostEnvironment): void {
  if (start.osKernel.platform !== "win32") return;
  const startEvidence = {
    browserInstallation: start.browserInstallation,
    gpuDriver: start.gpuDriver,
    powerMode: start.powerMode,
    windowsBuild: start.windowsBuild,
  };
  const endEvidence = {
    browserInstallation: end.browserInstallation,
    gpuDriver: end.gpuDriver,
    powerMode: end.powerMode,
    windowsBuild: end.windowsBuild,
  };
  if (JSON.stringify(startEvidence) !== JSON.stringify(endEvidence)) {
    throw new Error(
      "Edge version, Windows build, GPU driver, AC state, or power plan changed during the benchmark run",
    );
  }
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

const WINDOWS_ROOT = String.raw`C:\Windows`;
const WINDOWS_SYSTEM32 = String.raw`C:\Windows\System32`;
const WINDOWS_POWERSHELL_DIRECTORY = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`;
export const WINDOWS_POWERSHELL_EXECUTABLE = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

export const WINDOWS_HOST_EVIDENCE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Import-Module -Name "C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1" -Force

$edgePath = $null
foreach ($registryView in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    $registryView
  )
  try {
    $edgeKey = $baseKey.OpenSubKey("SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", $false)
    if ($null -ne $edgeKey) {
      try {
        $candidate = [string]$edgeKey.GetValue("")
        if ([regex]::IsMatch($candidate, "^[A-Za-z]:\\") -and [System.IO.File]::Exists($candidate)) {
          $edgePath = $candidate
        }
      } finally {
        $edgeKey.Dispose()
      }
    }
  } finally {
    $baseKey.Dispose()
  }
  if ($null -ne $edgePath) { break }
}

$edgeCandidates = @(
  $edgePath
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgeCandidates |
  Where-Object { $_ -and [regex]::IsMatch($_, "^[A-Za-z]:\\") -and [System.IO.File]::Exists($_) } |
  Select-Object -First 1
if (-not $edgePath) { throw "installed Microsoft Edge executable was not found" }
$edgeVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($edgePath).ProductVersion

$operatingSystem = CimCmdlets\Get-CimInstance -ClassName Win32_OperatingSystem
$controllers = @(
  CimCmdlets\Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
    $pnpDeviceId = [string]$_.PNPDeviceID
    $identity = [regex]::Match($pnpDeviceId, "VEN_([0-9A-Fa-f]{4}).*DEV_([0-9A-Fa-f]{4})")
    if (-not $identity.Success) { throw "video controller has no PCI vendor/device identity: $pnpDeviceId" }
    [ordered]@{
      deviceId = [Convert]::ToInt32($identity.Groups[2].Value, 16)
      driverVersion = [string]$_.DriverVersion
      name = [string]$_.Name
      pnpDeviceId = $pnpDeviceId
      vendorId = [Convert]::ToInt32($identity.Groups[1].Value, 16)
      vendorName = [string]$_.AdapterCompatibility
    }
  }
) | Sort-Object @{ Expression = { [int]$_.vendorId } }, @{ Expression = { [int]$_.deviceId } }, name
if ($controllers.Count -eq 0) { throw "Win32_VideoController returned no controllers" }

$acLineStatus = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString().ToLowerInvariant()
$powerCfgPath = "C:\Windows\System32\powercfg.exe"
if (-not [System.IO.File]::Exists($powerCfgPath)) { throw "the canonical powercfg executable was not found" }
$activeScheme = (& $powerCfgPath /GETACTIVESCHEME | Out-String)
if ($LASTEXITCODE -ne 0) { throw "powercfg /GETACTIVESCHEME failed with exit code $LASTEXITCODE" }
$schemeIdentity = [regex]::Match($activeScheme, "[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}")
if (-not $schemeIdentity.Success) { throw "powercfg did not return an active scheme GUID" }

[ordered]@{
  browserInstallation = [ordered]@{
    channel = "msedge"
    executablePath = [string]$edgePath
    productVersion = [string]$edgeVersion
    source = "windows-file-version"
    status = "available"
  }
  gpuDriver = [ordered]@{
    controllers = @($controllers)
    source = "windows-cim"
    status = "available"
  }
  powerMode = [ordered]@{
    acLineStatus = $acLineStatus
    activeSchemeGuid = $schemeIdentity.Value.ToLowerInvariant()
    source = "windows-system-power-status+powercfg"
    status = "available"
  }
  windowsBuild = [ordered]@{
    buildNumber = [string]$operatingSystem.BuildNumber
    caption = [string]$operatingSystem.Caption
    source = "windows-cim"
    status = "available"
    version = [string]$operatingSystem.Version
  }
} | ConvertTo-Json -Compress -Depth 6
`;

export type WindowsHostEvidenceRunner = (script: string) => string;

export type WindowsHostEvidenceInvocation = Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  executablePath: string;
}>;

/**
 * Returns the production probe invocation without consulting caller-provided
 * PATH, SystemRoot, ProgramFiles, PSModulePath, or PowerShell profiles. The
 * benchmark threat model fails closed on a non-standard Windows installation;
 * it does not claim resistance to an administrator replacing OS files or HKLM.
 */
export function windowsHostEvidenceInvocation(script: string): WindowsHostEvidenceInvocation {
  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    env: {
      Path: `${WINDOWS_SYSTEM32};${WINDOWS_POWERSHELL_DIRECTORY}`,
      PSModulePath: `${WINDOWS_POWERSHELL_DIRECTORY}\\Modules`,
      SystemRoot: WINDOWS_ROOT,
      TEMP: `${WINDOWS_ROOT}\\Temp`,
      TMP: `${WINDOWS_ROOT}\\Temp`,
      WINDIR: WINDOWS_ROOT,
    },
    executablePath: WINDOWS_POWERSHELL_EXECUTABLE,
  };
}

const defaultWindowsHostEvidenceRunner: WindowsHostEvidenceRunner = (script) => {
  const invocation = windowsHostEvidenceInvocation(script);
  return execFileSync(invocation.executablePath, [...invocation.args], {
    encoding: "utf8",
    env: { ...invocation.env },
    windowsHide: true,
  });
};

const windowsProbeSchema = z.strictObject({
  browserInstallation: availableBrowserInstallationSchema,
  gpuDriver: availableGpuDriverSchema,
  powerMode: availablePowerModeSchema,
  windowsBuild: availableWindowsBuildSchema,
});

function unavailableWindowsEvidence(reason: string) {
  return { reason: `Windows native host evidence is unavailable: ${reason}`, status: "unavailable" } as const;
}

export function collectHostEnvironment(
  options: Readonly<{
    platform?: NodeJS.Platform;
    windowsHostEvidence?: WindowsHostEvidenceRunner;
  }> = {},
): HostEnvironment {
  const platform = options.platform ?? process.platform;
  const [firstCpu] = cpus();
  let windowsEvidence:
    | z.infer<typeof windowsProbeSchema>
    | Readonly<{
        browserInstallation: UnavailableEvidence;
        gpuDriver: UnavailableEvidence;
        powerMode: UnavailableEvidence;
        windowsBuild: UnavailableEvidence;
      }>;
  if (platform === "win32") {
    try {
      windowsEvidence = windowsProbeSchema.parse(
        JSON.parse((options.windowsHostEvidence ?? defaultWindowsHostEvidenceRunner)(WINDOWS_HOST_EVIDENCE_SCRIPT)),
      );
    } catch (error) {
      const unavailable = unavailableWindowsEvidence(error instanceof Error ? error.message : String(error));
      windowsEvidence = {
        browserInstallation: unavailable,
        gpuDriver: unavailable,
        powerMode: unavailable,
        windowsBuild: unavailable,
      };
    }
  } else {
    const unavailable = unavailableWindowsEvidence(`platform ${platform} is not Windows`);
    windowsEvidence = {
      browserInstallation: unavailable,
      gpuDriver: unavailable,
      powerMode: unavailable,
      windowsBuild: unavailable,
    };
  }
  return hostEnvironmentSchema.parse({
    browserInstallation: windowsEvidence.browserInstallation,
    commitIdentity: collectCommitIdentity(),
    cpu: firstCpu
      ? { logicalCores: cpus().length, model: firstCpu.model.trim() }
      : { reason: "node:os reported no CPU entries", status: "unavailable" },
    gpuDriver: windowsEvidence.gpuDriver,
    osKernel: { platform, release: release(), version: version() },
    powerMode: windowsEvidence.powerMode,
    windowsBuild: windowsEvidence.windowsBuild,
  });
}
