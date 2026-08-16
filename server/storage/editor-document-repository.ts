import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { type EditorEditMutationV1, parseEditorEditMutationV1 } from "../../src/collaboration/editor-edit-mutation";
import {
  canonicalEditorSessionSnapshotJsonV1,
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  type EditorSessionSnapshotV1,
  parseEditorSessionSnapshotV1,
} from "../../src/collaboration/editor-session-contract";
import { canonicalJsonV1 } from "../../src/engine/fast-manim-snapshot-digest";
import { sha256V1Schema } from "../../src/engine/primitives";
import {
  manimProjectIdSchema,
  manimProjectNameSchema,
  manimSourcePathSchema,
} from "../../src/render-pipeline/contracts";
import { sceneEditSchema as canonicalEditProgramSchemaV1, type SceneEdit } from "../../src/studio/scene-edit-contract";
import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_EDITOR_PROGRAM_BYTES_V1 = 256 * 1024;
export const MAX_EDITOR_EVENT_TAIL_LIMIT_V1 = 256;
export const MAX_EDITOR_REVISION_V1 = 9_223_372_036_854_775_807n;
export const NATIVE_EDITOR_DOCUMENT_KEY_BYTES_V1 = 32;

/**
 * Closed document-origin union per ADR 0005: source binding is an origin
 * property, not part of every document's identity.
 */
export const EDITOR_DOCUMENT_ORIGINS_V1 = Object.freeze(["imported-manim", "studio-native"] as const);
export type EditorDocumentOriginV1 = (typeof EDITOR_DOCUMENT_ORIGINS_V1)[number];

const editorSceneIdSchemaV1 = z
  .string()
  .regex(/^scene:[0-9a-f]{64}$/u, "Scene ID must be a canonical lower-case SHA-256 identity.");
const editorDocumentKeySchemaV1 = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Editor document key must be a lower-case SHA-256 digest.");
const editorRevisionSchemaV1 = z.bigint().min(0n).max(MAX_EDITOR_REVISION_V1);
const editorSessionBaseGenerationSchemaV1 = z
  .bigint()
  .min(0n)
  .max(MAX_EDITOR_REVISION_V1 - 1n);
const editorUuidSchemaV1 = z.uuid();

const editorSessionUpdateSchemaV1 = z
  .object({
    documentRevision: editorRevisionSchemaV1,
    expectedSessionGeneration: editorSessionBaseGenerationSchemaV1,
    snapshot: z.unknown(),
    snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
  })
  .strict();

const editorDocumentOpenInputSchemaV1 = z
  .object({
    projectId: manimProjectIdSchema,
    sceneId: editorSceneIdSchemaV1,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    tenantId: manimTenantIdSchema,
  })
  .strict();

const editorDocumentNativeCreateInputSchemaV1 = z
  .object({
    name: manimProjectNameSchema,
    projectId: manimProjectIdSchema,
    tenantId: manimTenantIdSchema,
  })
  .strict();

const editorDocumentNativeOpenInputSchemaV1 = z
  .object({
    projectId: manimProjectIdSchema,
    tenantId: manimTenantIdSchema,
  })
  .strict();

const editorDocumentCommitInputSchemaV1 = z
  .object({
    baseRevision: editorRevisionSchemaV1,
    clientMutationId: editorUuidSchemaV1,
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorUuidSchemaV1,
    mutation: z.unknown(),
    projectId: manimProjectIdSchema,
    sessionUpdate: editorSessionUpdateSchemaV1.optional(),
    subjectId: editorUuidSchemaV1,
    tenantId: manimTenantIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.sessionUpdate && input.sessionUpdate.documentRevision !== input.baseRevision + 1n) {
      context.addIssue({
        code: "custom",
        message: "An atomic editor session snapshot must name the post-mutation document revision.",
        path: ["sessionUpdate", "documentRevision"],
      });
    }
  });

const editorDocumentTailInputSchemaV1 = z
  .object({
    afterRevision: editorRevisionSchemaV1,
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorUuidSchemaV1,
    limit: z.number().int().min(1).max(MAX_EDITOR_EVENT_TAIL_LIMIT_V1),
    projectId: manimProjectIdSchema,
    tenantId: manimTenantIdSchema,
  })
  .strict();

const editorSessionSnapshotReadInputSchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorUuidSchemaV1,
    projectId: manimProjectIdSchema,
    subjectId: editorUuidSchemaV1,
    tenantId: manimTenantIdSchema,
  })
  .strict();

const editorSessionSnapshotPutInputSchemaV1 = editorSessionSnapshotReadInputSchemaV1
  .safeExtend({
    documentRevision: editorRevisionSchemaV1,
    expectedSessionGeneration: editorSessionBaseGenerationSchemaV1,
    snapshot: z.unknown(),
    snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
  })
  .strict();

export type EditorDocumentOpenInputV1 = Readonly<{
  projectId: string;
  sceneId: string;
  sourceHash: string;
  sourcePath: string;
  tenantId: string;
}>;

export type EditorDocumentCommitInputV1 = Readonly<{
  baseRevision: bigint;
  clientMutationId: string;
  documentKey: string;
  epoch: string;
  mutation: EditorEditMutationV1;
  projectId: string;
  sessionUpdate?: EditorSessionUpdateV1;
  subjectId: string;
  tenantId: string;
}>;

export type EditorSessionUpdateV1 = Readonly<{
  documentRevision: bigint;
  expectedSessionGeneration: bigint;
  snapshot: EditorSessionSnapshotV1;
  snapshotVersion: typeof EDITOR_SESSION_SNAPSHOT_VERSION_V1;
}>;

export type EditorSessionSnapshotReadInputV1 = Readonly<{
  documentKey: string;
  epoch: string;
  projectId: string;
  subjectId: string;
  tenantId: string;
}>;

export type EditorSessionSnapshotPutInputV1 = EditorSessionSnapshotReadInputV1 & EditorSessionUpdateV1;

export type EditorSessionSnapshotRecordV1 = Readonly<{
  documentKey: string;
  documentRevision: bigint;
  epoch: string;
  projectId: string;
  sessionGeneration: bigint;
  snapshot: EditorSessionSnapshotV1;
  snapshotByteSize: number;
  snapshotDigest: string;
  snapshotVersion: typeof EDITOR_SESSION_SNAPSHOT_VERSION_V1;
  subjectId: string;
  tenantId: string;
  updatedAt: Date;
}>;

export type EditorSessionSnapshotReadResultV1 =
  | Readonly<{
      kind: "available";
      session: EditorSessionSnapshotRecordV1;
    }>
  | Readonly<{
      currentSessionGeneration: bigint;
      kind: "unavailable";
    }>;

export type EditorSessionUpdateEvidenceV1 = Readonly<{
  documentRevision: bigint;
  sessionGeneration: bigint;
  snapshotByteSize: number;
  snapshotDigest: string;
  snapshotVersion: typeof EDITOR_SESSION_SNAPSHOT_VERSION_V1;
}>;

export type EditorDocumentTailInputV1 = Readonly<{
  afterRevision: bigint;
  documentKey: string;
  epoch: string;
  limit: number;
  projectId: string;
  tenantId: string;
}>;

/**
 * Origin-conditional source binding. Only the imported compatibility lane
 * carries a Python source path and exact source digest; a Studio-native
 * document carries neither and never infers them from a display label.
 */
export type EditorDocumentSourceBindingV1 =
  | Readonly<{ origin: "imported-manim"; sourceHash: string; sourcePath: string }>
  | Readonly<{ origin: "studio-native"; sourceHash: null; sourcePath: null }>;

export type EditorDocumentV1 = Readonly<{
  documentKey: string;
  epoch: string;
  openedAt: Date;
  projectId: string;
  revision: bigint;
  sealedAt: Date | null;
  tenantId: string;
  updatedAt: Date;
}> &
  EditorDocumentSourceBindingV1;

export type ImportedEditorDocumentV1 = Extract<EditorDocumentV1, { origin: "imported-manim" }>;

export type EditorDocumentNativeCreateInputV1 = Readonly<{
  name: string;
  projectId: string;
  tenantId: string;
}>;

export type EditorDocumentNativeCreateResultV1 = Readonly<{
  document: EditorDocumentV1;
  kind: "created";
  project: Readonly<{ name: string; projectId: string; tenantId: string }>;
  projection: EditorDocumentProjectionV1;
}>;

export type EditorDocumentNativeOpenInputV1 = Readonly<{
  projectId: string;
  tenantId: string;
}>;

export type EditorDocumentNativeHeadV1 = Readonly<{
  documentKey: string;
  epoch: string;
  revision: bigint;
}>;

export type EditorDocumentProjectionV1 = Readonly<{
  programs: readonly SceneEdit[];
  revision: bigint;
}>;

export type EditorEditEventV1 = Readonly<{
  baseRevision: bigint;
  clientMutationId: string;
  committedAt: Date;
  documentKey: string;
  byteSize: number;
  digest: string;
  epoch: string;
  mutation: EditorEditMutationV1;
  projectId: string;
  revision: bigint;
  subjectId: string;
  tenantId: string;
}>;

export type EditorDocumentOpenResultV1 =
  | Readonly<{
      created: boolean;
      document: EditorDocumentV1;
      kind: "opened";
      projection: EditorDocumentProjectionV1;
    }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ currentSourceHash: string; kind: "source-conflict" }>;

export type EditorDocumentCommitConflictReasonV1 =
  | "document-sealed"
  | "forbidden"
  | "invalid-mutation"
  | "mutation-reused"
  | "not-found"
  | "projection-mismatch"
  | "revision-mismatch"
  | "session-generation-mismatch"
  | "source-changed";

export type EditorDocumentCommitResultV1 =
  | Readonly<{
      document: EditorDocumentV1;
      event: EditorEditEventV1;
      kind: "committed";
      replayed: boolean;
      sessionUpdate?: EditorSessionUpdateEvidenceV1;
    }>
  | Readonly<{
      currentRevision?: bigint;
      currentSessionGeneration?: bigint;
      kind: "conflict";
      reason: EditorDocumentCommitConflictReasonV1;
    }>;

export type EditorSessionSnapshotConflictReasonV1 =
  | "document-sealed"
  | "epoch-mismatch"
  | "forbidden"
  | "not-found"
  | "projection-mismatch"
  | "revision-mismatch"
  | "session-generation-mismatch"
  | "source-changed";

export type EditorSessionSnapshotPutResultV1 =
  | Readonly<{
      kind: "stored";
      replayed: boolean;
      session: EditorSessionSnapshotRecordV1;
    }>
  | Readonly<{
      currentDocumentRevision?: bigint;
      currentSessionGeneration?: bigint;
      kind: "conflict";
      reason: EditorSessionSnapshotConflictReasonV1;
    }>;

export type EditorDocumentTailResultV1 = Readonly<{
  document: EditorDocumentV1;
  events: readonly EditorEditEventV1[];
}> | null;

export function createEditorDocumentKeyV1(sourcePathValue: string, sceneIdValue: string) {
  const sourcePath = manimSourcePathSchema.parse(sourcePathValue);
  const sceneId = editorSceneIdSchemaV1.parse(sceneIdValue);
  const digest = createHash("sha256")
    .update(`poietra.editor-document.v1\0${sourcePath}\0${sceneId}`, "utf8")
    .digest("hex");
  return digest;
}

/**
 * Mints the existing opaque 32-byte `documentKey` for a Studio-native document
 * with a server-side CSPRNG and returns its lower-hex transport form. Per ADR
 * 0005 the key is generated once, is never derived from a source path, Scene
 * name, source digest, or display name, and no second document-ID column
 * exists beside it. The deterministic source-derived key shape above remains
 * exclusive to the imported compatibility lane.
 */
export function mintNativeEditorDocumentKeyV1(randomBytesV1: (size: number) => Buffer = randomBytes) {
  const bytes = randomBytesV1(NATIVE_EDITOR_DOCUMENT_KEY_BYTES_V1);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== NATIVE_EDITOR_DOCUMENT_KEY_BYTES_V1) {
    throw new TypeError(
      `A native editor document key requires exactly ${NATIVE_EDITOR_DOCUMENT_KEY_BYTES_V1} cryptographically random bytes.`,
    );
  }
  return editorDocumentKeySchemaV1.parse(bytes.toString("hex"));
}

export function canonicalEditorProgramV1(value: unknown) {
  const program = canonicalEditProgramSchemaV1.parse(value) as SceneEdit;
  const canonicalJson = canonicalJsonV1(program);
  const byteSize = Buffer.byteLength(canonicalJson, "utf8");
  if (byteSize > MAX_EDITOR_PROGRAM_BYTES_V1) {
    throw new TypeError(`Canonical Editor Programs accept at most ${MAX_EDITOR_PROGRAM_BYTES_V1} UTF-8 bytes.`);
  }
  return {
    byteSize,
    digest: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    json: canonicalJson,
    program,
  } as const;
}

/**
 * Canonicalizes the mutation while retaining the v17 program-only evidence
 * seal. Mutation kind and target are persisted separately by v18.
 */
export function canonicalEditorMutationV1(value: unknown) {
  const mutation = parseEditorEditMutationV1(value);
  return { ...canonicalEditorProgramV1(mutation.program), mutation } as const;
}

export function canonicalEditorSessionSnapshotV1(value: unknown) {
  const snapshot = parseEditorSessionSnapshotV1(value);
  const json = canonicalEditorSessionSnapshotJsonV1(snapshot);
  const byteSize = Buffer.byteLength(json, "utf8");
  return {
    byteSize,
    digest: createHash("sha256").update(json, "utf8").digest("hex"),
    json,
    snapshot,
  } as const;
}

export function parseEditorDocumentOpenInputV1(value: unknown): EditorDocumentOpenInputV1 {
  return editorDocumentOpenInputSchemaV1.parse(value);
}

export function parseEditorDocumentNativeCreateInputV1(value: unknown): EditorDocumentNativeCreateInputV1 {
  return editorDocumentNativeCreateInputSchemaV1.parse(value);
}

export function parseEditorDocumentNativeOpenInputV1(value: unknown): EditorDocumentNativeOpenInputV1 {
  return editorDocumentNativeOpenInputSchemaV1.parse(value);
}

export function parseEditorDocumentCommitInputV1(value: unknown): EditorDocumentCommitInputV1 {
  const parsed = editorDocumentCommitInputSchemaV1.parse(value);
  const { sessionUpdate, ...base } = parsed;
  const mutation = canonicalEditorMutationV1(parsed.mutation).mutation;
  if (!sessionUpdate) return { ...base, mutation };
  return {
    ...base,
    mutation,
    sessionUpdate: {
      ...sessionUpdate,
      snapshot: canonicalEditorSessionSnapshotV1(sessionUpdate.snapshot).snapshot,
    },
  };
}

export function parseEditorDocumentTailInputV1(value: unknown): EditorDocumentTailInputV1 {
  return editorDocumentTailInputSchemaV1.parse(value);
}

export function parseEditorSessionSnapshotReadInputV1(value: unknown): EditorSessionSnapshotReadInputV1 {
  return editorSessionSnapshotReadInputSchemaV1.parse(value);
}

export function parseEditorSessionSnapshotPutInputV1(value: unknown): EditorSessionSnapshotPutInputV1 {
  const parsed = editorSessionSnapshotPutInputSchemaV1.parse(value);
  return { ...parsed, snapshot: canonicalEditorSessionSnapshotV1(parsed.snapshot).snapshot };
}

export interface EditorDocumentRepositoryV1 {
  close(): Promise<void>;
  commitMutation(input: EditorDocumentCommitInputV1, signal?: AbortSignal): Promise<EditorDocumentCommitResultV1>;
  /**
   * Atomically creates a Project together with its Studio-native Editor
   * Document at revision zero and an empty projection, without a
   * `workspace_source_heads` row or any starter `.py` blob.
   */
  createNativeDocument(
    input: EditorDocumentNativeCreateInputV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentNativeCreateResultV1>;
  openDocument(input: EditorDocumentOpenInputV1, signal?: AbortSignal): Promise<EditorDocumentOpenResultV1>;
  /**
   * Opens the project's Studio-native document without any source binding:
   * no source path, no source hash, and no `workspace_source_heads` read. The
   * result never reports `created` (the native document is created with its
   * Project) and never reports a source conflict.
   */
  openNativeDocument(input: EditorDocumentNativeOpenInputV1, signal?: AbortSignal): Promise<EditorDocumentOpenResultV1>;
  /** Lock-free existence probe for the project's open native document. */
  readNativeDocumentHead(
    input: EditorDocumentNativeOpenInputV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentNativeHeadV1 | null>;
  putSessionSnapshot(
    input: EditorSessionSnapshotPutInputV1,
    signal?: AbortSignal,
  ): Promise<EditorSessionSnapshotPutResultV1>;
  readSessionSnapshot(
    input: EditorSessionSnapshotReadInputV1,
    signal?: AbortSignal,
  ): Promise<EditorSessionSnapshotReadResultV1>;
  readEventTail(input: EditorDocumentTailInputV1, signal?: AbortSignal): Promise<EditorDocumentTailResultV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export type {
  EditorEditMutationApplyResultV1,
  EditorEditMutationConflictReasonV1,
  EditorEditMutationV1,
} from "../../src/collaboration/editor-edit-mutation";
export {
  applyEditorEditMutationV1,
  editorEditMutationV1Schema,
  parseAuthoritativeEditorProgramsV1,
  parseEditorEditMutationV1,
} from "../../src/collaboration/editor-edit-mutation";
