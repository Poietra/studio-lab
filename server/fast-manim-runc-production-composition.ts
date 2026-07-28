import { createHash } from "node:crypto";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  createProcessLinuxCgroupV2ResourceControllerV1,
  deriveLinuxCgroupV2OrchestratorPathV1,
  type ProcessLinuxCgroupV2ResourceControllerOptionsV1,
} from "./fast-manim-linux-cgroup-v2";
import {
  digestFastManimOciProfileV1,
  type FastManimOciBuildAttestationV1,
  type FastManimOciProfileV1,
  fastManimOciBuildAttestationV1Schema,
  fastManimOciProfileV1Schema,
} from "./fast-manim-oci-sandbox-profile";
import { FastManimRuncJobBrokerV1 } from "./fast-manim-runc-job-broker";
import { FastManimRuncJobBundleStoreV1 } from "./fast-manim-runc-job-bundle";
import { FastManimRuncMountedRootfsRegistryV1 } from "./fast-manim-runc-mounted-rootfs";
import type { FastManimRuncOciSpecGeneratorOptionsV1 } from "./fast-manim-runc-oci-spec";
import {
  type FastManimRuncReleaseTrustOptionsV1,
  FastManimRuncReleaseTrustV1,
  type FastManimRuncSignedReleaseV1,
} from "./fast-manim-runc-release-trust";
import {
  type FastManimRuncRootlessIdentityMapOptionsV1,
  FastManimRuncRootlessIdentityMapV1,
} from "./fast-manim-runc-rootless-identity";
import { FastManimRuncCliRuntimeV1 } from "./fast-manim-runc-runtime";
import { FastManimRuncSandboxBackendV1 } from "./fast-manim-runc-sandbox-backend";
import {
  type FastManimSandboxResourceLimitsV1,
  parseFastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

export type FastManimRuncProductionRootfsOptionsV1 = Readonly<{
  format: "erofs" | "squashfs";
  imagePath: string;
  rootfsDigest: string;
  rootfsPath: string;
}>;

export type FastManimRuncProductionCompositionOptionsV1 = Readonly<{
  attestation: FastManimOciBuildAttestationV1;
  bundleRoot: string;
  cgroup: ProcessLinuxCgroupV2ResourceControllerOptionsV1;
  identityMap: FastManimRuncRootlessIdentityMapOptionsV1;
  limits: FastManimSandboxResourceLimitsV1;
  profile: FastManimOciProfileV1;
  releasePublicKeys: FastManimRuncReleaseTrustOptionsV1["publicKeys"];
  rootfs: FastManimRuncProductionRootfsOptionsV1;
  runtimeStateRoot: string;
  seccomp: FastManimRuncOciSpecGeneratorOptionsV1["seccomp"];
  signedRelease: FastManimRuncSignedReleaseV1;
  startupSignal: AbortSignal;
}>;

async function rethrowAfterCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "The production runc composition could not be cleaned up.");
  }
  throw error;
}

/**
 * Builds the single process-owned production backend from closed host
 * configuration. The cgroup controller is initialized last because it is the
 * only process-global resource acquired during composition.
 */
export async function createFastManimRuncProductionCompositionV1(
  options: FastManimRuncProductionCompositionOptionsV1,
): Promise<FastManimRuncSandboxBackendV1> {
  if (!(options?.startupSignal instanceof AbortSignal)) {
    throw new TypeError("The production runc composition requires a startup signal.");
  }
  options.startupSignal.throwIfAborted();

  const profile = fastManimOciProfileV1Schema.parse(options.profile);
  const attestation = fastManimOciBuildAttestationV1Schema.parse(options.attestation);
  const limits = parseFastManimSandboxResourceLimitsV1(options.limits);
  if (
    attestation.profileDigest !== digestFastManimOciProfileV1(profile) ||
    attestation.seccompDigest !== createHash("sha256").update(canonicalJsonV1(options.seccomp), "utf8").digest("hex")
  ) {
    throw new TypeError("The production runc materials do not match their build attestation.");
  }

  const identityMap = new FastManimRuncRootlessIdentityMapV1(options.identityMap);
  const bundleStore = new FastManimRuncJobBundleStoreV1({ identityMap, root: options.bundleRoot });
  const runtime = new FastManimRuncCliRuntimeV1({
    bundleRoot: options.bundleRoot,
    stateRoot: options.runtimeStateRoot,
  });
  deriveLinuxCgroupV2OrchestratorPathV1(options.cgroup.root);
  const rootfsRegistry = new FastManimRuncMountedRootfsRegistryV1(options.rootfs);
  const release = new FastManimRuncReleaseTrustV1({
    publicKeys: options.releasePublicKeys,
    rootfsRegistry,
  }).verify(options.signedRelease);
  const releaseAttestation = release.attestation();
  if (
    releaseAttestation.profileDigest !== attestation.profileDigest ||
    releaseAttestation.runtimeDigest !== attestation.runtimeDigest
  ) {
    throw new TypeError("The signed runc release does not match its build attestation.");
  }
  await release.assertReady(options.startupSignal);
  options.startupSignal.throwIfAborted();

  const resourceController = createProcessLinuxCgroupV2ResourceControllerV1(options.cgroup);
  let broker: FastManimRuncJobBrokerV1 | undefined;
  try {
    await resourceController.initialize();
    options.startupSignal.throwIfAborted();
    broker = new FastManimRuncJobBrokerV1({
      bundleStore,
      identityMap,
      limits,
      profile,
      release,
      resourceController,
      runtime,
      seccomp: options.seccomp,
    });
    return new FastManimRuncSandboxBackendV1({ attestation, broker, profile });
  } catch (error) {
    return rethrowAfterCleanup(error, () => (broker ? broker.close() : resourceController.shutdown()));
  }
}
