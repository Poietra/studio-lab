import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createBrowserEditorDocumentKeyV1,
  type EditorDocumentAuthorityCommitOutcomeV1,
  EditorDocumentAuthorityErrorV1,
  type EditorDocumentAuthorityIdentityV1,
  type EditorDocumentAuthorityOpenOutcomeV1,
  type EditorDocumentAuthorityRecoveryKindV1,
  type EditorDocumentAuthoritySnapshotV1,
  EditorDocumentAuthorityV1,
} from "../collaboration/editor-document-authority";
import {
  attemptEditorDocumentSessionKeepaliveV1,
  type EditorDocumentClientV1,
  FetchEditorDocumentClientV1,
} from "../collaboration/editor-document-client";
import type { EditorEditMutationV1 } from "../collaboration/editor-edit-mutation";
import {
  BrowserEditorLiveClientV1,
  type EditorLiveClientV1,
  type EditorLiveConnectionV1,
} from "../collaboration/editor-live-client";
import { type EditorLivePresenceV1, editorLivePresenceSchemaV1 } from "../collaboration/editor-live-contract";
import { EditorRemoteHeadQueueV1 } from "../collaboration/editor-remote-head-queue";
import {
  canonicalEditorSessionSnapshotJsonV1,
  type EditorSessionSnapshotV1,
} from "../collaboration/editor-session-contract";
import { EditorTimelineAdmissionError } from "./editor-authority-state";
import {
  assertEditorMutationCommitAcknowledgementV1,
  browserEditorMutationPendingJournalV1,
  type EditorMutationPendingJournalEntryV1,
  EditorMutationPendingJournalErrorV1,
  type EditorMutationPendingJournalIdentityV1,
  type EditorMutationPendingJournalLookupV1,
  type EditorMutationPendingJournalV1,
} from "./editor-mutation-pending-journal";
import {
  browserEditorSessionPendingJournalV1,
  type EditorSessionPendingJournalBasisV1,
  type EditorSessionPendingJournalEntryV1,
  type EditorSessionPendingJournalLaneIdentityV1,
  EditorSessionPendingJournalReadErrorV1,
} from "./editor-session-pending-journal";
import type { SceneEdit } from "./scene-edit-contract";
import type { StudioPresenceParticipantV1 } from "./studio-presence-overlay";

const defaultEditorDocumentClientV1 = new FetchEditorDocumentClientV1();
const EDITOR_SESSION_NAVIGATION_FLUSH_WAIT_MS_V1 = 2_000;
let defaultEditorLiveClientV1: EditorLiveClientV1 | null | undefined;
const EDITOR_CLOUD_SESSION_AUTOSAVE_DELAY_MS_V1 = 300;

function browserEditorLiveClientV1() {
  if (defaultEditorLiveClientV1 !== undefined) return defaultEditorLiveClientV1;
  defaultEditorLiveClientV1 =
    typeof window === "undefined" || typeof WebSocket === "undefined" ? null : new BrowserEditorLiveClientV1();
  return defaultEditorLiveClientV1;
}

type EditorDocumentAuthorityPhaseV1 = "blocked" | "disabled" | "opening" | "pending" | "ready" | "recoverable";

export type EditorDocumentAuthorityUiStateV1 = Readonly<{
  journalConflict: boolean;
  journalConflictAccountWide: boolean;
  journalConflictKind: "mutation" | "session" | null;
  message: string | null;
  phase: EditorDocumentAuthorityPhaseV1;
  retryable: boolean;
}>;

type EditorPresenceRoomV1 = Readonly<{
  identityKey: string | null;
  participants: readonly StudioPresenceParticipantV1[];
}>;

class EditorSessionPendingJournalConflictV1 extends Error {
  constructor() {
    super(
      "A pending private Editor session conflicts with newer cloud state. Discard the pending local state or return after resolving the other editor.",
    );
    this.name = "EditorSessionPendingJournalConflictV1";
  }
}

class EditorMutationPendingJournalConflictV1 extends Error {
  constructor(
    message = "A retained Editor mutation conflicts with newer cloud state. Clear it explicitly or resolve the other editor before continuing.",
  ) {
    super(message);
    this.name = "EditorMutationPendingJournalConflictV1";
  }
}

export type EditorDocumentAuthorityHookCommitOutcomeV1 =
  | EditorDocumentAuthorityCommitOutcomeV1
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "stale" }>;

export type EditorDocumentSessionFlushOutcomeV1 = Readonly<{
  kind: "busy" | "failed" | "journaled" | "stored";
}>;

export function editorDocumentSessionFlushAllowsTransitionV1(
  outcome: EditorDocumentSessionFlushOutcomeV1,
  transition: "account" | "document" = "document",
) {
  return (
    outcome.kind === "stored" || outcome.kind === "journaled" || (transition === "account" && outcome.kind === "failed")
  );
}

export function editorDocumentAuthorityStateAfterJournalStorageFailureV1(
  state: EditorDocumentAuthorityUiStateV1,
  message: string,
): EditorDocumentAuthorityUiStateV1 {
  return {
    ...state,
    journalConflict: false,
    journalConflictAccountWide: false,
    journalConflictKind: null,
    message,
  };
}

export function installEditorAuthorityBasisAfterJournalSettlementV1(
  input: Readonly<{
    currentDocumentRevision: string | null;
    install: () => void;
    nextDocumentRevision: string;
    pendingLaneDocumentRevision: string | null;
  }>,
) {
  const staleLane =
    input.currentDocumentRevision !== null &&
    input.currentDocumentRevision !== input.nextDocumentRevision &&
    input.pendingLaneDocumentRevision !== null &&
    input.pendingLaneDocumentRevision !== input.nextDocumentRevision;
  if (staleLane) return false;
  input.install();
  return true;
}

export type EditorDocumentSessionBootstrapV1 = Readonly<{
  onCloudReady: () => void;
  persist: boolean;
  snapshot: EditorSessionSnapshotV1;
}>;

type UseEditorDocumentAuthorityInputV1 = Readonly<{
  client?: EditorDocumentClientV1;
  identity: EditorDocumentAuthorityIdentityV1 | null;
  liveClient?: EditorLiveClientV1 | null;
  onOpen: (outcome: EditorDocumentAuthorityOpenOutcomeV1) => Promise<EditorDocumentSessionBootstrapV1>;
  onProjection: (programs: readonly SceneEdit[], reason: "open" | "remote") => Promise<void>;
  ownerKey: string | null;
  sessionSnapshot: EditorSessionSnapshotV1 | null;
}>;

function identityKeyV1(identity: EditorDocumentAuthorityIdentityV1 | null, ownerKey: string | null) {
  return identity
    ? [
        ownerKey,
        identity.organizationId,
        identity.projectId,
        identity.sourcePath,
        identity.sceneName,
        identity.sourceHash,
      ]
        .map((part) => part ?? "")
        .join("\0")
    : null;
}

function pendingJournalBasisV1(snapshot: EditorDocumentAuthoritySnapshotV1): EditorSessionPendingJournalBasisV1 {
  return {
    documentRevision: snapshot.revision,
    expectedSessionGeneration: snapshot.sessionGeneration,
    identity: {
      documentKey: snapshot.document.documentKey,
      epoch: snapshot.document.epoch,
      projectId: snapshot.document.projectId,
      sourceHash: snapshot.document.sourceHash,
      sourcePath: snapshot.document.sourcePath,
    },
  };
}

function pendingMutationJournalIdentityV1(
  snapshot: EditorDocumentAuthoritySnapshotV1,
): EditorMutationPendingJournalIdentityV1 {
  return {
    documentKey: snapshot.document.documentKey,
    epoch: snapshot.document.epoch,
    projectId: snapshot.document.projectId,
    sourceHash: snapshot.document.sourceHash,
    sourcePath: snapshot.document.sourcePath,
  };
}

function pendingMutationJournalLookupV1(
  identity: Pick<EditorDocumentAuthorityIdentityV1, "projectId" | "sourceHash" | "sourcePath">,
  documentKey: string,
): EditorMutationPendingJournalLookupV1 {
  return {
    documentKey,
    projectId: identity.projectId,
    sourceHash: identity.sourceHash,
    sourcePath: identity.sourcePath,
  };
}

function canonicalJournalEntrySnapshotV1(entry: EditorSessionPendingJournalEntryV1) {
  return canonicalEditorSessionSnapshotJsonV1(entry.request.snapshot);
}

function publicAuthorityMessageV1(error: unknown) {
  if (error instanceof EditorMutationPendingJournalConflictV1) return error.message;
  if (error instanceof EditorMutationPendingJournalErrorV1) {
    if (error.code === "storage") {
      return "Browser storage is unavailable. Enable site storage, then reload before continuing to edit.";
    }
    return error.code === "ambiguous" || error.code === "mismatch"
      ? "A pending Editor mutation cannot be resolved safely. Clear its recovery journal before continuing."
      : "Pending Editor mutations cannot be resolved safely. Clear all mutation recovery journals before continuing.";
  }
  if (error instanceof EditorSessionPendingJournalConflictV1) return error.message;
  if (error instanceof EditorSessionPendingJournalReadErrorV1) {
    if (error.code === "storage") {
      return "Browser storage is unavailable. Enable site storage, then reload before continuing to edit.";
    }
    return error.code === "ambiguous"
      ? "Pending private Editor sessions cannot be resolved safely. Clear the pending journal before continuing."
      : "Pending private Editor sessions cannot be resolved safely. Clear all pending journals before continuing.";
  }
  if (error instanceof EditorDocumentAuthorityErrorV1) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return null;
  return "The authoritative Editor document is unavailable. Reload the Scene before editing.";
}

function shouldExposeJournalDiscardV1(error: unknown, retryable: boolean, retainedEvidence: boolean) {
  if (error instanceof EditorMutationPendingJournalErrorV1 && error.code === "storage") return false;
  if (error instanceof EditorSessionPendingJournalReadErrorV1 && error.code === "storage") return false;
  return (
    error instanceof EditorMutationPendingJournalConflictV1 ||
    error instanceof EditorMutationPendingJournalErrorV1 ||
    error instanceof EditorSessionPendingJournalConflictV1 ||
    error instanceof EditorSessionPendingJournalReadErrorV1 ||
    (!retryable && retainedEvidence)
  );
}

function journalConflictIsAccountWideV1(error: unknown) {
  return (
    (error instanceof EditorMutationPendingJournalErrorV1 || error instanceof EditorSessionPendingJournalReadErrorV1) &&
    (error.code === "capacity" || error.code === "corrupt")
  );
}

function journalConflictKindV1(error: unknown): "mutation" | "session" | null {
  if (error instanceof EditorMutationPendingJournalConflictV1 || error instanceof EditorMutationPendingJournalErrorV1) {
    return "mutation";
  }
  if (
    error instanceof EditorSessionPendingJournalConflictV1 ||
    error instanceof EditorSessionPendingJournalReadErrorV1
  ) {
    return "session";
  }
  return null;
}

export function editorMutationJournalConflictIsDefinitiveV1(
  error: unknown,
  retainedMutation: boolean,
  recoveryKind: EditorDocumentAuthorityRecoveryKindV1 | null,
) {
  return (
    retainedMutation &&
    recoveryKind !== "commit" &&
    error instanceof EditorDocumentAuthorityErrorV1 &&
    (error.code === "conflict" || error.code === "session-conflict")
  );
}

export async function recoverPendingEditorMutationBeforeOpenV1(
  input: Readonly<{
    client: EditorDocumentClientV1;
    identity: EditorDocumentAuthorityIdentityV1;
    journal: EditorMutationPendingJournalV1 | null;
    onLookup?: (lookup: EditorMutationPendingJournalLookupV1) => void;
    onPending?: (entry: EditorMutationPendingJournalEntryV1, lookup: EditorMutationPendingJournalLookupV1) => void;
    signal?: AbortSignal;
  }>,
) {
  if (!input.journal) return { kind: "empty" } as const;
  input.signal?.throwIfAborted();
  const documentKey = await createBrowserEditorDocumentKeyV1(input.identity);
  input.signal?.throwIfAborted();
  const lookup = pendingMutationJournalLookupV1(input.identity, documentKey);
  input.onLookup?.(lookup);
  const entry = input.journal.readExact(lookup);
  if (!entry) return { kind: "empty" } as const;
  input.onPending?.(entry, lookup);
  const result = await input.client.commit(input.identity, documentKey, entry.request, input.signal);
  input.signal?.throwIfAborted();
  if (result.kind === "conflict") {
    throw new EditorMutationPendingJournalConflictV1(
      `A retained Editor mutation conflicts with cloud state (${result.reason}). Clear it explicitly or resolve the other editor before continuing.`,
    );
  }
  await assertEditorMutationCommitAcknowledgementV1(entry, result);
  if (!input.journal.acknowledgeExact(entry)) {
    throw new EditorMutationPendingJournalConflictV1(
      "The accepted Editor mutation remains in browser recovery storage. Reload before continuing.",
    );
  }
  return { entry, kind: "recovered", result } as const;
}

function emptyEditorPresenceV1(): EditorLivePresenceV1 {
  return { cursor: null, playheadSeconds: 0, selectedEntityIds: [] };
}

function sameStudioPresenceParticipantsV1(
  left: readonly StudioPresenceParticipantV1[],
  right: readonly StudioPresenceParticipantV1[],
) {
  if (left.length !== right.length) return false;
  return left.every((participant, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      participant.memberId === candidate.memberId &&
      participant.isSelf === candidate.isSelf &&
      participant.cursor?.x === candidate.cursor?.x &&
      participant.cursor?.y === candidate.cursor?.y &&
      participant.selectedEntityIds.length === candidate.selectedEntityIds.length &&
      participant.selectedEntityIds.every(
        (entityId, entityIndex) => entityId === candidate.selectedEntityIds[entityIndex],
      )
    );
  });
}

export function useEditorDocumentAuthorityV1(input: UseEditorDocumentAuthorityInputV1) {
  const [reopenGeneration, setReopenGeneration] = useState(0);
  const [state, setState] = useState<EditorDocumentAuthorityUiStateV1>({
    journalConflict: false,
    journalConflictAccountWide: false,
    journalConflictKind: null,
    message: null,
    phase: "disabled",
    retryable: false,
  });
  const authority = useRef<EditorDocumentAuthorityV1 | null>(null);
  const authorityIdentityKey = useRef<string | null>(null);
  const liveConnection = useRef<EditorLiveConnectionV1 | null>(null);
  const liveConnectionIdentityKey = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateState = useCallback(
    (
      next: Omit<
        EditorDocumentAuthorityUiStateV1,
        "journalConflict" | "journalConflictAccountWide" | "journalConflictKind"
      > & {
        journalConflict?: boolean;
        journalConflictAccountWide?: boolean;
        journalConflictKind?: "mutation" | "session" | null;
      },
    ) => {
      const journalConflict = next.journalConflict ?? false;
      const normalized: EditorDocumentAuthorityUiStateV1 = {
        journalConflict,
        journalConflictAccountWide: next.journalConflictAccountWide ?? false,
        journalConflictKind: journalConflict ? (next.journalConflictKind ?? "session") : null,
        message: next.message,
        phase: next.phase,
        retryable: next.retryable,
      };
      stateRef.current = normalized;
      setState(normalized);
    },
    [],
  );
  const projection = useRef(input.onProjection);
  projection.current = input.onProjection;
  const bootstrap = useRef(input.onOpen);
  bootstrap.current = input.onOpen;
  const client = input.client ?? defaultEditorDocumentClientV1;
  const liveClient = input.liveClient === undefined ? browserEditorLiveClientV1() : input.liveClient;
  const identityKey = identityKeyV1(input.identity, input.ownerKey);
  const renderedIdentityKey = useRef(identityKey);
  renderedIdentityKey.current = identityKey;
  const sessionSnapshotCanonical = useMemo(
    () => (input.sessionSnapshot === null ? null : canonicalEditorSessionSnapshotJsonV1(input.sessionSnapshot)),
    [input.sessionSnapshot],
  );
  const latestSessionSnapshot = useRef(input.sessionSnapshot);
  latestSessionSnapshot.current = input.sessionSnapshot;
  const sessionJournal = useMemo(
    () =>
      input.identity && input.ownerKey
        ? browserEditorSessionPendingJournalV1({
            organizationId: input.identity.organizationId,
            userId: input.ownerKey,
          })
        : null,
    [input.identity?.organizationId, input.ownerKey],
  );
  const mutationJournal = useMemo(
    () =>
      input.identity && input.ownerKey
        ? browserEditorMutationPendingJournalV1({
            organizationId: input.identity.organizationId,
            userId: input.ownerKey,
          })
        : null,
    [input.identity?.organizationId, input.ownerKey],
  );
  const authoritySnapshot = useRef<EditorDocumentAuthoritySnapshotV1 | null>(null);
  const rejectedTimelineProgram = useRef<Readonly<{ program: SceneEdit; revision: string }> | null>(null);
  const journalBasis = useRef<EditorSessionPendingJournalBasisV1 | null>(null);
  const journalConflictIdentity = useRef<EditorSessionPendingJournalLaneIdentityV1 | null>(null);
  const mutationConflictLookup = useRef<EditorMutationPendingJournalLookupV1 | null>(null);
  const pendingMutationRecovery = useRef<EditorMutationPendingJournalEntryV1 | null>(null);
  const terminationAttemptedEntryId = useRef<string | null>(null);
  const lastSavedSessionCanonical = useRef<string | null>(null);
  const operationLane = useRef<Promise<void>>(Promise.resolve());
  const sessionAuthorityEpoch = useRef(0);
  const pendingSessionRecovery = useRef<Readonly<{
    canonical: string;
    journalRecovery?: Readonly<{
      entry: EditorSessionPendingJournalEntryV1;
      opened: EditorDocumentAuthorityOpenOutcomeV1;
    }>;
    onCloudReady: (() => void) | null;
  }> | null>(null);
  const pendingCommitSessionRecovery = useRef<Readonly<{
    canonical: string;
    snapshot: EditorSessionSnapshotV1;
  }> | null>(null);
  const queuedCommitIdentityKey = useRef<string | null>(null);
  const queuedReconcileIdentityKey = useRef<string | null>(null);
  const [renderedQueuedCommitIdentityKey, setRenderedQueuedCommitIdentityKey] = useState<string | null>(null);
  const presentationReady = useRef(false);
  const reconcileRunner = useRef<() => Promise<boolean>>(async () => false);
  const remoteHeadQueue = useRef<EditorRemoteHeadQueueV1 | null>(null);
  const localPresence = useRef<EditorLivePresenceV1>(emptyEditorPresenceV1());
  const localPresenceIdentityKey = useRef<string | null>(identityKey);
  const [presenceRoom, setPresenceRoom] = useState<EditorPresenceRoomV1>({ identityKey: null, participants: [] });
  remoteHeadQueue.current ??= new EditorRemoteHeadQueueV1(
    () => stateRef.current.phase === "ready",
    () => reconcileRunner.current(),
  );

  const installAuthoritySnapshot = useCallback((snapshot: EditorDocumentAuthoritySnapshotV1) => {
    authoritySnapshot.current = snapshot;
    journalBasis.current = pendingJournalBasisV1(snapshot);
  }, []);

  const acknowledgePendingMutation = useCallback(
    (outcome: EditorDocumentAuthorityCommitOutcomeV1) => {
      if (outcome.kind === "reconciled" && !outcome.accepted) {
        throw new EditorMutationPendingJournalConflictV1();
      }
      const entry = pendingMutationRecovery.current;
      if (!mutationJournal || !entry) {
        throw new EditorMutationPendingJournalErrorV1("The exact pending Editor mutation is unavailable.", "mismatch");
      }
      if (!mutationJournal.acknowledgeExact(entry)) {
        throw new EditorMutationPendingJournalConflictV1(
          "The accepted Editor mutation remains in browser recovery storage. Reload before continuing.",
        );
      }
      pendingMutationRecovery.current = null;
      mutationConflictLookup.current = null;
    },
    [mutationJournal],
  );

  const installAuthoritySnapshotAfterBasisAdvance = useCallback(
    (snapshot: EditorDocumentAuthoritySnapshotV1) => {
      const previousBasis = journalBasis.current;
      const lane = sessionJournal && previousBasis ? sessionJournal.readLaneExact(previousBasis.identity) : null;
      if (lane && previousBasis) journalConflictIdentity.current = previousBasis.identity;
      const installed = installEditorAuthorityBasisAfterJournalSettlementV1({
        currentDocumentRevision: previousBasis?.documentRevision ?? null,
        install: () => installAuthoritySnapshot(snapshot),
        nextDocumentRevision: snapshot.revision,
        pendingLaneDocumentRevision: lane?.head.request.documentRevision ?? null,
      });
      if (installed) journalConflictIdentity.current = null;
      return installed;
    },
    [installAuthoritySnapshot, sessionJournal],
  );

  const recordSessionSnapshot = useCallback(
    (snapshot: EditorSessionSnapshotV1) => {
      const basis = journalBasis.current;
      if (!sessionJournal || !basis) return null;
      journalConflictIdentity.current = basis.identity;
      return sessionJournal.record(basis, snapshot);
    },
    [sessionJournal],
  );

  const checkpointLatestSession = useCallback(
    (reportError = true) => {
      if (!presentationReady.current) return { durable: false, entry: null } as const;
      const snapshot = latestSessionSnapshot.current;
      if (snapshot === null) return { durable: false, entry: null } as const;
      const canonical = canonicalEditorSessionSnapshotJsonV1(snapshot);
      if (canonical === lastSavedSessionCanonical.current) return { durable: true, entry: null } as const;
      try {
        const entry = recordSessionSnapshot(snapshot);
        return { durable: entry !== null, entry } as const;
      } catch (error) {
        if (reportError) {
          const message = publicAuthorityMessageV1(error);
          const journalConflict = error instanceof EditorSessionPendingJournalReadErrorV1 && error.code !== "storage";
          const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
          if (journalConflictAccountWide) journalConflictIdentity.current = null;
          if (message) {
            if (error instanceof EditorSessionPendingJournalReadErrorV1 && error.code === "storage") {
              updateState(editorDocumentAuthorityStateAfterJournalStorageFailureV1(stateRef.current, message));
              return { durable: false, entry: null } as const;
            }
            updateState({
              journalConflict,
              journalConflictAccountWide,
              message,
              phase: "blocked",
              retryable: false,
            });
          }
        }
        return { durable: false, entry: null } as const;
      }
    },
    [recordSessionSnapshot, updateState],
  );

  const pendingJournalRetainsCurrentBasis = useCallback(() => {
    const basis = journalBasis.current;
    if (!sessionJournal || !basis) return false;
    try {
      return sessionJournal.readLaneExact(basis.identity) !== null;
    } catch {
      return true;
    }
  }, [sessionJournal]);

  const recoverPendingJournalAtOpen = useCallback(
    async (
      activeAuthority: EditorDocumentAuthorityV1,
      opened: EditorDocumentAuthorityOpenOutcomeV1,
      signal: AbortSignal,
      stillActive: () => boolean,
    ) => {
      if (!sessionJournal) return opened;
      const assertActive = () => {
        signal.throwIfAborted();
        if (!stillActive()) throw new DOMException("The Editor session recovery is stale.", "AbortError");
      };
      let current = opened;
      const identity = pendingJournalBasisV1(opened).identity;
      for (let step = 0; step < 2; step += 1) {
        const lane = sessionJournal.readLaneExact(identity);
        if (!lane) return current;
        const sealed = await sessionJournal.sealExact(lane.head.entryId);
        assertActive();
        if (sealed.kind !== "sealed") throw new EditorSessionPendingJournalConflictV1();
        const entry = sealed.entry;

        if (lane.successor) {
          const sealedSuccessor = await sessionJournal.sealExact(lane.successor.entryId);
          assertActive();
          if (sealedSuccessor.kind !== "sealed") throw new EditorSessionPendingJournalConflictV1();
          if (
            current.session !== null &&
            current.sessionGeneration ===
              (BigInt(sealedSuccessor.entry.request.expectedSessionGeneration) + 1n).toString(10) &&
            canonicalEditorSessionSnapshotJsonV1(current.session) ===
              canonicalJournalEntrySnapshotV1(sealedSuccessor.entry)
          ) {
            if (!(await sessionJournal.acknowledgeExact(entry.entryId, entry.request))) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            assertActive();
            const promoted = sessionJournal.readLaneExact(identity)?.head;
            if (
              !promoted ||
              !(await sessionJournal.acknowledgeExact(promoted.entryId, sealedSuccessor.entry.request))
            ) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            assertActive();
            continue;
          }
        }

        if (
          current.session !== null &&
          canonicalEditorSessionSnapshotJsonV1(current.session) === canonicalJournalEntrySnapshotV1(entry)
        ) {
          if (!(await sessionJournal.acknowledgeExact(entry.entryId, entry.request))) {
            throw new EditorSessionPendingJournalConflictV1();
          }
          assertActive();
          continue;
        }
        if (
          current.revision !== entry.request.documentRevision ||
          current.sessionGeneration !== entry.request.expectedSessionGeneration
        ) {
          throw new EditorSessionPendingJournalConflictV1();
        }
        const attempted = sessionJournal.markAttemptedExact(entry.entryId);
        if (!attempted) throw new EditorSessionPendingJournalConflictV1();
        pendingSessionRecovery.current = {
          canonical: canonicalJournalEntrySnapshotV1(attempted),
          journalRecovery: { entry: attempted, opened: current },
          onCloudReady: null,
        };
        const outcome = await activeAuthority.saveSession(attempted.request.snapshot, signal);
        assertActive();
        pendingSessionRecovery.current = null;
        if (outcome.kind !== "stored") throw new EditorSessionPendingJournalConflictV1();
        if (!(await sessionJournal.acknowledgeExact(attempted.entryId, attempted.request))) {
          throw new EditorSessionPendingJournalConflictV1();
        }
        assertActive();
        current = Object.freeze({
          ...current,
          session: attempted.request.snapshot,
          sessionGeneration: outcome.sessionGeneration,
        });
      }
      if (sessionJournal.readLaneExact(identity)) throw new EditorSessionPendingJournalConflictV1();
      return current;
    },
    [sessionJournal],
  );

  const connectLive = useCallback(
    (
      snapshot: EditorDocumentAuthoritySnapshotV1,
      liveIdentity: EditorDocumentAuthorityIdentityV1,
      activeGeneration: number,
      activeIdentityKey: string,
      activeAuthority: EditorDocumentAuthorityV1,
    ) => {
      if (
        !liveClient ||
        generation.current !== activeGeneration ||
        renderedIdentityKey.current !== activeIdentityKey ||
        authority.current !== activeAuthority
      ) {
        return;
      }
      if (liveConnection.current && liveConnectionIdentityKey.current === activeIdentityKey) return;
      liveConnection.current?.close();
      liveConnection.current = null;
      liveConnectionIdentityKey.current = null;
      let connection: EditorLiveConnectionV1 | null = null;
      try {
        connection = liveClient.connect(
          {
            documentKey: snapshot.document.documentKey,
            epoch: snapshot.document.epoch,
            organizationId: liveIdentity.organizationId,
            projectId: liveIdentity.projectId,
          },
          {
            onHead: () => {
              if (
                generation.current !== activeGeneration ||
                renderedIdentityKey.current !== activeIdentityKey ||
                authority.current !== activeAuthority
              )
                return;
              remoteHeadQueue.current?.notify();
            },
            onParticipants: (participants, selfMemberId) => {
              if (
                generation.current !== activeGeneration ||
                renderedIdentityKey.current !== activeIdentityKey ||
                authority.current !== activeAuthority
              )
                return;
              const projected = participants.map((participant) => {
                const isSelf = participant.member.id === selfMemberId;
                return {
                  cursor: isSelf ? null : participant.presence.cursor,
                  isSelf,
                  memberId: participant.member.id,
                  selectedEntityIds: isSelf ? [] : participant.presence.selectedEntityIds,
                };
              });
              setPresenceRoom((current) =>
                current.identityKey === activeIdentityKey &&
                sameStudioPresenceParticipantsV1(current.participants, projected)
                  ? current
                  : { identityKey: activeIdentityKey, participants: projected },
              );
            },
            onPhase: (phase) => {
              if (
                generation.current !== activeGeneration ||
                renderedIdentityKey.current !== activeIdentityKey ||
                authority.current !== activeAuthority
              )
                return;
              if (phase === "connected") {
                remoteHeadQueue.current?.notify();
              } else {
                setPresenceRoom((current) =>
                  current.identityKey === activeIdentityKey ? { identityKey: null, participants: [] } : current,
                );
              }
            },
          },
        );
        if (
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== activeIdentityKey ||
          authority.current !== activeAuthority
        ) {
          connection.close();
          return;
        }
        liveConnection.current = connection;
        liveConnectionIdentityKey.current = activeIdentityKey;
        connection.publishPresence(
          localPresenceIdentityKey.current === activeIdentityKey ? localPresence.current : emptyEditorPresenceV1(),
        );
      } catch {
        connection?.close();
        if (liveConnection.current === connection) liveConnection.current = null;
        if (liveConnectionIdentityKey.current === activeIdentityKey) liveConnectionIdentityKey.current = null;
      }
    },
    [liveClient],
  );

  useEffect(() => {
    generation.current += 1;
    const activeGeneration = generation.current;
    request.current?.abort();
    request.current = null;
    operationLane.current = Promise.resolve();
    sessionAuthorityEpoch.current += 1;
    pendingSessionRecovery.current = null;
    pendingCommitSessionRecovery.current = null;
    queuedCommitIdentityKey.current = null;
    queuedReconcileIdentityKey.current = null;
    setRenderedQueuedCommitIdentityKey(null);
    presentationReady.current = false;
    rejectedTimelineProgram.current = null;
    lastSavedSessionCanonical.current = null;
    authoritySnapshot.current = null;
    journalBasis.current = null;
    journalConflictIdentity.current = null;
    mutationConflictLookup.current = null;
    pendingMutationRecovery.current = null;
    terminationAttemptedEntryId.current = null;
    authority.current = null;
    authorityIdentityKey.current = null;
    liveConnection.current?.close();
    liveConnection.current = null;
    liveConnectionIdentityKey.current = null;
    if (localPresenceIdentityKey.current !== identityKey) {
      localPresence.current = emptyEditorPresenceV1();
      localPresenceIdentityKey.current = identityKey;
    }
    setPresenceRoom({ identityKey: null, participants: [] });
    remoteHeadQueue.current?.clear();
    if (!input.identity || identityKey === null) {
      updateState({ message: null, phase: "disabled", retryable: false });
      return;
    }
    const activeIdentity = input.identity;
    const controller = new AbortController();
    const nextAuthority = new EditorDocumentAuthorityV1(client, activeIdentity);
    request.current = controller;
    authority.current = nextAuthority;
    authorityIdentityKey.current = identityKey;
    updateState({ message: null, phase: "opening", retryable: false });
    void (async () => {
      const openAttemptIsCurrent = () =>
        !controller.signal.aborted &&
        generation.current === activeGeneration &&
        renderedIdentityKey.current === identityKey &&
        authority.current === nextAuthority;
      await recoverPendingEditorMutationBeforeOpenV1({
        client,
        identity: activeIdentity,
        journal: mutationJournal,
        onLookup: (lookup) => {
          mutationConflictLookup.current = lookup;
        },
        onPending: (entry, lookup) => {
          pendingMutationRecovery.current = entry;
          mutationConflictLookup.current = lookup;
        },
        signal: controller.signal,
      });
      if (!openAttemptIsCurrent()) return null;
      pendingMutationRecovery.current = null;
      mutationConflictLookup.current = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let snapshot = await nextAuthority.open(controller.signal);
        if (!openAttemptIsCurrent()) return null;
        installAuthoritySnapshot(snapshot);
        connectLive(snapshot, activeIdentity, activeGeneration, identityKey, nextAuthority);
        journalConflictIdentity.current = pendingJournalBasisV1(snapshot).identity;
        snapshot = await recoverPendingJournalAtOpen(nextAuthority, snapshot, controller.signal, openAttemptIsCurrent);
        if (!openAttemptIsCurrent()) return null;
        journalConflictIdentity.current = null;
        installAuthoritySnapshot(snapshot);
        const installed = await bootstrap.current(snapshot);
        if (!openAttemptIsCurrent()) return null;
        presentationReady.current = true;
        const canonical = canonicalEditorSessionSnapshotJsonV1(installed.snapshot);
        if (installed.persist) {
          pendingSessionRecovery.current = { canonical, onCloudReady: installed.onCloudReady };
          let attemptedJournalEntry: EditorSessionPendingJournalEntryV1 | null = null;
          if (sessionJournal) {
            const journalEntry = recordSessionSnapshot(installed.snapshot);
            if (!journalEntry) throw new EditorSessionPendingJournalConflictV1();
            attemptedJournalEntry = sessionJournal.markAttemptedExact(journalEntry.entryId);
            if (!attemptedJournalEntry) throw new EditorSessionPendingJournalConflictV1();
            const sealed = await sessionJournal.sealExact(attemptedJournalEntry.entryId);
            if (!openAttemptIsCurrent()) return null;
            if (sealed?.kind !== "sealed") throw new EditorSessionPendingJournalConflictV1();
          }
          try {
            const saved = await nextAuthority.saveSession(installed.snapshot, controller.signal);
            if (!openAttemptIsCurrent()) return null;
            if (saved.kind === "reconciled") {
              if (!installAuthoritySnapshotAfterBasisAdvance(saved.snapshot)) {
                throw new EditorSessionPendingJournalConflictV1();
              }
              sessionAuthorityEpoch.current += 1;
              lastSavedSessionCanonical.current = null;
              await projection.current(saved.snapshot.programs, "remote");
              if (!openAttemptIsCurrent()) return null;
              pendingSessionRecovery.current = null;
              if (attempt < 2) continue;
              throw new EditorDocumentAuthorityErrorV1(
                "The Editor document kept changing while its private session opened.",
                "conflict",
              );
            }
            snapshot = Object.freeze({
              ...snapshot,
              session: installed.snapshot,
              sessionGeneration: saved.sessionGeneration,
            });
            installAuthoritySnapshot(snapshot);
            if (
              attemptedJournalEntry &&
              !(await sessionJournal?.acknowledgeExact(attemptedJournalEntry.entryId, attemptedJournalEntry.request))
            ) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            if (!openAttemptIsCurrent()) return null;
            journalConflictIdentity.current = null;
          } catch (error) {
            if (
              error instanceof EditorDocumentAuthorityErrorV1 &&
              error.code === "conflict" &&
              attempt < 2 &&
              !controller.signal.aborted
            ) {
              pendingSessionRecovery.current = null;
              continue;
            }
            throw error;
          }
        }
        lastSavedSessionCanonical.current = canonical;
        pendingSessionRecovery.current = null;
        installed.onCloudReady();
        return snapshot;
      }
      throw new EditorDocumentAuthorityErrorV1(
        "The Editor document kept changing while its private session opened.",
        "conflict",
      );
    })()
      .then((snapshot) => {
        if (snapshot === null) return;
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== identityKey ||
          authority.current !== nextAuthority
        )
          return;
        presentationReady.current = true;
        updateState({ message: null, phase: "ready", retryable: false });
        remoteHeadQueue.current?.kick();
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== identityKey ||
          authority.current !== nextAuthority
        )
          return;
        if (error instanceof EditorTimelineAdmissionError) {
          const snapshot = authoritySnapshot.current;
          const program = snapshot?.programs.at(-1);
          rejectedTimelineProgram.current = snapshot && program ? { program, revision: snapshot.revision } : null;
        }
        const message = publicAuthorityMessageV1(error);
        const retryable =
          nextAuthority.sessionRecoveryPending || (presentationReady.current && nextAuthority.recoveryKind !== null);
        if (message) {
          const journalConflict = shouldExposeJournalDiscardV1(error, retryable, pendingJournalRetainsCurrentBasis());
          const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
          const journalConflictKind = journalConflictKindV1(error);
          if (journalConflictAccountWide) {
            journalConflictIdentity.current = null;
            if (journalConflictKind === "mutation") mutationConflictLookup.current = null;
          }
          updateState({
            journalConflict,
            journalConflictAccountWide,
            journalConflictKind,
            message,
            phase: journalConflict ? "blocked" : retryable ? "recoverable" : "blocked",
            retryable: journalConflict ? false : retryable,
          });
        }
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
    return () => {
      if (
        presentationReady.current &&
        pendingCommitSessionRecovery.current === null &&
        queuedCommitIdentityKey.current === null &&
        queuedReconcileIdentityKey.current === null
      ) {
        checkpointLatestSession(false);
      }
      controller.abort();
      if (request.current === controller) request.current = null;
      if (authority.current === nextAuthority) {
        authority.current = null;
        authorityIdentityKey.current = null;
      }
      if (liveConnectionIdentityKey.current === identityKey) {
        liveConnection.current?.close();
        liveConnection.current = null;
        liveConnectionIdentityKey.current = null;
      }
      remoteHeadQueue.current?.clear();
    };
  }, [
    checkpointLatestSession,
    client,
    connectLive,
    identityKey,
    installAuthoritySnapshot,
    installAuthoritySnapshotAfterBasisAdvance,
    mutationJournal,
    pendingJournalRetainsCurrentBasis,
    recoverPendingJournalAtOpen,
    reopenGeneration,
    updateState,
  ]);

  const runInOperationLane = useCallback(async <T>(operation: () => Promise<T>) => {
    const preceding = operationLane.current;
    let release!: () => void;
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    operationLane.current = preceding.then(
      () => ticket,
      () => ticket,
    );
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }, []);

  const saveSessionSnapshot = useCallback(
    (snapshot: EditorSessionSnapshotV1, onCloudReady: (() => void) | null = null) => {
      const canonical = canonicalEditorSessionSnapshotJsonV1(snapshot);
      const queuedGeneration = generation.current;
      const queuedIdentityKey = renderedIdentityKey.current;
      const queuedSessionAuthorityEpoch = sessionAuthorityEpoch.current;
      return runInOperationLane(async () => {
        if (
          generation.current !== queuedGeneration ||
          sessionAuthorityEpoch.current !== queuedSessionAuthorityEpoch ||
          queuedIdentityKey === null ||
          renderedIdentityKey.current !== queuedIdentityKey
        ) {
          return false;
        }
        if (lastSavedSessionCanonical.current === canonical) {
          onCloudReady?.();
          return true;
        }
        const activeAuthority = authority.current;
        const activeIdentityKey = renderedIdentityKey.current;
        if (
          !activeAuthority ||
          activeIdentityKey === null ||
          authorityIdentityKey.current !== activeIdentityKey ||
          stateRef.current.phase !== "ready"
        ) {
          return false;
        }
        const activeGeneration = generation.current;
        const controller = new AbortController();
        const saveAttemptIsCurrent = () =>
          !controller.signal.aborted &&
          generation.current === activeGeneration &&
          renderedIdentityKey.current === activeIdentityKey &&
          authority.current === activeAuthority;
        request.current = controller;
        try {
          if (sessionJournal) {
            const recorded = recordSessionSnapshot(snapshot);
            const basis = journalBasis.current;
            if (!recorded || !basis) throw new EditorSessionPendingJournalConflictV1();
            journalConflictIdentity.current = basis.identity;
            let targetAcknowledged = false;
            for (let step = 0; step < 2; step += 1) {
              const lane = sessionJournal.readLaneExact(basis.identity);
              if (!lane) break;
              const attempted = sessionJournal.markAttemptedExact(lane.head.entryId);
              if (!attempted) throw new EditorSessionPendingJournalConflictV1();
              const sealed = await sessionJournal.sealExact(attempted.entryId);
              if (!saveAttemptIsCurrent()) return false;
              if (sealed.kind !== "sealed") throw new EditorSessionPendingJournalConflictV1();
              const attemptedCanonical = canonicalJournalEntrySnapshotV1(attempted);
              pendingSessionRecovery.current = {
                canonical: attemptedCanonical,
                onCloudReady: attemptedCanonical === canonical ? onCloudReady : null,
              };
              const outcome = await activeAuthority.saveSession(attempted.request.snapshot, controller.signal);
              if (!saveAttemptIsCurrent()) return false;
              pendingSessionRecovery.current = null;
              if (outcome.kind === "reconciled") {
                if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
                  throw new EditorSessionPendingJournalConflictV1();
                }
                sessionAuthorityEpoch.current += 1;
                lastSavedSessionCanonical.current = null;
                await projection.current(outcome.snapshot.programs, "remote");
                if (!saveAttemptIsCurrent()) return false;
                remoteHeadQueue.current?.kick();
                return false;
              }
              const previousSnapshot = authoritySnapshot.current;
              if (!previousSnapshot) throw new EditorSessionPendingJournalConflictV1();
              installAuthoritySnapshot({ ...previousSnapshot, sessionGeneration: outcome.sessionGeneration });
              lastSavedSessionCanonical.current = attemptedCanonical;
              terminationAttemptedEntryId.current = null;
              if (!(await sessionJournal.acknowledgeExact(attempted.entryId, attempted.request))) {
                throw new EditorSessionPendingJournalConflictV1();
              }
              if (!saveAttemptIsCurrent()) return false;
              if (attemptedCanonical === canonical) {
                targetAcknowledged = true;
                onCloudReady?.();
              }
            }
            if (!targetAcknowledged && lastSavedSessionCanonical.current !== canonical) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            journalConflictIdentity.current = null;
            return true;
          }

          pendingSessionRecovery.current = { canonical, onCloudReady };
          const outcome = await activeAuthority.saveSession(snapshot, controller.signal);
          if (
            controller.signal.aborted ||
            generation.current !== activeGeneration ||
            renderedIdentityKey.current !== activeIdentityKey ||
            authority.current !== activeAuthority
          ) {
            return false;
          }
          pendingSessionRecovery.current = null;
          if (outcome.kind === "reconciled") {
            if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            sessionAuthorityEpoch.current += 1;
            lastSavedSessionCanonical.current = null;
            await projection.current(outcome.snapshot.programs, "remote");
            if (!saveAttemptIsCurrent()) return false;
            remoteHeadQueue.current?.kick();
            return false;
          }
          const previousSnapshot = authoritySnapshot.current;
          if (previousSnapshot)
            installAuthoritySnapshot({ ...previousSnapshot, sessionGeneration: outcome.sessionGeneration });
          lastSavedSessionCanonical.current = canonical;
          onCloudReady?.();
          return true;
        } catch (error) {
          if (
            controller.signal.aborted ||
            generation.current !== activeGeneration ||
            renderedIdentityKey.current !== activeIdentityKey ||
            authority.current !== activeAuthority
          ) {
            return false;
          }
          if (error instanceof EditorSessionPendingJournalReadErrorV1 && error.code === "storage") {
            const message = publicAuthorityMessageV1(error);
            if (message) {
              updateState(editorDocumentAuthorityStateAfterJournalStorageFailureV1(stateRef.current, message));
            }
            return false;
          }
          const retryable = activeAuthority.sessionRecoveryPending || activeAuthority.recoveryKind !== null;
          if (!retryable) pendingSessionRecovery.current = null;
          const journalConflict = shouldExposeJournalDiscardV1(error, retryable, pendingJournalRetainsCurrentBasis());
          const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
          if (journalConflictAccountWide) journalConflictIdentity.current = null;
          const message = publicAuthorityMessageV1(error);
          if (message) {
            updateState({
              journalConflict,
              journalConflictAccountWide,
              message,
              phase: journalConflict ? "blocked" : retryable ? "recoverable" : "blocked",
              retryable: journalConflict ? false : retryable,
            });
          }
          return false;
        } finally {
          if (request.current === controller) request.current = null;
        }
      });
    },
    [
      installAuthoritySnapshot,
      installAuthoritySnapshotAfterBasisAdvance,
      pendingJournalRetainsCurrentBasis,
      recordSessionSnapshot,
      runInOperationLane,
      sessionJournal,
      updateState,
    ],
  );

  const settlePendingJournalBeforeBasisAdvance = useCallback(async () => {
    const basis = journalBasis.current;
    if (!sessionJournal || !basis) return true;
    try {
      const lane = sessionJournal.readLaneExact(basis.identity);
      if (!lane) return true;
      return await saveSessionSnapshot((lane.successor ?? lane.head).request.snapshot);
    } catch (error) {
      const message = publicAuthorityMessageV1(error);
      if (error instanceof EditorSessionPendingJournalReadErrorV1 && error.code === "storage") {
        if (message) updateState(editorDocumentAuthorityStateAfterJournalStorageFailureV1(stateRef.current, message));
        return false;
      }
      const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
      if (journalConflictAccountWide) journalConflictIdentity.current = null;
      if (message) {
        updateState({
          journalConflict: true,
          journalConflictAccountWide,
          message,
          phase: "blocked",
          retryable: false,
        });
      }
      return false;
    }
  }, [saveSessionSnapshot, sessionJournal, updateState]);

  /**
   * Checkpoints the latest session, then gives the serialized cloud-save lane
   * a bounded opportunity to acknowledge it before navigation continues.
   */
  const flushSession = useCallback(async () => {
    if (renderedIdentityKey.current === null) return { kind: "stored" } as const;
    if (!presentationReady.current) return { kind: "stored" } as const;
    if (
      pendingCommitSessionRecovery.current !== null ||
      queuedCommitIdentityKey.current !== null ||
      queuedReconcileIdentityKey.current !== null
    ) {
      updateState({
        ...stateRef.current,
        message: "Wait for the current Editor change to finish before leaving this Scene.",
      });
      return { kind: "busy" } as const;
    }
    const snapshot = latestSessionSnapshot.current;
    if (snapshot === null) {
      updateState({ ...stateRef.current, message: "The current Editor session is not ready to be saved." });
      return { kind: "failed" } as const;
    }
    const checkpoint = checkpointLatestSession();
    const saveAttempt = saveSessionSnapshot(snapshot).catch(() => false);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const outcome = await Promise.race([
        saveAttempt.then((saved) => ({ kind: "settled", saved }) as const),
        new Promise<Readonly<{ kind: "timed-out" }>>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), EDITOR_SESSION_NAVIGATION_FLUSH_WAIT_MS_V1);
        }),
      ]);
      if (outcome.kind === "settled" && outcome.saved) return { kind: "stored" } as const;
      if (checkpoint.durable) return { kind: "journaled" } as const;
      updateState({
        ...stateRef.current,
        message:
          stateRef.current.message ??
          "The private Editor session could not be saved. Retry the action after browser storage is available.",
      });
      return { kind: "failed" } as const;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }, [checkpointLatestSession, saveSessionSnapshot, updateState]);

  useEffect(() => {
    if (
      identityKey === null ||
      input.sessionSnapshot === null ||
      sessionSnapshotCanonical === null ||
      state.phase !== "ready" ||
      sessionSnapshotCanonical === lastSavedSessionCanonical.current
    ) {
      return;
    }
    const snapshot = input.sessionSnapshot;
    const timeout = window.setTimeout(() => {
      if (renderedIdentityKey.current !== identityKey || stateRef.current.phase !== "ready") return;
      void saveSessionSnapshot(snapshot);
    }, EDITOR_CLOUD_SESSION_AUTOSAVE_DELAY_MS_V1);
    return () => window.clearTimeout(timeout);
  }, [identityKey, input.sessionSnapshot, saveSessionSnapshot, sessionSnapshotCanonical, state.phase]);

  useEffect(() => {
    if (!sessionJournal || !input.identity || identityKey === null) return;
    const terminationIdentity = input.identity;
    const checkpointForTermination = () => {
      if (!presentationReady.current) return;
      if (
        pendingCommitSessionRecovery.current !== null ||
        queuedCommitIdentityKey.current !== null ||
        queuedReconcileIdentityKey.current !== null
      )
        return;
      const basis = journalBasis.current;
      if (!basis) return;
      const checkpoint = checkpointLatestSession(false);
      if (!checkpoint.entry) return;
      if (terminationAttemptedEntryId.current === checkpoint.entry.entryId) return;
      const accepted = attemptEditorDocumentSessionKeepaliveV1(
        {
          organizationId: terminationIdentity.organizationId,
          projectId: terminationIdentity.projectId,
        },
        basis.identity.documentKey,
        checkpoint.entry.request,
      );
      if (!accepted) return;
      const attempted = sessionJournal.markAttemptedExact(checkpoint.entry.entryId);
      if (!attempted) return;
      terminationAttemptedEntryId.current = attempted.entryId;
      void sessionJournal.sealExact(attempted.entryId);
    };
    window.addEventListener("pagehide", checkpointForTermination);
    return () => {
      window.removeEventListener("pagehide", checkpointForTermination);
    };
  }, [checkpointLatestSession, identityKey, input.identity, sessionJournal]);

  const canAuthor = useCallback(() => {
    const activeIdentityKey = renderedIdentityKey.current;
    return (
      activeIdentityKey !== null &&
      authority.current !== null &&
      authorityIdentityKey.current === activeIdentityKey &&
      queuedCommitIdentityKey.current === null &&
      stateRef.current.phase === "ready"
    );
  }, []);

  const commitMutation = useCallback(
    (
      mutation: EditorEditMutationV1,
      sessionSnapshot?: EditorSessionSnapshotV1,
    ): Promise<EditorDocumentAuthorityHookCommitOutcomeV1> => {
      const queuedGeneration = generation.current;
      const queuedIdentityKey = renderedIdentityKey.current;
      if (queuedIdentityKey === null || !canAuthor()) return Promise.resolve({ kind: "blocked" } as const);
      queuedCommitIdentityKey.current = queuedIdentityKey;
      setRenderedQueuedCommitIdentityKey(queuedIdentityKey);
      const commit = async () => {
        if (!(await settlePendingJournalBeforeBasisAdvance())) return { kind: "blocked" } as const;
        return runInOperationLane<EditorDocumentAuthorityHookCommitOutcomeV1>(async () => {
          if (
            generation.current !== queuedGeneration ||
            queuedIdentityKey === null ||
            renderedIdentityKey.current !== queuedIdentityKey
          ) {
            return { kind: "stale" };
          }
          const activeAuthority = authority.current;
          const activeIdentityKey = renderedIdentityKey.current;
          if (
            !activeAuthority ||
            activeIdentityKey === null ||
            authorityIdentityKey.current !== activeIdentityKey ||
            stateRef.current.phase !== "ready"
          )
            return { kind: "blocked" };
          const activeGeneration = generation.current;
          const activeSnapshot = authoritySnapshot.current;
          if (!activeSnapshot) return { kind: "blocked" };
          const mutationIdentity = pendingMutationJournalIdentityV1(activeSnapshot);
          const mutationLookup = pendingMutationJournalLookupV1(mutationIdentity, mutationIdentity.documentKey);
          mutationConflictLookup.current = mutationLookup;
          const controller = new AbortController();
          request.current = controller;
          updateState({ message: null, phase: "pending", retryable: false });
          pendingCommitSessionRecovery.current = sessionSnapshot
            ? {
                canonical: canonicalEditorSessionSnapshotJsonV1(sessionSnapshot),
                snapshot: sessionSnapshot,
              }
            : null;
          try {
            const outcome: EditorDocumentAuthorityCommitOutcomeV1 = await activeAuthority.commit(mutation, {
              onPrepared: (request) => {
                if (!mutationJournal) {
                  throw new EditorMutationPendingJournalErrorV1(
                    "Pending Editor mutation storage is unavailable.",
                    "storage",
                  );
                }
                pendingMutationRecovery.current = mutationJournal.record(mutationIdentity, request);
              },
              sessionSnapshot,
              signal: controller.signal,
            });
            if (
              controller.signal.aborted ||
              generation.current !== activeGeneration ||
              renderedIdentityKey.current !== activeIdentityKey ||
              authority.current !== activeAuthority
            )
              return { kind: "stale" };
            acknowledgePendingMutation(outcome);
            if (outcome.kind === "reconciled") {
              pendingCommitSessionRecovery.current = null;
              if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
                throw new EditorSessionPendingJournalConflictV1();
              }
              sessionAuthorityEpoch.current += 1;
              lastSavedSessionCanonical.current = null;
              await projection.current(outcome.snapshot.programs, "remote");
              if (
                controller.signal.aborted ||
                generation.current !== activeGeneration ||
                renderedIdentityKey.current !== activeIdentityKey ||
                authority.current !== activeAuthority
              ) {
                return { kind: "stale" };
              }
            }
            if (outcome.kind === "committed") {
              pendingCommitSessionRecovery.current = null;
              if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
                throw new EditorSessionPendingJournalConflictV1();
              }
              sessionAuthorityEpoch.current += 1;
              lastSavedSessionCanonical.current =
                !outcome.sessionInvalidated && sessionSnapshot
                  ? canonicalEditorSessionSnapshotJsonV1(sessionSnapshot)
                  : null;
            }
            updateState({ message: null, phase: "ready", retryable: false });
            if (outcome.kind === "committed" || outcome.accepted) {
              liveConnection.current?.publishHead(outcome.snapshot.revision);
            }
            remoteHeadQueue.current?.kick();
            return outcome;
          } catch (error) {
            if (
              controller.signal.aborted ||
              generation.current !== activeGeneration ||
              renderedIdentityKey.current !== activeIdentityKey ||
              authority.current !== activeAuthority
            )
              return { kind: "stale" };
            const retryable = activeAuthority.sessionRecoveryPending || activeAuthority.recoveryKind !== null;
            const retainedMutation = pendingMutationRecovery.current !== null;
            const definitiveMutationConflict = editorMutationJournalConflictIsDefinitiveV1(
              error,
              retainedMutation,
              activeAuthority.recoveryKind,
            );
            const message = publicAuthorityMessageV1(error);
            if (activeAuthority.recoveryKind !== "commit") pendingCommitSessionRecovery.current = null;
            if (
              pendingMutationRecovery.current === null &&
              !(error instanceof EditorMutationPendingJournalErrorV1) &&
              !(error instanceof EditorMutationPendingJournalConflictV1)
            ) {
              mutationConflictLookup.current = null;
            }
            if (message) {
              const journalConflict = shouldExposeJournalDiscardV1(
                error,
                retryable,
                pendingJournalRetainsCurrentBasis() || definitiveMutationConflict,
              );
              const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
              const journalConflictKind = definitiveMutationConflict ? "mutation" : journalConflictKindV1(error);
              if (journalConflictAccountWide && journalConflictKind === "mutation") {
                mutationConflictLookup.current = null;
              }
              updateState({
                journalConflict,
                journalConflictAccountWide,
                journalConflictKind,
                message,
                phase: journalConflict ? "blocked" : retryable ? "recoverable" : "blocked",
                retryable: journalConflict ? false : retryable,
              });
            }
            return { kind: "blocked" };
          } finally {
            if (request.current === controller) request.current = null;
          }
        });
      };
      return commit().finally(() => {
        if (
          generation.current === queuedGeneration &&
          renderedIdentityKey.current === queuedIdentityKey &&
          queuedCommitIdentityKey.current === queuedIdentityKey
        ) {
          queuedCommitIdentityKey.current = null;
          setRenderedQueuedCommitIdentityKey(null);
        }
      });
    },
    [
      canAuthor,
      acknowledgePendingMutation,
      installAuthoritySnapshotAfterBasisAdvance,
      mutationJournal,
      pendingJournalRetainsCurrentBasis,
      runInOperationLane,
      settlePendingJournalBeforeBasisAdvance,
      updateState,
    ],
  );

  const removeRejectedTimelineProgram = useCallback(async () => {
    const recovery = rejectedTimelineProgram.current;
    const snapshot = authoritySnapshot.current;
    const program = snapshot?.programs.at(-1);
    if (
      !recovery ||
      !snapshot ||
      !program ||
      snapshot.revision !== recovery.revision ||
      program !== recovery.program ||
      presentationReady.current ||
      stateRef.current.phase !== "blocked"
    ) {
      return false;
    }
    // Reuse the normal durable mutation lane; only this exact retained Program
    // is allowed through the ready gate while presentation is unavailable.
    updateState({ message: null, phase: "ready", retryable: false });
    const outcome = await commitMutation({
      kind: "remove",
      program,
      targetTransactionId: program.transactionId,
    });
    const advanced = authoritySnapshot.current?.revision !== recovery.revision;
    if (outcome.kind === "blocked" || outcome.kind === "stale") {
      if (!advanced) return false;
    }
    setReopenGeneration((generation) => generation + 1);
    return true;
  }, [commitMutation, updateState]);

  const retry = useCallback(async () => {
    const activeAuthority = authority.current;
    const activeIdentityKey = renderedIdentityKey.current;
    if (
      !activeAuthority ||
      activeIdentityKey === null ||
      authorityIdentityKey.current !== activeIdentityKey ||
      stateRef.current.phase !== "recoverable" ||
      (activeAuthority.recoveryKind === null && !activeAuthority.sessionRecoveryPending)
    )
      return false;
    const activeGeneration = generation.current;
    const controller = new AbortController();
    const retryAttemptIsCurrent = () =>
      !controller.signal.aborted &&
      generation.current === activeGeneration &&
      renderedIdentityKey.current === activeIdentityKey &&
      authority.current === activeAuthority;
    request.current = controller;
    updateState({ message: null, phase: "pending", retryable: false });
    try {
      if (activeAuthority.sessionRecoveryPending) {
        const pending = pendingSessionRecovery.current;
        if (!pending) {
          updateState({
            message: "The recoverable private Editor session payload is unavailable. Reload the Scene.",
            phase: "blocked",
            retryable: false,
          });
          return false;
        }
        const outcome = await activeAuthority.retrySession(controller.signal);
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== activeIdentityKey ||
          authority.current !== activeAuthority
        ) {
          return false;
        }
        pendingSessionRecovery.current = null;
        const journalRecovery = pending.journalRecovery;
        if (outcome.kind === "reconciled") {
          if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
            throw new EditorSessionPendingJournalConflictV1();
          }
          sessionAuthorityEpoch.current += 1;
          lastSavedSessionCanonical.current = null;
          await projection.current(outcome.snapshot.programs, "remote");
          if (!retryAttemptIsCurrent()) return false;
          const basis = journalBasis.current;
          if (basis && sessionJournal?.readLaneExact(basis.identity)) {
            throw new EditorSessionPendingJournalConflictV1();
          }
        } else {
          const previousSnapshot = authoritySnapshot.current;
          if (previousSnapshot) {
            installAuthoritySnapshot({ ...previousSnapshot, sessionGeneration: outcome.sessionGeneration });
          }
          if (journalRecovery) {
            if (
              !(await sessionJournal?.acknowledgeExact(journalRecovery.entry.entryId, journalRecovery.entry.request))
            ) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            if (!retryAttemptIsCurrent()) return false;
            let recovered: EditorDocumentAuthorityOpenOutcomeV1 = Object.freeze({
              ...journalRecovery.opened,
              session: journalRecovery.entry.request.snapshot,
              sessionGeneration: outcome.sessionGeneration,
            });
            installAuthoritySnapshot(recovered);
            recovered = await recoverPendingJournalAtOpen(activeAuthority, recovered, controller.signal, () =>
              Boolean(
                !controller.signal.aborted &&
                  generation.current === activeGeneration &&
                  renderedIdentityKey.current === activeIdentityKey &&
                  authority.current === activeAuthority,
              ),
            );
            if (
              controller.signal.aborted ||
              generation.current !== activeGeneration ||
              renderedIdentityKey.current !== activeIdentityKey ||
              authority.current !== activeAuthority
            ) {
              return false;
            }
            journalConflictIdentity.current = null;
            installAuthoritySnapshot(recovered);
            const installed = await bootstrap.current(recovered);
            if (!retryAttemptIsCurrent()) return false;
            if (installed.persist) {
              throw new EditorDocumentAuthorityErrorV1(
                "The recovered private Editor session was not accepted as stored cloud state.",
                "corrupt-response",
              );
            }
            lastSavedSessionCanonical.current = canonicalEditorSessionSnapshotJsonV1(installed.snapshot);
            installed.onCloudReady();
          } else {
            const basis = journalBasis.current;
            const head = basis ? sessionJournal?.readLaneExact(basis.identity)?.head : null;
            if (
              head &&
              canonicalJournalEntrySnapshotV1(head) === pending.canonical &&
              !(await sessionJournal?.acknowledgeExact(head.entryId, head.request))
            ) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            if (!retryAttemptIsCurrent()) return false;
            lastSavedSessionCanonical.current = pending.canonical;
            pending.onCloudReady?.();
          }
        }
        presentationReady.current = true;
        updateState({ message: null, phase: "ready", retryable: false });
        remoteHeadQueue.current?.kick();
        return true;
      }
      const outcome = await activeAuthority.retry(controller.signal);
      if (
        controller.signal.aborted ||
        generation.current !== activeGeneration ||
        renderedIdentityKey.current !== activeIdentityKey ||
        authority.current !== activeAuthority
      )
        return false;
      if (pendingMutationRecovery.current !== null) acknowledgePendingMutation(outcome);
      pendingSessionRecovery.current = null;
      const pendingCommitSession = pendingCommitSessionRecovery.current;
      if (!installAuthoritySnapshotAfterBasisAdvance(outcome.snapshot)) {
        throw new EditorSessionPendingJournalConflictV1();
      }
      pendingCommitSessionRecovery.current = null;
      if (outcome.kind === "committed" && !outcome.sessionInvalidated && pendingCommitSession) {
        sessionAuthorityEpoch.current += 1;
        const installed = await bootstrap.current({ ...outcome.snapshot, session: pendingCommitSession.snapshot });
        if (!retryAttemptIsCurrent()) return false;
        if (installed.persist) {
          throw new EditorDocumentAuthorityErrorV1(
            "The recovered atomic Editor session was not accepted as stored cloud state.",
            "corrupt-response",
          );
        }
        lastSavedSessionCanonical.current = pendingCommitSession.canonical;
        installed.onCloudReady();
      } else if (outcome.kind === "committed" || outcome.sessionInvalidated) {
        sessionAuthorityEpoch.current += 1;
        lastSavedSessionCanonical.current = null;
        await projection.current(outcome.snapshot.programs, "remote");
        if (!retryAttemptIsCurrent()) return false;
      }
      updateState({ message: null, phase: "ready", retryable: false });
      if (outcome.kind === "committed" || outcome.accepted) {
        liveConnection.current?.publishHead(outcome.snapshot.revision);
      }
      remoteHeadQueue.current?.kick();
      return true;
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation.current !== activeGeneration ||
        renderedIdentityKey.current !== activeIdentityKey ||
        authority.current !== activeAuthority
      )
        return false;
      const retryable = activeAuthority.recoveryKind !== null || activeAuthority.sessionRecoveryPending;
      const definitiveMutationConflict = editorMutationJournalConflictIsDefinitiveV1(
        error,
        pendingMutationRecovery.current !== null,
        activeAuthority.recoveryKind,
      );
      const message = publicAuthorityMessageV1(error);
      if (message) {
        const journalConflict = shouldExposeJournalDiscardV1(
          error,
          retryable,
          pendingJournalRetainsCurrentBasis() || definitiveMutationConflict,
        );
        const journalConflictAccountWide = journalConflictIsAccountWideV1(error);
        const journalConflictKind = definitiveMutationConflict ? "mutation" : journalConflictKindV1(error);
        if (journalConflictAccountWide) {
          journalConflictIdentity.current = null;
          if (journalConflictKind === "mutation") mutationConflictLookup.current = null;
        }
        updateState({
          journalConflict,
          journalConflictAccountWide,
          journalConflictKind,
          message,
          phase: journalConflict ? "blocked" : retryable ? "recoverable" : "blocked",
          retryable: journalConflict ? false : retryable,
        });
      }
      return false;
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [
    acknowledgePendingMutation,
    installAuthoritySnapshot,
    installAuthoritySnapshotAfterBasisAdvance,
    pendingJournalRetainsCurrentBasis,
    recoverPendingJournalAtOpen,
    sessionJournal,
    updateState,
  ]);

  const performRemoteHeadReconcile = useCallback(() => {
    const queuedGeneration = generation.current;
    const queuedIdentityKey = renderedIdentityKey.current;
    if (queuedIdentityKey === null) return Promise.resolve(false);
    queuedReconcileIdentityKey.current = queuedIdentityKey;
    const reconcile = async () => {
      if (!(await settlePendingJournalBeforeBasisAdvance())) return false;
      return runInOperationLane(async () => {
        if (
          generation.current !== queuedGeneration ||
          queuedIdentityKey === null ||
          renderedIdentityKey.current !== queuedIdentityKey
        ) {
          return false;
        }
        const activeAuthority = authority.current;
        const activeIdentityKey = renderedIdentityKey.current;
        if (
          !activeAuthority ||
          activeIdentityKey === null ||
          authorityIdentityKey.current !== activeIdentityKey ||
          stateRef.current.phase !== "ready"
        )
          return false;
        const activeGeneration = generation.current;
        const controller = new AbortController();
        request.current = controller;
        updateState({ message: null, phase: "pending", retryable: false });
        try {
          const result = await activeAuthority.reconcile(controller.signal);
          if (
            controller.signal.aborted ||
            generation.current !== activeGeneration ||
            renderedIdentityKey.current !== activeIdentityKey ||
            authority.current !== activeAuthority
          )
            return false;
          if (result.changed) {
            if (!installAuthoritySnapshotAfterBasisAdvance(result.snapshot)) {
              throw new EditorSessionPendingJournalConflictV1();
            }
            sessionAuthorityEpoch.current += 1;
            lastSavedSessionCanonical.current = null;
            await projection.current(result.snapshot.programs, "remote");
            if (
              controller.signal.aborted ||
              generation.current !== activeGeneration ||
              renderedIdentityKey.current !== activeIdentityKey ||
              authority.current !== activeAuthority
            ) {
              return false;
            }
          }
          updateState({ message: null, phase: "ready", retryable: false });
          return true;
        } catch (error) {
          if (
            controller.signal.aborted ||
            generation.current !== activeGeneration ||
            renderedIdentityKey.current !== activeIdentityKey ||
            authority.current !== activeAuthority
          )
            return false;
          const message = publicAuthorityMessageV1(error);
          const retryable = activeAuthority.recoveryKind !== null;
          if (message) {
            const journalConflict = shouldExposeJournalDiscardV1(error, retryable, pendingJournalRetainsCurrentBasis());
            updateState({
              journalConflict,
              message,
              phase: journalConflict ? "blocked" : retryable ? "recoverable" : "blocked",
              retryable: journalConflict ? false : retryable,
            });
          }
          return false;
        } finally {
          if (request.current === controller) request.current = null;
        }
      });
    };
    return reconcile().finally(() => {
      if (
        generation.current === queuedGeneration &&
        renderedIdentityKey.current === queuedIdentityKey &&
        queuedReconcileIdentityKey.current === queuedIdentityKey
      ) {
        queuedReconcileIdentityKey.current = null;
      }
    });
  }, [
    installAuthoritySnapshotAfterBasisAdvance,
    pendingJournalRetainsCurrentBasis,
    runInOperationLane,
    settlePendingJournalBeforeBasisAdvance,
    updateState,
  ]);
  reconcileRunner.current = performRemoteHeadReconcile;

  /** Transport-independent wake-up seam. The notification revision is never trusted. */
  const reconcileRemoteHead = useCallback(() => {
    remoteHeadQueue.current?.notify();
  }, []);

  const discardPendingSession = useCallback(() => {
    if (!stateRef.current.journalConflict) return false;
    if (stateRef.current.journalConflictKind === "mutation") {
      const lookup = mutationConflictLookup.current;
      if (!mutationJournal) return false;
      if (stateRef.current.journalConflictAccountWide) {
        if (!mutationJournal.discardAll()) return false;
      } else if (!lookup || !mutationJournal.discardExact(lookup)) {
        return false;
      }
      mutationConflictLookup.current = null;
      pendingMutationRecovery.current = null;
      return true;
    }
    const identity = journalConflictIdentity.current;
    if (!sessionJournal) return false;
    if (stateRef.current.journalConflictAccountWide) {
      if (!sessionJournal.discardAll()) return false;
    } else if (identity) {
      if (!sessionJournal.discardLaneExact(identity)) {
        try {
          if (sessionJournal.readLaneExact(identity) !== null) return false;
        } catch {
          return false;
        }
      }
    } else {
      return false;
    }
    journalConflictIdentity.current = null;
    return true;
  }, [mutationJournal, sessionJournal]);

  const updatePresence = useCallback((update: Partial<EditorLivePresenceV1>) => {
    const activeIdentityKey = renderedIdentityKey.current;
    if (activeIdentityKey === null) return;
    if (localPresenceIdentityKey.current !== activeIdentityKey) {
      localPresence.current = emptyEditorPresenceV1();
      localPresenceIdentityKey.current = activeIdentityKey;
    }
    const next = editorLivePresenceSchemaV1.safeParse({ ...localPresence.current, ...update });
    if (!next.success) return;
    localPresence.current = next.data;
    if (liveConnectionIdentityKey.current !== activeIdentityKey) return;
    try {
      liveConnection.current?.publishPresence(next.data);
    } catch {
      // Presence is an ephemeral affordance and must never interrupt editing.
    }
  }, []);

  return {
    authoringBlocked:
      input.identity !== null &&
      (authorityIdentityKey.current !== identityKey ||
        state.phase !== "ready" ||
        renderedQueuedCommitIdentityKey === identityKey),
    canAuthor,
    commitMutation,
    discardPendingSession,
    enabled: input.identity !== null,
    flushSession,
    message: state.message,
    pendingSessionConflict: state.journalConflict,
    pendingSessionConflictAccountWide: state.journalConflictAccountWide,
    pendingJournalConflictKind: state.journalConflictKind,
    phase: state.phase,
    presentationReady:
      input.identity === null ||
      (identityKey !== null && authorityIdentityKey.current === identityKey && presentationReady.current),
    presenceParticipants: presenceRoom.identityKey === identityKey ? presenceRoom.participants : [],
    reconcileRemoteHead,
    rejectedTimelineProgramAvailable:
      rejectedTimelineProgram.current !== null && !presentationReady.current && state.phase === "blocked",
    removeRejectedTimelineProgram,
    retry,
    retryable: state.retryable,
    updatePresence,
  } as const;
}
