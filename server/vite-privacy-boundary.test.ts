import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as createRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, createServer, normalizePath, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudioViteConfig } from "../vite.config";
import {
  createStudioViteFsDeny,
  loadStudioNonSecretEnvironment,
  shouldDenyStudioSensitiveFileRequest,
  studioSensitiveFileBoundary,
  VITE_DEFAULT_FS_DENY,
} from "./vite-privacy-boundary";

const servers: ViteDevServer[] = [];
const roots: string[] = [];

function request(server: ViteDevServer, path: string) {
  const address = server.httpServer?.address() as AddressInfo;
  return new Promise<Readonly<{ body: string; status: number }>>((resolveResponse, rejectResponse) => {
    const outgoing = createRequest(
      {
        headers: { connection: "close", host: `127.0.0.1:${address.port}` },
        host: "127.0.0.1",
        path,
        port: address.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolveResponse({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.once("error", rejectResponse);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("Vite privacy boundary", () => {
  it("classifies POSIX and drive-absolute /@fs paths without treating relative paths as absolute", () => {
    const windows = { logPath: "C:/Studio/private/active.jsonl", root: "C:/Studio" } as const;
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/C:/Studio/private/active.jsonl", windows)).toBe(true);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/c%3A/Studio/private/active.jsonl.previous?raw", windows)).toBe(
      true,
    );
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/C:/Studio/public.txt", windows)).toBe(false);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/relative/path", windows)).toBe(true);

    const posix = { logPath: "/srv/studio/private/active.jsonl", root: "/srv/studio" } as const;
    expect(shouldDenyStudioSensitiveFileRequest("/@fs//srv/studio/private/active.jsonl", posix)).toBe(true);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/srv/studio/private/active.jsonl", posix)).toBe(true);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs//srv/studio/public.txt", posix)).toBe(false);

    const unc = {
      logPath: String.raw`\\server\share\private\active.jsonl`,
      root: "C:/Studio",
    } as const;
    expect(shouldDenyStudioSensitiveFileRequest("/@fs//server/share/private/active.jsonl", unc)).toBe(true);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs/%2Fserver/share/private/active.jsonl.previous?import", unc)).toBe(
      true,
    );
    expect(shouldDenyStudioSensitiveFileRequest("/@fs//SERVER/share/public.txt", unc)).toBe(false);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs///server/share/public.txt", unc)).toBe(true);
    expect(shouldDenyStudioSensitiveFileRequest("/@fs////server/share/public.txt", unc)).toBe(true);
  });

  it("ignores dotenv credentials and returns only public or explicitly allowed non-secret settings", () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-vite-env-"));
    roots.push(root);
    writeFileSync(
      join(root, ".env"),
      [
        "OPENAI_API_KEY=SECRET_DOTENV_OPENAI_KEY",
        "POIETRA_OPENAI_MODEL=SECRET_DOTENV_MODEL",
        "VITE_PUBLIC_SENTINEL=public-value",
      ].join("\n"),
      { mode: 0o600 },
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const env = loadStudioNonSecretEnvironment("development", root, {
      OPENAI_API_KEY: "SECRET_PROCESS_OPENAI_KEY",
      POIETRA_AI_LOCAL_KEY_FILE_OPT_IN: "1",
      POIETRA_OPENAI_MODEL: "gpt-process-model",
    });

    expect(env).toMatchObject({
      POIETRA_AI_LOCAL_KEY_FILE_OPT_IN: "1",
      POIETRA_OPENAI_MODEL: "gpt-process-model",
      VITE_PUBLIC_SENTINEL: "public-value",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(JSON.stringify(env)).not.toContain("SECRET_DOTENV_OPENAI_KEY");
    expect(JSON.stringify(env)).not.toContain("SECRET_PROCESS_OPENAI_KEY");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("SECRET_DOTENV_OPENAI_KEY");
    const config = createStudioViteConfig("development", root, {
      OPENAI_API_KEY: "SECRET_PROCESS_OPENAI_KEY",
      POIETRA_OPENAI_MODEL: "gpt-process-model",
    });
    expect(JSON.stringify(config)).not.toContain("SECRET_DOTENV_OPENAI_KEY");
    expect(JSON.stringify(config)).not.toContain("SECRET_PROCESS_OPENAI_KEY");
  });

  it("keeps all Vite defaults and denies legacy plus active log files through real Vite routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-vite-deny-"));
    roots.push(root);
    const legacyLog = join(root, ".studio-logs", "ai-edit-suggestions.jsonl");
    const activeLog = join(root, "custom-logs", "active.jsonl");
    mkdirSync(join(root, ".studio-logs"), { recursive: true });
    mkdirSync(join(root, "custom-logs"), { recursive: true });
    for (const path of [join(root, ".env"), join(root, ".openai-key"), legacyLog, activeLog, `${activeLog}.previous`]) {
      writeFileSync(path, "SECRET_VITE_FILE_SENTINEL", { mode: 0o600 });
    }
    const deny = createStudioViteFsDeny(activeLog);
    expect(deny).toEqual(expect.arrayContaining([...VITE_DEFAULT_FS_DENY]));
    const allowListSentinel = join(root, "SECRET_VITE_ALLOW_LIST");
    const viteOutput: string[] = [];
    const viteLogger = createLogger("info");
    vi.spyOn(viteLogger, "error").mockImplementation((message) => {
      viteOutput.push(String(message));
    });
    vi.spyOn(viteLogger, "info").mockImplementation((message) => {
      viteOutput.push(String(message));
    });
    vi.spyOn(viteLogger, "warn").mockImplementation((message) => {
      viteOutput.push(String(message));
    });
    vi.spyOn(viteLogger, "warnOnce").mockImplementation((message) => {
      viteOutput.push(String(message));
    });

    const server = await createServer({
      configFile: false,
      customLogger: viteLogger,
      plugins: [studioSensitiveFileBoundary({ logPath: activeLog, root })],
      root,
      server: {
        fs: { allow: [allowListSentinel], deny },
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    servers.push(server);
    await server.listen();
    expect((await request(server, "/.env")).status).not.toBe(200);
    viteOutput.length = 0;
    const routes = [
      "/.openai-key",
      "/nested/.openai-key",
      "/.openai-key?raw",
      "/.openai-key?import",
      "/%2Eopenai-key",
      "/%252Eopenai-key",
      "/.studio-logs/ai-edit-suggestions.jsonl",
      "/%2Estudio-logs/ai-edit-suggestions.jsonl?raw",
      "/custom-logs/active.jsonl",
      "/custom-logs/%61ctive.jsonl?raw",
      "/custom-logs/active.jsonl.previous?import",
      `/@fs/${normalizePath(activeLog)}?raw`,
      `/@fs/${normalizePath(`${activeLog}.previous`)}?import`,
      "/@fs///ambiguous/path",
      "/invalid/%E0%A4%A",
      "/invalid/%00path",
      "/safe/%2e%2e/ambiguous",
    ];

    for (const route of routes) {
      const response = await request(server, route);
      expect(response.status, route).toBe(404);
      expect(response.body, route).toBe('{"error":"Not found."}');
    }
    const persistedOutput = JSON.stringify(viteOutput);
    expect(persistedOutput).not.toContain(root);
    expect(persistedOutput).not.toContain(activeLog);
    expect(persistedOutput).not.toContain(allowListSentinel);
    expect(persistedOutput).not.toContain("SECRET_VITE_FILE_SENTINEL");
  });
});
