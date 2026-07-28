import { HttpError } from "../http/json";
import type { ManimMediaAssetV1 } from "../manim-api";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  RenderArtifactReadErrorV1,
  type RenderArtifactReadClaimV1,
  type RenderArtifactRepositoryV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";

const DEFAULT_CLAIM_DURATION_MS = 5 * 60_000;
const MAX_CLAIM_DURATION_MS = 15 * 60_000;

export type AuthorizedArtifactReaderOptionsV1 = Readonly<{
  claimDurationMs?: number;
  repository: RenderArtifactRepositoryV1;
  store: RenderArtifactStoreV1;
  tenantId: string;
}>;

function claimDuration(value: number | undefined) {
  const selected = value ?? DEFAULT_CLAIM_DURATION_MS;
  if (!Number.isSafeInteger(selected) || selected < 1_000 || selected > MAX_CLAIM_DURATION_MS) {
    throw new RangeError("Artifact read-claim duration must be between one second and 15 minutes.");
  }
  return selected;
}

function missing(error: unknown): never {
  if (error instanceof HttpError && error.status === 404) throw error;
  if (error instanceof RenderArtifactReadErrorV1 && error.code === "missing") {
    throw new HttpError("Rendered artifact not found.", 404);
  }
  throw error;
}

/** Holds a DB read claim for the full HEAD/range stream lifetime. */
export class AuthorizedArtifactReaderV1 {
  readonly #claimDurationMs: number;
  readonly #repository: RenderArtifactRepositoryV1;
  readonly #store: RenderArtifactStoreV1;
  readonly #tenantId: string;
  #closeRequest: Promise<void> | null = null;

  constructor(options: AuthorizedArtifactReaderOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("Artifact reader tenant ID is invalid.");
    this.#claimDurationMs = claimDuration(options.claimDurationMs);
    this.#repository = options.repository;
    this.#store = options.store;
    this.#tenantId = tenant.data;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [repositoryReady, storeReady] = await Promise.all([
      this.#repository.ready(signal),
      this.#store.ready(signal),
    ]);
    signal?.throwIfAborted();
    return repositoryReady && storeReady;
  }

  #asset(claim: RenderArtifactReadClaimV1): ManimMediaAssetV1 {
    let closed = false;
    let closeRequest: Promise<void> | null = null;
    let opened = false;
    let renewal: Promise<void> | null = null;
    let renewalTimer: NodeJS.Timeout | null = null;
    const leaseAbort = new AbortController();
    const receipt = claim.artifact.receipt;
    const renewalIntervalMs = Math.max(1, Math.floor(this.#claimDurationMs / 3));
    const scheduleRenewal = () => {
      if (closed || leaseAbort.signal.aborted) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = null;
        renewal = this.#repository
          .renewReadClaim(this.#tenantId, claim.claimId, this.#claimDurationMs, leaseAbort.signal)
          .then(() => scheduleRenewal())
          .catch((error: unknown) => {
            if (!closed) leaseAbort.abort(error);
          });
      }, renewalIntervalMs);
      renewalTimer.unref();
    };
    const operationSignal = (signal?: AbortSignal) =>
      signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal;
    scheduleRenewal();
    const asset: ManimMediaAssetV1 = {
      byteSize: receipt.byteSize,
      close: () => {
        closeRequest ??= (async () => {
          closed = true;
          if (renewalTimer) clearTimeout(renewalTimer);
          renewalTimer = null;
          leaseAbort.abort(new DOMException("The artifact read handle was closed.", "AbortError"));
          await renewal?.catch(() => undefined);
          await this.#repository.releaseReadClaim(this.#tenantId, claim.claimId);
        })();
        return closeRequest;
      },
      mediaType: receipt.mediaType,
      open: async (range, signal) => {
        if (closed || opened) throw new Error("The authorized artifact handle is not reusable.");
        opened = true;
        const combinedSignal = operationSignal(signal);
        combinedSignal.throwIfAborted();
        try {
          return await this.#store.open(this.#tenantId, receipt, range, combinedSignal);
        } catch (error) {
          return missing(error);
        }
      },
    };
    return Object.assign(asset, { leaseSignal: leaseAbort.signal });
  }

  async #open(claimRequest: () => Promise<RenderArtifactReadClaimV1>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const claim = await claimRequest();
    const asset = this.#asset(claim) as ManimMediaAssetV1 & Readonly<{ leaseSignal: AbortSignal }>;
    try {
      const headSignal = signal ? AbortSignal.any([signal, asset.leaseSignal]) : asset.leaseSignal;
      headSignal.throwIfAborted();
      await this.#store.head(this.#tenantId, claim.artifact.receipt, headSignal);
      signal?.throwIfAborted();
      asset.leaseSignal.throwIfAborted();
      return asset;
    } catch (error) {
      await asset.close().catch(() => undefined);
      return missing(error);
    }
  }

  sessionVideo(sessionId: string, signal?: AbortSignal) {
    return this.#open(
      () => this.#repository.acquireSessionVideo(this.#tenantId, sessionId, this.#claimDurationMs, signal),
      signal,
    );
  }

  projectThumbnail(projectId: string, signal?: AbortSignal) {
    return this.#open(
      () => this.#repository.acquireProjectThumbnail(this.#tenantId, projectId, this.#claimDurationMs, signal),
      signal,
    );
  }

  async projectThumbnailBytes(projectId: string, signal?: AbortSignal) {
    const asset = await this.projectThumbnail(projectId, signal);
    try {
      const body = await asset.open(null, signal);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of body) {
        signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > asset.byteSize) throw new RenderArtifactReadErrorV1("corrupt");
        chunks.push(chunk);
      }
      if (size !== asset.byteSize) throw new RenderArtifactReadErrorV1("corrupt");
      return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size,
      );
    } finally {
      await asset.close();
    }
  }

  close() {
    this.#closeRequest ??= (async () => {
      const results = await Promise.allSettled([this.#store.close(), this.#repository.close()]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "Could not fully close durable render artifact storage.");
    })();
    return this.#closeRequest;
  }
}
