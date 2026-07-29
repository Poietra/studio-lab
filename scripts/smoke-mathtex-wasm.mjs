import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const moduleBase = "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm";
const glueBytes = await readFile(`${moduleBase}.js`);
const wasmBytes = await readFile(`${moduleBase}_bg.wasm`);
const outline = await import(`../${moduleBase}.js`);

await outline.default({ module_or_path: wasmBytes });
assert.equal(outline.poietraMathTexOutlineAbiVersion(), 1);
assert.equal(typeof outline.compileMathTexOutlineV1, "function");

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

const requests = [encodeRequest(["E = mc^2"]), encodeRequest([String.raw`\frac{1}{2}`])];
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

const unsupported = JSON.parse(decoder.decode(wasmResponses[1]));
assertExactKeys(unsupported, ["result", "schema", "version"]);
assert.equal(unsupported.schema, "poietra.mathtex-outline-response");
assert.equal(unsupported.version, 1);
assertExactKeys(unsupported.result, ["code", "kind", "message"]);
assert.equal(unsupported.result.kind, "unsupported");
assert.equal(typeof unsupported.result.code, "string");
assert.ok(unsupported.result.code.length > 0);
assert.equal(typeof unsupported.result.message, "string");
assert.ok(unsupported.result.message.length > 0);
assert.ok(encoder.encode(unsupported.result.message).byteLength <= 512);

const gzipBytes = gzipSync(Buffer.concat([glueBytes, wasmBytes])).byteLength;
console.log(
  JSON.stringify({
    compiledSubpaths: representative.result.path.subpaths.length,
    gzipBytes,
    segmentCount,
    unsupportedCode: unsupported.result.code,
    wasmBytes: wasmBytes.byteLength,
  }),
);
