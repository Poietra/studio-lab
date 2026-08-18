import { HttpError } from "../http/json";
import type { ManimMediaAssetV1 } from "../manim-api";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  assertClientExportPublicationIdentityV1,
  type ClientExportArtifactStoreV1,
  type ClientExportPublicationV1,
  type ClientExportReadClaimV1,
  ClientExportReadErrorV1,
  type ClientExportRepositoryV1,
} from "./client-export-contract";

/**
 * A read claim is minted for the full worst-case media-stream deadline, so no
 * renewal loop is required: the claim is a pin, not a lease (ADR 0005), and it
 * is released when the asset handle closes. Expired claims are reaped lazily
 * by the repository on the next acquisition.
 */
const DEFAULT_CLAIM_DURATION_MS = 16 * 60_000;
const MAX_CLAIM_DURATION_MS = 30 * 60_000;

export type ClientExportReaderOptionsV1 = Readonly<{
  claimDurationMs?: number;
  repository: ClientExportRepositoryV1;
  store: ClientExportArtifactStoreV1;
  tenantId: string;
}>;

function claimDuration(value: number | undefined) {
  const selected = value ?? DEFAULT_CLAIM_DURATION_MS;
  if (!Number.isSafeInteger(selected) || selected < 1_000 || selected > MAX_CLAIM_DURATION_MS) {
    throw new RangeError("Client export read-claim duration must be between one second and 30 minutes.");
  }
  return selected;
}

function missing(error: unknown): never {
  if (error instanceof HttpError && error.status === 404) throw error;
  if (error instanceof ClientExportReadErrorV1 && error.code === "missing") {
    throw new HttpError("Client export publication not found.", 404);
  }
  throw error;
}

/** Streams published client-export bytes under a read-claim pin held for the handle lifetime. */
export class ClientExportReaderV1 {
  readonly #claimDurationMs: number;
  readonly #repository: ClientExportRepositoryV1;
  readonly #store: ClientExportArtifactStoreV1;
  readonly #tenantId: string;

  constructor(options: ClientExportReaderOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("Client export reader tenant ID is invalid.");
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

  async publication(
    projectId: string,
    publicationId: string,
    signal?: AbortSignal,
  ): Promise<ClientExportPublicationV1> {
    const publication = await this.#repository.readPublication(this.#tenantId, projectId, publicationId, signal);
    if (!publication) throw new HttpError("Client export publication not found.", 404);
    return assertClientExportPublicationIdentityV1(publication, { projectId, tenantId: this.#tenantId });
  }

  #asset(claim: ClientExportReadClaimV1): ManimMediaAssetV1 {
    let closed = false;
    let closeRequest: Promise<void> | null = null;
    let opened = false;
    const receipt = claim.artifact.receipt;
    const asset: ManimMediaAssetV1 = {
      byteSize: receipt.byteSize,
      close: () => {
        closeRequest ??= (async () => {
          closed = true;
          await this.#repository.releaseReadClaim(this.#tenantId, claim.claimId);
        })();
        return closeRequest;
      },
      mediaType: receipt.mediaType,
      open: async (range, signal) => {
        if (closed || opened) throw new Error("The client export read handle is not reusable.");
        opened = true;
        signal?.throwIfAborted();
        try {
          return await this.#store.open(this.#tenantId, receipt, range, signal);
        } catch (error) {
          return missing(error);
        }
      },
    };
    return asset;
  }

  async publicationVideo(projectId: string, publicationId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const claim = await this.#repository.acquirePublicationVideo(
      this.#tenantId,
      projectId,
      publicationId,
      this.#claimDurationMs,
      signal,
    );
    const asset = this.#asset(claim);
    try {
      signal?.throwIfAborted();
      await this.#store.head(this.#tenantId, claim.artifact.receipt, signal);
      return asset;
    } catch (error) {
      await asset.close().catch(() => undefined);
      return missing(error);
    }
  }
}
