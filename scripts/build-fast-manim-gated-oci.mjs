import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "snapshot";
const PENDING_MATHTEX_ARTIFACT_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";
const profiles = {
  render: {
    archiveSha256: "46f66b6698650988c18327732d1d3c30cccd53b38de91e1059c61187d92c2b61",
    assetDirectory: "manim-render-gated-oci",
    commit: "ac143dc46ebe314095ae7864a32efa289a0afe96",
    entrypoint: "render-entrypoint.py",
    tag: "poietra-manim-render-gated:ac143dc",
    tree: "b86e2ec81f257cae20669e3c5c33080facfbd610",
  },
  snapshot: {
    archiveSha256: "c4796847340c34a82396acdb56ae5e9d3d85e8414b9740860062e9f28712fad6",
    assetDirectory: "fast-manim-gated-oci",
    commit: "29d21a2bd213df8ffeed0454278aa86289d190b8",
    engineArchiveSha256: "2aa42246977322bae54862f49ce28b3e61bf8b472a93800b2fdda8e344173d32",
    engineCommit: "be671c1ddcfc8466548c8822956e19579256e581",
    engineTree: "d0f6d72213c65527ae9b7a4717390b48db1e9256",
    entrypoint: "gated-entrypoint.py",
    // Promotion remains deliberately unavailable until the pinned amd64
    // builder produces the double-clean native artifact digest for this tree.
    mathtexExtensionSha256: PENDING_MATHTEX_ARTIFACT_SHA256,
    platform: "linux/amd64",
    tag: "poietra-fast-manim-gated:29d21a2",
    tree: "d486d57ba637da1e915a5b29d6bda2d967570a54",
    verifier: "verify-mathtex-provider.py",
  },
};
const profile = profiles[target];
const sourceRepository = process.env.POIETRA_FAST_MANIM_SOURCE_REPO;
if (!profile) throw new Error("The OCI build target must be snapshot or render.");
if (target === "snapshot" && profile.mathtexExtensionSha256 === PENDING_MATHTEX_ARTIFACT_SHA256) {
  throw new Error(
    "The snapshot image is awaiting the pinned-builder MathTex artifact digest; run the bounded derivation on the external amd64 operator host first.",
  );
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = resolve(repositoryRoot, "sandbox", profile.assetDirectory);

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const chunks = [];
    const child = spawn(command, arguments_, {
      env: { PATH: process.env.PATH },
      stdio: options.inheritStdout ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "inherit"],
    });
    let byteLength = 0;
    child.stdout?.on("data", (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > 64 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectRun(new Error(`${command} exited with ${code ?? 1}`));
        return;
      }
      resolveRun(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function writeGitArchive(repository, destination, commit, options = {}) {
  const output = await open(destination, "wx", 0o600);
  try {
    const arguments_ = ["-C", repository, "archive", "--format=tar.gz"];
    if (options.prefix) arguments_.push(`--prefix=${options.prefix}`);
    arguments_.push(commit, ...(options.pathspec ?? []));
    await new Promise((resolveArchive, rejectArchive) => {
      const child = spawn("git", arguments_, {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", output.fd, "inherit"],
      });
      child.once("error", rejectArchive);
      child.once("close", (code) =>
        code === 0 ? resolveArchive() : rejectArchive(new Error(`git archive exited with ${code ?? 1}`)),
      );
    });
  } finally {
    await output.close();
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

if (!sourceRepository) throw new Error("POIETRA_FAST_MANIM_SOURCE_REPO is required.");
const canonicalSource = resolve(sourceRepository);
const actualCommit = await run("git", ["-C", canonicalSource, "rev-parse", `${profile.commit}^{commit}`]);
const actualTree = await run("git", ["-C", canonicalSource, "show", "--no-patch", "--format=%T", profile.commit]);
if (actualCommit !== profile.commit || actualTree !== profile.tree) {
  throw new Error("The locked fast-manim commit/tree is unavailable.");
}
if (target === "snapshot") {
  const actualEngineCommit = await run("git", ["-C", repositoryRoot, "rev-parse", `${profile.engineCommit}^{commit}`]);
  const actualEngineTree = await run("git", ["-C", repositoryRoot, "rev-parse", `${profile.engineCommit}:engine`]);
  if (actualEngineCommit !== profile.engineCommit || actualEngineTree !== profile.engineTree) {
    throw new Error("The locked Studio engine commit/tree is unavailable.");
  }
}

const context = await mkdtemp(join(tmpdir(), "poietra-gated-oci-build-"));
try {
  const archivePath = join(context, "fast-manim.tar.gz");
  await writeGitArchive(canonicalSource, archivePath, profile.commit, { prefix: "fast-manim/" });
  if ((await sha256(archivePath)) !== profile.archiveSha256) {
    throw new Error("The locked fast-manim archive digest does not match.");
  }
  const assets = [
    copyFile(join(assetRoot, "Containerfile"), join(context, "Containerfile")),
    copyFile(join(assetRoot, profile.entrypoint), join(context, profile.entrypoint)),
  ];
  if (target === "snapshot") {
    const engineArchivePath = join(context, "studio-engine.tar.gz");
    await writeGitArchive(repositoryRoot, engineArchivePath, profile.engineCommit, { pathspec: ["engine"] });
    if ((await sha256(engineArchivePath)) !== profile.engineArchiveSha256) {
      throw new Error("The locked Studio engine archive digest does not match.");
    }
    assets.push(copyFile(join(assetRoot, profile.verifier), join(context, profile.verifier)));
  }
  await Promise.all(assets);

  const buildArguments = ["build", "--pull=false"];
  if (profile.platform) buildArguments.push("--platform", profile.platform);
  buildArguments.push(
    "--file",
    join(context, "Containerfile"),
    "--tag",
    profile.tag,
    "--build-arg",
    `FAST_MANIM_ARCHIVE_SHA256=${profile.archiveSha256}`,
    "--build-arg",
    `FAST_MANIM_COMMIT=${profile.commit}`,
    "--build-arg",
    `FAST_MANIM_TREE=${profile.tree}`,
  );
  if (target === "snapshot") {
    buildArguments.push(
      "--build-arg",
      `MATHTEX_EXTENSION_SHA256=${profile.mathtexExtensionSha256}`,
      "--build-arg",
      `STUDIO_ENGINE_ARCHIVE_SHA256=${profile.engineArchiveSha256}`,
      "--build-arg",
      `STUDIO_ENGINE_COMMIT=${profile.engineCommit}`,
      "--build-arg",
      `STUDIO_ENGINE_TREE=${profile.engineTree}`,
    );
  }
  buildArguments.push(context);
  await run("docker", buildArguments, { inheritStdout: true });

  const imageId = await run("docker", ["image", "inspect", profile.tag, "--format", "{{.Id}}"]);
  const normalizedImageId = imageId.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalizedImageId)) {
    throw new Error("Docker did not return an immutable image ID.");
  }
  process.stdout.write(
    `${JSON.stringify({
      archiveSha256: profile.archiveSha256,
      commit: profile.commit,
      ...(target === "snapshot"
        ? {
            engineArchiveSha256: profile.engineArchiveSha256,
            engineCommit: profile.engineCommit,
            engineTree: profile.engineTree,
            mathtexExtensionSha256: profile.mathtexExtensionSha256,
            platform: profile.platform,
          }
        : {}),
      image: `sha256:${normalizedImageId}`,
      tree: profile.tree,
    })}\n`,
  );
} finally {
  await rm(context, { force: true, recursive: true });
}
