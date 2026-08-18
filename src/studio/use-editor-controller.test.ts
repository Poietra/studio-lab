import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { EditorSessionStore } from "./editor-session-store";
import type { ProgramRecord } from "./model";
import { STUDIO_STYLE_PROFILE } from "./style-profile";
import {
  applyEditorDraft,
  createInitialEditorState,
  discardEditorDraft,
  editEditorAppliedProgram,
  editorProgramRecord,
  initializeEditorScene,
  installAuthoritativeEditorPrograms,
  installCloudEditorSessionSnapshotV1,
  LatestRequestController,
  redoEditorProgram,
  restoreEditorSession,
  snapshotCloudEditorSessionV1,
  snapshotEditorSession,
  stageEditorDraft,
  undoEditorProgram,
} from "./use-editor-controller";

function record(transactionId: string, resolvedSeconds = 5) {
  const operationId = `${transactionId}/set-appearance`;
  return {
    program: {
      anchor: {
        capturedPlayhead: resolvedSeconds,
        evidence: [],
        resolvedSeconds,
        source: { kind: "absolute", seconds: resolvedSeconds },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId: "equation",
          id: operationId,
          interval: { end: resolvedSeconds, start: resolvedSeconds },
          key: "appearance",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "fixture" },
          value: 0.5,
        },
      ],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operationId] },
      transactionId,
      version: 1,
    },
    validation: { issues: [], status: "valid" },
  } as const satisfies ProgramRecord;
}

function timelineRecord(transactionId: string, resolvedSeconds = 5) {
  const base = record(transactionId, resolvedSeconds);
  const operationId = `${transactionId}/wait`;
  return {
    ...base,
    program: {
      ...base.program,
      intentCount: 1,
      operations: [
        {
          dependsOn: [],
          eventKind: "wait",
          id: operationId,
          interval: { end: resolvedSeconds + 1, start: resolvedSeconds },
          kind: "InsertTimelineEvent",
          label: "Wait",
          provenance: { evidence: [], origin: "studio-default" },
          purpose: "scene-duration",
        },
      ],
      schedule: { edges: [], mode: "sequence", order: [operationId] },
    },
  } as const satisfies ProgramRecord;
}

const motionOperation: EditSuggestionOperation = {
  anchor: { kind: "playhead", referenceSeconds: 5 },
  controlOffset: { x: 20, y: -10 },
  delta: { x: 40, y: 0 },
  easing: "smooth",
  end: 6,
  kind: "create-motion",
  start: 5,
  targetObjectIds: ["equation"],
};

describe("editor session lifecycle", () => {
  it("uses the Studio style profile for the initial motion duration", () => {
    expect(createInitialEditorState().motionDuration).toBe(STUDIO_STYLE_PROFILE.durationSeconds.deliberate);
  });

  it("saves and restores session state while clearing transient request UI", () => {
    const draft = record("draft");
    const sessionState = {
      ...createInitialEditorState(),
      appliedPrograms: [record("applied")],
      currentTime: 7,
      durationError: "duration needs attention",
      draftError: "kept with the draft",
      draftOperation: motionOperation,
      draftProgram: draft,
      insertTool: "Circle" as const,
      insertValue: "circle",
      instruction: "move it",
      interactionMode: "position" as const,
      isPlaying: true,
      motionDuration: 2.5,
      selectedObjectIds: ["equation"],
      suggestionMessage: "transient",
      suggestionStatus: "loading" as const,
    };
    const store = new EditorSessionStore();
    const identity = {
      projectId: "project",
      sceneId: "scene.py#Scene",
      sourceHash: "a".repeat(64),
    };
    store.save(identity, snapshotEditorSession(sessionState));

    const snapshot = store.restore(identity);
    expect(snapshot.kind).toBe("restored");
    if (snapshot.kind !== "restored") throw new Error("Expected the session to restore.");
    const restored = restoreEditorSession(createInitialEditorState(), snapshot.snapshot);

    expect(restored).toMatchObject({
      appliedPrograms: sessionState.appliedPrograms,
      currentTime: 7,
      durationError: "duration needs attention",
      draftError: "kept with the draft",
      draftProgram: draft,
      insertTool: "Circle",
      instruction: "move it",
      interactionMode: "position",
      isPlaying: false,
      motionDuration: 2.5,
      selectedObjectIds: ["equation"],
      suggestion: null,
      suggestionMessage: null,
      suggestionStatus: "idle",
    });
  });

  it("initializes a new Scene without changing the user's interaction preferences", () => {
    const previous = {
      ...createInitialEditorState(),
      interactionMode: "position" as const,
      motionDuration: 3,
    };

    const initialized = initializeEditorScene(previous, {
      currentTime: 2,
      selectedObjectIds: ["first-visible"],
    });

    expect(initialized).toMatchObject({
      appliedPrograms: [],
      currentTime: 2,
      interactionMode: "position",
      motionDuration: 3,
      selectedObjectIds: ["first-visible"],
    });
  });

  it("exports only the strict subject-private cloud snapshot", () => {
    const exported = snapshotCloudEditorSessionV1({
      ...createInitialEditorState(),
      durationError: "local duration error",
      draftError: "local draft error",
      insertValue: "unfinished input",
      instruction: "unfinished instruction",
      suggestionMessage: "transient",
    });

    expect(exported).toMatchObject({ appliedPrograms: [], currentTime: 0 });
    expect(exported).not.toHaveProperty("durationError");
    expect(exported).not.toHaveProperty("draftError");
    expect(exported).not.toHaveProperty("insertValue");
    expect(exported).not.toHaveProperty("instruction");
    expect(exported).not.toHaveProperty("pendingClarification");
    expect(exported).not.toHaveProperty("suggestionMessage");
  });

  it("installs cloud authoring state only beside the exact authoritative projection", () => {
    const authoritative = record("applied");
    const privateApplied = editorProgramRecord(authoritative, motionOperation, ["equation"]);
    const cloud = snapshotCloudEditorSessionV1({
      ...createInitialEditorState(),
      appliedPrograms: [privateApplied],
      currentTime: 7,
      draftOperation: motionOperation,
      draftProgram: record("draft"),
      insertTool: "Circle",
      interactionMode: "position",
      motionDuration: 2.5,
      programUndoEntries: [{ index: 0, kind: "append", value: privateApplied }],
      selectedObjectIds: ["equation"],
    });
    const current = {
      ...createInitialEditorState(),
      isPlaying: true,
      suggestionMessage: "must be cleared",
      suggestionStatus: "loading" as const,
    };

    const installed = installCloudEditorSessionSnapshotV1(current, [authoritative], cloud);

    expect(installed.kind).toBe("installed");
    if (installed.kind !== "installed") throw new Error("Expected the cloud snapshot to install.");
    expect(installed.state).toMatchObject({
      appliedPrograms: [privateApplied],
      currentTime: 7,
      draftProgram: record("draft"),
      insertTool: "Circle",
      interactionMode: "position",
      isPlaying: false,
      motionDuration: 2.5,
      selectedObjectIds: ["equation"],
      suggestionMessage: null,
      suggestionStatus: "idle",
    });

    const mismatched = installCloudEditorSessionSnapshotV1(current, [record("other")], cloud);
    expect(mismatched).toEqual({ kind: "projection-mismatch" });
    expect(installCloudEditorSessionSnapshotV1(current, [authoritative], { ...cloud, unknown: true })).toEqual({
      kind: "invalid-snapshot",
    });
  });

  it("preserves the personal redo boundary across a cloud snapshot round trip", () => {
    const first = editorProgramRecord(record("first"), null, []);
    const latest = editorProgramRecord(record("latest"), motionOperation, ["equation"]);
    const beforeUndo = {
      ...createInitialEditorState(),
      appliedPrograms: [first, latest],
      programUndoEntries: [
        { index: 0, kind: "append" as const, value: first },
        { index: 1, kind: "append" as const, value: latest },
      ],
    };
    const afterUndo = undoEditorProgram(beforeUndo);
    const cloud = snapshotCloudEditorSessionV1(afterUndo);
    const restored = installCloudEditorSessionSnapshotV1(createInitialEditorState(), [first], cloud);

    expect(restored.kind).toBe("installed");
    if (restored.kind !== "installed") throw new Error("Expected the cloud snapshot to install.");
    expect(redoEditorProgram(restored.state).appliedPrograms).toEqual([first, latest]);
  });
});

describe("editor draft history", () => {
  it("installs an authoritative projection and invalidates stale local authoring history", () => {
    const local = editorProgramRecord(record("local"), motionOperation, ["equation"]);
    const remote = record("remote");
    const reconciled = installAuthoritativeEditorPrograms(
      {
        ...createInitialEditorState(),
        appliedPrograms: [local],
        draftOperation: motionOperation,
        draftProgram: record("draft"),
        editingAppliedProgram: { index: 0, original: local },
        isPlaying: true,
        programUndoEntries: [{ index: 0, kind: "append", value: local }],
        redoPrograms: [{ kind: "mutation", mutation: { index: 0, kind: "append", value: local } }],
        selectedObjectIds: ["equation"],
      },
      [remote],
      "Remote history changed.",
    );

    expect(reconciled).toMatchObject({
      appliedPrograms: [remote],
      draftError: "Remote history changed.",
      draftOperation: null,
      draftProgram: null,
      editingAppliedProgram: null,
      isPlaying: false,
      programUndoEntries: [],
      redoPrograms: [],
      selectedObjectIds: [],
    });
  });

  it("stages and applies a validated draft atomically", () => {
    const draft = record("draft", 5);
    const staged = stageEditorDraft(
      {
        ...createInitialEditorState(),
        redoPrograms: [
          {
            kind: "mutation" as const,
            mutation: {
              index: 0,
              kind: "append" as const,
              value: record("old-redo"),
            },
          },
        ],
      },
      {
        currentTime: 5,
        operation: motionOperation,
        record: draft,
        selectedObjectIds: ["equation"],
      },
    );

    expect(staged).toMatchObject({
      currentTime: 5,
      draftError: null,
      draftOperation: motionOperation,
      draftProgram: draft,
      redoPrograms: [],
      selectedObjectIds: ["equation"],
    });

    const applied = applyEditorDraft(staged);
    expect(applied).toMatchObject({
      appliedPrograms: [editorProgramRecord(draft, motionOperation, ["equation"])],
      currentTime: 5,
      draftOperation: null,
      draftProgram: null,
      redoPrograms: [],
      suggestionStatus: "idle",
    });
  });

  it("keeps the current time until Rust projects an applied timeline draft", () => {
    const draft = timelineRecord("timeline-draft", 5);
    const staged = stageEditorDraft(
      { ...createInitialEditorState(), currentTime: 9 },
      { operation: null, record: draft },
    );

    const applied = applyEditorDraft(staged);

    expect(applied.appliedPrograms).toHaveLength(1);
    expect(applied.currentTime).toBe(9);
  });

  it("preserves a direct-manipulation draft before staging the next ordered draft", () => {
    const preserved = record("preserved", 4);
    const next = record("next", 6);
    const staged = stageEditorDraft(
      {
        ...createInitialEditorState(),
        draftOperation: motionOperation,
        draftProgram: preserved,
        selectedObjectIds: ["equation"],
      },
      {
        operation: null,
        preserveAppliedProgram: preserved,
        record: next,
      },
    );

    expect(staged.appliedPrograms).toEqual([editorProgramRecord(preserved, motionOperation, ["equation"])]);
    expect(staged.programUndoEntries).toEqual([
      {
        index: 0,
        kind: "append",
        value: editorProgramRecord(preserved, motionOperation, ["equation"]),
      },
    ]);
    expect(staged.draftProgram).toBe(next);
  });

  it("rejects a staged draft that would violate applied source order", () => {
    const applied = editorProgramRecord(record("applied", 7), null, []);
    const previous = {
      ...createInitialEditorState(),
      appliedPrograms: [applied],
    };
    const staged = stageEditorDraft(previous, {
      operation: null,
      record: record("earlier", 5),
    });

    expect(staged.appliedPrograms).toEqual([applied]);
    expect(staged.draftProgram).toBeNull();
    expect(staged.draftError).toContain("earlier than the latest applied Program");
  });

  it("undoes and redoes a draft with its operation and selection", () => {
    const draft = record("draft");
    const staged = stageEditorDraft(createInitialEditorState(), {
      operation: motionOperation,
      record: draft,
      selectedObjectIds: ["tx:draft/entity:new", "equation"],
    });

    const undone = undoEditorProgram(staged);
    expect(undone.draftProgram).toBeNull();
    expect(undone.selectedObjectIds).toEqual(["equation"]);
    expect(undone.redoPrograms).toEqual([
      {
        edit: null,
        kind: "draft",
        value: editorProgramRecord(draft, motionOperation, ["tx:draft/entity:new", "equation"]),
      },
    ]);

    const redone = redoEditorProgram(undone);
    expect(redone.draftProgram).toEqual(
      editorProgramRecord(draft, motionOperation, ["tx:draft/entity:new", "equation"]),
    );
    expect(redone.draftOperation).toBe(motionOperation);
    expect(redone.selectedObjectIds).toEqual(["tx:draft/entity:new", "equation"]);
    expect(redone.redoPrograms).toEqual([]);
  });

  it("undoes and redoes the latest applied Program", () => {
    const first = editorProgramRecord(record("first"), null, []);
    const latest = editorProgramRecord(record("latest"), motionOperation, ["equation"]);
    const state = {
      ...createInitialEditorState(),
      appliedPrograms: [first, latest],
      programUndoEntries: [
        { index: 0, kind: "append" as const, value: first },
        { index: 1, kind: "append" as const, value: latest },
      ],
      selectedObjectIds: ["equation"],
    };

    const undone = undoEditorProgram(state);
    expect(undone.appliedPrograms).toEqual([first]);
    expect(undone.selectedObjectIds).toEqual([]);

    const redone = redoEditorProgram(undone);
    expect(redone.appliedPrograms).toEqual([first, latest]);
    expect(redone.selectedObjectIds).toEqual(["equation"]);
  });

  it("replaces an edited Applied Program in place and preserves reversible history", () => {
    const original = editorProgramRecord(record("motion", 5), motionOperation, ["equation"]);
    const initial = {
      ...createInitialEditorState(),
      appliedPrograms: [original],
      programUndoEntries: [{ index: 0, kind: "append" as const, value: original }],
    };
    const editing = editEditorAppliedProgram(initial, original, 0);
    const replacement = record("motion", 6);
    const staged = stageEditorDraft(editing, {
      currentTime: 6,
      operation: { ...motionOperation, end: 7, start: 6 },
      record: replacement,
      selectedObjectIds: ["equation"],
    });

    const applied = applyEditorDraft(staged);
    expect(applied.appliedPrograms).toHaveLength(1);
    expect(applied.appliedPrograms[0]?.program.anchor.resolvedSeconds).toBe(6);
    expect(applied.programUndoEntries.at(-1)).toMatchObject({
      index: 0,
      kind: "replace",
      previous: original,
    });

    const undone = undoEditorProgram(applied);
    expect(undone.appliedPrograms).toEqual([original]);
    const redone = redoEditorProgram(undone);
    expect(redone.appliedPrograms[0]?.program.anchor.resolvedSeconds).toBe(6);
    expect(redone.appliedPrograms).toHaveLength(1);
  });

  it("stages a metadata-free lifetime replacement explicitly and persists its edit identity", () => {
    const original = editorProgramRecord(record("lifetime", 5), null, ["equation"]);
    const replacement = record("lifetime", 7);
    const staged = stageEditorDraft(
      {
        ...createInitialEditorState(),
        appliedPrograms: [original],
        programUndoEntries: [{ index: 0, kind: "append" as const, value: original }],
      },
      {
        appliedEdit: { index: 0, original },
        currentTime: 7,
        operation: null,
        record: replacement,
        selectedObjectIds: ["equation"],
      },
    );
    const restored = restoreEditorSession(createInitialEditorState(), snapshotEditorSession(staged));

    expect(restored.editingAppliedProgram).toEqual({ index: 0, original });
    const applied = applyEditorDraft(restored);
    expect(applied.appliedPrograms).toHaveLength(1);
    expect(applied.appliedPrograms[0]?.program.anchor.resolvedSeconds).toBe(7);
    expect(undoEditorProgram(applied).appliedPrograms).toEqual([original]);
  });

  it("keeps a preview-only replacement staged instead of applying it", () => {
    const original = editorProgramRecord(record("motion"), motionOperation, ["equation"]);
    const editing = editEditorAppliedProgram(
      {
        ...createInitialEditorState(),
        appliedPrograms: [original],
        programUndoEntries: [{ index: 0, kind: "append" as const, value: original }],
      },
      original,
      0,
    );
    const previewOnly = {
      ...record("motion"),
      program: { ...record("motion").program, loweringStatus: "illustrative" as const },
    };
    const staged = stageEditorDraft(editing, {
      operation: motionOperation,
      record: previewOnly,
    });

    const blocked = applyEditorDraft(staged);
    expect(blocked.appliedPrograms).toEqual([original]);
    expect(blocked.draftProgram).toBe(previewOnly);
    expect(blocked.editingAppliedProgram?.original).toBe(original);
    expect(blocked.draftError).toContain("cannot be applied");
  });

  it("discards provisional draft selection without touching other objects", () => {
    const draft = record("draft");
    const discarded = discardEditorDraft({
      ...createInitialEditorState(),
      draftProgram: draft,
      selectedObjectIds: ["tx:draft/entity:new", "equation"],
    });

    expect(discarded.draftProgram).toBeNull();
    expect(discarded.selectedObjectIds).toEqual(["equation"]);
  });
});

describe("latest request cancellation", () => {
  it("aborts a superseded request and only finishes the current request", () => {
    const requests = new LatestRequestController();
    const first = requests.start();
    const second = requests.start();

    expect(first.signal.aborted).toBe(true);
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);

    requests.finish(first);
    expect(requests.isCurrent(second)).toBe(true);

    requests.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(requests.isCurrent(second)).toBe(false);
  });
});
