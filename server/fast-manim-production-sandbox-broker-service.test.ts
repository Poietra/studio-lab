import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

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
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import {
  assertFastManimProductionHostMaterialsV1,
  createFastManimProductionGatedOciBackendV1,
  parseFastManimRootlessDockerInfoV1,
} from "./fast-manim-production-gated-oci-backend";
import { createFastManimProductionSandboxClientV1 } from "./fast-manim-production-sandbox-client";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";

const dockerSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: dockerSpawn,
}));

const SERVER_VERSION = "28.3.3";

function completedDockerProcess(code: number) {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: PassThrough;
    stdout: PassThrough;
  };
  child.kill = vi.fn();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

function productionRelease(keyId = "studio-release-key") {
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
    expiresAt: issuedAt + 10 * 60_000,
    issuedAt,
    keyId,
    runtimeDigest: digestFastManimGatedOciRuntimeV1(material),
    schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
    version: 1 as const,
  };
  return {
    publicKeys: [
      { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
    ],
    signedRelease: {
      payload,
      signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
    },
  };
}

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

  it("keeps the production backend unavailable while the current native artifact digest is pending", async () => {
    const release = productionRelease();
    const verifiedRelease = verifyFastManimGatedOciReleaseV1(release.signedRelease, release.publicKeys);
    await expect(
      createFastManimProductionGatedOciBackendV1({
        dockerSocketPath: "/missing/docker.sock",
        seccompPath: "/missing/seccomp.json",
        verifiedRelease,
      }),
    ).rejects.toThrow(/awaiting its pinned-builder MathTex artifact digest/i);
  });

  it("pins every explicit Docker command to the configured Unix socket without fallback", async () => {
    const missingSocket = `/tmp/poietra-missing-docker-${process.pid}.sock`;
    dockerSpawn.mockReset();
    dockerSpawn.mockReturnValueOnce(completedDockerProcess(17));

    const result = await new FastManimGatedOciDockerClientV1({ socketPath: missingSocket }).run([
      "info",
      "--format",
      "{{json .}}",
    ]);

    expect(result).toEqual({ code: 17, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) });
    expect(dockerSpawn).toHaveBeenCalledOnce();
    expect(dockerSpawn).toHaveBeenCalledWith(
      "/usr/bin/docker",
      ["--host", `unix://${missingSocket}`, "info", "--format", "{{json .}}"],
      { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );
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

  it("rejects a Studio principal that is the broker or is outside the socket group", async () => {
    const brokerUserId = process.geteuid!();
    const socketGroupId = process.getegid!();
    const release = productionRelease();
    const options = {
      brokerUserId,
      ...release,
      socketGroupId,
      socketPath: "/missing/production-broker.sock",
    };
    try {
      vi.spyOn(process, "geteuid").mockReturnValue(brokerUserId);
      await expect(createFastManimProductionSandboxClientV1(options)).rejects.toThrow(/distinct effective user/i);
      vi.restoreAllMocks();

      vi.spyOn(process, "geteuid").mockReturnValue(brokerUserId + 1);
      vi.spyOn(process, "getegid").mockReturnValue(socketGroupId + 1);
      vi.spyOn(process, "getgroups").mockReturnValue([]);
      await expect(createFastManimProductionSandboxClientV1(options)).rejects.toThrow(/member/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("verifies the broker-owned directory and socket before composing the Studio client", async () => {
    const brokerUserId = process.geteuid!();
    const socketGroupId = process.getegid!();
    const root = await mkdtemp(join(tmpdir(), "poietra-production-client-"));
    const directory = join(root, "broker");
    await mkdir(directory, { mode: 0o750 });
    const socketPath = join(directory, "broker.sock");
    const server = createServer((socket) => socket.destroy());
    let client: Awaited<ReturnType<typeof createFastManimProductionSandboxClientV1>> | undefined;
    try {
      server.listen(socketPath);
      await once(server, "listening");
      await chmod(socketPath, 0o660);
      vi.spyOn(process, "geteuid").mockReturnValue(brokerUserId + 1);
      vi.spyOn(process, "getgroups").mockReturnValue([socketGroupId]);
      const options = { brokerUserId, ...productionRelease(), socketGroupId, socketPath };

      await chmod(root, 0o777);
      await expect(createFastManimProductionSandboxClientV1(options)).rejects.toThrow(/ancestor/i);
      await chmod(root, 0o750);
      await chmod(directory, 0o700);
      await expect(createFastManimProductionSandboxClientV1(options)).rejects.toThrow(/0750/i);
      await chmod(directory, 0o750);
      await chmod(socketPath, 0o600);
      await expect(createFastManimProductionSandboxClientV1(options)).rejects.toThrow(/0660/i);
      await chmod(socketPath, 0o660);
      client = await createFastManimProductionSandboxClientV1(options);

      expect(client.backend).toBeInstanceOf(FastManimUdsSandboxBackendV1);
      expect(client.attestationVerifier).toBeTypeOf("function");
      expect(client.profileDigest).toBe(options.signedRelease.payload.profileDigest);
      expect(client.runtimeDigest).toBe(options.signedRelease.payload.runtimeDigest);
    } finally {
      vi.restoreAllMocks();
      await client?.backend.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { force: true, recursive: true });
    }
  });
});
