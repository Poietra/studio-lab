import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, normalizePath, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudioViteConfig } from "../vite.config";
import { createStudioViteFsDeny, loadStudioNonSecretEnvironment, VITE_DEFAULT_FS_DENY } from "./vite-privacy-boundary";

const servers: ViteDevServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("Vite privacy boundary", () => {
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
      POIETRA_OPENAI_MODEL: "gpt-process-model",
    });

    expect(env).toMatchObject({
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

    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root,
      server: {
        fs: { deny },
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const routes = [
      "/.env",
      "/.openai-key",
      "/.openai-key?raw",
      "/.openai-key?import",
      "/%2Eopenai-key",
      "/.studio-logs/ai-edit-suggestions.jsonl",
      "/%2Estudio-logs/ai-edit-suggestions.jsonl?raw",
      "/custom-logs/active.jsonl",
      "/custom-logs/%61ctive.jsonl?raw",
      "/custom-logs/active.jsonl.previous?import",
      `/@fs/${normalizePath(activeLog)}?raw`,
      `/@fs/${normalizePath(`${activeLog}.previous`)}?import`,
    ];

    for (const route of routes) {
      const response = await fetch(`${origin}${route}`);
      const body = await response.text();
      expect(response.status, route).not.toBe(200);
      expect(body, route).not.toContain("SECRET_VITE_FILE_SENTINEL");
    }
  });
});
