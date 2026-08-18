import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { ProgramRecord } from "../studio/model";
import { STUDIO_STYLE_PROFILE, styleProfileRef } from "../studio/style-profile";
import {
  canonicalEditorSessionSnapshotJsonV1,
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  type EditorProgramRecord,
  editorSessionSnapshotByteSizeV1,
  MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1,
  parseEditorSessionSnapshotV1,
} from "./editor-session-contract";

const motionOperation: EditSuggestionOperation = {
  anchor: { kind: "playhead", referenceSeconds: 2 },
  controlOffset: { x: 20, y: -10 },
  delta: { x: 40, y: 0 },
  easing: "smooth",
  end: 3,
  kind: "create-motion",
  start: 2,
  targetObjectIds: ["equation"],
};

function record(transactionId: string, evidence: readonly string[] = []) {
  const operationId = `${transactionId}/set-appearance`;
  return {
    program: {
      anchor: {
        capturedPlayhead: 2,
        evidence: evidence.slice(0, 32),
        resolvedSeconds: 2,
        source: { kind: "absolute", seconds: 2 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId: "equation",
          id: operationId,
          interval: { end: 2, start: 2 },
          key: "appearance",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "fixture" },
          value: 0.5,
        },
      ],
      provenance: {
        evidence,
        origin: "studio-default",
        styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operationId] },
      transactionId,
      version: 1,
    },
    validation: {
      issues: [
        {
          code: "style-profile-deviation",
          field: "duration",
          message: "Explicit timing differs from the Studio style profile.",
          severity: "warning",
        },
      ],
      status: "valid",
    },
  } as const satisfies ProgramRecord;
}

function draftRecord(transactionId: string) {
  return {
    program: {
      anchor: {
        capturedPlayhead: 2,
        evidence: [],
        resolvedSeconds: 2,
        source: { kind: "absolute", seconds: 2 },
      },
      intentCount: 0,
      loweringStatus: "supported",
      operations: [],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [] },
      transactionId,
      version: 1,
    },
    validation: {
      issues: [
        {
          code: "operation-count",
          field: "operations",
          message: "The draft has no operations yet.",
          severity: "error",
        },
      ],
      status: "invalid",
    },
  } as const;
}

function snapshot() {
  const original = record("motion");
  const applied: EditorProgramRecord = {
    ...original,
    editorMetadata: { operation: motionOperation, selection: ["数式"] },
  };
  return {
    appliedPrograms: [applied],
    currentTime: 7.25,
    draftOperation: motionOperation,
    draftProgram: draftRecord("motion"),
    editingAppliedProgram: { index: 0, original: applied },
    insertTool: "Circle",
    interactionMode: "position",
    motionDuration: 2.5,
    programUndoEntries: [{ index: 0, kind: "append", value: applied }],
    redoPrograms: [{ edit: null, kind: "draft", value: draftRecord("redo") }],
    selectedObjectIds: ["equation"],
    verifiedSourceDurationBasis: { duration: 8, sessionKey: "source-session" },
  };
}

describe("editor session snapshot V1 contract", () => {
  it("strictly preserves the complete durable resume state and editor metadata", () => {
    const value = snapshot();

    expect(parseEditorSessionSnapshotV1(value)).toEqual(value);
    expect(value.draftProgram).toMatchObject({
      program: { intentCount: 0, operations: [] },
      validation: { status: "invalid" },
    });
    expect(EDITOR_SESSION_SNAPSHOT_VERSION_V1).toBe(1);
    expect(MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1).toBe(384 * 1024);
    expect(() => parseEditorSessionSnapshotV1({ ...value, instruction: "transient" })).toThrow();
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        appliedPrograms: [{ ...value.appliedPrograms[0], unexpected: true }],
      }),
    ).toThrow();
  });

  it("rejects unknown keys inside nested suggestion and Program schemas", () => {
    const value = snapshot();
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        draftOperation: {
          ...motionOperation,
          controlOffset: { ...motionOperation.controlOffset, evil: true },
        },
      }),
    ).toThrow(/unknown wire field/i);
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        draftProgram: {
          ...value.draftProgram,
          program: {
            ...value.draftProgram?.program,
            operations: [
              {
                dependsOn: [],
                entityId: "equation",
                id: "motion/set-position",
                interval: { end: 3, evil: true, start: 2 },
                key: "position",
                kind: "SetProperty",
                provenance: { evidence: [], origin: "fixture" },
                value: { x: 1, y: 2 },
              },
            ],
            schedule: { edges: [], mode: "sequence", order: ["motion/set-position"] },
          },
        },
      }),
    ).toThrow(/unknown wire field/i);
  });

  it("emits deterministic canonical JSON and measures UTF-8 bytes in browsers", () => {
    const value = snapshot();
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    const canonical = canonicalEditorSessionSnapshotJsonV1(value);

    expect(canonicalEditorSessionSnapshotJsonV1(reversed)).toBe(canonical);
    expect(editorSessionSnapshotByteSizeV1(value)).toBe(new TextEncoder().encode(canonical).byteLength);
    expect(editorSessionSnapshotByteSizeV1(value)).toBeGreaterThan(canonical.length);
  });

  it("rejects canonical snapshot JSON above the shared 384 KiB budget", () => {
    const evidence = Array.from({ length: 64 }, () => "x".repeat(500));
    const oversized = {
      ...snapshot(),
      appliedPrograms: Array.from({ length: 9 }, (_, index) => record(`large-${index}`, evidence)),
      draftOperation: null,
      draftProgram: null,
      editingAppliedProgram: null,
      programUndoEntries: [],
      redoPrograms: [],
    };

    expect(() => parseEditorSessionSnapshotV1(oversized)).toThrow(/384|393216|canonical JSON bytes/i);
  });

  it("retains the existing draft, edit, and applicable-program consistency checks", () => {
    const value = snapshot();

    expect(() => parseEditorSessionSnapshotV1({ ...value, draftProgram: null })).toThrow(/draft/i);
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        draftProgram: draftRecord("different"),
      }),
    ).toThrow(/no longer matches/i);

    const emptyInvalidDraft = draftRecord("empty-invalid");
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        appliedPrograms: [emptyInvalidDraft],
        editingAppliedProgram: null,
        programUndoEntries: [],
      }),
    ).toThrow();
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        editingAppliedProgram: null,
        programUndoEntries: [{ index: 0, kind: "append", value: emptyInvalidDraft }],
      }),
    ).toThrow();

    const previewOnly = {
      ...value.appliedPrograms[0],
      program: { ...value.appliedPrograms[0].program, loweringStatus: "illustrative" },
    };
    expect(() =>
      parseEditorSessionSnapshotV1({
        ...value,
        appliedPrograms: [previewOnly],
        editingAppliedProgram: null,
        programUndoEntries: [],
      }),
    ).toThrow(/truthfully applicable/i);
  });
});
