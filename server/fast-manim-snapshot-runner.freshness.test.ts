import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1, ZERO_SHA256 } from "./fast-manim-snapshot-contract";
import { FastManimSnapshotAdmissionController, FastManimSnapshotPublicationStore } from "./fast-manim-snapshot-runner";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { sourceHash } from "./manim-source-store";
import {
  createRunner,
  exampleQuery,
  expectFailure,
  expectNoSnapshot,
  installFastManimSnapshotRunnerFixture,
  mkfifo,
  producerCommand,
  producerGate,
  runRequest,
  sceneSource,
  supportsVerifiedRead,
  TEST_PRODUCER_TIMER_SETTLE_MS,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot, reapAfterTest, temporaryRoots } = installFastManimSnapshotRunnerFixture();

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot runner", () => {
  it("settles a run whose source is swapped to a FIFO before open instead of hanging", {
    timeout: 10_000,
  }, async () => {
    const root = await projectRoot();
    const pidFile = join(root, "fifo-run.pid");
    const scenePath = join(root, "scene.py");
    let swapped = false;
    const runner = createRunner(root, producerCommand(`--pid-file=${pidFile}`), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (swapped) return;
          swapped = true;
          await rm(scenePath, { force: true });
          await mkfifo(scenePath);
        },
      },
    });
    // Read, run, and close all settle inside the test deadline: without
    // O_NONBLOCK the open would block until a FIFO writer appeared.
    await expect(runner.run(runRequest())).rejects.toMatchObject({ status: 400 });
    expect(swapped).toBe(true);
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await runner.close();
  });

  it("stales and unpublishes on a FIFO swap observed by the snapshot GET freshness read", async () => {
    const root = await projectRoot();
    const scenePath = join(root, "scene.py");
    const runner = createRunner(root, producerCommand());
    expect((await runner.run(runRequest())).status).toBe("verified");
    await rm(scenePath);
    await mkfifo(scenePath);
    const view = await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    expect(view.status).toBe("stale");
    await expectNoSnapshot(runner);
  });

  it("stales and unpublishes on a symlink swap even when the target bytes hash identically", async () => {
    const root = await projectRoot();
    const scenePath = join(root, "scene.py");
    const runner = createRunner(root, producerCommand());
    expect((await runner.run(runRequest())).status).toBe("verified");
    // Same content, but the pathname no longer proves an inode inside the
    // root: the hardened GET freshness read must refuse to vouch for it.
    const outsideRoot = await mkdtemp(join(tmpdir(), "poietra-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "outside.py");
    await writeFile(outsidePath, sceneSource, "utf8");
    await rm(scenePath);
    await symlink(outsidePath, scenePath);
    const view = await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    expect(view.status).toBe("stale");
    await expectNoSnapshot(runner);
  });

  it("awaits private runtime directory cleanup on normal, timeout, abort, and close paths", {
    timeout: 30_000,
  }, async () => {
    const root = await projectRoot();
    const runtimeTmpRoot = await mkdtemp(join(tmpdir(), "poietra-runtime-cleanup-test-"));
    temporaryRoots.push(runtimeTmpRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeTmpRoot;
    try {
      // Normal: cleanup completes before run() resolves, not fire-and-forget.
      const runner = createRunner(root, producerCommand());
      expect((await runner.run(runRequest())).status).toBe("verified");
      expect(await readdir(runtimeTmpRoot)).toEqual([]);
      // Timeout.
      const hung = createRunner(root, producerCommand("--mode=hang"), { timeoutMs: 500 });
      expectFailure(await hung.run(runRequest({ requestId: "snapshot-request-2" })), "producer-timeout");
      expect(await readdir(runtimeTmpRoot)).toEqual([]);
      // Abort.
      const abortController = new AbortController();
      const abortGate = await producerGate(root, "cleanup-abort");
      const slow = createRunner(root, producerCommand(...abortGate.arguments));
      const aborted = slow.run(runRequest({ requestId: "snapshot-request-3" }), abortController.signal);
      await abortGate.ready;
      abortController.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      expect(await readdir(runtimeTmpRoot)).toEqual([]);
      // Close: close() itself must not resolve before the deletion completed.
      const closeGate = await producerGate(root, "cleanup-close");
      const closing = createRunner(root, producerCommand(...closeGate.arguments));
      const closingRun = closing.run(runRequest({ requestId: "snapshot-request-4" }));
      await closeGate.ready;
      await closing.close();
      await expect(closingRun).rejects.toMatchObject({ name: "AbortError" });
      expect(await readdir(runtimeTmpRoot)).toEqual([]);
    } finally {
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  });

  it("surfaces sanitized runtime-directory cleanup failures from both run and close", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const admissionController = new FastManimSnapshotAdmissionController();
    const publicationStore = new FastManimSnapshotPublicationStore();
    let runtimeDir = "";
    let removalCount = 0;
    let rejectionPropertyReads = 0;
    const runner = createRunner(await projectRoot(), producerCommand(), {
      admissionController,
      logger,
      publicationStore,
      runtimeDirectoryRemover: async (path) => {
        runtimeDir = path;
        await rm(path, { force: true, recursive: true });
        removalCount += 1;
        if (removalCount === 1) return;
        throw Object.defineProperties(
          {},
          {
            code: {
              get() {
                rejectionPropertyReads += 1;
                throw new Error(`secret cleanup code: ${path}`);
              },
            },
            name: {
              get() {
                rejectionPropertyReads += 1;
                throw new Error(`secret cleanup name: ${path}`);
              },
            },
          },
        );
      },
    });
    const expected = { message: "The Scene snapshot runtime directory could not be cleaned up.", status: 500 };
    expect((await runner.run(runRequest())).status).toBe("verified");
    expect(publicationStore.entriesOf(1).map(([, entry]) => entry.revision)).toEqual([1]);
    await expect(runner.run(runRequest({ requestId: "snapshot-request-2" }))).rejects.toMatchObject(expected);
    // The cleanup-failing run never publishes over the prior verified entry.
    expect(publicationStore.entriesOf(1).map(([, entry]) => entry.revision)).toEqual([1]);
    await expect(runner.close()).rejects.toMatchObject(expected);
    expect(admissionController.activeCount).toBe(0);
    // close releases the prior entry even though it must also surface cleanup failure.
    expect(publicationStore.entriesOf(1)).toEqual([]);
    expect(runtimeDir).toContain("poietra-producer-");
    expect(rejectionPropertyReads).toBe(0);
    const serializedLogs = JSON.stringify(records);
    expect(serializedLogs).not.toContain(runtimeDir);
    expect(serializedLogs).toContain('"failure":"runtime-directory-removal-rejected"');
  });

  it.each([
    { shutdown: "close", failRead: true, targetRead: 1 },
    { shutdown: "close", failRead: false, targetRead: 2 },
    { shutdown: "abort", failRead: true, targetRead: 2 },
  ] as const)(
    "lets $shutdown win while verified read $targetRead is held",
    async ({ failRead, shutdown, targetRead }) => {
      const root = await projectRoot();
      let readCount = 0;
      let releaseHeldRead!: () => void;
      let reachedHeldRead!: () => void;
      const heldReadReached = new Promise<void>((resolve) => {
        reachedHeldRead = resolve;
      });
      const holdRead = new Promise<void>((resolve) => {
        releaseHeldRead = resolve;
      });
      const runner = createRunner(root, producerCommand(), {
        sourceReadHooks: {
          beforeOpen: async () => {
            readCount += 1;
            if (readCount !== targetRead) return;
            reachedHeldRead();
            await holdRead;
          },
        },
      });
      const controller = new AbortController();
      const running = runner.run(runRequest(), controller.signal);
      running.catch(() => undefined);
      await heldReadReached;
      const closing = shutdown === "close" ? runner.close() : null;
      if (shutdown === "abort") controller.abort();
      if (failRead) await rm(join(root, "scene.py"), { force: true });
      releaseHeldRead();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      if (closing) await closing;
      else await runner.close();
    },
  );

  it("lets close win when stored-snapshot re-verification rejects", async () => {
    const store = new FastManimSnapshotPublicationStore();
    const runner = createRunner(await projectRoot(), producerCommand(), { publicationStore: store });
    expect((await runner.run(runRequest())).status).toBe("verified");
    const entry = store.entriesOf(1)[0]?.[1];
    if (!entry) throw new Error("Expected the first runner owner to have a publication.");
    (entry.result as { snapshotHash: string }).snapshotHash = ZERO_SHA256;
    const lookup = runner.snapshot(exampleQuery);
    lookup.catch(() => undefined);
    const closing = runner.close();
    await expect(lookup).rejects.toMatchObject({ status: 503 });
    await closing;
  });

  it("bounds the wait from leader exit and never signals the group after resolution", {
    timeout: 30_000,
  }, async () => {
    const root = await projectRoot();
    const orphanPidFile = join(root, "orphan-quiet.pid");
    const signals: Array<readonly [number, string]> = [];
    // The leader exits immediately, leaving a quiet same-group descendant on
    // the pipes; the run deadline is far away, so settlement must come from
    // the bounded pipe-close grace. After the leader exited the server sends
    // NO signal to the negative PGID (it may be recycled) — the descendant is
    // the documented #80 residual, reaped by the test.
    const runner = createRunner(root, producerCommand("--mode=orphan-hang", `--orphan-pid-file=${orphanPidFile}`), {
      killProcessGroup: (pid, signalName) => {
        signals.push([pid, signalName]);
        process.kill(pid, signalName);
      },
      timeoutMs: 60_000,
    });
    const startedAt = Date.now();
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
    expect(Number.isInteger(orphanPid)).toBe(true);
    reapAfterTest(orphanPid);
    // The leader exited before any stop was requested, so no group signal was
    // ever sent, and none fires after the run resolved either.
    expect(signals).toEqual([]);
    await delay(TEST_PRODUCER_TIMER_SETTLE_MS);
    expect(signals).toEqual([]);
  });

  it("refuses to serve a lookup that raced close and awaits active lookups before owner release", async () => {
    const root = await projectRoot();
    let holdLookup: Promise<void> | null = null;
    let releaseLookup!: () => void;
    let reachLookup!: () => void;
    const lookupReached = new Promise<void>((resolve) => {
      reachLookup = resolve;
    });
    const runner = createRunner(root, producerCommand(), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (holdLookup) {
            reachLookup();
            await holdLookup;
          }
        },
      },
    });
    expect((await runner.run(runRequest())).status).toBe("verified");
    holdLookup = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    const lookup = runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    lookup.catch(() => undefined);
    await lookupReached;
    expect(runner.busy).toBe(true);
    let closeSettled = false;
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // close() waits for the held lookup instead of releasing the owner under it.
    expect(closeSettled).toBe(false);
    releaseLookup();
    // The revalidated lookup must refuse to return verified after close began.
    await expect(lookup).rejects.toMatchObject({ status: 503 });
    await closing;
    await expect(runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("surfaces 503 instead of stale when close races a lookup whose freshness read fails", async () => {
    const root = await projectRoot();
    const scenePath = join(root, "scene.py");
    let holdLookup: Promise<void> | null = null;
    let releaseLookup!: () => void;
    let reachLookup!: () => void;
    const lookupReached = new Promise<void>((resolve) => {
      reachLookup = resolve;
    });
    // The freshness read is paused mid-flight; while it is held, close()
    // begins and the source is swapped so the read will fail. On release the
    // lookup must observe shutdown and fail 503, not unpublish + return stale.
    const runner = createRunner(root, producerCommand(), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (holdLookup) {
            const gate = holdLookup;
            holdLookup = null;
            reachLookup();
            await gate;
          }
        },
      },
    });
    expect((await runner.run(runRequest())).status).toBe("verified");
    holdLookup = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    const lookup = runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    lookup.catch(() => undefined);
    await lookupReached;
    const closing = runner.close();
    // Make the held freshness read fail: swap the source to a FIFO so
    // readVerified rejects and the lookup would otherwise reach staleView.
    await rm(scenePath, { force: true });
    await mkfifo(scenePath);
    releaseLookup();
    await expect(lookup).rejects.toMatchObject({ status: 503 });
    await closing;
    // Publication accounting was released cleanly; a fresh runner on the same
    // shared store still admits and serves.
    await expect(runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("does not let a lookup holding an old revision delete or serve it after a same-key republish", async () => {
    const root = await projectRoot();
    let holdFirstLookup: Promise<void> | null = null;
    let releaseFirstLookup!: () => void;
    let reachFirstLookup!: () => void;
    const firstLookupReached = new Promise<void>((resolve) => {
      reachFirstLookup = resolve;
    });
    // The freshness read of the first lookup is paused mid-flight; while it
    // holds revision 1, the source changes and revision 2 is published. On
    // release the lookup must neither delete the fresh entry nor return the
    // dead revision 1 — it retries and observes revision 2.
    const runner = createRunner(root, producerCommand(), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (holdFirstLookup) {
            const gate = holdFirstLookup;
            holdFirstLookup = null;
            reachFirstLookup();
            await gate;
          }
        },
      },
    });
    const first = await runner.run(runRequest());
    if (first.status !== "verified") throw new Error("Expected revision 1 to verify.");
    expect(first.revision).toBe(1);

    holdFirstLookup = new Promise((resolve) => {
      releaseFirstLookup = resolve;
    });
    const lookup = runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    lookup.catch(() => undefined);
    await firstLookupReached;
    // Change the source and republish revision 2 for the same key.
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# revision two\n`, "utf8");
    const second = await runner.run(runRequest({ requestId: "snapshot-request-2", sourcePath: "scene.py" }));
    if (second.status !== "verified") throw new Error("Expected revision 2 to verify.");
    expect(second.revision).toBe(2);

    releaseFirstLookup();
    const view = await lookup;
    // The stale revision 1 was never returned, and the fresh revision 2 was
    // not deleted by the retrying lookup.
    expect(view.status).toBe("verified");
    if (view.status !== "verified") throw new Error("Expected the fresh revision to survive.");
    expect(view.revision).toBe(2);
    expect((await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).status).toBe("verified");
  });

  it("normalizes compiled provenance evidence so producer free text never reaches the wire", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand("--mode=leak-compiled"));
    const view = await runner.run(runRequest());
    expect(view.status).toBe("verified");
    const wire = JSON.stringify(view);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain("compiled at");
    expect(wire).toContain(FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1);
  });

  it("normalizes unsupported diagnostics to server-owned bounded text", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand("--mode=leak-unsupported"));
    const view = await runner.run(runRequest());
    expect(view.status).toBe("unsupported");
    if (view.status !== "unsupported") throw new Error("Expected an unsupported snapshot run.");
    expect(view.fallback).toEqual({ kind: "server-authoritative-render" });
    expect(view.issues.map((issue) => issue.code)).toEqual([
      "geometry-evidence-incomplete",
      "runtime-semantics-unsupported",
    ]);
    for (const issue of view.issues) {
      expect(issue.evidence).toEqual([]);
      expect("runtimeObjectId" in issue).toBe(false);
    }
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("/home/builder");
    expect(wire).not.toContain("Users\\\\builder");
    expect(wire).not.toContain("class ExampleScene");
    await expectNoSnapshot(runner);
  });

  it("survives a change-and-restore ABA swap because the producer compiles the immutable request text", async () => {
    const root = await projectRoot();
    const gate = await producerGate(root, "aba-swap");
    const runner = createRunner(root, producerCommand(...gate.arguments));
    const running = runner.run(runRequest());
    await gate.ready;
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# swapped mid-run\n`, "utf8");
    await writeFile(join(root, "scene.py"), sceneSource, "utf8");
    await gate.release();
    const view = await running;
    expect(view.status).toBe("verified");
    if (view.status !== "verified") throw new Error("Expected the restored source to verify.");
    if (view.snapshot.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    expect(view.snapshot.sourceHash).toBe(sourceHash(sceneSource));
  });

  it("refuses to publish when the source changes during the run", async () => {
    const root = await projectRoot();
    const gate = await producerGate(root, "source-change");
    const runner = createRunner(root, producerCommand(...gate.arguments));
    const running = runner.run(runRequest());
    await gate.ready;
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# edited mid-run\n`, "utf8");
    await gate.release();
    expectFailure(await running, "source-changed");
    await expectNoSnapshot(runner);
  });

  it("unpublishes a snapshot the moment it is observed stale", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand());
    expect((await runner.run(runRequest())).status).toBe("verified");
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# edited later\n`, "utf8");
    const view = await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    expect(view.status).toBe("stale");
    if (view.status !== "stale") throw new Error("Expected a stale snapshot view.");
    expect(view.revision).toBe(1);
    expect(view.fallback).toEqual({ kind: "server-authoritative-render" });
    expect(JSON.stringify(view)).not.toContain("snapshotHash");
    await expectNoSnapshot(runner);
  });
});
