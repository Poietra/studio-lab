import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "snapshot";
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
    archiveSha256: "00413ce7ae00d4affa318a701831db369c70ba02f20a6babc44e7d7db8702694",
    assetDirectory: "fast-manim-gated-oci",
    commit: "7d20dc2d6dce4e84d4c24bc9509aff4094279ee7",
    entrypoint: "gated-entrypoint.py",
    tag: "poietra-fast-manim-gated:7d20dc2",
    tree: "f80a55d0764259df9f80b89dd47a18d51e0623db",
  },
};
const profile = profiles[target];
const sourceRepository = process.env.POIETRA_FAST_MANIM_SOURCE_REPO;
if (!profile) throw new Error("The OCI build target must be snapshot or render.");
const { archiveSha256, commit, tree } = profile;
const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../sandbox", profile.assetDirectory);

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
    child.once("close", async (code) => {
      if (code !== 0) {
        rejectRun(new Error(`${command} exited with ${code ?? 1}`));
        return;
      }
      resolveRun(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function writeGitArchive(repository, destination) {
  const output = await open(destination, "wx", 0o600);
  try {
    await new Promise((resolveArchive, rejectArchive) => {
      const child = spawn("git", ["-C", repository, "archive", "--format=tar.gz", "--prefix=fast-manim/", commit], {
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

if (!sourceRepository) throw new Error("POIETRA_FAST_MANIM_SOURCE_REPO is required.");
const canonicalSource = resolve(sourceRepository);
const actualCommit = await run("git", ["-C", canonicalSource, "rev-parse", `${commit}^{commit}`]);
const actualTree = await run("git", ["-C", canonicalSource, "show", "--no-patch", "--format=%T", commit]);
if (actualCommit !== commit || actualTree !== tree)
  throw new Error("The locked fast-manim commit/tree is unavailable.");

const context = await mkdtemp(join(tmpdir(), "poietra-gated-oci-build-"));
try {
  const archivePath = join(context, "fast-manim.tar.gz");
  await writeGitArchive(canonicalSource, archivePath);
  const digest = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (digest !== archiveSha256) throw new Error("The locked fast-manim archive digest does not match.");
  await Promise.all([
    copyFile(join(assetRoot, "Containerfile"), join(context, "Containerfile")),
    copyFile(join(assetRoot, profile.entrypoint), join(context, profile.entrypoint)),
  ]);
  await run(
    "docker",
    [
      "build",
      "--pull=false",
      "--file",
      join(context, "Containerfile"),
      "--tag",
      profile.tag,
      "--build-arg",
      `FAST_MANIM_ARCHIVE_SHA256=${archiveSha256}`,
      "--build-arg",
      `FAST_MANIM_COMMIT=${commit}`,
      "--build-arg",
      `FAST_MANIM_TREE=${tree}`,
      context,
    ],
    { inheritStdout: true },
  );
  const imageId = await run("docker", ["image", "inspect", profile.tag, "--format", "{{.Id}}"]).then((value) =>
    value.replace(/^sha256:/, ""),
  );
  if (!/^[a-f0-9]{64}$/.test(imageId)) throw new Error("Docker did not return an immutable image ID.");
  process.stdout.write(`${JSON.stringify({ archiveSha256, commit, image: `sha256:${imageId}`, tree })}\n`);
} finally {
  await rm(context, { force: true, recursive: true });
}
