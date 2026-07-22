import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";

import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import {
  modelSuggestionSchema,
  type ModelSuggestion,
} from "../../src/ai/edit-suggestion-schema";
import type { StructuredLogger } from "../logging/structured-logger";
import {
  EditSuggestionGenerationError,
  type EditSuggestionGenerator,
} from "./service";

type OpenAiGeneratorOptions = Readonly<{
  apiKey: string;
  instructions: string;
  model: string;
}>;

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

export function createOpenAiEditSuggestionGenerator(
  options: OpenAiGeneratorOptions,
): EditSuggestionGenerator {
  const client = new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: 30_000 });

  const requestCandidate = async (
    request: EditSuggestionRequest,
    logger: StructuredLogger,
    attempt: "initial" | "repair",
    repairFeedback?: string,
  ): Promise<ModelSuggestion | null> => {
    const instructions = repairFeedback
      ? `${options.instructions}\n\nThe previous candidate failed closed-schema validation: ${repairFeedback}. Return a fresh candidate that satisfies every schema invariant. Do not repeat an operation kind. Parallel steps must have identical start and end values. If the complete request cannot be represented, return one focused clarification.`
      : options.instructions;
    logger.info("model.requested", {
      attempt,
      instructions,
      model: options.model,
      repairFeedback,
      request,
    });
    const completion = await client.responses.parse({
      input: [{ content: JSON.stringify(request), role: "user" }],
      instructions,
      max_output_tokens: 900,
      model: options.model,
      reasoning: { effort: "none" },
      store: false,
      text: { format: zodTextFormat(modelSuggestionSchema, "poietra_edit_suggestion") },
    });
    logger.info("model.responded", {
      attempt,
      responseId: completion.id,
      result: completion.output_parsed,
      usage: completion.usage,
    });
    return completion.output_parsed;
  };

  const generateWithRepair = async (
    request: EditSuggestionRequest,
    logger: StructuredLogger,
  ) => {
    try {
      return requireCandidate(await requestCandidate(request, logger, "initial"));
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const feedback = validationFeedback(error);
      logger.warn("model.validation_failed", {
        attempt: "initial",
        feedback,
        issues: error.issues,
      });
      return requireCandidate(
        await requestCandidate(request, logger, "repair", feedback),
        true,
      );
    }
  };

  return {
    async generate(request, logger) {
      try {
        return await generateWithRepair(request, logger);
      } catch (error) {
        if (error instanceof EditSuggestionGenerationError) throw error;
        if (error instanceof ZodError) {
          throw new EditSuggestionGenerationError(
            "The model could not produce a valid atomic edit after one repair attempt. Please try the request again.",
            422,
            { cause: error },
          );
        }
        const status = error instanceof OpenAI.APIError
          && error.status >= 400
          && error.status < 500
          ? error.status
          : 502;
        throw new EditSuggestionGenerationError(
          error instanceof Error ? error.message : "OpenAI request failed.",
          status,
          { cause: error },
        );
      }
    },
  };
}
