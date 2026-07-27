import type {
  RenderSessionStatus,
  RenderSourceActionCancellationRequest,
  RenderSourceActionView,
} from "../src/render-pipeline/contracts";
import { HttpError } from "./http/json";
import { renderSessionStatusPolicy } from "./manim-render-session-policy";

export type RenderSourceMutationKind = "commit" | "undo";
export type RenderSourceMutationOutcome = "committed" | "undone";

export type RenderSourceActionRecord = {
  abortController: AbortController;
  completion: Promise<void>;
  expectedKey: string | null;
  id: string;
  kind: RenderSourceMutationKind;
  outcome: RenderSourceMutationOutcome | null;
  state: "cancelled" | "failed" | "running" | "succeeded";
};

export type RenderMutationTransactionState = {
  actionInProgress: boolean;
  actions: Map<string, RenderSourceActionRecord>;
  latestActionId: string | null;
};

export type RenderMutationSession = {
  mutation: RenderMutationTransactionState;
  status: RenderSessionStatus;
  updatedAt: string;
};

type RenderMutationTransition = Readonly<{
  outcome: RenderSourceMutationOutcome;
  status: Extract<RenderSessionStatus, "committed" | "undone">;
}>;

const MUTATION_TRANSITIONS = {
  commit: { outcome: "committed", status: "committed" },
  undo: { outcome: "undone", status: "undone" },
} as const satisfies Record<RenderSourceMutationKind, RenderMutationTransition>;

const MAX_SOURCE_ACTION_RECORDS = 64;

function mutationLabel(kind: RenderSourceMutationKind) {
  return kind === "commit" ? "Commit" : "Undo";
}

function assertMutationAllowed(status: RenderSessionStatus, kind: RenderSourceMutationKind) {
  const policy = renderSessionStatusPolicy(status);
  if (kind === "commit" ? !policy.committable : !policy.undoable) {
    throw new HttpError(
      kind === "commit"
        ? "Only a successful preview can be committed."
        : "Only a committed source change can be undone.",
      409,
    );
  }
}

function assertCancellationAllowed(status: RenderSessionStatus, kind: RenderSourceMutationKind) {
  const policy = renderSessionStatusPolicy(status);
  if (kind === "commit" ? !policy.committable : !policy.undoable) {
    const expectedStatus = kind === "commit" ? "ready" : "committed";
    throw new HttpError(`Only a ${expectedStatus} render session can register this cancellation.`, 409);
  }
}

function assertLedgerCapacity(state: RenderMutationTransactionState) {
  if (state.actions.size >= MAX_SOURCE_ACTION_RECORDS) {
    throw new HttpError("This render session has too many retained source-action outcomes.", 429);
  }
}

function createCompletion() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveCompletion) => {
    resolve = resolveCompletion;
  });
  return { promise, resolve };
}

export function createRenderMutationTransactionState(): RenderMutationTransactionState {
  return {
    actionInProgress: false,
    actions: new Map(),
    latestActionId: null,
  };
}

export function beginRenderSessionAction(
  state: RenderMutationTransactionState,
  options: Readonly<{ allowWhileClosing?: boolean; closing: boolean }>,
) {
  if (options.closing && !options.allowWhileClosing) {
    throw new HttpError("The Manim render pipeline is shutting down.", 503);
  }
  if (state.actionInProgress) {
    throw new HttpError("Another action is already running for this render session.", 409);
  }
  state.actionInProgress = true;
  return () => {
    state.actionInProgress = false;
  };
}

export function renderSourceActionView(action: RenderSourceActionRecord): RenderSourceActionView {
  return {
    id: action.id,
    kind: action.kind,
    outcome: action.outcome,
    state: action.state,
  };
}

export function runningRenderSourceActions(state: RenderMutationTransactionState) {
  return [...state.actions.values()].filter((action) => action.state === "running");
}

/**
 * Owns the source-mutation transaction state machine while callers retain the
 * actual source-store and resource lifecycle. A new action always progresses
 * through: preflight -> running ledger record -> source CAS -> session
 * transition -> terminal ledger publication. There is no await between the
 * session transition and terminal ledger publication, so observers cannot see
 * a committed/undone session paired with a running action.
 */
export class RenderMutationTransactionCoordinator {
  private readonly isClosing: () => boolean;
  private readonly now: () => string;

  constructor(options: Readonly<{ isClosing: () => boolean; now?: () => string }>) {
    this.isClosing = options.isClosing;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private assertOpen() {
    if (this.isClosing()) throw new HttpError("The Manim render pipeline is shutting down.", 503);
  }

  async run<TSession extends RenderMutationSession>(
    session: TSession,
    input: Readonly<{
      actionId: string;
      /**
       * Synchronous, non-throwing publication hook for state derived from the
       * committed session transition. Throwing here would occur after the
       * source CAS has succeeded, so callers must schedule fallible work and
       * contain its errors outside this transaction boundary.
       */
      afterTransition?: (session: TSession) => void;
      expectedKey: string;
      kind: RenderSourceMutationKind;
      preflight?: (session: TSession) => void;
      publishSource: (session: TSession, signal: AbortSignal) => Promise<void>;
      signal?: AbortSignal;
    }>,
  ) {
    this.assertOpen();
    const { mutation } = session;
    const existing = mutation.actions.get(input.actionId);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        (existing.expectedKey !== null && existing.expectedKey !== input.expectedKey)
      ) {
        throw new HttpError("The source action ID is already bound to a different mutation.", 409);
      }
      if (existing.state === "running") await existing.completion;
      if (existing.state === "succeeded") {
        if (mutation.latestActionId !== existing.id) {
          throw new HttpError("The source action completed, but this render session has since advanced.", 409);
        }
        return { action: renderSourceActionView(existing), executed: false } as const;
      }
      throw new HttpError(
        existing.state === "cancelled"
          ? `The ${mutationLabel(input.kind)} action was cancelled before it changed the source.`
          : `The previous ${mutationLabel(input.kind)} action failed. Start a new action to retry.`,
        409,
      );
    }

    assertLedgerCapacity(mutation);
    assertMutationAllowed(session.status, input.kind);
    input.preflight?.(session);

    const finishAction = beginRenderSessionAction(mutation, { closing: this.isClosing() });
    const abortController = new AbortController();
    const abortAction = () => abortController.abort(input.signal?.reason);
    if (input.signal?.aborted) abortAction();
    else input.signal?.addEventListener("abort", abortAction, { once: true });
    const completion = createCompletion();
    const action: RenderSourceActionRecord = {
      abortController,
      completion: completion.promise,
      expectedKey: input.expectedKey,
      id: input.actionId,
      kind: input.kind,
      outcome: null,
      state: "running",
    };
    mutation.actions.set(action.id, action);
    mutation.latestActionId = action.id;

    let actionError: unknown = null;
    try {
      abortController.signal.throwIfAborted();
      await input.publishSource(session, abortController.signal);
      const transition = MUTATION_TRANSITIONS[input.kind];
      session.status = transition.status;
      session.updatedAt = this.now();
      input.afterTransition?.(session);
      action.outcome = transition.outcome;
      action.state = "succeeded";
    } catch (error) {
      action.state = abortController.signal.aborted ? "cancelled" : "failed";
      actionError = error;
    } finally {
      input.signal?.removeEventListener("abort", abortAction);
      finishAction();
      completion.resolve();
    }
    if (actionError) throw actionError;
    return { action: renderSourceActionView(action), executed: true } as const;
  }

  async cancel(session: RenderMutationSession, request: RenderSourceActionCancellationRequest) {
    this.assertOpen();
    const { mutation } = session;
    let action = mutation.actions.get(request.actionId);
    if (action) {
      if (action.kind !== request.kind) {
        throw new HttpError("The source-action cancellation kind does not match its registered action.", 409);
      }
      if (action.state === "running") {
        action.abortController.abort();
        await action.completion;
      } else if (mutation.actionInProgress) {
        throw new HttpError("Another action is already running for this render session.", 409);
      }
    } else {
      assertCancellationAllowed(session.status, request.kind);
      assertLedgerCapacity(mutation);
      const finishAction = beginRenderSessionAction(mutation, { closing: this.isClosing() });
      try {
        action = {
          abortController: new AbortController(),
          completion: Promise.resolve(),
          expectedKey: null,
          id: request.actionId,
          kind: request.kind,
          outcome: null,
          state: "cancelled",
        };
        mutation.actions.set(action.id, action);
        mutation.latestActionId = action.id;
      } finally {
        finishAction();
      }
    }
    return renderSourceActionView(action);
  }
}
