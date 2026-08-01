import { describe, expect, it } from "vitest";

import {
  storageObjectLocatorFromRowV1,
  storageObjectLocatorJoinSqlV1,
  storageObjectLocatorPredicateSqlV1,
  storageObjectLocatorSqlValuesV1,
} from "./postgres-storage-object-locator";

const GENERATION = "123e4567-e89b-42d3-a456-426614174000";

describe("PostgreSQL storage object locator helpers", () => {
  it("round-trips exactly one provider version or application generation", () => {
    expect(storageObjectLocatorFromRowV1({ object_generation: null, version_id: "version-a" })).toEqual({
      versionId: "version-a",
    });
    expect(storageObjectLocatorFromRowV1({ object_generation: GENERATION, version_id: null })).toEqual({
      objectGeneration: GENERATION,
    });
    expect(storageObjectLocatorSqlValuesV1({ versionId: "version-a" })).toEqual(["version-a", null]);
    expect(storageObjectLocatorSqlValuesV1({ objectGeneration: GENERATION })).toEqual([null, GENERATION]);
  });

  it("fails closed for missing or ambiguous database locators", () => {
    expect(() => storageObjectLocatorFromRowV1({ object_generation: null, version_id: null })).toThrow("non-exclusive");
    expect(() => storageObjectLocatorFromRowV1({ object_generation: GENERATION, version_id: "version-a" })).toThrow(
      "non-exclusive",
    );
  });

  it("emits null-safe exact predicates and joins with row-level XOR guards", () => {
    const predicate = storageObjectLocatorPredicateSqlV1("object", 3, 4);
    const join = storageObjectLocatorJoinSqlV1("object", "generation");
    expect(predicate).toContain("object.version_id IS NOT DISTINCT FROM $3");
    expect(predicate).toContain("object.object_generation IS NOT DISTINCT FROM $4");
    expect(predicate).toContain("<> (object.object_generation IS NULL)");
    expect(join).toContain("object.version_id IS NOT DISTINCT FROM generation.version_id");
    expect(join).toContain("generation.object_generation IS NULL");
  });
});
