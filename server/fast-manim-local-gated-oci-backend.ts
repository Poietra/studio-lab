import {
  assertFastManimGatedOciImageV1,
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FastManimGatedOciDockerClientV1,
  type FastManimGatedOciJobExecutorV1,
  FastManimGatedOciJobRunnerV1,
} from "./fast-manim-gated-oci-job-runner";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxDeployment,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  parseFastManimSandboxDeployment,
  parseFastManimSandboxJobIdentityV1,
  UnavailableFastManimSandboxBackendV1,
} from "./fast-manim-sandbox-backend";

export {
  FastManimGatedOciError as FastManimLocalGatedOciError,
  parseFastManimGatedOciResultV1 as parseFastManimLocalGatedOciResultV1,
  runFastManimGatedOciJobV1 as runFastManimLocalGatedOciV1,
} from "./fast-manim-gated-oci-job-runner";

export type FastManimLocalGatedOciBackendOptionsV1 = Readonly<{
  dockerClient?: FastManimGatedOciDockerClientV1;
  /** Test-only execution seam; the configured factory never supplies it. */
  executeJob?: FastManimGatedOciJobExecutorV1;
  image: string;
  seccompPath?: string;
}>;

/** Rootful Docker conformance wrapper. It can never claim production readiness. */
export class FastManimLocalGatedOciBackendV1 implements FastManimSandboxBackendV1 {
  readonly #dockerClient: FastManimGatedOciDockerClientV1;
  readonly #image: string;
  readonly #jobs: FastManimGatedOciJobRunnerV1;

  constructor(options: FastManimLocalGatedOciBackendOptionsV1) {
    this.#dockerClient = options.dockerClient ?? new FastManimGatedOciDockerClientV1();
    this.#image = options.image;
    this.#jobs = new FastManimGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: this.#dockerClient,
      ...(options.executeJob ? { executeJob: options.executeJob } : {}),
      image: options.image,
      ...(options.seccompPath ? { seccompPath: options.seccompPath } : {}),
    });
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= Date.now()) {
      throw new TypeError("Sandbox status deadline must be a future epoch millisecond integer.");
    }
    context.signal.throwIfAborted();
    const health = this.#jobs.health();
    if (health !== "open") return this.#unavailable(health === "cleanup-failed" ? "health-check-failed" : "disabled");
    try {
      await assertFastManimGatedOciImageV1(this.#image, this.#dockerClient, context.deadlineEpochMs, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      return this.#unavailable("health-check-failed");
    }
    if (Date.now() >= context.deadlineEpochMs || this.#jobs.health() !== "open") {
      return this.#unavailable("health-check-failed");
    }
    return {
      attestation: {
        profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
        runtimeDigest: this.#image.slice("sha256:".length),
        trust: "development-only",
      },
      backendId: "local-docker-gated-rootful",
      backendKind: "local-process",
      capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
      health: "ready",
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    return this.#jobs.start(request, context);
  }

  close() {
    return this.#jobs.close();
  }

  #unavailable(reason: "disabled" | "health-check-failed"): FastManimSandboxBackendStatusV1 {
    return {
      backendId: "local-docker-gated-rootful",
      backendKind: "local-process",
      capabilities: [],
      health: "unavailable",
      reason,
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }
}

export function createConfiguredFastManimLocalGatedOciBackendV1(
  options: Readonly<{
    deployment: FastManimSandboxDeployment;
    image: string | undefined;
    localDockerDevOptIn: boolean;
  }>,
): FastManimSandboxBackendV1 {
  const deployment = parseFastManimSandboxDeployment(options.deployment);
  if (deployment === "production" || !options.localDockerDevOptIn || !options.image) {
    return new UnavailableFastManimSandboxBackendV1();
  }
  return new FastManimLocalGatedOciBackendV1({ image: options.image });
}
