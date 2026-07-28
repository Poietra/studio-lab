import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_PROFILE_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  FastManimGatedOciDockerClientV1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
} from "./fast-manim-gated-oci-release";
import {
  assertFastManimProductionHostMaterialsV1,
  createFastManimProductionGatedOciBackendV1,
  parseFastManimRootlessDockerInfoV1,
} from "./fast-manim-production-gated-oci-backend";
import { createFastManimProductionSandboxClientV1 } from "./fast-manim-production-sandbox-client";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";

const SERVER_VERSION = "28.3.3";

function dockerInfo(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      CgroupDriver: "systemd",
      CgroupVersion: "2",
      OSType: "linux",
      SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
      ServerVersion: SERVER_VERSION,
      ...overrides,
    }),
  );
}

describe("production gated OCI host contract", () => {
  it("accepts only rootless Linux Docker with cgroup v2, systemd, and the signed server version", () => {
    expect(parseFastManimRootlessDockerInfoV1(dockerInfo(), SERVER_VERSION)).toEqual({
      cgroupDriver: "systemd",
      cgroupVersion: "2",
      rootless: true,
      serverVersion: SERVER_VERSION,
    });
    for (const report of [
      dockerInfo({ SecurityOptions: ["name=seccomp,profile=builtin"] }),
      dockerInfo({ CgroupVersion: "1" }),
      dockerInfo({ CgroupDriver: "cgroupfs" }),
      dockerInfo({ OSType: "windows" }),
      dockerInfo({ ServerVersion: "28.3.2" }),
      Buffer.from("not-json"),
      Buffer.alloc(32 * 1024 + 1),
    ]) {
      expect(() => parseFastManimRootlessDockerInfoV1(report, SERVER_VERSION)).toThrow();
    }
  });

  it("binds the compiled profile and actual seccomp document to their canonical digests", async () => {
    const seccomp = JSON.parse(
      await readFile(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex")).toBe(
      FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
    );
    expect(createHash("sha256").update(canonicalJsonV1(FAST_MANIM_GATED_OCI_PROFILE_V1), "utf8").digest("hex")).toBe(
      FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
    );
  });

  it("never falls back from an explicitly missing Docker socket to the default daemon", async () => {
    const missingSocket = `/tmp/poietra-missing-docker-${process.pid}.sock`;
    const explicit = new FastManimGatedOciDockerClientV1({ socketPath: missingSocket });
    const explicitResult = await explicit.run(["info", "--format", "{{json .}}"], 2_000);
    expect(explicitResult.code).not.toBe(0);

    const defaultResult = await new FastManimGatedOciDockerClientV1().run(["info", "--format", "{{json .}}"], 2_000);
    expect(Number.isInteger(defaultResult.code)).toBe(true);
    if (defaultResult.code === 0) {
      const report = JSON.parse(defaultResult.stdout.toString("utf8")) as {
        SecurityOptions?: unknown;
        ServerVersion?: unknown;
      };
      if (
        typeof report.ServerVersion === "string" &&
        Array.isArray(report.SecurityOptions) &&
        !report.SecurityOptions.includes("name=rootless")
      ) {
        expect(() => parseFastManimRootlessDockerInfoV1(defaultResult.stdout, report.ServerVersion as string)).toThrow(
          /rootless/i,
        );
      }
    }
  });

  it("rejects missing host materials and every public production test seam", async () => {
    await expect(
      assertFastManimProductionHostMaterialsV1(
        `/tmp/poietra-missing-docker-${process.pid}.sock`,
        `/tmp/poietra-missing-seccomp-${process.pid}.json`,
      ),
    ).rejects.toThrow();
    await expect(
      createFastManimProductionGatedOciBackendV1({
        dockerSocketPath: "/missing/docker.sock",
        executeJob: async () => undefined,
        seccompPath: "/missing/seccomp.json",
        verifiedRelease: undefined,
      } as never),
    ).rejects.toThrow(/configuration/i);
    await expect(
      createFastManimProductionGatedOciBackendV1({
        dockerSocketPath: "/missing/docker.sock",
        seccompPath: "/missing/seccomp.json",
        verifiedRelease: { descriptor: () => ({ imageDigest: `sha256:${"a".repeat(64)}` }) },
      } as never),
    ).rejects.toThrow(/configuration/i);
  });

  it("composes the Studio UDS adapter and verifier from one signed release", () => {
    const keys = generateKeyPairSync("ed25519");
    const issuedAt = Date.now() - 1_000;
    const material = {
      dockerServerVersion: SERVER_VERSION,
      imageDigest: `sha256:${"a".repeat(64)}`,
      profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
      seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
    };
    const payload = {
      ...material,
      expiresAt: issuedAt + 60_000,
      issuedAt,
      keyId: "studio-release-key",
      runtimeDigest: digestFastManimGatedOciRuntimeV1(material),
      schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
      version: 1 as const,
    };
    const signedRelease = {
      payload,
      signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
    };
    const client = createFastManimProductionSandboxClientV1({
      publicKeys: [
        { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
      ],
      signedRelease,
      socketPath: "/run/poietra/sandbox-broker.sock",
    });

    expect(client.backend).toBeInstanceOf(FastManimUdsSandboxBackendV1);
    expect(client.attestationVerifier).toBeTypeOf("function");
  });
});
