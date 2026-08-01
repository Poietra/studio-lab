import { z } from "zod";

import { editProgramSuggestionSchema, editSuggestionLeafOperationSchema } from "../ai/edit-suggestion-schema";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import type { ProgramRecord } from "../studio/model";
import { canonicalOperationSchema, programExecutionCapabilities } from "../studio/operation-registry";
import type { StudioTool } from "../studio/studio-toolbar";
import type { InteractionMode } from "../studio/studio-viewport";
import { deepStrictWireSchemaV1 } from "./deep-strict-wire-schema";

export const EDITOR_SESSION_SNAPSHOT_VERSION_V1 = 1 as const;
export const MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1 = 384 * 1024;

export type AppliedProgramMetadata = Readonly<{
  operation: EditSuggestionOperation | null;
  selection: readonly string[];
}>;

export type EditorProgramRecord = ProgramRecord &
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
      value: EditorProgramRecord;
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
  draftProgram: ProgramRecord | null;
  editingAppliedProgram: AppliedProgramEdit | null;
  insertTool: StudioTool;
  interactionMode: InteractionMode;
  motionDuration: number;
  programUndoEntries: readonly AppliedProgramMutation[];
  redoPrograms: readonly RedoProgramEntry[];
  selectedObjectIds: readonly string[];
  verifiedSourceDurationBasis: Readonly<{ duration: number; sessionKey: string }> | null;
}>;

const finiteNumber = z.number().finite();
const boundedId = z.string().min(1).max(512);
const evidenceSchema = z.array(z.string().max(500)).max(64);
const timeAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), seconds: finiteNumber }).strict(),
  z.object({ kind: z.literal("playhead"), referenceSeconds: finiteNumber }).strict(),
  z
    .object({
      kind: z.literal("playhead-offset"),
      offsetSeconds: finiteNumber,
      referenceSeconds: finiteNumber,
    })
    .strict(),
  z
    .object({
      boundary: z.enum(["play-end", "play-start", "scene-end", "scene-start"]),
      eventId: boundedId,
      kind: z.literal("structural"),
      offsetSeconds: finiteNumber.optional(),
    })
    .strict(),
]);
const programSchema = z
  .object({
    anchor: z
      .object({
        capturedPlayhead: finiteNumber,
        evidence: evidenceSchema,
        resolvedSeconds: finiteNumber.nonnegative(),
        source: timeAnchorSchema,
      })
      .strict(),
    intentCount: z.number().int().min(0).max(16),
    loweringStatus: z.enum(["illustrative", "supported", "unsupported"]),
    operations: z.array(canonicalOperationSchema).max(64),
    provenance: z
      .object({
        evidence: evidenceSchema,
        origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
      })
      .strict(),
    requestedExecution: z.enum(["parallel", "sequence"]),
    schedule: z
      .object({
        edges: z
          .array(
            z
              .object({
                from: boundedId,
                reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
                to: boundedId,
              })
              .strict(),
          )
          .max(256),
        mode: z.enum(["dependency-dag", "parallel", "sequence"]),
        order: z.array(boundedId).max(64),
      })
      .strict(),
    transactionId: z.string().min(1).max(160),
    version: z.literal(1),
  })
  .strict();
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
      "target-missing",
    ]),
    field: z.string().max(256),
    message: z.string().max(2_000),
    operationId: boundedId.optional(),
    severity: z.enum(["error", "warning"]),
  })
  .strict();
const programRecordSchema = z
  .object({
    program: programSchema,
    validation: z
      .object({
        issues: z.array(validationIssueSchema).max(256),
        status: z.enum(["invalid", "valid"]),
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
const editorProgramRecordSchema = programRecordSchema
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
      value: editorProgramRecordSchema,
    })
    .strict(),
  z
    .object({
      index: mutationIndexSchema,
      kind: z.literal("replace"),
      previous: editorProgramRecordSchema,
      value: editorProgramRecordSchema,
    })
    .strict(),
]);
const appliedProgramEditSchema = z
  .object({
    index: mutationIndexSchema,
    original: editorProgramRecordSchema,
  })
  .strict();
const redoProgramEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      edit: appliedProgramEditSchema.nullable(),
      kind: z.literal("draft"),
      value: editorProgramRecordSchema,
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
    appliedPrograms: z.array(editorProgramRecordSchema).max(32),
    currentTime: finiteNumber.nonnegative().max(86_400),
    draftOperation: editSuggestionOperationSchema.nullable(),
    draftProgram: editorProgramRecordSchema.nullable(),
    editingAppliedProgram: appliedProgramEditSchema.nullable(),
    insertTool: z.enum(["select", "Text", "MathTex", "Rectangle", "Circle", "Line", "Arrow"]),
    interactionMode: z.enum(["animate", "position"]),
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
      if (record.validation.status !== "valid" || programExecutionCapabilities(record.program).apply !== "supported") {
        context.addIssue({
          code: "custom",
          message: "Only valid, truthfully applicable Programs may be restored as applied.",
          path: ["appliedPrograms", index],
        });
      }
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

export const editorSessionSnapshotSchemaV1 = deepStrictWireSchemaV1(editorSessionSnapshotBaseSchemaV1);

export function parseEditorSessionSnapshotV1(value: unknown): EditorSessionSnapshotV1 {
  return editorSessionSnapshotSchemaV1.parse(value);
}

export function canonicalEditorSessionSnapshotJsonV1(value: unknown) {
  return canonicalJsonV1(parseEditorSessionSnapshotV1(value));
}

export function editorSessionSnapshotByteSizeV1(value: unknown) {
  return new TextEncoder().encode(canonicalEditorSessionSnapshotJsonV1(value)).byteLength;
}
