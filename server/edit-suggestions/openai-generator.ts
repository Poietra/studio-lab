import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import { type ModelSuggestion, modelSuggestionSchema } from "../../src/ai/edit-suggestion-schema";
import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import type { StructuredLogger } from "../logging/structured-logger";
import { EditSuggestionGenerationError, type EditSuggestionGenerator } from "./service";

type OpenAiGeneratorOptions = Readonly<{
  apiKey: string;
  instructions: string;
  model: string;
}>;

type CandidateAttempt = Readonly<{
  kind: "initial" | "repair";
  repairFeedback?: string;
  signal?: AbortSignal;
}>;

function usageTelemetry(
  usage:
    | Readonly<{
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      }>
    | null
    | undefined,
) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function validationFeedback(error: ZodError) {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
    .join("; ");
}

function requireCandidate(candidate: ModelSuggestion | null, repaired = false) {
  if (candidate) return candidate;
  throw new EditSuggestionGenerationError(
    repaired
      ? "The model did not return a usable structured suggestion after repair."
      : "The model did not return a usable structured suggestion.",
    422,
  );
}

export function createOpenAiEditSuggestionGenerator(options: OpenAiGeneratorOptions): EditSuggestionGenerator {
  const client = new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: 30_000 });

  const requestCandidate = async (
    request: EditSuggestionRequest,
    logger: StructuredLogger,
    attempt: CandidateAttempt,
  ): Promise<ModelSuggestion | null> => {
    const instructions = attempt.repairFeedback
      ? `${options.instructions}\n\nThe previous candidate failed closed-schema validation: ${attempt.repairFeedback}. Return a fresh candidate that satisfies every schema invariant. Do not repeat an operation kind. Parallel steps must have identical start and end values. If the complete request cannot be represented, return one focused clarification.`
      : options.instructions;
    logger.info("model.requested", {
      attempt: attempt.kind,
      model: options.model,
    });
    const completion = await client.responses.parse(
      {
        input: [{ content: JSON.stringify(request), role: "user" }],
        instructions,
        max_output_tokens: 900,
        model: options.model,
        reasoning: { effort: "none" },
        store: false,
        text: { format: zodTextFormat(modelSuggestionSchema, "poietra_edit_suggestion") },
      },
      { signal: attempt.signal },
    );
    logger.info("model.responded", {
      attempt: attempt.kind,
      usage: usageTelemetry(completion.usage),
    });
    return completion.output_parsed;
  };

  const generateWithRepair = async (request: EditSuggestionRequest, logger: StructuredLogger, signal?: AbortSignal) => {
    try {
      return requireCandidate(await requestCandidate(request, logger, { kind: "initial", signal }));
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const feedback = validationFeedback(error);
      logger.warn("model.validation_failed", {
        attempt: "initial",
        issueCodes: [...new Set(error.issues.map((issue) => issue.code))].sort(),
        issueCount: error.issues.length,
      });
      return requireCandidate(
        await requestCandidate(request, logger, {
          kind: "repair",
          repairFeedback: feedback,
          signal,
        }),
        true,
      );
    }
  };

  return {
    async generate(request, logger, signal) {
      try {
        return await generateWithRepair(request, logger, signal);
      } catch (error) {
        if (error instanceof EditSuggestionGenerationError) throw error;
        if (error instanceof ZodError) {
          throw new EditSuggestionGenerationError(
            "The model could not produce a valid atomic edit after one repair attempt. Please try the request again.",
            422,
            { cause: error },
          );
        }
        throw new EditSuggestionGenerationError("The AI provider request failed.", 502, { cause: error });
      }
    },
  };
}
