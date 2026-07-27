import { createHash } from "node:crypto";

import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  type FastManimSandboxBackendStatusV1,
} from "../fast-manim-sandbox-backend";
import {
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
  type FastManimSnapshotProducerRequestV1,
  fastManimSnapshotSceneIdV1,
} from "../fast-manim-snapshot-contract";
import { runtimeConfig, sceneSource } from "./fast-manim-snapshot-runner-fixture";

export const SANDBOX_TEST_SHA_A = "a".repeat(64);
const SANDBOX_TEST_SHA_B = "b".repeat(64);

export function sandboxProducerRequest(): FastManimSnapshotProducerRequestV1 {
  const sourceHash = createHash("sha256").update(sceneSource, "utf8").digest("hex");
  const config = runtimeConfig();
  return {
    projectId: "default",
    requestId: "snapshot-request-1",
    runtimeConfig: config,
    runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(config),
    sceneId: fastManimSnapshotSceneIdV1("scene.py", "ExampleScene"),
    sceneName: "ExampleScene",
    schema: FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
    snapshotVersion: 1,
    sourceHash,
    sourcePath: "scene.py",
    sourceText: sceneSource,
    version: 1,
  };
}

export function localSandboxReadyStatus(profileDigest = SANDBOX_TEST_SHA_A): FastManimSandboxBackendStatusV1 {
  return {
    attestation: { profileDigest, runtimeDigest: SANDBOX_TEST_SHA_B, trust: "development-only" },
    backendId: "test-local-backend",
    backendKind: "local-process",
    capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
    health: "ready",
    schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
    version: 1,
  };
}

export function productionSandboxReadyStatus(profileDigest = SANDBOX_TEST_SHA_A): FastManimSandboxBackendStatusV1 {
  return {
    attestation: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      profileDigest,
      runtimeDigest: SANDBOX_TEST_SHA_B,
      trust: "verified",
    },
    backendId: "test-production-backend",
    backendKind: "production",
    capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
    health: "ready",
    schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
    version: 1,
  };
}
