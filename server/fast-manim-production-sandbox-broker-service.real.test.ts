import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
} from "./fast-manim-gated-oci-release";
import { startFastManimProductionSandboxBrokerServiceV1 } from "./fast-manim-production-sandbox-broker-service";
import { createFastManimProductionSandboxClientV1 } from "./fast-manim-production-sandbox-client";
import { FastManimSandboxRequestBundleV1, resolveFastManimSandboxReadiness } from "./fast-manim-sandbox-backend";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const dockerSocketPath = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET;
const imageDigest = process.env.POIETRA_FAST_MANIM_PRODUCTION_IMAGE;
const seccompPath = process.env.POIETRA_FAST_MANIM_PRODUCTION_SECCOMP;
const dockerServerVersion = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION;
const realLane =
  process.geteuid?.() !== 0 &&
  !!dockerSocketPath &&
  /^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "") &&
  !!seccompPath &&
  !!dockerServerVersion;

describe.skipIf(!realLane)("production sandbox broker real rootless lane", () => {
  it("executes through the signed rootless runtime over an actual Unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poietra-production-broker-"));
    const socketPath = join(directory, "broker.sock");
    const keys = generateKeyPairSync("ed25519");
    const issuedAt = Date.now() - 1_000;
    const material = {
      dockerServerVersion: dockerServerVersion!,
      imageDigest: imageDigest!,
      profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
      seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
    };
    const payload = {
      ...material,
      expiresAt: issuedAt + 60_000,
      issuedAt,
      keyId: "real-lane-key",
      runtimeDigest: digestFastManimGatedOciRuntimeV1(material),
      schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
      version: 1 as const,
    };
    const signedRelease = {
      payload,
      signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
    };
    const publicKeys = [
      { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
    ];
    const abort = new AbortController();
    let broker: Awaited<ReturnType<typeof startFastManimProductionSandboxBrokerServiceV1>> | undefined;
    let client: ReturnType<typeof createFastManimProductionSandboxClientV1> | undefined;
    try {
      broker = await startFastManimProductionSandboxBrokerServiceV1({
        brokerUserId: process.geteuid!(),
        dockerSocketPath: dockerSocketPath!,
        publicKeys,
        seccompPath: seccompPath!,
        signal: abort.signal,
        signedRelease,
        socketGroupId: process.getegid!(),
        socketPath,
      });
      client = createFastManimProductionSandboxClientV1({ publicKeys, signedRelease, socketPath });
      const identity = { projectId: "default", requestId: "real-production", tenantId: "real-production" };
      const status = await client.backend.status({
        deadlineEpochMs: Date.now() + 20_000,
        identity,
        signal: abort.signal,
      });
      const readiness = resolveFastManimSandboxReadiness(status, "production", Date.now(), client.attestationVerifier);
      if (readiness.kind !== "ready") throw new Error("The real production broker did not become ready.");
      const request = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
      const result = await client.backend.start(request, {
        attestationDigest: readiness.attestationDigest,
        deadlineEpochMs: Date.now() + 30_000,
        identity,
        signal: abort.signal,
      }).result;
      expect(result).toMatchObject({ kind: "ok", requestDigest: request.requestDigest });
    } finally {
      abort.abort();
      await Promise.allSettled([client?.backend.close(), broker?.close()]);
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);
});
