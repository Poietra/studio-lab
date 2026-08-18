import { createHash, randomUUID } from "node:crypto";

import { HttpError } from "../http/json";
import {
  type AcceptClientThumbnailPublicationResultV1,
  CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
  CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
  CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
  type ClientThumbnailArtifactReceiptV1,
  type ClientThumbnailArtifactStoreV1,
  type ClientThumbnailLineageV1,
  type ClientThumbnailPublicationV1,
  type ClientThumbnailRepositoryV1,
  MAX_CLIENT_THUMBNAIL_BYTES_V1,
  parseClientThumbnailLineageV1,
  sameClientThumbnailPublicationPayloadV1,
} from "./client-thumbnail-contract";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const THUMBNAIL_WIDTH = 854;
const THUMBNAIL_HEIGHT = 480;

export type PublishClientThumbnailInputV1 = Readonly<{
  bytes: Uint8Array;
  contentDigest: string;
  createdBySubjectId: string;
  documentEpoch: string;
  documentKey: string;
  documentRevision: bigint;
  projectId: string;
  publicationId: string;
  sceneRevisionHash: string;
  tenantId: string;
}>;

export type PublishClientThumbnailResultV1 = Readonly<{
  publication: ClientThumbnailPublicationV1;
  replayed: boolean;
}>;

export type ClientThumbnailPublisherOptionsV1 = Readonly<{
  artifacts: ClientThumbnailArtifactStoreV1;
  publications: ClientThumbnailRepositoryV1;
  tenantId: string;
}>;

function refusal(result: Extract<AcceptClientThumbnailPublicationResultV1, { kind: "refused" }>): never {
  if (result.reason === "document-not-found") {
    throw new HttpError("The thumbnail lineage document was not found.", 404);
  }
  throw new HttpError("The thumbnail lineage is not the current Editor Document revision.", 409);
}

function inspectPngV1(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MAX_CLIENT_THUMBNAIL_BYTES_V1) {
    throw new HttpError("The client thumbnail must be a PNG no larger than 4 MiB.", 413);
  }
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    !body.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    body.readUInt32BE(16) !== THUMBNAIL_WIDTH ||
    body.readUInt32BE(20) !== THUMBNAIL_HEIGHT
  ) {
    throw new HttpError("The client thumbnail must be an 854x480 PNG.", 400);
  }
  return body;
}

/** Validates and durably publishes the exact thumbnail rendered by the browser Rust engine. */
export class ClientThumbnailPublisherV1 {
  readonly #options: ClientThumbnailPublisherOptionsV1;

  constructor(options: ClientThumbnailPublisherOptionsV1) {
    this.#options = options;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = await Promise.all([this.#options.artifacts.ready(signal), this.#options.publications.ready(signal)]);
    signal?.throwIfAborted();
    return ready.every(Boolean);
  }

  async publish(input: PublishClientThumbnailInputV1, signal?: AbortSignal): Promise<PublishClientThumbnailResultV1> {
    signal?.throwIfAborted();
    if (input.tenantId !== this.#options.tenantId) {
      throw new TypeError("The client thumbnail does not match the trusted tenant composition.");
    }
    const bytes = inspectPngV1(input.bytes);
    const contentDigest = createHash("sha256").update(bytes).digest("hex");
    if (contentDigest !== input.contentDigest) {
      throw new HttpError("The client thumbnail digest does not match the uploaded bytes.", 400);
    }
    let lineage: ClientThumbnailLineageV1;
    try {
      lineage = parseClientThumbnailLineageV1({
        documentEpoch: input.documentEpoch,
        documentKey: input.documentKey,
        documentRevision: input.documentRevision,
        producerKind: CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
        representativeFrameRule: CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
        sceneContractVersion: CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
        sceneRevisionHash: input.sceneRevisionHash,
      });
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : "Client thumbnail lineage is invalid.", 400);
    }

    const stored = await this.#options.publications.readPublication(
      input.tenantId,
      input.projectId,
      input.publicationId,
      signal,
    );
    if (stored) {
      if (
        !sameClientThumbnailPublicationPayloadV1(stored, {
          createdBySubjectId: input.createdBySubjectId,
          lineage,
          projectId: input.projectId,
          receipt: { byteSize: bytes.byteLength, contentDigest },
        })
      ) {
        throw new HttpError("The thumbnail publication ID is already bound to a different payload.", 409);
      }
      return { publication: stored, replayed: true };
    }

    const receipt = await this.#options.artifacts.put(input.tenantId, { bytes, contentDigest }, signal);
    // A rejected call can be an ambiguous commit, so an exception deliberately
    // leaves the immutable object in place. A named refusal below is known not
    // to have retained this receipt and is cleaned up immediately.
    const result = await this.#options.publications.acceptPublication(
      {
        artifactId: randomUUID(),
        createdBySubjectId: input.createdBySubjectId,
        lineage,
        projectId: input.projectId,
        publicationId: input.publicationId,
        receipt,
        tenantId: input.tenantId,
      },
      signal,
    );
    if (result.kind === "accepted" && !result.replayed) {
      return { publication: result.publication, replayed: false };
    }
    await this.#discard(receipt);
    if (result.kind === "accepted") return { publication: result.publication, replayed: true };
    if (result.kind === "conflict") {
      throw new HttpError("The thumbnail publication ID is already bound to a different payload.", 409);
    }
    return refusal(result);
  }

  async #discard(receipt: ClientThumbnailArtifactReceiptV1) {
    try {
      await this.#options.artifacts.deleteObject(this.#options.tenantId, receipt);
    } catch {
      // Best effort only; the immutable object is not addressable without a publication row.
    }
  }
}
