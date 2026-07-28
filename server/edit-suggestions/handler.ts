import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { editSuggestionRequestSchema, modelSuggestionSchema } from "../../src/ai/edit-suggestion-schema";
import { HttpError, readJsonBody, sendJson } from "../http/json";
import type { StructuredLogger } from "../logging/structured-logger";
import { isVerifiedManimPrincipal, type VerifiedManimPrincipal } from "../manim-request-principal";
import {
  createEditSuggestionAdmissionController,
  type EditSuggestionAdmissionController,
  type EditSuggestionGenerationReservation,
} from "./admission";
import { EditSuggestionGenerationError, type EditSuggestionGenerator } from "./service";

export const EDIT_SUGGESTION_ROUTE = "/api/ai/edit-suggestions";

export type EditSuggestionRequestPolicy = Readonly<{
  expectedOrigin?: string;
  maxJsonBodyBytes?: number;
  principal: VerifiedManimPrincipal;
  requestSignal?: AbortSignal;
}>;

export type EditSuggestionRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  policy: EditSuggestionRequestPolicy,
) => Promise<void>;

export type EditSuggestionHandlerOptions = Readonly<{
  admission?: EditSuggestionAdmissionController;
  generationTimeoutMs?: number;
  generator: () => EditSuggestionGenerator | null;
  logger: StructuredLogger;
  now?: () => number;
  requestId?: () => string;
}>;

function generationFailureStatus(error: EditSuggestionGenerationError) {
  if (error.status === 422 || error.status === 429) return error.status;
  return 502;
}

function requestFailureStatus(error: HttpError) {
  if ([400, 401, 403, 413, 415].includes(error.status)) return error.status;
  return 400;
}

function failureStatus(error: unknown, generationStarted: boolean) {
  if (error instanceof EditSuggestionGenerationError) return generationFailureStatus(error);
  if (!generationStarted && error instanceof HttpError) return requestFailureStatus(error);
  return undefined;
}

function publicGenerationFailure(error: EditSuggestionGenerationError) {
  const status = generationFailureStatus(error);
  if (status === 422) {
    return { error: "The model did not return a valid edit suggestion.", status: 422 } as const;
  }
  if (status === 429) {
    return { error: "Edit suggestion capacity is temporarily exhausted.", status: 429 } as const;
  }
  return { error: "Edit suggestion generation failed.", status: 502 } as const;
}

function boundedRequestId(candidate: unknown) {
  return typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(candidate)
    ? candidate
    : randomUUID();
}

function boundedLatency(startedAt: number, now: () => number) {
  const elapsed = Math.floor(now() - startedAt);
  if (!Number.isSafeInteger(elapsed) || elapsed <= 0) return 0;
  return Math.min(elapsed, 120_000);
}

function requireSameOriginMutation(request: IncomingMessage, expectedOrigin?: string) {
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin mutation requests are not allowed.", 403);
  }
  const origin = request.headers.origin;
  if (expectedOrigin) {
    let actualOrigin: string | null = null;
    try {
      const parsed = origin ? new URL(origin) : null;
      actualOrigin =
        parsed && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
          ? parsed.origin
          : null;
    } catch {
      // The fixed rejection below intentionally does not echo the origin.
    }
    if (actualOrigin !== expectedOrigin) {
      request.resume();
      throw new HttpError("Mutation requests require the configured public Origin.", 403);
    }
    return;
  }
  if (!origin) return;
  const host = request.headers.host;
  try {
    const parsed = new URL(origin);
    const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
    if (
      !host ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.protocol !== protocol ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.host.toLowerCase() !== host.toLowerCase()
    ) {
      throw new Error("Origin does not match Host.");
    }
  } catch {
    request.resume();
    throw new HttpError("Mutation requests require a same-origin request.", 403);
  }
}

const GENERATION_ABORTED = Symbol("generation-aborted");

const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).max(10_000_000).optional(),
    outputTokens: z.number().int().min(0).max(10_000_000).optional(),
    totalTokens: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

const generationResultSchema = z
  .object({
    suggestion: modelSuggestionSchema,
    telemetry: z
      .object({
        repairAttempted: z.boolean(),
        usage: tokenUsageSchema.optional(),
      })
      .strict(),
  })
  .strict();

async function raceWithSignal<T>(running: Promise<T>, signal: AbortSignal): Promise<T | typeof GENERATION_ABORTED> {
  if (signal.aborted) return GENERATION_ABORTED;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<typeof GENERATION_ABORTED>((resolve) => {
    abortListener = () => resolve(GENERATION_ABORTED);
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    if (signal.aborted) return GENERATION_ABORTED;
    return await Promise.race([running, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function trackGeneration<T>(
  pending: Set<Promise<unknown>>,
  reservation: EditSuggestionGenerationReservation,
  operation: () => Promise<T>,
) {
  const running = Promise.resolve().then(operation);
  pending.add(running);
  const settled = () => {
    try {
      reservation.release();
    } finally {
      pending.delete(running);
    }
  };
  // Both branches consume the provider settlement. The trailing catch also
  // prevents a defensive reservation implementation from creating a detached
  // unhandled rejection during cleanup.
  void running.then(settled, settled).catch(() => undefined);
  return running;
}

export function createEditSuggestionRequestHandler(
  options: EditSuggestionHandlerOptions,
): EditSuggestionRequestHandler {
  const admission = options.admission ?? createEditSuggestionAdmissionController();
  const generationTimeoutMs = options.generationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(generationTimeoutMs) || generationTimeoutMs <= 0 || generationTimeoutMs > 120_000) {
    throw new RangeError("The edit-suggestion generation timeout must be between 1 and 120000 milliseconds.");
  }
  const now = options.now ?? Date.now;
  const pendingGenerations = new Set<Promise<unknown>>();

  return async (request, response, policy) => {
    const requestId = boundedRequestId((options.requestId ?? randomUUID)());
    const startedAt = now();
    let logger = options.logger.child({ requestId });
    response.setHeader("x-poietra-request-id", requestId);
    const requestAbort = new AbortController();
    let generationStarted = false;
    let generationTimedOut = false;
    const abortFromParent = () => requestAbort.abort(policy.requestSignal?.reason);
    const abortFromRequest = () => requestAbort.abort(new Error("The client request was interrupted."));
    const abortOnClosedResponse = () => {
      if (!response.writableEnded) requestAbort.abort(new Error("The client connection closed."));
    };
    if (policy.requestSignal?.aborted) abortFromParent();
    else policy.requestSignal?.addEventListener("abort", abortFromParent, { once: true });
    request.once("aborted", abortFromRequest);
    response.once("close", abortOnClosedResponse);

    const telemetry = (status: number) => ({ latencyMs: boundedLatency(startedAt, now), status });
    const respond = (status: number, body: unknown) => {
      if (!sendJson(response, status, body)) {
        logger.warn("response.abandoned", telemetry(status));
        return;
      }
      logger.info("response.sent", telemetry(status));
    };

    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/" && pathname !== EDIT_SUGGESTION_ROUTE) {
        respond(404, { error: "Edit-suggestion endpoint not found." });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        respond(405, { error: "Method not allowed." });
        return;
      }
      if (!isVerifiedManimPrincipal(policy.principal)) throw new HttpError("Authentication is required.", 401);
      logger = logger.child(admission.correlations(policy.principal));
      logger.info("request.started");
      if (!admission.consumeRequest(policy.principal)) {
        request.resume();
        respond(429, { error: "Edit suggestion capacity is temporarily exhausted." });
        return;
      }
      if (requestAbort.signal.aborted) {
        request.resume();
        logger.warn("response.abandoned", telemetry(499));
        return;
      }

      const generator = options.generator();
      if (!generator) {
        request.resume();
        respond(503, { error: "The OpenAI credential is not configured." });
        return;
      }
      requireSameOriginMutation(request, policy.expectedOrigin);
      const body = await readJsonBody(request, Math.min(policy.maxJsonBodyBytes ?? 64 * 1024, 64 * 1024));
      logger.info("request.received");
      const parsed = editSuggestionRequestSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("request.validation_failed");
        const hasUnavailableOption = parsed.error.issues.some(
          (issue) => issue.code === "custom" && issue.path.at(-1) === "optionId",
        );
        respond(400, {
          error: hasUnavailableOption
            ? "A clarification option is no longer available."
            : "Invalid edit-suggestion context.",
        });
        return;
      }
      if (requestAbort.signal.aborted) {
        logger.warn("response.abandoned", telemetry(499));
        return;
      }

      const admitted = admission.reserveGeneration(policy.principal);
      if (!admitted.accepted) {
        respond(429, { error: "Edit suggestion capacity is temporarily exhausted." });
        return;
      }

      const timeout = setTimeout(() => {
        generationTimedOut = true;
        requestAbort.abort(new Error("The edit-suggestion generation deadline expired."));
      }, generationTimeoutMs);
      timeout.unref();
      let result: Awaited<ReturnType<EditSuggestionGenerator["generate"]>> | typeof GENERATION_ABORTED;
      try {
        generationStarted = true;
        logger.info("model.requested");
        const running = trackGeneration(pendingGenerations, admitted.reservation, () => {
          if (requestAbort.signal.aborted) {
            throw requestAbort.signal.reason ?? new Error("The edit-suggestion generation was aborted.");
          }
          return generator.generate(parsed.data, requestAbort.signal);
        });
        result = await raceWithSignal(running, requestAbort.signal);
      } finally {
        clearTimeout(timeout);
      }
      if (result === GENERATION_ABORTED) {
        if (generationTimedOut && !response.destroyed) {
          respond(504, { error: "Edit suggestion generation timed out." });
        } else {
          logger.warn("response.abandoned", telemetry(499));
        }
        return;
      }
      const validatedGeneration = generationResultSchema.safeParse(result);
      if (!validatedGeneration.success) {
        logger.warn("model.result_rejected");
        throw new EditSuggestionGenerationError("The generator returned an invalid result envelope.", 502);
      }
      if (validatedGeneration.data.telemetry.repairAttempted) logger.warn("model.validation_failed");
      logger.info(
        "model.responded",
        validatedGeneration.data.telemetry.usage
          ? {
              usage: validatedGeneration.data.telemetry.usage,
            }
          : undefined,
      );
      const suggestion = validatedGeneration.data.suggestion;
      if (suggestion.kind === "clarification" || !suggestion.operation) {
        respond(200, {
          kind: "clarification",
          message: suggestion.message || "Please make the desired spatial change more specific.",
          options:
            suggestion.options.length >= 2
              ? suggestion.options.map((option, index) => ({ ...option, id: `option-${index + 1}` }))
              : [],
        });
        return;
      }

      respond(200, {
        kind: "suggestion",
        suggestion: {
          assumptions: suggestion.assumptions,
          confidence: "medium",
          operation: suggestion.operation,
          provider: "remote",
          summary: suggestion.summary,
        },
      });
    } catch (error) {
      if (requestAbort.signal.aborted) {
        if (generationTimedOut && !response.destroyed && !response.writableEnded) {
          respond(504, { error: "Edit suggestion generation timed out." });
        } else {
          logger.warn("response.abandoned", telemetry(499));
        }
        return;
      }
      const status = failureStatus(error, generationStarted);
      logger.error("request.failed", {
        latencyMs: boundedLatency(startedAt, now),
        ...(status === undefined ? {} : { status }),
      });
      if (!generationStarted && error instanceof HttpError) {
        const requestStatus = requestFailureStatus(error);
        if (requestStatus === 401) {
          respond(401, { error: "Authentication is required." });
          return;
        }
        respond(requestStatus, { error: error.message });
        return;
      }
      if (error instanceof EditSuggestionGenerationError) {
        const failure = publicGenerationFailure(error);
        respond(failure.status, { error: failure.error });
        return;
      }
      respond(502, { error: "Edit suggestion generation failed." });
    } finally {
      policy.requestSignal?.removeEventListener("abort", abortFromParent);
      request.removeListener("aborted", abortFromRequest);
      response.removeListener("close", abortOnClosedResponse);
    }
  };
}

export function createEditSuggestionHandler(
  options: EditSuggestionHandlerOptions & Readonly<{ principal: VerifiedManimPrincipal }>,
) {
  const handler = createEditSuggestionRequestHandler(options);
  return (request: IncomingMessage, response: ServerResponse) =>
    handler(request, response, {
      principal: options.principal,
    });
}
