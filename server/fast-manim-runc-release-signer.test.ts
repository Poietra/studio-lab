import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { fastManimRuncSignedReleaseV1Schema } from "./fast-manim-runc-release-trust";

const signer = resolve("scripts/sign-fast-manim-runc-release.mjs");
const roots: string[] = [];

function createAttestation(overrides: Readonly<Record<string, unknown>> = {}) {
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest: "3".repeat(64),
    seccompDigest: "6".repeat(64),
  };
  return {
    buildLockDigest: material.lockDigest,
    fastManim: { archiveSha256: "7".repeat(64), commit: "8".repeat(40), tree: "9".repeat(40) },
    imageConfigDigest: material.imageConfigDigest,
    imageDigest: material.imageDigest,
    platform: "linux/amd64",
    profileDigest: material.profileDigest,
    runtimeDigest: createHash("sha256").update(canonicalJsonV1(material), "utf8").digest("hex"),
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "poietra-release-signer-"));
  roots.push(root);
  const attestationPath = join(root, "attestation.json");
  const privateKeyPath = join(root, "release-key.pem");
  const outputPath = join(root, "release.json");
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyBytes = Buffer.from(keyPair.privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(attestationPath, `${canonicalJsonV1(createAttestation())}\n`, { mode: 0o600 });
  writeFileSync(privateKeyPath, privateKeyBytes, { mode: 0o600 });
  return { attestationPath, keyPair, outputPath, privateKeyBytes, privateKeyPath };
}

function runSign(input: ReturnType<typeof fixture>, outputPath = input.outputPath) {
  return spawnSync(
    process.execPath,
    [
      signer,
      "--attestation",
      input.attestationPath,
      "--rootfs-digest",
      "b".repeat(64),
      "--issued-at",
      "1800000000000",
      "--expires-at",
      "1800000060000",
      "--key-id",
      "release-key-1",
      "--private-key",
      input.privateKeyPath,
      "--output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("fast-manim runc release signer CLI", () => {
  it("writes one canonical release signed over exactly the verifier payload bytes", () => {
    const input = fixture();
    const result = runSign(input);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(statSync(input.outputPath).mode & 0o777).toBe(0o600);
    const text = readFileSync(input.outputPath, "utf8");
    const release = JSON.parse(text) as { payload: Record<string, unknown>; signature: string };
    expect(() => fastManimRuncSignedReleaseV1Schema.parse(release)).not.toThrow();
    expect(text).toBe(`${canonicalJsonV1(release)}\n`);
    expect(release.payload).toEqual({
      expiresAt: 1_800_000_060_000,
      imageDigest: `sha256:${"1".repeat(64)}`,
      issuedAt: 1_800_000_000_000,
      keyId: "release-key-1",
      profileDigest: "3".repeat(64),
      rootfsDigest: "b".repeat(64),
      runtimeDigest: createAttestation().runtimeDigest,
      sbomDigest: "4".repeat(64),
      schema: "poietra.fast-manim-runc-release",
      seccompDigest: "6".repeat(64),
      version: 1,
    });
    expect(
      verify(
        null,
        Buffer.from(canonicalJsonV1(release.payload), "utf8"),
        input.keyPair.publicKey,
        Buffer.from(release.signature, "base64url"),
      ),
    ).toBe(true);
    expect(readFileSync(input.privateKeyPath)).toEqual(input.privateKeyBytes);
  });

  it("rejects non-canonical or internally inconsistent OCI attestations", () => {
    const input = fixture();
    const cases = [
      `${JSON.stringify(createAttestation(), null, 2)}\n`,
      `${canonicalJsonV1(createAttestation({ unexpected: true }))}\n`,
      `${canonicalJsonV1(createAttestation({ runtimeDigest: "0".repeat(64) }))}\n`,
    ];

    for (const [index, bytes] of cases.entries()) {
      writeFileSync(input.attestationPath, bytes);
      const outputPath = `${input.outputPath}-${index}`;
      const result = runSign(input, outputPath);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^fast-manim release signing failed: /u);
      expect(existsSync(outputPath)).toBe(false);
    }
  });

  it("refuses an attestation that another local user could modify", () => {
    const input = fixture();
    chmodSync(input.attestationPath, 0o666);

    const result = runSign(input);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OCI attestation is unavailable or unsafe");
    expect(existsSync(input.outputPath)).toBe(false);
  });

  it("refuses exposed or non-Ed25519 key files and never overwrites output", () => {
    const input = fixture();
    chmodSync(input.privateKeyPath, 0o644);
    const exposed = runSign(input);
    expect(exposed.status).toBe(1);
    expect(exposed.stderr).not.toContain(input.privateKeyPath);
    expect(exposed.stderr).not.toContain("PRIVATE KEY");
    expect(existsSync(input.outputPath)).toBe(false);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
    writeFileSync(input.privateKeyPath, rsa, { mode: 0o600 });
    chmodSync(input.privateKeyPath, 0o600);
    const wrongType = runSign(input);
    expect(wrongType.status).toBe(1);
    expect(wrongType.stderr).not.toContain(input.privateKeyPath);
    expect(existsSync(input.outputPath)).toBe(false);

    writeFileSync(input.privateKeyPath, input.privateKeyBytes, { mode: 0o600 });
    writeFileSync(input.outputPath, "do-not-overwrite", { mode: 0o600 });
    const existing = runSign(input);
    expect(existing.status).toBe(1);
    expect(readFileSync(input.outputPath, "utf8")).toBe("do-not-overwrite");
  });
});
