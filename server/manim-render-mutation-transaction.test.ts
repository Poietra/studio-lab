import { describe, expect, it } from "vitest";

import type { RenderSessionStatus } from "../src/render-pipeline/contracts";
import {
  createRenderMutationTransactionState,
  type RenderMutationSession,
  RenderMutationTransactionCoordinator,
  renderSourceActionView,
} from "./manim-render-mutation-transaction";

const actionIds = {
  commit: "00000000-0000-4000-8000-000000000101",
  concurrent: "00000000-0000-4000-8000-000000000102",
  retry: "00000000-0000-4000-8000-000000000103",
  undo: "00000000-0000-4000-8000-000000000104",
} as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(status: RenderSessionStatus = "ready"): RenderMutationSession {
  return {
    mutation: createRenderMutationTransactionState(),
    status,
    updatedAt: "before-transaction",
  };
}

function coordinator() {
  return new RenderMutationTransactionCoordinator({
    isClosing: () => false,
    now: () => "after-transaction",
  });
}

describe("RenderMutationTransactionCoordinator", () => {
  it("orders preflight, running-ledger publication, source CAS, session transition, and final ledger publication", async () => {
    const target = session();
    const enteredSourceCas = deferred();
    const releaseSourceCas = deferred();
    const phases: string[] = [];

    const transaction = coordinator().run(target, {
      actionId: actionIds.commit,
      afterTransition: (current) => {
        phases.push(`${current.status}:${current.mutation.actions.get(actionIds.commit)?.state}`);
      },
      expectedKey: "candidate-a",
      kind: "commit",
      preflight: () => phases.push("preflight"),
      publishSource: async (current) => {
        phases.push("source-cas");
        const running = current.mutation.actions.get(actionIds.commit);
        expect(renderSourceActionView(running!)).toEqual({
          id: actionIds.commit,
          kind: "commit",
          outcome: null,
          state: "running",
        });
        expect(current.mutation.actionInProgress).toBe(true);
        expect(current.status).toBe("ready");
        enteredSourceCas.resolve();
        await releaseSourceCas.promise;
        phases.push("source-published");
      },
    });

    await enteredSourceCas.promise;
    expect(phases).toEqual(["preflight", "source-cas"]);
    expect(target.status).toBe("ready");
    expect(target.updatedAt).toBe("before-transaction");

    releaseSourceCas.resolve();
    await expect(transaction).resolves.toEqual({
      action: { id: actionIds.commit, kind: "commit", outcome: "committed", state: "succeeded" },
      executed: true,
    });
    expect(phases).toEqual(["preflight", "source-cas", "source-published", "committed:running"]);
    expect(target).toMatchObject({ status: "committed", updatedAt: "after-transaction" });
    expect(target.mutation.actionInProgress).toBe(false);
    expect(renderSourceActionView(target.mutation.actions.get(actionIds.commit)!)).toEqual({
      id: actionIds.commit,
      kind: "commit",
      outcome: "committed",
      state: "succeeded",
    });
  });

  it("fails closed on an unknown source-publication outcome without claiming a partial session or ledger commit", async () => {
    const target = session();
    const unknownOutcome = new Error("Source publication outcome is unknown.");
    let sourceMayHaveChanged = false;

    await expect(
      coordinator().run(target, {
        actionId: actionIds.commit,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource: async () => {
          sourceMayHaveChanged = true;
          throw unknownOutcome;
        },
      }),
    ).rejects.toBe(unknownOutcome);

    expect(sourceMayHaveChanged).toBe(true);
    expect(target).toMatchObject({ status: "ready", updatedAt: "before-transaction" });
    expect(target.mutation.actionInProgress).toBe(false);
    expect(renderSourceActionView(target.mutation.actions.get(actionIds.commit)!)).toEqual({
      id: actionIds.commit,
      kind: "commit",
      outcome: null,
      state: "failed",
    });
    await expect(
      coordinator().run(target, {
        actionId: actionIds.commit,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource: async () => undefined,
      }),
    ).rejects.toThrow(/previous Commit action failed/i);
  });

  it("does not create a ledger entry or call source CAS when preflight rejects a stale candidate", async () => {
    const target = session();
    const publishSource = async () => {
      throw new Error("Source CAS must not run.");
    };

    await expect(
      coordinator().run(target, {
        actionId: actionIds.commit,
        expectedKey: "stale-candidate",
        kind: "commit",
        preflight: () => {
          throw new Error("Stale rendered candidate.");
        },
        publishSource,
      }),
    ).rejects.toThrow(/stale rendered candidate/i);

    expect(target.mutation.actions.size).toBe(0);
    expect(target.mutation.latestActionId).toBeNull();
    expect(target.mutation.actionInProgress).toBe(false);
    expect(target.status).toBe("ready");
  });

  it("coalesces an exact running replay, rejects a concurrent different action, and rejects stale replay after Undo", async () => {
    const target = session();
    const sourceCasEntered = deferred();
    const releaseSourceCas = deferred();
    let sourcePublications = 0;
    const transactions = coordinator();
    const publishSource = async () => {
      sourcePublications += 1;
      sourceCasEntered.resolve();
      await releaseSourceCas.promise;
    };
    const first = transactions.run(target, {
      actionId: actionIds.commit,
      expectedKey: "candidate-a",
      kind: "commit",
      publishSource,
    });
    await sourceCasEntered.promise;

    const replay = transactions.run(target, {
      actionId: actionIds.commit,
      expectedKey: "candidate-a",
      kind: "commit",
      publishSource,
    });
    await expect(
      transactions.run(target, {
        actionId: actionIds.concurrent,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource,
      }),
    ).rejects.toThrow(/another action is already running/i);

    releaseSourceCas.resolve();
    await expect(first).resolves.toMatchObject({ executed: true });
    await expect(replay).resolves.toMatchObject({ executed: false });
    expect(sourcePublications).toBe(1);
    await expect(
      transactions.run(target, {
        actionId: actionIds.commit,
        expectedKey: "different-candidate",
        kind: "commit",
        publishSource,
      }),
    ).rejects.toThrow(/already bound to a different mutation/i);

    await expect(
      transactions.run(target, {
        actionId: actionIds.undo,
        expectedKey: "undo",
        kind: "undo",
        publishSource: async () => undefined,
      }),
    ).resolves.toMatchObject({
      action: { kind: "undo", outcome: "undone", state: "succeeded" },
      executed: true,
    });
    expect(target.status).toBe("undone");

    await expect(
      transactions.run(target, {
        actionId: actionIds.commit,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource,
      }),
    ).rejects.toThrow(/session has since advanced/i);
  });

  it("publishes a cancellation tombstone before a delayed mutation and keeps pre-CAS aborts source-free", async () => {
    const target = session();
    const transactions = coordinator();

    await expect(transactions.cancel(target, { actionId: actionIds.commit, kind: "commit" })).resolves.toEqual({
      id: actionIds.commit,
      kind: "commit",
      outcome: null,
      state: "cancelled",
    });
    await expect(transactions.cancel(target, { actionId: actionIds.commit, kind: "undo" })).rejects.toThrow(
      /cancellation kind does not match/i,
    );
    await expect(
      transactions.run(target, {
        actionId: actionIds.commit,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource: async () => {
          throw new Error("Tombstoned source CAS must not run.");
        },
      }),
    ).rejects.toThrow(/Commit action was cancelled/i);

    const preAborted = new AbortController();
    preAborted.abort();
    let sourceCalled = false;
    await expect(
      transactions.run(target, {
        actionId: actionIds.retry,
        expectedKey: "candidate-a",
        kind: "commit",
        publishSource: async () => {
          sourceCalled = true;
        },
        signal: preAborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sourceCalled).toBe(false);
    expect(target.status).toBe("ready");
    expect(renderSourceActionView(target.mutation.actions.get(actionIds.retry)!)).toMatchObject({
      outcome: null,
      state: "cancelled",
    });
  });

  it("aborts and joins an in-flight source CAS, while preserving a CAS that already won cancellation", async () => {
    const cancelledTarget = session();
    const transactions = coordinator();
    const entered = deferred();
    const mutation = transactions.run(cancelledTarget, {
      actionId: actionIds.commit,
      expectedKey: "candidate-a",
      kind: "commit",
      publishSource: async (_session, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const rejectedMutation = expect(mutation).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    await expect(
      transactions.cancel(cancelledTarget, { actionId: actionIds.commit, kind: "commit" }),
    ).resolves.toMatchObject({ outcome: null, state: "cancelled" });
    await rejectedMutation;
    expect(cancelledTarget.status).toBe("ready");

    const winningTarget = session();
    const sourcePublished = deferred();
    const finishSourceCallback = deferred();
    const winningMutation = transactions.run(winningTarget, {
      actionId: actionIds.concurrent,
      expectedKey: "candidate-b",
      kind: "commit",
      publishSource: async () => {
        sourcePublished.resolve();
        await finishSourceCallback.promise;
      },
    });
    await sourcePublished.promise;
    const lateCancellation = transactions.cancel(winningTarget, {
      actionId: actionIds.concurrent,
      kind: "commit",
    });
    finishSourceCallback.resolve();

    await expect(winningMutation).resolves.toMatchObject({ executed: true });
    await expect(lateCancellation).resolves.toMatchObject({ outcome: "committed", state: "succeeded" });
    expect(winningTarget.status).toBe("committed");
  });
});
