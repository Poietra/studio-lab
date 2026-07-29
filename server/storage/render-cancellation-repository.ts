import type { DurableRenderSessionV1 } from "./render-session-repository";

export const MAX_DURABLE_RENDER_CANCELLATION_INTENTS_V1 = 4_096;
export const MAX_DURABLE_RENDER_CANCELLATION_INTENTS_PER_TENANT_V1 = 256;
export const DURABLE_RENDER_CANCELLATION_GRACE_MS_V1 = 30_000;
export const MAX_DURABLE_RENDER_CANCELLATION_DELIVERY_LEASE_MS_V1 = 60_000;

export type DurableRenderCancellationIntentV1 = Readonly<{
  acknowledgedAt: Date | null;
  brokerShardId: string;
  delivery: Readonly<{ expiresAt: Date; ownerId: string; token: bigint }> | null;
  expiresAt: Date;
  fenceDigest: string | null;
  jobId: string;
  rejectUntil: Date;
  requestedAt: Date;
  sessionId: string;
  tenantId: string;
}>;

export type DurableRenderCancellationDeliveryV1 = Omit<DurableRenderCancellationIntentV1, "delivery"> &
  Readonly<{ delivery: NonNullable<DurableRenderCancellationIntentV1["delivery"]> }>;

export type DurableRenderCancellationRegistrationV1 =
  | Readonly<{ intent: null; session: DurableRenderSessionV1 }>
  | Readonly<{ intent: DurableRenderCancellationIntentV1; session: DurableRenderSessionV1 }>;

export type DurableRenderCancellationDeliveryClaimV1 = Readonly<{
  brokerShardId: string;
  leaseDurationMs: number;
  maximum: number;
  ownerId: string;
  tenantId: string;
}>;

export type DurableRenderCancellationAcknowledgementV1 = Readonly<{
  deliveryToken: bigint;
  fenceDigest: string;
  ownerId: string;
  sessionId: string;
  tenantId: string;
}>;

/** PostgreSQL-backed authority used by API replicas and credentialed broker relays. */
export interface RenderCancellationRepositoryV1 {
  acknowledgeCancellation(
    input: DurableRenderCancellationAcknowledgementV1,
    signal?: AbortSignal,
  ): Promise<DurableRenderSessionV1>;
  claimCancellationDeliveries(
    input: DurableRenderCancellationDeliveryClaimV1,
    signal?: AbortSignal,
  ): Promise<readonly DurableRenderCancellationDeliveryV1[]>;
  purgeExpiredCancellations(tenantId: string, maximum: number, signal?: AbortSignal): Promise<number>;
  readCancellation(
    tenantId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DurableRenderCancellationIntentV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  registerCancellation(
    tenantId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DurableRenderCancellationRegistrationV1>;
}
