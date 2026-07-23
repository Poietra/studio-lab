import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { importManimScene } from "../src/render-pipeline/source-import";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
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
const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));

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
      writeFile(join(projectRoot, "unsafe\\name.py"), sceneSource("UnsafePath", "unsafe"), "utf8"),
    ]);
    await symlink(join(projectRoot, "b.py"), join(projectRoot, "linked.py"));

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
  it("serves a semantic fallback without running Manim", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-manager-"));
    temporaryRoots.push(projectRoot);
    await writeFile(join(projectRoot, "scene.py"), sceneSource("Cached", "cached"), "utf8");
    const commandMarker = join(projectRoot, "command-ran");
    const command = join(projectRoot, "command.mjs");
    await writeFile(command, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(commandMarker)}, "ran");\n`, "utf8");
    const manager = new ManimRenderManager({
      command: [process.execPath, command],
      frame,
      projectRoot,
    });
    managers.push(manager);

    const [first, second] = await Promise.all([manager.thumbnail(), manager.thumbnail()]);
    expect(first.kind).toBe("semantic");
    expect(first.body.equals(second.body)).toBe(true);
    expect(first.body.toString("utf8")).toContain("cached");
    await expect(manager.thumbnailStatus()).resolves.toMatchObject({
      imageKind: "semantic",
      state: "missing",
    });
    expect(manager.canUnregister()).toBe(true);
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
      expect(thumbnail.headers.get("x-poietra-thumbnail-kind")).toBe("semantic");
      expect(thumbnail.headers.get("x-poietra-thumbnail-state")).toBe("missing");
      const svg = await thumbnail.text();
      expect(svg).toContain("&lt;safe &amp; visible&gt;");
      expect(svg).not.toMatch(/<script\b|foreignObject/i);

      const rejectedMethod = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejectedMethod.status).toBe(405);

      const status = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/status`);
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        imageKind: "semantic",
        projectId: "project-thumbnail",
        state: "missing",
      });

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

  it("generates and serves a real PNG only through the explicit HTTP action", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-http-render-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-http-cache-"));
    temporaryRoots.push(projectRoot, cacheRoot);
    await writeFile(join(projectRoot, "scene.py"), sceneSource("RenderedThumbnail", "rendered"), "utf8");
    const renderMarker = join(projectRoot, "thumbnail-render-started");
    const registry = new ManimProjectRegistry({
      command: [process.execPath, fakeRenderer, "--render-start-marker", renderMarker],
      frame,
      projects: [{ id: "project-thumbnail", name: "Thumbnail", root: projectRoot }],
      renderTimeoutMs: 5_000,
      thumbnailCacheRoot: cacheRoot,
    });
    registries.push(registry);
    const server = createServer((request, response) => {
      void handleManimRequest(registry, request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const rejectedRequests = [
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, { method: "POST" }),
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
          body: "{}",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
          body: "{}",
          headers: { "content-type": "application/problem+json" },
          method: "POST",
        }),
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
          body: JSON.stringify({ unexpected: true }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
          body: "{}",
          headers: { "content-type": "application/json", origin: "https://attacker.example" },
          method: "POST",
        }),
        fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
          body: "{}",
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
          method: "POST",
        }),
      ];
      await expect(Promise.all(rejectedRequests).then((responses) => responses.map((response) => response.status)))
        .resolves.toEqual([415, 415, 415, 400, 403, 403]);
      await expect(readFile(renderMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const generated = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
        body: "{}",
        headers: { "content-type": "application/json", origin },
        method: "POST",
      });
      expect(generated.status).toBe(202);
      await expect(generated.json()).resolves.toMatchObject({ state: "generating" });

      let status: { state?: string } = {};
      for (let attempt = 0; attempt < 100 && status.state !== "current"; attempt += 1) {
        status = await (await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/status`)).json();
        if (status.state !== "current") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status.state).toBe("current");
      const thumbnail = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/png");
      expect(thumbnail.headers.get("x-poietra-thumbnail-kind")).toBe("rendered");
      expect(Buffer.from(await thumbnail.arrayBuffer()).subarray(0, 8))
        .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("never exposes absolute renderer, project, or cache paths through thumbnail HTTP errors", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-private-project-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-private-cache-"));
    temporaryRoots.push(projectRoot, cacheRoot);
    await writeFile(join(projectRoot, "scene.py"), sceneSource("PrivateThumbnail", "private"), "utf8");
    const privateCommand = join(projectRoot, "private-renderer");
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const registry = new ManimProjectRegistry({
      command: [privateCommand, "--private-cache", cacheRoot],
      frame,
      logger,
      projects: [{ id: "project-thumbnail", name: "Thumbnail", root: projectRoot }],
      thumbnailCacheRoot: cacheRoot,
    });
    registries.push(registry);
    const server = createServer((request, response) => {
      void handleManimRequest(registry, request, response, logger);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const rejected = await fetch(`${origin}/api/manim/projects/project-thumbnail/thumbnail/generate`, {
        body: "{}",
        headers: { "content-type": "application/json", origin },
        method: "POST",
      });
      expect(rejected.status).toBe(503);
      const responsePayload = await rejected.text();
      const statusPayload = await (await fetch(
        `${origin}/api/manim/projects/project-thumbnail/thumbnail/status`,
      )).text();
      const publicPayload = `${responsePayload}\n${statusPayload}`;
      for (const privatePath of [privateCommand, projectRoot, cacheRoot]) {
        expect(publicPayload).not.toContain(privatePath);
      }
      expect(publicPayload).toMatch(/renderer is unavailable/i);
      expect(JSON.stringify(records)).toContain(privateCommand);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
