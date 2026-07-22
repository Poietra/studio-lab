import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findRenderedVideo, waitForRenderExit } from "./manim-render-process";

describe("Manim render process utilities", () => {
  it("selects the completed Scene video and ignores partial movie fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-media-test-"));
    try {
      const partials = join(root, "videos", "scene", "480p15", "partial_movie_files", "Target");
      const output = join(root, "videos", "scene", "480p15");
      await mkdir(partials, { recursive: true });
      await writeFile(join(partials, "newer-fragment.mp4"), "fragment", "utf8");
      await writeFile(join(output, "OtherScene.mp4"), "other", "utf8");
      const expected = join(output, "Target.mp4");
      await writeFile(expected, "complete", "utf8");
      await symlink(expected, join(output, "Linked.mp4"));

      await expect(findRenderedVideo(root, "Target")).resolves.toBe(expected);
      await expect(findRenderedVideo(root, "Missing")).resolves.toBeNull();
      await expect(findRenderedVideo(root, "Linked")).resolves.toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("observes a process that exited before the waiter was attached", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
    await once(child, "exit");

    await expect(waitForRenderExit(child, 1_000)).resolves.toEqual({ code: 7, signal: null });
  });
});
