import { resolve } from "node:path";

import { loadEnv, normalizePath } from "vite";

const NON_SECRET_POIETRA_ENV_KEYS = [
  "POIETRA_AI_DEBUG_LOG",
  "POIETRA_BENCHMARK_BUILD",
  "POIETRA_FAST_MANIM_SNAPSHOT_COMMAND",
  "POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN",
  "POIETRA_MANIM_COMMAND",
  "POIETRA_MANIM_FRAME_HEIGHT",
  "POIETRA_MANIM_FRAME_WIDTH",
  "POIETRA_MANIM_PROJECT_ROOT",
  "POIETRA_MANIM_PROJECTS",
  "POIETRA_OPENAI_MODEL",
  "POIETRA_STUDIO_DATA_ROOT",
] as const;

// Vite 8.1.5 replaces, rather than extends, this list when server.fs.deny is
// configured. Keep its complete defaults before adding Studio-specific paths.
export const VITE_DEFAULT_FS_DENY = Object.freeze([
  ".env",
  ".env.*",
  "*.{crt,pem,key,p12,pfx,cer,der}",
  ".npmrc",
  ".yarnrc.yml",
  "**/.git/**",
]);

export function loadStudioNonSecretEnvironment(
  mode: string,
  root: string,
  processEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  const env: Record<string, string> = { ...loadEnv(mode, root, "VITE_") };
  for (const key of NON_SECRET_POIETRA_ENV_KEYS) {
    const value = processEnvironment[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function escapeDenyPath(path: string) {
  return normalizePath(resolve(path)).replace(/([*?[\]{}()!+@])/g, "\\$1");
}

export function createStudioViteFsDeny(logPath: false | string) {
  return [
    ...VITE_DEFAULT_FS_DENY,
    ".openai-key",
    "**/.studio-logs/**",
    ...(logPath === false ? [] : [escapeDenyPath(logPath), escapeDenyPath(`${logPath}.previous`)]),
  ];
}
