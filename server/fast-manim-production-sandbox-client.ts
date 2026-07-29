import {
  type FastManimGatedOciReleasePublicKeyV1,
  type FastManimGatedOciSignedReleaseV1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import {
  assertFastManimProductionBrokerSocketV1,
  FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
} from "./fast-manim-production-sandbox-transport";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";

export type FastManimProductionSandboxClientOptionsV1 = Readonly<{
  brokerUserId: number;
  publicKeys: readonly FastManimGatedOciReleasePublicKeyV1[];
  signedRelease: FastManimGatedOciSignedReleaseV1;
  socketGroupId: number;
  socketPath: string;
}>;

function assertStudioPrincipal(brokerUserId: number, socketGroupId: number) {
  const studioUserId = process.geteuid?.();
  const studioGroupIds = new Set([process.getegid?.(), ...(process.getgroups?.() ?? [])]);
  if (
    !Number.isSafeInteger(brokerUserId) ||
    brokerUserId <= 0 ||
    brokerUserId > 0xffff_ffff ||
    !Number.isSafeInteger(socketGroupId) ||
    socketGroupId < 0 ||
    socketGroupId > 0xffff_ffff ||
    studioUserId === undefined ||
    studioUserId === brokerUserId ||
    !studioGroupIds.has(socketGroupId)
  ) {
    throw new TypeError("Studio must be a distinct effective user and a member of the configured broker socket group.");
  }
}

/** Studio verifies the release independently; broker status is never self-authenticating. */
export async function createFastManimProductionSandboxClientV1(options: FastManimProductionSandboxClientOptionsV1) {
  if (
    !options ||
    Object.keys(options).sort().join(",") !== "brokerUserId,publicKeys,signedRelease,socketGroupId,socketPath"
  ) {
    throw new TypeError("The production sandbox client configuration is invalid.");
  }
  assertStudioPrincipal(options.brokerUserId, options.socketGroupId);
  await assertFastManimProductionBrokerSocketV1(options.socketPath, options.brokerUserId, options.socketGroupId);
  const release = verifyFastManimGatedOciReleaseV1(options.signedRelease, options.publicKeys);
  const { profileDigest, runtimeDigest } = release.descriptor();
  return Object.freeze({
    attestationVerifier: release.attestationVerifier,
    backend: new FastManimUdsSandboxBackendV1({
      closeTimeoutMs: FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
      socketPath: options.socketPath,
    }),
    profileDigest,
    runtimeDigest,
  });
}
