import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRealManimProjectCensusReport,
  loadRealManimProjectCensusManifest,
  type RealManimProjectCensusObservation,
} from "./real-manim-project-census";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "real-manim-census-v2");
const observations = [
  {
    codebaseId: "math-to-manim",
    execution: {
      artifactBytes: 89_953,
      artifactDigest: "45d48c46a6c296d7800b1057d5782072912d5f63e4fa1775be7b530dc7552a93",
      status: "passed",
    },
    runtimeTrace: { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] },
    snapshotProbe: { outcome: "fallback", reasons: ["unsupported:animation-evidence-incomplete"] },
    staticImport: { entityCount: 0, sceneRecognized: true, unknownCount: 0 },
  },
  {
    codebaseId: "manim-ml",
    execution: { reason: "external-dependencies-unpinned", status: "blocked" },
    runtimeTrace: { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] },
    snapshotProbe: { outcome: "fallback", reasons: ["unsupported:animation-evidence-incomplete"] },
    staticImport: { entityCount: 0, sceneRecognized: true, unknownCount: 0 },
  },
  {
    codebaseId: "manim-slides",
    execution: { reason: "plugin-runtime-not-installed", status: "blocked" },
    runtimeTrace: { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] },
    snapshotProbe: {
      outcome: "rejected",
      reasons: ["contract:identity-evidence-invalid", "failure:result-rejected"],
    },
    staticImport: { entityCount: 0, sceneRecognized: false, unknownCount: 0 },
  },
] as const satisfies readonly RealManimProjectCensusObservation[];

describe("real Manim project census", () => {
  it("rebuilds the measured baseline and derives the #509 target from its evidence", async () => {
    const manifest = await loadRealManimProjectCensusManifest(join(fixtureRoot, "manifest.json"));
    const baseline = JSON.parse(await readFile(join(fixtureRoot, "baseline.json"), "utf8"));
    const report = buildRealManimProjectCensusReport(manifest, observations);
    expect(report).toEqual(baseline);
    expect(report.targetSelection.selectedCodebaseId).toBe("math-to-manim");
    expect(report.results["manim-slides"].snapshotProbe.reasons).toEqual([
      "contract:identity-evidence-invalid",
      "failure:result-rejected",
    ]);

    const changed = structuredClone(observations) as RealManimProjectCensusObservation[];
    changed[0] = {
      ...changed[0]!,
      runtimeTrace: {
        artifactDigest: "45d48c46a6c296d7800b1057d5782072912d5f63e4fa1775be7b530dc7552a93",
        outcome: "accepted",
        reasons: [],
      },
    };
    const acceptedReport = buildRealManimProjectCensusReport(manifest, changed);
    expect(acceptedReport.targetSelection.selectedCodebaseId).toBe("math-to-manim");
    expect(acceptedReport.targetSelection.reasons).toContain("generic-runtime-trace-preview-accepted");
    expect(acceptedReport.targetSelection.reasons).not.toContain("generic-runtime-trace-gap-observed");
  });

  it("fails closed on manifest identity drift and incomplete observations", async () => {
    const manifest = await loadRealManimProjectCensusManifest(join(fixtureRoot, "manifest.json"));
    expect(() => buildRealManimProjectCensusReport(manifest, observations.slice(1))).toThrow(
      "Observations do not match the manifest",
    );
    const directory = await mkdtemp(join(tmpdir(), "poietra-project-census-"));
    try {
      const path = join(directory, "manifest.json");
      const drifted = structuredClone(manifest);
      drifted.codebases[0]!.revision = "0".repeat(40);
      await writeFile(path, JSON.stringify(drifted));
      await expect(loadRealManimProjectCensusManifest(path)).rejects.toThrow("manifest is invalid");
      const configDrifted = structuredClone(manifest);
      configDrifted.execution.pixelWidth += 1;
      await writeFile(path, JSON.stringify(configDrifted));
      await expect(loadRealManimProjectCensusManifest(path)).rejects.toThrow("manifest is invalid");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
