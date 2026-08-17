import { describe, expect, it, vi } from "vitest";

import {
  BUNDLED_DURABLE_STORAGE_MIGRATION_CATALOG_V1,
  BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1,
} from "../server/storage/postgres/migrate";
import {
  applyBundledMigrationsV1,
  parseBundledMigrationApplyArgumentsV1,
  readRecordedMigrationInventoryV1,
} from "./apply-bundled-migrations.mjs";

const CATALOG = BUNDLED_DURABLE_STORAGE_MIGRATION_CATALOG_V1;
const HEAD = BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1;

function dependencies(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    applyThrough: vi.fn(async (version: number) => ({ applied: true, version })),
    bundledCatalog: vi.fn(() => CATALOG),
    migrationHead: vi.fn(() => HEAD),
    recordedInventory: vi.fn(async () => [...CATALOG]),
    ...overrides,
  };
}

function freshThen(target: number) {
  const recorded = vi.fn(async () =>
    recorded.mock.calls.length > 1 ? CATALOG.filter(({ version }) => version <= target) : [],
  );
  return recorded;
}

function poolStub(relation: string | null, entries: readonly Readonly<{ checksum: string; version: number }>[] = []) {
  const query = vi.fn(async (text: string) =>
    text.includes("to_regclass")
      ? { rows: [{ relation }] }
      : { rows: entries.map(({ checksum, version }) => ({ checksum, version: String(version) })) },
  );
  return { query };
}

describe("bundled migration apply", () => {
  it("defaults to the catalog head and accepts only a bundled --through", () => {
    expect(parseBundledMigrationApplyArgumentsV1([])).toEqual({ dryRun: false, through: null });
    expect(parseBundledMigrationApplyArgumentsV1(["--", "--through", "24"])).toEqual({
      dryRun: false,
      through: 24,
    });
    expect(parseBundledMigrationApplyArgumentsV1(["--dry-run"])).toEqual({ dryRun: true, through: null });
    for (const invalid of [["--through"], ["--through", "0"], ["--through", "v24"], ["--force"]]) {
      expect(() => parseBundledMigrationApplyArgumentsV1(invalid)).toThrow();
    }
  });

  it("reads a fresh database as an empty inventory and reads installed checksums", async () => {
    const fresh = poolStub(null);
    await expect(readRecordedMigrationInventoryV1(fresh)).resolves.toEqual([]);
    expect(fresh.query).toHaveBeenCalledTimes(1);

    const installed = poolStub("poietra_schema_migrations", CATALOG.slice(0, 3));
    await expect(readRecordedMigrationInventoryV1(installed)).resolves.toEqual(CATALOG.slice(0, 3));
  });

  it("applies through the catalog head and reports the post-apply inventory", async () => {
    const fixture = dependencies({ recordedInventory: freshThen(HEAD) });
    await expect(applyBundledMigrationsV1({ dryRun: false, through: null }, fixture)).resolves.toEqual({
      applied: true,
      databaseAtHead: true,
      dryRun: false,
      head: HEAD,
      pending: [],
      recorded: CATALOG.map(({ version }) => version),
      schema: "poietra.bundled-migration-apply",
      target: HEAD,
      targetIsHead: true,
      version: 1,
    });
    expect(fixture.applyThrough).toHaveBeenCalledWith(HEAD);
    expect(fixture.recordedInventory).toHaveBeenCalledTimes(2);
  });

  it("keeps database and target head facts distinct for an older --through", async () => {
    const target = CATALOG.at(-2)?.version;
    if (target === undefined) throw new Error("The bundle must carry more than one migration.");

    const dryRun = dependencies();
    await expect(applyBundledMigrationsV1({ dryRun: true, through: target }, dryRun)).resolves.toMatchObject({
      databaseAtHead: true,
      dryRun: true,
      pending: [],
      target,
      targetIsHead: false,
    });
    expect(dryRun.applyThrough).not.toHaveBeenCalled();

    const apply = dependencies({ applyThrough: vi.fn(async () => ({ applied: false, version: target })) });
    await expect(applyBundledMigrationsV1({ dryRun: false, through: target }, apply)).resolves.toMatchObject({
      applied: false,
      databaseAtHead: true,
      dryRun: false,
      target,
      targetIsHead: false,
    });
    expect(apply.applyThrough).toHaveBeenCalledWith(target);
  });

  it("reports a staged database without claiming that it or the target is head", async () => {
    const target = CATALOG.at(-2)?.version;
    if (target === undefined) throw new Error("The bundle must carry more than one migration.");
    const fixture = dependencies({ recordedInventory: freshThen(target) });
    await expect(applyBundledMigrationsV1({ dryRun: false, through: target }, fixture)).resolves.toMatchObject({
      databaseAtHead: false,
      target,
      targetIsHead: false,
    });
  });

  it("previews pending migrations without applying and requires the complete head inventory", async () => {
    const recorded = CATALOG.slice(0, 2);
    const fixture = dependencies({ recordedInventory: vi.fn(async () => recorded) });
    await expect(applyBundledMigrationsV1({ dryRun: true, through: null }, fixture)).resolves.toMatchObject({
      applied: false,
      databaseAtHead: false,
      dryRun: true,
      pending: CATALOG.slice(2).map(({ version }) => version),
      recorded: recorded.map(({ version }) => version),
      targetIsHead: true,
    });
    expect(fixture.applyThrough).not.toHaveBeenCalled();

    const missingMiddle = dependencies({
      recordedInventory: vi.fn(async () => [...CATALOG.slice(0, 1), ...CATALOG.slice(2)]),
    });
    await expect(applyBundledMigrationsV1({ dryRun: true, through: null }, missingMiddle)).rejects.toThrow(
      /contiguous prefix/iu,
    );
    expect(missingMiddle.applyThrough).not.toHaveBeenCalled();
  });

  it("rejects unknown versions and checksum drift before applying", async () => {
    const unknown = dependencies({
      recordedInventory: vi.fn(async () => [...CATALOG, { checksum: "a".repeat(64), version: HEAD + 1 }]),
    });
    await expect(applyBundledMigrationsV1({ dryRun: false, through: null }, unknown)).rejects.toThrow(
      /does not carry/iu,
    );
    expect(unknown.applyThrough).not.toHaveBeenCalled();

    const checksumDrift = dependencies({
      recordedInventory: vi.fn(async () =>
        CATALOG.map((entry) => (entry.version === HEAD ? { ...entry, checksum: "a".repeat(64) } : entry)),
      ),
    });
    await expect(applyBundledMigrationsV1({ dryRun: true, through: null }, checksumDrift)).rejects.toThrow(
      /checksum/iu,
    );
    expect(checksumDrift.applyThrough).not.toHaveBeenCalled();
  });

  it("rejects an invalid target, head mismatch, or incomplete apply", async () => {
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
    await expect(
      applyBundledMigrationsV1(
        { dryRun: false, through: null },
        dependencies({ recordedInventory: vi.fn(async () => CATALOG.slice(0, -1)) }),
      ),
    ).rejects.toThrow(/missing durable storage migrations/iu);
  });
});
