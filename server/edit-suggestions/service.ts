import type { ModelSuggestion } from "../../src/ai/edit-suggestion-schema";
import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";

export type EditSuggestionTokenUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}>;

export type EditSuggestionGenerationTelemetry = Readonly<{
  repairAttempted: boolean;
  usage?: EditSuggestionTokenUsage;
}>;

export type EditSuggestionGenerationResult = Readonly<{
  suggestion: ModelSuggestion;
  telemetry: EditSuggestionGenerationTelemetry;
}>;

/**
 * The provider-facing capability surface is intentionally narrow: it receives
 * request data plus cancellation, never the server logger. The handler treats
 * this result envelope as untrusted and validates it before logging telemetry.
 */
export type EditSuggestionGenerator = Readonly<{
  generate: (request: EditSuggestionRequest, signal?: AbortSignal) => Promise<EditSuggestionGenerationResult>;
}>;

export class EditSuggestionGenerationError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "EditSuggestionGenerationError";
    this.status = status;
  }
}
