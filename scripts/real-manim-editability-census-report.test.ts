import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealManimCensusManifest } from "./real-manim-census-report";
import {
  assertRealManimEditabilityCensusCaseFloor,
  assertRealManimEditabilityCensusFloor,
  buildRealManimEditabilityCensusReport,
  REAL_MANIM_EDITABILITY_CAPABILITIES,
  REAL_MANIM_EDITABILITY_PRODUCER_DIGEST,
  type RealManimEditabilityCensusCaseId,
  type RealManimEditabilityCensusObservation,
} from "./real-manim-editability-census-report";

const openingCaseId = "fast-manim-basic/OpeningManim/runtime-trace-v2";
const updatersCaseId = "fast-manim-basic/UpdatersExample/runtime-trace-v1";
const fixtureDirectory = join(import.meta.dirname, "..", "fixtures");

async function loadInputs() {
  const [manifest, baselineBytes, playbackBaselineBytes] = await Promise.all([
    loadRealManimCensusManifest(join(fixtureDirectory, "real-manim-census-v1", "manifest.json")),
    readFile(join(fixtureDirectory, "real-manim-editability-census-v1", "baseline.json")),
    readFile(join(fixtureDirectory, "real-manim-census-v1", "baseline.json")),
  ]);
  const playbackBaseline = JSON.parse(playbackBaselineBytes.toString("utf8")) as {
    manifestDigest: string;
    producerDigest: string;
    summary: { corpora: { compatibility: { scenes: Record<string, number> } } };
  };
  return { baseline: JSON.parse(baselineBytes.toString("utf8")) as unknown, manifest, playbackBaseline };
}

function provenCase(caseId: RealManimEditabilityCensusCaseId): RealManimEditabilityCensusObservation[] {
  return REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability) => ({ capability, caseId, status: "proven" }));
}

function blockedTail(
  caseId: RealManimEditabilityCensusCaseId,
  provenCount: number,
): RealManimEditabilityCensusObservation[] {
  return REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability, index) =>
    index < provenCount
      ? { capability, caseId, status: "proven" }
      : { blocker: "source-edit-anchor-unavailable", capability, caseId, status: "blocked" },
  );
}

function baselineObservations(): RealManimEditabilityCensusObservation[] {
  return [...provenCase(openingCaseId), ...provenCase(updatersCaseId)];
}

describe("real Manim editability census report", () => {
  it("builds the pinned two-case baseline deterministically in capability dependency order", async () => {
    const { baseline, manifest, playbackBaseline } = await loadInputs();
    const observations = baselineObservations();
    const report = buildRealManimEditabilityCensusReport(
      manifest,
      REAL_MANIM_EDITABILITY_PRODUCER_DIGEST,
      observations.reverse(),
    );

    expect(report).toEqual(baseline);
    expect(report.manifestDigest).toBe(playbackBaseline.manifestDigest);
    expect(report.producerDigest).toBe(playbackBaseline.producerDigest);
    expect(playbackBaseline.summary.corpora.compatibility.scenes).toEqual({
      accepted: 7,
      fallback: 0,
      rejected: 0,
      total: 7,
    });
    expect(Object.keys(report.results)).toEqual([openingCaseId, updatersCaseId]);
    expect(report.capabilities).toEqual(REAL_MANIM_EDITABILITY_CAPABILITIES);
    expect(() => assertRealManimEditabilityCensusFloor(report, baseline)).not.toThrow();
  });

  it("fails closed on incomplete, duplicate, unpinned, and dependency-invalid evidence", async () => {
    const { manifest } = await loadInputs();
    const observations = baselineObservations();
    expect(() =>
      buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, observations.slice(1)),
    ).toThrow("Missing editability observations");
    expect(() =>
      buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, [
        ...observations,
        observations[0]!,
      ]),
    ).toThrow("Duplicate editability observation");
    expect(() => buildRealManimEditabilityCensusReport(manifest, "a".repeat(64), observations)).toThrow(
      "does not match the pinned playback census",
    );

    const dependencyInvalid = [...blockedTail(openingCaseId, 1), ...provenCase(updatersCaseId)];
    dependencyInvalid[2] = { capability: "edit", caseId: openingCaseId, status: "proven" };
    expect(() =>
      buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, dependencyInvalid),
    ).toThrow("earlier dependency is blocked");
  });

  it("rejects any regression below the fully proven capability floor", async () => {
    const { baseline, manifest } = await loadInputs();
    const current = buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, [
      ...provenCase(openingCaseId),
      ...provenCase(updatersCaseId),
    ]);
    expect(() => assertRealManimEditabilityCensusFloor(current, baseline)).not.toThrow();

    const regressedOpening = blockedTail(openingCaseId, 2);
    const regressedUpdaters = blockedTail(updatersCaseId, 2);
    const openingRegression = buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, [
      ...regressedOpening,
      ...provenCase(updatersCaseId),
    ]);
    expect(() => assertRealManimEditabilityCensusFloor(openingRegression, baseline)).toThrow(`${openingCaseId}/edit`);

    const updatersRegression = buildRealManimEditabilityCensusReport(manifest, REAL_MANIM_EDITABILITY_PRODUCER_DIGEST, [
      ...provenCase(openingCaseId),
      ...regressedUpdaters,
    ]);
    expect(() => assertRealManimEditabilityCensusFloor(updatersRegression, baseline)).toThrow(`${updatersCaseId}/edit`);

    expect(() => assertRealManimEditabilityCensusCaseFloor(openingCaseId, regressedOpening, baseline)).toThrow(
      `${openingCaseId}/edit`,
    );
    expect(() => assertRealManimEditabilityCensusCaseFloor(updatersCaseId, regressedUpdaters, baseline)).toThrow(
      `${updatersCaseId}/edit`,
    );
    expect(() =>
      assertRealManimEditabilityCensusCaseFloor(updatersCaseId, provenCase(updatersCaseId).slice(1), baseline),
    ).toThrow("Missing editability observations");
  });
});
