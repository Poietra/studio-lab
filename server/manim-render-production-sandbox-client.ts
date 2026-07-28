import { assertFastManimProductionBrokerSocketV1 } from "./fast-manim-production-sandbox-transport";
import {
  digestManimRenderGatedOciRuntimeV1,
  MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
} from "./manim-render-gated-oci-job-runner";
import { ManimRenderUdsSandboxBackendV1 } from "./manim-render-uds-sandbox-backend";

export type ManimRenderProductionSandboxClientOptionsV1 = Readonly<{
  brokerUserId: number;
  imageDigest: string;
  socketGroupId: number;
  socketPath: string;
}>;

function assertStudioPrincipal(brokerUserId: number, socketGroupId: number) {
  const studioUserId = process.geteuid?.();
  const studioGroups = new Set([process.getegid?.(), ...(process.getgroups?.() ?? [])]);
  if (
    !Number.isSafeInteger(brokerUserId) ||
    brokerUserId <= 0 ||
    studioUserId === undefined ||
    studioUserId <= 0 ||
    studioUserId === brokerUserId ||
    !Number.isSafeInteger(socketGroupId) ||
    socketGroupId < 0 ||
    !studioGroups.has(socketGroupId)
  ) {
    throw new TypeError("Studio must use the configured render broker group as a distinct non-root principal.");
  }
}

/** Closed Studio-side production client. Expected runtime identity comes from the immutable image digest. */
export async function createManimRenderProductionSandboxClientV1(options: ManimRenderProductionSandboxClientOptionsV1) {
  if (!options || Object.keys(options).sort().join(",") !== "brokerUserId,imageDigest,socketGroupId,socketPath") {
    throw new TypeError("The production render sandbox client configuration is invalid.");
  }
  assertStudioPrincipal(options.brokerUserId, options.socketGroupId);
  await assertFastManimProductionBrokerSocketV1(options.socketPath, options.brokerUserId, options.socketGroupId);
  return Object.freeze({
    backend: new ManimRenderUdsSandboxBackendV1({ socketPath: options.socketPath }),
    profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
    runtimeDigest: digestManimRenderGatedOciRuntimeV1(options.imageDigest),
  });
}
