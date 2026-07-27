import type { Plugin } from "vite";

import { createEditSuggestionHandler } from "./edit-suggestions/handler";
import { EDIT_SUGGESTION_INSTRUCTIONS } from "./edit-suggestions/instructions";
import { createOpenAiEditSuggestionGenerator } from "./edit-suggestions/openai-generator";
import type { EditSuggestionGenerator } from "./edit-suggestions/service";
import {
  createConsoleJsonSink,
  createRotatingJsonlSink,
  createStructuredLogger,
  nullLogger,
  type StructuredLogger,
} from "./logging/structured-logger";

type PluginOptions = Readonly<{
  apiKey?: string;
  logPath?: false | string;
  model?: string;
}>;

export function openAiEditSuggestions(options: PluginOptions = {}): Plugin {
  const apiKey = options.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  let generator: EditSuggestionGenerator | null = null;
  let logger: StructuredLogger = nullLogger;
  let root = process.cwd();
  const model = options.model ?? "gpt-5.6-luna";

  return {
    apply: "serve",
    name: "poietra-openai-edit-suggestions",
    configResolved(config) {
      root = config.root;
      if (options.logPath !== false) {
        const consoleSink = createConsoleJsonSink({ includeData: false, prefix: "poietra-ai" });
        try {
          const fileSink = createRotatingJsonlSink({
            logPath: options.logPath ?? ".studio-logs/ai-edit-suggestions.jsonl",
            root,
          });
          logger = createStructuredLogger({
            context: { component: "edit-suggestions-api" },
            sinks: [consoleSink, fileSink],
          });
          logger.info("logging.configured", { sink: "rotating-jsonl" });
        } catch {
          logger = createStructuredLogger({
            context: { component: "edit-suggestions-api" },
            sinks: [consoleSink],
          });
          logger.warn("logging.file_sink_unavailable");
        }
      }
      generator = apiKey
        ? createOpenAiEditSuggestionGenerator({
            apiKey,
            instructions: EDIT_SUGGESTION_INSTRUCTIONS,
            model,
          })
        : null;
      logger.info("generator.configured", { credentialConfigured: Boolean(apiKey), model });
    },
    configureServer(server) {
      server.middlewares.use(
        "/api/ai/edit-suggestions",
        createEditSuggestionHandler({
          generator: () => generator,
          logger,
        }),
      );
    },
  };
}
