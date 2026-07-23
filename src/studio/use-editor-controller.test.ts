import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { ProgramRecord } from "./model";
import {
  applyEditorDraft,
  createInitialEditorState,
  discardEditorDraft,
  editEditorAppliedProgram,
  editorProgramRecord,
  EditorSessionStore,
  initializeEditorScene,
  LatestRequestController,
  redoEditorProgram,
  restoreEditorSession,
  snapshotEditorSession,
  stageEditorDraft,
  undoEditorProgram,
} from "./use-editor-controller";

function record(transactionId: string, resolvedSeconds = 5): ProgramRecord {
  return {
    program: {
      anchor: {
        capturedPlayhead: resolvedSeconds,
        evidence: [],
        resolvedSeconds,
        source: { kind: "absolute", seconds: resolvedSeconds },
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
    validation: { issues: [], status: "valid" },
  };
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
  it("saves and restores session state while clearing transient request UI", () => {
    const draft = record("draft");
    const sessionState = {
      ...createInitialEditorState(),
      appliedPrograms: [record("applied")],
      currentTime: 7,
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
    store.save("project/scene/hash", snapshotEditorSession(sessionState));

    const snapshot = store.restore("project/scene/hash");
    expect(snapshot).not.toBeNull();
    const restored = restoreEditorSession(createInitialEditorState(), snapshot!);

    expect(restored).toMatchObject({
      appliedPrograms: sessionState.appliedPrograms,
      currentTime: 7,
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
});

describe("editor draft history", () => {
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
