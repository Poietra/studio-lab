import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { electronPackageLayout } from "./electron-package-layout.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const noticePath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/PACKAGE-LICENSES.txt");
const fontPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/assets/NewCMMath-Regular.otf");
const manifestPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/Cargo.toml");
const libraryPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/src/lib.rs");
const noticeName = "THIRD_PARTY_NOTICES.txt";
const expectedFontDigest = "d66ac1cc91c55c24d3636ae2df1238076debdff51841f9893fc5419cc2df3df7";

const [notice, font, manifest, library] = await Promise.all([
  readFile(noticePath),
  readFile(fontPath),
  readFile(manifestPath, "utf8"),
  readFile(libraryPath, "utf8"),
]);
const noticeText = notice.toString("utf8");
const actualFontDigest = createHash("sha256").update(font).digest("hex");

assert.equal(actualFontDigest, expectedFontDigest, "the embedded font bytes changed without a notice update");
for (const required of [
  "Name: New Computer Modern Math",
  "Official distribution: https://ctan.org/pkg/newcomputermodern",
  "License: GUST Font License, version 1.0, 22 June 2009",
  `SHA-256: ${expectedFontDigest}`,
  "The Rust source code in this package is licensed under the MIT license",
]) {
  assert.ok(noticeText.includes(required), `the canonical notice is missing: ${required}`);
}
assert.match(manifest, /^license-file = "PACKAGE-LICENSES[.]txt"$/mu);
assert.match(manifest, /^publish = false$/mu);
assert.doesNotMatch(manifest, /^license(?:[.]workspace)?\s*=/mu);
assert.ok(library.includes(`"${expectedFontDigest}"`), "the Rust font digest and notice digest differ");

const outputRoots = new Map([
  ["--web", resolve(repositoryRoot, "dist")],
  ["--server", resolve(repositoryRoot, "dist-server")],
  ["--electron", resolve(electronPackageLayout(repositoryRoot).appRoot, "dist")],
]);
for (const argument of process.argv.slice(2)) {
  const outputRoot = outputRoots.get(argument);
  if (!outputRoot) throw new TypeError(`Unknown third-party notice smoke target: ${argument}`);
  const distributed = await readFile(resolve(outputRoot, noticeName));
  assert.deepEqual(distributed, notice, `${argument} did not ship the canonical third-party notice bytes`);
}

process.stdout.write(
  `${JSON.stringify({ checked: process.argv.slice(2), fontDigest: actualFontDigest, noticeBytes: notice.byteLength })}\n`,
);
