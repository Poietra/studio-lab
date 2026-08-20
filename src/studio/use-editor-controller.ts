import { type SetStateAction, useCallback, useEffect, useReducer, useRef } from "react";

import type { PendingClarification } from "../ai/clarification";
import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
import { type EditorSessionSnapshotV1, parseEditorSessionSnapshotV1 } from "../collaboration/editor-session-contract";
import { editorProgramsMatchAuthorityV1 } from "./editor-authority-state";
import {
  type AppliedProgramEdit,
  type AppliedProgramMutation,
  browserEditorSessionStorageAdapter,
  type DraftEditorProgramRecord,
  durableEditorSessionSnapshotV1,
  EDITOR_SESSION_STALE_SOURCE_MESSAGE,
  type EditorProgramRecord,
  type EditorSessionAccountScope,
  type EditorSessionIdentity,
  type EditorSessionSnapshot,
  EditorSessionStore,
  editorSessionIdentityKey,
  type RedoProgramEntry,
} from "./editor-session-store";
import type { ProjectFragmentMaterialStateV1 } from "./fragment-material-authoring";
import type { SuggestionStatus } from "./magic-edit-panel";
import type { ProgramRecord } from "./model";
import { programExecutionCapabilities } from "./operation-registry";
import { isSceneDurationOperation } from "./operations";
import { sourceTimeToWorkingTime } from "./program-composition";
import { sceneEditSchema } from "./scene-edit-contract";
import type { StudioTool } from "./studio-toolbar";
import type { InteractionMode } from "./studio-viewport";
import { STUDIO_STYLE_PROFILE } from "./style-profile";
import { appendAppliedProgram, replaceAppliedProgram } from "./transactions";

function editorTransitionTime(programs: readonly ProgramRecord["program"][], sourceTime: number, currentTime: number) {
  return programs.some((program) => program.operations.some(isSceneDurationOperation))
    ? currentTime
    : sourceTimeToWorkingTime(programs, sourceTime);
}

export type {
  AppliedProgramEdit,
  AppliedProgramMetadata,
  AppliedProgramMutation,
  EditorProgramRecord,
  EditorSessionIdentity,
  EditorSessionSnapshot,
  RedoProgramEntry,
} from "./editor-session-store";

export type EditorControllerState = EditorSessionSnapshot &
  Readonly<{
    isPlaying: boolean;
    pendingClarification: PendingClarification | null;
    suggestion: EditSuggestion | null;
    suggestionMessage: string | null;
    suggestionStatus: SuggestionStatus;
  }>;

type StageDraftInput = Readonly<{
  appliedEdit?: AppliedProgramEdit | null;
  clearAppliedEdit?: boolean;
  clearSuggestion?: boolean;
  currentTime?: number;
  operation: EditSuggestionOperation | null;
  preserveAppliedProgram?: ProgramRecord | null;
  record: ProgramRecord;
  selectedObjectIds?: readonly string[];
  stopPlayback?: boolean;
}>;

type AppliedProgramEditInput = Readonly<{
  focusSourceTime?: number;
  operation?: EditSuggestionOperation;
  record?: ProgramRecord;
}>;

type EditorControllerAction =
  | Readonly<{ state: EditorControllerState; type: "replace" }>
  | Readonly<{
      update: (state: EditorControllerState) => EditorControllerState;
      type: "update";
    }>;

const SESSION_AUTOSAVE_DELAY_MS = 300;

export function editorProgramRecord(
  record: ProgramRecord,
  operation: EditSuggestionOperation | null,
  selection: readonly string[],
): EditorProgramRecord {
  if (record.validation.status !== "valid") {
    throw new TypeError("Only a valid Scene Edit can become an applied editor record.");
  }
  return {
    editorMetadata: { operation, selection },
    program: sceneEditSchema.parse(record.program),
    validation: { issues: record.validation.issues, status: "valid" },
  };
}

export function draftEditorProgramRecord(
  record: ProgramRecord,
  operation: EditSuggestionOperation | null,
  selection: readonly string[],
): DraftEditorProgramRecord {
  return { ...record, editorMetadata: { operation, selection } };
}

export function createInitialEditorState(): EditorControllerState {
  return {
    appliedPrograms: [],
    currentTime: 0,
    durationError: null,
    draftError: null,
    draftOperation: null,
    draftProgram: null,
    editingAppliedProgram: null,
    insertTool: "select",
    insertValue: "",
    instruction: "",
    interactionMode: "animate",
    isPlaying: false,
    lockedEntityIds: [],
    motionDuration: STUDIO_STYLE_PROFILE.durationSeconds.deliberate,
    pendingClarification: null,
    programUndoEntries: [],
    redoPrograms: [],
    selectedObjectIds: [],
    suggestion: null,
    suggestionMessage: null,
    suggestionStatus: "idle",
    verifiedSourceDurationBasis: null,
  };
}

export function editorControllerReducer(state: EditorControllerState, action: EditorControllerAction) {
  return action.type === "replace" ? action.state : action.update(state);
}

function withoutSuggestion(state: EditorControllerState): EditorControllerState {
  return {
    ...state,
    pendingClarification: null,
    suggestion: null,
    suggestionMessage: null,
    suggestionStatus: "idle",
  };
}

export function snapshotEditorSession(state: EditorControllerState): EditorSessionSnapshot {
  return {
    appliedPrograms: state.appliedPrograms,
    currentTime: state.currentTime,
    durationError: state.durationError,
    draftError: state.draftError,
    draftOperation: state.draftOperation,
    draftProgram: state.draftProgram,
    editingAppliedProgram: state.editingAppliedProgram,
    insertTool: state.insertTool,
    insertValue: state.insertValue,
    instruction: state.instruction,
    interactionMode: state.interactionMode,
    lockedEntityIds: state.lockedEntityIds,
    motionDuration: state.motionDuration,
    programUndoEntries: state.programUndoEntries,
    redoPrograms: state.redoPrograms,
    selectedObjectIds: state.selectedObjectIds,
    verifiedSourceDurationBasis: state.verifiedSourceDurationBasis,
  };
}

/** Subject-private editor state suitable for the strict cloud wire contract. */
export function snapshotCloudEditorSessionV1(state: EditorControllerState): EditorSessionSnapshotV1 {
  return durableEditorSessionSnapshotV1(snapshotEditorSession(state));
}

export function restoreEditorSession(
  state: EditorControllerState,
  snapshot: EditorSessionSnapshot,
): EditorControllerState {
  return withoutSuggestion({
    ...state,
    ...snapshot,
    isPlaying: false,
  });
}

export type CloudEditorSessionInstallResultV1 =
  | Readonly<{ kind: "installed"; state: EditorControllerState }>
  | Readonly<{ kind: "invalid-snapshot" }>
  | Readonly<{ kind: "projection-mismatch" }>;

/**
 * Installs private cloud state only when it is an exact companion to the
 * already revalidated authoritative projection. Canonical Programs and their
 * browser validation stay authoritative; only private authoring metadata is
 * copied from the subject snapshot.
 */
export function installCloudEditorSessionSnapshotV1(
  state: EditorControllerState,
  authoritativePrograms: readonly EditorProgramRecord[],
  snapshotValue: unknown,
): CloudEditorSessionInstallResultV1 {
  let parsed: EditorSessionSnapshotV1;
  try {
    parsed = parseEditorSessionSnapshotV1(snapshotValue);
  } catch {
    return { kind: "invalid-snapshot" };
  }
  if (
    !editorProgramsMatchAuthorityV1(
      parsed.appliedPrograms,
      authoritativePrograms.map((record) => record.program),
    )
  ) {
    return { kind: "projection-mismatch" };
  }
  const appliedPrograms = authoritativePrograms.map((record, index) => {
    const { editorMetadata: _ignoredMetadata, ...authoritativeRecord } = record;
    const editorMetadata = parsed.appliedPrograms[index]?.editorMetadata;
    return editorMetadata === undefined ? authoritativeRecord : { ...authoritativeRecord, editorMetadata };
  });
  const snapshot: EditorSessionSnapshot = {
    ...parsed,
    appliedPrograms,
    durationError: null,
    draftError: null,
    insertValue: "",
    instruction: "",
    lockedEntityIds: parsed.lockedEntityIds ?? [],
  };
  return { kind: "installed", state: restoreEditorSession(state, snapshot) };
}

export function initializeEditorScene(
  state: EditorControllerState,
  input: Readonly<{ currentTime: number; selectedObjectIds: readonly string[] }>,
): EditorControllerState {
  return {
    ...createInitialEditorState(),
    currentTime: input.currentTime,
    interactionMode: state.interactionMode,
    lockedEntityIds: [],
    motionDuration: state.motionDuration,
    selectedObjectIds: input.selectedObjectIds,
  };
}

function applyBlocker(record: ProgramRecord) {
  const execution = programExecutionCapabilities(record.program);
  return record.validation.status !== "valid" || execution.apply !== "supported"
    ? (execution.applyBlocker ?? "This Program is invalid and cannot be applied.")
    : null;
}

export function stageEditorDraft(state: EditorControllerState, input: StageDraftInput): EditorControllerState {
  const preflightError = editorDraftPreflightError(state, input);
  if (preflightError) return { ...state, draftError: preflightError };
  let appliedPrograms = state.appliedPrograms;
  let programUndoEntries = state.programUndoEntries;
  const preserved = input.preserveAppliedProgram;
  if (
    preserved &&
    !appliedPrograms.some((candidate) => candidate.program.transactionId === preserved.program.transactionId)
  ) {
    const blocker = applyBlocker(preserved);
    if (blocker) return { ...state, draftError: blocker };
    const value = editorProgramRecord(preserved, state.draftOperation, state.selectedObjectIds);
    const appended = appendAppliedProgram(appliedPrograms, value);
    if (appended.kind === "rejected") return { ...state, draftError: appended.reason };
    const mutation = {
      index: appended.index,
      kind: "append",
      value,
    } satisfies AppliedProgramMutation;
    appliedPrograms = appended.programs;
    programUndoEntries = [...programUndoEntries, mutation];
  }
  const next = {
    ...state,
    appliedPrograms,
    currentTime: input.currentTime ?? state.currentTime,
    draftError: programExecutionCapabilities(input.record.program).applyBlocker,
    draftOperation: input.operation,
    draftProgram: input.record,
    editingAppliedProgram:
      input.appliedEdit !== undefined ? input.appliedEdit : input.clearAppliedEdit ? null : state.editingAppliedProgram,
    isPlaying: input.stopPlayback ? false : state.isPlaying,
    programUndoEntries,
    redoPrograms: [],
    selectedObjectIds: input.selectedObjectIds ?? state.selectedObjectIds,
  };
  return input.clearSuggestion ? withoutSuggestion(next) : next;
}

function editorDraftPreflightError(state: EditorControllerState, input: StageDraftInput) {
  let programs: readonly ProgramRecord[] = state.appliedPrograms;
  const preserved = input.preserveAppliedProgram;
  if (preserved && !programs.some((candidate) => candidate.program.transactionId === preserved.program.transactionId)) {
    const blocker = applyBlocker(preserved);
    if (blocker) return blocker;
    const appended = appendAppliedProgram(
      programs,
      editorProgramRecord(preserved, state.draftOperation, state.selectedObjectIds),
    );
    if (appended.kind === "rejected") return appended.reason;
    programs = appended.programs;
  }
  const candidate = draftEditorProgramRecord(
    input.record,
    input.operation,
    input.selectedObjectIds ?? state.selectedObjectIds,
  );
  const activeEdit =
    input.appliedEdit !== undefined ? input.appliedEdit : input.clearAppliedEdit ? null : state.editingAppliedProgram;
  const result = activeEdit
    ? replaceAppliedProgram(programs, activeEdit.original.program.transactionId, candidate)
    : appendAppliedProgram(programs, candidate);
  return result.kind === "rejected" ? result.reason : null;
}

export function discardEditorDraft(state: EditorControllerState): EditorControllerState {
  const discardedTransactionId = state.draftProgram?.program.transactionId;
  const discardedAppliedEdit = state.editingAppliedProgram;
  return withoutSuggestion({
    ...state,
    draftError: null,
    draftOperation: null,
    draftProgram: null,
    editingAppliedProgram: null,
    selectedObjectIds:
      discardedTransactionId && !discardedAppliedEdit
        ? state.selectedObjectIds.filter((id) => !id.startsWith(`tx:${discardedTransactionId}/entity:`))
        : state.selectedObjectIds,
  });
}

export function suspendEditor(state: EditorControllerState): EditorControllerState {
  return withoutSuggestion({
    ...state,
    isPlaying: false,
  });
}

export function installAuthoritativeEditorPrograms(
  state: EditorControllerState,
  programs: readonly EditorProgramRecord[],
  message: string | null = null,
): EditorControllerState {
  return withoutSuggestion({
    ...state,
    appliedPrograms: programs,
    draftError: message,
    draftOperation: null,
    draftProgram: null,
    editingAppliedProgram: null,
    isPlaying: false,
    programUndoEntries: [],
    redoPrograms: [],
    selectedObjectIds: [],
  });
}

export function applyEditorDraft(state: EditorControllerState): EditorControllerState {
  if (!state.draftProgram) return state;
  const blocker = applyBlocker(state.draftProgram);
  if (blocker) return { ...state, draftError: blocker };
  const value = editorProgramRecord(state.draftProgram, state.draftOperation, state.selectedObjectIds);
  let appliedPrograms: readonly EditorProgramRecord[];
  let mutation: AppliedProgramMutation;
  if (state.editingAppliedProgram) {
    const replacement = replaceAppliedProgram(
      state.appliedPrograms,
      state.editingAppliedProgram.original.program.transactionId,
      value,
    );
    if (replacement.kind === "rejected") {
      return { ...state, draftError: replacement.reason };
    }
    appliedPrograms = replacement.programs;
    mutation = {
      index: replacement.index,
      kind: "replace",
      previous: state.editingAppliedProgram.original,
      value,
    };
  } else {
    const appended = appendAppliedProgram(state.appliedPrograms, value);
    if (appended.kind === "rejected") {
      return { ...state, draftError: appended.reason };
    }
    appliedPrograms = appended.programs;
    mutation = {
      index: appended.index,
      kind: "append",
      value,
    };
  }
  const currentTime = editorTransitionTime(
    appliedPrograms.map((record) => record.program),
    state.draftProgram.program.anchor.resolvedSeconds,
    state.currentTime,
  );
  return withoutSuggestion({
    ...state,
    appliedPrograms,
    currentTime,
    draftError: null,
    draftOperation: null,
    draftProgram: null,
    editingAppliedProgram: null,
    programUndoEntries: [...state.programUndoEntries, mutation],
    redoPrograms: [],
  });
}

export function undoEditorProgram(state: EditorControllerState): EditorControllerState {
  if (state.draftProgram) {
    const redoEntry: RedoProgramEntry = {
      edit: state.editingAppliedProgram,
      kind: "draft",
      value: draftEditorProgramRecord(state.draftProgram, state.draftOperation, state.selectedObjectIds),
    };
    return {
      ...discardEditorDraft(state),
      redoPrograms: [...state.redoPrograms, redoEntry],
    };
  }
  const mutation = state.programUndoEntries.at(-1);
  if (!mutation) return state;
  let appliedPrograms: readonly EditorProgramRecord[];
  let selectedObjectIds: readonly string[];
  if (mutation.kind === "append") {
    const current = state.appliedPrograms[mutation.index];
    if (current?.program.transactionId !== mutation.value.program.transactionId) {
      return {
        ...state,
        draftError: "The applied Program history no longer matches the Scene working state.",
      };
    }
    appliedPrograms = [
      ...state.appliedPrograms.slice(0, mutation.index),
      ...state.appliedPrograms.slice(mutation.index + 1),
    ];
    selectedObjectIds = [];
  } else {
    const replacement = replaceAppliedProgram(
      state.appliedPrograms,
      mutation.value.program.transactionId,
      mutation.previous,
    );
    if (replacement.kind === "rejected") {
      return { ...state, draftError: replacement.reason };
    }
    appliedPrograms = replacement.programs;
    selectedObjectIds = mutation.previous.editorMetadata?.selection ?? [];
  }
  return {
    ...state,
    appliedPrograms,
    programUndoEntries: state.programUndoEntries.slice(0, -1),
    redoPrograms: [...state.redoPrograms, { kind: "mutation", mutation }],
    selectedObjectIds,
  };
}

export function redoEditorProgram(
  state: EditorControllerState,
  blockedReason: string | null = null,
): EditorControllerState {
  if (state.draftProgram) return state;
  const entry = state.redoPrograms.at(-1);
  if (!entry) return state;
  if (blockedReason) return { ...state, draftError: blockedReason };
  if (entry.kind === "draft") {
    const precedingPrograms = entry.edit
      ? state.appliedPrograms.slice(0, entry.edit.index).map((record) => record.program)
      : state.appliedPrograms.map((record) => record.program);
    return {
      ...state,
      currentTime: editorTransitionTime(
        precedingPrograms,
        entry.value.program.anchor.resolvedSeconds,
        state.currentTime,
      ),
      draftError: programExecutionCapabilities(entry.value.program).applyBlocker,
      draftOperation: entry.value.editorMetadata?.operation ?? null,
      draftProgram: entry.value,
      editingAppliedProgram: entry.edit,
      redoPrograms: state.redoPrograms.slice(0, -1),
      selectedObjectIds: entry.value.editorMetadata?.selection ?? [],
    };
  }
  const mutation = entry.mutation;
  const blocker = applyBlocker(mutation.value);
  if (blocker) return { ...state, draftError: blocker };
  let appliedPrograms: readonly EditorProgramRecord[];
  if (mutation.kind === "append") {
    const nextPrograms = [...state.appliedPrograms];
    nextPrograms.splice(mutation.index, 0, mutation.value);
    appliedPrograms = nextPrograms;
  } else {
    const replacement = replaceAppliedProgram(
      state.appliedPrograms,
      mutation.previous.program.transactionId,
      mutation.value,
    );
    if (replacement.kind === "rejected") {
      return { ...state, draftError: replacement.reason };
    }
    appliedPrograms = replacement.programs;
  }
  return {
    ...state,
    appliedPrograms,
    programUndoEntries: [...state.programUndoEntries, mutation],
    redoPrograms: state.redoPrograms.slice(0, -1),
    selectedObjectIds: mutation.value.editorMetadata?.selection ?? [],
  };
}

export function editEditorAppliedProgram(
  state: EditorControllerState,
  record: ProgramRecord,
  index: number,
  input: AppliedProgramEditInput = {},
): EditorControllerState {
  const editorRecord = state.appliedPrograms[index];
  if (!editorRecord || editorRecord.program.transactionId !== record.program.transactionId) {
    return { ...state, draftError: "The selected Program no longer matches the applied edit history." };
  }
  const transactionId = editorRecord.program.transactionId;
  const activeEdit =
    state.editingAppliedProgram?.original.program.transactionId === transactionId ? state.editingAppliedProgram : null;
  if (state.draftProgram && !activeEdit) {
    return {
      ...state,
      draftError: "Apply or discard the current draft before editing an Applied Program.",
    };
  }
  const metadata = editorRecord.editorMetadata;
  const operation = input.operation ?? metadata?.operation;
  const draftRecord = input.record ?? record;
  const appliedRecord = state.appliedPrograms[index];
  if (
    !metadata?.operation ||
    !operation ||
    draftRecord.program.transactionId !== transactionId ||
    appliedRecord?.program.transactionId !== transactionId
  ) {
    return {
      ...state,
      draftError: "This Program is read-only because editable Studio authoring metadata is unavailable.",
    };
  }
  return withoutSuggestion({
    ...state,
    currentTime: editorTransitionTime(
      state.appliedPrograms.slice(0, index).map((candidate) => candidate.program),
      input.focusSourceTime ?? draftRecord.program.anchor.resolvedSeconds,
      state.currentTime,
    ),
    draftError: programExecutionCapabilities(draftRecord.program).applyBlocker,
    draftOperation: operation,
    draftProgram: draftRecord,
    editingAppliedProgram: activeEdit ?? { index, original: editorRecord },
    isPlaying: false,
    redoPrograms: [],
    selectedObjectIds: metadata.selection,
  });
}

export function resetEditorPrograms(state: EditorControllerState): EditorControllerState {
  return {
    ...discardEditorDraft(state),
    appliedPrograms: [],
    programUndoEntries: [],
    redoPrograms: [],
  };
}

export class LatestRequestController {
  private current: AbortController | null = null;

  cancel() {
    const controller = this.current;
    this.current = null;
    controller?.abort();
  }

  finish(controller: AbortController) {
    if (this.current === controller) this.current = null;
  }

  isCurrent(controller: AbortController) {
    return this.current === controller;
  }

  start() {
    this.cancel();
    const controller = new AbortController();
    this.current = controller;
    return controller;
  }
}

function resolveStateAction<T>(previous: T, next: SetStateAction<T>) {
  return typeof next === "function" ? (next as (value: T) => T)(previous) : next;
}

export function useEditorController(accountScope?: EditorSessionAccountScope) {
  const [state, dispatch] = useReducer(editorControllerReducer, undefined, createInitialEditorState);
  const sessionStore = useRef<EditorSessionStore | null>(null);
  // Production mounts App behind accountSessionMountKeyV1, so an account or
  // organization change creates a fresh controller and storage boundary.
  if (!sessionStore.current) {
    sessionStore.current = new EditorSessionStore(browserEditorSessionStorageAdapter(accountScope));
  }
  const activeSession = useRef<EditorSessionIdentity | null>(null);
  const localMigrationCandidates = useRef(new Map<string, EditorSessionSnapshotV1>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestController = useRef(new LatestRequestController());

  useEffect(() => () => requestController.current.cancel(), []);

  useEffect(() => {
    const identity = activeSession.current;
    if (!identity) return;
    const identityKey = editorSessionIdentityKey(identity);
    if (identityKey === null || sessionStore.current?.isCloudManaged(identity)) return;
    const timeout = window.setTimeout(() => {
      if (activeSession.current !== identity || sessionStore.current?.isCloudManaged(identity)) return;
      sessionStore.current?.save(identity, snapshotEditorSession(stateRef.current));
    }, SESSION_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [state]);

  useEffect(() => {
    const saveBeforePageExit = () => {
      const identity = activeSession.current;
      const identityKey = identity ? editorSessionIdentityKey(identity) : null;
      if (identity && identityKey) {
        sessionStore.current?.save(identity, snapshotEditorSession(stateRef.current));
      }
    };
    window.addEventListener("pagehide", saveBeforePageExit);
    return () => window.removeEventListener("pagehide", saveBeforePageExit);
  }, []);

  const update = useCallback((transition: (current: EditorControllerState) => EditorControllerState) => {
    dispatch({ type: "update", update: transition });
  }, []);

  const setField = useCallback(
    <K extends keyof EditorControllerState>(field: K, value: SetStateAction<EditorControllerState[K]>) => {
      update((current) => ({
        ...current,
        [field]: resolveStateAction(current[field], value),
      }));
    },
    [update],
  );

  const saveSession = useCallback((identity: EditorSessionIdentity) => {
    sessionStore.current?.save(identity, snapshotEditorSession(stateRef.current));
  }, []);

  const loadProjectFragmentMaterials = useCallback(
    (projectId: string) => sessionStore.current?.restoreProjectFragmentMaterials(projectId),
    [],
  );

  const saveProjectFragmentMaterials = useCallback((projectId: string, state: ProjectFragmentMaterialStateV1) => {
    return sessionStore.current?.saveProjectFragmentMaterials(projectId, state) ?? false;
  }, []);

  const openSession = useCallback(
    (
      identity: EditorSessionIdentity,
      fallback: Readonly<{ currentTime: number; selectedObjectIds: readonly string[] }>,
    ) => {
      const previousIdentity = activeSession.current;
      if (
        previousIdentity &&
        (previousIdentity.projectId !== identity.projectId ||
          previousIdentity.sceneId !== identity.sceneId ||
          previousIdentity.sourceHash !== identity.sourceHash)
      ) {
        sessionStore.current?.save(previousIdentity, snapshotEditorSession(stateRef.current));
      }
      activeSession.current = identity;
      const restored = sessionStore.current?.restore(identity) ?? { kind: "empty" as const };
      const identityKey = editorSessionIdentityKey(identity);
      if (identityKey) {
        if (restored.kind === "restored") {
          localMigrationCandidates.current.set(identityKey, durableEditorSessionSnapshotV1(restored.snapshot));
        } else {
          localMigrationCandidates.current.delete(identityKey);
        }
      }
      const initialized = initializeEditorScene(stateRef.current, fallback);
      dispatch({
        state:
          restored.kind === "restored"
            ? restoreEditorSession(stateRef.current, restored.snapshot)
            : restored.kind === "stale-source"
              ? { ...initialized, draftError: EDITOR_SESSION_STALE_SOURCE_MESSAGE }
              : initialized,
        type: "replace",
      });
      return restored.kind;
    },
    [],
  );

  const readLocalSessionForCloudMigration = useCallback(
    (identity: EditorSessionIdentity, authoritativePrograms: readonly EditorProgramRecord[]) => {
      const identityKey = editorSessionIdentityKey(identity);
      if (identityKey === null) return null;
      const snapshot = localMigrationCandidates.current.get(identityKey) ?? null;
      if (snapshot === null) return null;
      return editorProgramsMatchAuthorityV1(
        snapshot.appliedPrograms,
        authoritativePrograms.map((record) => record.program),
      )
        ? snapshot
        : null;
    },
    [],
  );

  const markSessionCloudManaged = useCallback((identity: EditorSessionIdentity) => {
    return sessionStore.current?.markCloudManaged(identity) ?? false;
  }, []);

  const clearMigratedLocalSession = useCallback((identity: EditorSessionIdentity) => {
    const identityKey = editorSessionIdentityKey(identity);
    if (identityKey === null) return false;
    localMigrationCandidates.current.delete(identityKey);
    return sessionStore.current?.clearMigrated(identity) ?? false;
  }, []);

  const stageDraft = useCallback(
    (input: StageDraftInput) => {
      const preflightError = editorDraftPreflightError(state, input);
      if (preflightError) {
        setField("draftError", preflightError);
        return false;
      }
      update((current) => stageEditorDraft(current, input));
      return true;
    },
    [setField, state, update],
  );

  const discardDraft = useCallback(() => {
    requestController.current.cancel();
    update(discardEditorDraft);
  }, [update]);

  const applyDraft = useCallback(() => {
    if (!state.draftProgram) return false;
    if (applyBlocker(state.draftProgram)) {
      update(applyEditorDraft);
      return false;
    }
    requestController.current.cancel();
    update(applyEditorDraft);
    return true;
  }, [state.draftProgram, update]);

  const undoProgram = useCallback(() => {
    if (!state.draftProgram && state.programUndoEntries.length === 0) return false;
    if (state.draftProgram) requestController.current.cancel();
    update(undoEditorProgram);
    return true;
  }, [state.draftProgram, state.programUndoEntries.length, update]);

  const redoProgram = useCallback(
    (blockedReason: string | null = null) => {
      if (state.draftProgram || state.redoPrograms.length === 0) return false;
      update((current) => redoEditorProgram(current, blockedReason));
      return blockedReason === null;
    },
    [state.draftProgram, state.redoPrograms.length, update],
  );

  const editAppliedProgram = useCallback(
    (record: ProgramRecord, index: number, input?: AppliedProgramEditInput) => {
      const appliedRecord = state.appliedPrograms[index];
      const metadata =
        appliedRecord?.program.transactionId === record.program.transactionId
          ? appliedRecord.editorMetadata
          : undefined;
      const editingTransactionId = state.editingAppliedProgram?.original.program.transactionId;
      if ((!state.draftProgram || editingTransactionId === record.program.transactionId) && metadata?.operation) {
        requestController.current.cancel();
      }
      update((current) => editEditorAppliedProgram(current, record, index, input));
    },
    [state.draftProgram, state.editingAppliedProgram, update],
  );

  const resetPrograms = useCallback(() => {
    requestController.current.cancel();
    update(resetEditorPrograms);
  }, [update]);

  const installAcceptedState = useCallback((next: EditorControllerState) => {
    requestController.current.cancel();
    dispatch({ state: next, type: "replace" });
  }, []);

  const suspend = useCallback(() => {
    requestController.current.cancel();
    update(suspendEditor);
  }, [update]);

  const cancelSuggestionRequest = useCallback(() => requestController.current.cancel(), []);
  const beginSuggestionRequest = useCallback(() => requestController.current.start(), []);
  const finishSuggestionRequest = useCallback((controller: AbortController) => {
    requestController.current.finish(controller);
  }, []);
  const isSuggestionRequestCurrent = useCallback(
    (controller: AbortController) => requestController.current.isCurrent(controller),
    [],
  );

  return {
    activeSessionIdentity: activeSession.current,
    applyDraft,
    beginSuggestionRequest,
    cancelSuggestionRequest,
    clearMigratedLocalSession,
    clearProjectSessions: (projectId: string) => {
      sessionStore.current?.clearProject(projectId);
      for (const key of localMigrationCandidates.current.keys()) {
        const [candidateProjectId] = JSON.parse(key) as readonly string[];
        if (candidateProjectId === projectId) localMigrationCandidates.current.delete(key);
      }
      if (activeSession.current?.projectId === projectId) activeSession.current = null;
    },
    clearSession: (identity: EditorSessionIdentity) => {
      sessionStore.current?.clear(identity);
      const identityKey = editorSessionIdentityKey(identity);
      if (identityKey) localMigrationCandidates.current.delete(identityKey);
      // Clearing local persistence does not unload the current controller state.
      // Source reconciliation resets its programs separately; retaining the
      // identity lets a same-hash refresh remain aligned, while a changed hash
      // still fails closed until App opens the replacement session.
    },
    discardDraft,
    editAppliedProgram,
    finishSuggestionRequest,
    isSuggestionRequestCurrent,
    installAcceptedState,
    loadProjectFragmentMaterials,
    openSession,
    pruneSessions: (projectIds: ReadonlySet<string>) => {
      sessionStore.current?.pruneProjects(projectIds);
      for (const key of localMigrationCandidates.current.keys()) {
        const [projectId] = JSON.parse(key) as readonly string[];
        if (projectId && !projectIds.has(projectId)) localMigrationCandidates.current.delete(key);
      }
      const projectId = activeSession.current?.projectId;
      if (projectId && !projectIds.has(projectId)) activeSession.current = null;
    },
    readLocalSessionForCloudMigration,
    redoProgram,
    resetPrograms,
    saveSession,
    saveProjectFragmentMaterials,
    markSessionCloudManaged,
    setCurrentTime: (value: SetStateAction<number>) => setField("currentTime", value),
    setDurationError: (value: SetStateAction<string | null>) => setField("durationError", value),
    setDraftError: (value: SetStateAction<string | null>) => setField("draftError", value),
    setInsertTool: (value: SetStateAction<StudioTool>) => setField("insertTool", value),
    setInsertValue: (value: SetStateAction<string>) => setField("insertValue", value),
    setInstruction: (value: SetStateAction<string>) => setField("instruction", value),
    setInteractionMode: (value: SetStateAction<InteractionMode>) => setField("interactionMode", value),
    setIsPlaying: (value: SetStateAction<boolean>) => setField("isPlaying", value),
    setLockedEntityIds: (value: SetStateAction<readonly string[]>) => setField("lockedEntityIds", value),
    setMotionDuration: (value: SetStateAction<number>) => setField("motionDuration", value),
    setPendingClarification: (value: SetStateAction<PendingClarification | null>) =>
      setField("pendingClarification", value),
    setSelectedObjectIds: (value: SetStateAction<readonly string[]>) => setField("selectedObjectIds", value),
    setSuggestion: (value: SetStateAction<EditSuggestion | null>) => setField("suggestion", value),
    setSuggestionMessage: (value: SetStateAction<string | null>) => setField("suggestionMessage", value),
    setSuggestionStatus: (value: SetStateAction<SuggestionStatus>) => setField("suggestionStatus", value),
    setVerifiedSourceDurationBasis: (value: SetStateAction<EditorSessionSnapshot["verifiedSourceDurationBasis"]>) =>
      setField("verifiedSourceDurationBasis", value),
    stageDraft,
    state,
    suspend,
    undoProgram,
  } as const;
}
