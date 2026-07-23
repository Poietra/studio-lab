import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

if (process.argv.includes("--version")) {
  const markerIndex = process.argv.indexOf("--version-marker");
  if (markerIndex >= 0 && process.argv[markerIndex + 1]) {
    await writeFile(process.argv[markerIndex + 1], String(process.pid), "utf8");
  }
  if (process.argv.includes("--hang-version")) {
    await new Promise(() => setInterval(() => undefined, 1_000));
  }
  if (process.argv.includes("--slow-version")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (process.argv.includes("--fail-version")) process.exit(7);
  process.stdout.write("fake-manim 1.0\n");
  process.exit(0);
}

if (process.argv.includes("--fail-render")) {
  process.stderr.write("Thumbnail render failed\n");
  process.exit(9);
}

const mediaIndex = process.argv.indexOf("--media_dir");
const mediaRoot = mediaIndex >= 0 ? process.argv[mediaIndex + 1] : null;
if (!mediaRoot) {
  process.stderr.write("Missing --media_dir\n");
  process.exit(2);
}

const argvMarkerIndex = process.argv.indexOf("--argv-marker");
if (argvMarkerIndex >= 0 && process.argv[argvMarkerIndex + 1]) {
  await writeFile(process.argv[argvMarkerIndex + 1], JSON.stringify(process.argv.slice(2)), "utf8");
}

const slowTransactionIndex = process.argv.indexOf("--slow-transaction");
const slowTransaction = slowTransactionIndex >= 0 ? process.argv[slowTransactionIndex + 1] : null;
const previewSourcePath = process.argv.find((argument) => argument.endsWith(".py"));
if (
  slowTransaction &&
  previewSourcePath &&
  (await readFile(previewSourcePath, "utf8")).includes(`poietra:transaction "${slowTransaction}"`)
) {
  const shutdownMarkerIndex = process.argv.indexOf("--shutdown-marker");
  if (shutdownMarkerIndex >= 0 && process.argv[shutdownMarkerIndex + 1]) {
    await writeFile(
      process.argv[shutdownMarkerIndex + 1],
      JSON.stringify({ pid: process.pid, tempRoot: dirname(previewSourcePath) }),
      "utf8",
    );
  }
  await new Promise(() => setInterval(() => undefined, 1_000));
}

const renderStartMarkerIndex = process.argv.indexOf("--render-start-marker");
if (renderStartMarkerIndex >= 0 && process.argv[renderStartMarkerIndex + 1]) {
  await writeFile(process.argv[renderStartMarkerIndex + 1], "started", "utf8");
}
const renderCountMarkerIndex = process.argv.indexOf("--render-count-marker");
if (renderCountMarkerIndex >= 0 && process.argv[renderCountMarkerIndex + 1]) {
  await appendFile(process.argv[renderCountMarkerIndex + 1], "started\n", "utf8");
}
const thumbnailStartMarkerIndex = process.argv.indexOf("--thumbnail-start-marker");
if (process.argv.includes("-s") && thumbnailStartMarkerIndex >= 0 && process.argv[thumbnailStartMarkerIndex + 1]) {
  await writeFile(process.argv[thumbnailStartMarkerIndex + 1], "started", "utf8");
}

process.stdout.write("Rendering 50%\n");
const slowRender =
  process.argv.includes("--slow-render") || (process.argv.includes("--slow-thumbnail") && process.argv.includes("-s"));
await new Promise((resolve) => setTimeout(resolve, slowRender ? 10_000 : 80));
if (process.argv.includes("-s")) {
  const sceneName = process.argv.at(-1);
  const outputFileIndex = process.argv.indexOf("--output_file");
  const explicitOutputName = outputFileIndex >= 0 ? process.argv[outputFileIndex + 1] : null;
  const imageName = explicitOutputName
    ? `${explicitOutputName.replace(/\.png$/i, "")}.png`
    : `${sceneName}_ManimCE_v0.20.1.png`;
  const output = join(mediaRoot, "images", "fake");
  await mkdir(output, { recursive: true });
  const png = process.argv.includes("--invalid-png")
    ? Buffer.from("not-a-png")
    : Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
  await writeFile(join(output, imageName), png);
} else {
  const output = join(mediaRoot, "videos", "fake", "480p15");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "GroupedEquation.mp4"), Buffer.from("fake-mp4-preview"));
}
const completionMarkerIndex = process.argv.indexOf("--completion-marker");
if (completionMarkerIndex >= 0 && process.argv[completionMarkerIndex + 1]) {
  await writeFile(process.argv[completionMarkerIndex + 1], "completed", "utf8");
}
process.stdout.write("Rendering 100%\n");
