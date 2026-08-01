import { useCallback, useEffect, useRef, useState } from "react";

import {
  type EditorDocumentAuthorityCommitOutcomeV1,
  EditorDocumentAuthorityErrorV1,
  type EditorDocumentAuthorityIdentityV1,
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
import type { CanonicalEditProgram } from "./operations";
import type { StudioPresenceParticipantV1 } from "./studio-presence-overlay";

const defaultEditorDocumentClientV1 = new FetchEditorDocumentClientV1();
let defaultEditorLiveClientV1: EditorLiveClientV1 | null | undefined;

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

type UseEditorDocumentAuthorityInputV1 = Readonly<{
  client?: EditorDocumentClientV1;
  identity: EditorDocumentAuthorityIdentityV1 | null;
  liveClient?: EditorLiveClientV1 | null;
  onProjection: (programs: readonly CanonicalEditProgram[], reason: "open" | "remote") => void;
}>;

function identityKeyV1(identity: EditorDocumentAuthorityIdentityV1 | null) {
  return identity
    ? [identity.organizationId, identity.projectId, identity.sourcePath, identity.sceneName, identity.sourceHash].join(
        "\0",
      )
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
  const client = input.client ?? defaultEditorDocumentClientV1;
  const liveClient = input.liveClient === undefined ? browserEditorLiveClientV1() : input.liveClient;
  const identityKey = identityKeyV1(input.identity);
  const renderedIdentityKey = useRef(identityKey);
  renderedIdentityKey.current = identityKey;
  const reconcileRunner = useRef<() => Promise<boolean>>(async () => false);
  const remoteHeadQueue = useRef<EditorRemoteHeadQueueV1 | null>(null);
  const localPresence = useRef<EditorLivePresenceV1>(emptyEditorPresenceV1());
  const localPresenceIdentityKey = useRef<string | null>(identityKey);
  const [presenceRoom, setPresenceRoom] = useState<EditorPresenceRoomV1>({ identityKey: null, participants: [] });
  remoteHeadQueue.current ??= new EditorRemoteHeadQueueV1(
    () => stateRef.current.phase === "ready",
    () => reconcileRunner.current(),
  );

  useEffect(() => {
    generation.current += 1;
    const activeGeneration = generation.current;
    request.current?.abort();
    request.current = null;
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
    if (!input.identity) {
      updateState({ message: null, phase: "disabled", retryable: false });
      return;
    }
    const controller = new AbortController();
    const nextAuthority = new EditorDocumentAuthorityV1(client, input.identity);
    request.current = controller;
    authority.current = nextAuthority;
    authorityIdentityKey.current = identityKey;
    let nextLiveConnection: EditorLiveConnectionV1 | null = null;
    updateState({ message: null, phase: "opening", retryable: false });
    void nextAuthority
      .open(controller.signal)
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== identityKey ||
          authority.current !== nextAuthority
        )
          return;
        projection.current(snapshot.programs, "open");
        updateState({ message: null, phase: "ready", retryable: false });
        if (!liveClient) return;
        try {
          nextLiveConnection = liveClient.connect(
            {
              documentKey: snapshot.document.documentKey,
              epoch: snapshot.document.epoch,
              organizationId: input.identity!.organizationId,
              projectId: input.identity!.projectId,
            },
            {
              onHead: () => {
                if (
                  generation.current !== activeGeneration ||
                  renderedIdentityKey.current !== identityKey ||
                  authority.current !== nextAuthority
                )
                  return;
                remoteHeadQueue.current?.notify();
              },
              onParticipants: (participants, selfMemberId) => {
                if (
                  generation.current !== activeGeneration ||
                  renderedIdentityKey.current !== identityKey ||
                  authority.current !== nextAuthority
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
                  current.identityKey === identityKey &&
                  sameStudioPresenceParticipantsV1(current.participants, projected)
                    ? current
                    : { identityKey, participants: projected },
                );
              },
              onPhase: (phase) => {
                if (
                  generation.current !== activeGeneration ||
                  renderedIdentityKey.current !== identityKey ||
                  authority.current !== nextAuthority
                )
                  return;
                if (phase === "connected") {
                  remoteHeadQueue.current?.notify();
                } else {
                  setPresenceRoom((current) =>
                    current.identityKey === identityKey ? { identityKey: null, participants: [] } : current,
                  );
                }
              },
            },
          );
          liveConnection.current = nextLiveConnection;
          liveConnectionIdentityKey.current = identityKey;
          nextLiveConnection.publishPresence(
            localPresenceIdentityKey.current === identityKey ? localPresence.current : emptyEditorPresenceV1(),
          );
        } catch {
          nextLiveConnection?.close();
          if (liveConnection.current === nextLiveConnection) liveConnection.current = null;
          nextLiveConnection = null;
          liveConnectionIdentityKey.current = null;
        }
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
        const retryable = nextAuthority.recoveryKind !== null;
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
      nextLiveConnection?.close();
      if (liveConnection.current === nextLiveConnection) {
        liveConnection.current = null;
        liveConnectionIdentityKey.current = null;
      }
      remoteHeadQueue.current?.clear();
    };
  }, [client, identityKey, liveClient, updateState]);

  const canAuthor = useCallback(() => {
    const activeIdentityKey = renderedIdentityKey.current;
    return (
      activeIdentityKey !== null &&
      authority.current !== null &&
      authorityIdentityKey.current === activeIdentityKey &&
      stateRef.current.phase === "ready"
    );
  }, []);

  const commitMutation = useCallback(
    async (mutation: EditorEditMutationV1): Promise<EditorDocumentAuthorityHookCommitOutcomeV1> => {
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
      try {
        const outcome: EditorDocumentAuthorityCommitOutcomeV1 = await activeAuthority.commit(
          mutation,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          generation.current !== activeGeneration ||
          renderedIdentityKey.current !== activeIdentityKey ||
          authority.current !== activeAuthority
        )
          return { kind: "stale" };
        if (outcome.kind === "reconciled") projection.current(outcome.snapshot.programs, "remote");
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
        if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
        return { kind: "blocked" };
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [updateState],
  );

  const retry = useCallback(async () => {
    const activeAuthority = authority.current;
    const activeIdentityKey = renderedIdentityKey.current;
    if (
      !activeAuthority ||
      activeIdentityKey === null ||
      authorityIdentityKey.current !== activeIdentityKey ||
      stateRef.current.phase !== "recoverable" ||
      activeAuthority.recoveryKind === null
    )
      return false;
    const activeGeneration = generation.current;
    const controller = new AbortController();
    request.current = controller;
    updateState({ message: null, phase: "pending", retryable: false });
    try {
      const outcome = await activeAuthority.retry(controller.signal);
      if (
        controller.signal.aborted ||
        generation.current !== activeGeneration ||
        renderedIdentityKey.current !== activeIdentityKey ||
        authority.current !== activeAuthority
      )
        return false;
      projection.current(outcome.snapshot.programs, "remote");
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
      const retryable = activeAuthority.recoveryKind !== null;
      if (message) updateState({ message, phase: retryable ? "recoverable" : "blocked", retryable });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [updateState]);

  const performRemoteHeadReconcile = useCallback(async () => {
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
      if (result.changed) projection.current(result.snapshot.programs, "remote");
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
  }, [updateState]);
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
    authoringBlocked: input.identity !== null && state.phase !== "ready",
    canAuthor,
    commitMutation,
    enabled: input.identity !== null,
    message: state.message,
    phase: state.phase,
    presenceParticipants: presenceRoom.identityKey === identityKey ? presenceRoom.participants : [],
    reconcileRemoteHead,
    retry,
    retryable: state.retryable,
    updatePresence,
  } as const;
}
