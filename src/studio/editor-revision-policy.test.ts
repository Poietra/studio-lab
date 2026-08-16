import { describe, expect, it } from "vitest";

import {
  canonicalEditorWorkingRevision,
  EDITOR_SESSION_LOADING_BLOCKER,
  type EditorRevisionScene,
  type EditorSourceLifecycle,
  resolveEditorRevision,
  resolveEditorRevisionDurationPolicy,
  resolveEditorSourceLifecycle,
  SOURCE_TIMING_LOADING_BLOCKER,
  SOURCE_TIMING_MISMATCH_BLOCKER,
  WORKSPACE_REIMPORT_BLOCKER,
} from "./editor-revision-policy";
import type { AppliedProgramEdit, EditorProgramRecord, RedoProgramEntry } from "./editor-session-store";
import { PRISTINE_WORKING_REVISION } from "./preview-snapshot-provider";

function record(transactionId: string, evidence: readonly string[] = []): EditorProgramRecord {
  return {
    program: {
      anchor: {
        capturedPlayhead: 1,
        evidence: [],
        resolvedSeconds: 1,
        source: { kind: "playhead", referenceSeconds: 1 },
      },
      intentCount: 0,
      loweringStatus: "supported",
      operations: [],
      provenance: { evidence, origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [] },
      transactionId,
      version: 1,
    },
    validation: { issues: [], status: "valid" },
  };
}

const SCENE_HASH = "a".repeat(64);
const scene: EditorRevisionScene = {
  name: "SceneOne",
  runtimeSceneState: { duration: 2 },
  sceneId: "scene.py#SceneOne",
  sourceHash: SCENE_HASH,
  sourcePath: "scene.py",
};

function sessionIdentity(projectId = "project-a", targetScene: EditorRevisionScene = scene) {
  return {
    projectId,
    sceneId: targetScene.sceneId,
    sourceHash: targetScene.sourceHash,
  };
}

function lifecycle(overrides: Partial<EditorSourceLifecycle> = {}): EditorSourceLifecycle {
  return {
    invalidated: false,
    sourceLifecyclePending: false,
    sourceMutationPending: false,
    sourceReimportPending: false,
    studioAuthoringLocked: false,
    workspaceRefreshing: false,
    ...overrides,
  };
}

function revisionInput() {
  return {
    activeProjectId: "project-a",
    appliedEdits: [] as readonly EditorProgramRecord[],
    draftEdit: null,
    editingAppliedProgram: null,
    invalidated: false,
    loadedSessionIdentity: sessionIdentity(),
    redoPrograms: [] as readonly RedoProgramEntry[],
    retainedSourceDurationBasis: null,
    scene,
    workspaceProjectId: "project-a",
  };
}

describe("canonicalEditorWorkingRevision", () => {
  it("uses the protocol pristine identity only when no current or redo Program exists", () => {
    expect(canonicalEditorWorkingRevision(revisionInput())).toBe(PRISTINE_WORKING_REVISION);

    const value = record("tx-1");
    const edit: AppliedProgramEdit = { index: 0, original: value };
    const revisions = [
      canonicalEditorWorkingRevision({
        ...revisionInput(),
        appliedEdits: [value],
      }),
      canonicalEditorWorkingRevision({
        ...revisionInput(),
        draftEdit: value,
      }),
      canonicalEditorWorkingRevision({
        ...revisionInput(),
        editingAppliedProgram: edit,
      }),
      canonicalEditorWorkingRevision({
        ...revisionInput(),
        redoPrograms: [{ edit: null, kind: "draft", value }],
      }),
    ];

    expect(revisions.every((revision) => revision.startsWith("studio-working-v1:"))).toBe(true);
    expect(new Set(revisions)).toHaveLength(4);
  });

  it("identifies canonical content rather than only a retained transaction ID", () => {
    const original = record("same-transaction");
    const edited = record("same-transaction", ["changed-content"]);
    const originalRevision = canonicalEditorWorkingRevision({ ...revisionInput(), draftEdit: original });
    const editedRevision = canonicalEditorWorkingRevision({ ...revisionInput(), draftEdit: edited });

    expect(editedRevision).not.toBe(originalRevision);
    expect(canonicalEditorWorkingRevision({ ...revisionInput(), draftEdit: record("same-transaction") })).toBe(
      originalRevision,
    );
  });

  it("includes exact redo mutation content", () => {
    const first: RedoProgramEntry = {
      kind: "mutation",
      mutation: { index: 0, kind: "append", value: record("redo", ["first"]) },
    };
    const second: RedoProgramEntry = {
      kind: "mutation",
      mutation: { index: 0, kind: "append", value: record("redo", ["second"]) },
    };
    expect(canonicalEditorWorkingRevision({ ...revisionInput(), redoPrograms: [first] })).not.toBe(
      canonicalEditorWorkingRevision({ ...revisionInput(), redoPrograms: [second] }),
    );
  });
});

describe("resolveEditorRevision", () => {
  it("creates one aligned preview and async identity from workspace, Scene, source and editor state", () => {
    const resolved = resolveEditorRevision(revisionInput());

    expect(resolved).toMatchObject({
      editorPristine: true,
      previewContext: {
        projectId: "project-a",
        sceneName: scene.name,
        sourceDuration: 2,
        sourceHash: scene.sourceHash,
        sourcePath: scene.sourcePath,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      retainedSourceDuration: null,
      selectionAligned: true,
      sessionReady: true,
      workingRevision: PRISTINE_WORKING_REVISION,
    });
    expect(resolved.sessionKey).not.toBeNull();
    expect(resolved.asyncRevisionKey).not.toBeNull();
  });

  it.each([
    ["workspace selection", { workspaceProjectId: "project-b" }],
    ["missing project", { activeProjectId: null }],
    ["missing Scene", { scene: null }],
    ["source mutation", { invalidated: true }],
    ["editor session handoff", { loadedSessionIdentity: sessionIdentity("project-b") }],
  ] as const)("fails closed during a %s boundary", (_label, change) => {
    const resolved = resolveEditorRevision({ ...revisionInput(), ...change });
    expect(resolved.previewContext).toBeNull();
    expect(resolved.asyncRevisionKey).toBeNull();
  });

  it("marks the selected Scene unready until its editor session snapshot is installed", () => {
    const resolved = resolveEditorRevision({
      ...revisionInput(),
      loadedSessionIdentity: sessionIdentity("project-b"),
    });

    expect(resolved).toMatchObject({
      asyncRevisionKey: null,
      previewContext: null,
      selectionAligned: true,
      sessionKey: null,
      sessionReady: false,
    });
  });

  it("retains the session duration while a mutation hides all preview and async authority", () => {
    const aligned = resolveEditorRevision(revisionInput());
    if (aligned.sessionKey === null) throw new Error("Expected an aligned editor session.");
    const invalidated = resolveEditorRevision({
      ...revisionInput(),
      invalidated: true,
      retainedSourceDurationBasis: { duration: 3, sessionKey: aligned.sessionKey },
    });
    expect(invalidated).toMatchObject({
      asyncRevisionKey: null,
      previewContext: null,
      retainedSourceDuration: 3,
      sessionKey: aligned.sessionKey,
    });
  });

  it("changes identity on project, Scene, source path, source hash, and canonical mutation", () => {
    const original = resolveEditorRevision(revisionInput());
    const renamedScene = { ...scene, name: "SceneTwo", sceneId: "scene.py#SceneTwo" };
    const movedScene = { ...scene, sceneId: "other.py#SceneOne", sourcePath: "other.py" };
    const rehashedScene = { ...scene, sourceHash: "b".repeat(64) };
    const variants = [
      resolveEditorRevision({
        ...revisionInput(),
        activeProjectId: "project-b",
        loadedSessionIdentity: sessionIdentity("project-b"),
        workspaceProjectId: "project-b",
      }),
      resolveEditorRevision({
        ...revisionInput(),
        loadedSessionIdentity: sessionIdentity("project-a", renamedScene),
        scene: renamedScene,
      }),
      resolveEditorRevision({
        ...revisionInput(),
        loadedSessionIdentity: sessionIdentity("project-a", movedScene),
        scene: movedScene,
      }),
      resolveEditorRevision({
        ...revisionInput(),
        loadedSessionIdentity: sessionIdentity("project-a", rehashedScene),
        scene: rehashedScene,
      }),
      resolveEditorRevision({ ...revisionInput(), appliedEdits: [record("tx-1")] }),
    ];

    expect(new Set(variants.map((variant) => variant.asyncRevisionKey))).toHaveLength(variants.length);
    expect(variants.every((variant) => variant.asyncRevisionKey !== original.asyncRevisionKey)).toBe(true);
  });

  it("retains verified duration only for the exact source session", () => {
    const first = resolveEditorRevision(revisionInput());
    if (first.sessionKey === null) throw new Error("Expected an aligned editor session.");
    const retained = { duration: 3, sessionKey: first.sessionKey };
    expect(
      resolveEditorRevision({ ...revisionInput(), retainedSourceDurationBasis: retained }).retainedSourceDuration,
    ).toBe(3);
    expect(
      resolveEditorRevision({
        ...revisionInput(),
        retainedSourceDurationBasis: retained,
        scene: { ...scene, sourceHash: "b".repeat(64) },
      }).retainedSourceDuration,
    ).toBeNull();
  });
});

describe("editor source and duration policy", () => {
  it("invalidates only lifecycle work owned by the active project", () => {
    const otherProject = resolveEditorSourceLifecycle({
      activeProjectId: "project-a",
      renderActionInProgress: false,
      sourceMutationPendingProjectId: "project-b",
      sourceReimportTargetProjectId: "project-b",
      workspaceRefreshing: false,
    });
    expect(otherProject.invalidated).toBe(false);

    expect(
      resolveEditorSourceLifecycle({
        activeProjectId: "project-a",
        renderActionInProgress: true,
        sourceMutationPendingProjectId: null,
        sourceReimportTargetProjectId: null,
        workspaceRefreshing: false,
      }),
    ).toMatchObject({ invalidated: true, sourceMutationPending: true, studioAuthoringLocked: true });
    expect(
      resolveEditorSourceLifecycle({
        activeProjectId: "project-a",
        renderActionInProgress: false,
        sourceMutationPendingProjectId: null,
        sourceReimportTargetProjectId: "project-a",
        workspaceRefreshing: false,
      }),
    ).toMatchObject({ invalidated: true, sourceReimportPending: true, studioAuthoringLocked: true });
    expect(
      resolveEditorSourceLifecycle({
        activeProjectId: "project-a",
        renderActionInProgress: false,
        sourceMutationPendingProjectId: null,
        sourceReimportTargetProjectId: null,
        workspaceRefreshing: true,
      }),
    ).toMatchObject({ invalidated: true, studioAuthoringLocked: true, workspaceRefreshing: true });
  });

  it("adopts while pristine, retains without a provider, and blocks a changed basis after edits", () => {
    const pristine = resolveEditorRevision(revisionInput());
    const adopted = resolveEditorRevisionDurationPolicy({
      candidate: 3,
      lifecycle: lifecycle(),
      metadataPhase: "ready",
      providerPending: false,
      retained: null,
      revision: pristine,
    });
    expect(adopted).toMatchObject({
      adoption: { duration: 3, sessionKey: pristine.sessionKey },
      mismatch: false,
      resolvedVerifiedSourceDuration: 3,
    });
    const retained = adopted.adoption;
    if (retained === null) throw new Error("Expected the pristine basis to be adopted.");
    const edited = resolveEditorRevision({ ...revisionInput(), appliedEdits: [record("tx-1")] });
    expect(
      resolveEditorRevisionDurationPolicy({
        candidate: null,
        lifecycle: lifecycle(),
        metadataPhase: "inactive",
        providerPending: false,
        retained,
        revision: edited,
      }),
    ).toMatchObject({ mismatch: false, resolvedVerifiedSourceDuration: 3 });
    expect(
      resolveEditorRevisionDurationPolicy({
        candidate: 4,
        lifecycle: lifecycle(),
        metadataPhase: "ready",
        providerPending: false,
        retained,
        revision: edited,
      }),
    ).toMatchObject({
      durationBlockMessage: SOURCE_TIMING_MISMATCH_BLOCKER,
      mismatch: true,
      resolvedVerifiedSourceDuration: 3,
    });
  });

  it("does not adopt invalidated evidence and preserves lifecycle blocker precedence", () => {
    const revision = resolveEditorRevision(revisionInput());
    expect(
      resolveEditorRevisionDurationPolicy({
        candidate: 3,
        lifecycle: lifecycle({ invalidated: true, sourceMutationPending: true }),
        metadataPhase: "ready",
        providerPending: false,
        retained: null,
        revision,
      }),
    ).toMatchObject({ adoption: null, durationBlockMessage: WORKSPACE_REIMPORT_BLOCKER });
    expect(
      resolveEditorRevisionDurationPolicy({
        candidate: null,
        lifecycle: lifecycle(),
        metadataPhase: "loading",
        providerPending: false,
        retained: null,
        revision,
      }).durationBlockMessage,
    ).toBe(SOURCE_TIMING_LOADING_BLOCKER);
  });

  it("blocks authoring synchronously while the selected Scene session is handing off", () => {
    const revision = resolveEditorRevision({
      ...revisionInput(),
      loadedSessionIdentity: sessionIdentity("project-b"),
    });

    expect(
      resolveEditorRevisionDurationPolicy({
        candidate: 3,
        lifecycle: lifecycle(),
        metadataPhase: "ready",
        providerPending: false,
        retained: null,
        revision,
      }),
    ).toMatchObject({
      adoption: null,
      durationBlocked: true,
      durationBlockMessage: EDITOR_SESSION_LOADING_BLOCKER,
      renderPipelineLifecycleBlocker: EDITOR_SESSION_LOADING_BLOCKER,
    });
  });
});
