import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRealManimCensusFloor,
  buildRealManimCensusReport,
  loadRealManimCensusManifest,
  type RealManimCensusAttempt,
  type RealManimCensusManifest,
  type RealManimCensusOutcome,
  realManimCensusCaseId,
} from "./real-manim-census-report";

const digest = "a".repeat(64);
const snapshotHash = "b".repeat(64);
const gammaFeatures = ["mobject-updater", "value-tracker"] as const;
function manifest(): RealManimCensusManifest {
  return {
    assets: [],
    producer: {
      digest,
      digestAlgorithm: "sha256(repository-nul-revision-nul-tree)",
      licenses: [{ path: "LICENSE", spdx: "MIT" }],
      module: "manim.renderer.source_runtime_identity",
      repository: "https://github.com/Poietra/fast-manim.git",
      revision: "c".repeat(40),
      tree: "d".repeat(40),
    },
    schema: "poietra.real-manim-census-manifest",
    sources: [
      {
        corpus: "calibration",
        id: "cal-a",
        path: "fixtures/a.py",
        repository: "studio-lab",
        scenes: [{ features: ["create"], name: "Alpha", profiles: [1, 2] }],
        sha256: "e".repeat(64),
      },
      {
        corpus: "calibration",
        id: "cal-b",
        path: "fixtures/b.py",
        repository: "studio-lab",
        scenes: [{ features: ["style"], name: "Beta", profiles: [1, 2] }],
        sha256: "f".repeat(64),
      },
      {
        corpus: "compatibility",
        id: "compat-a",
        path: "example_scenes/basic.py",
        repository: "fast-manim",
        scenes: [{ features: [...gammaFeatures], name: "Gamma", profiles: [1, 2] }],
        sha256: "1".repeat(64),
      },
    ],
    version: 1,
  };
}

const cases = {
  alpha: { corpus: "calibration", features: ["create"], sceneName: "Alpha", sourceId: "cal-a" },
  beta: { corpus: "calibration", features: ["style"], sceneName: "Beta", sourceId: "cal-b" },
  gamma: { corpus: "compatibility", features: gammaFeatures, sceneName: "Gamma", sourceId: "compat-a" },
} as const;

function attempt(selected: (typeof cases)[keyof typeof cases], profile: 1 | 2, outcome: RealManimCensusOutcome) {
  const common = {
    caseId: realManimCensusCaseId(selected.sourceId, selected.sceneName, profile),
    corpus: selected.corpus,
    features: selected.features,
    profile,
    sceneName: selected.sceneName,
  } as const;
  if (outcome === "accepted") return { ...common, outcome, reasons: [], snapshotHash };
  if (outcome === "fallback") {
    return { ...common, outcome, reasons: ["unsupported:runtime-semantics-unsupported"] };
  }
  return { ...common, outcome, reasons: ["contract:result-malformed", "failure:result-rejected"] };
}

type Outcomes = Readonly<Record<`${keyof typeof cases}${1 | 2}`, RealManimCensusOutcome>>;
function attempts(outcomes: Outcomes): RealManimCensusAttempt[] {
  return (Object.keys(cases) as Array<keyof typeof cases>).flatMap((name) => [
    attempt(cases[name], 1, outcomes[`${name}1`]),
    attempt(cases[name], 2, outcomes[`${name}2`]),
  ]);
}
const baselineOutcomes = {
  alpha1: "accepted",
  alpha2: "accepted",
  beta1: "fallback",
  beta2: "accepted",
  gamma1: "accepted",
  gamma2: "fallback",
} as const;

describe("real Manim census report", () => {
  it("loads only an exact pinned manifest with known feature tags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poietra-census-"));
    try {
      const path = join(directory, "manifest.json");
      await writeFile(path, JSON.stringify(manifest()));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(manifest());
      const invalid = structuredClone(manifest());
      invalid.sources[0]!.scenes[0]!.features = ["guessed-feature" as "create"];
      await writeFile(path, JSON.stringify(invalid));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const unpinnedV8 = structuredClone(manifest());
      unpinnedV8.sources[2]!.scenes[0]!.profiles = [1, 2, 8];
      await writeFile(path, JSON.stringify(unpinnedV8));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const officialV8 = structuredClone(manifest());
      const officialSource = officialV8.sources[2]!;
      officialSource.id = "fast-manim-basic";
      officialSource.sha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
      officialSource.scenes[0]!.name = "SquareToCircle";
      officialSource.scenes[0]!.profiles = [1, 2, 3, 4, 5, 6, 7, 8];
      await writeFile(path, JSON.stringify(officialV8));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(officialV8);

      const unpinnedV9 = structuredClone(manifest());
      unpinnedV9.sources[2]!.scenes[0]!.profiles = [1, 2, 9];
      await writeFile(path, JSON.stringify(unpinnedV9));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const officialV9 = structuredClone(manifest());
      const officialWarpSource = officialV9.sources[2]!;
      officialWarpSource.id = "fast-manim-basic";
      officialWarpSource.sha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
      officialWarpSource.scenes[0]!.name = "WarpSquare";
      officialWarpSource.scenes[0]!.profiles = [1, 2, 3, 4, 5, 6, 7, 9];
      await writeFile(path, JSON.stringify(officialV9));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(officialV9);

      const unpinnedV10 = structuredClone(manifest());
      unpinnedV10.sources[2]!.scenes[0]!.profiles = [1, 2, 10];
      await writeFile(path, JSON.stringify(unpinnedV10));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const officialV10 = structuredClone(manifest());
      const officialLineJointsSource = officialV10.sources[2]!;
      officialLineJointsSource.id = "fast-manim-basic";
      officialLineJointsSource.sha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
      officialLineJointsSource.scenes[0]!.name = "LineJoints";
      officialLineJointsSource.scenes[0]!.profiles = [1, 2, 3, 4, 5, 6, 7, 10];
      await writeFile(path, JSON.stringify(officialV10));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(officialV10);

      const unpinnedV11 = structuredClone(manifest());
      unpinnedV11.sources[2]!.scenes[0]!.profiles = [1, 2, 11];
      await writeFile(path, JSON.stringify(unpinnedV11));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const officialV11 = structuredClone(manifest());
      const officialSpiralInSource = officialV11.sources[2]!;
      officialSpiralInSource.id = "fast-manim-basic";
      officialSpiralInSource.sha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
      officialSpiralInSource.scenes[0]!.name = "SpiralInExample";
      officialSpiralInSource.scenes[0]!.profiles = [1, 2, 3, 4, 5, 6, 7, 11];
      await writeFile(path, JSON.stringify(officialV11));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(officialV11);

      const unpinnedV12 = structuredClone(manifest());
      unpinnedV12.sources[2]!.scenes[0]!.profiles = [1, 2, 12];
      await writeFile(path, JSON.stringify(unpinnedV12));
      await expect(loadRealManimCensusManifest(path)).rejects.toThrow("manifest is invalid");

      const officialV12 = structuredClone(manifest());
      const officialWriteStuffSource = officialV12.sources[2]!;
      officialWriteStuffSource.id = "fast-manim-basic";
      officialWriteStuffSource.sha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
      officialWriteStuffSource.scenes[0]!.name = "WriteStuff";
      officialWriteStuffSource.scenes[0]!.profiles = [1, 2, 3, 4, 5, 6, 7, 12];
      await writeFile(path, JSON.stringify(officialV12));
      await expect(loadRealManimCensusManifest(path)).resolves.toEqual(officialV12);

      const pinned = await loadRealManimCensusManifest(
        join(import.meta.dirname, "..", "fixtures", "real-manim-census-v1", "manifest.json"),
      );
      expect(
        pinned.sources.flatMap((source) =>
          source.scenes
            .filter((scene) => scene.profiles.includes(8))
            .map((scene) => ({
              corpus: source.corpus,
              id: source.id,
              name: scene.name,
              path: source.path,
              repository: source.repository,
              sha256: source.sha256,
            })),
        ),
      ).toEqual([
        {
          corpus: "compatibility",
          id: "fast-manim-basic",
          name: "SquareToCircle",
          path: "example_scenes/basic.py",
          repository: "fast-manim",
          sha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        },
      ]);
      expect(
        pinned.sources.flatMap((source) =>
          source.scenes
            .filter((scene) => scene.profiles.includes(12))
            .map((scene) => ({
              corpus: source.corpus,
              id: source.id,
              name: scene.name,
              path: source.path,
              repository: source.repository,
              sha256: source.sha256,
            })),
        ),
      ).toEqual([
        {
          corpus: "compatibility",
          id: "fast-manim-basic",
          name: "WriteStuff",
          path: "example_scenes/basic.py",
          repository: "fast-manim",
          sha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        },
      ]);
      expect(
        pinned.sources.flatMap((source) =>
          source.scenes
            .filter((scene) => scene.profiles.includes(11))
            .map((scene) => ({
              corpus: source.corpus,
              id: source.id,
              name: scene.name,
              path: source.path,
              repository: source.repository,
              sha256: source.sha256,
            })),
        ),
      ).toEqual([
        {
          corpus: "compatibility",
          id: "fast-manim-basic",
          name: "SpiralInExample",
          path: "example_scenes/basic.py",
          repository: "fast-manim",
          sha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        },
      ]);
      expect(
        pinned.sources.flatMap((source) =>
          source.scenes
            .filter((scene) => scene.profiles.includes(10))
            .map((scene) => ({
              corpus: source.corpus,
              id: source.id,
              name: scene.name,
              path: source.path,
              repository: source.repository,
              sha256: source.sha256,
            })),
        ),
      ).toEqual([
        {
          corpus: "compatibility",
          id: "fast-manim-basic",
          name: "LineJoints",
          path: "example_scenes/basic.py",
          repository: "fast-manim",
          sha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        },
      ]);
      expect(
        pinned.sources.flatMap((source) =>
          source.scenes
            .filter((scene) => scene.profiles.includes(9))
            .map((scene) => ({
              corpus: source.corpus,
              id: source.id,
              name: scene.name,
              path: source.path,
              repository: source.repository,
              sha256: source.sha256,
            })),
        ),
      ).toEqual([
        {
          corpus: "compatibility",
          id: "fast-manim-basic",
          name: "WarpSquare",
          path: "example_scenes/basic.py",
          repository: "fast-manim",
          sha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("builds deterministic attempt, scene, and reason summaries", () => {
    const input = attempts({
      alpha1: "fallback",
      alpha2: "accepted",
      beta1: "fallback",
      beta2: "fallback",
      gamma1: "fallback",
      gamma2: "rejected",
    });
    const report = buildRealManimCensusReport(manifest(), digest, input.reverse());
    expect(buildRealManimCensusReport(manifest(), digest, input.reverse())).toEqual(report);
    expect(report.summary).toEqual({
      attempts: { accepted: 1, fallback: 4, rejected: 1, total: 6 },
      corpora: {
        calibration: {
          attempts: { accepted: 1, fallback: 3, rejected: 0, total: 4 },
          scenes: { accepted: 1, fallback: 1, rejected: 0, total: 2 },
        },
        compatibility: {
          attempts: { accepted: 0, fallback: 1, rejected: 1, total: 2 },
          scenes: { accepted: 0, fallback: 0, rejected: 1, total: 1 },
        },
      },
      scenes: { accepted: 1, fallback: 1, rejected: 1, total: 3 },
    });
    expect(Object.values(report.scenes)).toEqual(["accepted", "fallback", "rejected"]);
    expect(Object.keys(report.reasonCounts)).toEqual([
      "contract:result-malformed",
      "failure:result-rejected",
      "unsupported:runtime-semantics-unsupported",
    ]);
  });

  it("fails closed on missing, duplicate, mismatched, unknown, or unpinned attempts", () => {
    const complete = attempts(baselineOutcomes);
    expect(() => buildRealManimCensusReport(manifest(), digest, complete.slice(1))).toThrow("Missing census attempts");
    expect(() => buildRealManimCensusReport(manifest(), digest, [...complete, complete[0]!])).toThrow("Duplicate");
    expect(() =>
      buildRealManimCensusReport(manifest(), digest, [{ ...complete[0]!, profile: 2 }, ...complete.slice(1)]),
    ).toThrow("does not match");
    expect(() =>
      buildRealManimCensusReport(manifest(), digest, [
        { ...complete[0]!, reasons: ["failure:invented"], snapshotHash: undefined } as RealManimCensusAttempt,
        ...complete.slice(1),
      ]),
    ).toThrow("Unknown census reason");
    expect(() => buildRealManimCensusReport(manifest(), "0".repeat(64), complete)).toThrow("Producer digest");
  });

  it("enforces scene, attempt, accepted-case, and compatibility rejection floors", () => {
    const baseline = buildRealManimCensusReport(manifest(), digest, attempts(baselineOutcomes));
    const check = (changes: Partial<Outcomes>, message: string) => {
      const report = buildRealManimCensusReport(manifest(), digest, attempts({ ...baselineOutcomes, ...changes }));
      expect(() => assertRealManimCensusFloor(report, baseline)).toThrow(message);
    };
    check({ alpha1: "fallback", alpha2: "fallback", beta1: "accepted" }, "Accepted scene count");
    check({ alpha2: "fallback" }, "Accepted attempt count");
    check({ alpha2: "fallback", beta1: "accepted" }, "Previously accepted census case");
    const changedSnapshot = structuredClone(baseline);
    changedSnapshot.results["cal-a/Alpha/v1"]!.snapshotHash = "9".repeat(64);
    expect(() => assertRealManimCensusFloor(changedSnapshot, baseline)).toThrow("snapshot changed");
    changedSnapshot.producerDigest = "8".repeat(64);
    changedSnapshot.manifestDigest = "7".repeat(64);
    expect(() => assertRealManimCensusFloor(changedSnapshot, baseline)).not.toThrow();
    changedSnapshot.corpusDigest = "6".repeat(64);
    expect(() => assertRealManimCensusFloor(changedSnapshot, baseline)).toThrow("different corpora");
    expect(() => assertRealManimCensusFloor(baseline, baseline)).not.toThrow();

    const rejectedBaselineOutcomes = { ...baselineOutcomes, alpha2: "fallback", beta1: "rejected" } as const;
    const rejectedBaseline = buildRealManimCensusReport(manifest(), digest, attempts(rejectedBaselineOutcomes));
    const rejectedCheck = (changes: Partial<Outcomes>, message: string) => {
      const current = attempts({ ...rejectedBaselineOutcomes, ...changes });
      const report = buildRealManimCensusReport(manifest(), digest, current);
      expect(() => assertRealManimCensusFloor(report, rejectedBaseline)).toThrow(message);
    };
    rejectedCheck({ alpha2: "rejected" }, "Rejected attempt count");
    rejectedCheck({ beta1: "fallback", gamma2: "rejected" }, "compatibility-corpus rejections");
    rejectedCheck({ alpha2: "rejected", beta1: "fallback" }, "safe fallback census case");

    const missingCase = structuredClone(baseline);
    delete missingCase.results["cal-a/Alpha/v1"];
    expect(() => assertRealManimCensusFloor(baseline, missingCase)).toThrow("differ from the baseline");
  });
});
