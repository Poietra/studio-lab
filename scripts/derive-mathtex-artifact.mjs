import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MATHTEX_ARTIFACT_DERIVATION_SCHEMA_V1 = "poietra.mathtex-artifact-derivation";
export const MATHTEX_ARTIFACT_DERIVATION_VERSION_V1 = 1;
export const MATHTEX_ARTIFACT_FILE_V1 = "poietra_mathtex_outline.abi3.so";
export const MATHTEX_ARTIFACT_TARGET_V1 = "x86_64-unknown-linux-gnu";
export const MATHTEX_ARTIFACT_BUILDER_IMAGE_V1 =
  "rust@sha256:6ca5ad23231207874325a751b9df584d51cd42c066c74c6963c264e3233c3e8e";
export const MATHTEX_ARTIFACT_RUST_VERSION_V1 = "rustc 1.92.0 (ded5c06cf 2025-12-08)";
export const MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1 = Object.freeze(["first", "second"]);
export const MATHTEX_ARTIFACT_BUILD_SCRIPT_V1 = `
set -eu
test "$(uname -m)" = "x86_64"
test "$(rustc --version)" = "${MATHTEX_ARTIFACT_RUST_VERSION_V1}"
mkdir --parents /opt/poietra-build/studio /opt/poietra-output
printf '%s  %s\n' "$STUDIO_ENGINE_ARCHIVE_SHA256" /opt/poietra-build/studio-engine.tar.gz \
  | sha256sum --check --strict -
tar --extract --gzip --file=/opt/poietra-build/studio-engine.tar.gz \
  --directory=/opt/poietra-build/studio --no-same-owner
env -u MATHTEX_EXTENSION_SHA256 cargo build --locked \
  --profile mathtex-python-release \
  --package poietra-mathtex-py \
  --manifest-path /opt/poietra-build/studio/engine/Cargo.toml \
  --target x86_64-unknown-linux-gnu
artifact=/opt/poietra-build/target/x86_64-unknown-linux-gnu/mathtex-python-release/libpoietra_mathtex_outline.so
test -f "$artifact" && test ! -L "$artifact"
artifact_size="$(stat --format='%s' "$artifact")"
test "$artifact_size" -gt 0 && test "$artifact_size" -le 16777216
install --owner=0 --group=0 --mode=0444 "$artifact" /opt/poietra-output/${MATHTEX_ARTIFACT_FILE_V1}
`;

const DOCKER = "/usr/bin/docker";
const MAX_COMMAND_STDOUT_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 4 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONTAINER_NAME = /^poietra-mathtex-artifact-[a-z0-9-]{1,48}-(?:first|second)$/;
const REPORT_FIELDS = Object.freeze([
  "artifactFile",
  "artifactSha256",
  "artifactSizeBytes",
  "builderImage",
  "cleanBuilds",
  "engineArchiveSha256",
  "engineCommit",
  "engineTree",
  "rustVersion",
  "schema",
  "target",
  "version",
]);

function fail(message) {
  throw new Error(message);
}

export function parseMathTexArtifactDerivationArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 3) {
    fail("Usage: derive-mathtex-artifact.mjs <engine-commit> <engine-tree> <engine-archive-sha256>");
  }
  const [engineCommit, engineTree, engineArchiveSha256] = arguments_;
  if (!GIT_OBJECT_ID.test(engineCommit) || !GIT_OBJECT_ID.test(engineTree) || !SHA256.test(engineArchiveSha256)) {
    fail("MathTex artifact derivation requires lowercase, full-length immutable engine pins.");
  }
  return Object.freeze({ engineArchiveSha256, engineCommit, engineTree });
}

export function mathTexArtifactContainerArguments(input, archivePath, outputPath, containerName) {
  for (const path of [archivePath, outputPath]) {
    if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path || path.includes("\0")) {
      fail("MathTex artifact derivation paths must be canonical absolute paths.");
    }
  }
  if (!CONTAINER_NAME.test(containerName)) fail("The MathTex artifact derivation container name is invalid.");
  return Object.freeze([
    "run",
    "--rm",
    "--pull",
    "never",
    "--platform",
    "linux/amd64",
    "--name",
    containerName,
    "--label",
    "io.poietra.mathtex-artifact-derivation=v1",
    "--mount",
    `type=bind,src=${archivePath},dst=/opt/poietra-build/studio-engine.tar.gz,readonly`,
    "--mount",
    `type=bind,src=${outputPath},dst=/opt/poietra-output`,
    "--env",
    "CARGO_HOME=/opt/poietra-build/cargo-home",
    "--env",
    "CARGO_INCREMENTAL=0",
    "--env",
    "CARGO_TARGET_DIR=/opt/poietra-build/target",
    "--env",
    "PYO3_NO_PYTHON=1",
    "--env",
    "SOURCE_DATE_EPOCH=0",
    "--env",
    `STUDIO_ENGINE_ARCHIVE_SHA256=${input.engineArchiveSha256}`,
    "--env",
    `STUDIO_ENGINE_COMMIT=${input.engineCommit}`,
    "--env",
    `STUDIO_ENGINE_TREE=${input.engineTree}`,
    "--workdir",
    "/opt/poietra-build/studio",
    "--entrypoint",
    "/bin/sh",
    MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
    "-c",
    MATHTEX_ARTIFACT_BUILD_SCRIPT_V1,
  ]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMathTexArtifactDerivationReport(bytes, expected) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_REPORT_BYTES) {
    fail("The MathTex artifact derivation report is empty or oversized.");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error("The MathTex artifact derivation report is not valid UTF-8 JSON.", { cause });
  }
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(REPORT_FIELDS)) {
    fail("The MathTex artifact derivation report has unexpected fields.");
  }
  if (
    value.artifactFile !== MATHTEX_ARTIFACT_FILE_V1 ||
    typeof value.artifactSha256 !== "string" ||
    !SHA256.test(value.artifactSha256) ||
    value.artifactSha256 === "0".repeat(64) ||
    !Number.isSafeInteger(value.artifactSizeBytes) ||
    value.artifactSizeBytes <= 0 ||
    value.artifactSizeBytes > MAX_ARTIFACT_BYTES ||
    value.builderImage !== MATHTEX_ARTIFACT_BUILDER_IMAGE_V1 ||
    value.cleanBuilds !== MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1.length ||
    value.engineArchiveSha256 !== expected.engineArchiveSha256 ||
    value.engineCommit !== expected.engineCommit ||
    value.engineTree !== expected.engineTree ||
    value.rustVersion !== MATHTEX_ARTIFACT_RUST_VERSION_V1 ||
    value.schema !== MATHTEX_ARTIFACT_DERIVATION_SCHEMA_V1 ||
    value.target !== MATHTEX_ARTIFACT_TARGET_V1 ||
    value.version !== MATHTEX_ARTIFACT_DERIVATION_VERSION_V1
  ) {
    fail("The MathTex artifact derivation report does not match the pinned request.");
  }
  return Object.freeze({ ...value });
}

export async function withMathTexArtifactBuildContext(operation) {
  const contextPath = await mkdtemp(join(tmpdir(), "poietra-mathtex-artifact-"));
  try {
    return await operation(contextPath);
  } finally {
    await rm(contextPath, { force: true, maxRetries: 3, recursive: true });
  }
}

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const chunks = [];
    let byteLength = 0;
    const child = spawn(command, arguments_, {
      env: options.env ?? { PATH: process.env.PATH },
      stdio: options.diagnosticOutput ? ["ignore", process.stderr, process.stderr] : ["ignore", "pipe", "inherit"],
    });
    child.stdout?.on("data", (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_COMMAND_STDOUT_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code !== 0 || byteLength > MAX_COMMAND_STDOUT_BYTES) {
        rejectRun(new Error(`${command} failed while deriving the MathTex artifact.`));
        return;
      }
      resolveRun(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export async function removeMathTexArtifactContainer(containerName, runner = run) {
  if (!CONTAINER_NAME.test(containerName)) fail("The MathTex artifact derivation container name is invalid.");
  const environment = { PATH: "/usr/bin:/bin" };
  const listArguments = [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `name=^/${containerName}$`,
    "--filter",
    "label=io.poietra.mathtex-artifact-derivation=v1",
  ];
  const containerId = await runner(DOCKER, listArguments, { env: environment });
  if (!containerId) return;
  if (!CONTAINER_ID.test(containerId)) fail("The MathTex derivation cleanup found an unexpected container.");
  await runner(DOCKER, ["container", "rm", "--force", containerId], { env: environment });
  if (await runner(DOCKER, listArguments, { env: environment })) {
    fail("The MathTex derivation container survived scoped cleanup.");
  }
}

async function writeGitArchive(repositoryRoot, destination, commit) {
  const output = await open(destination, "wx", 0o600);
  try {
    await new Promise((resolveArchive, rejectArchive) => {
      const child = spawn("git", ["-C", repositoryRoot, "archive", "--format=tar.gz", commit, "engine"], {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", output.fd, "inherit"],
      });
      child.once("error", rejectArchive);
      child.once("close", (code) =>
        code === 0 ? resolveArchive() : rejectArchive(new Error("git archive failed for the pinned Studio engine.")),
      );
    });
  } finally {
    await output.close();
  }
}

async function readBoundedRegularFile(path, maximumBytes) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    fail("A MathTex artifact derivation output is not a bounded regular file.");
  }
  const bytes = await readFile(path);
  return Object.freeze({ bytes, digest: createHash("sha256").update(bytes).digest("hex"), size: metadata.size });
}

export async function deriveMathTexArtifact(input) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const actualCommit = await run("git", ["-C", repositoryRoot, "rev-parse", `${input.engineCommit}^{commit}`]);
  const actualTree = await run("git", ["-C", repositoryRoot, "rev-parse", `${input.engineCommit}:engine`]);
  if (actualCommit !== input.engineCommit || actualTree !== input.engineTree) {
    fail("The locked Studio engine commit/tree is unavailable.");
  }

  return withMathTexArtifactBuildContext(async (contextPath) => {
    const archivePath = join(contextPath, "studio-engine.tar.gz");
    await writeGitArchive(repositoryRoot, archivePath, input.engineCommit);
    const archive = await readBoundedRegularFile(archivePath, 64 * 1024 * 1024);
    if (archive.digest !== input.engineArchiveSha256) fail("The locked Studio engine archive digest does not match.");

    const artifacts = [];
    const contextName = basename(contextPath)
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "")
      .slice(-32);
    for (const attempt of MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1) {
      const outputPath = join(contextPath, attempt);
      const containerName = `poietra-mathtex-artifact-${contextName}-${attempt}`;
      await mkdir(outputPath, { mode: 0o700 });
      try {
        await run(DOCKER, mathTexArtifactContainerArguments(input, archivePath, outputPath, containerName), {
          diagnosticOutput: true,
          env: { PATH: "/usr/bin:/bin" },
        });
      } finally {
        await removeMathTexArtifactContainer(containerName);
      }
      artifacts.push(await readBoundedRegularFile(join(outputPath, MATHTEX_ARTIFACT_FILE_V1), MAX_ARTIFACT_BYTES));
    }
    const [first, second] = artifacts;
    if (
      !first ||
      !second ||
      first.digest !== second.digest ||
      first.size !== second.size ||
      Buffer.compare(first.bytes, second.bytes) !== 0
    ) {
      fail("Two clean pinned-builder runs produced different MathTex artifacts.");
    }
    const report = {
      artifactFile: MATHTEX_ARTIFACT_FILE_V1,
      artifactSha256: first.digest,
      artifactSizeBytes: first.size,
      builderImage: MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
      cleanBuilds: MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1.length,
      engineArchiveSha256: input.engineArchiveSha256,
      engineCommit: input.engineCommit,
      engineTree: input.engineTree,
      rustVersion: MATHTEX_ARTIFACT_RUST_VERSION_V1,
      schema: MATHTEX_ARTIFACT_DERIVATION_SCHEMA_V1,
      target: MATHTEX_ARTIFACT_TARGET_V1,
      version: MATHTEX_ARTIFACT_DERIVATION_VERSION_V1,
    };
    return parseMathTexArtifactDerivationReport(Buffer.from(JSON.stringify(report)), input);
  });
}

async function main() {
  const input = parseMathTexArtifactDerivationArguments(process.argv.slice(2));
  const report = await deriveMathTexArtifact(input);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
