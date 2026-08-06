import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import { sendJson } from "./http/json";
import { createConsoleJsonSink, createStructuredLogger } from "./logging/structured-logger";
import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import { ManimProjectRegistry } from "./manim-project-registry";
import { type ManimRenderPipelineOptions, parseManimCommand } from "./manim-render-config";
import { handleManimRequest, type ManimRequestContext } from "./manim-render-http";
import { localManimTenantId } from "./manim-request-principal";

export function manimRenderPipeline(options: ManimRenderPipelineOptions = {}): Plugin {
  let manager: ManimProjectRegistry | null = null;
  let requestContext: ManimRequestContext | null = null;
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
      const dataRoot = options.workspaceDataRoot ? resolve(options.workspaceDataRoot) : join(config.root, ".poietra");
      const catalog = new PersistentManimProjectCatalog({
        dataRoot,
        seedProjects,
      });
      const tenantId = localManimTenantId(realpathSync(dataRoot));
      manager = new ManimProjectRegistry({
        catalog,
        catalogStorageRoot: realpathSync(dataRoot),
        command: parseManimCommand(options.command),
        frame: {
          height: options.frameHeight ?? 8,
          // Canonical Manim 16:9 frame width (128/9). The exact double
          // matters: producers reject a frame that fails their camera
          // normalization, so all snapshot configs must agree bit-for-bit.
          width: options.frameWidth ?? 14.222222222222221,
        },
        logger,
        projects: seedProjects,
        runtimeTraceProducerCommand: options.runtimeTraceProducerCommand,
        runtimeTraceProducerDevOptIn: options.runtimeTraceProducerDevOptIn ?? false,
        snapshotSandboxDeployment: options.snapshotSandboxDeployment ?? "production",
        snapshotProducerCommand: options.snapshotProducerCommand,
        snapshotProducerDevOptIn: options.snapshotProducerDevOptIn ?? false,
        snapshotVersion: options.snapshotVersion,
        tenantId,
        thumbnailCacheRoot: join(realpathSync(dataRoot), "thumbnails"),
      });
      requestContext = createTrustedLocalManimRequestContext(manager, "development");
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/api/manim/")) {
          next();
          return;
        }
        if (!manager || !requestContext) {
          sendJson(response, 503, { error: "Manim render pipeline is not configured." });
          return;
        }
        await handleManimRequest(requestContext, request, response, logger);
      });
    },
    async closeBundle() {
      await manager?.close();
    },
  };
}
