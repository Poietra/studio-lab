import type {
  AppliedProgramEdit,
  EditorProgramRecord,
  EditorSessionIdentity,
  RedoProgramEntry,
} from "./editor-session-store";
import { editorSessionIdentityKey } from "./editor-session-store";
import type { ProgramRecord } from "./model";
import { PRISTINE_WORKING_REVISION, type StudioPreviewEditingContextV1 } from "./preview-snapshot-provider";
import type { SceneEdit } from "./scene-edit-contract";

export const SOURCE_TIMING_LOADING_BLOCKER = "Wait for verified Scene timing before continuing.";
export const SOURCE_TIMING_MISMATCH_BLOCKER =
  "Verified Scene timing conflicts with this Studio edit history. Waiting will not resolve it; use Resolve timing to discard the Studio edit history and adopt the verified duration.";
export const EDITOR_SESSION_LOADING_BLOCKER = "Wait for the selected Scene's editor session to finish loading.";
export const WORKSPACE_REIMPORT_BLOCKER = "Wait for the updated Python source to finish reimporting before editing.";

export type VerifiedSourceDurationBasis = Readonly<{ duration: number; sessionKey: string }>;

export type EditorRevisionScene = Readonly<{
  name: string;
  runtimeSceneState: Readonly<{ duration: number }>;
  sceneId: string;
  sourceHash: string;
  sourcePath: string;
}>;

export type EditorWorkingRevisionInput = Readonly<{
  appliedEdits: readonly EditorProgramRecord[];
  draftEdit: ProgramRecord | null;
  editingAppliedProgram: AppliedProgramEdit | null;
  redoPrograms: readonly RedoProgramEntry[];
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function redoRevision(entry: RedoProgramEntry) {
  if (entry.kind === "draft") {
    return {
      edit: entry.edit ? { index: entry.edit.index, original: entry.edit.original.program } : null,
      kind: entry.kind,
      value: entry.value.program,
    };
  }
  return {
    kind: entry.kind,
    mutation:
      entry.mutation.kind === "append"
        ? {
            index: entry.mutation.index,
            kind: entry.mutation.kind,
            value: entry.mutation.value.program,
          }
        : {
            index: entry.mutation.index,
            kind: entry.mutation.kind,
            previous: entry.mutation.previous.program,
            value: entry.mutation.value.program,
          },
  };
}

/**
 * Exact identity of the canonical editor state that can affect current or
 * redo playback. Transaction IDs alone are insufficient because editing an
 * applied Program deliberately retains its transaction identity.
 */
export function canonicalEditorWorkingRevision(input: EditorWorkingRevisionInput) {
  if (
    input.appliedEdits.length === 0 &&
    input.draftEdit === null &&
    input.editingAppliedProgram === null &&
    input.redoPrograms.length === 0
  )
    return PRISTINE_WORKING_REVISION;
  return `studio-working-v1:${canonicalJson({
    applied: input.appliedEdits.map((record) => record.program),
    draft: input.draftEdit?.program ?? null,
    editing: input.editingAppliedProgram
      ? {
          index: input.editingAppliedProgram.index,
          original: input.editingAppliedProgram.original.program,
        }
      : null,
    redo: input.redoPrograms.map(redoRevision),
  })}`;
}

/** Exact preview revision for one durable Editor Document program list. */
export function canonicalAppliedProgramsWorkingRevisionV1(programs: readonly SceneEdit[]) {
  if (programs.length === 0) return PRISTINE_WORKING_REVISION;
  return `studio-working-v1:${canonicalJson({
    applied: programs,
    draft: null,
    editing: null,
    redo: [],
  })}`;
}

export type EditorSourceLifecycle = Readonly<{
  invalidated: boolean;
  sourceLifecyclePending: boolean;
  sourceMutationPending: boolean;
  sourceReimportPending: boolean;
  studioAuthoringLocked: boolean;
  workspaceRefreshing: boolean;
}>;

export function resolveEditorSourceLifecycle(
  input: Readonly<{
    activeProjectId: string | null;
    renderActionInProgress: boolean;
    sourceMutationPendingProjectId: string | null;
    sourceReimportTargetProjectId: string | null;
    workspaceRefreshing: boolean;
  }>,
): EditorSourceLifecycle {
  const sourceMutationPending =
    input.activeProjectId !== null &&
    (input.sourceMutationPendingProjectId === input.activeProjectId || input.renderActionInProgress);
  const sourceReimportPending =
    input.activeProjectId !== null && input.sourceReimportTargetProjectId === input.activeProjectId;
  const sourceLifecyclePending = sourceMutationPending || sourceReimportPending;
  return {
    invalidated: sourceLifecyclePending || input.workspaceRefreshing,
    sourceLifecyclePending,
    sourceMutationPending,
    sourceReimportPending,
    studioAuthoringLocked: sourceLifecyclePending || input.workspaceRefreshing,
    workspaceRefreshing: input.workspaceRefreshing,
  };
}

export type EditorRevision = Readonly<{
  asyncRevisionKey: string | null;
  editorPristine: boolean;
  previewContext: StudioPreviewEditingContextV1 | null;
  retainedSourceDuration: number | null;
  selectionAligned: boolean;
  sessionKey: string | null;
  sessionReady: boolean;
  workingRevision: string;
}>;

export function resolveEditorRevision(
  input: EditorWorkingRevisionInput &
    Readonly<{
      activeProjectId: string | null;
      invalidated: boolean;
      loadedSessionIdentity: EditorSessionIdentity | null;
      retainedSourceDurationBasis: VerifiedSourceDurationBasis | null;
      scene: EditorRevisionScene | null;
      workspaceProjectId: string | null;
    }>,
): EditorRevision {
  const workingRevision = canonicalEditorWorkingRevision(input);
  const editorPristine = workingRevision === PRISTINE_WORKING_REVISION;
  const selectionAligned =
    input.activeProjectId !== null && input.workspaceProjectId === input.activeProjectId && input.scene !== null;
  const identity: EditorSessionIdentity | null =
    selectionAligned && input.scene
      ? {
          projectId: input.activeProjectId!,
          sceneId: input.scene.sceneId,
          sourceHash: input.scene.sourceHash,
        }
      : null;
  const targetSessionKey = identity ? editorSessionIdentityKey(identity) : null;
  const loadedSessionKey = input.loadedSessionIdentity ? editorSessionIdentityKey(input.loadedSessionIdentity) : null;
  // `openSession` runs after the selection render. Until it installs the
  // target snapshot, every editor record still belongs to the previous Scene.
  const sessionReady = targetSessionKey !== null && targetSessionKey === loadedSessionKey;
  const sessionKey = sessionReady ? targetSessionKey : null;
  const retainedSourceDuration =
    sessionKey !== null && input.retainedSourceDurationBasis?.sessionKey === sessionKey
      ? input.retainedSourceDurationBasis.duration
      : null;
  const previewContext =
    sessionKey !== null && !input.invalidated && input.scene && input.activeProjectId
      ? {
          projectId: input.activeProjectId,
          sceneName: input.scene.name,
          sourceDuration: input.scene.runtimeSceneState.duration,
          sourceHash: input.scene.sourceHash,
          sourcePath: input.scene.sourcePath,
          workingRevision,
        }
      : null;
  return {
    asyncRevisionKey: previewContext
      ? canonicalJson([
          sessionKey,
          previewContext.sourcePath,
          previewContext.sceneName,
          previewContext.sourceHash,
          workingRevision,
        ])
      : null,
    editorPristine,
    previewContext,
    retainedSourceDuration,
    selectionAligned,
    sessionKey,
    sessionReady,
    workingRevision,
  };
}

/** One immutable verified duration basis per exact project/Scene/source session. */
export function resolveVerifiedSourceDurationBasis(
  input: Readonly<{
    candidate: number | null;
    editorPristine: boolean;
    retained: VerifiedSourceDurationBasis | null;
    sessionKey: string | null;
  }>,
) {
  const retained = input.retained?.sessionKey === input.sessionKey ? input.retained : null;
  const candidateValid = input.candidate !== null && Number.isFinite(input.candidate) && input.candidate >= 0.1;
  if (retained) {
    if (!candidateValid || Math.abs(input.candidate! - retained.duration) < 0.0005) {
      return { adoption: null, duration: retained.duration, mismatch: false } as const;
    }
    if (input.editorPristine) {
      const adoption = { duration: input.candidate!, sessionKey: input.sessionKey! };
      return { adoption, duration: adoption.duration, mismatch: false } as const;
    }
    return { adoption: null, duration: retained.duration, mismatch: true } as const;
  }
  if (!input.editorPristine) return { adoption: null, duration: null, mismatch: candidateValid } as const;
  if (input.sessionKey === null || !candidateValid) return { adoption: null, duration: null, mismatch: false } as const;
  const adoption = { duration: input.candidate!, sessionKey: input.sessionKey };
  return { adoption, duration: adoption.duration, mismatch: false } as const;
}

export type EditorRevisionDurationPolicy = Readonly<{
  adoption: VerifiedSourceDurationBasis | null;
  durationBlocked: boolean;
  durationBlockMessage: string | null;
  mismatch: boolean;
  renderPipelineLifecycleBlocker: string | null;
  resolvedVerifiedSourceDuration: number | null;
  sourceDurationBasisLoading: boolean;
}>;

export function resolveEditorRevisionDurationPolicy(
  input: Readonly<{
    candidate: number | null;
    lifecycle: EditorSourceLifecycle;
    metadataPhase: "failed" | "inactive" | "loading" | "ready" | null;
    providerPending: boolean;
    retained: VerifiedSourceDurationBasis | null;
    revision: EditorRevision;
  }>,
): EditorRevisionDurationPolicy {
  const basis = resolveVerifiedSourceDurationBasis({
    candidate: input.lifecycle.invalidated ? null : input.candidate,
    editorPristine: input.revision.editorPristine,
    retained: input.retained,
    sessionKey: input.revision.sessionKey,
  });
  const sourceDurationBasisLoading = input.providerPending || input.metadataPhase === "loading";
  const editorSessionHandoffPending = input.revision.selectionAligned && !input.revision.sessionReady;
  const renderPipelineLifecycleBlocker =
    input.lifecycle.sourceReimportPending || input.lifecycle.workspaceRefreshing
      ? WORKSPACE_REIMPORT_BLOCKER
      : editorSessionHandoffPending
        ? EDITOR_SESSION_LOADING_BLOCKER
        : basis.mismatch
          ? SOURCE_TIMING_MISMATCH_BLOCKER
          : sourceDurationBasisLoading
            ? SOURCE_TIMING_LOADING_BLOCKER
            : null;
  const durationBlockMessage = input.lifecycle.sourceMutationPending
    ? WORKSPACE_REIMPORT_BLOCKER
    : renderPipelineLifecycleBlocker;
  return {
    adoption: basis.adoption,
    durationBlocked: durationBlockMessage !== null,
    durationBlockMessage,
    mismatch: basis.mismatch,
    renderPipelineLifecycleBlocker,
    resolvedVerifiedSourceDuration: basis.duration,
    sourceDurationBasisLoading,
  };
}

/** Keeps a restored playhead intact until an explicit provider resolves. */
export function clampPlayheadToResolvedSourceDuration(currentTime: number, duration: number, pending: boolean) {
  return pending ? currentTime : Math.min(currentTime, duration);
}

/** Prevents a destructive timing reset from crossing a Scene/source switch. */
export function canResolveSourceDurationMismatch(
  input: Readonly<{
    currentSessionKey: string | null;
    mismatch: boolean;
    targetSessionKey: string | null;
  }>,
) {
  return input.mismatch && input.targetSessionKey !== null && input.targetSessionKey === input.currentSessionKey;
}
