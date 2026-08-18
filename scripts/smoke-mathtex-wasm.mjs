import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const moduleBase = "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm";
const glueBytes = await readFile(`${moduleBase}.js`);
const wasmBytes = await readFile(`${moduleBase}_bg.wasm`);
const outline = await import(`../${moduleBase}.js`);

await outline.default({ module_or_path: wasmBytes });
assert.equal(outline.poietraMathTexOutlineAbiVersion(), 1);
assert.equal(typeof outline.compileMathTexOutlineV1, "function");
assert.equal(outline.poietraSegmentedTexOutlineAbiVersion(), 1);
assert.equal(typeof outline.compileSegmentedTexOutlineV1, "function");
assert.equal(outline.poietraTextOutlineAbiVersion(), 1);
assert.equal(typeof outline.compileTextOutlineV1, "function");

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encodeRequest(texParts) {
  return encoder.encode(
    JSON.stringify({
      schema: "poietra.mathtex-outline-request",
      texParts,
      version: 1,
    }),
  );
}

function compileWasm(request) {
  const responseBytes = outline.compileMathTexOutlineV1(request);
  assert.ok(responseBytes instanceof Uint8Array);
  assert.ok(responseBytes.byteLength > 0 && responseBytes.byteLength <= 1024 * 1024);
  return responseBytes;
}

function encodeTextRequest(text) {
  return encoder.encode(
    JSON.stringify({
      schema: "poietra.text-outline-request",
      text,
      version: 1,
    }),
  );
}

function compileTextWasm(request) {
  const responseBytes = outline.compileTextOutlineV1(request);
  assert.ok(responseBytes instanceof Uint8Array);
  assert.ok(responseBytes.byteLength > 0 && responseBytes.byteLength <= 1024 * 1024);
  return responseBytes;
}

function encodeSegmentedRequest({ mode, paintMatches = [], source, sourceKind = "literal" }) {
  return encoder.encode(
    JSON.stringify({
      mode,
      paintMatches,
      schema: "poietra.segmented-tex-outline-request",
      source,
      sourceKind,
      version: 1,
    }),
  );
}

function compileSegmentedWasm(request) {
  const responseBytes = outline.compileSegmentedTexOutlineV1(request);
  assert.ok(responseBytes instanceof Uint8Array);
  assert.ok(responseBytes.byteLength > 0 && responseBytes.byteLength <= 1024 * 1024);
  return responseBytes;
}

const corpus = JSON.parse(await readFile(new URL("../fixtures/mathtex-v1/manim-corpus.json", import.meta.url), "utf8"));
assert.equal(corpus.schema, "poietra.mathtex-manim-corpus");
assert.equal(corpus.version, 1);
assert.equal(corpus.cases.length, 25);

const compiledRequests = corpus.cases.map(({ texParts }) => encodeRequest(texParts));
const sourceProfile = JSON.parse(
  await readFile(new URL("../fixtures/mathtex-manim-parity-v1/source-profile.json", import.meta.url), "utf8"),
);
assert.equal(sourceProfile.schema, "poietra.mathtex-manim-source-profile");
assert.equal(sourceProfile.version, 1);
assert.equal(sourceProfile.profile, "core-ams");
assert.equal(sourceProfile.cases.length, 15);
const sourceProfileCompiledRequests = sourceProfile.cases.map(({ expectedOutcome, texParts }) => {
  assert.equal(expectedOutcome, "latex-compile-success");
  return encodeRequest(texParts);
});
const macroAmplifier = `\\def\\a#1{${"#1".repeat(300)}}\\a{${"x".repeat(250)}}`;
assert.equal(encoder.encode(macroAmplifier).byteLength, 864);
const macroRequests = [macroAmplifier, `\\url{${macroAmplifier}}`, `\\href{${macroAmplifier}}{x}`].map((source) =>
  encodeRequest([source]),
);
const excludedSourceProfileRequests = [
  String.raw`\hat\\`,
  String.raw`\hat{\\}`,
  String.raw`\vec\\`,
  String.raw`\vec{\\}`,
  String.raw`\sqrt}`,
  String.raw`\sqrt\begin{matrix}x\end{matrix}`,
  String.raw`\sqrt&`,
  String.raw`\sqrt{\\}`,
  String.raw`\left x \right)`,
  String.raw`\left( x \right y`,
  String.raw`\left(x\\y\right)`,
  String.raw`\begin{matrix}\left(x\\y\right)\end{matrix}`,
  String.raw`\begin{array}{c}\left(x\\y\right)\end{array}`,
  String.raw`\text{\begin{matrix}x\end{matrix}}`,
  String.raw`\text{\begin{matrix}x\\y\end{matrix}}`,
  String.raw`\textbf{\begin{matrix}x\end{matrix}}`,
  String.raw`\textbf{\begin{matrix}x\\y\end{matrix}}`,
  String.raw`\frac{\\}{b}`,
  String.raw`\frac{a}{\\}`,
  String.raw`x^}`,
  String.raw`x_}`,
  String.raw`x^&`,
  String.raw`x_&`,
  String.raw`x^\begin{matrix}x\end{matrix}`,
  String.raw`x_\begin{matrix}x\end{matrix}`,
  String.raw`x^\begin{matrix}x\\y\end{matrix}`,
  String.raw`x_\begin{matrix}x\\y\end{matrix}`,
  String.raw`\htmlStyle{font-size:2em}{x}`,
  String.raw`\href{https://example.test}{x}`,
  String.raw`\url{https://example.test}`,
  String.raw`\ce{H2O}`,
  String.raw`\color{red}{x}`,
  String.raw`\textcolor{red}{x}`,
  "α",
  "∑",
  "√x",
  "é",
  "ℝ",
  "x#y",
  "x%y",
  "$x$",
  String.raw`\begin{array}{c:c}a&b\end{array}`,
  String.raw`\begin{array}{:}a\end{array}`,
  String.raw`a\\*b`,
  String.raw`a\\[1mu]b`,
].map((source) => encodeRequest([source]));
const requests = [
  ...compiledRequests,
  ...sourceProfileCompiledRequests,
  ...macroRequests,
  ...excludedSourceProfileRequests,
  encodeRequest([]),
];
const wasmResponses = requests.map(compileWasm);
const nativeOutput = execFileSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--locked",
    "--package",
    "poietra-mathtex-wasm",
    "--example",
    "compile_request",
    "--manifest-path",
    "engine/Cargo.toml",
  ],
  { input: Buffer.concat(requests.flatMap((request) => [request, Buffer.from("\n")])), maxBuffer: 3 * 1024 * 1024 },
);
const nativeResponses = decoder
  .decode(nativeOutput)
  .trimEnd()
  .split("\n")
  .map((response) => encoder.encode(response));
assert.equal(nativeResponses.length, wasmResponses.length);
for (const [index, wasmResponse] of wasmResponses.entries()) {
  assert.deepEqual(
    Buffer.from(wasmResponse),
    Buffer.from(nativeResponses[index]),
    `native and WASM response ${index} must be byte-identical`,
  );
}

const textRequests = [
  encodeTextRequest("日本語で動画を作る"),
  encodeTextRequest("こんにちは\nPoietra"),
  encodeTextRequest("こんにちは\r\nPoietra"),
  encodeTextRequest("tab\tcharacter"),
];
const textWasmResponses = textRequests.map(compileTextWasm);
const textNativeOutput = execFileSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--locked",
    "--package",
    "poietra-mathtex-wasm",
    "--example",
    "compile_text_request",
    "--manifest-path",
    "engine/Cargo.toml",
  ],
  { input: Buffer.concat(textRequests.flatMap((request) => [request, Buffer.from("\n")])), maxBuffer: 3 * 1024 * 1024 },
);
const textNativeResponses = decoder
  .decode(textNativeOutput)
  .trimEnd()
  .split("\n")
  .map((response) => encoder.encode(response));
assert.equal(textNativeResponses.length, textWasmResponses.length);
for (const [index, wasmResponse] of textWasmResponses.entries()) {
  assert.deepEqual(
    Buffer.from(wasmResponse),
    Buffer.from(textNativeResponses[index]),
    `plain Text native and WASM response ${index} must be byte-identical`,
  );
}
for (const response of textWasmResponses.slice(0, 3)) {
  const parsed = JSON.parse(decoder.decode(response));
  assert.equal(parsed.schema, "poietra.text-outline-response");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.result.kind, "compiled");
  assert.equal(parsed.result.fillRule, "nonzero");
  assert.ok(parsed.result.path.subpaths.length > 0);
}
assert.deepEqual(
  Buffer.from(textWasmResponses[1]),
  Buffer.from(textWasmResponses[2]),
  "LF and CRLF must compile to the same canonical Text outline",
);
const unsupportedText = JSON.parse(decoder.decode(textWasmResponses[3]));
assert.equal(unsupportedText.result.kind, "unsupported");
assert.equal(unsupportedText.result.code, "character-unsupported");

for (const [index, response] of wasmResponses.slice(0, compiledRequests.length).entries()) {
  const result = JSON.parse(decoder.decode(response));
  assert.equal(result.result.kind, "compiled", `${corpus.cases[index].id} must compile in the WASM acceptance corpus`);
}
for (const [index, response] of wasmResponses
  .slice(compiledRequests.length, compiledRequests.length + sourceProfileCompiledRequests.length)
  .entries()) {
  const result = JSON.parse(decoder.decode(response));
  assert.equal(
    result.result.kind,
    "compiled",
    `${sourceProfile.cases[index].id} must compile in the pinned Manim source profile`,
  );
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertPoint(point) {
  assertExactKeys(point, ["x", "y"]);
  assert.ok(Number.isFinite(point.x));
  assert.ok(Number.isFinite(point.y));
}

const representative = JSON.parse(decoder.decode(wasmResponses[0]));
assertExactKeys(representative, ["result", "schema", "version"]);
assert.equal(representative.schema, "poietra.mathtex-outline-response");
assert.equal(representative.version, 1);
assertExactKeys(representative.result, [
  "bounds",
  "contentDigest",
  "fillRule",
  "fontDigest",
  "kind",
  "path",
  "toolchainDigest",
]);
assert.equal(representative.result.kind, "compiled");
assert.equal(representative.result.fillRule, "nonzero");
for (const digest of [
  representative.result.contentDigest,
  representative.result.toolchainDigest,
  representative.result.fontDigest,
]) {
  assert.match(digest, /^[0-9a-f]{64}$/);
}

assertExactKeys(representative.result.bounds, ["bottom", "left", "right", "top"]);
for (const coordinate of Object.values(representative.result.bounds)) assert.ok(Number.isFinite(coordinate));
assert.ok(Math.abs(representative.result.bounds.top - representative.result.bounds.bottom - 1) <= 0.000_002);
assert.ok(Math.abs(representative.result.bounds.left + representative.result.bounds.right) <= 0.000_002);
assert.ok(Math.abs(representative.result.bounds.bottom + representative.result.bounds.top) <= 0.000_002);

assertExactKeys(representative.result.path, ["subpaths"]);
assert.ok(representative.result.path.subpaths.length > 1);
let segmentCount = 0;
for (const subpath of representative.result.path.subpaths) {
  assertExactKeys(subpath, ["closed", "segments", "start"]);
  assert.equal(subpath.closed, true);
  assertPoint(subpath.start);
  assert.ok(subpath.segments.length > 0);
  segmentCount += subpath.segments.length;
  for (const segment of subpath.segments) {
    assertExactKeys(segment, ["control1", "control2", "end"]);
    assertPoint(segment.control1);
    assertPoint(segment.control2);
    assertPoint(segment.end);
  }
}
assert.ok(segmentCount > 0 && segmentCount <= 2048);

const macroFallbacks = wasmResponses
  .slice(
    compiledRequests.length + sourceProfileCompiledRequests.length,
    compiledRequests.length + sourceProfileCompiledRequests.length + macroRequests.length,
  )
  .map((response) => JSON.parse(decoder.decode(response)));
for (const macroFallback of macroFallbacks) {
  assertExactKeys(macroFallback, ["result", "schema", "version"]);
  assert.equal(macroFallback.result.kind, "unsupported");
  assert.equal(macroFallback.result.code, "syntax-unsupported");
}

const sourceProfileFallbacks = wasmResponses
  .slice(
    compiledRequests.length + sourceProfileCompiledRequests.length + macroRequests.length,
    compiledRequests.length +
      sourceProfileCompiledRequests.length +
      macroRequests.length +
      excludedSourceProfileRequests.length,
  )
  .map((response) => JSON.parse(decoder.decode(response)));
for (const sourceProfileFallback of sourceProfileFallbacks) {
  assertExactKeys(sourceProfileFallback, ["result", "schema", "version"]);
  assert.equal(sourceProfileFallback.result.kind, "unsupported");
  assert.equal(sourceProfileFallback.result.code, "syntax-unsupported");
}

const unsupported = JSON.parse(decoder.decode(wasmResponses.at(-1)));
assertExactKeys(unsupported, ["result", "schema", "version"]);
assert.equal(unsupported.schema, "poietra.mathtex-outline-response");
assert.equal(unsupported.version, 1);
assertExactKeys(unsupported.result, ["code", "kind", "message"]);
assert.equal(unsupported.result.kind, "unsupported");
assert.equal(unsupported.result.code, "invalid-request");
assert.equal(typeof unsupported.result.message, "string");
assert.ok(unsupported.result.message.length > 0);
assert.ok(encoder.encode(unsupported.result.message).byteLength <= 512);

const frozenAggregateWires = [
  [encodeRequest(["E = mc^2"]), "62fd900a1efd0add6b76502b4236f824d70f67de4885b506b7998e5b59601e6d"],
  [
    encodeRequest([String.raw`\sum_{k=1}^\infty {1 \over k^2} = {\pi^2 \over 6}`]),
    "545bc76ba67250fb044f33c67dcfb585d5c71faae0b79e50f748c06d80f67553",
  ],
];
for (const [request, expectedSha256] of frozenAggregateWires) {
  const response = compileWasm(request);
  assert.equal(
    createHash("sha256").update(response).digest("hex"),
    expectedSha256,
    "the aggregate MathTex V1 wire must remain byte-for-byte frozen",
  );
}

const officialSegmentedRequests = [
  encodeSegmentedRequest({
    mode: "tex-text",
    paintMatches: [{ literal: "text", paint: { alpha: 1, blue: 0, green: 1, red: 1 } }],
    source: "This is a some text",
  }),
  encodeSegmentedRequest({
    mode: "mathtex-math",
    source: String.raw`\sum_{k=1}^\infty {1 \over k^2} = {\pi^2 \over 6}`,
  }),
];
const segmentedWasmResponses = officialSegmentedRequests.map(compileSegmentedWasm);
const segmentedNativeOutput = execFileSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--locked",
    "--package",
    "poietra-mathtex-wasm",
    "--example",
    "compile_segmented_request",
    "--manifest-path",
    "engine/Cargo.toml",
  ],
  {
    input: Buffer.concat(officialSegmentedRequests.flatMap((request) => [request, Buffer.from("\n")])),
    maxBuffer: 1024 * 1024,
  },
);
const segmentedNativeResponses = decoder
  .decode(segmentedNativeOutput)
  .trimEnd()
  .split("\n")
  .map((response) => encoder.encode(response));
assert.equal(segmentedNativeResponses.length, segmentedWasmResponses.length);
for (const [index, wasmResponse] of segmentedWasmResponses.entries()) {
  assert.deepEqual(
    Buffer.from(wasmResponse),
    Buffer.from(segmentedNativeResponses[index]),
    `segmented native and WASM response ${index} must be byte-identical`,
  );
}

const [segmentedText, segmentedMath] = segmentedWasmResponses.map((response) => JSON.parse(decoder.decode(response)));
for (const response of [segmentedText, segmentedMath]) {
  assert.equal(response.schema, "poietra.segmented-tex-outline-response");
  assert.equal(response.version, 1);
  assert.equal(response.result.kind, "compiled");
  assert.equal(response.result.writePlan.representation, "separate-outline-and-fill-entities");
  assert.equal(response.result.writePlan.phaseBoundary, 0.5);
  assert.equal(response.result.writePlan.outlineStrokeWidth, 2);
  assert.ok(
    response.result.fragments.every(({ fillEntityId, id, outlineEntityId }) => {
      return outlineEntityId === `${id}:outline` && fillEntityId === `${id}:fill`;
    }),
  );
}
assert.equal(segmentedText.result.fragments.length, 15);
assert.deepEqual(
  segmentedText.result.fragments.filter(({ paint }) => paint.blue === 0).map(({ order }) => order),
  [11, 12, 13, 14],
);
assert.ok(
  segmentedText.result.fragments.every(({ sourceCorrelation }) => sourceCorrelation.kind === "exact-byte-range"),
);
assert.equal(segmentedMath.result.fragments.length, 14);
assert.equal(segmentedMath.result.fragments.filter(({ kind }) => kind === "rule").length, 2);
assert.ok(
  segmentedMath.result.fragments.every(({ sourceCorrelation }) => sourceCorrelation.kind === "expression-byte-range"),
);

const segmentedFallbacks = [
  encodeSegmentedRequest({ mode: "tex-text", source: "dynamic()", sourceKind: "dynamic" }),
  encodeSegmentedRequest({
    mode: "tex-text",
    paintMatches: [{ literal: "text", paint: { alpha: 1, blue: 0, green: 1, red: 1 } }],
    source: "text and text",
  }),
  encoder.encode(
    JSON.stringify({
      mode: "tex-text",
      paintMatches: [],
      schema: "poietra.segmented-tex-outline-request",
      source: "x",
      sourceKind: "literal",
      unsupportedOption: true,
      version: 1,
    }),
  ),
].map((request) => JSON.parse(decoder.decode(compileSegmentedWasm(request))));
assert.deepEqual(
  segmentedFallbacks.map(({ result }) => result.code),
  ["dynamic-source-unsupported", "paint-partition-ambiguous", "invalid-request"],
);

const gzipBytes = gzipSync(Buffer.concat([glueBytes, wasmBytes])).byteLength;
console.log(
  JSON.stringify({
    compiledCases: compiledRequests.length,
    compiledSubpaths: representative.result.path.subpaths.length,
    gzipBytes,
    segmentCount,
    segmentedFormulaFragments: segmentedMath.result.fragments.length,
    segmentedTextFragments: segmentedText.result.fragments.length,
    segmentedUnsupportedCodes: segmentedFallbacks.map(({ result }) => result.code),
    macroUnsupportedCases: macroFallbacks.length,
    macroUnsupportedCode: macroFallbacks[0].result.code,
    sourceProfileCompiledCases: sourceProfileCompiledRequests.length,
    sourceProfileUnsupportedCases: sourceProfileFallbacks.length,
    sourceProfileUnsupportedCode: sourceProfileFallbacks[0].result.code,
    unsupportedCode: unsupported.result.code,
    wasmBytes: wasmBytes.byteLength,
  }),
);
