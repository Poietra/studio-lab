import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import { createStructuredLogger, type StructuredLogRecord } from "../logging/structured-logger";
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
  const records: StructuredLogRecord[] = [];
  return {
    generator: createOpenAiEditSuggestionGenerator({
      apiKey: "SECRET_API_KEY",
      instructions: "SECRET_MODEL_INSTRUCTIONS",
      model: "gpt-test",
    }),
    logger: createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] }),
    records,
  };
}

beforeEach(() => {
  openAiMock.parse.mockReset();
});

describe("OpenAI edit suggestion generator privacy boundary", () => {
  it("logs only bounded attempt and token telemetry around a real Responses API call", async () => {
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
    const { generator, logger, records } = harness();

    await expect(generator.generate(request, logger)).resolves.toEqual(clarification);

    const providerRequest = openAiMock.parse.mock.calls[0]?.[0];
    expect(providerRequest).toMatchObject({ model: "gpt-test", store: false });
    expect(providerRequest.input[0].content).toContain("SECRET_SOURCE_AND_PROMPT");
    expect(records).toEqual([
      expect.objectContaining({ data: { attempt: "initial", model: "gpt-test" }, event: "model.requested" }),
      expect.objectContaining({
        data: {
          attempt: "initial",
          usage: { inputTokens: undefined, outputTokens: 7, totalTokens: 11 },
        },
        event: "model.responded",
      }),
    ]);
    const persisted = JSON.stringify(records);
    for (const sentinel of [
      "SECRET_API_KEY",
      "SECRET_MODEL_INSTRUCTIONS",
      "SECRET_MODEL_OUTPUT",
      "SECRET_PROVIDER_RESPONSE_ID",
      "SECRET_SOURCE_AND_PROMPT",
      "SECRET_PATH",
      "SECRET_USAGE_FIELD",
      "SECRET_USAGE_DETAIL",
    ]) {
      expect(persisted).not.toContain(sentinel);
    }
  });

  it("keeps validation feedback inside the repair request instead of telemetry", async () => {
    openAiMock.parse
      .mockRejectedValueOnce(
        new ZodError([{ code: "custom", message: "SECRET_VALIDATION_MESSAGE", path: ["SECRET_VALIDATION_PATH"] }]),
      )
      .mockResolvedValueOnce({ id: "response-2", output_parsed: clarification, usage: null });
    const { generator, logger, records } = harness();

    await expect(generator.generate(request, logger)).resolves.toEqual(clarification);

    expect(openAiMock.parse).toHaveBeenCalledTimes(2);
    expect(openAiMock.parse.mock.calls[1]?.[0].instructions).toContain("SECRET_VALIDATION_MESSAGE");
    expect(records.find((record) => record.event === "model.validation_failed")?.data).toEqual({
      attempt: "initial",
      issueCodes: ["custom"],
      issueCount: 1,
    });
    expect(JSON.stringify(records)).not.toContain("SECRET_VALIDATION_MESSAGE");
    expect(JSON.stringify(records)).not.toContain("SECRET_VALIDATION_PATH");
  });

  it.each([
    { expected: 429, provider: 429 },
    { expected: 502, provider: 401 },
    { expected: 502, provider: 500 },
  ])("normalizes provider status $provider to bounded status $expected", async ({ expected, provider }) => {
    openAiMock.parse.mockRejectedValue(new openAiMock.APIError(provider, "SECRET_PROVIDER_ERROR_AND_TRACEBACK"));
    const { generator, logger, records } = harness();

    await expect(generator.generate(request, logger)).rejects.toMatchObject({
      message: "The AI provider request failed.",
      name: "EditSuggestionGenerationError",
      status: expected,
    });
    expect(JSON.stringify(records)).not.toContain("SECRET_PROVIDER_ERROR_AND_TRACEBACK");
  });
});
