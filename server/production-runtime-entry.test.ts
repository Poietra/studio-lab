import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
} from "./fast-manim-gated-oci-release";
import { createStructuredLogger } from "./logging/structured-logger";
import { productionRuntimeConfigV1Schema, resolveProductionRuntimeCompositionV1 } from "./production-runtime-entry";

function productionRelease() {
  const keys = generateKeyPairSync("ed25519");
  const issuedAt = 1_780_000_000_000;
  const material = {
    dockerServerVersion: "28.3.3",
    imageDigest: `sha256:${"a".repeat(64)}`,
    profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
    seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  };
  const payload = {
    ...material,
    expiresAt: issuedAt + 10 * 60_000,
    issuedAt,
    keyId: "release-1",
    runtimeDigest: digestFastManimGatedOciRuntimeV1(material),
    schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
    version: 1 as const,
  };
  return {
    publicKeys: [
      { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
    ],
    signedRelease: {
      payload,
      signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
    },
  };
}

const RELEASE = productionRelease();

/** The smallest config an operator can write: endpoints only, every knob defaulted. */
const MINIMAL = Object.freeze({
  database: {
    database: "poietra",
    host: "db.internal",
    password: "secret",
    port: 5432,
    user: "poietra_runtime",
  },
  namespace: "cell-a",
  objectStorage: {
    immutable: {
      bucket: "poietra-immutable",
      provider: {
        accountId: "account-1",
        credentials: { accessKeyId: "key", secretAccessKey: "secret" },
        kind: "cloudflare-r2",
      },
    },
    writeLane: "immutable",
  },
  render: {
    sandbox: {
      brokerShardId: "shard-1",
      brokerUserId: 4001,
      imageDigest: `sha256:${"b".repeat(64)}`,
      socketGroupId: 4002,
      socketPath: "/run/poietra/render-broker.sock",
    },
    stagingRoot: "/var/lib/poietra/render",
  },
  server: { host: "127.0.0.1", port: 8443, publicOrigin: "https://studio.example.com" },
  snapshot: {
    sandbox: {
      brokerUserId: 4001,
      publicKeys: RELEASE.publicKeys,
      signedRelease: RELEASE.signedRelease,
      socketGroupId: 4002,
      socketPath: "/run/poietra/snapshot-broker.sock",
    },
  },
});

function logger() {
  return createStructuredLogger({ context: { component: "test" }, sinks: [] });
}

function parse(overrides: Record<string, unknown> = {}) {
  return productionRuntimeConfigV1Schema.parse({ ...MINIMAL, ...overrides });
}

describe("production runtime composition", () => {
  it("accepts an endpoint-only config and fills every operational knob", () => {
    const config = parse();

    expect(config.database.maxConnections).toBe(8);
    expect(config.database.statementTimeoutMs).toBe(30_000);
    expect(config.sourceGc).toMatchObject({ batchSize: 128, intervalMs: 300_000 });
    expect(config.render.cancellation.deliveryLeaseMs).toBe(60_000);
    expect(config.server.trustedProxyAddresses).toEqual([]);
  });

  it("builds pools the production assertions accept and never a connection string", () => {
    const { provisioner, runtimePoolConfig } = resolveProductionRuntimeCompositionV1(parse(), logger());

    for (const pool of [
      runtimePoolConfig,
      provisioner.database.migrationPoolConfig,
      provisioner.database.runtimePoolConfig,
    ]) {
      // assertProductionPoolConfig refuses each of these.
      expect(pool.connectionString).toBeUndefined();
      expect(pool.options).toBeUndefined();
      expect(pool.stream).toBeUndefined();
      expect(pool.host).toBe("db.internal");
      expect(pool.ssl).toEqual({ rejectUnauthorized: true });
    }
    // Migrations must not contend with the request pool.
    expect(provisioner.database.migrationPoolConfig.max).toBe(1);
    expect(provisioner.database.runtimePoolConfig.max).toBe(8);
  });

  it("routes every background failure through the logger instead of the process", () => {
    const records: string[] = [];
    const sink = {
      write: (record: { context?: Record<string, unknown>; event: string }) => {
        records.push(`${String(record.context?.component)}:${record.event}`);
      },
    };
    const composition = resolveProductionRuntimeCompositionV1(
      parse(),
      createStructuredLogger({ context: { component: "production-runtime" }, sinks: [sink] }),
    );

    composition.provisioner.sourceGc.onFailure(new Error("sweep failed"));
    composition.provisioner.renderWorker.onFailure(new Error("worker failed"));
    composition.provisioner.snapshot.artifactGc.onFailure(new Error("gc failed"));

    expect(records).toEqual([
      "source-gc:runtime.background_failure",
      "render-worker:runtime.background_failure",
      "snapshot-artifact-gc:runtime.background_failure",
    ]);
  });

  it("passes the deployment identity through to the server config unchanged", () => {
    const { server } = resolveProductionRuntimeCompositionV1(
      parse({ server: { ...MINIMAL.server, trustedProxyAddresses: ["10.0.0.1"] } }),
      logger(),
    );

    expect(server).toEqual({
      deployment: "production",
      host: "127.0.0.1",
      port: 8443,
      publicOrigin: "https://studio.example.com",
      trustedProxyAddresses: ["10.0.0.1"],
    });
  });

  it("refuses a config that could weaken the database or storage boundary", () => {
    const invalid = [
      { database: { ...MINIMAL.database, host: "/var/run/postgresql" } },
      { database: { ...MINIMAL.database, connectionString: "postgres://db/poietra" } },
      { objectStorage: { ...MINIMAL.objectStorage, writeLane: "anything" } },
      { render: { ...MINIMAL.render, stagingRoot: "relative/path" } },
      { render: { ...MINIMAL.render, sandbox: { ...MINIMAL.render.sandbox, imageDigest: "latest" } } },
      { namespace: "" },
    ];
    for (const override of invalid) {
      expect(() => parse(override as Record<string, unknown>)).toThrow();
    }
    // An unknown top-level key is a config the operator did not mean to write.
    expect(() => productionRuntimeConfigV1Schema.parse({ ...MINIMAL, extra: true })).toThrow();
  });

  it("keeps the runtime-cell bounds optional so the resolver owns its defaults", () => {
    expect(parse().runtimeCells).toEqual({});
    expect(parse({ runtimeCells: { maxCells: 4 } }).runtimeCells).toEqual({ maxCells: 4 });
  });
});

describe("production runtime entry", () => {
  it("refuses a non-canonical config path before reading anything", async () => {
    const { startProductionRuntimeEntryV1 } = await import("./production-runtime-entry");
    const open = vi.fn();

    await expect(startProductionRuntimeEntryV1("relative/config.json")).rejects.toThrow(/canonical and absolute/iu);
    await expect(startProductionRuntimeEntryV1("/etc/poietra/../config.json")).rejects.toThrow(
      /canonical and absolute/iu,
    );
    expect(open).not.toHaveBeenCalled();
  });
});
