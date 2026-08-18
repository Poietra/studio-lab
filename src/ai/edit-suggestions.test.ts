import { afterEach, describe, expect, it, vi } from "vitest";

import { STUDIO_STYLE_PROFILE } from "../studio/style-profile";
import { type EditSuggestionRequest, suggestEdit } from "./edit-suggestions";

const request: EditSuggestionRequest = {
  clarification: null,
  objects: [],
  playhead: 2,
  prompt: "Move the selected object.",
  scene: { id: "scene.py#Example", name: "Example", nextSceneId: null },
  sceneDuration: 10,
  selectedObjectIds: [],
  styleProfile: STUDIO_STYLE_PROFILE,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Magic Edit API client contracts", () => {
  it("reports malformed JSON with the endpoint status", async () => {
    vi.stubEnv("VITE_POIETRA_AI_ENDPOINT", "/api/ai/edit-suggestions");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502 })),
    );

    await expect(suggestEdit(request)).rejects.toThrow(/502.*malformed JSON/i);
  });

  it("normalizes an empty successful response as a contract error", async () => {
    vi.stubEnv("VITE_POIETRA_AI_ENDPOINT", "/api/ai/edit-suggestions");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await expect(suggestEdit(request)).rejects.toThrow(/invalid operation/i);
  });

  it("validates the outgoing request before contacting the endpoint", async () => {
    vi.stubEnv("VITE_POIETRA_AI_ENDPOINT", "/api/ai/edit-suggestions");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(suggestEdit({ ...request, sceneDuration: 0 })).rejects.toThrow(/request.*contract/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the caller's abort signal to fetch", async () => {
    vi.stubEnv("VITE_POIETRA_AI_ENDPOINT", "/api/ai/edit-suggestions");
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      expect(JSON.parse(String(init.body))).toMatchObject({
        styleProfile: STUDIO_STYLE_PROFILE,
      });
      return new Response(
        JSON.stringify({
          kind: "clarification",
          message: "Which object should move?",
          options: [],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(suggestEdit(request, { signal: controller.signal })).resolves.toMatchObject({
      kind: "clarification",
    });
  });
});
