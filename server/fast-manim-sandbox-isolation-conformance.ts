import type {
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";

/**
 * Backend-neutral tenant-isolation conformance for #84. Every claim here is
 * expressed only through the public `FastManimSandboxBackendV1` seam, so the
 * same suite applies to the development local-process backend and the selected
 * production backend (#306). Whatever is backend-specific — how a probing
 * producer reports what it saw, how a request-scoped workdir is observed on
 * disk, and how a producer is made to fail or hang — is injected as an
 * environment, and each environment records its own difference table in
 * `platform`.
 *
 * A producer's completion behavior (complete, fail, hang) is a property of the
 * backend's producer command, not of a request, so the harness asks the
 * environment for a backend per phase instead of overloading one factory.
 */
export type SandboxConformancePhaseV1 = "abort" | "failure" | "success";

export type SandboxConformanceObservationV1 = Readonly<{
  /** Names the producer saw in its working directory; a private request workdir is empty. */
  workdirEntries: readonly string[];
  /** The producer's working directory, which must be request-private. */
  workdir: string;
  /** The private HOME/TMPDIR the producer ran under, or null when unset. */
  privateHome: string | null;
  privateTmpdir: string | null;
  /** A host-process env var that must never reach the producer. */
  hostSentinel: string | null;
  /** An allowed producer env var; a negative control for the leak check. */
  producerSentinel: string | null;
  /** The distinct marker this producer read from its own request bytes. */
  requestMarker: string;
}>;

export type SandboxConformanceTenantV1 = Readonly<{
  context: FastManimSandboxJobContextV1;
  request: FastManimSandboxRequestBundleV1;
  /** The exact value this tenant's request echoes back, distinct per tenant. */
  requestMarker: string;
}>;

export type SandboxConformanceEnvironmentV1 = Readonly<{
  /** Human label plus the platform-guaranteed vs. suite-verified difference table. */
  platform: Readonly<{ guaranteed: readonly string[]; label: string; verified: readonly string[] }>;
  /** The host env var name the harness sets before a run; it must not leak. */
  hostSentinelName: string;
  /**
   * Build a backend for one phase. `observedWorkdirs` collects each
   * request-scoped workdir the backend allocates so the harness can assert it
   * is reclaimed. `faultDisableCleanup` skips that removal to prove the residue
   * assertion has teeth; it is only ever passed for the success phase.
   */
  createBackend(
    options: Readonly<{
      faultDisableCleanup?: boolean;
      observedWorkdirs: string[];
      phase: SandboxConformancePhaseV1;
    }>,
  ): FastManimSandboxBackendV1;
  /** A request + context for one tenant seed, echoing a distinct marker. */
  tenant(seed: number): SandboxConformanceTenantV1;
  /** How this environment's probing producer reports what it observed. */
  parseObservation(resultBytes: Uint8Array): SandboxConformanceObservationV1;
  /** Whether a previously-observed request workdir still exists on disk. */
  workdirExists(path: string): boolean;
}>;

export type SandboxConformanceCheckV1 = Readonly<{ detail: string; name: string; passed: boolean }>;

export type SandboxConformanceReportV1 = Readonly<{
  checks: readonly SandboxConformanceCheckV1[];
  passed: boolean;
  platform: SandboxConformanceEnvironmentV1["platform"];
}>;

function check(name: string, passed: boolean, detail: string): SandboxConformanceCheckV1 {
  return { detail, name, passed };
}

function residueCount(environment: SandboxConformanceEnvironmentV1, workdirs: readonly string[]) {
  return workdirs.filter((path) => environment.workdirExists(path)).length;
}

/**
 * Runs one honest pass of the backend-neutral isolation claims. Every check is
 * expected to pass; the caller asserts `report.passed`. The paired
 * `detectSandboxResidueFaultV1` proves the residue checks fail when cleanup is
 * removed, so a green report is evidence of enforcement, not of an assertion
 * that never fires.
 */
export async function runFastManimSandboxIsolationConformanceV1(
  environment: SandboxConformanceEnvironmentV1,
): Promise<SandboxConformanceReportV1> {
  const checks: SandboxConformanceCheckV1[] = [];
  const priorSentinel = process.env[environment.hostSentinelName];
  process.env[environment.hostSentinelName] = `host-secret-${environment.platform.label}`;
  try {
    // Two concurrent tenants exercise workdir privacy, delivery isolation, and
    // env non-leak together.
    const successWorkdirs: string[] = [];
    const a = environment.tenant(1);
    const b = environment.tenant(2);
    const backendA = environment.createBackend({ observedWorkdirs: successWorkdirs, phase: "success" });
    const backendB = environment.createBackend({ observedWorkdirs: successWorkdirs, phase: "success" });
    let observationA: SandboxConformanceObservationV1;
    let observationB: SandboxConformanceObservationV1;
    try {
      const [resultA, resultB] = await Promise.all([
        backendA.start(a.request, a.context).result,
        backendB.start(b.request, b.context).result,
      ]);
      if (resultA.kind !== "ok" || resultB.kind !== "ok") {
        throw new Error(`A conformance probe did not complete: ${resultA.kind}/${resultB.kind}.`);
      }
      observationA = environment.parseObservation(resultA.resultBytes);
      observationB = environment.parseObservation(resultB.resultBytes);
    } finally {
      await backendA.close();
      await backendB.close();
    }

    checks.push(
      check(
        "request-private-workdir",
        observationA.workdir !== observationB.workdir &&
          observationA.workdirEntries.length === 0 &&
          observationB.workdirEntries.length === 0 &&
          observationA.privateHome === observationA.workdir &&
          observationA.privateTmpdir === observationA.workdir,
        `A=${observationA.workdir} (${observationA.workdirEntries.join(",") || "empty"}), B=${observationB.workdir}`,
      ),
    );

    checks.push(
      check(
        "cross-tenant-delivery-isolation",
        observationA.requestMarker === a.requestMarker &&
          observationB.requestMarker === b.requestMarker &&
          observationA.requestMarker !== observationB.requestMarker &&
          a.request.requestDigest !== b.request.requestDigest,
        `A saw ${observationA.requestMarker} (want ${a.requestMarker}), B saw ${observationB.requestMarker} (want ${b.requestMarker})`,
      ),
    );

    checks.push(
      check(
        "host-env-non-leak",
        observationA.hostSentinel === null &&
          observationB.hostSentinel === null &&
          observationA.producerSentinel !== null &&
          observationB.producerSentinel !== null,
        `host sentinel ${observationA.hostSentinel === null ? "blocked" : `leaked as ${observationA.hostSentinel}`}; producer env ${observationA.producerSentinel === null ? "dropped" : "delivered"}`,
      ),
    );

    checks.push(
      check(
        "workdir-reclaimed-on-success",
        successWorkdirs.length >= 2 && residueCount(environment, successWorkdirs) === 0,
        `${successWorkdirs.length} workdirs, residue ${residueCount(environment, successWorkdirs)}`,
      ),
    );

    // Failure and abort each get their own backend so the harness never depends
    // on ordering within a shared one.
    const failureWorkdirs: string[] = [];
    const failureBackend = environment.createBackend({ observedWorkdirs: failureWorkdirs, phase: "failure" });
    let failureKind: string;
    try {
      const failing = environment.tenant(3);
      failureKind = (await failureBackend.start(failing.request, failing.context).result).kind;
    } finally {
      await failureBackend.close();
    }
    checks.push(
      check(
        "workdir-reclaimed-on-failure",
        failureKind === "failed" && failureWorkdirs.length >= 1 && residueCount(environment, failureWorkdirs) === 0,
        `result=${failureKind}, residue ${residueCount(environment, failureWorkdirs)}/${failureWorkdirs.length}`,
      ),
    );

    const abortWorkdirs: string[] = [];
    const abortBackend = environment.createBackend({ observedWorkdirs: abortWorkdirs, phase: "abort" });
    let abortReclaimed = false;
    try {
      const hanging = environment.tenant(4);
      const handle = abortBackend.start(hanging.request, hanging.context);
      handle.abort();
      await handle.result.then(
        (result) => {
          abortReclaimed = result.kind === "failed";
        },
        () => {
          abortReclaimed = true;
        },
      );
    } finally {
      await abortBackend.close();
    }
    checks.push(
      check(
        "workdir-reclaimed-on-abort",
        abortReclaimed && residueCount(environment, abortWorkdirs) === 0,
        `aborted=${abortReclaimed}, residue ${residueCount(environment, abortWorkdirs)}/${abortWorkdirs.length}`,
      ),
    );

    return { checks, passed: checks.every((entry) => entry.passed), platform: environment.platform };
  } finally {
    if (priorSentinel === undefined) delete process.env[environment.hostSentinelName];
    else process.env[environment.hostSentinelName] = priorSentinel;
  }
}

/**
 * Proves the residue claim is load-bearing: with cleanup disabled, the same
 * successful run leaves its request workdir on disk. A suite that could not
 * observe this would pass even against a backend that never cleaned up. The
 * caller owns removing the deliberately-leaked workdirs it is handed back.
 */
export async function detectSandboxResidueFaultV1(
  environment: SandboxConformanceEnvironmentV1,
): Promise<Readonly<{ observedResidue: boolean; workdirs: readonly string[] }>> {
  const observedWorkdirs: string[] = [];
  const backend = environment.createBackend({ faultDisableCleanup: true, observedWorkdirs, phase: "success" });
  try {
    const tenant = environment.tenant(9);
    const result = await backend.start(tenant.request, tenant.context).result;
    if (result.kind !== "ok") throw new Error(`The fault-injection probe did not complete: ${result.kind}.`);
  } finally {
    await backend.close().catch(() => undefined);
  }
  const residue = observedWorkdirs.filter((path) => environment.workdirExists(path));
  return {
    observedResidue: observedWorkdirs.length > 0 && residue.length === observedWorkdirs.length,
    workdirs: residue,
  };
}
