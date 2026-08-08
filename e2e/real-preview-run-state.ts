import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** mkdtemp prefix the real-preview config uses for one run's mutable harness copy. */
export const REAL_PREVIEW_HARNESS_PREFIX_V1 = "poietra-real-preview-harness-v";
/** Prefix of the run-scoped Studio workspace store under `test-results/`. */
export const REAL_PREVIEW_DATA_PREFIX_V1 = "workspace-store-";
export const REAL_PREVIEW_EVIDENCE_DIRECTORY_V1 = "real-preview-evidence";
/** Retained failure evidence is bounded in every dimension so runs cannot grow without limit. */
export const MAX_REAL_PREVIEW_EVIDENCE_RUNS_V1 = 5;
export const MAX_REAL_PREVIEW_EVIDENCE_FILES_V1 = 256;
export const MAX_REAL_PREVIEW_EVIDENCE_BYTES_V1 = 4 * 1024 * 1024;
export const MAX_REAL_PREVIEW_EVIDENCE_AGE_MS_V1 = 7 * 24 * 60 * 60 * 1000;

export type RealPreviewRunStateInputV1 = Readonly<{
  /** Run-scoped Studio workspace store, or null when the run never owned one. */
  dataRoot: string | null;
  evidenceRoot: string;
  /** Run-scoped mutable harness copy, or null for the read-only shared fixture harness. */
  harnessRoot: string | null;
  now: number;
  outcome: "failed" | "passed";
  /** Directory the run-scoped workspace store must be a direct child of. */
  outputRoot: string;
  /** Directory the run-scoped harness copy must be a direct child of. */
  temporaryRoot: string;
}>;

export type RealPreviewRunStateResultV1 = Readonly<{
  /** Cleanup problems, reported separately from whatever the tests themselves decided. */
  failures: readonly string[];
  removed: readonly string[];
  retainedEvidencePath: string | null;
}>;

/**
 * Accepts a path only when it is a real directory placed directly inside the
 * expected parent and named with this run's opaque prefix. A symlink, a nested
 * path, a bare prefix with no run suffix, and anything outside the parent are
 * all refused, so teardown can never reach beyond the current run's namespace.
 */
function ownedRunDirectory(candidate: string, parent: string, prefix: string) {
  const resolved = resolve(candidate);
  const name = basename(resolved);
  if (dirname(resolved) !== resolve(parent) || !name.startsWith(prefix) || name.length === prefix.length) {
    return null;
  }
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(resolved);
  } catch {
    // A namespace that no longer exists is already reclaimed.
    return null;
  }
  return status.isDirectory() ? resolved : null;
}

function boundedRegularFiles(root: string) {
  const files: string[] = [];
  let bytes = 0;
  const walk = (directory: string) => {
    if (files.length >= MAX_REAL_PREVIEW_EVIDENCE_FILES_V1 || bytes >= MAX_REAL_PREVIEW_EVIDENCE_BYTES_V1) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (files.length >= MAX_REAL_PREVIEW_EVIDENCE_FILES_V1 || bytes >= MAX_REAL_PREVIEW_EVIDENCE_BYTES_V1) return;
      const path = join(directory, entry.name);
      // Symlinks are never followed: evidence must stay inside the namespace.
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const { size } = statSync(path);
        if (bytes + size > MAX_REAL_PREVIEW_EVIDENCE_BYTES_V1) continue;
        bytes += size;
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

function retainEvidence(harnessRoot: string, evidenceRoot: string) {
  const target = join(evidenceRoot, basename(harnessRoot));
  mkdirSync(target, { recursive: true });
  for (const file of boundedRegularFiles(harnessRoot)) {
    const destination = join(target, relative(harnessRoot, file));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
  }
  return target;
}

/**
 * Drops retained runs older than the fixed age, then keeps only the newest
 * runs. `keep` is never pruned, so the run that just failed always survives.
 */
function pruneEvidence(evidenceRoot: string, keep: string, now: number) {
  let entries: Array<Readonly<{ modifiedAt: number; path: string }>>;
  try {
    entries = readdirSync(evidenceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(evidenceRoot, entry.name);
        return { modifiedAt: statSync(path).mtimeMs, path };
      });
  } catch {
    return [];
  }
  const expired = entries.filter(({ modifiedAt }) => now - modifiedAt > MAX_REAL_PREVIEW_EVIDENCE_AGE_MS_V1);
  const surviving = entries
    .filter((entry) => !expired.includes(entry))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || (left.path < right.path ? -1 : 1));
  const pruned = [...expired, ...surviving.slice(MAX_REAL_PREVIEW_EVIDENCE_RUNS_V1)].filter(
    ({ path }) => path !== resolve(keep),
  );
  for (const { path } of pruned) rmSync(path, { force: true, recursive: true });
  return pruned.map(({ path }) => path);
}

/**
 * Reclaims exactly the mutable state one real-preview run owns. A failed run
 * keeps a bounded copy of its harness first, so the bytes a test mutated stay
 * inspectable without leaking that state into the next run.
 */
export function reclaimRealPreviewRunStateV1(input: RealPreviewRunStateInputV1): RealPreviewRunStateResultV1 {
  const failures: string[] = [];
  const removed: string[] = [];
  const harnessRoot =
    input.harnessRoot === null
      ? null
      : ownedRunDirectory(input.harnessRoot, input.temporaryRoot, REAL_PREVIEW_HARNESS_PREFIX_V1);
  const dataRoot =
    input.dataRoot === null ? null : ownedRunDirectory(input.dataRoot, input.outputRoot, REAL_PREVIEW_DATA_PREFIX_V1);
  if (input.harnessRoot !== null && harnessRoot === null && pathExists(input.harnessRoot)) {
    failures.push(`The real-preview harness root is outside this run's namespace: ${input.harnessRoot}`);
  }
  if (input.dataRoot !== null && dataRoot === null && pathExists(input.dataRoot)) {
    failures.push(`The real-preview workspace store is outside this run's namespace: ${input.dataRoot}`);
  }

  let retainedEvidencePath: string | null = null;
  if (input.outcome === "failed" && harnessRoot) {
    try {
      retainedEvidencePath = retainEvidence(harnessRoot, resolve(input.evidenceRoot));
      pruneEvidence(resolve(input.evidenceRoot), retainedEvidencePath, input.now);
    } catch (cause) {
      failures.push(`Retaining real-preview failure evidence failed: ${describe(cause)}`);
    }
  }

  for (const path of [harnessRoot, dataRoot]) {
    if (!path) continue;
    try {
      rmSync(path, { force: true, recursive: true });
      removed.push(path);
    } catch (cause) {
      failures.push(`Reclaiming ${path} failed: ${describe(cause)}`);
    }
  }
  return { failures, removed, retainedEvidencePath };
}

/** A refused path that still exists in any form is a cleanup problem worth reporting. */
function pathExists(path: string) {
  try {
    lstatSync(resolve(path));
    return true;
  } catch {
    return false;
  }
}

function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Resolves the run namespace the real-preview config published for this process. */
export function realPreviewRunStateFromEnvironmentV1(
  environment: NodeJS.ProcessEnv,
  outputRoot: string,
  temporaryRoot: string,
): Omit<RealPreviewRunStateInputV1, "now" | "outcome"> | null {
  const dataRoot = environment.POIETRA_E2E_REAL_PREVIEW_DATA_ROOT?.trim() || null;
  const harnessRoot = environment.POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT?.trim() || null;
  if (!dataRoot && !harnessRoot) return null;
  return {
    dataRoot,
    evidenceRoot: join(outputRoot, REAL_PREVIEW_EVIDENCE_DIRECTORY_V1),
    harnessRoot,
    outputRoot,
    temporaryRoot,
  };
}

export function realPreviewRunStateSummaryV1(result: RealPreviewRunStateResultV1) {
  const reclaimed = result.removed.map((path) => basename(path)).join(", ") || "nothing";
  const retained = result.retainedEvidencePath
    ? ` Retained failure evidence in ${relative(process.cwd(), result.retainedEvidencePath)}${sep}.`
    : "";
  return `real-preview teardown reclaimed ${reclaimed}.${retained}`;
}
