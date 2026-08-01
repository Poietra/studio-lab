import { useCallback, useEffect, useRef, useState } from "react";

import {
  type EditorDocumentAuthorityCommitOutcomeV1,
  EditorDocumentAuthorityErrorV1,
  type EditorDocumentAuthorityIdentityV1,
  EditorDocumentAuthorityV1,
} from "../collaboration/editor-document-authority";
import { type EditorDocumentClientV1, FetchEditorDocumentClientV1 } from "../collaboration/editor-document-client";
import type { EditorEditMutationV1 } from "../collaboration/editor-edit-mutation";
import type { CanonicalEditProgram } from "./operations";

const defaultEditorDocumentClientV1 = new FetchEditorDocumentClientV1();

type EditorDocumentAuthorityPhaseV1 = "blocked" | "disabled" | "opening" | "pending" | "ready" | "recoverable";

type EditorDocumentAuthorityUiStateV1 = Readonly<{
  message: string | null;
  phase: EditorDocumentAuthorityPhaseV1;
  retryable: boolean;
}>;

export type EditorDocumentAuthorityHookCommitOutcomeV1 =
  | EditorDocumentAuthorityCommitOutcomeV1
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "stale" }>;

type UseEditorDocumentAuthorityInputV1 = Readonly<{
  client?: EditorDocumentClientV1;
  identity: EditorDocumentAuthorityIdentityV1 | null;
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

export function useEditorDocumentAuthorityV1(input: UseEditorDocumentAuthorityInputV1) {
  const [state, setState] = useState<EditorDocumentAuthorityUiStateV1>({
    message: null,
    phase: "disabled",
    retryable: false,
  });
  const authority = useRef<EditorDocumentAuthorityV1 | null>(null);
  const authorityIdentityKey = useRef<string | null>(null);
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
  const identityKey = identityKeyV1(input.identity);
  const renderedIdentityKey = useRef(identityKey);
  renderedIdentityKey.current = identityKey;

  useEffect(() => {
    generation.current += 1;
    const activeGeneration = generation.current;
    request.current?.abort();
    request.current = null;
    authority.current = null;
    authorityIdentityKey.current = null;
    if (!input.identity) {
      updateState({ message: null, phase: "disabled", retryable: false });
      return;
    }
    const controller = new AbortController();
    const nextAuthority = new EditorDocumentAuthorityV1(client, input.identity);
    request.current = controller;
    authority.current = nextAuthority;
    authorityIdentityKey.current = identityKey;
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
    };
  }, [client, identityKey, updateState]);

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

  /** Future WebSocket/DO transports only need to call this head-notification seam. */
  const reconcileRemoteHead = useCallback(async () => {
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

  return {
    authoringBlocked: input.identity !== null && state.phase !== "ready",
    canAuthor,
    commitMutation,
    enabled: input.identity !== null,
    message: state.message,
    phase: state.phase,
    reconcileRemoteHead,
    retry,
    retryable: state.retryable,
  } as const;
}
