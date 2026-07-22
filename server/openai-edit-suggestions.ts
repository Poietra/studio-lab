import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

function readApiKey(root: string) {
  const raw = readFileSync(resolve(root, ".openai-key"), "utf8").trim();
  if (!raw.includes("=")) return raw;
  const line = raw.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("OPENAI_API_KEY="));
  return line?.slice(line.indexOf("=") + 1).trim() ?? "";
}

export function openAiEditSuggestions(options: PluginOptions = {}): Plugin {
  let apiKey = options.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  let generator: EditSuggestionGenerator | null = null;
  let logger: StructuredLogger = nullLogger;
  let root = process.cwd();
  const model = options.model ?? "gpt-5.6-luna";

  return {
    apply: "serve",
    name: "poietra-openai-edit-suggestions",
    configResolved(config) {
      root = config.root;
      if (!apiKey) {
        try {
          apiKey = readApiKey(root);
        } catch {
          apiKey = "";
        }
      }
      if (options.logPath !== false) {
        const fileSink = createRotatingJsonlSink({
          logPath: options.logPath ?? ".studio-logs/ai-edit-suggestions.jsonl",
          root,
        });
        logger = createStructuredLogger({
          context: { component: "edit-suggestions-api" },
          sinks: [createConsoleJsonSink({ includeData: false, prefix: "poietra-ai" }), fileSink],
        });
        logger.info("logging.configured", { path: fileSink.path });
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
      server.middlewares.use("/api/ai/edit-suggestions", createEditSuggestionHandler({
        generator: () => generator,
        logger,
      }));
    },
  };
}
