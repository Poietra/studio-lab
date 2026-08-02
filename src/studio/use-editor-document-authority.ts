import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type EditorDocumentAuthorityCommitOutcomeV1,
  EditorDocumentAuthorityErrorV1,
  type EditorDocumentAuthorityIdentityV1,
  type EditorDocumentAuthorityOpenOutcomeV1,
  type EditorDocumentAuthoritySnapshotV1,
  EditorDocumentAuthorityV1,
} from "../collaboration/editor-document-authority";
import { type EditorDocumentClientV1, FetchEditorDocumentClientV1 } from "../collaboration/editor-document-client";
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
import type { CanonicalEditProgram } from "./operations";
import type { StudioPresenceParticipantV1 } from "./studio-presence-overlay";

const defaultEditorDocumentClientV1 = new FetchEditorDocumentClientV1();
let defaultEditorLiveClientV1: EditorLiveClientV1 | null | undefined;
const EDITOR_CLOUD_SESSION_AUTOSAVE_DELAY_MS_V1 = 300;

function browserEditorLiveClientV1() {
  if (defaultEditorLiveClientV1 !== undefined) return defaultEditorLiveClientV1;
  defaultEditorLiveClientV1 =
    typeof window === "undefined" || typeof WebSocket === "undefined" ? null : new BrowserEditorLiveClientV1();
  return defaultEditorLiveClientV1;
}

type EditorDocumentAuthorityPhaseV1 = "blocked" | "disabled" | "opening" | "pending" | "ready" | "recoverable";

type EditorDocumentAuthorityUiStateV1 = Readonly<{
  message: string | null;
  phase: EditorDocumentAuthorityPhaseV1;
  retryable: boolean;
}>;

type EditorPresenceRoomV1 = Readonly<{
  identityKey: string | null;
  participants: readonly StudioPresenceParticipantV1[];
}>;

export type EditorDocumentAuthorityHookCommitOutcomeV1 =
  | EditorDocumentAuthorityCommitOutcomeV1
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "stale" }>;

export type EditorDocumentSessionBootstrapV1 = Readonly<{
  onCloudReady: () => void;
  persist: boolean;
  snapshot: EditorSessionSnapshotV1;
}>;

type UseEditorDocumentAuthorityInputV1 = Readonly<{
  client?: EditorDocumentClientV1;
  identity: EditorDocumentAuthorityIdentityV1 | null;
  liveClient?: EditorLiveClientV1 | null;
  onOpen: (outcome: EditorDocumentAuthorityOpenOutcomeV1) => EditorDocumentSessionBootstrapV1;
  onProjection: (programs: readonly CanonicalEditProgram[], reason: "open" | "remote") => void;
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

function publicAuthorityMessageV1(error: unknown) {
  if (error instanceof EditorDocumentAuthorityErrorV1) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return null;
  return "The authoritative Editor document is unavailable. Reload the Scene before editing.";
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
  const [state, setState] = useState<EditorDocumentAuthorityUiStateV1>({
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
  const updateState = useCallback((next: EditorDocumentAuthorityUiStateV1) => {
    stateRef.current = next;
    setState(next);
  }, []);
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
  const lastSavedSessionCanonical = useRef<string | null>(null);
  const operationLane = useRef<Promise<void>>(Promise.resolve());
  const sessionAuthorityEpoch = useRef(0);
  const pendingSessionRecovery = useRef<Readonly<{
    canonical: string;
    onCloudReady: (() => void) | null;
  }> | null>(null);
  const pendingCommitSessionRecovery = useRef<Readonly<{
    canonical: string;
    snapshot: EditorSessionSnapshotV1;
  }> | null>(null);
  const queuedCommitIdentityKey = useRef<string | null>(null);
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
    setRenderedQueuedCommitIdentityKey(null);
    presentationReady.current = false;
    lastSavedSessionCanonical.current = null;
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
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = await nextAuthority.open(controller.signal);
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== identityKey ||
          authority.current !== nextAuthority
        ) {
          return null;
        }
        connectLive(snapshot, activeIdentity, activeGeneration, identityKey, nextAuthority);
        const installed = bootstrap.current(snapshot);
        presentationReady.current = true;
        const canonical = canonicalEditorSessionSnapshotJsonV1(installed.snapshot);
        if (installed.persist) {
          pendingSessionRecovery.current = { canonical, onCloudReady: installed.onCloudReady };
          try {
            const saved = await nextAuthority.saveSession(installed.snapshot, controller.signal);
            if (saved.kind === "reconciled") {
              sessionAuthorityEpoch.current += 1;
              lastSavedSessionCanonical.current = null;
              projection.current(saved.snapshot.programs, "remote");
              pendingSessionRecovery.current = null;
              if (attempt < 2) continue;
              throw new EditorDocumentAuthorityErrorV1(
                "The Editor document kept changing while its private session opened.",
                "conflict",
              );
            }
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
        const message = publicAuthorityMessageV1(error);
        const retryable =
          nextAuthority.sessionRecoveryPending || (presentationReady.current && nextAuthority.recoveryKind !== null);
        if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
    return () => {
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
  }, [client, connectLive, identityKey, updateState]);

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
        request.current = controller;
        pendingSessionRecovery.current = { canonical, onCloudReady };
        try {
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
            sessionAuthorityEpoch.current += 1;
            lastSavedSessionCanonical.current = null;
            projection.current(outcome.snapshot.programs, "remote");
            remoteHeadQueue.current?.kick();
            return false;
          }
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
          const retryable = activeAuthority.sessionRecoveryPending || activeAuthority.recoveryKind !== null;
          if (!retryable) pendingSessionRecovery.current = null;
          const message = publicAuthorityMessageV1(error);
          if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
          return false;
        } finally {
          if (request.current === controller) request.current = null;
        }
      });
    },
    [runInOperationLane, updateState],
  );

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
          const outcome: EditorDocumentAuthorityCommitOutcomeV1 = sessionSnapshot
            ? await activeAuthority.commit(mutation, { sessionSnapshot, signal: controller.signal })
            : await activeAuthority.commit(mutation, controller.signal);
          if (
            controller.signal.aborted ||
            generation.current !== activeGeneration ||
            renderedIdentityKey.current !== activeIdentityKey ||
            authority.current !== activeAuthority
          )
            return { kind: "stale" };
          if (outcome.kind === "reconciled") {
            pendingCommitSessionRecovery.current = null;
            sessionAuthorityEpoch.current += 1;
            lastSavedSessionCanonical.current = null;
            projection.current(outcome.snapshot.programs, "remote");
          }
          if (outcome.kind === "committed") {
            pendingCommitSessionRecovery.current = null;
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
          const message = publicAuthorityMessageV1(error);
          const retryable = activeAuthority.recoveryKind !== null;
          if (activeAuthority.recoveryKind !== "commit") pendingCommitSessionRecovery.current = null;
          if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
          return { kind: "blocked" };
        } finally {
          if (request.current === controller) request.current = null;
        }
      }).finally(() => {
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
    [canAuthor, runInOperationLane, updateState],
  );

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
        if (outcome.kind === "reconciled") {
          sessionAuthorityEpoch.current += 1;
          lastSavedSessionCanonical.current = null;
          projection.current(outcome.snapshot.programs, "remote");
        } else {
          lastSavedSessionCanonical.current = pending.canonical;
          pending.onCloudReady?.();
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
      pendingSessionRecovery.current = null;
      const pendingCommitSession = pendingCommitSessionRecovery.current;
      pendingCommitSessionRecovery.current = null;
      if (outcome.kind === "committed" && !outcome.sessionInvalidated && pendingCommitSession) {
        sessionAuthorityEpoch.current += 1;
        const installed = bootstrap.current({ ...outcome.snapshot, session: pendingCommitSession.snapshot });
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
        projection.current(outcome.snapshot.programs, "remote");
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
      const message = publicAuthorityMessageV1(error);
      const retryable = activeAuthority.recoveryKind !== null || activeAuthority.sessionRecoveryPending;
      if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [updateState]);

  const performRemoteHeadReconcile = useCallback(() => {
    const queuedGeneration = generation.current;
    const queuedIdentityKey = renderedIdentityKey.current;
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
          sessionAuthorityEpoch.current += 1;
          lastSavedSessionCanonical.current = null;
          projection.current(result.snapshot.programs, "remote");
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
        if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
        return false;
      } finally {
        if (request.current === controller) request.current = null;
      }
    });
  }, [runInOperationLane, updateState]);
  reconcileRunner.current = performRemoteHeadReconcile;

  /** Transport-independent wake-up seam. The notification revision is never trusted. */
  const reconcileRemoteHead = useCallback(() => {
    remoteHeadQueue.current?.notify();
  }, []);

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
    enabled: input.identity !== null,
    message: state.message,
    phase: state.phase,
    presentationReady:
      input.identity === null ||
      (identityKey !== null && authorityIdentityKey.current === identityKey && presentationReady.current),
    presenceParticipants: presenceRoom.identityKey === identityKey ? presenceRoom.participants : [],
    reconcileRemoteHead,
    retry,
    retryable: state.retryable,
    updatePresence,
  } as const;
}
