import { HttpError } from "../http/json";
import {
  assertClientThumbnailPublicationIdentityV1,
  type ClientThumbnailArtifactStoreV1,
  ClientThumbnailReadErrorV1,
  type ClientThumbnailRepositoryV1,
} from "./client-thumbnail-contract";

export type ClientThumbnailReaderOptionsV1 = Readonly<{
  repository: ClientThumbnailRepositoryV1;
  store: ClientThumbnailArtifactStoreV1;
  tenantId: string;
}>;

/** Reads the project thumbnail selected by the durable publication head. */
export class ClientThumbnailReaderV1 {
  readonly #options: ClientThumbnailReaderOptionsV1;

  constructor(options: ClientThumbnailReaderOptionsV1) {
    this.#options = options;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = await Promise.all([this.#options.repository.ready(signal), this.#options.store.ready(signal)]);
    signal?.throwIfAborted();
    return ready.every(Boolean);
  }

  async head(projectId: string, signal?: AbortSignal) {
    const head = await this.#options.repository.readHead(this.#options.tenantId, projectId, signal);
    if (!head) throw new HttpError("A durable thumbnail has not been generated.", 404);
    return {
      current: head.current,
      publication: assertClientThumbnailPublicationIdentityV1(head.publication, {
        projectId,
        tenantId: this.#options.tenantId,
      }),
    } as const;
  }

  async headBytes(projectId: string, signal?: AbortSignal) {
    const head = await this.head(projectId, signal);
    try {
      const bytes = await this.#options.store.read(this.#options.tenantId, head.publication.artifact.receipt, signal);
      return { bytes, ...head } as const;
    } catch (error) {
      if (error instanceof ClientThumbnailReadErrorV1 && error.code === "missing") {
        throw new HttpError("A durable thumbnail has not been generated.", 404);
      }
      throw error;
    }
  }
}
