import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import { startElectronShellServer, type ElectronShellServer } from "./electron-shell-server";

const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
const roots: string[] = [];
const servers: ElectronShellServer[] = [];
const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.wait(1)
        # poietra:anchor 1.000
        self.wait(1)
`;

function request(sourceHash: string, entityId: string): ProgramRenderRequest {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 32, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: "tx:shell/operation:motion",
    interval: { end: 1.5, start: 1 },
    kind: "CreateMotion" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    targetEntityIds: [entityId],
  };
  return {
    destination: null,
    program: {
      anchor: {
        capturedPlayhead: 1,
        evidence: [],
        resolvedSeconds: 1,
        source: { kind: "playhead", referenceSeconds: 1 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "shell",
      version: 1,
    },
    projectId: "shell-project",
    sceneName: "GroupedEquation",
    sourceBindings: [{ entityId, sourceVariable: "circle" }],
    sourceHash,
    sourcePath: "scene.py",
    viewport: { height: 360, width: 640 },
  };
}

function shellFetch(shell: ElectronShellServer, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-poietra-shell-capability", shell.capability);
  return fetch(`${shell.origin}${path}`, { ...init, headers });
}

async function waitForRender(shell: ElectronShellServer, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await shellFetch(shell, `/api/manim/renders/${id}`);
    const session = (await response.json()) as { status: string };
    if (["cancelled", "failed", "ready"].includes(session.status)) return session;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  }
  throw new Error("Packaged shell render did not finish.");
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Electron shell HTTP adapter", () => {
  it("serves a locked-down renderer and reuses CRUD, render, and export contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-electron-shell-"));
    roots.push(root);
    const distRoot = join(root, "dist");
    const projectRoot = join(root, "project");
    await Promise.all([mkdir(distRoot), mkdir(projectRoot)]);
    await Promise.all([
      writeFile(join(distRoot, "index.html"), "<!doctype html><title>Shell</title>", "utf8"),
      writeFile(join(projectRoot, "scene.py"), source, "utf8"),
    ]);
    const shell = await startElectronShellServer({
      command: [process.execPath, fakeRenderer],
      dataRoot: join(root, "data"),
      distRoot,
      projects: [{ id: "shell-project", name: "Shell project", root: projectRoot }],
    });
    servers.push(shell);

    expect((await fetch(shell.origin)).status).toBe(401);
    expect(
      (
        await fetch(shell.origin, {
          headers: { "x-poietra-shell-capability": "not-the-capability" },
        })
      ).status,
    ).toBe(401);

    const documentResponse = await shellFetch(shell, "/");
    expect(documentResponse.status).toBe(200);
    expect(documentResponse.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(documentResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(await documentResponse.text()).toContain("<title>Shell</title>");
    expect((await shellFetch(shell, "/../package.json")).status).toBe(404);

    const projectsResponse = await shellFetch(shell, "/api/manim/projects");
    const projects = (await projectsResponse.json()) as { projects: readonly Record<string, unknown>[] };
    expect(projects.projects).toEqual([{ id: "shell-project", kind: "existing", name: "Shell project" }]);
    expect(JSON.stringify(projects)).not.toContain(projectRoot);

    const rendererRegistration = await shellFetch(shell, "/api/manim/projects", {
      body: JSON.stringify({ kind: "existing", name: "Bypass", root: projectRoot }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rendererRegistration.status).toBe(403);
    expect(await rendererRegistration.json()).toEqual({
      error: "Existing-folder registration requires the native folder picker.",
    });
    expect(
      ((await (await shellFetch(shell, "/api/manim/projects")).json()) as { projects: unknown[] }).projects,
    ).toHaveLength(1);

    const workspace = (await (await shellFetch(shell, "/api/manim/projects/shell-project/workspace")).json()) as {
      sources: readonly {
        scenes: readonly { sourceHash: string; sourceVariables: Readonly<Record<string, string>> }[];
      }[];
    };
    const scene = workspace.sources[0]!.scenes[0]!;
    const entityId = Object.entries(scene.sourceVariables).find(([, variable]) => variable === "circle")?.[0];
    expect(entityId).toBeTruthy();

    const renderResponse = await shellFetch(shell, "/api/manim/projects/shell-project/renders", {
      body: JSON.stringify(request(scene.sourceHash, entityId!)),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(renderResponse.status).toBe(202);
    const started = (await renderResponse.json()) as { id: string };
    await expect(waitForRender(shell, started.id)).resolves.toMatchObject({ status: "ready" });
    const video = await shellFetch(shell, `/api/manim/renders/${started.id}/video`);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect((await video.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const exported = await shellFetch(shell, "/api/manim/projects/shell-project/export", {
      body: JSON.stringify(request(scene.sourceHash, entityId!)),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain('poietra:transaction "shell"');
    await shellFetch(shell, `/api/manim/renders/${started.id}/discard`, { method: "POST" });

    const managed = (await (
      await shellFetch(shell, "/api/manim/projects", {
        body: JSON.stringify({ kind: "managed", name: "Managed" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as { project: { id: string } };
    const renamed = await shellFetch(shell, `/api/manim/projects/${managed.project.id}`, {
      body: JSON.stringify({ name: "Renamed" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(await renamed.json()).toMatchObject({ project: { name: "Renamed" } });
    expect((await shellFetch(shell, `/api/manim/projects/${managed.project.id}`, { method: "DELETE" })).status).toBe(
      200,
    );

    expect(
      createHash("sha256")
        .update(await readFile(join(projectRoot, "scene.py")))
        .digest("hex"),
    ).toBe(scene.sourceHash);
  });
});
