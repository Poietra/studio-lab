import { describe, expect, it, vi } from "vitest";

import {
  DurableManimRenderCancellationCoordinatorV1,
  DurableManimRenderCancellationRelayV1,
} from "./durable-manim-render-cancellation";
import type { DurableManimRenderExecutorV1 } from "./durable-manim-render-worker";
import type {
  DurableRenderCancellationDeliveryV1,
  DurableRenderCancellationIntentV1,
  RenderCancellationRepositoryV1,
} from "./storage/render-cancellation-repository";
import type { DurableRenderSessionV1 } from "./storage/render-session-repository";

const tenantId = "tenant-a";
const sessionId = "00000000-0000-4000-8000-000000000001";
const fenceDigest = "a".repeat(64);

function intent(overrides: Partial<DurableRenderCancellationIntentV1> = {}): DurableRenderCancellationIntentV1 {
  return {
    acknowledgedAt: null,
    brokerShardId: "broker-b",
    delivery: null,
    expiresAt: new Date(Date.now() + 60_000),
    fenceDigest: null,
    jobId: `${tenantId}/${sessionId}`,
    rejectUntil: new Date(Date.now() + 30_000),
    requestedAt: new Date(),
    sessionId,
    tenantId,
    ...overrides,
  };
}

function repository(overrides: Partial<RenderCancellationRepositoryV1> = {}): RenderCancellationRepositoryV1 {
  return {
    acknowledgeCancellation: vi.fn(async () => ({ status: "cancelled" }) as DurableRenderSessionV1),
    claimCancellationDeliveries: vi.fn(async () => []),
    purgeExpiredCancellations: vi.fn(async () => 0),
    readCancellation: vi.fn(async () => null),
    ready: vi.fn(async () => true),
    registerCancellation: vi.fn(async () => ({ intent: null, session: {} as DurableRenderSessionV1 })),
    ...overrides,
  };
}

describe("durable render cancellation", () => {
  it("returns from the API coordinator only after a correlated ACK is durable", async () => {
    const pending = intent();
    const acknowledged = intent({ acknowledgedAt: new Date(), fenceDigest });
    const store = repository({
      readCancellation: vi.fn(async () => acknowledged),
      registerCancellation: vi.fn(async () => ({ intent: pending, session: {} as DurableRenderSessionV1 })),
    });
    const wake = vi.fn();
    const coordinator = new DurableManimRenderCancellationCoordinatorV1({
      acknowledgementPollMs: 25,
      acknowledgementTimeoutMs: 1_000,
      repository: store,
      tenantId,
      wake,
    });

    await expect(coordinator.cancel(sessionId)).resolves.toBeUndefined();
    expect(store.registerCancellation).toHaveBeenCalledWith(tenantId, sessionId);
    expect(store.readCancellation).toHaveBeenCalledWith(tenantId, sessionId);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("keeps a timed-out intent durable for owner-shard replay", async () => {
    vi.useFakeTimers();
    try {
      const pending = intent();
      const store = repository({
        readCancellation: vi.fn(async () => pending),
        registerCancellation: vi.fn(async () => ({ intent: pending, session: {} as DurableRenderSessionV1 })),
      });
      const coordinator = new DurableManimRenderCancellationCoordinatorV1({
        acknowledgementPollMs: 100,
        acknowledgementTimeoutMs: 1_000,
        repository: store,
        tenantId,
        wake: vi.fn(),
      });

      const cancellation = expect(coordinator.cancel(sessionId)).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(1_000);
      await cancellation;
      expect(store.registerCancellation).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers only claimed owner-shard intents and persists the broker fence receipt", async () => {
    const delivery = intent({
      delivery: { expiresAt: new Date(Date.now() + 30_000), ownerId: "relay-b", token: 7n },
    }) as DurableRenderCancellationDeliveryV1;
    const abortActive = vi.fn();
    const cancel = vi.fn<DurableManimRenderExecutorV1["cancel"]>(async () => ({ fenceDigest }));
    const acknowledgeCancellation = vi.fn(async () => ({ status: "cancelled" }) as DurableRenderSessionV1);
    const store = repository({
      acknowledgeCancellation,
      claimCancellationDeliveries: vi.fn(async () => [delivery]),
    });
    const relay = new DurableManimRenderCancellationRelayV1({
      abortActive,
      batchSize: 4,
      brokerShardId: "broker-b",
      deliveryLeaseMs: 20_000,
      executor: { cancel, ready: vi.fn(async () => true) },
      intervalMs: 60_000,
      onFailure: () => undefined,
      relayId: "relay-b",
      repository: store,
      sweepTimeoutMs: 15_000,
      tenantId,
    });

    await relay.start();
    await relay.close();

    expect(abortActive).toHaveBeenCalledWith(sessionId);
    expect(abortActive.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]!);
    expect(acknowledgeCancellation).toHaveBeenCalledWith(
      {
        deliveryToken: 7n,
        fenceDigest,
        ownerId: "relay-b",
        sessionId,
        tenantId,
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects delivery budgets that cannot cover the broker RPC and durable acknowledgement", () => {
    const options = {
      abortActive: vi.fn(),
      batchSize: 4,
      brokerShardId: "broker-b",
      deliveryLeaseMs: 20_000,
      executor: {
        cancel: vi.fn<DurableManimRenderExecutorV1["cancel"]>(async () => ({ fenceDigest })),
        ready: vi.fn(async () => true),
      },
      intervalMs: 60_000,
      onFailure: () => undefined,
      repository: repository(),
      sweepTimeoutMs: 15_000,
      tenantId,
    } as const;

    expect(() => new DurableManimRenderCancellationRelayV1(options)).not.toThrow();
    expect(() => new DurableManimRenderCancellationRelayV1({ ...options, deliveryLeaseMs: 19_999 })).toThrow(
      /deliveryLeaseMs/,
    );
    expect(() => new DurableManimRenderCancellationRelayV1({ ...options, sweepTimeoutMs: 14_999 })).toThrow(
      /sweepTimeoutMs/,
    );
  });

  it("wakes a sleeping relay immediately without overlapping its maintenance loop", async () => {
    vi.useFakeTimers();
    try {
      const claimCancellationDeliveries = vi.fn(async () => []);
      const relay = new DurableManimRenderCancellationRelayV1({
        abortActive: vi.fn(),
        batchSize: 4,
        brokerShardId: "broker-b",
        deliveryLeaseMs: 20_000,
        executor: {
          cancel: vi.fn<DurableManimRenderExecutorV1["cancel"]>(async () => ({ fenceDigest })),
          ready: vi.fn(async () => true),
        },
        intervalMs: 60_000,
        onFailure: () => undefined,
        repository: repository({ claimCancellationDeliveries }),
        sweepTimeoutMs: 15_000,
        tenantId,
      });
      await relay.start();
      expect(claimCancellationDeliveries).toHaveBeenCalledOnce();

      relay.wake();
      await vi.advanceTimersByTimeAsync(0);

      expect(claimCancellationDeliveries).toHaveBeenCalledTimes(2);
      await relay.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
