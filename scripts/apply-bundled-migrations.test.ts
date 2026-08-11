import { describe, expect, it, vi } from "vitest";

import {
  BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1,
  BUNDLED_DURABLE_STORAGE_MIGRATION_VERSIONS_V1,
} from "../server/storage/postgres/migrate";
import {
  applyBundledMigrationsV1,
  parseBundledMigrationApplyArgumentsV1,
  readRecordedMigrationVersionsV1,
} from "./apply-bundled-migrations.mjs";

const BUNDLED = BUNDLED_DURABLE_STORAGE_MIGRATION_VERSIONS_V1;
const HEAD = BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1;

function dependencies(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    applyThrough: vi.fn(async (version: number) => ({ applied: true, version })),
    bundledVersions: vi.fn(() => BUNDLED),
    migrationHead: vi.fn(() => HEAD),
    recordedVersions: vi.fn(async () => [...BUNDLED]),
    ...overrides,
  };
}

/**
 * A database that has recorded nothing yet, then everything through the target.
 * A never-migrated database has no ledger table at all, which the reader reports
 * as an empty inventory rather than an error — see the reader test below.
 */
function freshThen(target: number) {
  const recorded = vi.fn(async () => (recorded.mock.calls.length > 1 ? BUNDLED.filter((v) => v <= target) : []));
  return recorded;
}

/** A pg Pool stub that answers the reader's to_regclass probe and its select. */
function poolStub(relation: string | null, versions: readonly number[] = []) {
  const query = vi.fn(async (text: string) =>
    text.includes("to_regclass")
      ? { rows: [{ relation }] }
      : { rows: versions.map((version) => ({ version: String(version) })) },
  );
  return { query };
}

describe("bundled migration apply", () => {
  it("defaults to the catalog head and accepts only a bundled --through", () => {
    expect(parseBundledMigrationApplyArgumentsV1([])).toEqual({ dryRun: false, through: null });
    expect(parseBundledMigrationApplyArgumentsV1(["--", "--through", "24"])).toEqual({ dryRun: false, through: 24 });
    expect(parseBundledMigrationApplyArgumentsV1(["--dry-run"])).toEqual({ dryRun: true, through: null });
    for (const invalid of [["--through"], ["--through", "0"], ["--through", "v24"], ["--force"]]) {
      expect(() => parseBundledMigrationApplyArgumentsV1(invalid)).toThrow();
    }
  });

  it("reads a never-migrated database as an empty inventory instead of failing on the absent ledger", async () => {
    // Migration v1 creates poietra_schema_migrations, so the tool must survive
    // its absence; this is the fresh deployment database it exists to set up.
    const fresh = poolStub(null);
    await expect(readRecordedMigrationVersionsV1(fresh)).resolves.toEqual([]);
    expect(fresh.query).toHaveBeenCalledTimes(1);

    const migrated = poolStub("poietra_schema_migrations", [1, 2, 3]);
    await expect(readRecordedMigrationVersionsV1(migrated)).resolves.toEqual([1, 2, 3]);
  });

  it("applies through the catalog head and reports the recorded inventory", async () => {
    const fixture = dependencies({ recordedVersions: freshThen(HEAD) });

    await expect(applyBundledMigrationsV1({ dryRun: false, through: null }, fixture)).resolves.toEqual({
      applied: true,
      atHead: true,
      dryRun: false,
      head: HEAD,
      pending: [],
      recorded: [...BUNDLED],
      schema: "poietra.bundled-migration-apply",
      target: HEAD,
      version: 1,
    });
    expect(fixture.applyThrough).toHaveBeenCalledWith(HEAD);
    // The report must carry what the database recorded after applying, not the
    // empty inventory the preflight read.
    expect(fixture.recordedVersions).toHaveBeenCalledTimes(2);

    await expect(
      applyBundledMigrationsV1(
        { dryRun: false, through: null },
        dependencies({
          applyThrough: vi.fn(async (version: number) => ({ applied: false, version })),
          recordedVersions: freshThen(HEAD),
        }),
      ),
    ).resolves.toMatchObject({ applied: false, atHead: true });
  });

  it("stages one earlier migration without pretending the database is at head", async () => {
    const target = BUNDLED.at(-2);
    if (target === undefined) throw new Error("The bundle must carry more than one migration.");
    const fixture = dependencies({ recordedVersions: freshThen(target) });

    await expect(applyBundledMigrationsV1({ dryRun: false, through: target }, fixture)).resolves.toMatchObject({
      atHead: false,
      head: HEAD,
      target,
    });
    expect(fixture.applyThrough).toHaveBeenCalledWith(target);
  });

  it("previews pending versions without applying anything, staged or at head", async () => {
    const recorded = BUNDLED.slice(0, 2);
    const fixture = dependencies({ recordedVersions: vi.fn(async () => recorded) });

    await expect(applyBundledMigrationsV1({ dryRun: true, through: null }, fixture)).resolves.toMatchObject({
      applied: false,
      atHead: false,
      dryRun: true,
      pending: BUNDLED.filter((version) => !recorded.includes(version)),
      recorded,
    });
    expect(fixture.applyThrough).not.toHaveBeenCalled();

    // The documented staged preflight: --through with --dry-run must report the
    // staged target's pending set and still apply nothing.
    const target = BUNDLED.at(-2);
    if (target === undefined) throw new Error("The bundle must carry more than one migration.");
    const staged = dependencies({ recordedVersions: vi.fn(async () => recorded) });
    await expect(applyBundledMigrationsV1({ dryRun: true, through: target }, staged)).resolves.toMatchObject({
      applied: false,
      atHead: false,
      dryRun: true,
      pending: BUNDLED.filter((version) => version <= target && !recorded.includes(version)),
      target,
    });
    expect(staged.applyThrough).not.toHaveBeenCalled();
  });

  it("refuses drifted state as a preflight, before touching the database", async () => {
    const fixture = dependencies({ recordedVersions: vi.fn(async () => [...BUNDLED, HEAD + 7]) });

    await expect(applyBundledMigrationsV1({ dryRun: false, through: null }, fixture)).rejects.toThrow(
      /does not carry/iu,
    );
    // Applying first and detecting drift afterwards would already have mutated
    // a database whose artifact is older than its schema.
    expect(fixture.applyThrough).not.toHaveBeenCalled();
  });

  it("fails closed on drift, an unbundled target, a head mismatch, and an incomplete apply", async () => {
    await expect(
      applyBundledMigrationsV1(
        { dryRun: false, through: null },
        dependencies({ recordedVersions: vi.fn(async () => [...BUNDLED, HEAD + 7]) }),
      ),
    ).rejects.toThrow(/does not carry/iu);
    await expect(applyBundledMigrationsV1({ dryRun: false, through: HEAD + 1 }, dependencies())).rejects.toThrow(
      /is not bundled/iu,
    );
    await expect(
      applyBundledMigrationsV1({ dryRun: false, through: null }, dependencies({ migrationHead: vi.fn(() => 1) })),
    ).rejects.toThrow(/head does not match/iu);
    await expect(
      applyBundledMigrationsV1(
        { dryRun: false, through: null },
        dependencies({ applyThrough: vi.fn(async () => ({ applied: true, version: HEAD - 1 })) }),
      ),
    ).rejects.toThrow(/did not reach the exact/iu);
    // The applier claimed the head but the database does not record it.
    await expect(
      applyBundledMigrationsV1(
        { dryRun: false, through: null },
        dependencies({ recordedVersions: vi.fn(async () => BUNDLED.slice(0, -1)) }),
      ),
    ).rejects.toThrow(/missing durable storage migrations/iu);
  });
});
