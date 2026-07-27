import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig, ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import {
  ManimRenderManager,
  manimRenderPipeline,
  parseManimCommand,
  parseManimProjects,
} from "./manim-render-pipeline";
import { cleanupManimRenderPipelineFixtures, temporaryRoots } from "./manim-render-pipeline-test-fixtures";

afterEach(cleanupManimRenderPipelineFixtures);

describe("Manim command parsing", () => {
  it("accepts a JSON command without invoking a shell", () => {
    expect(parseManimCommand('["uv", "run", "manim"]')).toEqual(["uv", "run", "manim"]);
    expect(parseManimCommand(undefined)).toEqual(["manim"]);
  });

  it("parses a future multi-project environment registry", () => {
    expect(parseManimProjects('[{"id":"project-a","name":"A","root":"/tmp/a"},"/tmp/b"]')).toEqual([
      { id: "project-a", name: "A", root: "/tmp/a" },
      { root: "/tmp/b" },
    ]);
    expect(() => parseManimProjects('[{"root":"/tmp/a","path":"/private"}]')).toThrow(/unsupported field/i);
  });
});

describe("Manim render plugin configuration", () => {
  it.each([
    { frame: { height: 0, width: 14.222 }, message: /frame height/i },
    { frame: { height: 8, width: Number.NaN }, message: /frame width/i },
  ])("rejects invalid frame dimensions", ({ frame, message }) => {
    expect(
      () =>
        new ManimRenderManager({
          command: [process.execPath],
          frame,
          projectRoot: process.cwd(),
        }),
    ).toThrow(message);
  });

  it("is serve-only and does not return a Vite post hook that closes the manager", async () => {
    const workspaceDataRoot = await mkdtemp(join(tmpdir(), "poietra-plugin-catalog-"));
    temporaryRoots.push(workspaceDataRoot);
    const plugin = manimRenderPipeline({ workspaceDataRoot });
    expect(plugin.apply).toBe("serve");
    const configureResolved = plugin.configResolved as (config: ResolvedConfig) => void;
    configureResolved({ root: process.cwd() } as ResolvedConfig);
    const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
    const postHook = configureServer({
      middlewares: { use: () => undefined },
    } as unknown as ViteDevServer);

    expect(postHook).toBeUndefined();
    const closeBundle = plugin.closeBundle as () => Promise<void>;
    await closeBundle();
  });
});
