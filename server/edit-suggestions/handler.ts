import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { editSuggestionRequestSchema } from "../../src/ai/edit-suggestion-schema";
import { HttpError, readJsonBody, sendJson } from "../http/json";
import type { StructuredLogger } from "../logging/structured-logger";
import { EditSuggestionGenerationError, type EditSuggestionGenerator } from "./service";

type HandlerOptions = Readonly<{
  generator: () => EditSuggestionGenerator | null;
  logger: StructuredLogger;
  requestId?: () => string;
}>;

function failureTelemetry(error: unknown) {
  if (error instanceof HttpError) return { failure: "http", status: error.status } as const;
  if (error instanceof EditSuggestionGenerationError) {
    return { failure: "generation", status: error.status } as const;
  }
  return { failure: "internal" } as const;
}

function validationTelemetry(issues: readonly Readonly<{ code: string }>[]) {
  return {
    issueCodes: [...new Set(issues.map((issue) => issue.code))].sort(),
    issueCount: issues.length,
  };
}

function publicGenerationFailure(error: EditSuggestionGenerationError) {
  if (error.status === 422) {
    return { error: "The model did not return a valid edit suggestion.", status: 422 } as const;
  }
  if (error.status === 429) {
    return { error: "Edit suggestion capacity is temporarily exhausted.", status: 429 } as const;
  }
  return { error: "Edit suggestion generation failed.", status: 502 } as const;
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

    const respond = (status: number, body: unknown, outcome: string) => {
      if (!sendJson(response, status, body)) {
        logger.warn("response.abandoned", { outcome, status });
        return;
      }
      logger.info("response.sent", { outcome, status });
    };

    logger.info("request.started");
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/") {
        respond(404, { error: "Edit-suggestion endpoint not found." }, "not-found");
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        respond(405, { error: "Method not allowed." }, "method-not-allowed");
        return;
      }
      const generator = options.generator();
      if (!generator) {
        respond(503, { error: "The OpenAI credential is not configured." }, "generator-unavailable");
        return;
      }
      const body = await readJsonBody(request);
      logger.info("request.received");
      const parsed = editSuggestionRequestSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("request.validation_failed", validationTelemetry(parsed.error.issues));
        const hasUnavailableOption = parsed.error.issues.some(
          (issue) => issue.code === "custom" && issue.path.at(-1) === "optionId",
        );
        respond(
          400,
          {
            error: hasUnavailableOption
              ? "A clarification option is no longer available."
              : "Invalid edit-suggestion context.",
          },
          "validation-failed",
        );
        return;
      }

      const result = await generator.generate(parsed.data, logger, requestAbort.signal);
      if (result.kind === "clarification" || !result.operation) {
        respond(
          200,
          {
            kind: "clarification",
            message: result.message || "Please make the desired spatial change more specific.",
            options:
              result.options.length >= 2
                ? result.options.map((option, index) => ({ ...option, id: `option-${index + 1}` }))
                : [],
          },
          "clarification",
        );
        return;
      }

      respond(
        200,
        {
          kind: "suggestion",
          suggestion: {
            assumptions: result.assumptions,
            confidence: "medium",
            operation: result.operation,
            provider: "remote",
            summary: result.summary,
          },
        },
        "suggestion",
      );
    } catch (error) {
      logger.error("request.failed", failureTelemetry(error));
      if (error instanceof HttpError) {
        respond(error.status, { error: error.message }, "http-failed");
        return;
      }
      if (error instanceof EditSuggestionGenerationError) {
        const failure = publicGenerationFailure(error);
        respond(failure.status, { error: failure.error }, "generation-failed");
        return;
      }
      respond(502, { error: "Edit suggestion generation failed." }, "internal-failed");
    } finally {
      request.removeListener("aborted", abortGeneration);
      response.removeListener("close", abortOnClosedResponse);
    }
  };
}
