import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import { STUDIO_STYLE_PROFILE } from "../../src/studio/style-profile";
import { createOpenAiEditSuggestionGenerator } from "./openai-generator";

const openAiMock = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }

  return { APIError: MockApiError, parse: vi.fn() };
});

vi.mock("openai", () => ({
  default: class MockOpenAI {
    static APIError = openAiMock.APIError;
    readonly responses = { parse: openAiMock.parse };
  },
}));

const request: EditSuggestionRequest = {
  clarification: null,
  objects: [],
  playhead: 1,
  prompt: "SECRET_SOURCE_AND_PROMPT",
  scene: { id: "SECRET_PATH.py#Scene", name: "Scene", nextSceneId: null },
  sceneDuration: 2,
  selectedObjectIds: [],
  styleProfile: STUDIO_STYLE_PROFILE,
};

const clarification = {
  assumptions: [],
  kind: "clarification",
  message: "SECRET_MODEL_OUTPUT",
  operation: null,
  options: [],
  summary: "",
} as const;

function harness() {
  return {
    generator: createOpenAiEditSuggestionGenerator({
      apiKey: "SECRET_API_KEY",
      instructions: "SECRET_MODEL_INSTRUCTIONS",
      model: "gpt-test",
    }),
  };
}

beforeEach(() => {
  openAiMock.parse.mockReset();
});

describe("OpenAI edit suggestion generator privacy boundary", () => {
  it("returns only bounded token telemetry with a real Responses API result", async () => {
    openAiMock.parse.mockResolvedValue({
      id: "SECRET_PROVIDER_RESPONSE_ID",
      output_parsed: clarification,
      usage: {
        input_tokens: "SECRET_USAGE_FIELD",
        output_tokens: 7,
        secret_detail: "SECRET_USAGE_DETAIL",
        total_tokens: 11,
      },
    });
    const { generator } = harness();

    const result = await generator.generate(request);

    const providerRequest = openAiMock.parse.mock.calls[0]?.[0];
    expect(providerRequest).toMatchObject({ model: "gpt-test", store: false });
    expect(providerRequest.input[0].content).toContain("SECRET_SOURCE_AND_PROMPT");
    expect(JSON.parse(providerRequest.input[0].content)).toMatchObject({
      styleProfile: STUDIO_STYLE_PROFILE,
    });
    expect(result).toEqual({
      suggestion: clarification,
      telemetry: {
        repairAttempted: false,
        usage: { outputTokens: 7, totalTokens: 11 },
      },
    });
    const telemetry = JSON.stringify(result.telemetry);
    for (const sentinel of [
      "SECRET_API_KEY",
      "SECRET_MODEL_INSTRUCTIONS",
      "SECRET_PROVIDER_RESPONSE_ID",
      "SECRET_SOURCE_AND_PROMPT",
      "SECRET_PATH",
      "SECRET_USAGE_FIELD",
      "SECRET_USAGE_DETAIL",
    ]) {
      expect(telemetry).not.toContain(sentinel);
    }
  });

  it("keeps validation feedback inside the repair request instead of telemetry", async () => {
    openAiMock.parse
      .mockRejectedValueOnce(
        new ZodError([{ code: "custom", message: "SECRET_VALIDATION_MESSAGE", path: ["SECRET_VALIDATION_PATH"] }]),
      )
      .mockResolvedValueOnce({ id: "response-2", output_parsed: clarification, usage: null });
    const { generator } = harness();

    const result = await generator.generate(request);

    expect(openAiMock.parse).toHaveBeenCalledTimes(2);
    expect(openAiMock.parse.mock.calls[1]?.[0].instructions).toContain("SECRET_VALIDATION_MESSAGE");
    expect(result.telemetry).toEqual({ repairAttempted: true });
    expect(JSON.stringify(result.telemetry)).not.toContain("SECRET_VALIDATION_MESSAGE");
    expect(JSON.stringify(result.telemetry)).not.toContain("SECRET_VALIDATION_PATH");
  });

  it.each([
    { expected: 429, provider: 429 },
    { expected: 502, provider: 401 },
    { expected: 502, provider: 500 },
  ])("normalizes provider status $provider to bounded status $expected", async ({ expected, provider }) => {
    openAiMock.parse.mockRejectedValue(new openAiMock.APIError(provider, "SECRET_PROVIDER_ERROR_AND_TRACEBACK"));
    const { generator } = harness();

    await expect(generator.generate(request)).rejects.toMatchObject({
      message: "The AI provider request failed.",
      name: "EditSuggestionGenerationError",
      status: expected,
    });
  });
});
