import {
  type FastManimGatedOciReleasePublicKeyV1,
  type FastManimGatedOciSignedReleaseV1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import { createFastManimProductionGatedOciBackendV1 } from "./fast-manim-production-gated-oci-backend";
import {
  assertFastManimProductionBrokerSocketDirectoryV1,
  FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
} from "./fast-manim-production-sandbox-transport";
import {
  type FastManimSandboxBrokerServerV1,
  startFastManimSandboxBrokerServerV1,
} from "./fast-manim-sandbox-broker-server";

export type FastManimProductionSandboxBrokerServiceV1 = FastManimSandboxBrokerServerV1 &
  Readonly<{ fatal: Promise<void> }>;

export type FastManimProductionSandboxBrokerServiceOptionsV1 = Readonly<{
  brokerUserId: number;
  dockerSocketPath: string;
  publicKeys: readonly FastManimGatedOciReleasePublicKeyV1[];
  seccompPath: string;
  signal?: AbortSignal;
  signedRelease: FastManimGatedOciSignedReleaseV1;
  socketGroupId: number;
  socketPath: string;
}>;

function brokerIdentity(expectedUserId: number) {
  const effectiveUserId = process.geteuid?.();
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    effectiveUserId === undefined ||
    effectiveUserId !== expectedUserId
  ) {
    throw new TypeError("The production broker must run as its configured non-root user.");
  }
  return effectiveUserId;
}

/** Launches the separately supervised production broker after every host trust check succeeds. */
export async function startFastManimProductionSandboxBrokerServiceV1(
  options: FastManimProductionSandboxBrokerServiceOptionsV1,
): Promise<FastManimProductionSandboxBrokerServiceV1> {
  if (!options) throw new TypeError("Production broker configuration is required.");
  brokerIdentity(options.brokerUserId);
  options.signal?.throwIfAborted();
  await assertFastManimProductionBrokerSocketDirectoryV1(
    options.socketPath,
    options.brokerUserId,
    options.socketGroupId,
  );
  options.signal?.throwIfAborted();
  const verifiedRelease = verifyFastManimGatedOciReleaseV1(options.signedRelease, options.publicKeys);
  const backend = await createFastManimProductionGatedOciBackendV1({
    dockerSocketPath: options.dockerSocketPath,
    seccompPath: options.seccompPath,
    verifiedRelease,
  });
  let reportFatal!: () => void;
  const fatal = new Promise<void>((resolveFatal) => {
    reportFatal = resolveFatal;
  });
  try {
    const broker = await startFastManimSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
      onFatalClose: reportFatal,
      reconcileOrphans: (signal) => backend.reconcileOrphans(signal),
      ...(options.signal ? { signal: options.signal } : {}),
      socketGroupId: options.socketGroupId,
      socketPath: options.socketPath,
    });
    return { ...broker, fatal };
  } catch (error) {
    try {
      await backend.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "The production broker failed to start and close safely.");
    }
    throw error;
  }
}
