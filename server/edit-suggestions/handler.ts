import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ClarificationTurn } from "../../src/ai/edit-suggestions";
import { editSuggestionRequestSchema } from "../../src/ai/edit-suggestion-schema";
import { HttpRequestError, readJsonBody, sendJson } from "../http/json";
import type { StructuredLogger } from "../logging/structured-logger";
import {
  EditSuggestionGenerationError,
  type EditSuggestionGenerator,
} from "./service";

type HandlerOptions = Readonly<{
  generator: () => EditSuggestionGenerator | null;
  logger: StructuredLogger;
  requestId?: () => string;
}>;

function hasValidOptionAnswer(turn: ClarificationTurn) {
  const answer = turn.answer;
  return answer.kind !== "option"
    || turn.options.some((option) => option.id === answer.optionId);
}

function errorDetails(error: unknown) {
  return error instanceof Error
    ? { error, message: error.message, name: error.name }
    : { error };
}

export function createEditSuggestionHandler(options: HandlerOptions) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = (options.requestId ?? randomUUID)();
    const logger = options.logger.child({
      method: request.method,
      requestId,
      route: "/api/ai/edit-suggestions",
    });
    response.setHeader("x-poietra-request-id", requestId);

    const respond = (status: number, body: unknown) => {
      logger.info("response.sent", { body, status });
      sendJson(response, status, body);
    };

    logger.info("request.started");
    if (request.method !== "POST") {
      respond(405, { error: "Method not allowed." });
      return;
    }
    const generator = options.generator();
    if (!generator) {
      respond(503, { error: "The local OpenAI credential is not configured." });
      return;
    }

    try {
      const body = await readJsonBody(request);
      logger.info("request.received", { body });
      const parsed = editSuggestionRequestSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("request.validation_failed", { issues: parsed.error.issues });
        respond(400, { error: "Invalid edit-suggestion context." });
        return;
      }

      const turns = parsed.data.clarification
        ? [...parsed.data.clarification.history, parsed.data.clarification]
        : [];
      if (!turns.every(hasValidOptionAnswer)) {
        respond(400, { error: "A clarification option is no longer available." });
        return;
      }

      const result = await generator.generate(parsed.data, logger);
      if (result.kind === "clarification" || !result.operation) {
        respond(200, {
          kind: "clarification",
          message: result.message || "Please make the desired spatial change more specific.",
          options: result.options.length >= 2
            ? result.options.map((option, index) => ({ ...option, id: `option-${index + 1}` }))
            : [],
        });
        return;
      }

      respond(200, {
        kind: "suggestion",
        suggestion: {
          assumptions: result.assumptions,
          confidence: "medium",
          operation: result.operation,
          provider: "remote",
          summary: result.summary,
        },
      });
    } catch (error) {
      logger.error("request.failed", errorDetails(error));
      if (error instanceof HttpRequestError) {
        respond(error.status, { error: error.message });
        return;
      }
      if (error instanceof EditSuggestionGenerationError) {
        respond(error.status, { error: error.message });
        return;
      }
      respond(502, { error: "Edit suggestion generation failed." });
    }
  };
}
