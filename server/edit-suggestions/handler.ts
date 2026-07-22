import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { editSuggestionRequestSchema } from "../../src/ai/edit-suggestion-schema";
import { HttpError, readJsonBody, sendJson } from "../http/json";
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
    const requestAbort = new AbortController();
    const abortGeneration = () => requestAbort.abort();
    const abortOnClosedResponse = () => {
      if (!response.writableEnded) abortGeneration();
    };
    request.once("aborted", abortGeneration);
    response.once("close", abortOnClosedResponse);

    const respond = (status: number, body: unknown) => {
      if (!sendJson(response, status, body)) {
        logger.warn("response.abandoned", { status });
        return;
      }
      logger.info("response.sent", { body, status });
    };

    logger.info("request.started");
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/") {
        respond(404, { error: "Edit-suggestion endpoint not found." });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        respond(405, { error: "Method not allowed." });
        return;
      }
      const generator = options.generator();
      if (!generator) {
        respond(503, { error: "The local OpenAI credential is not configured." });
        return;
      }
      const body = await readJsonBody(request);
      logger.info("request.received", { body });
      const parsed = editSuggestionRequestSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("request.validation_failed", { issues: parsed.error.issues });
        const hasUnavailableOption = parsed.error.issues.some((issue) => (
          issue.code === "custom" && issue.path.at(-1) === "optionId"
        ));
        respond(400, {
          error: hasUnavailableOption
            ? "A clarification option is no longer available."
            : "Invalid edit-suggestion context.",
        });
        return;
      }

      const result = await generator.generate(parsed.data, logger, requestAbort.signal);
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
      if (error instanceof HttpError) {
        respond(error.status, { error: error.message });
        return;
      }
      if (error instanceof EditSuggestionGenerationError) {
        respond(error.status, { error: error.message });
        return;
      }
      respond(502, { error: "Edit suggestion generation failed." });
    } finally {
      request.removeListener("aborted", abortGeneration);
      response.removeListener("close", abortOnClosedResponse);
    }
  };
}
