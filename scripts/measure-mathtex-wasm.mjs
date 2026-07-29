import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const BASELINE_GZIP_BYTES = 10_600_905;
const MAX_GZIP_BYTES = Math.floor(BASELINE_GZIP_BYTES * 0.9);
const WARMUP_RUNS = 20;
const MEASURED_RUNS = 200;
// Warm timings stay in the report rather than the fail gate: shared-runner
// scheduling is not stable enough for a millisecond-level CI threshold.
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultModuleBase = `${repositoryRoot}/public/engine-wasm/mathtex-outline/poietra_mathtex_wasm`;

let check = false;
let moduleBase = defaultModuleBase;
let moduleBaseSupplied = false;
for (const argument of process.argv.slice(2)) {
  if (argument === "--check") {
    check = true;
  } else if (argument.startsWith("-")) {
    throw new Error(`Unknown option: ${argument}`);
  } else if (!moduleBaseSupplied) {
    moduleBase = argument;
    moduleBaseSupplied = true;
  } else {
    throw new Error("Only one module base path may be supplied.");
  }
}

const glueBytes = await readFile(`${moduleBase}.js`);
const wasmBytes = await readFile(`${moduleBase}_bg.wasm`);
const outline = await import(`${pathToFileURL(`${moduleBase}.js`).href}?measure=${Date.now()}`);

const initializationStarted = performance.now();
await outline.default({ module_or_path: wasmBytes });
const initializationMs = performance.now() - initializationStarted;

const request = new TextEncoder().encode(
  JSON.stringify({
    schema: "poietra.mathtex-outline-request",
    texParts: ["E = mc^2"],
    version: 1,
  }),
);
for (let index = 0; index < WARMUP_RUNS; index += 1) outline.compileMathTexOutlineV1(request);

const compileSamplesMs = [];
for (let index = 0; index < MEASURED_RUNS; index += 1) {
  const started = performance.now();
  outline.compileMathTexOutlineV1(request);
  compileSamplesMs.push(performance.now() - started);
}
compileSamplesMs.sort((left, right) => left - right);

function percentile(samples, quantile) {
  return samples[Math.ceil(samples.length * quantile) - 1];
}

const gzipBytes = gzipSync(Buffer.concat([glueBytes, wasmBytes]), { level: 6 }).byteLength;
const report = {
  baselineGzipBytes: BASELINE_GZIP_BYTES,
  glueBytes: glueBytes.byteLength,
  gzipBytes,
  gzipReductionPercent: ((BASELINE_GZIP_BYTES - gzipBytes) / BASELINE_GZIP_BYTES) * 100,
  initializationMs,
  maxGzipBytes: MAX_GZIP_BYTES,
  measuredRuns: MEASURED_RUNS,
  rawWasmBytes: wasmBytes.byteLength,
  warmCompileMedianMs: percentile(compileSamplesMs, 0.5),
  warmCompileP95Ms: percentile(compileSamplesMs, 0.95),
  warmupRuns: WARMUP_RUNS,
};
console.log(JSON.stringify(report, null, 2));

if (check && gzipBytes > MAX_GZIP_BYTES) {
  throw new Error(
    `MathTex outline WASM gzip budget exceeded: ${gzipBytes} > ${MAX_GZIP_BYTES} bytes (10% below baseline).`,
  );
}
