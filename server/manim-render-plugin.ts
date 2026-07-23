import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { sendJson } from "./http/json";
import {
  createConsoleJsonSink,
  createStructuredLogger,
} from "./logging/structured-logger";
import {
  parseManimCommand,
  type ManimRenderPipelineOptions,
} from "./manim-render-config";
import { handleManimRequest } from "./manim-render-http";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import { ManimProjectRegistry } from "./manim-project-registry";

export function manimRenderPipeline(options: ManimRenderPipelineOptions = {}): Plugin {
  let manager: ManimProjectRegistry | null = null;
  const logger = createStructuredLogger({
    context: { component: "manim-render-api" },
    sinks: [createConsoleJsonSink({ includeData: false, prefix: "poietra-manim" })],
  });
  return {
    apply: "serve",
    name: "poietra-manim-render-pipeline",
    configResolved(config) {
      const seedProjects = options.projects?.length
        ? options.projects
        : [{ root: options.projectRoot ? resolve(options.projectRoot) : config.root }];
      const catalog = new PersistentManimProjectCatalog({
        dataRoot: options.workspaceDataRoot ? resolve(options.workspaceDataRoot) : join(config.root, ".poietra"),
        seedProjects,
      });
      manager = new ManimProjectRegistry({
        catalog,
        command: parseManimCommand(options.command),
        frame: {
          height: options.frameHeight ?? 8,
          width: options.frameWidth ?? 14.222,
        },
        logger,
        projects: seedProjects,
      });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/api/manim/")) {
          next();
          return;
        }
        if (!manager) {
          sendJson(response, 503, { error: "Manim render pipeline is not configured." });
          return;
        }
        await handleManimRequest(manager, request, response, logger);
      });
    },
    async closeBundle() {
      await manager?.close();
    },
  };
}
