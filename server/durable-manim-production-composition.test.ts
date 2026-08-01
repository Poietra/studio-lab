import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  createDurablePostgresS3ProductionRuntimeV1,
  createProductionStorageOwnershipBoundaryV1,
} from "./durable-manim-production-composition";
import type { ProductionManimRuntimeAdapterV1 } from "./manim-production-server";
import { RoutedSourceContentBlobStoreV1 } from "./storage/routed-source-png-store";
import { ImmutableS3SourceBlobStoreV1 } from "./storage/s3/s3-immutable-source-png-store";
import { PrivateImmutableS3BucketTransportV1 } from "./storage/s3/s3-private-immutable-bucket-transport";

function closeable(close: () => Promise<void>) {
  return { close };
}

function runtimeAdapter(close: () => Promise<void>): ProductionManimRuntimeAdapterV1 {
  return {
    api: {} as never,
    close,
    ready: async () => ({ ready: false }),
    workspaceReady: async () => true,
  };
}

describe("production storage ownership boundary", () => {
  it("rejects a versioned write lane without legacy storage before migration", async () => {
    const poolConfig = { host: "database.example", ssl: { rejectUnauthorized: true } };
    await expect(
      createDurablePostgresS3ProductionRuntimeV1({
        database: { migrationPoolConfig: poolConfig, runtimePoolConfig: poolConfig },
        objectStorage: { writeLane: "versioned" },
      } as never),
    ).rejects.toThrow(/requires legacy object storage/i);
  });

  it("closes runtime, stores, then shared transports once", async () => {
    const events: string[] = [];
    const runtime = runtimeAdapter(
      vi.fn(async () => {
        events.push("runtime");
      }),
    );
    const store = closeable(
      vi.fn(async () => {
        expect(events).toEqual(["runtime"]);
        events.push("store");
      }),
    );
    const transport = closeable(
      vi.fn(async () => {
        expect(events).toEqual(["runtime", "store"]);
        events.push("transport");
      }),
    );
    const owned = createProductionStorageOwnershipBoundaryV1(runtime, [store, store], [transport, transport]);

    await Promise.all([owned.close(), owned.close()]);

    expect(events).toEqual(["runtime", "store", "transport"]);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("runs every close phase and aggregates synchronous and asynchronous failures", async () => {
    const runtimeFailure = new Error("runtime failed");
    const storeFailure = new Error("store failed");
    const transportFailure = new Error("transport failed");
    const runtime = runtimeAdapter(() => {
      throw runtimeFailure;
    });
    const store = closeable(async () => {
      throw storeFailure;
    });
    const transport = closeable(async () => {
      throw transportFailure;
    });
    const owned = createProductionStorageOwnershipBoundaryV1(runtime, [store], [transport]);

    const failure = await owned.close().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([runtimeFailure, storeFailure, transportFailure]);
  });

  it("closes a shared base transport after its routed store releases the lease", async () => {
    const transport = new PrivateImmutableS3BucketTransportV1({
      bucket: "poietra-private-objects",
      client: { destroy: vi.fn(), send: vi.fn() } as unknown as S3Client,
      deployment: "test",
    });
    const immutable = new ImmutableS3SourceBlobStoreV1({ transport });
    const routed = new RoutedSourceContentBlobStoreV1({ immutable, writeLane: "immutable" });
    const owned = createProductionStorageOwnershipBoundaryV1(
      runtimeAdapter(async () => undefined),
      [routed],
      [transport],
    );

    await owned.close();

    expect(() => transport.acquire()).toThrow(/closed/i);
  });
});
