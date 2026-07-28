import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  createFastManimOciAssetArchiveV1,
  createFastManimOciAssetTarV1,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1,
  runFastManimLocalOciConformanceV1,
} from "./fast-manim-local-oci-conformance";
import {
  createFastManimOciBrokerDispatchV1,
  digestFastManimOciProfileV1,
  FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1,
  FastManimOciBrokerDispatchV1,
  fastManimOciBuildAttestationV1Schema,
  fastManimOciJobDescriptorV1Schema,
  fastManimOciProfileV1Schema,
  prepareFastManimOciAssetsV1,
} from "./fast-manim-oci-sandbox-profile";
import { FastManimSandboxRequestBundleV1, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES } from "./fast-manim-sandbox-backend";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const profilePath = resolve("sandbox/fast-manim-oci/profile.v1.json");
const buildScript = resolve("scripts/fast-manim-oci-build.mjs");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function attestation(overrides: Readonly<Record<string, unknown>> = {}) {
  const profileDigest = digestFastManimOciProfileV1(profile);
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest,
    seccompDigest: "6".repeat(64),
  };
  return {
    buildLockDigest: material.lockDigest,
    fastManim: { archiveSha256: "7".repeat(64), commit: "8".repeat(40), tree: "9".repeat(40) },
    imageConfigDigest: material.imageConfigDigest,
    imageDigest: material.imageDigest,
    platform: "linux/amd64",
    profileDigest,
    runtimeDigest: createHash("sha256")
      .update(
        JSON.stringify(Object.fromEntries(Object.entries(material).sort(([left], [right]) => (left < right ? -1 : 1)))),
      )
      .digest("hex"),
    sbom: {
      digest: material.inventoryDigest,
      schema: "poietra.fast-manim-oci-sbom",
      signed: false,
      toolchainDigest: "a".repeat(64),
    },
    schema: "poietra.fast-manim-oci-build-attestation",
    seccompDigest: material.seccompDigest,
    version: 1,
    ...overrides,
  };
}

function context() {
  return {
    attestationDigest: "b".repeat(64),
    deadlineEpochMs: Date.now() + 60_000,
    identity: { projectId: "default", requestId: "request-1", tenantId: "tenant-1" },
    signal: new AbortController().signal,
  };
}

describe("fast-manim OCI profile and broker descriptor", () => {
  it("parses the tracked profile and emits a closed digest-only stdin descriptor", () => {
    expect(fastManimOciProfileV1Schema.parse(profile)).toEqual(profile);
    const request = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    const dispatch = createFastManimOciBrokerDispatchV1({
      attestation: attestation(),
      context: context(),
      profile,
      request,
    });
    expect(Object.keys(dispatch.descriptor).sort()).toEqual([
      "assets",
      "imageDigest",
      "profileDigest",
      "request",
      "runtimeDigest",
      "sbomDigest",
      "schema",
      "seccompDigest",
      "version",
    ]);
    expect(dispatch.descriptor.imageDigest).toMatch(/^sha256:/);
    expect(dispatch.descriptor.request).toEqual({
      byteLength: request.byteLength,
      sha256: request.requestDigest,
      transport: "stdin",
    });
    expect(dispatch.descriptor).not.toHaveProperty("argv");
    expect(dispatch.descriptor).not.toHaveProperty("environment");
    expect(dispatch.descriptor).not.toHaveProperty("mounts");
    expect(dispatch.descriptor).not.toHaveProperty("tenantId");
  });

  it("rejects a forged local conformance dispatch before contacting the runtime", async () => {
    await expect(
      runFastManimLocalOciConformanceV1({
        attestation: attestation(),
        dispatch: {} as FastManimOciBrokerDispatchV1,
        maximumStdoutBytes: MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1,
        profile,
      }),
    ).rejects.toThrow(/server-owned broker dispatch/i);
  });

  it("rejects profile drift, generic launch surfaces, fake trust, and re-correlated runtime material", () => {
    expect(() => fastManimOciProfileV1Schema.parse({ ...profile, mounts: [] })).toThrow();
    expect(() =>
      fastManimOciProfileV1Schema.parse({
        ...profile,
        environment: { ...profile.environment, AWS_SECRET_ACCESS_KEY: "sentinel" },
      }),
    ).toThrow();
    expect(() =>
      fastManimOciProfileV1Schema.parse({
        ...profile,
        hostExposure: { ...profile.hostExposure, projectRootMount: true },
      }),
    ).toThrow();
    expect(() =>
      fastManimOciBuildAttestationV1Schema.parse({ ...attestation(), signature: "not-a-signature" }),
    ).toThrow();
    expect(() =>
      fastManimOciBuildAttestationV1Schema.parse({ ...attestation(), runtimeDigest: "c".repeat(64) }),
    ).toThrow(/runtime digest/i);
    expect(() =>
      fastManimOciJobDescriptorV1Schema.parse({
        ...createFastManimOciBrokerDispatchV1({
          attestation: attestation(),
          context: context(),
          profile,
          request: new FastManimSandboxRequestBundleV1(sandboxProducerRequest()),
        }).descriptor,
        request: { byteLength: MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES + 1, sha256: "d".repeat(64), transport: "stdin" },
      }),
    ).toThrow();
  });

  it("allows only the verified factory to create a deeply frozen production dispatch", () => {
    const request = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    const assetBytes = Uint8Array.of(1, 2, 3);
    const mutableContext = context();
    const mutableAttestation = attestation();
    const dispatch = createFastManimOciBrokerDispatchV1({
      assets: [{ bytes: assetBytes, sha256: digest(assetBytes) }],
      attestation: mutableAttestation,
      context: mutableContext,
      profile,
      request,
    });
    const before = JSON.stringify(dispatch.descriptor);
    mutableAttestation.imageDigest = `sha256:${"e".repeat(64)}`;
    mutableContext.identity.projectId = "mutated";
    assetBytes.fill(0);
    expect(JSON.stringify(dispatch.descriptor)).toBe(before);
    expect(dispatch.context.identity.projectId).toBe("default");
    expect(digest(dispatch.copyRequestBytes())).toBe(request.requestDigest);
    expect(Object.isFrozen(dispatch.descriptor)).toBe(true);
    expect(Object.isFrozen(dispatch.descriptor.assets)).toBe(true);
    expect(Object.isFrozen(dispatch.descriptor.assets[0])).toBe(true);
    expect(Object.isFrozen(dispatch.descriptor.request)).toBe(true);
    expect(() => {
      (dispatch.descriptor.request as { sha256: string }).sha256 = "d".repeat(64);
    }).toThrow(TypeError);
    expect(
      () =>
        new (FastManimOciBrokerDispatchV1 as unknown as new (...arguments_: unknown[]) => FastManimOciBrokerDispatchV1)(
          {},
          context(),
          dispatch.descriptor,
          request.copyBytes(),
          prepareFastManimOciAssetsV1(profile, []),
        ),
    ).toThrow(/verified factory/i);
  });

  it("owns asset bytes privately, enforces individual/cumulative caps, and derives root-owned digest paths", () => {
    const inputBytes = Uint8Array.from([1, 2, 3]);
    const inputDigest = digest(inputBytes);
    const assets = prepareFastManimOciAssetsV1(profile, [{ bytes: inputBytes, sha256: inputDigest }]);
    inputBytes.fill(9);
    const first = assets.copyAssets();
    expect([...first[0]!.bytes]).toEqual([1, 2, 3]);
    expect(first[0]!.descriptor).toEqual({
      byteLength: 3,
      fileName: inputDigest,
      gid: 0,
      mode: 0o444,
      sha256: inputDigest,
      uid: 0,
    });
    first[0]!.bytes.fill(8);
    expect([...assets.copyAssets()[0]!.bytes]).toEqual([1, 2, 3]);

    expect(() => prepareFastManimOciAssetsV1(profile, [{ bytes: Uint8Array.of(1), sha256: "e".repeat(64) }])).toThrow(
      /digest/i,
    );
    expect(() =>
      prepareFastManimOciAssetsV1(profile, [
        { bytes: Uint8Array.of(1), sha256: digest(Uint8Array.of(1)) },
        { bytes: Uint8Array.of(1), sha256: digest(Uint8Array.of(1)) },
      ]),
    ).toThrow(/unique/i);

    const firstLarge = new Uint8Array(FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1 / 2);
    const secondLarge = new Uint8Array(FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1 / 2 + 1);
    secondLarge[0] = 1;
    expect(() =>
      prepareFastManimOciAssetsV1(profile, [
        { bytes: firstLarge, sha256: digest(firstLarge) },
        { bytes: secondLarge, sha256: digest(secondLarge) },
      ]),
    ).toThrow(/cumulative/i);
    const tooMany = Array.from({ length: 65 }, (_, index) => {
      const bytes = Uint8Array.of(index);
      return { bytes, sha256: digest(bytes) };
    });
    expect(() => prepareFastManimOciAssetsV1(profile, tooMany)).toThrow(/count/i);
  });

  it("encodes one deterministic 0444 root-owned ustar entry and rechecks bytes before injection", () => {
    const bytes = Uint8Array.from([10, 20, 30]);
    const assets = prepareFastManimOciAssetsV1(profile, [{ bytes, sha256: digest(bytes) }]);
    const asset = assets.copyAssets()[0]!;
    const archive = createFastManimOciAssetTarV1(asset);
    expect(archive.subarray(0, 100).toString("ascii").replaceAll("\0", "")).toBe(asset.descriptor.sha256);
    expect(archive.subarray(100, 107).toString("ascii")).toBe("0000444");
    expect(archive.subarray(108, 115).toString("ascii")).toBe("0000000");
    expect(archive.subarray(116, 123).toString("ascii")).toBe("0000000");
    expect(archive.subarray(136, 147).toString("ascii")).toBe("00000000000");
    expect([...archive.subarray(512, 515)]).toEqual([10, 20, 30]);
    asset.bytes[0] = 99;
    expect(() => createFastManimOciAssetTarV1(asset)).toThrow(/digest/i);
  });

  it("places one canonical exact manifest before sorted digest entries", () => {
    const request = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    const second = Uint8Array.of(2);
    const first = Uint8Array.of(1);
    const dispatch = createFastManimOciBrokerDispatchV1({
      assets: [
        { bytes: second, sha256: digest(second) },
        { bytes: first, sha256: digest(first) },
      ],
      attestation: attestation(),
      context: context(),
      profile,
      request,
    });
    const archive = createFastManimOciAssetArchiveV1(dispatch);
    expect(archive.subarray(0, 100).toString("ascii").replaceAll("\0", "")).toBe(".poietra-assets.v1.json");
    const manifestLength = Number.parseInt(archive.subarray(124, 135).toString("ascii"), 8);
    const manifest = JSON.parse(archive.subarray(512, 512 + manifestLength).toString("utf8"));
    expect(manifest).toEqual({
      assets: dispatch.descriptor.assets.map(({ byteLength, fileName, sha256 }) => ({
        byteLength,
        fileName,
        sha256,
      })),
      count: 2,
      schema: "poietra.fast-manim-oci-asset-manifest",
      version: 1,
    });
    expect(manifest.assets.map((asset: { sha256: string }) => asset.sha256)).toEqual(
      [...manifest.assets.map((asset: { sha256: string }) => asset.sha256)].sort(),
    );
  });
});

describe("fast-manim OCI locked build assembler", () => {
  it("verifies tracked inputs without source credentials or an archive", () => {
    const verification = JSON.parse(execFileSync(process.execPath, [buildScript, "verify"], { encoding: "utf8" }));
    expect(verification).toMatchObject({ schema: "poietra.fast-manim-oci-verification", version: 1 });
    expect(verification.profileDigest).toBe(digestFastManimOciProfileV1(profile));
  });

  it("requires source bytes and refuses to overwrite an existing context", { timeout: 20_000 }, () => {
    const missingSource = spawnSync(process.execPath, [buildScript, "assemble"], { encoding: "utf8" });
    expect(missingSource.status).not.toBe(0);
    expect(missingSource.stderr).toMatch(/source repository or preassembled source archive is required/i);

    const existing = mkdtempSync(join(tmpdir(), "poietra-existing-oci-context-"));
    const sentinel = join(existing, "sentinel");
    writeFileSync(sentinel, "owned by caller", "utf8");
    try {
      const refused = spawnSync(
        process.execPath,
        [buildScript, "assemble", "--source-archive", sentinel, "--context-dir", existing],
        { encoding: "utf8" },
      );
      expect(refused.status).not.toBe(0);
      expect(readFileSync(sentinel, "utf8")).toBe("owned by caller");
      expect(refused.stderr).toMatch(/exist/i);
    } finally {
      rmSync(existing, { force: true, recursive: true });
    }
  });

  it("accepts only an explicit no-cache build request", () => {
    const refused = spawnSync(process.execPath, [buildScript, "build", "--no-cache", "false"], { encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/literal true/i);
  });
});
