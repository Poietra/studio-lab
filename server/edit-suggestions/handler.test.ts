import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import type { ModelSuggestion } from "../../src/ai/edit-suggestion-schema";
import {
  createStructuredLogger,
  type StructuredLogRecord,
} from "../logging/structured-logger";
import { createEditSuggestionHandler } from "./handler";
import type { EditSuggestionGenerator } from "./service";

const choices = [
  { description: "Add the next Scene first.", id: "option-1", label: "Add Scene" },
  { description: "Use the current Scene.", id: "option-2", label: "Current Scene" },
] as const;

function requestBody(): EditSuggestionRequest {
  return {
    clarification: {
      answer: { kind: "text", text: "はい" },
      history: [{
        answer: { kind: "option", optionId: "option-1" },
        options: choices,
        question: "Should Studio add the next Scene first?",
      }],
      options: [],
      question: "Should Studio preview the explanation after adding that Scene?",
    },
    objects: [],
    playhead: 4.42,
    prompt: "Add Maxwell equations and explain them in the next Scene.",
    sceneDuration: 12,
    selectedObjectIds: [],
  };
}

async function callHandler(generator: EditSuggestionGenerator, body: unknown) {
  const records: StructuredLogRecord[] = [];
  const logger = createStructuredLogger({
    sinks: [{ write: (record) => records.push(record) }],
  });
  const server = createServer(createEditSuggestionHandler({
    generator: () => generator,
    logger,
    requestId: () => "request-1",
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { records, response, result: await response.json() as unknown };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
    expect(records.map((record) => record.event)).toEqual([
      "request.started",
      "request.received",
      "response.sent",
    ]);
    expect(records.every((record) => record.context.requestId === "request-1")).toBe(true);
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
        history: [{
          ...body.clarification!.history[0],
          answer: { kind: "option", optionId: "missing-option" },
        }],
      },
    };

    const { response, result } = await callHandler(generator, invalidBody);

    expect(response.status).toBe(400);
    expect(result).toEqual({ error: "A clarification option is no longer available." });
    expect(calls).toBe(0);
  });
});
