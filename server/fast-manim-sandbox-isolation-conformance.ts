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
  /** SHA-256 computed by the producer from the source body it actually read. */
  sourceDigest: string;
  /** Environment-defined cleanup target corresponding to this execution. */
  cleanupTarget: string;
}>;

export type SandboxConformanceTenantV1 = Readonly<{
  context: FastManimSandboxJobContextV1;
  request: FastManimSandboxRequestBundleV1;
  /** The exact value this tenant's request echoes back, distinct per tenant. */
  requestMarker: string;
  /** SHA-256 of this tenant's distinct source body. */
  sourceDigest: string;
}>;

export type SandboxConformanceBackendV1 = Readonly<{
  backend: FastManimSandboxBackendV1;
  /** Resolves only after the phase's producer has started executing. */
  waitUntilStarted(): Promise<string>;
}>;

export type SandboxConformanceEnvironmentV1 = Readonly<{
  /** Human label plus the platform-guaranteed vs. suite-verified difference table. */
  platform: Readonly<{ guaranteed: readonly string[]; label: string; verified: readonly string[] }>;
  /** The host env var name the harness sets before a run; it must not leak. */
  hostSentinelName: string;
  /** Exact allowlisted sentinel value the probing producer must receive. */
  producerSentinelValue: string;
  /**
   * Build a backend for one phase. `observedCleanupTargets` collects each
   * request-scoped resource the backend reclaims. `waitUntilStarted` is a
   * producer-start latch used to ensure the abort path reaches real execution.
   * `faultDisableCleanup` skips removal to prove the residue assertion has
   * teeth; it is only ever passed for the success phase.
   */
  createBackend(
    options: Readonly<{
      faultDisableCleanup?: boolean;
      observedCleanupTargets: string[];
      phase: SandboxConformancePhaseV1;
    }>,
  ): SandboxConformanceBackendV1;
  /** A request + context for one tenant seed, echoing a distinct marker. */
  tenant(seed: number): SandboxConformanceTenantV1;
  /** How this environment's probing producer reports what it observed. */
  parseObservation(resultBytes: Uint8Array): SandboxConformanceObservationV1;
  /** Whether a previously-observed cleanup target still exists. */
  cleanupTargetExists(target: string): boolean;
  /** Platform-specific evaluation of request-private execution semantics. */
  assessRequestPrivacy(
    observationA: SandboxConformanceObservationV1,
    observationB: SandboxConformanceObservationV1,
  ): Readonly<{ detail: string; passed: boolean }>;
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

function residueCount(environment: SandboxConformanceEnvironmentV1, targets: readonly string[]) {
  return targets.filter((target) => environment.cleanupTargetExists(target)).length;
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
    const successTargets: string[] = [];
    const a = environment.tenant(1);
    const b = environment.tenant(2);
    const successPhase = environment.createBackend({ observedCleanupTargets: successTargets, phase: "success" });
    let observationA: SandboxConformanceObservationV1;
    let observationB: SandboxConformanceObservationV1;
    try {
      const [resultA, resultB] = await Promise.all([
        successPhase.backend.start(a.request, a.context).result,
        successPhase.backend.start(b.request, b.context).result,
      ]);
      if (resultA.kind !== "ok" || resultB.kind !== "ok") {
        throw new Error(`A conformance probe did not complete: ${resultA.kind}/${resultB.kind}.`);
      }
      observationA = environment.parseObservation(resultA.resultBytes);
      observationB = environment.parseObservation(resultB.resultBytes);
      const privacy = environment.assessRequestPrivacy(observationA, observationB);
      checks.push(check("request-private-workdir", privacy.passed, privacy.detail));

      checks.push(
        check(
          "cross-tenant-delivery-isolation",
          observationA.requestMarker === a.requestMarker &&
            observationB.requestMarker === b.requestMarker &&
            observationA.requestMarker !== observationB.requestMarker &&
            observationA.sourceDigest === a.sourceDigest &&
            observationB.sourceDigest === b.sourceDigest &&
            observationA.sourceDigest !== observationB.sourceDigest &&
            a.request.requestDigest !== b.request.requestDigest,
          `A marker/source ${observationA.requestMarker}/${observationA.sourceDigest} (want ${a.requestMarker}/${a.sourceDigest}), B marker/source ${observationB.requestMarker}/${observationB.sourceDigest} (want ${b.requestMarker}/${b.sourceDigest})`,
        ),
      );

      checks.push(
        check(
          "host-env-non-leak",
          observationA.hostSentinel === null &&
            observationB.hostSentinel === null &&
            observationA.producerSentinel === environment.producerSentinelValue &&
            observationB.producerSentinel === environment.producerSentinelValue,
          `host sentinels A/B=${observationA.hostSentinel ?? "blocked"}/${observationB.hostSentinel ?? "blocked"}; producer sentinels A/B=${observationA.producerSentinel ?? "dropped"}/${observationB.producerSentinel ?? "dropped"}`,
        ),
      );

      const successResidue = residueCount(environment, successTargets);
      const observedSuccessTargets = new Set(successTargets);
      checks.push(
        check(
          "workdir-reclaimed-on-success",
          successTargets.length >= 2 &&
            observedSuccessTargets.has(observationA.cleanupTarget) &&
            observedSuccessTargets.has(observationB.cleanupTarget) &&
            successResidue === 0,
          `${successTargets.length} targets, correlated=${observedSuccessTargets.has(observationA.cleanupTarget) && observedSuccessTargets.has(observationB.cleanupTarget)}, residue ${successResidue}`,
        ),
      );
    } finally {
      await successPhase.backend.close();
    }

    // Failure and abort each get their own backend so the harness never depends
    // on ordering within a shared one.
    const failureTargets: string[] = [];
    const failurePhase = environment.createBackend({ observedCleanupTargets: failureTargets, phase: "failure" });
    let failureKind: string;
    try {
      const failing = environment.tenant(3);
      const handle = failurePhase.backend.start(failing.request, failing.context);
      const startedTarget = await failurePhase.waitUntilStarted();
      failureKind = (await handle.result).kind;
      const failureResidue = residueCount(environment, failureTargets);
      checks.push(
        check(
          "workdir-reclaimed-on-failure",
          failureKind === "failed" &&
            failureTargets.length >= 1 &&
            failureTargets.includes(startedTarget) &&
            failureResidue === 0,
          `result=${failureKind}, started-target-correlated=${failureTargets.includes(startedTarget)}, residue ${failureResidue}/${failureTargets.length}`,
        ),
      );
    } finally {
      await failurePhase.backend.close();
    }

    const abortTargets: string[] = [];
    const abortPhase = environment.createBackend({ observedCleanupTargets: abortTargets, phase: "abort" });
    let abortSettled = false;
    try {
      const hanging = environment.tenant(4);
      const handle = abortPhase.backend.start(hanging.request, hanging.context);
      const startedTarget = await abortPhase.waitUntilStarted();
      handle.abort();
      await handle.result.then(
        (result) => {
          abortSettled = result.kind === "failed";
        },
        () => {
          abortSettled = true;
        },
      );
      const abortResidue = residueCount(environment, abortTargets);
      checks.push(
        check(
          "workdir-reclaimed-on-abort",
          abortSettled && abortTargets.length >= 1 && abortTargets.includes(startedTarget) && abortResidue === 0,
          `settled=${abortSettled}, started-target-correlated=${abortTargets.includes(startedTarget)}, residue ${abortResidue}/${abortTargets.length}`,
        ),
      );
    } finally {
      await abortPhase.backend.close();
    }

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
  const observedTargets: string[] = [];
  const phase = environment.createBackend({
    faultDisableCleanup: true,
    observedCleanupTargets: observedTargets,
    phase: "success",
  });
  try {
    const tenant = environment.tenant(9);
    const result = await phase.backend.start(tenant.request, tenant.context).result;
    if (result.kind !== "ok") throw new Error(`The fault-injection probe did not complete: ${result.kind}.`);
  } finally {
    await phase.backend.close().catch(() => undefined);
  }
  const residue = observedTargets.filter((target) => environment.cleanupTargetExists(target));
  return {
    observedResidue: observedTargets.length > 0 && residue.length === observedTargets.length,
    workdirs: residue,
  };
}
