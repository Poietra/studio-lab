import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const artifactRoot = resolve(process.env.POIETRA_MANIM_SMOKE_ARTIFACTS ?? "test-results/manim-smoke");
const defaultDockerImage = "manimcommunity/manim@sha256:f18f53f2e4eaf2ea41713437d34363fb3f5cc6008b03fd798676ac0359396c3b";
await mkdir(artifactRoot, { recursive: true });

const log = createWriteStream(resolve(artifactRoot, "vitest.log"), { flags: "w" });
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, [
  resolve("node_modules/vitest/vitest.mjs"),
  "run",
  "server/manim-render-pipeline.real.test.ts",
  "--reporter=verbose",
], {
  env: {
    ...process.env,
    POIETRA_MANIM_DOCKER_IMAGE: process.env.POIETRA_MANIM_DOCKER_IMAGE ?? defaultDockerImage,
    POIETRA_MANIM_SMOKE_ARTIFACTS: artifactRoot,
    POIETRA_REAL_MANIM_SMOKE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

const result = await new Promise((resolveExit) => {
  child.once("error", (error) => resolveExit({ error: error.message, exitCode: 1, signal: null }));
  child.once("exit", (exitCode, signal) => resolveExit({ error: null, exitCode: exitCode ?? 1, signal }));
});
await new Promise((resolveClose) => log.end(resolveClose));
await writeFile(resolve(artifactRoot, "runner.json"), `${JSON.stringify({
  ...result,
  finishedAt: new Date().toISOString(),
  startedAt,
}, null, 2)}\n`, "utf8");

if (result.error) process.stderr.write(`${result.error}\n`);
if (result.signal) process.stderr.write(`Real Manim smoke stopped by ${result.signal}.\n`);
process.exitCode = result.exitCode;
