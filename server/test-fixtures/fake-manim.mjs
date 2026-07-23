import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  const markerIndex = process.argv.indexOf("--version-marker");
  if (markerIndex >= 0 && process.argv[markerIndex + 1]) {
    await writeFile(process.argv[markerIndex + 1], "checking", "utf8");
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

const renderStartMarkerIndex = process.argv.indexOf("--render-start-marker");
if (renderStartMarkerIndex >= 0 && process.argv[renderStartMarkerIndex + 1]) {
  await writeFile(process.argv[renderStartMarkerIndex + 1], "started", "utf8");
}

process.stdout.write("Rendering 50%\n");
await new Promise((resolve) => setTimeout(resolve, process.argv.includes("--slow-render") ? 10_000 : 80));
if (process.argv.includes("-s")) {
  const sceneName = process.argv.at(-1);
  const output = join(mediaRoot, "images", "fake");
  await mkdir(output, { recursive: true });
  const png = process.argv.includes("--invalid-png")
    ? Buffer.from("not-a-png")
    : Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
  await writeFile(join(output, `${sceneName}.png`), png);
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
