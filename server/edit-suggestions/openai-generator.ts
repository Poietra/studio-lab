import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import { type ModelSuggestion, modelSuggestionSchema } from "../../src/ai/edit-suggestion-schema";
import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import {
  EditSuggestionGenerationError,
  type EditSuggestionGenerationResult,
  type EditSuggestionGenerator,
  type EditSuggestionTokenUsage,
} from "./service";

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

const NOOP_OPENAI_LOGGER = Object.freeze({
  debug(_message: string, ..._rest: unknown[]) {},
  error(_message: string, ..._rest: unknown[]) {},
  info(_message: string, ..._rest: unknown[]) {},
  warn(_message: string, ..._rest: unknown[]) {},
});

function usageTelemetry(
  usage:
    | Readonly<{
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      }>
    | null
    | undefined,
): EditSuggestionTokenUsage | undefined {
  if (!usage) return undefined;
  const boundedCounter = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;
  const inputTokens = boundedCounter(usage.input_tokens);
  const outputTokens = boundedCounter(usage.output_tokens);
  const totalTokens = boundedCounter(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
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
  const client = new OpenAI({
    apiKey: options.apiKey,
    logLevel: "off",
    logger: NOOP_OPENAI_LOGGER,
    maxRetries: 0,
    timeout: 30_000,
  });

  const requestCandidate = async (
    request: EditSuggestionRequest,
    attempt: CandidateAttempt,
  ): Promise<Readonly<{ candidate: ModelSuggestion | null; usage?: EditSuggestionTokenUsage }>> => {
    const instructions = attempt.repairFeedback
      ? `${options.instructions}\n\nThe previous candidate failed closed-schema validation: ${attempt.repairFeedback}. Return a fresh candidate that satisfies every schema invariant. Do not repeat an operation kind. Parallel steps must have identical start and end values. If the complete request cannot be represented, return one focused clarification.`
      : options.instructions;
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
    const usage = usageTelemetry(completion.usage);
    return {
      candidate: completion.output_parsed,
      ...(usage ? { usage } : {}),
    };
  };

  const generateWithRepair = async (
    request: EditSuggestionRequest,
    signal?: AbortSignal,
  ): Promise<EditSuggestionGenerationResult> => {
    try {
      const initial = await requestCandidate(request, { kind: "initial", signal });
      return {
        suggestion: requireCandidate(initial.candidate),
        telemetry: {
          repairAttempted: false,
          ...(initial.usage ? { usage: initial.usage } : {}),
        },
      };
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const feedback = validationFeedback(error);
      const repaired = await requestCandidate(request, {
        kind: "repair",
        repairFeedback: feedback,
        signal,
      });
      return {
        suggestion: requireCandidate(repaired.candidate, true),
        telemetry: {
          repairAttempted: true,
          ...(repaired.usage ? { usage: repaired.usage } : {}),
        },
      };
    }
  };

  return {
    async generate(request, signal) {
      try {
        return await generateWithRepair(request, signal);
      } catch (error) {
        if (error instanceof EditSuggestionGenerationError) throw error;
        if (error instanceof ZodError) {
          throw new EditSuggestionGenerationError(
            "The model could not produce a valid atomic edit after one repair attempt. Please try the request again.",
            422,
            { cause: error },
          );
        }
        const status = error instanceof OpenAI.APIError && error.status === 429 ? 429 : 502;
        throw new EditSuggestionGenerationError("The AI provider request failed.", status, { cause: error });
      }
    },
  };
}
