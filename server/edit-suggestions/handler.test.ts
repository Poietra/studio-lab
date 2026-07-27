import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, request as createRequest, createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedConfig, ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSuggestion } from "../../src/ai/edit-suggestion-schema";
import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import { createStructuredLogger, type StructuredLogRecord } from "../logging/structured-logger";
import { openAiEditSuggestions } from "../openai-edit-suggestions";
import { createEditSuggestionHandler } from "./handler";
import { EditSuggestionGenerationError, type EditSuggestionGenerator } from "./service";

const openAiParse = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class MockOpenAI {
    static APIError = class extends Error {};
    readonly responses = { parse: openAiParse };
  },
}));

afterEach(() => {
  openAiParse.mockReset();
  vi.unstubAllEnvs();
});

const choices = [
  { description: "Add the next Scene first.", id: "option-1", label: "Add Scene" },
  { description: "Use the current Scene.", id: "option-2", label: "Current Scene" },
] as const;

function requestBody(): EditSuggestionRequest {
  return {
    clarification: {
      answer: { kind: "text", text: "はい" },
      history: [
        {
          answer: { kind: "option", optionId: "option-1" },
          options: choices,
          question: "Should Studio add the next Scene first?",
        },
      ],
      options: [],
      question: "Should Studio preview the explanation after adding that Scene?",
    },
    objects: [],
    playhead: 4.42,
    prompt: "Add Maxwell equations and explain them in the next Scene.",
    scene: { id: "scene.py#Current", name: "Current", nextSceneId: "scene.py#Next" },
    sceneDuration: 12,
    selectedObjectIds: [],
  };
}

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

async function callHttpHandler(handler: HttpHandler, body: unknown) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { response, result: (await response.json()) as unknown };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function callHandler(generator: EditSuggestionGenerator, body: unknown) {
  const records: StructuredLogRecord[] = [];
  const logger = createStructuredLogger({
    sinks: [{ write: (record) => records.push(record) }],
  });
  const result = await callHttpHandler(
    createEditSuggestionHandler({
      generator: () => generator,
      logger,
      requestId: () => "request-1",
    }),
    body,
  );
  return { records, ...result };
}

describe("edit suggestion API handler", () => {
  it("passes bounded clarification history to the generator and correlates logs", async () => {
    const received: EditSuggestionRequest[] = [];
    const generator: EditSuggestionGenerator = {
      async generate(request): Promise<ModelSuggestion> {
        received.push(request);
        return {
          assumptions: [],
          kind: "clarification",
          message: "One more question",
          operation: null,
          options: [],
          summary: "",
        };
      },
    };

    const { records, response } = await callHandler(generator, requestBody());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-poietra-request-id")).toBe("request-1");
    expect(received[0]?.clarification?.history).toHaveLength(1);
    expect(records.map((record) => record.event)).toEqual(["request.started", "request.received", "response.sent"]);
    expect(records.every((record) => record.context.requestId === "request-1")).toBe(true);
    const persistedLogs = JSON.stringify(records);
    expect(persistedLogs).not.toContain("Maxwell equations");
    expect(persistedLogs).not.toContain("Should Studio add the next Scene first?");
    expect(persistedLogs).not.toContain("One more question");
    expect(records.find((record) => record.event === "response.sent")?.data).toEqual({
      outcome: "clarification",
      status: 200,
    });
  });

  it("never exposes generator errors through HTTP or structured logs", async () => {
    const sentinel = "SECRET_SOURCE_PATH_AND_PROVIDER_BODY";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<ModelSuggestion> {
        throw new EditSuggestionGenerationError(sentinel, 401, {
          cause: new Error(`${sentinel}: nested traceback`),
        });
      },
    };

    const { records, response, result } = await callHandler(generator, requestBody());

    expect(response.status).toBe(502);
    expect(result).toEqual({ error: "Edit suggestion generation failed." });
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.find((record) => record.event === "request.failed")?.data).toEqual({
      failure: "generation",
      status: 401,
    });
  });

  it("preserves only the bounded capacity classification for provider rate limits", async () => {
    const sentinel = "SECRET_RATE_LIMIT_PROVIDER_BODY";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<ModelSuggestion> {
        throw new EditSuggestionGenerationError(sentinel, 429, {
          cause: new Error(`${sentinel}: nested traceback`),
        });
      },
    };

    const { records, response, result } = await callHandler(generator, requestBody());

    expect(response.status).toBe(429);
    expect(result).toEqual({ error: "Edit suggestion capacity is temporarily exhausted." });
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.find((record) => record.event === "request.failed")?.data).toEqual({
      failure: "generation",
      status: 429,
    });
  });

  it("rejects an option answer that does not belong to its historical turn", async () => {
    let calls = 0;
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<ModelSuggestion> {
        calls += 1;
        throw new Error("must not run");
      },
    };
    const body = requestBody();
    const invalidBody = {
      ...body,
      clarification: {
        ...body.clarification,
        history: [
          {
            ...body.clarification!.history[0],
            answer: { kind: "option", optionId: "missing-option" },
          },
        ],
      },
    };

    const { response, result } = await callHandler(generator, invalidBody);

    expect(response.status).toBe(400);
    expect(result).toEqual({ error: "A clarification option is no longer available." });
    expect(calls).toBe(0);
  });

  it("logs only bounded validation classifications for invalid bodies", async () => {
    const sentinel = "SECRET_INVALID_REQUEST_BODY";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<ModelSuggestion> {
        throw new Error("must not run");
      },
    };

    const { records, response } = await callHandler(generator, {
      ...requestBody(),
      sceneDuration: sentinel,
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.find((record) => record.event === "request.validation_failed")?.data).toMatchObject({
      issueCount: expect.any(Number),
    });
  });

  it("propagates a disconnected client to an in-flight generator", async () => {
    let resolveStarted!: () => void;
    let resolveAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const generator: EditSuggestionGenerator = {
      generate(_request, _logger, signal): Promise<never> {
        resolveStarted();
        return new Promise((_resolve, reject) => {
          expect(signal).toBeDefined();
          signal?.addEventListener(
            "abort",
            () => {
              resolveAborted();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    };
    const server = createServer(
      createEditSuggestionHandler({
        generator: () => generator,
        logger: createStructuredLogger({ sinks: [] }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const client = createRequest({
        headers: { "content-type": "application/json" },
        host: "127.0.0.1",
        method: "POST",
        path: "/",
        port: address.port,
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify(requestBody()));
      await started;
      client.destroy();

      await aborted;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("is exposed by a serve-only Vite plugin", () => {
    expect(openAiEditSuggestions({ logPath: false }).apply).toBe("serve");
  });

  it("never reads a repository-root .openai-key file", async () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-ai-key-boundary-"));
    try {
      writeFileSync(join(root, ".openai-key"), "OPENAI_API_KEY=SECRET_REPOSITORY_KEY\n", { mode: 0o600 });
      vi.stubEnv("OPENAI_API_KEY", "");
      const plugin = openAiEditSuggestions({ logPath: false });
      const configResolved = plugin.configResolved as (config: ResolvedConfig) => void;
      configResolved({ root } as ResolvedConfig);
      let handler: HttpHandler | null = null;
      const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
      configureServer({
        middlewares: {
          use(route: string, candidate: HttpHandler) {
            expect(route).toBe("/api/ai/edit-suggestions");
            handler = candidate;
          },
        },
      } as unknown as ViteDevServer);
      if (!handler) throw new Error("The edit-suggestion middleware was not installed.");

      const { response, result } = await callHttpHandler(handler, requestBody());

      expect(response.status).toBe(503);
      expect(result).toEqual({ error: "The OpenAI credential is not configured." });
      expect(openAiParse).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
