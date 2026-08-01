import { createHash } from "node:crypto";

import { z } from "zod";

import { type EditorEditMutationV1, parseEditorEditMutationV1 } from "../../src/collaboration/editor-edit-mutation";
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
const editorUuidSchemaV1 = z.uuid();

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
    subjectId: editorUuidSchemaV1,
    tenantId: manimTenantIdSchema,
  })
  .strict();

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
  subjectId: string;
  tenantId: string;
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
  | "revision-mismatch"
  | "source-changed";

export type EditorDocumentCommitResultV1 =
  | Readonly<{
      document: EditorDocumentV1;
      event: EditorEditEventV1;
      kind: "committed";
      replayed: boolean;
    }>
  | Readonly<{
      currentRevision?: bigint;
      kind: "conflict";
      reason: EditorDocumentCommitConflictReasonV1;
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

export function parseEditorDocumentOpenInputV1(value: unknown): EditorDocumentOpenInputV1 {
  return editorDocumentOpenInputSchemaV1.parse(value);
}

export function parseEditorDocumentCommitInputV1(value: unknown): EditorDocumentCommitInputV1 {
  const parsed = editorDocumentCommitInputSchemaV1.parse(value);
  return { ...parsed, mutation: canonicalEditorMutationV1(parsed.mutation).mutation };
}

export function parseEditorDocumentTailInputV1(value: unknown): EditorDocumentTailInputV1 {
  return editorDocumentTailInputSchemaV1.parse(value);
}

export interface EditorDocumentRepositoryV1 {
  close(): Promise<void>;
  commitMutation(input: EditorDocumentCommitInputV1, signal?: AbortSignal): Promise<EditorDocumentCommitResultV1>;
  openDocument(input: EditorDocumentOpenInputV1, signal?: AbortSignal): Promise<EditorDocumentOpenResultV1>;
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
