import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Plugin } from "vite";

import type { EditSuggestionAdmissionController } from "./edit-suggestions/admission";
import { createEditSuggestionHandler } from "./edit-suggestions/handler";
import { EDIT_SUGGESTION_INSTRUCTIONS } from "./edit-suggestions/instructions";
import { createOpenAiEditSuggestionGenerator } from "./edit-suggestions/openai-generator";
import type { EditSuggestionGenerator } from "./edit-suggestions/service";
import { sendJson } from "./http/json";
import {
  createConsoleJsonSink,
  createRotatingJsonlSink,
  createStructuredLogger,
  nullLogger,
  type StructuredLogger,
} from "./logging/structured-logger";
import type { VerifiedManimPrincipal } from "./manim-request-principal";
import { createTrustedLocalManimPrincipal, localManimTenantId } from "./manim-request-principal";

export type OpenAiEditSuggestionPluginOptions = Readonly<{
  admission?: EditSuggestionAdmissionController;
  apiKey?: string;
  generationTimeoutMs?: number;
  localDevelopmentOptIn?: boolean;
  localKeyFileOptIn?: boolean;
  logPath?: false | string;
  model?: string;
}>;

function readLocalDevelopmentApiKey(root: string) {
  const raw = readFileSync(resolve(root, ".openai-key"), "utf8").trim();
  if (!raw.includes("=")) return raw;
  const line = raw.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("OPENAI_API_KEY="));
  return line?.slice(line.indexOf("=") + 1).trim() ?? "";
}

function isLocalDevelopmentServer(config: Readonly<{ mode: string; server?: Readonly<{ host?: unknown }> }>) {
  const host = config.server?.host;
  return (
    config.mode === "development" &&
    (host === undefined || host === false || host === "127.0.0.1" || host === "localhost" || host === "::1")
  );
}

export function resolveAiEditSuggestionLogPath(logPath: false | string | undefined, root: string): false | string {
  if (logPath === false || logPath?.trim() === "off") return false;
  const configured = logPath?.trim();
  if (configured?.includes("\0")) throw new TypeError("The AI debug log path is invalid.");
  if (configured) return isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
  const workspaceId = createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), "poietra-studio-logs", workspaceId, "ai-edit-suggestions.jsonl");
}

export function openAiEditSuggestions(options: OpenAiEditSuggestionPluginOptions = {}): Plugin {
  const injectedApiKey = options.apiKey?.trim() || "";
  let generator: EditSuggestionGenerator | null = null;
  let logger: StructuredLogger = nullLogger;
  let principal: VerifiedManimPrincipal | null = null;
  const model = options.model ?? "gpt-5.6-luna";

  return {
    apply: "serve",
    name: "poietra-openai-edit-suggestions",
    configResolved(config) {
      logger = nullLogger;
      const root = config.root;
      const localDevelopment = isLocalDevelopmentServer(config);
      const localOptIn = localDevelopment && options.localDevelopmentOptIn === true;
      principal = null;
      let apiKey = injectedApiKey;
      let localKeyFileUsed = false;
      if (!apiKey && localOptIn && options.localKeyFileOptIn === true) {
        try {
          apiKey = readLocalDevelopmentApiKey(root);
          localKeyFileUsed = Boolean(apiKey);
        } catch {
          apiKey = "";
        }
      }
      if (localDevelopment && !localOptIn) apiKey = "";

      const logPath = resolveAiEditSuggestionLogPath(options.logPath, root);
      if (logPath !== false) {
        const consoleSink = createConsoleJsonSink({ prefix: "poietra-ai" });
        try {
          const fileSink = createRotatingJsonlSink({
            logPath,
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
      if (localDevelopment) {
        const localPrincipal = createTrustedLocalManimPrincipal({
          deployment: "development",
          tenantId: localManimTenantId(resolve(root)),
        });
        principal = localPrincipal;
      }
      if (apiKey && localDevelopment) {
        console.warn(
          localKeyFileUsed
            ? "[poietra-ai] Local AI edit suggestions and the repository .openai-key fallback are enabled; editor context will be sent to the configured remote model."
            : "[poietra-ai] Local AI edit suggestions are enabled; editor context will be sent to the configured remote model.",
        );
      }
      generator = apiKey
        ? createOpenAiEditSuggestionGenerator({
            apiKey,
            instructions: EDIT_SUGGESTION_INSTRUCTIONS,
            model,
          })
        : null;
      logger.info("generator.configured", { status: apiKey ? 200 : 503 });
    },
    configureServer(server) {
      const handler = principal
        ? createEditSuggestionHandler({
            admission: options.admission,
            generationTimeoutMs: options.generationTimeoutMs,
            generator: () => generator,
            logger,
            principal,
          })
        : (request: IncomingMessage, response: Parameters<typeof sendJson>[0]) => {
            request.resume();
            sendJson(response, 401, { error: "Authentication is required." });
          };
      server.middlewares.use("/api/ai/edit-suggestions", handler);
    },
  };
}
