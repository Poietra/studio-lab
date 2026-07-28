import {
  createFastManimOciBrokerDispatchV1,
  digestFastManimOciProfileV1,
  type FastManimOciBuildAttestationV1,
  type FastManimOciJobBrokerV1,
  fastManimOciBuildAttestationV1Schema,
  fastManimOciProfileV1Schema,
} from "./fast-manim-oci-sandbox-profile";
import { FastManimRuncJobBrokerV1, isProductionFastManimRuncJobBrokerV1 } from "./fast-manim-runc-job-broker";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  type FastManimSandboxAttestationVerifierV1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";

const BACKEND_ID = "runc-rootless-v1";
const testBackendCapabilityV1 = Object.freeze({ kind: "fast-manim-runc-test-backend" as const });

export interface FastManimRuncProductionBrokerV1 extends FastManimOciJobBrokerV1 {
  /** Probe the real runtime, immutable rootfs, and resource controller. */
  ready(context: FastManimSandboxStatusContextV1): Promise<boolean>;
  releaseAttestation(): Readonly<{
    expiresAt: number;
    issuedAt: number;
    profileDigest: string;
    runtimeDigest: string;
  }>;
}

export type FastManimRuncSandboxBackendOptionsV1 = Readonly<{
  attestation: unknown;
  broker: FastManimRuncProductionBrokerV1;
  profile: unknown;
}>;

function unavailable(reason: "disabled" | "health-check-failed"): FastManimSandboxBackendStatusV1 {
  return {
    backendId: BACKEND_ID,
    backendKind: "production",
    capabilities: [],
    health: "unavailable",
    reason,
    schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
    version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  };
}

function validateStatusContext(context: FastManimSandboxStatusContextV1) {
  parseFastManimSandboxJobIdentityV1(context.identity);
  if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= Date.now()) {
    throw new TypeError("Sandbox status deadline must be a future epoch millisecond integer.");
  }
  context.signal.throwIfAborted();
}

/**
 * Trusted in-process adapter from the closed Studio backend contract to the
 * production runc broker. Runtime/rootfs/cgroup claims remain owned by the
 * broker readiness probe; this adapter never reports ready from configuration
 * alone.
 */
export class FastManimRuncSandboxBackendV1 implements FastManimSandboxBackendV1 {
  readonly #attestation: FastManimOciBuildAttestationV1;
  readonly #broker: FastManimRuncProductionBrokerV1;
  readonly #profile: unknown;
  #closeRequest: Promise<void> | null = null;
  #closing = false;

  constructor(options: FastManimRuncSandboxBackendOptionsV1, testCapability?: typeof testBackendCapabilityV1) {
    if (
      typeof options?.broker?.dispatch !== "function" ||
      typeof options.broker.close !== "function" ||
      typeof options.broker.ready !== "function" ||
      typeof options.broker.releaseAttestation !== "function"
    ) {
      throw new TypeError("The production runc backend requires one complete broker.");
    }
    if (
      (!isProductionFastManimRuncJobBrokerV1(options.broker) ||
        !(options.broker instanceof FastManimRuncJobBrokerV1)) &&
      testCapability !== testBackendCapabilityV1
    ) {
      throw new TypeError("The production runc backend requires its closed broker implementation.");
    }
    const profile = fastManimOciProfileV1Schema.parse(options.profile);
    const attestation = fastManimOciBuildAttestationV1Schema.parse(options.attestation);
    if (attestation.profileDigest !== digestFastManimOciProfileV1(profile)) {
      throw new TypeError("The production runc backend profile does not match its build attestation.");
    }
    const releaseAttestation = options.broker.releaseAttestation();
    if (
      releaseAttestation.profileDigest !== attestation.profileDigest ||
      releaseAttestation.runtimeDigest !== attestation.runtimeDigest
    ) {
      throw new TypeError("The signed runc release does not match its build attestation.");
    }
    this.#attestation = attestation;
    this.#broker = options.broker;
    this.#profile = profile;
  }

  readonly attestationVerifier: FastManimSandboxAttestationVerifierV1 = (status) => {
    try {
      if (
        status.backendId !== BACKEND_ID ||
        status.backendKind !== "production" ||
        status.health !== "ready" ||
        status.attestation.trust !== "verified"
      ) {
        return false;
      }
      const release = this.#broker.releaseAttestation();
      return (
        status.attestation.issuedAt === new Date(release.issuedAt).toISOString() &&
        status.attestation.expiresAt === new Date(release.expiresAt).toISOString() &&
        status.attestation.profileDigest === release.profileDigest &&
        status.attestation.runtimeDigest === release.runtimeDigest
      );
    } catch {
      return false;
    }
  };

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    validateStatusContext(context);
    if (this.#closing) return unavailable("disabled");
    try {
      if ((await this.#broker.ready(context)) !== true) return unavailable("health-check-failed");
      context.signal.throwIfAborted();
      if (this.#closing || Date.now() >= context.deadlineEpochMs) return unavailable("health-check-failed");
      const release = this.#broker.releaseAttestation();
      return {
        attestation: {
          expiresAt: new Date(release.expiresAt).toISOString(),
          issuedAt: new Date(release.issuedAt).toISOString(),
          profileDigest: release.profileDigest,
          runtimeDigest: release.runtimeDigest,
          trust: "verified",
        },
        backendId: BACKEND_ID,
        backendKind: "production",
        capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
        health: "ready",
        schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
        version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return unavailable("health-check-failed");
    }
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!verifyFastManimSandboxRequestBundleV1(request)) {
      throw new TypeError("Sandbox request bytes are not sealed.");
    }
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= Date.now()) {
      throw new TypeError("Sandbox job deadline must be a future epoch millisecond integer.");
    }
    context.signal.throwIfAborted();
    if (this.#closing) {
      return {
        abort() {},
        result: Promise.resolve({
          attestationDigest: context.attestationDigest,
          code: "sandbox-unavailable" as const,
          kind: "failed" as const,
          requestDigest: request.requestDigest,
        }),
      };
    }
    return this.#broker.dispatch(
      createFastManimOciBrokerDispatchV1({
        attestation: this.#attestation,
        context,
        profile: this.#profile,
        request,
      }),
    );
  }

  close() {
    this.#closing = true;
    this.#closeRequest ??= this.#broker.close();
    return this.#closeRequest;
  }
}

/** Unit-test seam only; production cannot certify a structural broker double. */
export function createFastManimRuncSandboxBackendForTestingV1(options: FastManimRuncSandboxBackendOptionsV1) {
  if (process.env.NODE_ENV !== "test") {
    throw new TypeError("The runc test backend factory is unavailable outside the test runtime.");
  }
  return new FastManimRuncSandboxBackendV1(options, testBackendCapabilityV1);
}
