import { posix, resolve, win32 } from "node:path";

import { loadEnv, normalizePath, type Plugin } from "vite";

const NON_SECRET_POIETRA_ENV_KEYS = [
  "POIETRA_AI_DEBUG_LOG",
  "POIETRA_AI_LOCAL_KEY_FILE_OPT_IN",
  "POIETRA_BENCHMARK_BUILD",
  "POIETRA_FAST_MANIM_SNAPSHOT_COMMAND",
  "POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN",
  "POIETRA_FAST_MANIM_SNAPSHOT_VERSION",
  "POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND",
  "POIETRA_FAST_MANIM_RUNTIME_TRACE_DEV_OPT_IN",
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

function decodeRequestPath(rawPath: string) {
  let decoded = rawPath;
  for (let pass = 0; pass < 3 && decoded.includes("%"); pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  if (decoded.includes("%") || decoded.includes("\0") || decoded.includes("\\")) return null;
  return decoded;
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/;

function normalizedAbsolutePath(path: string) {
  if (WINDOWS_UNC_ABSOLUTE.test(path)) return win32.resolve(path).replaceAll("\\", "/").toLowerCase();
  if (WINDOWS_DRIVE_ABSOLUTE.test(path)) return win32.resolve(path).replaceAll("\\", "/").toLowerCase();
  if (path.startsWith("/")) return posix.resolve(path).toLowerCase();
  return null;
}

function normalizedConfiguredPath(path: string, root: string) {
  const absolute = normalizedAbsolutePath(path);
  if (absolute) return absolute;
  if (WINDOWS_DRIVE_ABSOLUTE.test(root)) {
    return win32.resolve(root, path).replaceAll("\\", "/").toLowerCase();
  }
  return normalizePath(resolve(root, path)).toLowerCase();
}

function normalizedRequestFile(rawUrl: string, root: string) {
  const rawPath = rawUrl.split(/[?#]/, 1)[0] ?? "";
  const decodedPath = decodeRequestPath(rawPath);
  if (!decodedPath?.startsWith("/")) return null;
  const segments = decodedPath.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return null;
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.includes(".openai-key") || lowerSegments.includes(".studio-logs")) return "sensitive" as const;

  if (decodedPath.startsWith("/@fs/")) {
    if (decodedPath.startsWith("/@fs///")) return null;
    const fsPath = decodedPath.slice("/@fs/".length);
    if (decodedPath.startsWith("/@fs//")) {
      const posixPath = normalizedAbsolutePath(fsPath);
      const uncPath = normalizedAbsolutePath(`/${fsPath}`);
      return posixPath && uncPath ? [posixPath, uncPath] : null;
    }
    const absolutePath = normalizedAbsolutePath(fsPath);
    return absolutePath ? [absolutePath] : null;
  }
  if (WINDOWS_DRIVE_ABSOLUTE.test(root)) {
    return [win32.resolve(root, decodedPath.slice(1)).replaceAll("\\", "/").toLowerCase()];
  }
  return [normalizePath(resolve(root, `.${decodedPath}`)).toLowerCase()];
}

type StudioSensitiveFileBoundaryOptions = Readonly<{ logPath: false | string; root: string }>;

export function shouldDenyStudioSensitiveFileRequest(rawUrl: string, options: StudioSensitiveFileBoundaryOptions) {
  const configuredLogs = new Set(
    options.logPath === false
      ? []
      : [
          normalizedConfiguredPath(options.logPath, options.root),
          normalizedConfiguredPath(`${options.logPath}.previous`, options.root),
        ],
  );
  const target = normalizedRequestFile(rawUrl, options.root);
  return target === null || target === "sensitive" || target.some((path) => configuredLogs.has(path));
}

export function studioSensitiveFileBoundary(options: StudioSensitiveFileBoundaryOptions): Plugin {
  return {
    apply: "serve",
    enforce: "pre",
    name: "poietra-sensitive-file-boundary",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url && !shouldDenyStudioSensitiveFileRequest(request.url, options)) {
          next();
          return;
        }
        request.resume();
        response.statusCode = 404;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("x-content-type-options", "nosniff");
        response.end('{"error":"Not found."}');
      });
    },
  };
}
