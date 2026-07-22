import type { EditSuggestionRequest } from "../../src/ai/edit-suggestions";
import type { ModelSuggestion } from "../../src/ai/edit-suggestion-schema";
import type { StructuredLogger } from "../logging/structured-logger";

export type EditSuggestionGenerator = Readonly<{
  generate: (
    request: EditSuggestionRequest,
    logger: StructuredLogger,
    signal?: AbortSignal,
  ) => Promise<ModelSuggestion>;
}>;

export class EditSuggestionGenerationError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "EditSuggestionGenerationError";
    this.status = status;
  }
}
