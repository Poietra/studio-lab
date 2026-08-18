import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as createRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedConfig, ViteDevServer } from "vite";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ModelSuggestion } from "../../src/ai/edit-suggestion-schema";
import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import {
  createConsoleJsonSink,
  createRotatingJsonlSink,
  createStructuredLogger,
  type StructuredLogRecord,
} from "../logging/structured-logger";
import { createTrustedLocalManimPrincipal } from "../manim-request-principal";
import { openAiEditSuggestions } from "../openai-edit-suggestions";
import { createEditSuggestionAdmissionController } from "./admission";
import { createEditSuggestionHandler, createEditSuggestionRequestHandler } from "./handler";
import {
  EditSuggestionGenerationError,
  type EditSuggestionGenerationResult,
  type EditSuggestionGenerator,
} from "./service";
import type { EditSuggestionUsageMeterV1 } from "./usage-metering";

const openAiParse = vi.hoisted(() => vi.fn());
const openAiConstructed = vi.hoisted(() => vi.fn());

const TEST_PRINCIPAL = createTrustedLocalManimPrincipal({
  deployment: "test",
  tenantId: "local-ai-handler-test",
});

vi.mock("openai", () => ({
  default: class MockOpenAI {
    static APIError = class extends Error {};
    readonly responses = { parse: openAiParse };

    constructor(options: unknown) {
      openAiConstructed(options);
    }
  },
}));

afterEach(() => {
  openAiConstructed.mockReset();
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

function generated(suggestion: ModelSuggestion): EditSuggestionGenerationResult {
  return {
    suggestion,
    telemetry: { repairAttempted: false },
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
      principal: TEST_PRINCIPAL,
      requestId: () => "request-1",
    }),
    body,
  );
  return { records, ...result };
}

describe("edit suggestion API handler", () => {
  it("does not start a provider call for an already-aborted production request", async () => {
    let generatorCalls = 0;
    const requestSignal = new AbortController();
    requestSignal.abort(new Error("Production request deadline exceeded."));
    const handler = createEditSuggestionRequestHandler({
      generator: () => ({
        async generate() {
          generatorCalls += 1;
          throw new Error("must not run");
        },
      }),
      logger: createStructuredLogger({ sinks: [] }),
    });
    const result = await callHttpHandler(async (request, response) => {
      await handler(request, response, {
        principal: TEST_PRINCIPAL,
        requestSignal: requestSignal.signal,
      });
      if (!response.writableEnded) {
        response.statusCode = 504;
        response.setHeader("content-type", "application/json");
        response.end('{"error":"Request deadline exceeded."}');
      }
    }, requestBody());

    expect(result.response.status).toBe(504);
    expect(generatorCalls).toBe(0);
  });

  it("rejects unbranded caller claims before reading the body or entering the generator", async () => {
    let generatorCalls = 0;
    const handler = createEditSuggestionRequestHandler({
      generator: () => ({
        async generate() {
          generatorCalls += 1;
          throw new Error("must not run");
        },
      }),
      logger: createStructuredLogger({ sinks: [] }),
    });
    const result = await callHttpHandler(
      (request, response) =>
        handler(request, response, {
          principal: { subjectId: "forged-user", tenantId: "tenant-forged" } as never,
        }),
      requestBody(),
    );

    expect(result.response.status).toBe(401);
    expect(result.result).toEqual({ error: "Authentication is required." });
    expect(generatorCalls).toBe(0);
  });

  it("passes bounded clarification history to the generator and correlates logs", async () => {
    const received: EditSuggestionRequest[] = [];
    const generator: EditSuggestionGenerator = {
      async generate(request): Promise<EditSuggestionGenerationResult> {
        received.push(request);
        return {
          suggestion: {
            assumptions: [],
            kind: "clarification",
            message: "One more question",
            operation: null,
            options: [],
            summary: "",
          },
          telemetry: {
            repairAttempted: true,
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          },
        };
      },
    };

    const { records, response } = await callHandler(generator, requestBody());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-poietra-request-id")).toBe("request-1");
    expect(received[0]?.clarification?.history).toHaveLength(1);
    expect(records.map((record) => record.event)).toEqual([
      "request.started",
      "request.received",
      "model.requested",
      "model.validation_failed",
      "model.responded",
      "response.sent",
    ]);
    expect(records.every((record) => record.context.requestId === "request-1")).toBe(true);
    const persistedLogs = JSON.stringify(records);
    expect(persistedLogs).not.toContain("Maxwell equations");
    expect(persistedLogs).not.toContain("Should Studio add the next Scene first?");
    expect(persistedLogs).not.toContain("One more question");
    expect(records.find((record) => record.event === "response.sent")?.data).toEqual({
      latencyMs: expect.any(Number),
      status: 200,
    });
    expect(records.find((record) => record.event === "model.responded")?.data).toEqual({
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
  });

  it("never exposes the structured logger to an injected generator and rejects unbounded telemetry", async () => {
    const sentinel = "SECRET_MALICIOUS_ADAPTER_PROMPT_PATH";
    let receivedBoundary: unknown;
    const generator: EditSuggestionGenerator = {
      async generate(request, signal) {
        expectTypeOf(signal).toEqualTypeOf<AbortSignal | undefined>();
        receivedBoundary = signal;
        return {
          suggestion: generated({
            assumptions: [],
            kind: "clarification",
            message: "safe response",
            operation: null,
            options: [],
            summary: "",
          }).suggestion,
          telemetry: {
            repairAttempted: false,
            usage: { inputTokens: 1, prompt: `${sentinel}:${request.prompt}` },
          },
        } as never;
      },
    };

    const { records, response, result } = await callHandler(generator, {
      ...requestBody(),
      prompt: sentinel,
      scene: { ...requestBody().scene, id: `${sentinel}.py#Scene` },
    });

    expect(response.status).toBe(502);
    expect(result).toEqual({ error: "Edit suggestion generation failed." });
    expect(receivedBoundary).toBeInstanceOf(AbortSignal);
    expect(receivedBoundary).not.toHaveProperty("info");
    expect(receivedBoundary).not.toHaveProperty("child");
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.map((record) => record.event)).toContain("model.result_rejected");
  });

  it("normalizes an injected generation error status before logging", async () => {
    const sentinel = "SECRET_MALICIOUS_ERROR_STATUS_PROMPT_PATH";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<EditSuggestionGenerationResult> {
        const error = new EditSuggestionGenerationError(sentinel, 502);
        Object.defineProperty(error, "status", {
          value: { path: `${sentinel}.py`, prompt: sentinel },
        });
        throw error;
      },
    };

    const { records, response, result } = await callHandler(generator, {
      ...requestBody(),
      prompt: sentinel,
    });

    expect(response.status).toBe(502);
    expect(result).toEqual({ error: "Edit suggestion generation failed." });
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.find((record) => record.event === "request.failed")?.data).toEqual({
      latencyMs: expect.any(Number),
      status: 502,
    });
  });

  it("never exposes generator errors through HTTP or structured logs", async () => {
    const sentinel = "SECRET_SOURCE_PATH_AND_PROVIDER_BODY";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<EditSuggestionGenerationResult> {
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
      latencyMs: expect.any(Number),
      status: 502,
    });
  });

  it("keeps source, path, environment, credential, traceback, clarification, and output sentinels out of console and JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-ai-redaction-"));
    const consoleCalls: unknown[][] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => consoleCalls.push(args));
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => consoleCalls.push(args));
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => consoleCalls.push(args));
    const logPath = join(root, "telemetry.jsonl");
    try {
      const logger = createStructuredLogger({
        sinks: [createConsoleJsonSink({ prefix: "poietra-ai-test" }), createRotatingJsonlSink({ logPath, root })],
      });
      const generator: EditSuggestionGenerator = {
        async generate(): Promise<EditSuggestionGenerationResult> {
          return generated({
            assumptions: [],
            kind: "clarification",
            message: "SECRET_MODEL_OUTPUT",
            operation: null,
            options: [],
            summary: "",
          });
        },
      };
      const body = requestBody();
      const handler = createEditSuggestionHandler({
        generator: () => generator,
        logger,
        principal: TEST_PRINCIPAL,
        requestId: () => "SECRET_PATH/../../unbounded-request-id".repeat(8),
      });
      const result = await callHttpHandler(handler, {
        ...body,
        clarification: {
          ...body.clarification!,
          question: "SECRET_CLARIFICATION",
        },
        objects: [
          {
            displayName: "SECRET_OBJECT_CONTEXT",
            editCapabilities: {
              delete: { kind: "supported" },
              scale: { current: 1, kind: "supported" },
            },
            id: "SECRET_OBJECT_ID",
            lifetimes: [{ end: 1, start: 0 }],
            mathTex: null,
            type: "SECRET_OBJECT_TYPE",
          },
        ],
        prompt: "SECRET_PROMPT SECRET_SOURCE SECRET_ENV SECRET_API_KEY SECRET_TRACEBACK",
        scene: { ...body.scene, id: "SECRET_PATH.py#Current" },
      });

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("x-poietra-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const persisted = `${readFileSync(logPath, "utf8")}\n${JSON.stringify(consoleCalls)}`;
      expect(persisted).not.toMatch(
        /SECRET_(?:API_KEY|CLARIFICATION|ENV|MODEL_OUTPUT|OBJECT|PATH|PROMPT|SOURCE|TRACEBACK)/,
      );
      const records = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as StructuredLogRecord);
      expect(records.every((record) => Object.keys(record.context).length <= 3)).toBe(true);
      expect(records.find((record) => record.event === "response.sent")?.data).toMatchObject({
        latencyMs: expect.any(Number),
        status: 200,
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves only the bounded capacity classification for provider rate limits", async () => {
    const sentinel = "SECRET_RATE_LIMIT_PROVIDER_BODY";
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<EditSuggestionGenerationResult> {
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
      latencyMs: expect.any(Number),
      status: 429,
    });
  });

  it("rejects an option answer that does not belong to its historical turn", async () => {
    let calls = 0;
    const generator: EditSuggestionGenerator = {
      async generate(): Promise<EditSuggestionGenerationResult> {
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
      async generate(): Promise<EditSuggestionGenerationResult> {
        throw new Error("must not run");
      },
    };

    const { records, response } = await callHandler(generator, {
      ...requestBody(),
      sceneDuration: sentinel,
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records.find((record) => record.event === "request.validation_failed")?.data).toBeUndefined();
  });

  it("charges the request rate quota before reading a near-limit invalid body", async () => {
    let calls = 0;
    const admission = createEditSuggestionAdmissionController({
      limits: {
        maxConcurrentPerPrincipal: 1,
        maxConcurrentPerTenant: 1,
        maxRequestsPerPrincipalWindow: 1,
        maxRequestsPerTenantWindow: 1,
        maxTrackedPrincipals: 10,
        maxTrackedTenants: 10,
        rateWindowMs: 60_000,
      },
    });
    const handler = createEditSuggestionHandler({
      admission,
      generator: () => ({
        async generate() {
          calls += 1;
          throw new Error("must not run");
        },
      }),
      logger: createStructuredLogger({ sinks: [] }),
      principal: TEST_PRINCIPAL,
    });

    const invalidBody = { ...requestBody(), prompt: "" };
    invalidBody.prompt = "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(invalidBody)));
    expect(Buffer.byteLength(JSON.stringify(invalidBody))).toBe(64 * 1024);

    const invalid = await callHttpHandler(handler, invalidBody);
    expect(invalid.response.status).toBe(400);
    const generationCapacity = admission.reserveGeneration(TEST_PRINCIPAL);
    expect(generationCapacity.accepted).toBe(true);
    if (generationCapacity.accepted) generationCapacity.reservation.release();

    const retry = await callHttpHandler(handler, requestBody());
    expect(retry.response.status).toBe(429);
    expect(calls).toBe(0);
  });

  it("holds a disconnected generation slot until an abort-ignoring provider settles", async () => {
    let resolveStarted!: () => void;
    let resolveAborted!: () => void;
    let settleFirst: ((result: EditSuggestionGenerationResult) => void) | undefined;
    let firstSettled = false;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    let calls = 0;
    const generator: EditSuggestionGenerator = {
      generate(_request, signal): Promise<EditSuggestionGenerationResult> {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve(
            generated({
              assumptions: [],
              kind: "clarification",
              message: "retry",
              operation: null,
              options: [],
              summary: "",
            }),
          );
        }
        resolveStarted();
        return new Promise((resolve) => {
          settleFirst = resolve;
          expect(signal).toBeDefined();
          signal?.addEventListener("abort", resolveAborted, { once: true });
        });
      },
    };
    const admission = createEditSuggestionAdmissionController({
      limits: {
        maxConcurrentPerPrincipal: 1,
        maxConcurrentPerTenant: 1,
        maxRequestsPerPrincipalWindow: 10,
        maxRequestsPerTenantWindow: 10,
        maxTrackedPrincipals: 10,
        maxTrackedTenants: 10,
        rateWindowMs: 60_000,
      },
    });
    const server = createServer(
      createEditSuggestionHandler({
        admission,
        generator: () => generator,
        logger: createStructuredLogger({ sinks: [] }),
        principal: TEST_PRINCIPAL,
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
      const blocked = await fetch(`http://127.0.0.1:${address.port}`, {
        body: JSON.stringify(requestBody()),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(blocked.status).toBe(429);
      expect(calls).toBe(1);

      settleFirst?.(
        generated({
          assumptions: [],
          kind: "clarification",
          message: "late result",
          operation: null,
          options: [],
          summary: "",
        }),
      );
      firstSettled = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const retry = await fetch(`http://127.0.0.1:${address.port}`, {
        body: JSON.stringify(requestBody()),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(retry.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      if (!firstSettled) {
        settleFirst?.(
          generated({
            assumptions: [],
            kind: "clarification",
            message: "cleanup",
            operation: null,
            options: [],
            summary: "",
          }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("holds a timed-out slot through a late provider rejection without an unhandled rejection", async () => {
    let calls = 0;
    let aborted = false;
    let rejectFirst: ((reason: unknown) => void) | undefined;
    let firstSettled = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const generator: EditSuggestionGenerator = {
      generate(_request, signal): Promise<EditSuggestionGenerationResult> {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve(
            generated({
              assumptions: [],
              kind: "clarification",
              message: "retry",
              operation: null,
              options: [],
              summary: "",
            }),
          );
        }
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        });
      },
    };
    const handler = createEditSuggestionHandler({
      admission: createEditSuggestionAdmissionController({
        limits: {
          maxConcurrentPerPrincipal: 1,
          maxConcurrentPerTenant: 1,
          maxRequestsPerPrincipalWindow: 10,
          maxRequestsPerTenantWindow: 10,
          maxTrackedPrincipals: 10,
          maxTrackedTenants: 10,
          rateWindowMs: 60_000,
        },
      }),
      generationTimeoutMs: 10,
      generator: () => generator,
      logger: createStructuredLogger({ sinks: [] }),
      principal: TEST_PRINCIPAL,
    });

    try {
      const first = await callHttpHandler(handler, requestBody());
      expect(first.response.status).toBe(504);
      expect(first.result).toEqual({ error: "Edit suggestion generation timed out." });
      expect(aborted).toBe(true);

      const blocked = await callHttpHandler(handler, requestBody());
      expect(blocked.response.status).toBe(429);
      expect(calls).toBe(1);

      rejectFirst?.(new Error("late provider rejection"));
      firstSettled = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      const retry = await callHttpHandler(handler, requestBody());
      expect(retry.response.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      if (!firstSettled) {
        rejectFirst?.(new Error("test cleanup"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      process.removeListener("unhandledRejection", onUnhandled);
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
      configResolved({ mode: "development", root } as ResolvedConfig);
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

  it("uses the repository key only after an explicit development opt-in and emits a fixed warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-ai-local-key-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(join(root, ".openai-key"), "OPENAI_API_KEY=SECRET_LOCAL_REPOSITORY_KEY\n", { mode: 0o600 });
      vi.stubEnv("OPENAI_API_KEY", "");

      const disabled = openAiEditSuggestions({
        localDevelopmentOptIn: true,
        localKeyFileOptIn: false,
        logPath: false,
      });
      const resolveDisabled = disabled.configResolved as (config: ResolvedConfig) => void;
      resolveDisabled({ mode: "development", root } as ResolvedConfig);
      expect(openAiConstructed).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();

      openAiParse.mockResolvedValue({
        output_parsed: {
          assumptions: [],
          kind: "clarification",
          message: "Choose a target.",
          operation: null,
          options: [],
          summary: "",
        },
        usage: null,
      });
      const enabled = openAiEditSuggestions({
        localDevelopmentOptIn: true,
        localKeyFileOptIn: true,
        logPath: false,
      });
      const resolveEnabled = enabled.configResolved as (config: ResolvedConfig) => void;
      resolveEnabled({ mode: "development", root } as ResolvedConfig);
      let handler: HttpHandler | null = null;
      const configureServer = enabled.configureServer as (server: ViteDevServer) => void;
      configureServer({
        middlewares: {
          use(_route: string, candidate: HttpHandler) {
            handler = candidate;
          },
        },
      } as unknown as ViteDevServer);
      if (!handler) throw new Error("The edit-suggestion middleware was not installed.");

      const result = await callHttpHandler(handler, requestBody());
      expect(result.response.status).toBe(200);
      expect(openAiConstructed).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "SECRET_LOCAL_REPOSITORY_KEY" }),
      );
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]?.[0])).toContain(".openai-key fallback");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("SECRET_LOCAL_REPOSITORY_KEY");
      expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
    } finally {
      warning.mockRestore();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("never adopts the repository key in production even when local flags are set", () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-ai-production-key-"));
    try {
      writeFileSync(join(root, ".openai-key"), "OPENAI_API_KEY=SECRET_PRODUCTION_REPOSITORY_KEY\n", { mode: 0o600 });
      vi.stubEnv("OPENAI_API_KEY", "");
      const plugin = openAiEditSuggestions({
        localDevelopmentOptIn: true,
        localKeyFileOptIn: true,
        logPath: false,
      });
      const configResolved = plugin.configResolved as (config: ResolvedConfig) => void;

      configResolved({ mode: "production", root } as ResolvedConfig);

      expect(openAiConstructed).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back to bounded console telemetry when the file sink cannot initialize", () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-ai-log-boundary-"));
    const sentinel = join(root, "SECRET_LOG_PARENT");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(sentinel, "not a directory", "utf8");
      const plugin = openAiEditSuggestions({ logPath: "SECRET_LOG_PARENT/api.jsonl" });
      const configResolved = plugin.configResolved as (config: ResolvedConfig) => void;

      expect(() => configResolved({ root } as ResolvedConfig)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("logging.file_sink_unavailable");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally {
      warn.mockRestore();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("edit suggestion usage metering", () => {
  const clarificationResult: EditSuggestionGenerationResult = {
    suggestion: {
      assumptions: [],
      kind: "clarification",
      message: "One more question",
      operation: null,
      options: [],
      summary: "",
    },
    telemetry: { repairAttempted: false },
  };

  function committedReservation() {
    return { kind: "settled", replayed: false, reservation: {} } as unknown as Awaited<
      ReturnType<EditSuggestionUsageMeterV1["commit"]>
    >;
  }

  function reservedResult() {
    return { kind: "reserved", replayed: false, reservation: {} } as unknown as Awaited<
      ReturnType<EditSuggestionUsageMeterV1["reserve"]>
    >;
  }

  function meterFixture(overrides: Partial<Record<"commit" | "release" | "reserve", unknown>> = {}) {
    const commit = vi.fn(async () => committedReservation());
    const release = vi.fn(async () => committedReservation());
    const reserve = vi.fn(async () => reservedResult());
    const meter = { commit, release, reserve, ...overrides } as unknown as EditSuggestionUsageMeterV1;
    return { commit, meter, release, reserve };
  }

  async function callMeteredHandler(meter: EditSuggestionUsageMeterV1, generate: EditSuggestionGenerator["generate"]) {
    const events: string[] = [];
    const handler = createEditSuggestionRequestHandler({
      generator: () => ({
        generate: async (request, signal) => {
          events.push("dispatch");
          return generate(request, signal);
        },
      }),
      logger: createStructuredLogger({ sinks: [] }),
      usageMeter: meter,
    });
    const result = await callHttpHandler(
      (request, response) => handler(request, response, { principal: TEST_PRINCIPAL }),
      requestBody(),
    );
    return { events, ...result };
  }

  it("reserves after admission and commits exactly at the provider dispatch", async () => {
    const order: string[] = [];
    const fixture = meterFixture({
      commit: vi.fn(async () => {
        order.push("commit");
        return committedReservation();
      }),
      reserve: vi.fn(async () => {
        order.push("reserve");
        return reservedResult();
      }),
    });

    const { events, response } = await callMeteredHandler(fixture.meter, async () => {
      order.push("provider");
      return clarificationResult;
    });

    expect(response.status).toBe(200);
    expect(order).toEqual(["reserve", "commit", "provider"]);
    expect(events).toEqual(["dispatch"]);
    const reserveMock = fixture.meter.reserve as ReturnType<typeof vi.fn>;
    expect(reserveMock).toHaveBeenCalledWith({
      lifetimeMs: expect.any(Number),
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      tenantId: TEST_PRINCIPAL.tenantId,
    });
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("keeps a dispatched unit committed even when no useful model response returns", async () => {
    const fixture = meterFixture();

    const { events, response } = await callMeteredHandler(fixture.meter, async () => {
      throw new EditSuggestionGenerationError("provider exploded", 502);
    });

    expect(response.status).toBe(502);
    expect(events).toEqual(["dispatch"]);
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("maps metering denials onto 402 and 429 without dispatching the provider", async () => {
    for (const [reason, status, error] of [
      ["quota-exhausted", 429, "The AI suggestion usage quota is exhausted."],
      ["blocked", 402, "The organization does not have an active AI suggestion entitlement."],
      ["operation-disabled", 402, "The organization does not have an active AI suggestion entitlement."],
      ["unconfigured", 402, "The organization does not have an active AI suggestion entitlement."],
    ] as const) {
      const fixture = meterFixture({
        reserve: vi.fn(async () => ({ kind: "denied", reason })),
      });

      const { events, response, result } = await callMeteredHandler(fixture.meter, async () => clarificationResult);

      expect(response.status).toBe(status);
      expect(result).toEqual({ error });
      expect(events).toEqual([]);
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.release).not.toHaveBeenCalled();
    }
  });

  it("releases a reserved unit and dispatches nothing when the commitment fails", async () => {
    const failures = [
      vi.fn(async () => ({ kind: "missing" }) as unknown as ReturnType<typeof committedReservation>),
      vi.fn(async () => {
        throw new Error("billing storage unavailable");
      }),
    ];
    for (const commit of failures) {
      const fixture = meterFixture({ commit });

      const { events, response } = await callMeteredHandler(fixture.meter, async () => clarificationResult);

      expect(response.status).toBe(502);
      expect(events).toEqual([]);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fixture.release).toHaveBeenCalledWith(TEST_PRINCIPAL.tenantId, expect.any(String));
    }
  });

  it("fails closed with 503 and frees the admission slot when metering storage is unavailable", async () => {
    const fixture = meterFixture({
      reserve: vi.fn(async () => {
        throw new Error("billing storage unavailable");
      }),
    });

    const { events, response, result } = await callMeteredHandler(fixture.meter, async () => clarificationResult);

    expect(response.status).toBe(503);
    expect(result).toEqual({ error: "Edit suggestion metering is unavailable." });
    expect(events).toEqual([]);
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("stays unmetered when no usage meter is injected", async () => {
    const handler = createEditSuggestionRequestHandler({
      generator: () => ({ generate: async () => clarificationResult }),
      logger: createStructuredLogger({ sinks: [] }),
    });

    const result = await callHttpHandler(
      (request, response) => handler(request, response, { principal: TEST_PRINCIPAL }),
      requestBody(),
    );

    expect(result.response.status).toBe(200);
  });
});
