import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import {
  EDITOR_SESSION_STALE_SOURCE_MESSAGE,
  EDITOR_SESSION_STORAGE_VERSION,
  type EditorSessionIdentity,
  type EditorSessionSnapshot,
  type EditorSessionStorageAdapter,
  EditorSessionStore,
  MAX_EDITOR_SESSION_STORAGE_BYTES,
  MAX_STORED_EDITOR_SESSIONS,
} from "./editor-session-store";
import type { ProgramRecord } from "./model";
import {
  applyEditorDraft,
  createInitialEditorState,
  editorProgramRecord,
  redoEditorProgram,
  resetEditorPrograms,
  restoreEditorSession,
  snapshotEditorSession,
  undoEditorProgram,
} from "./use-editor-controller";
import { resolveVerifiedSourceDurationBasis } from "./imported-workspace";

class MemoryAdapter implements EditorSessionStorageAdapter {
  value: string | null;

  constructor(value: string | null = null) {
    this.value = value;
  }

  clear() {
    this.value = null;
  }

  read() {
    return this.value;
  }

  write(serialized: string) {
    this.value = serialized;
  }
}

function identity(
  sceneId = "examples/scene.py#ExampleScene",
  sourceHash = "a".repeat(64),
  projectId = "project-a",
): EditorSessionIdentity {
  return { projectId, sceneId, sourceHash };
}

function record(transactionId: string): ProgramRecord {
  return {
    program: {
      anchor: {
        capturedPlayhead: 2,
        evidence: ["captured-playhead:2.000"],
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
    validation: { issues: [], status: "valid" },
  };
}

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

function snapshot(): EditorSessionSnapshot {
  const applied = record("applied");
  const draft = record("draft");
  return snapshotEditorSession({
    ...createInitialEditorState(),
    appliedPrograms: [applied],
    currentTime: 7.25,
    durationError: "Keep this local duration warning.",
    draftError: "Keep this local draft warning.",
    draftOperation: motionOperation,
    draftProgram: draft,
    insertTool: "Circle",
    insertValue: "draft content",
    instruction: "move the selected object",
    interactionMode: "position",
    motionDuration: 2.5,
    redoPrograms: [
      {
        kind: "mutation",
        mutation: {
          index: 1,
          kind: "append",
          value: editorProgramRecord(record("redo"), null, ["equation"]),
        },
      },
    ],
    selectedObjectIds: ["equation"],
    verifiedSourceDurationBasis: { duration: 1, sessionKey: "session-a" },
  });
}

describe("durable editor session storage", () => {
  it("restores the closed, versioned editor payload through a fresh store", () => {
    const adapter = new MemoryAdapter();
    const firstStore = new EditorSessionStore(adapter, () => 100);
    expect(firstStore.save(identity(), snapshot())).toBe(true);

    const serialized = adapter.value;
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized!)).toMatchObject({ version: EDITOR_SESSION_STORAGE_VERSION });
    expect(serialized).not.toContain("suggestionStatus");
    expect(serialized).not.toContain("pendingClarification");
    expect(serialized).not.toContain("move the selected object");
    expect(serialized).not.toContain("Keep this local draft warning");
    expect(serialized).not.toContain("Keep this local duration warning");
    expect(serialized).not.toContain("draft content");
    expect(serialized).not.toContain("sourcePath");
    expect(serialized).not.toContain("examples/scene.py");

    const restored = new EditorSessionStore(adapter).restore(identity());
    expect(restored).toEqual({
      kind: "restored",
      snapshot: {
        ...snapshot(),
        durationError: null,
        draftError: null,
        insertValue: "",
        instruction: "",
      },
    });
  });

  it("preserves transient inputs while switching Scenes within the same SPA", () => {
    const store = new EditorSessionStore(new MemoryAdapter());
    store.save(identity(), snapshot());

    expect(store.restore(identity())).toEqual({ kind: "restored", snapshot: snapshot() });
  });

  it("round-trips replacement history so undo and redo remain reversible", () => {
    const adapter = new MemoryAdapter();
    const original = editorProgramRecord(record("motion"), motionOperation, ["equation"]);
    const replacementOperation = { ...motionOperation, delta: { x: 80, y: 12 } };
    const replacement = editorProgramRecord(record("motion"), replacementOperation, ["equation"]);
    const replacementMutation = {
      index: 0,
      kind: "replace" as const,
      previous: original,
      value: replacement,
    };
    const session = snapshotEditorSession({
      ...createInitialEditorState(),
      appliedPrograms: [replacement],
      programUndoEntries: [{ index: 0, kind: "append" as const, value: original }, replacementMutation],
      selectedObjectIds: ["equation"],
    });
    expect(new EditorSessionStore(adapter).save(identity(), session)).toBe(true);

    const restored = new EditorSessionStore(adapter).restore(identity());
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("Expected replacement history to restore.");
    const state = restoreEditorSession(createInitialEditorState(), restored.snapshot);
    const undone = undoEditorProgram(state);
    expect(undone.appliedPrograms).toEqual([original]);
    expect(redoEditorProgram(undone).appliedPrograms).toEqual([replacement]);
  });

  it("does not apply redo history while an external lifecycle blocker is active", () => {
    const value = editorProgramRecord(record("redo-blocked"), null, ["equation"]);
    const state = {
      ...createInitialEditorState(),
      redoPrograms: [
        {
          kind: "mutation" as const,
          mutation: { index: 0, kind: "append" as const, value },
        },
      ],
    };

    const blocked = redoEditorProgram(state, "Wait for verified Scene timing.");

    expect(blocked.appliedPrograms).toEqual([]);
    expect(blocked.redoPrograms).toEqual(state.redoPrograms);
    expect(blocked.draftError).toBe("Wait for verified Scene timing.");
  });

  it.each([
    ["an older session without a basis", null, 1],
    ["a retained duration that changed", { duration: 1, sessionKey: "source-a" }, 2],
  ] as const)("resets %s and can adopt the current verified timing", (_label, retained, candidate) => {
    const applied = editorProgramRecord(record("applied-before-timing-reset"), null, ["equation"]);
    const redo = editorProgramRecord(record("redo-before-timing-reset"), null, ["equation"]);
    const edited = {
      ...createInitialEditorState(),
      appliedPrograms: [applied],
      draftOperation: motionOperation,
      draftProgram: record("draft-before-timing-reset"),
      programUndoEntries: [{ index: 0, kind: "append" as const, value: applied }],
      redoPrograms: [
        {
          kind: "mutation" as const,
          mutation: { index: 1, kind: "append" as const, value: redo },
        },
      ],
      verifiedSourceDurationBasis: retained,
    };
    expect(
      resolveVerifiedSourceDurationBasis({
        candidate,
        editorPristine: false,
        retained,
        sessionKey: "source-a",
      }).mismatch,
    ).toBe(true);

    const reset = resetEditorPrograms(edited);

    expect(reset.appliedPrograms).toEqual([]);
    expect(reset.draftOperation).toBeNull();
    expect(reset.draftProgram).toBeNull();
    expect(reset.editingAppliedProgram).toBeNull();
    expect(reset.programUndoEntries).toEqual([]);
    expect(reset.redoPrograms).toEqual([]);
    expect(reset.verifiedSourceDurationBasis).toEqual(retained);
    expect(
      resolveVerifiedSourceDurationBasis({
        candidate,
        editorPristine: true,
        retained: reset.verifiedSourceDurationBasis,
        sessionKey: "source-a",
      }),
    ).toEqual({
      adoption: { duration: candidate, sessionKey: "source-a" },
      duration: candidate,
      mismatch: false,
    });
  });

  it("restores preview-only replacement drafts but still blocks applying them", () => {
    const adapter = new MemoryAdapter();
    const original = editorProgramRecord(record("motion"), motionOperation, ["equation"]);
    const previewOnly = {
      ...record("motion"),
      program: { ...record("motion").program, loweringStatus: "illustrative" as const },
    };
    const session = snapshotEditorSession({
      ...createInitialEditorState(),
      appliedPrograms: [original],
      draftOperation: motionOperation,
      draftProgram: previewOnly,
      editingAppliedProgram: { index: 0, original },
      programUndoEntries: [{ index: 0, kind: "append", value: original }],
      selectedObjectIds: ["equation"],
    });
    expect(new EditorSessionStore(adapter).save(identity(), session)).toBe(true);

    const restored = new EditorSessionStore(adapter).restore(identity());
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("Expected the preview-only draft to restore.");
    const blocked = applyEditorDraft(restoreEditorSession(createInitialEditorState(), restored.snapshot));
    expect(blocked.appliedPrograms).toEqual([original]);
    expect(blocked.draftProgram).toMatchObject({ program: { loweringStatus: "illustrative" } });
    expect(blocked.draftError).toContain("cannot be applied");
  });

  it("rejects preview-only Programs from the persisted applied list", () => {
    const adapter = new MemoryAdapter();
    const previewOnly = editorProgramRecord(
      {
        ...record("preview-only"),
        program: { ...record("preview-only").program, loweringStatus: "illustrative" },
      },
      null,
      [],
    );
    const unsafe = snapshotEditorSession({
      ...createInitialEditorState(),
      appliedPrograms: [previewOnly],
      programUndoEntries: [{ index: 0, kind: "append", value: previewOnly }],
    });

    expect(new EditorSessionStore(adapter).save(identity(), unsafe)).toBe(false);
    expect(adapter.value).toBeNull();
  });

  it("rejects unknown snapshot fields instead of persisting an open-ended object", () => {
    const adapter = new MemoryAdapter();
    const store = new EditorSessionStore(adapter);
    const unsafeSnapshot = { ...snapshot(), suggestionStatus: "loading" } as EditorSessionSnapshot;

    expect(store.save(identity(), unsafeSnapshot)).toBe(false);
    expect(adapter.value).toBeNull();
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["a future version", JSON.stringify({ entries: [], version: EDITOR_SESSION_STORAGE_VERSION + 1 })],
    ["an unknown older version", JSON.stringify({ entries: [], version: 0 })],
  ])("discards %s without crashing", (_label, serialized) => {
    const adapter = new MemoryAdapter(serialized);
    const store = new EditorSessionStore(adapter);

    expect(adapter.value).toBeNull();
    expect(store.restore(identity())).toEqual({ kind: "empty" });
  });

  it("invalidates a prior source hash and reports why it was not restored", () => {
    const adapter = new MemoryAdapter();
    new EditorSessionStore(adapter).save(identity(), snapshot());
    const reloaded = new EditorSessionStore(adapter);

    expect(reloaded.restore(identity(undefined, "b".repeat(64)))).toEqual({ kind: "stale-source" });
    expect(adapter.value).toBeNull();
    expect(EDITOR_SESSION_STALE_SOURCE_MESSAGE).toContain("Python source changed");
  });

  it("removes all persisted sessions belonging to an unregistered workspace", () => {
    const adapter = new MemoryAdapter();
    const store = new EditorSessionStore(adapter, () => 100);
    store.save(identity("a.py#Scene"), snapshot());
    store.save(identity("b.py#Scene", "b".repeat(64)), snapshot());
    store.save(identity("other.py#Scene", "c".repeat(64), "project-b"), snapshot());

    store.clearProject("project-a");

    const reloaded = new EditorSessionStore(adapter);
    expect(reloaded.restore(identity("a.py#Scene"))).toEqual({ kind: "empty" });
    expect(reloaded.restore(identity("other.py#Scene", "c".repeat(64), "project-b"))).toMatchObject({
      kind: "restored",
    });
  });

  it("prunes unknown projects and keeps only the newest bounded session count", () => {
    const adapter = new MemoryAdapter();
    let clock = 0;
    const store = new EditorSessionStore(adapter, () => ++clock);
    for (let index = 0; index < MAX_STORED_EDITOR_SESSIONS + 5; index += 1) {
      store.save(identity(`scene-${index}.py#Scene`, `${index.toString(16).padStart(64, "0")}`), snapshot());
    }
    store.save(identity("other.py#Scene", "f".repeat(64), "project-b"), snapshot());
    store.pruneProjects(new Set(["project-a"]));

    const envelope = JSON.parse(adapter.value!) as { entries: readonly unknown[]; version: number };
    expect(envelope.version).toBe(EDITOR_SESSION_STORAGE_VERSION);
    expect(envelope.entries.length).toBeLessThanOrEqual(MAX_STORED_EDITOR_SESSIONS);
    expect(new TextEncoder().encode(adapter.value!).byteLength).toBeLessThanOrEqual(MAX_EDITOR_SESSION_STORAGE_BYTES);
    expect(JSON.stringify(envelope)).not.toContain("project-b");
  });

  it("keeps the in-memory session usable when persistent storage throws", () => {
    const throwingAdapter: EditorSessionStorageAdapter = {
      clear: () => {
        throw new Error("blocked");
      },
      read: () => {
        throw new Error("blocked");
      },
      write: () => {
        throw new Error("quota");
      },
    };
    const store = new EditorSessionStore(throwingAdapter);

    expect(store.save(identity(), snapshot())).toBe(true);
    expect(store.restore(identity())).toEqual({ kind: "restored", snapshot: snapshot() });
  });
});
