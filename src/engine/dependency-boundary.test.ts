import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ENGINE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const STUDIO_ROOT = fileURLToPath(new URL("../studio/", import.meta.url));
const MODULE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return MODULE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function resolvesInsideStudio(importer: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const fromStudio = relative(STUDIO_ROOT, resolve(dirname(importer), specifier));
  return fromStudio === "" || (fromStudio !== ".." && !fromStudio.startsWith(`..${sep}`));
}

describe("engine dependency boundary", () => {
  it("does not depend on the Studio application model", () => {
    const violations = sourceFiles(ENGINE_ROOT).flatMap((path) => {
      return [...readFileSync(path, "utf8").matchAll(IMPORT_SPECIFIER)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier && resolvesInsideStudio(path, specifier)))
        .map((specifier) => `${path.slice(ENGINE_ROOT.length)} -> ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
