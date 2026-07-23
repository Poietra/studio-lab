import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

import { sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import { handleManimRequest } from "./manim-render-http";
import {
  ManimProjectRegistry,
  type ManimProjectConfig,
} from "./manim-render-pipeline";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function setShellHeaders(response: import("node:http").ServerResponse) {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

async function staticFile(canonicalDistRoot: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!relativePath || relativePath.split("/").includes("..")) return null;
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(canonicalDistRoot, relativePath));
  } catch {
    return null;
  }
  const pathFromRoot = relative(canonicalDistRoot, canonicalPath);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    return null;
  }
  const metadata = await stat(canonicalPath);
  return metadata.isFile() ? { canonicalPath, metadata } : null;
}

export type ElectronShellServer = Readonly<{
  close: () => Promise<void>;
  origin: string;
  registry: ManimProjectRegistry;
}>;

export async function startElectronShellServer(options: Readonly<{
  command: readonly string[];
  dataRoot: string;
  distRoot: string;
  frame?: Readonly<{ height: number; width: number }>;
  logger?: StructuredLogger;
  projects?: readonly ManimProjectConfig[];
}>): Promise<ElectronShellServer> {
  const canonicalDistRoot = await realpath(resolve(options.distRoot));
  const projects = options.projects ?? [];
  const catalog = new PersistentManimProjectCatalog({
    dataRoot: options.dataRoot,
    seedProjects: projects,
  });
  const registry = new ManimProjectRegistry({
    catalog,
    command: options.command,
    frame: options.frame ?? { height: 8, width: 14.222 },
    logger: options.logger ?? nullLogger,
    projects,
  });
  let expectedHost = "";
  let closing = false;
  const server = createServer((request, response) => {
    if (closing) {
      sendJson(response, 503, { error: "Electron shell service is shutting down." });
      return;
    }
    if (request.headers.host !== expectedHost) {
      sendJson(response, 421, { error: "Electron shell service rejected an unexpected Host header." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${expectedHost}`);
    if (url.pathname.startsWith("/api/manim/")) {
      void handleManimRequest(registry, request, response, options.logger ?? nullLogger);
      return;
    }
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      const file = await staticFile(canonicalDistRoot, url.pathname);
      if (!file) {
        sendJson(response, 404, { error: "Shell asset not found." });
        return;
      }
      setShellHeaders(response);
      response.statusCode = 200;
      response.setHeader("cache-control", extname(file.canonicalPath) === ".html" ? "no-store" : "public, max-age=31536000, immutable");
      response.setHeader("content-length", file.metadata.size);
      response.setHeader("content-type", CONTENT_TYPES[extname(file.canonicalPath)] ?? "application/octet-stream");
      if (request.method === "HEAD") response.end();
      else response.end(await readFile(file.canonicalPath));
    })().catch((error: unknown) => {
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else sendJson(response, 500, { error: "Could not read the Electron shell asset." });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  const origin = `http://${expectedHost}`;
  let closeRequest: Promise<void> | null = null;

  return {
    close: () => {
      closeRequest ??= (async () => {
        closing = true;
        const networkClosed = new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
          server.closeIdleConnections();
        });
        const registryResult = await Promise.allSettled([registry.close()]);
        server.closeAllConnections();
        const results = [...registryResult, ...await Promise.allSettled([networkClosed])];
        const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Electron shell service.");
      })();
      return closeRequest;
    },
    origin,
    registry,
  };
}
