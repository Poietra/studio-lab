import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { electronPackageLayout } from "./electron-package-layout.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const noticePath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/PACKAGE-LICENSES.txt");
const manifestPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/Cargo.toml");
const libraryPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/src/lib.rs");
const digestPath = resolve(repositoryRoot, "engine/crates/poietra-mathtex-outline/src/digest.rs");
const noticeName = "THIRD_PARTY_NOTICES.txt";
const expectedFontDigest = "e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa";
const expectedFontFaces = [
  "KaTeX_AMS-Regular.ttf",
  "KaTeX_Caligraphic-Bold.ttf",
  "KaTeX_Caligraphic-Regular.ttf",
  "KaTeX_Fraktur-Bold.ttf",
  "KaTeX_Fraktur-Regular.ttf",
  "KaTeX_Main-Bold.ttf",
  "KaTeX_Main-BoldItalic.ttf",
  "KaTeX_Main-Italic.ttf",
  "KaTeX_Main-Regular.ttf",
  "KaTeX_Math-BoldItalic.ttf",
  "KaTeX_Math-Italic.ttf",
  "KaTeX_SansSerif-Bold.ttf",
  "KaTeX_SansSerif-Italic.ttf",
  "KaTeX_SansSerif-Regular.ttf",
  "KaTeX_Script-Regular.ttf",
  "KaTeX_Size1-Regular.ttf",
  "KaTeX_Size2-Regular.ttf",
  "KaTeX_Size3-Regular.ttf",
  "KaTeX_Size4-Regular.ttf",
  "KaTeX_Typewriter-Regular.ttf",
];

const [notice, manifest, library, digestSource] = await Promise.all([
  readFile(noticePath),
  readFile(manifestPath, "utf8"),
  readFile(libraryPath, "utf8"),
  readFile(digestPath, "utf8"),
]);
const noticeText = notice.toString("utf8");

for (const required of [
  "Name: RaTeX",
  "Version: 0.1.14",
  "Pinned revision: ae391d727ac615437c63c308f4538d971a84bede",
  "Name: KaTeX mathematical fonts",
  "License: SIL Open Font License, Version 1.1",
  `Aggregate SHA-256: ${expectedFontDigest}`,
  "The Rust source code in this package is licensed under the MIT license",
]) {
  assert.ok(noticeText.includes(required), `the canonical notice is missing: ${required}`);
}
for (const face of expectedFontFaces) {
  assert.ok(noticeText.includes(`  ${face}\n`), `the canonical notice is missing font face: ${face}`);
}
assert.match(manifest, /^license-file = "PACKAGE-LICENSES[.]txt"$/mu);
assert.match(manifest, /^publish = false$/mu);
assert.doesNotMatch(manifest, /^license(?:[.]workspace)?\s*=/mu);
assert.ok(library.includes(`"${expectedFontDigest}"`), "the Rust font digest and notice digest differ");
assert.ok(digestSource.includes(`font-digest=${expectedFontDigest}`), "the toolchain and font digests differ");

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
  `${JSON.stringify({ checked: process.argv.slice(2), fontDigest: expectedFontDigest, fontFaces: expectedFontFaces.length, noticeBytes: notice.byteLength })}\n`,
);
