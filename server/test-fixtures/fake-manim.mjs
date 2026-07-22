import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  if (process.argv.includes("--fail-version")) process.exit(7);
  process.stdout.write("fake-manim 1.0\n");
  process.exit(0);
}

const mediaIndex = process.argv.indexOf("--media_dir");
const mediaRoot = mediaIndex >= 0 ? process.argv[mediaIndex + 1] : null;
if (!mediaRoot) {
  process.stderr.write("Missing --media_dir\n");
  process.exit(2);
}

process.stdout.write("Rendering 50%\n");
await new Promise((resolve) => setTimeout(resolve, 80));
const output = join(mediaRoot, "videos", "fake", "480p15");
await mkdir(output, { recursive: true });
await writeFile(join(output, "GroupedEquation.mp4"), Buffer.from("fake-mp4-preview"));
process.stdout.write("Rendering 100%\n");
