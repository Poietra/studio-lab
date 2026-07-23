import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importManimScene, type ImportedManimScene } from "../src/render-pipeline/source-import";
import { handleManimRequest } from "./manim-render-http";
import { ManimProjectRegistry, ManimRenderManager } from "./manim-render-pipeline";
import {
  renderManimSceneThumbnailSvg,
  representativeManimSceneTime,
} from "./manim-thumbnail";
import { discoverFirstManimScene, discoverPythonSources } from "./manim-workspace";

const temporaryRoots: string[] = [];
const managers: ManimRenderManager[] = [];
const registries: ManimProjectRegistry[] = [];
const frame = { height: 8, width: 14.222 } as const;

afterEach(async () => {
  await Promise.allSettled([
    ...managers.splice(0).map((manager) => manager.close()),
    ...registries.splice(0).map((registry) => registry.close()),
  ]);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function sceneSource(name: string, content: string) {
  return `from manim import *

class ${name}(Scene):
    def construct(self):
        item = Text(${JSON.stringify(content)})
        self.add(item)
        self.wait(1)
`;
}

describe("Manim thumbnail source discovery", () => {
  it("uses sorted traversal and returns the first importable Scene without doing project-wide discovery", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-discovery-"));
    temporaryRoots.push(projectRoot);
    await mkdir(join(projectRoot, "a-scenes"));
    await Promise.all([
      writeFile(join(projectRoot, "a-scenes", "a.py"), "value = 1\n", "utf8"),
      writeFile(join(projectRoot, "a-scenes", "b.py"), sceneSource("NestedFirst", "first"), "utf8"),
      writeFile(join(projectRoot, "b.py"), sceneSource("RootLater", "later"), "utf8"),
    ]);

    const first = await discoverFirstManimScene(projectRoot, frame);
    expect(first?.sceneId).toBe("a-scenes/b.py#NestedFirst");
    expect((await discoverPythonSources(projectRoot, frame)).map((source) => source.path))
      .toEqual(["a-scenes/b.py", "b.py"]);
  });
});

describe("safe Manim scene thumbnails", () => {
  it("chooses the earliest time with the most visible entities and renders their type, content, and position", () => {
    const source = `from manim import *

class Representative(Scene):
    def construct(self):
        early = Text("early")
        equation = MathTex("x < y", "& z")
        circle = Circle()
        self.add(early)
        self.wait(1)
        self.remove(early)
        self.wait(1)
        self.add(equation, circle)
        self.wait(2)
`;
    const imported = importManimScene(source, "scene.py", "Representative", frame);
    if (!imported) throw new Error("The thumbnail fixture Scene was not imported.");

    expect(representativeManimSceneTime(imported.runtimeSceneState)).toBe(2);
    const svg = renderManimSceneThumbnailSvg(imported.runtimeSceneState);
    expect(svg).toContain('transform="translate(320 135) scale(1)"');
    expect(svg).toContain('transform="translate(470 135) scale(1)"');
    expect(svg).toContain("x &lt; y &amp; z");
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("early");
  });

  it("bounds entities and text while emitting only escaped, inert SVG markup", () => {
    const assignments = Array.from({ length: 48 }, (_, index) => (
      `        item_${index} = Text(${JSON.stringify(index === 0 ? "<script>& exploit" : `item ${index}`)})`
    ));
    const variables = Array.from({ length: 48 }, (_, index) => `item_${index}`).join(", ");
    const source = `from manim import *

class Bounded(Scene):
    def construct(self):
${assignments.join("\n")}
        self.add(${variables})
        self.wait(1)
`;
    const imported = importManimScene(source, "bounded.py", "Bounded", frame);
    if (!imported) throw new Error("The bounded thumbnail fixture Scene was not imported.");

    const svg = renderManimSceneThumbnailSvg(imported.runtimeSceneState);
    expect(svg.match(/<g\b/g)).toHaveLength(32);
    expect(svg.match(/<text\b/g)).toHaveLength(16);
    expect(svg).toContain("&lt;script&gt;&amp; exploit");
    expect(svg).not.toMatch(/<script\b/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg.length).toBeLessThan(20_000);
  });
});

describe("Manim thumbnail manager and HTTP boundary", () => {
  it("coalesces and caches discovery, does not run Manim, and blocks unregister while scanning", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-manager-"));
    temporaryRoots.push(projectRoot);
    const imported = importManimScene(sceneSource("Cached", "cached"), "scene.py", "Cached", frame);
    if (!imported) throw new Error("The cached thumbnail fixture Scene was not imported.");
    const commandMarker = join(projectRoot, "command-ran");
    const command = join(projectRoot, "command.mjs");
    await writeFile(command, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(commandMarker)}, "ran");\n`, "utf8");
    let discoveryCount = 0;
    let releaseDiscovery!: (scene: ImportedManimScene) => void;
    const pendingDiscovery = new Promise<ImportedManimScene>((resolve) => {
      releaseDiscovery = resolve;
    });
    const manager = new ManimRenderManager({
      command: [process.execPath, command],
      frame,
      projectRoot,
      thumbnailSceneDiscovery: async () => {
        discoveryCount += 1;
        return pendingDiscovery;
      },
    });
    managers.push(manager);

    const first = manager.thumbnailSvg();
    const second = manager.thumbnailSvg();
    expect(discoveryCount).toBe(1);
    expect(manager.canUnregister()).toBe(false);
    releaseDiscovery(imported);
    const [firstSvg, secondSvg] = await Promise.all([first, second]);
    expect(firstSvg).toBe(secondSvg);
    expect(manager.canUnregister()).toBe(true);
    expect(await manager.thumbnailSvg()).toBe(firstSvg);
    expect(discoveryCount).toBe(1);
    await manager.thumbnailSvg("default", Date.now() + 31_000);
    expect(discoveryCount).toBe(2);
    await expect(readFile(commandMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves secured SVG and an SVG 404 fallback through the project registry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-http-"));
    const emptyRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-empty-"));
    temporaryRoots.push(projectRoot, emptyRoot);
    await writeFile(join(projectRoot, "scene.py"), sceneSource("HttpThumbnail", "<safe & visible>"), "utf8");
    const registry = new ManimProjectRegistry({
      command: ["poietra-command-that-does-not-exist"],
      frame,
      projects: [
        { id: "project-thumbnail", name: "Thumbnail", root: projectRoot },
        { id: "project-empty", name: "Empty", root: emptyRoot },
      ],
    });
    registries.push(registry);
    const server = createServer((request, response) => {
      void handleManimRequest(registry, request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const thumbnail = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
      expect(thumbnail.headers.get("x-content-type-options")).toBe("nosniff");
      expect(thumbnail.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(thumbnail.headers.get("cache-control")).toBe("no-store");
      const svg = await thumbnail.text();
      expect(svg).toContain("&lt;safe &amp; visible&gt;");
      expect(svg).not.toMatch(/<script\b|foreignObject/i);

      const rejectedMethod = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejectedMethod.status).toBe(405);

      for (const projectId of ["project-empty", "project-missing"]) {
        const fallback = await fetch(`${origin}/api/manim/projects/${projectId}/thumbnail`);
        expect(fallback.status).toBe(404);
        expect(fallback.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
        expect(await fallback.text()).toContain("No scene preview");
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
