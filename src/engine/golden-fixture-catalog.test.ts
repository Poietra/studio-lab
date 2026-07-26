import { describe, expect, it } from "vitest";
import {
  ENGINE_GOLDEN_FIXTURE_CATALOG,
  ENGINE_GOLDEN_FIXTURE_IDS,
  expandEngineGoldenSampleTimes,
  REQUIRED_ENGINE_GOLDEN_FEATURES,
  REQUIRED_ENGINE_GOLDEN_NEGATIVE_CASES,
  REQUIRED_ENGINE_GOLDEN_WORKLOAD_CATEGORIES,
  engineGoldenFixtureCatalogSchema,
  engineGoldenFixtureSchema,
} from "./golden-fixture-catalog";

describe("engine golden fixture catalog", () => {
  it("contains the 15 stable IDs exactly once and in contract order", () => {
    const ids = ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures.map(({ id }) => id);
    expect(ids).toEqual(ENGINE_GOLDEN_FIXTURE_IDS);
    expect(new Set(ids)).toHaveLength(15);
  });

  it("covers every required feature, workload, and negative case", () => {
    const fixtures = ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures;
    expect(new Set(fixtures.flatMap(({ features }) => features))).toEqual(new Set(REQUIRED_ENGINE_GOLDEN_FEATURES));
    expect(new Set(fixtures.flatMap(({ workloadCategories }) => workloadCategories))).toEqual(
      new Set(REQUIRED_ENGINE_GOLDEN_WORKLOAD_CATEGORIES),
    );
    expect(new Set(fixtures.flatMap(({ negativeCases }) => negativeCases.map(({ code }) => code)))).toEqual(
      new Set(REQUIRED_ENGINE_GOLDEN_NEGATIVE_CASES),
    );
    expect(fixtures.every(({ negativeCases }) => negativeCases.length > 0)).toBe(true);
  });

  it("keeps samples ordered, bounded, and aligned with expected checkpoints", () => {
    for (const fixture of ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures) {
      const samples = expandEngineGoldenSampleTimes(fixture.samplePlan);
      expect(samples).toEqual([...samples].sort((left, right) => left - right));
      expect(new Set(samples)).toHaveLength(samples.length);
      expect(samples[0]).toBeGreaterThanOrEqual(0);
      expect(samples.at(-1)).toBeLessThanOrEqual(fixture.durationSeconds);
      for (const checkpoint of fixture.expectations.checkpoints) {
        expect(samples.some((sample) => Math.abs(sample - checkpoint.at) <= Number.EPSILON * 8)).toBe(true);
      }
    }

    const stress = ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures.find(({ id }) => id === "eng-v1-015-stress-scrub-mixed")!;
    expect(expandEngineGoldenSampleTimes(stress.samplePlan)).toHaveLength(301);
  });

  it("uses fast-manim only as a secondary compatibility reference", () => {
    for (const fixture of ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures) {
      expect(fixture.references.some(({ role }) => role === "primary")).toBe(true);
      expect(
        fixture.references
          .filter(({ category }) => category === "fast-manim")
          .every(({ role }) => role === "secondary"),
      ).toBe(true);
    }

    const fixture = structuredClone(ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures[0]);
    fixture.references[1].role = "primary";
    expect(engineGoldenFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("pins the canonical circle and topology-aligned morph to four cubics", () => {
    const byId = new Map(ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures.map((fixture) => [fixture.id, fixture]));
    expect(byId.get("eng-v1-003-shape-primitives")?.expectations.canonicalSegmentCounts).toContainEqual({
      segments: 4,
      target: "circle",
    });
    expect(byId.get("eng-v1-011-path-morph")?.expectations.canonicalSegmentCounts).toEqual([
      { segments: 4, target: "morph-source" },
      { segments: 4, target: "morph-target" },
    ]);
  });

  it("rejects unknown fields, duplicate IDs, and coverage gaps", () => {
    expect(
      engineGoldenFixtureSchema.safeParse({
        ...structuredClone(ENGINE_GOLDEN_FIXTURE_CATALOG.fixtures[0]),
        accidentalField: true,
      }).success,
    ).toBe(false);

    const duplicate = structuredClone(ENGINE_GOLDEN_FIXTURE_CATALOG);
    duplicate.fixtures[1].id = duplicate.fixtures[0].id;
    expect(engineGoldenFixtureCatalogSchema.safeParse(duplicate).success).toBe(false);

    const missingFeature = structuredClone(ENGINE_GOLDEN_FIXTURE_CATALOG);
    for (const fixture of missingFeature.fixtures) {
      fixture.features = fixture.features.filter((feature) => feature !== "camera-relative-precision");
    }
    expect(engineGoldenFixtureCatalogSchema.safeParse(missingFeature).success).toBe(false);
  });
});
