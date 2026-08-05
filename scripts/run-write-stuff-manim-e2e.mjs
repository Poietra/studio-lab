import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const [pythonExecutable, sourceRoot, manifestJson, ...manimArguments] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 2;
}

function parseManifest(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The WriteStuff Tex cache manifest must be valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.entries(parsed).length === 0 ||
    Object.entries(parsed).some(
      ([file, digest]) =>
        !/^[a-f0-9]{16}\.(?:svg|tex)$/.test(file) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
    )
  ) {
    throw new Error("The WriteStuff Tex cache manifest has an invalid shape.");
  }
  return parsed;
}

async function verifiedCacheFiles(root, manifest) {
  if (!isAbsolute(root)) throw new Error("The WriteStuff Tex cache root must be absolute.");
  const expectedFiles = Object.keys(manifest).sort();
  const actualFiles = (await readdir(root)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("The WriteStuff Tex cache contains an unexpected file set.");
  }
  return Promise.all(
    expectedFiles.map(async (file) => {
      const bytes = await readFile(join(root, file));
      if (createHash("sha256").update(bytes).digest("hex") !== manifest[file]) {
        throw new Error(`The WriteStuff Tex cache file ${file} failed its SHA-256 check.`);
      }
      return { bytes, file };
    }),
  );
}

async function runManim(executable, arguments_) {
  const child = spawn(executable, ["-m", "manim", ...arguments_], { stdio: "inherit" });
  return new Promise((resolveClose) => {
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveClose(1);
    });
    child.once("close", (code, signal) => {
      if (signal) process.stderr.write(`Manim stopped by ${signal}.\n`);
      resolveClose(code ?? 1);
    });
  });
}

async function main() {
  if (!pythonExecutable || !sourceRoot || !manifestJson || manimArguments.length === 0) {
    return fail("Usage: run-write-stuff-manim-e2e <python> <cache-root> <manifest-json> <manim-arguments...>");
  }
  let manifest;
  let files;
  try {
    manifest = parseManifest(manifestJson);
    files = await verifiedCacheFiles(sourceRoot, manifest);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The WriteStuff Tex cache could not be verified.");
  }

  if (manimArguments.length === 1 && manimArguments[0] === "--version") {
    return runManim(pythonExecutable, manimArguments);
  }

  const mediaIndexes = manimArguments
    .map((argument, index) => (argument === "--media_dir" ? index : -1))
    .filter((index) => index >= 0);
  if (mediaIndexes.length !== 1) return fail("The WriteStuff E2E render requires exactly one --media_dir argument.");
  const mediaRoot = manimArguments[mediaIndexes[0] + 1];
  if (!mediaRoot || !isAbsolute(mediaRoot)) {
    return fail("The WriteStuff E2E render requires an absolute --media_dir path.");
  }

  const targetRoot = join(mediaRoot, "Tex");
  try {
    await mkdir(targetRoot, { recursive: true });
    await Promise.all(files.map(({ bytes, file }) => writeFile(join(targetRoot, file), bytes, { flag: "wx" })));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The WriteStuff Tex cache could not be installed.");
  }
  return runManim(pythonExecutable, manimArguments);
}

process.exitCode = await main();
