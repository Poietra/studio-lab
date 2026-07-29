import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import { startFastManimProductionSandboxBrokerServiceV1 } from "./fast-manim-production-sandbox-broker-service";
import { FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1 } from "./fast-manim-production-sandbox-transport";
import {
  FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1,
  type FastManimSnapshotRunRequestV1,
} from "./fast-manim-snapshot-contract";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import type { FastManimSnapshotSourceProviderV1 } from "./fast-manim-snapshot-source-provider";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";
import {
  FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1,
  FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1,
} from "./test-fixtures/fast-manim-sandbox-conformance-fixture";

const required = process.env.POIETRA_FAST_MANIM_PRODUCTION_REQUIRED === "1";
const dockerSocketPath = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET;
const imageDigest = process.env.POIETRA_FAST_MANIM_PRODUCTION_IMAGE;
const seccompPath = process.env.POIETRA_FAST_MANIM_PRODUCTION_SECCOMP;
const dockerServerVersion = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION;
const requested =
  required || [dockerSocketPath, imageDigest, seccompPath, dockerServerVersion].some((value) => value !== undefined);
const FRAME = { height: 8, width: 14.222222222222221 } as const;
const PROJECT_ID = "default";
const TENANT_ID = "real-production";
const MATHTEX_CONFORMANCE_CASE_V3 = Object.freeze({
  expectedKind: "compiled" as const,
  sceneName: "GatedMathTexScene",
  sourcePath: "mathtex.py",
  sourceText: `from manim import MathTex, Scene

# ${FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1.join(" ")}
class GatedMathTexScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
`,
});

type ConformanceCase =
  | (typeof FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1)[keyof typeof FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1]
  | typeof MATHTEX_CONFORMANCE_CASE_V3;

function sourceHash(sourceText: string) {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}

function conformanceSourceProvider(): FastManimSnapshotSourceProviderV1 {
  const cases = new Map<string, ConformanceCase>(
    [...Object.values(FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1), MATHTEX_CONFORMANCE_CASE_V3].map(
      (testCase) => [testCase.sourcePath, testCase] as const,
    ),
  );
  return {
    async readVerified(sourcePath, signal) {
      signal?.throwIfAborted();
      const testCase = cases.get(sourcePath);
      if (!testCase) throw new Error("The requested snapshot conformance source does not exist.");
      const hash = sourceHash(testCase.sourceText);
      return { hash, source: testCase.sourceText, versionToken: hash };
    },
  };
}

function runRequest(testCase: ConformanceCase, requestId: string): FastManimSnapshotRunRequestV1 {
  return {
    projectId: PROJECT_ID,
    requestId,
    sceneName: testCase.sceneName,
    sourceHash: sourceHash(testCase.sourceText),
    sourcePath: testCase.sourcePath,
  };
}

function expectNoConformanceLeak(value: unknown) {
  const wire = JSON.stringify(value);
  for (const sentinel of FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1) expect(wire).not.toContain(sentinel);
}

describe.skipIf(!requested)("production sandbox broker real rootless lane", () => {
  beforeAll(() => {
    if (
      !dockerSocketPath ||
      !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") ||
      !seccompPath ||
      !dockerServerVersion ||
      process.geteuid?.() === undefined ||
      process.geteuid() === 0 ||
      process.getegid?.() === undefined
    ) {
      throw new TypeError(
        "The required production snapshot lane needs a non-root principal and explicit Docker socket, image, seccomp, and Docker-version inputs.",
      );
    }
  });

  it("seals V1 conformance and a real V3 MathTex outline through the production UDS runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poietra-production-broker-"));
    await chmod(directory, 0o750);
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
      expiresAt: issuedAt + 10 * 60_000,
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
    let client: FastManimUdsSandboxBackendV1 | undefined;
    let runner: FastManimSnapshotRunner | undefined;
    let mathTexClient: FastManimUdsSandboxBackendV1 | undefined;
    let mathTexRunner: FastManimSnapshotRunner | undefined;
    let operationError: unknown;
    let operationFailed = false;
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
      const verifiedRelease = verifyFastManimGatedOciReleaseV1(signedRelease, publicKeys);
      client = new FastManimUdsSandboxBackendV1({
        closeTimeoutMs: FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
        socketPath,
      });
      runner = new FastManimSnapshotRunner({
        attestationVerifier: verifiedRelease.attestationVerifier,
        backend: client,
        deployment: "production",
        frame: FRAME,
        projectId: PROJECT_ID,
        sourceProvider: conformanceSourceProvider(),
        tenantId: TENANT_ID,
        timeoutMs: 60_000,
      });
      mathTexClient = new FastManimUdsSandboxBackendV1({
        closeTimeoutMs: FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1,
        socketPath,
      });
      mathTexRunner = new FastManimSnapshotRunner({
        attestationVerifier: verifiedRelease.attestationVerifier,
        backend: mathTexClient,
        deployment: "production",
        frame: FRAME,
        projectId: PROJECT_ID,
        snapshotVersion: 3,
        sourceProvider: conformanceSourceProvider(),
        tenantId: TENANT_ID,
        timeoutMs: 60_000,
      });

      const supportedCase = FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1.supported;
      const supported = await runner.runUnpublished(
        runRequest(supportedCase, "real-production-supported"),
        abort.signal,
      );
      expect(supported.status).toBe("verified");
      if (supported.status !== "verified" || supported.snapshot.kind !== supportedCase.expectedKind) {
        throw new Error("The production broker did not return the shared compiled Scene.");
      }
      const supportedBundle = await parseVerifiedSceneIrBundleV1(supported.snapshot.bundle);
      expect(supportedBundle.scene.entities).toHaveLength(3);
      expectNoConformanceLeak(supported);

      const mathTex = await mathTexRunner.runUnpublished(
        runRequest(MATHTEX_CONFORMANCE_CASE_V3, "real-production-mathtex-v3"),
        abort.signal,
      );
      expect(mathTex.status).toBe("verified");
      if (mathTex.status !== "verified" || mathTex.snapshot.kind !== MATHTEX_CONFORMANCE_CASE_V3.expectedKind) {
        throw new Error("The production broker did not return a verified hermetic MathTex V3 snapshot.");
      }
      const mathTexBundle = await parseVerifiedSceneIrBundleV1(mathTex.snapshot.bundle);
      expect(mathTexBundle.scene.source).toMatchObject({
        kind: "imported-manim-server-snapshot",
        snapshotVersion: 3,
      });
      expect(mathTexBundle.scene.requiredCapabilities).toEqual(["cubic-path-geometry"]);
      expect(mathTexBundle.scene.entities).toHaveLength(1);
      const mathTexEntity = mathTexBundle.scene.entities[0]!;
      if (mathTexEntity.geometry.kind !== "cubic-path" || mathTexEntity.appearance.kind !== "vector") {
        throw new Error("The production MathTex snapshot did not contain one vector cubic outline.");
      }
      expect(mathTexEntity.geometry.path.subpaths.length).toBeGreaterThan(1);
      expect(
        mathTexEntity.geometry.path.subpaths.every((subpath) => subpath.closed && subpath.segments.length > 0),
      ).toBe(true);
      expect(mathTexEntity.appearance).toEqual({
        fill: {
          color: { alpha: 1, blue: 1, green: 1, red: 1 },
          rule: "nonzero",
        },
        kind: "vector",
        opacity: 1,
        stroke: null,
      });
      expect(mathTex.sourceRuntimeIdentity?.mappings).toMatchObject([
        {
          binding: { name: "equation" },
          entityId: mathTexEntity.id,
        },
      ]);
      expect(mathTex.sourceRuntimeIdentity?.mappings).toHaveLength(1);
      const mathTexWire = JSON.stringify(mathTex);
      expectNoConformanceLeak(mathTex);
      expect(mathTexWire).not.toContain("E = mc^2");
      expect(mathTexWire).not.toContain("poietra_mathtex_outline");
      expect(mathTexWire).not.toContain(".so");

      const unsupportedCase = FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1.unsupported;
      const unsupported = await runner.runUnpublished(
        runRequest(unsupportedCase, "real-production-unsupported"),
        abort.signal,
      );
      expect(unsupported.status).toBe("unsupported");
      if (unsupported.status !== "unsupported") {
        throw new Error("The production broker did not return structured unsupported evidence.");
      }
      expect(unsupported.fallback).toEqual({ kind: "server-authoritative-render" });
      expect(unsupported.issues.length).toBeGreaterThan(0);
      for (const issue of unsupported.issues) {
        expect(issue.message).toBe(FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1[issue.code]);
        expect(issue.evidence).toEqual([]);
        expect("runtimeObjectId" in issue).toBe(false);
      }
      expectNoConformanceLeak(unsupported);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    const clientCleanup = await Promise.allSettled([
      runner?.close() ?? client?.close() ?? Promise.resolve(),
      mathTexRunner?.close() ?? mathTexClient?.close() ?? Promise.resolve(),
    ]);
    abort.abort();
    const brokerCleanup = await Promise.allSettled([broker?.close() ?? Promise.resolve()]);
    await rm(directory, { force: true, recursive: true });
    const errors = [
      ...(operationFailed ? [operationError] : []),
      ...[...clientCleanup, ...brokerCleanup].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, "The real production broker lane did not execute and close safely.");
    }
  }, 300_000);
});
