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

/** Reads the current project thumbnail selected by the durable publication head. */
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

  async current(projectId: string, signal?: AbortSignal) {
    const publication = await this.#options.repository.readCurrent(this.#options.tenantId, projectId, signal);
    if (!publication) throw new HttpError("A durable thumbnail has not been generated.", 404);
    return assertClientThumbnailPublicationIdentityV1(publication, {
      projectId,
      tenantId: this.#options.tenantId,
    });
  }

  async currentBytes(projectId: string, signal?: AbortSignal) {
    const publication = await this.current(projectId, signal);
    try {
      const bytes = await this.#options.store.read(this.#options.tenantId, publication.artifact.receipt, signal);
      return { bytes, publication } as const;
    } catch (error) {
      if (error instanceof ClientThumbnailReadErrorV1 && error.code === "missing") {
        throw new HttpError("A durable thumbnail has not been generated.", 404);
      }
      throw error;
    }
  }
}
