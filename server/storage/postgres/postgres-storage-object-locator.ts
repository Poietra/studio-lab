import {
  type StorageObjectLocatorV1,
  storageObjectLocatorColumnsV1,
  storageObjectLocatorV1,
} from "../storage-object-locator";

export type PostgresStorageObjectLocatorRowV1 = Readonly<{
  /** Legacy column spelling: `object_generation` stores the random immutable-object locator token (ADR 0005). */
  object_generation: string | null;
  version_id: string | null;
}>;

export function storageObjectLocatorFromRowV1(row: PostgresStorageObjectLocatorRowV1): StorageObjectLocatorV1 {
  if (row.version_id !== null && row.object_generation === null) {
    return storageObjectLocatorV1({ versionId: row.version_id });
  }
  if (row.version_id === null && row.object_generation !== null) {
    return storageObjectLocatorV1({ objectGeneration: row.object_generation });
  }
  throw new TypeError("PostgreSQL returned a non-exclusive storage object locator.");
}

export function storageObjectLocatorSqlValuesV1(locator: StorageObjectLocatorV1) {
  const values = storageObjectLocatorColumnsV1(locator);
  return [values.versionId, values.objectGeneration] as const;
}

function sqlIdentifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError("SQL identifier is invalid.");
  return value;
}

export function storageObjectLocatorSelectSqlV1(alias: string, prefix = "") {
  const table = sqlIdentifier(alias);
  const columnPrefix = sqlIdentifier(prefix || "locator");
  return `${table}.version_id AS ${columnPrefix}_version_id, ${table}.object_generation AS ${columnPrefix}_object_generation`;
}

export function storageObjectLocatorPredicateSqlV1(
  alias: string,
  versionParameter: number,
  generationParameter: number,
) {
  const table = sqlIdentifier(alias);
  if (
    !Number.isSafeInteger(versionParameter) ||
    versionParameter < 1 ||
    !Number.isSafeInteger(generationParameter) ||
    generationParameter < 1
  ) {
    throw new TypeError("SQL locator parameter is invalid.");
  }
  return `(${table}.version_id IS NOT DISTINCT FROM $${versionParameter} AND ${table}.object_generation IS NOT DISTINCT FROM $${generationParameter} AND ((${table}.version_id IS NULL) <> (${table}.object_generation IS NULL)))`;
}

export function storageObjectLocatorJoinSqlV1(leftAlias: string, rightAlias: string) {
  const left = sqlIdentifier(leftAlias);
  const right = sqlIdentifier(rightAlias);
  return `(${left}.version_id IS NOT DISTINCT FROM ${right}.version_id AND ${left}.object_generation IS NOT DISTINCT FROM ${right}.object_generation AND ((${left}.version_id IS NULL) <> (${left}.object_generation IS NULL)) AND ((${right}.version_id IS NULL) <> (${right}.object_generation IS NULL)))`;
}
