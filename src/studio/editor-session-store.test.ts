import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import {
  STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "../engine/fragment-material-registry";
import { createStudioEntitiesProgram, replaceStudioTextContentProgram } from "./authoring-commands";
import { resolveVerifiedSourceDurationBasis } from "./editor-revision-policy";
import {
  EDITOR_SESSION_STALE_SOURCE_MESSAGE,
  EDITOR_SESSION_STORAGE_VERSION,
  type EditorSessionIdentity,
  type EditorSessionSnapshot,
  type EditorSessionStorageAdapter,
  EditorSessionStore,
  editorSessionStorageKey,
  MAX_EDITOR_SESSION_STORAGE_BYTES,
  MAX_STORED_EDITOR_SESSIONS,
  WebStorageEditorSessionAdapter,
} from "./editor-session-store";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  assignStudioFragmentMaterialV1,
  createStudioFragmentMaterialV1,
  createStudioGradientFragmentMaterialPresetV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  projectFragmentMaterialsForSceneV1,
  recordStudioFragmentMaterialGlslDiagnosticV1,
  removeStudioFragmentMaterialV1,
  updateStudioFragmentMaterialFromGlslV1,
  updateStudioFragmentMaterialParameterSchemaV1,
  updateStudioFragmentMaterialParameterV1,
} from "./fragment-material-authoring";
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

class KeyedMemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function identity(
  sceneId = "examples/scene.py#ExampleScene",
  sourceHash = "a".repeat(64),
  projectId = "project-a",
): EditorSessionIdentity {
  return { projectId, sceneId, sourceHash };
}

function assignedFragmentMaterials(sceneId: string, entityId: string) {
  const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
  return assignStudioFragmentMaterialV1(material.state, { entityId, sceneId, shaderId: material.shaderId });
}

function record(transactionId: string) {
  const operationId = `${transactionId}/set-appearance`;
  return {
    program: {
      anchor: {
        capturedPlayhead: 2,
        evidence: ["captured-playhead:2.000"],
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
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operationId] },
      transactionId,
      version: 1,
    },
    validation: { issues: [], status: "valid" },
  } as const satisfies ProgramRecord;
}

function draftRecord(transactionId: string) {
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
  const draft = draftRecord("draft");
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
    lockedEntityIds: ["equation"],
    motionDuration: 2.5,
    redoPrograms: [{ edit: null, kind: "draft", value: draftRecord("redo") }],
    selectedObjectIds: ["equation"],
    verifiedSourceDurationBasis: { duration: 1, sessionKey: "session-a" },
  });
}

describe("durable editor session storage", () => {
  it("uses disjoint validated browser keys for each account and organization", () => {
    const first = editorSessionStorageKey({
      organizationId: "organization-a",
      userId: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8",
    });
    const second = editorSessionStorageKey({
      organizationId: "organization-b",
      userId: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8",
    });
    const third = editorSessionStorageKey({
      organizationId: "organization-a",
      userId: "35b33044-5387-4c29-aed1-cad82750f4cc",
    });

    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
    expect(first).toBe("poietra.studio.editor-sessions.2f2e3ea4-88de-4f37-81f7-1860d8f942f8.organization-a");
    expect(second).toBe("poietra.studio.editor-sessions.2f2e3ea4-88de-4f37-81f7-1860d8f942f8.organization-b");
    expect(editorSessionStorageKey()).toBe("poietra.studio.editor-sessions");
    expect(() =>
      editorSessionStorageKey({
        organizationId: "../foreign",
        userId: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8",
      }),
    ).toThrow("account scope is invalid");
  });

  it("never restores the same project identity from another account scope", () => {
    const storage = new KeyedMemoryStorage();
    const firstKey = editorSessionStorageKey({
      organizationId: "organization-a",
      userId: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8",
    });
    const secondKey = editorSessionStorageKey({
      organizationId: "organization-b",
      userId: "35b33044-5387-4c29-aed1-cad82750f4cc",
    });
    new EditorSessionStore(new WebStorageEditorSessionAdapter(storage, firstKey)).save(identity(), {
      ...snapshot(),
      currentTime: 1,
    });
    new EditorSessionStore(new WebStorageEditorSessionAdapter(storage, secondKey)).save(identity(), {
      ...snapshot(),
      currentTime: 2,
    });

    expect(
      new EditorSessionStore(new WebStorageEditorSessionAdapter(storage, firstKey)).restore(identity()),
    ).toMatchObject({ kind: "restored", snapshot: { currentTime: 1 } });
    expect(
      new EditorSessionStore(new WebStorageEditorSessionAdapter(storage, secondKey)).restore(identity()),
    ).toMatchObject({ kind: "restored", snapshot: { currentTime: 2 } });
  });

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
    expect(restored).toMatchObject({
      kind: "restored",
      snapshot: {
        draftProgram: { program: { intentCount: 0, operations: [] }, validation: { status: "invalid" } },
      },
    });
  });

  it("restores canonical Studio Text font size and weight from the editor session", () => {
    const adapter = new MemoryAdapter();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 2,
      entities: [
        {
          content: { displayLines: ["Sized Text"], label: "Sized Text", text: "Sized Text" },
          position: { x: 320, y: 180 },
          type: "Text",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "sized-text",
    });
    const owner = programRecord(creation.validation.program, creation.validation);
    const replacement = replaceStudioTextContentProgram({
      content: {
        displayLines: ["Sized Text"],
        label: "Sized Text",
        text: "Sized Text",
        textLayout: {
          alignment: "left",
          fontFamily: "mono",
          fontSize: 1.75,
          fontWeight: "bold",
          lineHeight: 1.2,
        },
      },
      entityId: creation.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const applied = editorProgramRecord(programRecord(replacement.program, replacement), null, creation.entityIds);
    const sizedTextSnapshot = snapshotEditorSession({
      ...createInitialEditorState(),
      appliedPrograms: [applied],
      programUndoEntries: [{ index: 0, kind: "append", value: applied }],
      selectedObjectIds: ["tx:sized-text/entity:text"],
    });
    const store = new EditorSessionStore(adapter);

    expect(store.save(identity(), sizedTextSnapshot)).toBe(true);

    const restored = new EditorSessionStore(adapter).restore(identity());
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("Expected the sized Text session to restore.");
    const create = restored.snapshot.appliedPrograms[0]?.program.operations.find(
      (operation) => operation.kind === "CreateEntity",
    );
    expect(create?.kind === "CreateEntity" ? create.entity.content?.textLayout : null).toEqual({
      alignment: "left",
      fontFamily: "mono",
      fontSize: 1.75,
      fontWeight: "bold",
      lineHeight: 1.2,
    });
  });

  it("preserves transient inputs while switching Scenes within the same SPA", () => {
    const store = new EditorSessionStore(new MemoryAdapter());
    store.save(identity(), snapshot());

    expect(store.restore(identity())).toEqual({ kind: "restored", snapshot: snapshot() });
  });

  it("restores preset parameters and Scene-isolated assignments through the existing storage authority", () => {
    const adapter = new MemoryAdapter();
    const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
    const sceneA = assignStudioFragmentMaterialV1(material.state, {
      entityId: "source:scene.py#SceneA:rectangle",
      sceneId: "scene.py#SceneA",
      shaderId: material.shaderId,
    });
    const sceneB = assignStudioFragmentMaterialV1(sceneA, {
      entityId: "circle",
      sceneId: "scene.py#SceneB",
      shaderId: material.shaderId,
    });
    const authored = updateStudioFragmentMaterialParameterV1(sceneB, {
      entityId: "circle",
      name: "Speed",
      sceneId: "scene.py#SceneB",
      value: 1.25,
    });
    expect(new EditorSessionStore(adapter).saveProjectFragmentMaterials("project-a", authored)).toBe(true);
    expect(JSON.parse(adapter.value!)).toMatchObject({
      fragmentMaterials: { "project-a": { sourceLanguage: "wgsl" } },
      version: EDITOR_SESSION_STORAGE_VERSION,
    });

    const reloaded = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");
    expect(reloaded.registry.materials[0]).toMatchObject({
      revision: 1,
      source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
    });
    expect(projectFragmentMaterialsForSceneV1(reloaded, "scene.py#SceneA").assignments).toHaveProperty(
      "source:scene.py#SceneA:rectangle",
    );
    expect(projectFragmentMaterialsForSceneV1(reloaded, "scene.py#SceneA").assignments).not.toHaveProperty("circle");
    expect(projectFragmentMaterialsForSceneV1(reloaded, "scene.py#SceneB").assignments).toHaveProperty("circle");
    expect(reloaded.parameterSchemasByShaderId[material.shaderId]).toMatchObject([
      { name: "Speed", type: "f32" },
      { name: "Bands", type: "f32" },
    ]);
    expect(projectFragmentMaterialsForSceneV1(reloaded, "scene.py#SceneB").assignments.circle?.parameters).toEqual([
      1.25, 8,
    ]);

    const withoutSceneA = removeStudioFragmentMaterialV1(reloaded, {
      entityId: "source:scene.py#SceneA:rectangle",
      sceneId: "scene.py#SceneA",
    });
    expect(new EditorSessionStore(adapter).saveProjectFragmentMaterials("project-a", withoutSceneA)).toBe(true);
    const reopened = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");
    expect(projectFragmentMaterialsForSceneV1(reopened, "scene.py#SceneA").assignments).toEqual({});
    expect(reopened.registry.materials[0]?.source).toBe(STUDIO_WAVE_FRAGMENT_SOURCE_V1);
  });

  it("restores a custom scalar schema and its assignment defaults through the existing storage authority", () => {
    const adapter = new MemoryAdapter();
    const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Custom" });
    const authored = updateStudioFragmentMaterialParameterSchemaV1(material.state, {
      parameterSchema: [
        { default: 0.25, name: "Amount", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        { default: 6, name: "Count", range: { max: 16, min: 1, step: 1 }, type: "f32" },
      ],
      shaderId: material.shaderId,
    });
    const assigned = assignStudioFragmentMaterialV1(authored, {
      entityId: "circle",
      sceneId: "scene.py#SceneA",
      shaderId: material.shaderId,
    });

    expect(new EditorSessionStore(adapter).saveProjectFragmentMaterials("project-a", assigned)).toBe(true);
    const restored = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");

    expect(restored.parameterSchemasByShaderId[material.shaderId]).toEqual(
      authored.parameterSchemasByShaderId[material.shaderId],
    );
    expect(projectFragmentMaterialsForSceneV1(restored, "scene.py#SceneA").assignments.circle?.parameters).toEqual([
      0.25, 6,
    ]);
  });

  it("restores Gradient RGB parameters through the existing flat material ABI", () => {
    const adapter = new MemoryAdapter();
    const gradient = createStudioGradientFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    const assigned = assignStudioFragmentMaterialV1(gradient.state, {
      entityId: "circle",
      sceneId: "scene.py#SceneA",
      shaderId: gradient.shaderId,
    });
    const recolored = updateStudioFragmentMaterialParameterV1(assigned, {
      entityId: "circle",
      name: "Warm",
      sceneId: "scene.py#SceneA",
      value: [0.9, 0.4, 0.1],
    });

    expect(new EditorSessionStore(adapter).saveProjectFragmentMaterials("project-a", recolored)).toBe(true);
    const restored = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");

    expect(restored.registry.materials[0]?.source).toBe(STUDIO_GRADIENT_FRAGMENT_SOURCE_V1);
    expect(restored.parameterSchemasByShaderId[gradient.shaderId]).toMatchObject([
      { name: "Angle", type: "f32" },
      { name: "Spread", type: "f32" },
      { default: [0.2, 0.55, 1], name: "Cool", type: "rgb" },
      { default: [1, 0.3, 0.65], name: "Warm", type: "rgb" },
    ]);
    expect(projectFragmentMaterialsForSceneV1(restored, "scene.py#SceneA").assignments.circle?.parameters).toEqual([
      0.75, 1.5, 0.2, 0.55, 1, 0.9, 0.4, 0.1,
    ]);
  });

  it("restores a pre-named-material envelope without clearing other editor storage", () => {
    const adapter = new MemoryAdapter(
      JSON.stringify({
        entries: [],
        fragmentMaterials: {
          "project-a": {
            sourceLanguage: "wgsl",
            state: {
              assignmentsByScene: {
                "scene.py#SceneA": {
                  circle: { parameters: [0.35, 8], revision: 1, shaderId: "project-studio-fragment" },
                },
              },
              registry: {
                materials: [
                  {
                    revision: 1,
                    shaderId: "project-studio-fragment",
                    source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
                  },
                ],
                schema: "poietra.fragment-material-registry",
                version: 1,
              },
            },
          },
        },
        version: EDITOR_SESSION_STORAGE_VERSION,
      }),
    );

    const restored = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");
    expect(restored.namesByShaderId).toEqual({ "project-studio-fragment": "Wave material" });
    expect(projectFragmentMaterialsForSceneV1(restored, "scene.py#SceneA").assignments.circle).toMatchObject({
      shaderId: "project-studio-fragment",
    });
    expect(adapter.value).toContain("namesByShaderId");
  });

  it("restores a rejected GLSL draft and diagnostic beside the last canonical WGSL", () => {
    const adapter = new MemoryAdapter();
    const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "GLSL" });
    const source = "#version 450\nvoid main() {}";
    const imported = updateStudioFragmentMaterialFromGlslV1(material.state, {
      entryPoint: "main",
      shaderId: material.shaderId,
      source,
      wgsl: "@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
    });
    const rejected = recordStudioFragmentMaterialGlslDiagnosticV1(imported, {
      diagnostic: "material.glsl:2:12: expected ')'",
      entryPoint: "main",
      shaderId: material.shaderId,
      source: "#version 450\nvoid main( {",
    });
    expect(new EditorSessionStore(adapter).saveProjectFragmentMaterials("project-a", rejected)).toBe(true);

    const restored = new EditorSessionStore(adapter).restoreProjectFragmentMaterials("project-a");
    expect(restored.glslSourcesByShaderId[material.shaderId]).toEqual({
      diagnostic: "material.glsl:2:12: expected ')'",
      entryPoint: "main",
      source: "#version 450\nvoid main( {",
    });
    expect(restored.registry.materials[0]?.source).toContain("fn fs_main");
  });

  it("separates cloud management from exact migrated-entry deletion", () => {
    const adapter = new MemoryAdapter();
    const migrated = identity("examples/scene.py#Migrated");
    const retained = identity("examples/scene.py#Retained");
    const store = new EditorSessionStore(adapter);
    store.save(migrated, { ...snapshot(), currentTime: 1 });
    store.save(retained, { ...snapshot(), currentTime: 2 });

    expect(store.markCloudManaged(migrated)).toBe(true);
    expect(store.isCloudManaged(migrated)).toBe(true);
    expect(store.save(migrated, { ...snapshot(), currentTime: 3 })).toBe(false);

    const marked = new EditorSessionStore(adapter);
    expect(marked.restore(migrated)).toMatchObject({ kind: "restored", snapshot: { currentTime: 1 } });
    expect(marked.restore(retained)).toMatchObject({ kind: "restored", snapshot: { currentTime: 2 } });

    expect(store.clearMigrated(migrated)).toBe(true);

    const reopened = new EditorSessionStore(adapter);
    expect(reopened.restore(migrated)).toEqual({ kind: "empty" });
    expect(reopened.restore(retained)).toMatchObject({ kind: "restored", snapshot: { currentTime: 2 } });
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
    store.saveProjectFragmentMaterials("project-a", assignedFragmentMaterials("scene-a", "circle"));

    store.clearProject("project-a");

    const reloaded = new EditorSessionStore(adapter);
    expect(reloaded.restore(identity("a.py#Scene"))).toEqual({ kind: "empty" });
    expect(reloaded.restore(identity("other.py#Scene", "c".repeat(64), "project-b"))).toMatchObject({
      kind: "restored",
    });
    expect(reloaded.restoreProjectFragmentMaterials("project-a")).toBe(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
  });

  it("prunes unknown projects and keeps only the newest bounded session count", () => {
    const adapter = new MemoryAdapter();
    let clock = 0;
    const store = new EditorSessionStore(adapter, () => ++clock);
    for (let index = 0; index < MAX_STORED_EDITOR_SESSIONS + 5; index += 1) {
      store.save(identity(`scene-${index}.py#Scene`, `${index.toString(16).padStart(64, "0")}`), snapshot());
    }
    store.save(identity("other.py#Scene", "f".repeat(64), "project-b"), snapshot());
    store.saveProjectFragmentMaterials("project-b", assignedFragmentMaterials("scene-b", "circle"));
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
