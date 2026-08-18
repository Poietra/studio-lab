import {
  type BrowserWebCodecsEncoderEvidenceV1,
  browserWebCodecsEncoderEvidenceSchemaV1,
} from "../../src/collaboration/client-export-http-contract";
import { canonicalJsonV1 } from "../../src/engine/canonical-json";
import { manimProjectIdSchema } from "../../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  createImmutableObjectLocatorTokenV1,
  immutableObjectKeyV1,
  immutableObjectLocatorTokenV1,
} from "./immutable-object-contract";

/**
 * Client-export publication contract (ADR 0005 §"Artifact lineage and
 * publication"). An artifact is the immutable uploaded MP4 plus its private
 * object receipt; the publication carries the Editor Document lineage columns
 * directly and makes exactly one artifact durably addressable (1:1 in v1).
 * `publicationId` alone is the idempotency identity: replaying the same
 * complete immutable payload returns the existing success, and the same ID
 * with any differing field is a conflict.
 */
export const MAX_CLIENT_EXPORT_VIDEO_BYTES_V1 = 134_217_728;
export const MAX_CLIENT_EXPORT_ENCODER_EVIDENCE_JSON_BYTES_V1 = 16_384;
export const CLIENT_EXPORT_ARTIFACT_KIND_V1 = "video";
export const CLIENT_EXPORT_MEDIA_TYPE_V1 = "video/mp4";
export const CLIENT_EXPORT_PRODUCER_KIND_V1 = "browser-webcodecs";
export const CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1 = 1;
export const CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1 = 1;
export const MAX_EDITOR_DOCUMENT_REVISION_V1 = 9_007_199_254_740_991n;

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class ClientExportReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The client export object is missing." : "The client export object is corrupt.");
    this.name = "ClientExportReadErrorV1";
    this.code = code;
  }
}

function tenantIdV1(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client export tenant ID is invalid.");
  return parsed.data;
}

function projectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client export project ID is invalid.");
  return parsed.data;
}

function digestV1(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function clientExportIdV1(value: string, label = "Client export ID") {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function clientExportByteSizeV1(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CLIENT_EXPORT_VIDEO_BYTES_V1
  ) {
    throw new TypeError("Client export byte size is invalid.");
  }
  return value;
}

function hasControlCharacterV1(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function etagV1(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    hasControlCharacterV1(value)
  ) {
    throw new TypeError("Client export ETag is invalid.");
  }
  return value;
}

/** Content-addressed private key prefix before the locator-token suffix. */
export function clientExportContentAddressedKeyV1(tenantValue: string, contentDigestValue: string) {
  const tenantId = tenantIdV1(tenantValue);
  const contentDigest = digestV1(contentDigestValue, "Client export content digest");
  return `tenants/${tenantId}/client-exports/${CLIENT_EXPORT_ARTIFACT_KIND_V1}/${contentDigest}`;
}

export function clientExportMediaPrefixV1(tenantValue: string) {
  return `tenants/${tenantIdV1(tenantValue)}/client-exports/`;
}

export function clientExportObjectKeyV1(tenantValue: string, contentDigest: string, objectLocatorToken: string) {
  return immutableObjectKeyV1({
    contentAddressedKey: clientExportContentAddressedKeyV1(tenantValue, contentDigest),
    contentDigest: digestV1(contentDigest, "Client export content digest"),
    objectLocatorToken,
    tenantId: tenantIdV1(tenantValue),
  });
}

/**
 * Allocates a fresh random locator token for one upload. The token is stored
 * in the legacy-spelled `object_generation` column
 * (`immutable_object_generation_v1` domain) and embedded as the `/g/{token}`
 * key suffix; the internal vocabulary is `objectLocatorToken` and the value is
 * never ordered, monotonic, or comparable (ADR 0005).
 */
export function createClientExportArtifactLocatorV1(tenantValue: string, contentDigest: string) {
  const objectLocatorToken = createImmutableObjectLocatorTokenV1();
  return {
    objectKey: clientExportObjectKeyV1(tenantValue, contentDigest, objectLocatorToken),
    objectLocatorToken,
  } as const;
}

/** Immutable private object receipt for one accepted client-export MP4. */
export type ClientExportArtifactReceiptV1 = Readonly<{
  byteSize: number;
  contentDigest: string;
  etag: string;
  mediaType: typeof CLIENT_EXPORT_MEDIA_TYPE_V1;
  objectKey: string;
  objectLocatorToken: string;
}>;

const RECEIPT_FIELDS = new Set<string>([
  "byteSize",
  "contentDigest",
  "etag",
  "mediaType",
  "objectKey",
  "objectLocatorToken",
]);

export function parseClientExportArtifactReceiptV1(tenantValue: string, value: unknown): ClientExportArtifactReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Client export artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((field) => !RECEIPT_FIELDS.has(field))) {
    throw new TypeError("Client export artifact receipt contains an unknown field.");
  }
  if (candidate.mediaType !== CLIENT_EXPORT_MEDIA_TYPE_V1) {
    throw new TypeError("Client export artifact receipt is invalid.");
  }
  const contentDigest = digestV1(candidate.contentDigest, "Client export content digest");
  const objectLocatorToken = immutableObjectLocatorTokenV1(candidate.objectLocatorToken);
  const objectKey = clientExportObjectKeyV1(tenantValue, contentDigest, objectLocatorToken);
  if (candidate.objectKey !== objectKey) throw new TypeError("Client export artifact receipt is invalid.");
  return {
    byteSize: clientExportByteSizeV1(candidate.byteSize),
    contentDigest,
    etag: etagV1(candidate.etag),
    mediaType: CLIENT_EXPORT_MEDIA_TYPE_V1,
    objectKey,
    objectLocatorToken,
  };
}

/** Recovers the content-addressed identity from a stored private object key. */
export function parseClientExportObjectKeyV1(tenantValue: string, objectKey: string) {
  const tenantId = tenantIdV1(tenantValue);
  const prefix = `tenants/${tenantId}/client-exports/${CLIENT_EXPORT_ARTIFACT_KIND_V1}/`;
  if (typeof objectKey !== "string" || !objectKey.startsWith(prefix)) {
    throw new TypeError("Client export object key is invalid.");
  }
  const remainder = objectKey.slice(prefix.length).split("/");
  if (remainder.length !== 3 || remainder[1] !== "g" || !remainder[0] || !remainder[2]) {
    throw new TypeError("Client export object key is invalid.");
  }
  const contentDigest = digestV1(remainder[0], "Client export content digest");
  const objectLocatorToken = immutableObjectLocatorTokenV1(remainder[2]);
  return { contentDigest, objectLocatorToken } as const;
}

export function sameClientExportArtifactReceiptV1(
  left: ClientExportArtifactReceiptV1,
  right: ClientExportArtifactReceiptV1,
) {
  return (
    left.byteSize === right.byteSize &&
    left.contentDigest === right.contentDigest &&
    left.etag === right.etag &&
    left.mediaType === right.mediaType &&
    left.objectKey === right.objectKey &&
    left.objectLocatorToken === right.objectLocatorToken
  );
}

/**
 * Editor Document lineage recorded with the publication. The document
 * reference is the exact identity `(tenant, project, documentKey, epoch)`;
 * `documentRevision` is validated against the locked document row in the
 * acceptance transaction and deliberately has no foreign key to
 * `editor_edit_events` because revision zero has no event row (ADR 0005).
 */
export type ClientExportLineageV1 = Readonly<{
  documentEpoch: string;
  documentKey: string;
  documentRevision: bigint;
  encoderEvidence: BrowserWebCodecsEncoderEvidenceV1;
  encoderEvidenceVersion: typeof CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1;
  exportProfileHash: string;
  producerKind: typeof CLIENT_EXPORT_PRODUCER_KIND_V1;
  sceneContractVersion: typeof CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1;
  sceneRevisionHash: string;
}>;

export function parseClientExportLineageV1(value: unknown): ClientExportLineageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Client export lineage is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.documentKey !== "string" ||
    !SHA256.test(candidate.documentKey) ||
    typeof candidate.documentEpoch !== "string" ||
    !UUID.test(candidate.documentEpoch) ||
    typeof candidate.documentRevision !== "bigint" ||
    candidate.documentRevision < 0n ||
    candidate.documentRevision > MAX_EDITOR_DOCUMENT_REVISION_V1 ||
    candidate.sceneContractVersion !== CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1 ||
    candidate.producerKind !== CLIENT_EXPORT_PRODUCER_KIND_V1 ||
    candidate.encoderEvidenceVersion !== CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1
  ) {
    throw new TypeError("Client export lineage is invalid.");
  }
  const evidence = browserWebCodecsEncoderEvidenceSchemaV1.safeParse(candidate.encoderEvidence);
  if (!evidence.success) throw new TypeError("Client export encoder evidence is invalid.");
  let evidenceJson: string;
  try {
    evidenceJson = canonicalJsonV1(evidence.data);
  } catch {
    throw new TypeError("Client export encoder evidence must be canonical JSON.");
  }
  if (Buffer.byteLength(evidenceJson, "utf8") > MAX_CLIENT_EXPORT_ENCODER_EVIDENCE_JSON_BYTES_V1) {
    throw new TypeError("Client export encoder evidence exceeds the 16 KiB bound.");
  }
  return {
    documentEpoch: candidate.documentEpoch,
    documentKey: candidate.documentKey,
    documentRevision: candidate.documentRevision,
    encoderEvidence: evidence.data,
    encoderEvidenceVersion: CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
    exportProfileHash: digestV1(candidate.exportProfileHash, "Client export profile hash"),
    producerKind: CLIENT_EXPORT_PRODUCER_KIND_V1,
    sceneContractVersion: CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
    sceneRevisionHash: digestV1(candidate.sceneRevisionHash, "Client export Scene revision hash"),
  };
}

export type ClientExportPublishedArtifactV1 = Readonly<{
  artifactId: string;
  receipt: ClientExportArtifactReceiptV1;
}>;

export type ClientExportPublicationV1 = Readonly<{
  artifact: ClientExportPublishedArtifactV1;
  createdBySubjectId: string;
  expiresAt: Date;
  lineage: ClientExportLineageV1;
  projectId: string;
  publicationId: string;
  publishedAt: Date;
  tenantId: string;
}>;

export type AcceptClientExportPublicationInputV1 = Readonly<{
  artifactId: string;
  createdBySubjectId: string;
  expirationMs: number;
  lineage: ClientExportLineageV1;
  projectId: string;
  publicationId: string;
  receipt: ClientExportArtifactReceiptV1;
  tenantId: string;
}>;

/**
 * Discriminated acceptance outcome. `replayed: true` means the same
 * `publicationId` already carries this exact immutable payload and the stored
 * publication is returned without settling any quota again; `conflict` means
 * the same ID names a different payload (409); refusals are named so the HTTP
 * layer maps them without string matching.
 */
export type AcceptClientExportPublicationResultV1 =
  | Readonly<{ kind: "accepted"; publication: ClientExportPublicationV1; replayed: boolean }>
  | Readonly<{ kind: "conflict"; reason: "payload-mismatch" }>
  | Readonly<{
      kind: "refused";
      reason: "artifact-deleting" | "document-not-found" | "quota-exhausted" | "revision-ahead";
    }>;

/**
 * Replay equivalence covers the complete immutable payload: lineage, artifact
 * content identity, project, and creating subject. The artifact ID, locator
 * token, ETag, and server-assigned expiry are excluded because a legitimate
 * byte-identical retry re-uploads under a fresh locator; the retry's orphan
 * object is reclaimed by the storage-first GC sweep.
 */
export function samePublicationAcceptancePayloadV1(
  stored: ClientExportPublicationV1,
  input: Readonly<{
    createdBySubjectId: string;
    lineage: ClientExportLineageV1;
    projectId: string;
    receipt: Pick<ClientExportArtifactReceiptV1, "byteSize" | "contentDigest">;
  }>,
) {
  return (
    stored.projectId === input.projectId &&
    stored.createdBySubjectId === input.createdBySubjectId &&
    stored.lineage.documentKey === input.lineage.documentKey &&
    stored.lineage.documentEpoch === input.lineage.documentEpoch &&
    stored.lineage.documentRevision === input.lineage.documentRevision &&
    stored.lineage.sceneRevisionHash === input.lineage.sceneRevisionHash &&
    stored.lineage.exportProfileHash === input.lineage.exportProfileHash &&
    canonicalJsonV1(stored.lineage.encoderEvidence) === canonicalJsonV1(input.lineage.encoderEvidence) &&
    stored.artifact.receipt.contentDigest === input.receipt.contentDigest &&
    stored.artifact.receipt.byteSize === input.receipt.byteSize
  );
}

export type ClientExportReadClaimV1 = Readonly<{
  artifact: ClientExportPublishedArtifactV1;
  claimExpiresAt: Date;
  claimId: string;
}>;

export type ClientExportDeletionV1 = Readonly<{
  deletionId: string;
  receipt: ClientExportArtifactReceiptV1;
  tenantId: string;
}>;

export type ClientExportObjectV1 = Readonly<{
  lastModified: Date;
  receipt: ClientExportArtifactReceiptV1;
}>;

export type ClientExportObjectPageV1 = Readonly<{
  nextCursor: string | null;
  objects: readonly ClientExportObjectV1[];
}>;

export interface ClientExportRepositoryV1 {
  acceptPublication(
    input: AcceptClientExportPublicationInputV1,
    signal?: AbortSignal,
  ): Promise<AcceptClientExportPublicationResultV1>;
  acknowledgeDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  acquirePublicationVideo(
    tenantId: string,
    projectId: string,
    publicationId: string,
    claimDurationMs: number,
    signal?: AbortSignal,
  ): Promise<ClientExportReadClaimV1>;
  close(): Promise<void>;
  isArtifactRetained(tenantId: string, receipt: ClientExportArtifactReceiptV1, signal?: AbortSignal): Promise<boolean>;
  pendingDeletions(tenantId: string, maximum: number, signal?: AbortSignal): Promise<readonly ClientExportDeletionV1[]>;
  queueDeletion(
    tenantId: string,
    receipt: ClientExportArtifactReceiptV1,
    graceMs: number,
    signal?: AbortSignal,
  ): Promise<ClientExportDeletionV1 | null>;
  readPublication(
    tenantId: string,
    projectId: string,
    publicationId: string,
    signal?: AbortSignal,
  ): Promise<ClientExportPublicationV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  releaseReadClaim(tenantId: string, claimId: string, signal?: AbortSignal): Promise<void>;
}

export interface ClientExportArtifactStoreV1 {
  close(): Promise<void>;
  deleteObject(tenantId: string, receipt: ClientExportArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  head(tenantId: string, receipt: ClientExportArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listObjects(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ClientExportObjectPageV1>;
  open(
    tenantId: string,
    receipt: ClientExportArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  put(
    tenantId: string,
    input: Readonly<{ byteSize: number; bytes: Uint8Array; contentDigest: string }>,
    signal?: AbortSignal,
  ): Promise<ClientExportArtifactReceiptV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export function assertClientExportPublicationIdentityV1(
  publication: ClientExportPublicationV1,
  expected: Readonly<{ projectId: string; tenantId: string }>,
) {
  if (
    publication.tenantId !== tenantIdV1(expected.tenantId) ||
    publication.projectId !== projectIdV1(expected.projectId)
  ) {
    throw new TypeError("Client export storage returned a publication outside the authenticated request identity.");
  }
  return publication;
}
