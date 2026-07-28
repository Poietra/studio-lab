import { createHash, createPrivateKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE =
  "Usage: sign-fast-manim-runc-release.mjs --attestation PATH --rootfs-digest SHA256 --issued-at EPOCH_MS --expires-at EPOCH_MS --key-id ID --private-key PATH --output PATH";
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REQUIRED_OPTIONS = Object.freeze([
  "attestation",
  "expiresAt",
  "issuedAt",
  "keyId",
  "output",
  "privateKey",
  "rootfsDigest",
]);

class ReleaseSignerError extends Error {}

function fail(message) {
  throw new ReleaseSignerError(message);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) fail(`${label} has unexpected fields.`);
}

function requireDigest(value, label, pattern = SHA256) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is not a canonical SHA-256 digest.`);
}

function validateAttestation(value) {
  exactKeys(
    value,
    [
      "buildLockDigest",
      "fastManim",
      "imageConfigDigest",
      "imageDigest",
      "platform",
      "profileDigest",
      "runtimeDigest",
      "sbom",
      "schema",
      "seccompDigest",
      "version",
    ],
    "OCI attestation",
  );
  exactKeys(value.fastManim, ["archiveSha256", "commit", "tree"], "OCI attestation fastManim");
  exactKeys(value.sbom, ["digest", "schema", "signed", "toolchainDigest"], "OCI attestation SBOM");
  requireDigest(value.buildLockDigest, "OCI build-lock digest");
  requireDigest(value.fastManim.archiveSha256, "OCI source archive digest");
  requireDigest(value.imageConfigDigest, "OCI image config digest", IMAGE_DIGEST);
  requireDigest(value.imageDigest, "OCI image digest", IMAGE_DIGEST);
  requireDigest(value.profileDigest, "OCI profile digest");
  requireDigest(value.runtimeDigest, "OCI runtime digest");
  requireDigest(value.sbom.digest, "OCI SBOM digest");
  requireDigest(value.sbom.toolchainDigest, "OCI toolchain digest");
  requireDigest(value.seccompDigest, "OCI seccomp digest");
  if (!/^[a-f0-9]{40}$/u.test(value.fastManim.commit) || !/^[a-f0-9]{40}$/u.test(value.fastManim.tree)) {
    fail("OCI source revisions must be full lowercase Git object IDs.");
  }
  if (
    value.schema !== "poietra.fast-manim-oci-build-attestation" ||
    value.version !== 1 ||
    value.platform !== "linux/amd64" ||
    value.sbom.schema !== "poietra.fast-manim-oci-sbom" ||
    value.sbom.signed !== false
  ) {
    fail("OCI attestation schema or locked metadata is unsupported.");
  }
  const runtimeDigest = createHash("sha256")
    .update(
      canonicalJson({
        imageConfigDigest: value.imageConfigDigest,
        imageDigest: value.imageDigest,
        inventoryDigest: value.sbom.digest,
        lockDigest: value.buildLockDigest,
        profileDigest: value.profileDigest,
        seccompDigest: value.seccompDigest,
      }),
      "utf8",
    )
    .digest("hex");
  if (runtimeDigest !== value.runtimeDigest) fail("OCI runtime digest does not match its locked materials.");
  return value;
}

async function readBoundedFile(path, maximumBytes, label, privateKey = false) {
  let handle;
  try {
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = await handle.stat({ bigint: true });
    const expectedUid = process.geteuid?.();
    if (
      !status.isFile() ||
      status.nlink !== 1n ||
      status.size <= 0n ||
      status.size > BigInt(maximumBytes) ||
      expectedUid === undefined ||
      status.uid !== BigInt(expectedUid) ||
      (Number(status.mode) & (privateKey ? 0o077 : 0o022)) !== 0
    ) {
      fail(`${label} is unavailable or unsafe.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== status.dev ||
      after.ino !== status.ino ||
      after.size !== status.size ||
      after.mtimeNs !== status.mtimeNs ||
      after.ctimeNs !== status.ctimeNs
    ) {
      fail(`${label} changed while it was read.`);
    }
    await handle.close();
    handle = undefined;
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseSignerError) throw error;
    fail(`${label} is unavailable or unsafe.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseTimestamp(value, label) {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) fail(`${label} must be a positive epoch-millisecond integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be a safe epoch-millisecond integer.`);
  return parsed;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return null;
  const names = {
    "--attestation": "attestation",
    "--expires-at": "expiresAt",
    "--issued-at": "issuedAt",
    "--key-id": "keyId",
    "--output": "output",
    "--private-key": "privateKey",
    "--rootfs-digest": "rootfsDigest",
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const name = names[option];
    if (!name || value === undefined || value.startsWith("--") || options[name] !== undefined) fail(USAGE);
    options[name] = value;
  }
  if (argv.length !== REQUIRED_OPTIONS.length * 2 || REQUIRED_OPTIONS.some((name) => options[name] === undefined)) {
    fail(USAGE);
  }
  return options;
}

async function writeExclusive(path, bytes) {
  let handle;
  try {
    handle = await open(
      resolve(path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    fail("Release output could not be created safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function signRelease(options) {
  if (!SHA256.test(options.rootfsDigest)) fail("Rootfs digest is not a canonical SHA-256 digest.");
  if (!KEY_ID.test(options.keyId)) fail("Release key ID is not canonical.");
  const issuedAt = parseTimestamp(options.issuedAt, "Release issuance");
  const expiresAt = parseTimestamp(options.expiresAt, "Release expiry");
  if (expiresAt <= issuedAt) fail("Release expiry must follow issuance.");

  const attestationBytes = await readBoundedFile(options.attestation, 16_384, "OCI attestation");
  let attestation;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(attestationBytes);
    attestation = validateAttestation(JSON.parse(text));
    if (text !== `${canonicalJson(attestation)}\n`) fail("OCI attestation is not canonical JSON.");
  } catch (error) {
    if (error instanceof ReleaseSignerError) throw error;
    fail("OCI attestation is not canonical UTF-8 JSON.");
  }

  const payload = {
    expiresAt,
    imageDigest: attestation.imageDigest,
    issuedAt,
    keyId: options.keyId,
    profileDigest: attestation.profileDigest,
    rootfsDigest: options.rootfsDigest,
    runtimeDigest: attestation.runtimeDigest,
    sbomDigest: attestation.sbom.digest,
    schema: "poietra.fast-manim-runc-release",
    seccompDigest: attestation.seccompDigest,
    version: 1,
  };
  const privateKeyBytes = await readBoundedFile(options.privateKey, 16_384, "Private key", true);
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      fail("Private key must be an Ed25519 private key.");
    }
  } catch (error) {
    if (error instanceof ReleaseSignerError) throw error;
    fail("Private key must be an Ed25519 private key.");
  } finally {
    privateKeyBytes.fill(0);
  }
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url");
  await writeExclusive(options.output, Buffer.from(`${canonicalJson({ payload, signature })}\n`, "utf8"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  await signRelease(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof ReleaseSignerError ? error.message : "Unexpected signing failure.";
    process.stderr.write(`fast-manim release signing failed: ${message}\n`);
    process.exitCode = 1;
  });
}
