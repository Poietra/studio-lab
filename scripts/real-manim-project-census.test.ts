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
      artifactBytes: 89_930,
      artifactDigest: "b786567c23f235befbbb386ae81ea57eb7793ec5910ef8ed5d3c5e67b9e3c25a",
      status: "passed",
    },
    runtimeTrace: {
      artifactDigest: "99c2455bcd2658378ba10171b257a977c731811a60f64f092b110cbe1dca78fe",
      outcome: "accepted",
      reasons: [],
    },
    snapshotProbe: { outcome: "fallback", reasons: ["unsupported:animation-evidence-incomplete"] },
    staticImport: { entityCount: 0, sceneRecognized: true, unknownCount: 0 },
  },
  {
    codebaseId: "manim-ml",
    execution: { reason: "external-dependencies-unpinned", status: "blocked" },
    runtimeTrace: { outcome: "rejected", reasons: ["failure:producer-exit"] },
    snapshotProbe: { outcome: "fallback", reasons: ["unsupported:animation-evidence-incomplete"] },
    staticImport: { entityCount: 0, sceneRecognized: true, unknownCount: 0 },
  },
  {
    codebaseId: "manim-slides",
    execution: { reason: "plugin-runtime-not-installed", status: "blocked" },
    runtimeTrace: { outcome: "rejected", reasons: ["failure:producer-exit"] },
    snapshotProbe: { outcome: "fallback", reasons: ["unsupported:animation-evidence-incomplete"] },
    staticImport: { entityCount: 0, sceneRecognized: false, unknownCount: 0 },
  },
] as const satisfies readonly RealManimProjectCensusObservation[];

describe("real Manim project census", () => {
  it("rebuilds the measured baseline and reports when no generic Runtime Trace gap remains", async () => {
    const manifest = await loadRealManimProjectCensusManifest(join(fixtureRoot, "manifest.json"));
    const baseline = JSON.parse(await readFile(join(fixtureRoot, "baseline.json"), "utf8"));
    const report = buildRealManimProjectCensusReport(manifest, observations);
    expect(report).toEqual(baseline);
    expect(report.targetSelection.selectedCodebaseId).toBeNull();
    expect(report.targetSelection.reasons).toEqual(["generic-runtime-trace-gap-not-observed"]);
    expect(report.results["manim-slides"].snapshotProbe.reasons).toEqual(["unsupported:animation-evidence-incomplete"]);

    const withGap = structuredClone(observations) as RealManimProjectCensusObservation[];
    withGap[0] = {
      ...withGap[0]!,
      runtimeTrace: { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] },
    };
    const selected = buildRealManimProjectCensusReport(manifest, withGap);
    expect(selected.targetSelection.candidates).toEqual(
      report.targetSelection.candidates.map((candidate) =>
        candidate.codebaseId === "math-to-manim" ? { ...candidate, runtimeTraceOutcome: "fallback" } : candidate,
      ),
    );
    expect(selected.targetSelection.selectedCodebaseId).toBe("math-to-manim");
    expect(selected.targetSelection.reasons).toEqual([
      "bounded-source-execution-passed",
      "generic-runtime-trace-gap-observed",
      "safe-snapshot-fallback",
      "source-scene-recognized",
      "producer-compatible-dependencies",
    ]);

    const unsafeGap = structuredClone(observations) as RealManimProjectCensusObservation[];
    unsafeGap[1] = {
      ...unsafeGap[1]!,
      runtimeTrace: { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] },
    };
    const notSelected = buildRealManimProjectCensusReport(manifest, unsafeGap);
    expect(notSelected.targetSelection.selectedCodebaseId).toBeNull();
    expect(notSelected.targetSelection.reasons).toEqual(["safe-generic-runtime-trace-target-not-observed"]);
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
