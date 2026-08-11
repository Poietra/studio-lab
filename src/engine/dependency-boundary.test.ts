import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ENGINE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const STUDIO_IMPORT = /(?:from\s+|import\s*(?:\(\s*)?)["'](?:\.\.\/)+studio(?:\/|["'])/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

describe("engine dependency boundary", () => {
  it("does not depend on the Studio application model", () => {
    const violations = sourceFiles(ENGINE_ROOT).flatMap((path) => {
      return STUDIO_IMPORT.test(readFileSync(path, "utf8")) ? [path.slice(ENGINE_ROOT.length)] : [];
    });

    expect(violations).toEqual([]);
  });
});
