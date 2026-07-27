import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { fastManimSnapshotRunViewV1Schema } from "./fast-manim-snapshot-contract";
import { handleManimRequest } from "./manim-render-http";
import { ManimRenderManager } from "./manim-render-manager";
import {
  expectFailure,
  fakeManim,
  installFastManimSnapshotRunnerFixture,
  producerCommand,
  runRequest,
  supportsVerifiedRead,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { managers, projectRoot, servers } = installFastManimSnapshotRunnerFixture();

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot endpoint", () => {
  async function startServer(manager: ManimRenderManager) {
    const server = createServer((request, response) => {
      void handleManimRequest(manager, request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves verified snapshots over HTTP and validates the wire envelope", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
      snapshotSandboxDeployment: "test",
      snapshotProducerCommand: producerCommand(),
      snapshotProducerDevOptIn: true,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const posted = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" },
      method: "POST",
    });
    expect(posted.status).toBe(200);
    const postedText = await posted.text();
    const postedView = fastManimSnapshotRunViewV1Schema.parse(JSON.parse(postedText));
    expect(postedView.status).toBe("verified");
    if (postedView.status !== "verified") throw new Error("Expected a verified endpoint response.");
    expect(postedView.revision).toBe(1);
    expect(postedText).not.toContain(root);
    expect(postedText).not.toContain("def construct");

    const fetched = await fetch(
      `${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py&sceneName=ExampleScene`,
    );
    expect(fetched.status).toBe(200);
    const fetchedView = fastManimSnapshotRunViewV1Schema.parse(await fetched.json());
    expect(fetchedView.status).toBe("verified");

    const missing = await fetch(
      `${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py&sceneName=OtherScene`,
    );
    expect(missing.status).toBe(404);

    const invalidQuery = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py`);
    expect(invalidQuery.status).toBe(400);

    const mismatch = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest({ projectId: "other" })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(mismatch.status).toBe(409);

    const unknownProject = await fetch(`${baseUrl}/api/manim/projects/other/scene-snapshots`, {
      body: JSON.stringify(runRequest({ projectId: "other" })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unknownProject.status).toBe(404);
  });

  it("rejects cross-origin snapshot mutations before executing project Python", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
      snapshotSandboxDeployment: "test",
      snapshotProducerCommand: producerCommand(),
      snapshotProducerDevOptIn: true,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const endpoint = `${baseUrl}/api/manim/projects/default/scene-snapshots`;

    const crossSite = await fetch(endpoint, {
      body: JSON.stringify(runRequest()),
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toEqual({ error: "Cross-origin mutation requests are not allowed." });

    const foreignOrigin = await fetch(endpoint, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
    });
    expect(foreignOrigin.status).toBe(403);
    await expect(foreignOrigin.json()).resolves.toEqual({ error: "Mutation requests require a same-origin request." });

    await expect(
      manager.sceneSnapshot("default", { sceneName: "ExampleScene", sourcePath: "scene.py" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns a structured failure envelope over HTTP when the producer is not configured", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const posted = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(posted.status).toBe(200);
    const view = fastManimSnapshotRunViewV1Schema.parse(await posted.json());
    expectFailure(view, "sandbox-unavailable");
  });
});
