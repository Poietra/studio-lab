import { createHash, randomUUID } from "node:crypto";

import {
  EXPORT_RESOLUTION_PIXELS_V1,
  type ExportProfileV1,
  exportProfileHashV1,
  parseExportProfileV1,
} from "../../src/engine/export-profile";
import { HttpError } from "../http/json";
import {
  type AcceptClientExportPublicationResultV1,
  CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
  CLIENT_EXPORT_PRODUCER_KIND_V1,
  CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
  type ClientExportArtifactStoreV1,
  type ClientExportLineageV1,
  type ClientExportPublicationV1,
  type ClientExportRepositoryV1,
  clientExportByteSizeV1,
  MAX_CLIENT_EXPORT_VIDEO_BYTES_V1,
  parseClientExportLineageV1,
  samePublicationAcceptancePayloadV1,
} from "./client-export-contract";
import type { ClientExportPublicationMeteringV1 } from "./client-export-metering";

const PUBLICATION_RESERVATION_LIFETIME_MS_V1 = 5 * 60_000;

/**
 * Rust-owned structural verification result for one uploaded MP4, produced by
 * the poietra-wasm `verifyExportMp4V1` entry ("one core, two hosts": Node
 * loads the same WASM artifact the browser exporter uses, so producer and
 * verifier share one container and provenance contract).
 */
export type ClientExportMp4VerificationV1 =
  | Readonly<{
      kind: "verified";
      provenance: Readonly<{
        engineAbiVersion: number;
        exportProfileHash: string;
        sceneId: string;
        sceneRevisionHash: string;
      }>;
      structure: Readonly<{
        durationTicks: number;
        heightPx: number;
        sampleCount: number;
        timescale: number;
        widthPx: number;
      }>;
    }>
  | Readonly<{ code: string; kind: "refused"; message: string }>;

export type ClientExportMp4VerifierV1 = (bytes: Uint8Array) => Promise<ClientExportMp4VerificationV1>;

export type PublishClientExportInputV1 = Readonly<{
  bytes: Uint8Array;
  contentDigest: string;
  createdBySubjectId: string;
  documentEpoch: string;
  documentKey: string;
  documentRevision: bigint;
  encoderEvidence: Readonly<Record<string, unknown>>;
  exportProfile: unknown;
  projectId: string;
  publicationId: string;
  sceneRevisionHash: string;
  tenantId: string;
}>;

export type PublishClientExportResultV1 = Readonly<{
  publication: ClientExportPublicationV1;
  replayed: boolean;
}>;

export type ClientExportPublisherOptionsV1 = Readonly<{
  artifactExpirationMs: number;
  artifacts: ClientExportArtifactStoreV1;
  metering: ClientExportPublicationMeteringV1;
  publications: ClientExportRepositoryV1;
  tenantId: string;
  verifyMp4: ClientExportMp4VerifierV1;
  verifyMp4Ready?: (signal?: AbortSignal) => Promise<boolean>;
}>;

function meteringDenied(reason: "blocked" | "operation-settled" | "quota-exhausted" | "unconfigured"): never {
  if (reason === "operation-settled") {
    throw new HttpError("That client export publication is already settled.", 409);
  }
  if (reason === "quota-exhausted") {
    throw new HttpError("The client export publication quota is exhausted.", 429);
  }
  throw new HttpError("The organization does not have an active export-publication entitlement.", 402);
}

function acceptanceRefused(result: Extract<AcceptClientExportPublicationResultV1, { kind: "refused" }>): never {
  if (result.reason === "document-not-found") {
    throw new HttpError("The export lineage document was not found.", 404);
  }
  if (result.reason === "revision-ahead") {
    throw new HttpError("The export lineage revision is ahead of the document.", 409);
  }
  throw new HttpError("The client export publication quota is exhausted.", 429);
}

/**
 * Verifies client-produced MP4 bytes and publishes them atomically per ADR
 * 0005 §"Artifact lineage and publication": digest recompute, Rust structural
 * MP4 parse plus provenance extraction, lineage cross-checks, one flow
 * reservation before the bytes are staged, then the repository acceptance
 * transaction (document lock, revision check, artifact + publication insert,
 * metering settlement) in one PostgreSQL transaction. Replay of the same
 * `publicationId` with the same payload returns the stored success and never
 * settles the metering port again.
 */
export class ClientExportPublisherV1 {
  readonly #options: ClientExportPublisherOptionsV1;

  constructor(options: ClientExportPublisherOptionsV1) {
    if (
      !Number.isSafeInteger(options.artifactExpirationMs) ||
      options.artifactExpirationMs < 1 ||
      options.artifactExpirationMs > 30 * 24 * 60 * 60_000
    ) {
      throw new RangeError("client export artifactExpirationMs must be an integer between 1 ms and 30 days.");
    }
    this.#options = options;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [artifacts, publications, verifier] = await Promise.all([
      this.#options.artifacts.ready(signal),
      this.#options.publications.ready(signal),
      this.#options.verifyMp4Ready?.(signal) ?? Promise.resolve(true),
    ]);
    signal?.throwIfAborted();
    return artifacts && publications && verifier;
  }

  async #verify(input: PublishClientExportInputV1, profile: ExportProfileV1) {
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_CLIENT_EXPORT_VIDEO_BYTES_V1) {
      throw new HttpError("The client export upload exceeds the 128 MiB bound.", 413);
    }
    clientExportByteSizeV1(bytes.byteLength);
    if (bytes.byteLength > profile.maxOutputBytes) {
      throw new HttpError("The client export upload exceeds the export profile output bound.", 413);
    }
    const contentDigest = createHash("sha256").update(bytes).digest("hex");
    if (contentDigest !== input.contentDigest) {
      throw new HttpError("The client export content digest does not match the uploaded bytes.", 400);
    }

    const verification = await this.#options.verifyMp4(bytes);
    if (verification.kind !== "verified") {
      throw new HttpError(`The client export MP4 failed structural verification (${verification.code}).`, 400);
    }

    const profileHash = await exportProfileHashV1(profile);
    if (
      verification.provenance.sceneRevisionHash !== input.sceneRevisionHash ||
      verification.provenance.exportProfileHash !== profileHash
    ) {
      throw new HttpError("The client export provenance does not match the claimed lineage.", 400);
    }
    const resolution = EXPORT_RESOLUTION_PIXELS_V1[profile.resolution];
    if (
      verification.structure.widthPx !== resolution.widthPx ||
      verification.structure.heightPx !== resolution.heightPx
    ) {
      throw new HttpError("The client export MP4 dimensions do not match the export profile.", 400);
    }
    if (
      verification.structure.timescale < 1 ||
      verification.structure.durationTicks > profile.maxDurationSeconds * verification.structure.timescale
    ) {
      throw new HttpError("The client export MP4 duration exceeds the export profile bound.", 400);
    }
    return { contentDigest, profileHash };
  }

  async publish(input: PublishClientExportInputV1, signal?: AbortSignal): Promise<PublishClientExportResultV1> {
    signal?.throwIfAborted();
    const tenantId = this.#options.tenantId;
    if (input.tenantId !== tenantId) {
      throw new TypeError("The client export publication does not match the trusted tenant composition.");
    }
    let profile: ExportProfileV1;
    try {
      profile = parseExportProfileV1(input.exportProfile);
    } catch {
      throw new HttpError("The client export profile is invalid.", 400);
    }
    const { contentDigest, profileHash } = await this.#verify(input, profile);
    signal?.throwIfAborted();

    let lineage: ClientExportLineageV1;
    try {
      lineage = parseClientExportLineageV1({
        documentEpoch: input.documentEpoch,
        documentKey: input.documentKey,
        documentRevision: input.documentRevision,
        encoderEvidence: input.encoderEvidence,
        encoderEvidenceVersion: CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
        exportProfileHash: profileHash,
        producerKind: CLIENT_EXPORT_PRODUCER_KIND_V1,
        sceneContractVersion: CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
        sceneRevisionHash: input.sceneRevisionHash,
      });
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : "Client export lineage is invalid.", 400);
    }

    // Replay detection before any reservation (ADR 0005): a retry whose
    // payload matches the stored publication returns the existing success
    // without reserving quota or re-staging bytes; a differing payload is a
    // conflict. The acceptance transaction re-checks under its row lock, so a
    // racing first submission is still handled exactly once.
    const stored = await this.#options.publications.readPublication(
      tenantId,
      input.projectId,
      input.publicationId,
      signal,
    );
    if (stored) {
      if (
        !samePublicationAcceptancePayloadV1(stored, {
          createdBySubjectId: input.createdBySubjectId,
          lineage,
          projectId: input.projectId,
          receipt: { byteSize: input.bytes.byteLength, contentDigest },
        })
      ) {
        throw new HttpError("The client export publication ID is already bound to a different payload.", 409);
      }
      return { publication: stored, replayed: true };
    }

    // Reserve one export-publication flow unit before staging bytes. The
    // repository settles this reservation inside its acceptance transaction,
    // AFTER replay detection, so a replayed acceptance never consumes quota.
    const reservation = await this.#options.metering.reservePublication(
      {
        lifetimeMs: PUBLICATION_RESERVATION_LIFETIME_MS_V1,
        operationId: input.publicationId,
        tenantId,
      },
      signal,
    );
    if (reservation.kind !== "reserved") meteringDenied(reservation.reason);

    let receipt;
    try {
      receipt = await this.#options.artifacts.put(
        tenantId,
        { byteSize: input.bytes.byteLength, bytes: input.bytes, contentDigest },
        signal,
      );
    } catch (error) {
      // A failed object put may not return a receipt, so physical cleanup is
      // left to the storage-first sweep. The flow reservation must still be
      // released immediately instead of occupying quota until expiry.
      await this.#releaseReservation(input.publicationId);
      throw error;
    }

    let result: AcceptClientExportPublicationResultV1;
    // A rejected database call can be an ambiguous commit: PostgreSQL may
    // have accepted this exact receipt before the connection or request was
    // lost. Therefore this call intentionally has no catch that deletes the
    // object or releases its possibly settled reservation. A truly orphaned
    // object is reclaimed by the storage-first sweep and an unsettled
    // reservation expires naturally.
    result = await this.#options.publications.acceptPublication(
      {
        artifactId: randomUUID(),
        createdBySubjectId: input.createdBySubjectId,
        expirationMs: this.#options.artifactExpirationMs,
        lineage,
        projectId: input.projectId,
        publicationId: input.publicationId,
        receipt,
        tenantId,
      },
      signal,
    );

    if (result.kind === "accepted" && !result.replayed) {
      return { publication: result.publication, replayed: false };
    }

    // The transaction did not retain this upload's fresh locator: a replayed
    // acceptance keeps the original object, and every other outcome keeps
    // nothing. Discard best-effort; the storage-first GC sweep reclaims any
    // orphan this cleanup misses.
    await this.#discard(receipt, input.publicationId);
    if (result.kind === "accepted") return { publication: result.publication, replayed: true };
    if (result.kind === "conflict") {
      throw new HttpError("The client export publication ID is already bound to a different payload.", 409);
    }
    return acceptanceRefused(result);
  }

  async #discard(receipt: Parameters<ClientExportArtifactStoreV1["deleteObject"]>[1], operationId: string) {
    try {
      await this.#options.artifacts.deleteObject(this.#options.tenantId, receipt);
    } catch {
      // The GC sweep owns orphan reclamation; cleanup here is best-effort.
    }
    await this.#releaseReservation(operationId);
  }

  async #releaseReservation(operationId: string) {
    try {
      await this.#options.metering.releasePublication(this.#options.tenantId, operationId);
    } catch {
      // An unreleased reservation expires on its own lifetime.
    }
  }
}
