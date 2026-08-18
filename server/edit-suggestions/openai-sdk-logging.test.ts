import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import { STUDIO_STYLE_PROFILE } from "../../src/studio/style-profile";
import { createOpenAiEditSuggestionGenerator } from "./openai-generator";

const request: EditSuggestionRequest = {
  clarification: null,
  objects: [],
  playhead: 0,
  prompt: "SECRET_SDK_PROMPT",
  scene: { id: "scene.py#Scene", name: "Scene", nextSceneId: null },
  sceneDuration: 1,
  selectedObjectIds: [],
  styleProfile: STUDIO_STYLE_PROFILE,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI SDK logging boundary", () => {
  it("does not emit request or response data when OPENAI_LOG requests debug output", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const consoleCalls: unknown[][] = [];
    for (const method of ["debug", "error", "info", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("SECRET_SDK_PROMPT");
      expect(String(init?.body)).toContain("SECRET_SDK_INSTRUCTIONS");
      return new Response(
        JSON.stringify({
          error: { code: "server_error", message: "provider failed", type: "server_error" },
          id: "SECRET_SDK_RESPONSE_ID",
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "SECRET_SDK_REQUEST_ID",
          },
          status: 500,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenAiEditSuggestionGenerator({
      apiKey: "SECRET_SDK_API_KEY",
      instructions: "SECRET_SDK_INSTRUCTIONS",
      model: "gpt-test",
    });

    await expect(generator.generate(request)).rejects.toMatchObject({
      message: "The AI provider request failed.",
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleCalls)).not.toMatch(
      /SECRET_SDK_(?:API_KEY|INSTRUCTIONS|PROMPT|REQUEST_ID|RESPONSE_ID)/,
    );
  });
});
