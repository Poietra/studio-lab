import { manimProjectIdSchema } from "../../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  createImmutableObjectLocatorTokenV1,
  immutableObjectKeyV1,
  immutableObjectLocatorTokenV1,
} from "./immutable-object-contract";

export const CLIENT_THUMBNAIL_MEDIA_TYPE_V1 = "image/png";
export const CLIENT_THUMBNAIL_PRODUCER_KIND_V1 = "browser-wasm-wgpu";
export const CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1 = "last-representable-in-duration";
export const CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1 = 1;
export const MAX_CLIENT_THUMBNAIL_BYTES_V1 = 4 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class ClientThumbnailReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The client thumbnail object is missing." : "The client thumbnail object is corrupt.");
    this.name = "ClientThumbnailReadErrorV1";
    this.code = code;
  }
}

function tenantIdV1(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client thumbnail tenant ID is invalid.");
  return parsed.data;
}

function projectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client thumbnail project ID is invalid.");
  return parsed.data;
}

function digestV1(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function clientThumbnailIdV1(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function clientThumbnailByteSizeV1(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CLIENT_THUMBNAIL_BYTES_V1) {
    throw new TypeError("Client thumbnail byte size is invalid.");
  }
  return value as number;
}

function etagV1(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 512) {
    throw new TypeError("Client thumbnail ETag is invalid.");
  }
  return value;
}

export function clientThumbnailContentAddressedKeyV1(tenantValue: string, contentDigestValue: string) {
  const tenantId = tenantIdV1(tenantValue);
  const contentDigest = digestV1(contentDigestValue, "Client thumbnail content digest");
  return `tenants/${tenantId}/client-thumbnails/image/${contentDigest}`;
}

export function clientThumbnailObjectKeyV1(tenantValue: string, contentDigest: string, objectLocatorToken: string) {
  return immutableObjectKeyV1({
    contentAddressedKey: clientThumbnailContentAddressedKeyV1(tenantValue, contentDigest),
    contentDigest: digestV1(contentDigest, "Client thumbnail content digest"),
    objectLocatorToken,
    tenantId: tenantIdV1(tenantValue),
  });
}

export function createClientThumbnailArtifactLocatorV1(tenantId: string, contentDigest: string) {
  const objectLocatorToken = createImmutableObjectLocatorTokenV1();
  return {
    objectKey: clientThumbnailObjectKeyV1(tenantId, contentDigest, objectLocatorToken),
    objectLocatorToken,
  } as const;
}

export type ClientThumbnailArtifactReceiptV1 = Readonly<{
  byteSize: number;
  contentDigest: string;
  etag: string;
  mediaType: typeof CLIENT_THUMBNAIL_MEDIA_TYPE_V1;
  objectKey: string;
  objectLocatorToken: string;
}>;

export function parseClientThumbnailArtifactReceiptV1(
  tenantValue: string,
  value: unknown,
): ClientThumbnailArtifactReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Client thumbnail artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const expectedFields = ["byteSize", "contentDigest", "etag", "mediaType", "objectKey", "objectLocatorToken"];
  if (Object.keys(candidate).some((field) => !expectedFields.includes(field))) {
    throw new TypeError("Client thumbnail artifact receipt contains an unknown field.");
  }
  const contentDigest = digestV1(candidate.contentDigest, "Client thumbnail content digest");
  const objectLocatorToken = immutableObjectLocatorTokenV1(candidate.objectLocatorToken);
  const objectKey = clientThumbnailObjectKeyV1(tenantValue, contentDigest, objectLocatorToken);
  if (candidate.mediaType !== CLIENT_THUMBNAIL_MEDIA_TYPE_V1 || candidate.objectKey !== objectKey) {
    throw new TypeError("Client thumbnail artifact receipt is invalid.");
  }
  return {
    byteSize: clientThumbnailByteSizeV1(candidate.byteSize),
    contentDigest,
    etag: etagV1(candidate.etag),
    mediaType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
    objectKey,
    objectLocatorToken,
  };
}

export type ClientThumbnailLineageV1 = Readonly<{
  documentEpoch: string;
  documentKey: string;
  documentRevision: bigint;
  producerKind: typeof CLIENT_THUMBNAIL_PRODUCER_KIND_V1;
  representativeFrameRule: typeof CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1;
  sceneContractVersion: typeof CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1;
  sceneRevisionHash: string;
}>;

export function parseClientThumbnailLineageV1(value: unknown): ClientThumbnailLineageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Client thumbnail lineage is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.documentEpoch !== "string" ||
    !UUID.test(candidate.documentEpoch) ||
    typeof candidate.documentKey !== "string" ||
    !SHA256.test(candidate.documentKey) ||
    typeof candidate.documentRevision !== "bigint" ||
    candidate.documentRevision < 0n ||
    candidate.documentRevision > BigInt(Number.MAX_SAFE_INTEGER) ||
    candidate.producerKind !== CLIENT_THUMBNAIL_PRODUCER_KIND_V1 ||
    candidate.representativeFrameRule !== CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1 ||
    candidate.sceneContractVersion !== CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1
  ) {
    throw new TypeError("Client thumbnail lineage is invalid.");
  }
  return {
    documentEpoch: candidate.documentEpoch,
    documentKey: candidate.documentKey,
    documentRevision: candidate.documentRevision,
    producerKind: CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
    representativeFrameRule: CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
    sceneContractVersion: CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
    sceneRevisionHash: digestV1(candidate.sceneRevisionHash, "Client thumbnail Scene revision hash"),
  };
}

export type ClientThumbnailPublicationV1 = Readonly<{
  artifact: Readonly<{ artifactId: string; receipt: ClientThumbnailArtifactReceiptV1 }>;
  createdBySubjectId: string;
  lineage: ClientThumbnailLineageV1;
  projectId: string;
  publicationId: string;
  publishedAt: Date;
  tenantId: string;
}>;

export type ClientThumbnailHeadV1 = Readonly<{
  current: boolean;
  publication: ClientThumbnailPublicationV1;
}>;

export type AcceptClientThumbnailPublicationInputV1 = Readonly<{
  artifactId: string;
  createdBySubjectId: string;
  lineage: ClientThumbnailLineageV1;
  projectId: string;
  publicationId: string;
  receipt: ClientThumbnailArtifactReceiptV1;
  tenantId: string;
}>;

export type AcceptClientThumbnailPublicationResultV1 =
  | Readonly<{ kind: "accepted"; publication: ClientThumbnailPublicationV1; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused"; reason: "document-not-found" | "document-revision-mismatch" }>;

export function sameClientThumbnailPublicationPayloadV1(
  stored: ClientThumbnailPublicationV1,
  input: Readonly<{
    createdBySubjectId: string;
    lineage: ClientThumbnailLineageV1;
    projectId: string;
    receipt: Pick<ClientThumbnailArtifactReceiptV1, "byteSize" | "contentDigest">;
  }>,
) {
  return (
    stored.projectId === input.projectId &&
    stored.createdBySubjectId === input.createdBySubjectId &&
    stored.lineage.documentEpoch === input.lineage.documentEpoch &&
    stored.lineage.documentKey === input.lineage.documentKey &&
    stored.lineage.documentRevision === input.lineage.documentRevision &&
    stored.lineage.sceneRevisionHash === input.lineage.sceneRevisionHash &&
    stored.artifact.receipt.byteSize === input.receipt.byteSize &&
    stored.artifact.receipt.contentDigest === input.receipt.contentDigest
  );
}

export interface ClientThumbnailRepositoryV1 {
  acceptPublication(
    input: AcceptClientThumbnailPublicationInputV1,
    signal?: AbortSignal,
  ): Promise<AcceptClientThumbnailPublicationResultV1>;
  close(): Promise<void>;
  readHead(tenantId: string, projectId: string, signal?: AbortSignal): Promise<ClientThumbnailHeadV1 | null>;
  readPublication(
    tenantId: string,
    projectId: string,
    publicationId: string,
    signal?: AbortSignal,
  ): Promise<ClientThumbnailPublicationV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export interface ClientThumbnailArtifactStoreV1 {
  close(): Promise<void>;
  deleteObject(tenantId: string, receipt: ClientThumbnailArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  put(
    tenantId: string,
    input: Readonly<{ bytes: Uint8Array; contentDigest: string }>,
    signal?: AbortSignal,
  ): Promise<ClientThumbnailArtifactReceiptV1>;
  read(tenantId: string, receipt: ClientThumbnailArtifactReceiptV1, signal?: AbortSignal): Promise<Buffer>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export function assertClientThumbnailPublicationIdentityV1(
  publication: ClientThumbnailPublicationV1,
  expected: Readonly<{ projectId: string; tenantId: string }>,
) {
  if (
    publication.tenantId !== tenantIdV1(expected.tenantId) ||
    publication.projectId !== projectIdV1(expected.projectId)
  ) {
    throw new TypeError("Client thumbnail storage returned a publication outside the authenticated identity.");
  }
  return publication;
}
