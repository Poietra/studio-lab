import { z } from "zod";

import { editProgramSuggestionSchema, editSuggestionLeafOperationSchema } from "../ai/edit-suggestion-schema";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { INSERT_ENTITY_TYPES } from "../studio/authoring-commands";
import type { ProgramRecord } from "../studio/model";
import { programExecutionCapabilities } from "../studio/operation-registry";
import type { SceneEdit, SceneEditDraft } from "../studio/scene-edit-contract";
import {
  normalizeLegacySceneEditWireAliases,
  sceneEditDraftSchema,
  sceneEditSchema,
} from "../studio/scene-edit-contract";
import type { StudioTool } from "../studio/studio-toolbar";
import type { InteractionMode } from "../studio/studio-viewport";
import { deepStrictWireSchemaV1 } from "./deep-strict-wire-schema";

export const EDITOR_SESSION_SNAPSHOT_VERSION_V1 = 1 as const;
export const MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1 = 384 * 1024;

export type AppliedProgramMetadata = Readonly<{
  operation: EditSuggestionOperation | null;
  selection: readonly string[];
}>;

export type AcceptedProgramRecord = Readonly<{
  program: SceneEdit;
  validation: Readonly<{
    issues: ProgramRecord["validation"]["issues"];
    status: "valid";
  }>;
}>;

export type DraftProgramRecord = Readonly<{
  program: SceneEditDraft;
  validation: ProgramRecord["validation"];
}>;

export type EditorProgramRecord = AcceptedProgramRecord &
  Readonly<{
    editorMetadata?: AppliedProgramMetadata;
  }>;

export type DraftEditorProgramRecord = DraftProgramRecord &
  Readonly<{
    editorMetadata?: AppliedProgramMetadata;
  }>;

export type AppliedProgramMutation =
  | Readonly<{
      index: number;
      kind: "append";
      value: EditorProgramRecord;
    }>
  | Readonly<{
      index: number;
      kind: "replace";
      previous: EditorProgramRecord;
      value: EditorProgramRecord;
    }>;

export type AppliedProgramEdit = Readonly<{
  index: number;
  original: EditorProgramRecord;
}>;

export type RedoProgramEntry =
  | Readonly<{
      edit: AppliedProgramEdit | null;
      kind: "draft";
      value: DraftEditorProgramRecord;
    }>
  | Readonly<{
      kind: "mutation";
      mutation: AppliedProgramMutation;
    }>;

/**
 * Subject-private editor state that is safe to persist and resume. Transient
 * errors, instructions, and in-progress text inputs are intentionally absent.
 */
export type EditorSessionSnapshotV1 = Readonly<{
  appliedPrograms: readonly EditorProgramRecord[];
  currentTime: number;
  draftOperation: EditSuggestionOperation | null;
  draftProgram: DraftEditorProgramRecord | null;
  editingAppliedProgram: AppliedProgramEdit | null;
  insertTool: StudioTool;
  interactionMode: InteractionMode;
  lockedEntityIds?: readonly string[];
  motionDuration: number;
  programUndoEntries: readonly AppliedProgramMutation[];
  redoPrograms: readonly RedoProgramEntry[];
  selectedObjectIds: readonly string[];
  verifiedSourceDurationBasis: Readonly<{ duration: number; sessionKey: string }> | null;
}>;

const finiteNumber = z.number().finite();
const boundedId = z.string().min(1).max(512);
const validationIssueSchema = z
  .object({
    code: z.enum([
      "anchor-invalid",
      "cycle",
      "identity-unknown",
      "interval-invalid",
      "lifetime-unknown",
      "lowering-unsupported",
      "operation-count",
      "parallel-conflict",
      "provisional-id-invalid",
      "schema-invalid",
      "style-profile-deviation",
      "target-missing",
    ]),
    field: z.string().max(256),
    message: z.string().max(2_000),
    operationId: boundedId.optional(),
    severity: z.enum(["error", "warning"]),
  })
  .strict();
const draftProgramRecordSchema = z
  .object({
    program: sceneEditDraftSchema,
    validation: z
      .object({
        issues: z.array(validationIssueSchema).max(256),
        status: z.enum(["invalid", "valid"]),
      })
      .strict(),
  })
  .strict();
const acceptedProgramRecordSchema = z
  .object({
    program: sceneEditSchema,
    validation: z
      .object({
        issues: z.array(validationIssueSchema).max(256),
        status: z.literal("valid"),
      })
      .strict(),
  })
  .strict();
const editSuggestionOperationSchema = z.union([editSuggestionLeafOperationSchema, editProgramSuggestionSchema]);
const selectionSchema = z.array(boundedId).max(256);
const appliedProgramMetadataSchema = z
  .object({
    operation: editSuggestionOperationSchema.nullable(),
    selection: selectionSchema,
  })
  .strict();
const acceptedEditorProgramRecordSchema = acceptedProgramRecordSchema
  .safeExtend({
    editorMetadata: appliedProgramMetadataSchema.optional(),
  })
  .strict();
const draftEditorProgramRecordSchema = draftProgramRecordSchema
  .safeExtend({
    editorMetadata: appliedProgramMetadataSchema.optional(),
  })
  .strict();
const mutationIndexSchema = z.number().int().min(0).max(31);
const appliedProgramMutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      index: mutationIndexSchema,
      kind: z.literal("append"),
      value: acceptedEditorProgramRecordSchema,
    })
    .strict(),
  z
    .object({
      index: mutationIndexSchema,
      kind: z.literal("replace"),
      previous: acceptedEditorProgramRecordSchema,
      value: acceptedEditorProgramRecordSchema,
    })
    .strict(),
]);
const appliedProgramEditSchema = z
  .object({
    index: mutationIndexSchema,
    original: acceptedEditorProgramRecordSchema,
  })
  .strict();
const redoProgramEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      edit: appliedProgramEditSchema.nullable(),
      kind: z.literal("draft"),
      value: draftEditorProgramRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("mutation"),
      mutation: appliedProgramMutationSchema,
    })
    .strict(),
]);

function canonicalJsonByteSizeV1(value: unknown) {
  return new TextEncoder().encode(canonicalJsonV1(value)).byteLength;
}

const editorSessionSnapshotBaseSchemaV1 = z
  .object({
    appliedPrograms: z.array(acceptedEditorProgramRecordSchema).max(32),
    currentTime: finiteNumber.nonnegative().max(86_400),
    draftOperation: editSuggestionOperationSchema.nullable(),
    draftProgram: draftEditorProgramRecordSchema.nullable(),
    editingAppliedProgram: appliedProgramEditSchema.nullable(),
    insertTool: z.enum(["select", ...INSERT_ENTITY_TYPES]),
    interactionMode: z.enum(["animate", "position"]),
    lockedEntityIds: selectionSchema.optional().default([]),
    motionDuration: finiteNumber.min(0.1).max(600),
    programUndoEntries: z.array(appliedProgramMutationSchema).max(32),
    redoPrograms: z.array(redoProgramEntrySchema).max(32),
    selectedObjectIds: selectionSchema,
    verifiedSourceDurationBasis: z
      .object({
        duration: finiteNumber.min(0.1).max(86_400),
        sessionKey: z.string().min(1).max(512),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.draftOperation && !snapshot.draftProgram) {
      context.addIssue({
        code: "custom",
        message: "A persisted draft operation requires a persisted draft program.",
        path: ["draftOperation"],
      });
    }
    if (snapshot.editingAppliedProgram && !snapshot.draftProgram) {
      context.addIssue({
        code: "custom",
        message: "A persisted Applied Program edit requires a persisted draft program.",
        path: ["editingAppliedProgram"],
      });
    }
    const transactionIds = new Set<string>();
    snapshot.appliedPrograms.forEach((record, index) => {
      const transactionId = record.program.transactionId;
      if (transactionIds.has(transactionId)) {
        context.addIssue({
          code: "custom",
          message: "Applied Program transaction identities must be unique.",
          path: ["appliedPrograms", index, "program", "transactionId"],
        });
      }
      transactionIds.add(transactionId);
    });
    const edit = snapshot.editingAppliedProgram;
    if (edit) {
      const applied = snapshot.appliedPrograms[edit.index];
      if (
        !applied ||
        applied.program.transactionId !== edit.original.program.transactionId ||
        snapshot.draftProgram?.program.transactionId !== edit.original.program.transactionId
      ) {
        context.addIssue({
          code: "custom",
          message: "The persisted Applied Program edit no longer matches its transaction.",
          path: ["editingAppliedProgram"],
        });
      }
    }
    if (canonicalJsonByteSizeV1(snapshot) > MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1) {
      context.addIssue({
        code: "custom",
        message: `Editor session snapshots accept at most ${MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1} UTF-8 canonical JSON bytes.`,
      });
    }
  });

export const editorSessionSnapshotSchemaV1 = z.preprocess(
  normalizeLegacySceneEditWireAliases,
  deepStrictWireSchemaV1(editorSessionSnapshotBaseSchemaV1),
);

export function parseEditorSessionSnapshotV1(value: unknown): EditorSessionSnapshotV1 {
  const snapshot = editorSessionSnapshotSchemaV1.parse(value);
  const blockedIndex = snapshot.appliedPrograms.findIndex(
    (record) => programExecutionCapabilities(record.program).apply !== "supported",
  );
  if (blockedIndex >= 0) {
    throw new TypeError(
      `Only valid, truthfully applicable Programs may be restored as applied (appliedPrograms[${blockedIndex}]).`,
    );
  }
  return snapshot;
}

export function canonicalEditorSessionSnapshotJsonV1(value: unknown) {
  return canonicalJsonV1(parseEditorSessionSnapshotV1(value));
}

export function editorSessionSnapshotByteSizeV1(value: unknown) {
  return new TextEncoder().encode(canonicalEditorSessionSnapshotJsonV1(value)).byteLength;
}
