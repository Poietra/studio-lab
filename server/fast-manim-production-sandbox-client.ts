import {
  type FastManimGatedOciReleasePublicKeyV1,
  type FastManimGatedOciSignedReleaseV1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";

type ProductionClientOptions = Readonly<{
  publicKeys: readonly FastManimGatedOciReleasePublicKeyV1[];
  signedRelease: FastManimGatedOciSignedReleaseV1;
  socketPath: string;
}>;

/** Studio verifies the release independently; broker status is never self-authenticating. */
export function createFastManimProductionSandboxClientV1(options: ProductionClientOptions) {
  if (!options || Object.keys(options).sort().join(",") !== "publicKeys,signedRelease,socketPath") {
    throw new TypeError("The production sandbox client configuration is invalid.");
  }
  const release = verifyFastManimGatedOciReleaseV1(options.signedRelease, options.publicKeys);
  return Object.freeze({
    attestationVerifier: release.attestationVerifier,
    backend: new FastManimUdsSandboxBackendV1({ socketPath: options.socketPath }),
  });
}
