import { afterEach, describe, expect, it, vi } from "vitest";

import { loadManimRender, loadManimWorkspace } from "./client";

afterEach(() => vi.unstubAllGlobals());

function session(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    canCancel: false,
    canCommit: true,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    error: null,
    id: "render-id",
    logTail: "done",
    patch: { anchorLine: 4, insertedCode: "self.wait(1)", sourceHash: "a".repeat(64) },
    programTransactionId: "tx",
    progress: 1,
    sceneName: "SceneOne",
    sourcePath: "scene.py",
    status: "ready",
    updatedAt: "2026-01-01T00:00:01.000Z",
    videoUrl: "/api/manim/renders/render-id/video",
    ...overrides,
  };
}

describe("Manim API client contracts", () => {
  it("accepts a workspace matching the runtime contract", async () => {
    const workspace = {
      command: ["manim"],
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      sources: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(workspace), { status: 200 })));

    await expect(loadManimWorkspace()).resolves.toEqual(workspace);
  });

  it("rejects undeclared workspace fields instead of exposing server paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      command: ["manim"],
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      projectRoot: "/private/project",
      sources: [],
    }), { status: 200 })));

    await expect(loadManimWorkspace()).rejects.toThrow(/does not match the API contract/i);
  });

  it("accepts a render session matching the runtime contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(session()), { status: 200 })));

    await expect(loadManimRender("render-id")).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a successful response with an invalid runtime shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(session({ progress: "done" })), { status: 200 })));

    await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
  });

  it("reports malformed JSON without masking the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 502 })));

    await expect(loadManimRender("render-id")).rejects.toThrow(/502.*malformed JSON/i);
  });
});
