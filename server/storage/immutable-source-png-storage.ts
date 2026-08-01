import { manimProjectIdSchema } from "../../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  type ImmutableObjectLocatorV1,
  immutableObjectKeyV1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";
import { MAX_PROJECT_PNG_BYTES_V1, projectPngObjectKeyV1 } from "./project-png-storage";
import { MAX_MANIM_SOURCE_BYTES_V1 } from "./workspace-source-repository";

const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_ETAG_UTF8_BYTES_V1 = 512;

export type ImmutableSourceBlobReceiptV1 = ImmutableObjectLocatorV1 &
  Readonly<{
    byteSize: number;
    digest: string;
    etag: string;
  }>;

export type ImmutableProjectPngReceiptV1 = ImmutableObjectLocatorV1 &
  Readonly<{
    byteSize: number;
    digest: string;
    etag: string;
  }>;

export type ImmutableSourceBlobOrphanCandidateV1 = Readonly<{
  lastModified: Date;
  receipt: ImmutableSourceBlobReceiptV1;
}>;

export type ImmutableProjectPngOrphanCandidateV1 = Readonly<{
  lastModified: Date;
  projectId: string;
  receipt: ImmutableProjectPngReceiptV1;
}>;

export type ImmutableSourceBlobOrphanPageV1 = Readonly<{
  candidates: readonly ImmutableSourceBlobOrphanCandidateV1[];
  nextCursor: string | null;
}>;

export type ImmutableProjectPngOrphanPageV1 = Readonly<{
  candidates: readonly ImmutableProjectPngOrphanCandidateV1[];
  nextCursor: string | null;
}>;

/** Provider-neutral input pin that can be persisted by a later render-session migration. */
export type ImmutableRenderInputLocatorV1 =
  | Readonly<{
      kind: "source-blob";
      receipt: ImmutableSourceBlobReceiptV1;
    }>
  | Readonly<{
      kind: "project-png";
      projectId: string;
      receipt: ImmutableProjectPngReceiptV1;
    }>;

export interface ImmutableSourceContentBlobStoreV1 {
  close(): Promise<void>;
  deleteObject(tenantId: string, receipt: ImmutableSourceBlobReceiptV1, signal?: AbortSignal): Promise<void>;
  headSource(tenantId: string, receipt: ImmutableSourceBlobReceiptV1, signal?: AbortSignal): Promise<void>;
  listOrphanCandidates(
    tenantId: string,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ImmutableSourceBlobOrphanPageV1>;
  putSource(tenantId: string, source: string, signal?: AbortSignal): Promise<ImmutableSourceBlobReceiptV1>;
  readSource(tenantId: string, receipt: ImmutableSourceBlobReceiptV1, signal?: AbortSignal): Promise<string>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export interface ImmutableProjectPngBlobStoreV1 {
  close(): Promise<void>;
  deleteObject(
    tenantId: string,
    projectId: string,
    receipt: ImmutableProjectPngReceiptV1,
    signal?: AbortSignal,
  ): Promise<void>;
  head(tenantId: string, projectId: string, receipt: ImmutableProjectPngReceiptV1, signal?: AbortSignal): Promise<void>;
  listOrphanCandidates(
    tenantId: string,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ImmutableProjectPngOrphanPageV1>;
  put(
    tenantId: string,
    projectId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ImmutableProjectPngReceiptV1>;
  read(
    tenantId: string,
    projectId: string,
    receipt: ImmutableProjectPngReceiptV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

function exactKeys(candidate: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(candidate).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function tenantIdV1(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable object tenant ID is invalid.");
  return parsed.data;
}

function projectIdV1(value: unknown) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable project ID is invalid.");
  return parsed.data;
}

function digestV1(value: unknown) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError("Immutable object digest is invalid.");
  return value;
}

function byteSizeV1(value: unknown, maximum: number, minimum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError("Immutable object byte size is invalid.");
  }
  return value as number;
}

function etagV1(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_ETAG_UTF8_BYTES_V1
  ) {
    throw new TypeError("Immutable object ETag is invalid.");
  }
  return value;
}

function recordV1(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

export function sourceBlobContentAddressedKeyV1(tenantValue: unknown, digestValue: unknown) {
  const tenantId = tenantIdV1(tenantValue);
  const digest = digestV1(digestValue);
  return `${immutableSourceBlobFamilyPrefixV1(tenantId)}${digest}`;
}

export function immutableSourceBlobFamilyPrefixV1(tenantValue: unknown) {
  return `tenants/${tenantIdV1(tenantValue)}/sources/`;
}

export function immutableProjectPngFamilyPrefixV1(tenantValue: unknown) {
  return `tenants/${tenantIdV1(tenantValue)}/projects/`;
}

export function immutableSourceBlobObjectKeyV1(tenantValue: unknown, digestValue: unknown, objectGeneration: unknown) {
  const tenantId = tenantIdV1(tenantValue);
  const contentDigest = digestV1(digestValue);
  return immutableObjectKeyV1({
    contentAddressedKey: sourceBlobContentAddressedKeyV1(tenantId, contentDigest),
    contentDigest,
    objectGeneration: objectGeneration as string,
    tenantId,
  });
}

export function immutableProjectPngObjectKeyV1(
  tenantValue: unknown,
  projectValue: unknown,
  digestValue: unknown,
  objectGeneration: unknown,
) {
  const tenantId = tenantIdV1(tenantValue);
  const projectId = projectIdV1(projectValue);
  const contentDigest = digestV1(digestValue);
  return immutableObjectKeyV1({
    contentAddressedKey: projectPngObjectKeyV1(tenantId, projectId, contentDigest),
    contentDigest,
    objectGeneration: objectGeneration as string,
    tenantId,
  });
}

export function parseImmutableSourceBlobObjectKeyV1(tenantValue: unknown, value: unknown) {
  const tenantId = tenantIdV1(tenantValue);
  if (typeof value !== "string") throw new TypeError("Immutable source object key is invalid.");
  const prefix = immutableSourceBlobFamilyPrefixV1(tenantId);
  const parts = value.startsWith(prefix) ? value.slice(prefix.length).split("/") : [];
  if (parts.length !== 3 || parts[1] !== "g") throw new TypeError("Immutable source object key is invalid.");
  const digest = digestV1(parts[0]);
  const objectKey = immutableSourceBlobObjectKeyV1(tenantId, digest, parts[2]);
  if (objectKey !== value) throw new TypeError("Immutable source object key is invalid.");
  return { digest, objectGeneration: parts[2]!, objectKey } as const;
}

export function parseImmutableProjectPngObjectKeyV1(tenantValue: unknown, value: unknown) {
  const tenantId = tenantIdV1(tenantValue);
  if (typeof value !== "string") throw new TypeError("Immutable project image.png object key is invalid.");
  const prefix = immutableProjectPngFamilyPrefixV1(tenantId);
  const parts = value.startsWith(prefix) ? value.slice(prefix.length).split("/") : [];
  if (parts.length !== 6 || parts[1] !== "assets" || parts[2] !== "image.png" || parts[4] !== "g") {
    throw new TypeError("Immutable project image.png object key is invalid.");
  }
  const projectId = projectIdV1(parts[0]);
  const digest = digestV1(parts[3]);
  const objectKey = immutableProjectPngObjectKeyV1(tenantId, projectId, digest, parts[5]);
  if (objectKey !== value) throw new TypeError("Immutable project image.png object key is invalid.");
  return { digest, objectGeneration: parts[5]!, objectKey, projectId } as const;
}

export function parseImmutableSourceBlobReceiptV1(tenantValue: unknown, value: unknown): ImmutableSourceBlobReceiptV1 {
  const tenantId = tenantIdV1(tenantValue);
  const candidate = recordV1(value, "Immutable source blob receipt");
  exactKeys(
    candidate,
    ["byteSize", "digest", "etag", "objectGeneration", "objectKey"],
    "Immutable source blob receipt",
  );
  const digest = digestV1(candidate.digest);
  const locator = parseImmutableObjectLocatorV1(
    {
      contentAddressedKey: sourceBlobContentAddressedKeyV1(tenantId, digest),
      contentDigest: digest,
      tenantId,
    },
    candidate,
  );
  return {
    byteSize: byteSizeV1(candidate.byteSize, MAX_MANIM_SOURCE_BYTES_V1, 0),
    digest,
    etag: etagV1(candidate.etag),
    ...locator,
  };
}

export function parseImmutableProjectPngReceiptV1(
  tenantValue: unknown,
  projectValue: unknown,
  value: unknown,
): ImmutableProjectPngReceiptV1 {
  const tenantId = tenantIdV1(tenantValue);
  const projectId = projectIdV1(projectValue);
  const candidate = recordV1(value, "Immutable project image.png receipt");
  exactKeys(
    candidate,
    ["byteSize", "digest", "etag", "objectGeneration", "objectKey"],
    "Immutable project image.png receipt",
  );
  const digest = digestV1(candidate.digest);
  const locator = parseImmutableObjectLocatorV1(
    {
      contentAddressedKey: projectPngObjectKeyV1(tenantId, projectId, digest),
      contentDigest: digest,
      tenantId,
    },
    candidate,
  );
  return {
    byteSize: byteSizeV1(candidate.byteSize, MAX_PROJECT_PNG_BYTES_V1, 1),
    digest,
    etag: etagV1(candidate.etag),
    ...locator,
  };
}

export function parseImmutableRenderInputLocatorV1(
  tenantValue: unknown,
  value: unknown,
): ImmutableRenderInputLocatorV1 {
  const tenantId = tenantIdV1(tenantValue);
  const candidate = recordV1(value, "Immutable render input locator");
  if (candidate.kind === "source-blob") {
    exactKeys(candidate, ["kind", "receipt"], "Immutable render input locator");
    return { kind: "source-blob", receipt: parseImmutableSourceBlobReceiptV1(tenantId, candidate.receipt) };
  }
  if (candidate.kind === "project-png") {
    exactKeys(candidate, ["kind", "projectId", "receipt"], "Immutable render input locator");
    const projectId = projectIdV1(candidate.projectId);
    return {
      kind: "project-png",
      projectId,
      receipt: parseImmutableProjectPngReceiptV1(tenantId, projectId, candidate.receipt),
    };
  }
  throw new TypeError("Immutable render input locator is invalid.");
}
