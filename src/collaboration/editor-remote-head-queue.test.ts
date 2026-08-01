import { describe, expect, it, vi } from "vitest";

import { EditorRemoteHeadQueueV1 } from "./editor-remote-head-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Editor remote-head queue", () => {
  it("holds a notification during a local commit and reconciles when kicked", async () => {
    let ready = false;
    const reconcile = vi.fn(async () => true);
    const queue = new EditorRemoteHeadQueueV1(() => ready, reconcile);

    queue.notify();
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    ready = true;
    queue.kick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
  });

  it("coalesces notifications received during one reconciliation into one follow-up", async () => {
    const first = deferred<boolean>();
    const reconcile = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValue(true);
    const queue = new EditorRemoteHeadQueueV1(() => true, reconcile);

    queue.notify();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    queue.notify();
    queue.notify();
    first.resolve(true);

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  });

  it("drops queued work when the Scene identity is cleared", async () => {
    let ready = false;
    const reconcile = vi.fn(async () => true);
    const queue = new EditorRemoteHeadQueueV1(() => ready, reconcile);

    queue.notify();
    queue.clear();
    ready = true;
    queue.kick();
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs a new identity notification after the previous reconciliation unwinds", async () => {
    const first = deferred<boolean>();
    const reconcile = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValue(true);
    const queue = new EditorRemoteHeadQueueV1(() => true, reconcile);

    queue.notify();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    queue.clear();
    queue.notify();
    first.resolve(false);

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  });
});
