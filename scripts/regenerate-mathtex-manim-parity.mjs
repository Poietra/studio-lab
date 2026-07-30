import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIM_IMAGE = "manimcommunity/manim@sha256:f18f53f2e4eaf2ea41713437d34363fb3f5cc6008b03fd798676ac0359396c3b";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repositoryRoot, "fixtures", "mathtex-manim-parity-v1");
const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-mathtex-manim-parity-"));
const generated = join(temporaryRoot, "fixture");

try {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...(uid === null || gid === null ? [] : ["--user", `${uid}:${gid}`]),
      "--env",
      "HOME=/tmp/poietra-manim-parity-home",
      "--env",
      `POIETRA_MANIM_REFERENCE_IMAGE=${MANIM_IMAGE}`,
      "--volume",
      `${repositoryRoot}:/workspace:ro`,
      "--volume",
      `${temporaryRoot}:/output`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/opt/venv/bin/python",
      MANIM_IMAGE,
      "scripts/generate-mathtex-manim-parity.py",
      "--output",
      "/output/fixture",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Manim parity generator exited with status ${result.status}.`);

  const staged = `${target}.new`;
  await rm(staged, { force: true, recursive: true });
  await mkdir(dirname(staged), { recursive: true });
  await cp(generated, staged, { recursive: true });
  await rm(target, { force: true, recursive: true });
  await rename(staged, target);
  process.stdout.write(`MathTex Manim references regenerated at ${target}\n${result.stdout}`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
