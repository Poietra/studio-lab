import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const BASELINE_GZIP_BYTES = 10_600_905;
const PRE_SEGMENTED_GZIP_BYTES = 1_027_693;
const MAX_SEGMENTED_GZIP_DELTA_BYTES = 64 * 1024;
const MAX_GZIP_BYTES = 1_200_000;
const MAX_WARM_COMPILE_P95_MS = 10;
const WARMUP_RUNS = 20;
const MEASURED_RUNS = 200;
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
    texParts: [String.raw`\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}`],
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
const warmCompileMedianMs = percentile(compileSamplesMs, 0.5);
const warmCompileP95Ms = percentile(compileSamplesMs, 0.95);
const report = {
  baselineGzipBytes: BASELINE_GZIP_BYTES,
  glueBytes: glueBytes.byteLength,
  gzipBytes,
  gzipReductionPercent: ((BASELINE_GZIP_BYTES - gzipBytes) / BASELINE_GZIP_BYTES) * 100,
  initializationMs,
  maxGzipBytes: MAX_GZIP_BYTES,
  maxWarmCompileP95Ms: MAX_WARM_COMPILE_P95_MS,
  measuredRuns: MEASURED_RUNS,
  rawWasmBytes: wasmBytes.byteLength,
  segmentedGzipDeltaBytes: gzipBytes - PRE_SEGMENTED_GZIP_BYTES,
  segmentedGzipDeltaLimitBytes: MAX_SEGMENTED_GZIP_DELTA_BYTES,
  warmCompileMedianMs,
  warmCompileP95Ms,
  warmupRuns: WARMUP_RUNS,
};
console.log(JSON.stringify(report, null, 2));

if (check && gzipBytes > MAX_GZIP_BYTES) {
  throw new Error(`MathTex outline WASM gzip budget exceeded: ${gzipBytes} > ${MAX_GZIP_BYTES} bytes.`);
}

if (check && gzipBytes - PRE_SEGMENTED_GZIP_BYTES > MAX_SEGMENTED_GZIP_DELTA_BYTES) {
  throw new Error(
    `Segmented Tex outline WASM gzip delta exceeded: ${gzipBytes - PRE_SEGMENTED_GZIP_BYTES} > ${MAX_SEGMENTED_GZIP_DELTA_BYTES} bytes.`,
  );
}

if (check && warmCompileP95Ms > MAX_WARM_COMPILE_P95_MS) {
  throw new Error(
    `MathTex outline WASM warm compile p95 exceeded: ${warmCompileP95Ms.toFixed(3)}ms > ${MAX_WARM_COMPILE_P95_MS}ms.`,
  );
}
