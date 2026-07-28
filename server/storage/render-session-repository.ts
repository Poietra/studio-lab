import type { RenderSessionStatus, RenderSourceActionView } from "../../src/render-pipeline/contracts";

import type { SourceBlobReceiptV1, WorkspaceSourceHeadV1 } from "./workspace-source-repository";

export const MAX_DURABLE_RENDER_LOG_BYTES_V1 = 64 * 1024;
export const MAX_DURABLE_RENDER_ERROR_BYTES_V1 = 4 * 1024;
export const MAX_DURABLE_RENDER_ARTIFACT_LOCATOR_BYTES_V1 = 2 * 1024;
export const MAX_DURABLE_RENDER_LEASE_MS_V1 = 15 * 60 * 1_000;
export const MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1 = 1_000;
export const MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1 = 15 * 60 * 1_000;

export type DurableRenderSourceActionV1 = RenderSourceActionView &
  Readonly<{
    createdAt: Date;
    expectedKey: string | null;
    sessionId: string;
    tenantId: string;
    updatedAt: Date;
  }>;

export type DurableRenderSessionV1 = Readonly<{
  artifactLocator: string | null;
  commitCorrelationKey: string;
  createdAt: Date;
  deadline: Date;
  error: string | null;
  executionAttempts: number;
  fenceToken: bigint;
  id: string;
  latestAction: DurableRenderSourceActionV1 | null;
  lease: Readonly<{ expiresAt: Date; ownerId: string }> | null;
  logTail: string;
  original: Readonly<{ blob: SourceBlobReceiptV1; generation: bigint }>;
  patch: Readonly<{
    anchorLine: number;
    anchorLines: readonly number[];
    insertedCode: string;
  }>;
  patched: Readonly<{ blob: SourceBlobReceiptV1 }>;
  programBatchId: string;
  programTransactionId: string;
  progress: number;
  projectId: string;
  renderRequestId: string;
  sceneName: string;
  sourcePath: string;
  status: RenderSessionStatus;
  tenantId: string;
  updatedAt: Date;
  version: bigint;
}>;

export type CreateDurableRenderSessionInputV1 = Readonly<{
  commitCorrelationKey: string;
  executionTimeoutMs: number;
  id: string;
  originalHead: WorkspaceSourceHeadV1;
  patch: DurableRenderSessionV1["patch"];
  patchedBlob: SourceBlobReceiptV1;
  programBatchId: string;
  programTransactionId: string;
  renderRequestId: string;
  sceneName: string;
  tenantId: string;
}>;

export type DurableRenderLeaseClaimV1 = Readonly<{
  leaseDurationMs: number;
  ownerId: string;
  sessionId: string;
  tenantId: string;
}>;

export type DurableRenderLeaseIdentityV1 = Readonly<{
  expectedVersion: bigint;
  fenceToken: bigint;
  ownerId: string;
  sessionId: string;
  tenantId: string;
}>;

export type DurableRenderLeaseRenewalV1 = DurableRenderLeaseIdentityV1 & Readonly<{ leaseDurationMs: number }>;

export type DurableRenderLeaseCompletionV1 = DurableRenderLeaseIdentityV1 &
  Readonly<{
    artifactLocator?: string | null;
    error: string | null;
    logTail: string;
    progress: number;
    status: Extract<RenderSessionStatus, "cancelled" | "failed" | "ready">;
  }>;

export type DurableRenderSourceActionInputV1 = Readonly<{
  actionId: string;
  expectedKey: string;
  expectedSessionVersion: bigint;
  kind: "commit" | "undo";
  sessionId: string;
  tenantId: string;
}>;

export type DurableRenderSourceActionResultV1 = Readonly<{
  action: DurableRenderSourceActionV1;
  executed: boolean;
  session: DurableRenderSessionV1;
}>;

export interface RenderSessionRepositoryV1 {
  abandonSession(
    tenantId: string,
    sessionId: string,
    expectedRenderRequestId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  applySourceAction(
    input: DurableRenderSourceActionInputV1,
    signal?: AbortSignal,
  ): Promise<DurableRenderSourceActionResultV1>;
  cancelSession(tenantId: string, sessionId: string, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  cancelSourceAction(
    input: Omit<DurableRenderSourceActionInputV1, "expectedKey" | "expectedSessionVersion">,
    signal?: AbortSignal,
  ): Promise<DurableRenderSourceActionResultV1>;
  claimLease(input: DurableRenderLeaseClaimV1, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  close(): Promise<void>;
  completeLease(input: DurableRenderLeaseCompletionV1, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  createSession(input: CreateDurableRenderSessionInputV1, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  discardSession(tenantId: string, sessionId: string, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  expireTimedOutSessions(tenantId: string, limit: number, signal?: AbortSignal): Promise<number>;
  findRecoverableSessions(
    tenantId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DurableRenderSessionV1[]>;
  readSession(tenantId: string, sessionId: string, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  renewLease(input: DurableRenderLeaseRenewalV1, signal?: AbortSignal): Promise<DurableRenderSessionV1>;
}
