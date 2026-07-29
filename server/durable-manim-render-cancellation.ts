import { randomUUID } from "node:crypto";
import type {
  DurableManimRenderCancellationRequestV1,
  DurableManimRenderExecutorV1,
} from "./durable-manim-render-worker";
import { HttpError } from "./http/json";
import { MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1 } from "./manim-render-sandbox-contract";
import { manimTenantIdSchema } from "./manim-request-principal";
import { DurableMaintenanceWorkerCoreV1 } from "./storage/durable-gc-core";
import {
  MAX_DURABLE_RENDER_CANCELLATION_DELIVERY_LEASE_MS_V1,
  type RenderCancellationRepositoryV1,
} from "./storage/render-cancellation-repository";

const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_ACKNOWLEDGEMENT_POLL_MS = 100;
const MAX_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 16;
const CANCELLATION_DELIVERY_SAFETY_MS = 5_000;
const MIN_SWEEP_TIMEOUT_MS = MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1 + CANCELLATION_DELIVERY_SAFETY_MS;

function boundedInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedIdentity(value: string, name: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 240
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export type DurableManimRenderCancellationCoordinatorOptionsV1 = Readonly<{
  acknowledgementPollMs?: number;
  acknowledgementTimeoutMs?: number;
  repository: RenderCancellationRepositoryV1;
  tenantId: string;
  wake: () => void;
}>;

/** Registers a durable intent and returns only after the owner broker's ACK is durable. */
export class DurableManimRenderCancellationCoordinatorV1 {
  readonly #acknowledgementPollMs: number;
  readonly #acknowledgementTimeoutMs: number;
  readonly #repository: RenderCancellationRepositoryV1;
  readonly #tenantId: string;
  readonly #wake: () => void;

  constructor(options: DurableManimRenderCancellationCoordinatorOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success || typeof options.wake !== "function") {
      throw new TypeError("The render cancellation coordinator configuration is invalid.");
    }
    this.#tenantId = tenant.data;
    this.#repository = options.repository;
    this.#wake = options.wake;
    this.#acknowledgementPollMs = boundedInteger(
      options.acknowledgementPollMs ?? DEFAULT_ACKNOWLEDGEMENT_POLL_MS,
      "acknowledgementPollMs",
      25,
      1_000,
    );
    this.#acknowledgementTimeoutMs = boundedInteger(
      options.acknowledgementTimeoutMs ?? DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
      "acknowledgementTimeoutMs",
      1_000,
      MAX_ACKNOWLEDGEMENT_TIMEOUT_MS,
    );
  }

  async cancel(sessionId: string) {
    const registered = await this.#repository.registerCancellation(this.#tenantId, sessionId);
    if (!registered.intent || registered.intent.acknowledgedAt) return;
    this.#wake();
    const deadline = Date.now() + this.#acknowledgementTimeoutMs;
    while (Date.now() < deadline) {
      await delay(Math.min(this.#acknowledgementPollMs, Math.max(1, deadline - Date.now())));
      const intent = await this.#repository.readCancellation(this.#tenantId, sessionId);
      if (intent?.acknowledgedAt && intent.fenceDigest) return;
      if (!intent) throw new Error("The durable render cancellation intent disappeared before acknowledgement.");
    }
    throw new HttpError("Render cancellation is still being delivered to its execution shard.", 503);
  }
}

export type DurableManimRenderCancellationRelayOptionsV1 = Readonly<{
  abortActive: (sessionId: string) => void;
  batchSize: number;
  brokerShardId: string;
  deliveryLeaseMs: number;
  executor: Pick<DurableManimRenderExecutorV1, "cancel" | "ready">;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  relayId?: string;
  repository: RenderCancellationRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

/** DB-credentialed relay; the broker itself remains isolated from PostgreSQL. */
export class DurableManimRenderCancellationRelayV1 extends DurableMaintenanceWorkerCoreV1<
  Readonly<{ acknowledged: number; examined: number; purged: number }>
> {
  constructor(options: DurableManimRenderCancellationRelayOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("The render cancellation relay tenant ID is invalid.");
    const brokerShardId = boundedIdentity(options.brokerShardId, "The render broker shard ID");
    const relayId = boundedIdentity(options.relayId ?? `relay-${randomUUID()}`, "The render cancellation relay ID");
    const batchSize = boundedInteger(options.batchSize, "batchSize", 1, MAX_BATCH_SIZE);
    const deliveryLeaseMs = boundedInteger(
      options.deliveryLeaseMs,
      "deliveryLeaseMs",
      1_000,
      MAX_DURABLE_RENDER_CANCELLATION_DELIVERY_LEASE_MS_V1,
    );
    if (options.sweepTimeoutMs < MIN_SWEEP_TIMEOUT_MS) {
      throw new RangeError(`sweepTimeoutMs must be at least ${MIN_SWEEP_TIMEOUT_MS} milliseconds.`);
    }
    if (deliveryLeaseMs < options.sweepTimeoutMs + CANCELLATION_DELIVERY_SAFETY_MS) {
      throw new RangeError("deliveryLeaseMs must include the sweep timeout and durable acknowledgement safety margin.");
    }
    super({
      intervalMs: options.intervalMs,
      onFailure: options.onFailure,
      startOnceError: "The render cancellation relay can only be started once.",
      sweepTimeoutMs: options.sweepTimeoutMs,
      validationPrefix: "Render cancellation relay",
      run: async (signal) => {
        const [repositoryReady, executorReady] = await Promise.all([
          options.repository.ready(signal),
          options.executor.ready(signal),
        ]);
        signal.throwIfAborted();
        if (!repositoryReady || !executorReady) {
          throw new Error("Render cancellation delivery is unavailable.");
        }
        const purged = await options.repository.purgeExpiredCancellations(tenant.data, batchSize, signal);
        const intents = await options.repository.claimCancellationDeliveries(
          {
            brokerShardId,
            leaseDurationMs: deliveryLeaseMs,
            maximum: batchSize,
            ownerId: relayId,
            tenantId: tenant.data,
          },
          signal,
        );
        const outcomes = await Promise.allSettled(
          intents.map(async (intent) => {
            signal.throwIfAborted();
            if (intent.tenantId !== tenant.data || intent.brokerShardId !== brokerShardId) {
              throw new Error("The cancellation delivery does not belong to this broker shard.");
            }
            options.abortActive(intent.sessionId);
            const acknowledgement = await options.executor.cancel({
              jobId: intent.jobId,
              rejectUntilEpochMs: intent.rejectUntil.getTime(),
              sessionId: intent.sessionId,
              tenantId: intent.tenantId,
            } satisfies DurableManimRenderCancellationRequestV1);
            signal.throwIfAborted();
            await options.repository.acknowledgeCancellation(
              {
                deliveryToken: intent.delivery.token,
                fenceDigest: acknowledgement.fenceDigest,
                ownerId: relayId,
                sessionId: intent.sessionId,
                tenantId: intent.tenantId,
              },
              signal,
            );
          }),
        );
        const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
        const acknowledged = outcomes.length - failures.length;
        if (failures.length > 0) {
          throw new AggregateError(failures, "One or more render cancellations could not be relayed.");
        }
        return { acknowledged, examined: intents.length, purged };
      },
    });
  }
}

export async function createDurableManimRenderCancellationRelayV1(
  options: DurableManimRenderCancellationRelayOptionsV1,
  signal?: AbortSignal,
) {
  const relay = new DurableManimRenderCancellationRelayV1(options);
  try {
    return await relay.start(signal);
  } catch (error) {
    await relay.close();
    throw error;
  }
}
