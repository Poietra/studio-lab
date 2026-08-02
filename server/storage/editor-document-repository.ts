import { createHash } from "node:crypto";

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
  canonicalEditProgramSchemaV1,
  manimProjectIdSchema,
  manimSourcePathSchema,
} from "../../src/render-pipeline/contracts";
import type { CanonicalEditProgram } from "../../src/studio/operations";
import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_EDITOR_PROGRAM_BYTES_V1 = 256 * 1024;
export const MAX_EDITOR_EVENT_TAIL_LIMIT_V1 = 256;
export const MAX_EDITOR_REVISION_V1 = 9_223_372_036_854_775_807n;

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

export type EditorDocumentV1 = Readonly<{
  documentKey: string;
  epoch: string;
  openedAt: Date;
  projectId: string;
  revision: bigint;
  sealedAt: Date | null;
  sourceHash: string;
  sourcePath: string;
  tenantId: string;
  updatedAt: Date;
}>;

export type EditorDocumentProjectionV1 = Readonly<{
  programs: readonly CanonicalEditProgram[];
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

export function canonicalEditorProgramV1(value: unknown) {
  const program = canonicalEditProgramSchemaV1.parse(value) as CanonicalEditProgram;
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
  openDocument(input: EditorDocumentOpenInputV1, signal?: AbortSignal): Promise<EditorDocumentOpenResultV1>;
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
