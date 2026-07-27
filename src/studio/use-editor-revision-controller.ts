import { useCallback, useLayoutEffect, useRef } from "react";
import {
  type EditorRevision,
  type EditorRevisionDurationPolicy,
  type EditorSourceLifecycle,
  resolveEditorRevisionDurationPolicy,
  type VerifiedSourceDurationBasis,
} from "./editor-revision-policy";
import type { EditorSessionSnapshot } from "./editor-session-store";

export type EditorRevisionRequestTicket = Readonly<{
  controller: AbortController;
  generation: number;
  revisionKey: string;
}>;

/** Latest-only async boundary keyed by the exact selection and editor revision. */
export class EditorRevisionRequestController {
  #current: EditorRevisionRequestTicket | null = null;
  #generation = 0;
  #pendingOwner: EditorRevisionRequestTicket | null = null;

  begin(revisionKey: string | null) {
    this.cancel();
    if (revisionKey === null) return null;
    const ticket = {
      controller: new AbortController(),
      generation: this.#generation,
      revisionKey,
    } satisfies EditorRevisionRequestTicket;
    this.#current = ticket;
    this.#pendingOwner = ticket;
    return ticket;
  }

  cancel() {
    this.#generation += 1;
    this.#current?.controller.abort();
    this.#current = null;
  }

  finish(ticket: EditorRevisionRequestTicket) {
    if (this.#pendingOwner !== ticket) return false;
    this.#pendingOwner = null;
    if (this.#current === ticket) this.#current = null;
    return true;
  }

  isCurrent(ticket: EditorRevisionRequestTicket, revisionKey: string | null) {
    return (
      this.#current === ticket &&
      this.#generation === ticket.generation &&
      ticket.revisionKey === revisionKey &&
      !ticket.controller.signal.aborted
    );
  }

  synchronize(revisionKey: string | null) {
    if (this.#current && this.#current.revisionKey !== revisionKey) this.cancel();
  }
}

type UseEditorRevisionControllerInput = Readonly<{
  candidate: number | null;
  lifecycle: EditorSourceLifecycle;
  metadataPhase: "failed" | "inactive" | "loading" | "ready" | null;
  providerPending: boolean;
  retained: VerifiedSourceDurationBasis | null;
  revision: EditorRevision;
  setVerifiedSourceDurationBasis: (value: EditorSessionSnapshot["verifiedSourceDurationBasis"]) => void;
}>;

export type EditorRevisionController = EditorRevisionDurationPolicy &
  Readonly<{
    beginRequest: () => EditorRevisionRequestTicket | null;
    blockDurationAuthority: (message: string) => void;
    finishRequest: (ticket: EditorRevisionRequestTicket) => boolean;
    isRequestCurrent: (ticket: EditorRevisionRequestTicket) => boolean;
    readDurationBlocker: () => string | null;
  }>;

export function useEditorRevisionController(input: UseEditorRevisionControllerInput): EditorRevisionController {
  const policy = resolveEditorRevisionDurationPolicy(input);
  const revisionKey = useRef(input.revision.asyncRevisionKey);
  revisionKey.current = input.revision.asyncRevisionKey;
  const durationBlocker = useRef(policy.durationBlockMessage);
  durationBlocker.current = policy.durationBlockMessage;
  const requestController = useRef<EditorRevisionRequestController | null>(null);
  if (requestController.current === null) requestController.current = new EditorRevisionRequestController();
  const requests = requestController.current;

  useLayoutEffect(() => {
    requests.synchronize(input.revision.asyncRevisionKey);
  }, [input.revision.asyncRevisionKey, requests]);
  useLayoutEffect(
    () => () => {
      requests.cancel();
    },
    [requests],
  );
  useLayoutEffect(() => {
    if (policy.adoption) input.setVerifiedSourceDurationBasis(policy.adoption);
  }, [input.setVerifiedSourceDurationBasis, policy.adoption]);

  const beginRequest = useCallback(() => requests.begin(revisionKey.current), [requests]);
  const blockDurationAuthority = useCallback((message: string) => {
    durationBlocker.current = message;
  }, []);
  const finishRequest = useCallback((ticket: EditorRevisionRequestTicket) => requests.finish(ticket), [requests]);
  const isRequestCurrent = useCallback(
    (ticket: EditorRevisionRequestTicket) => requests.isCurrent(ticket, revisionKey.current),
    [requests],
  );
  const readDurationBlocker = useCallback(() => durationBlocker.current, []);

  return {
    ...policy,
    beginRequest,
    blockDurationAuthority,
    finishRequest,
    isRequestCurrent,
    readDurationBlocker,
  };
}
