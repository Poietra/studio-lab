import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import {
  calculateGenericImportabilityCompletion,
  loadGenericImportabilityManifest,
} from "./generic-importability-manifest";

const root = join(import.meta.dirname, "..");
const manifestPath = join(root, "fixtures", "generic-importability", "manifest.json");

describe("generic Manim importability scoreboard", () => {
  it("keeps every stage explicit and derives the committed completion gates", async () => {
    const manifest = await loadGenericImportabilityManifest(manifestPath);

    expect(manifest.cases).toHaveLength(10);
    expect(calculateGenericImportabilityCompletion(manifest)).toEqual(manifest.completion);
    expect(manifest.cases.filter(({ sourcePath }) => sourcePath === "example_scenes/basic.py")).toHaveLength(7);
  });

  it("admits all seven official Scenes and pins measured roots to the full source identity", async () => {
    const manifest = await loadGenericImportabilityManifest(manifestPath);
    const official = manifest.cases.filter(({ sourcePath }) => sourcePath === "example_scenes/basic.py");
    const sourceText = await readFile(join(root, official[0]!.fixturePaths[0]!), "utf8");
    const expectedSourceHash = createHash("sha256").update(sourceText).digest("hex");

    for (const entry of official) {
      expect(
        studioSourceAnalysisProviderV1.analyze({
          expectedSourceHash,
          sceneName: entry.sceneName,
          sourcePath: entry.sourcePath,
          sourceText,
        }).scene.name,
      ).toBe(entry.sceneName);
      if (entry.rootCoverage.status === "unmeasured") continue;
      const fixture = JSON.parse(await readFile(join(root, entry.rootCoverage.fixturePath), "utf8")) as {
        evidence?: { sourceHash?: string; sourcePath?: string };
        sourceHash?: string;
        sourcePath?: string;
      };
      expect(fixture.evidence?.sourcePath ?? fixture.sourcePath).toBe(entry.sourcePath);
      expect(fixture.evidence?.sourceHash ?? fixture.sourceHash).toBe(expectedSourceHash);
    }
  });

  it("pins measured generic root counts and reruns every cited offline test in the gate command", async () => {
    const manifest = await loadGenericImportabilityManifest(manifestPath);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const gateCommand = packageJson.scripts["test:importer:quality"];
    expect(gateCommand).toBeTypeOf("string");

    for (const testFile of manifest.evidenceTests) {
      await expect(access(join(root, testFile))).resolves.toBeUndefined();
      expect(gateCommand).toContain(testFile);
    }

    for (const entry of manifest.cases) {
      for (const fixturePath of entry.fixturePaths) {
        await expect(access(join(root, fixturePath))).resolves.toBeUndefined();
      }
      if (entry.rootCoverage.status === "unmeasured") continue;
      const fixture = JSON.parse(await readFile(join(root, entry.rootCoverage.fixturePath), "utf8")) as {
        evidence?: {
          records?: readonly {
            bindings?: readonly unknown[];
            lifecycle?: readonly unknown[];
            status?: string;
          }[];
          sceneName?: string;
        };
        roots?: readonly unknown[];
        scene?: { className?: string };
        sceneName?: string;
      };
      const roots =
        fixture.roots ??
        fixture.evidence?.records?.filter(
          (record) =>
            record.status === "mapped" &&
            record.bindings?.length === 1 &&
            record.lifecycle !== undefined &&
            record.lifecycle.length > 0,
        );
      expect(fixture.scene?.className ?? fixture.sceneName ?? fixture.evidence?.sceneName).toBe(entry.sceneName);
      expect(roots).toHaveLength(entry.rootCoverage.expected);
    }
  });
});
