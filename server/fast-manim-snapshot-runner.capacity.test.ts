import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
  type FastManimSnapshotRunner,
} from "./fast-manim-snapshot-runner";
import {
  createRunner,
  expectFailure,
  expectNoSnapshot,
  installFastManimSnapshotRunnerFixture,
  producerCommand,
  runRequest,
  sceneSource,
  supportsVerifiedRead,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot, temporaryRoots } = installFastManimSnapshotRunnerFixture();

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot runner", () => {
  it("bounds the published store by count and bytes with a globally monotonic revision sequence", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "other.py"), sceneSource, "utf8");
    const probeRunner = createRunner(root, producerCommand());
    const probe = await probeRunner.run(runRequest());
    if (probe.status !== "verified") throw new Error("Expected the probe run to verify.");
    const entryBytes = Buffer.byteLength(JSON.stringify(probe.snapshot), "utf8");

    const runner = createRunner(root, producerCommand(), {
      maxPublishedBytes: Math.floor(entryBytes * 1.5),
    });
    const first = await runner.run(runRequest());
    if (first.status !== "verified") throw new Error("Expected the first publish to verify.");
    expect(first.revision).toBe(1);
    const second = await runner.run(runRequest({ requestId: "snapshot-request-2", sourcePath: "other.py" }));
    if (second.status !== "verified") throw new Error("Expected the second publish to verify.");
    expect(second.revision).toBe(2);
    await expectNoSnapshot(runner);
    expect((await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "other.py" })).status).toBe("verified");
    const third = await runner.run(runRequest({ requestId: "snapshot-request-3" }));
    if (third.status !== "verified") throw new Error("Expected the republish to verify.");
    expect(third.revision).toBe(3);

    const oversized = createRunner(root, producerCommand(), { maxPublishedBytes: 1_024 });
    expectFailure(await oversized.run(runRequest({ requestId: "snapshot-request-4" })), "snapshot-too-large");
    await expectNoSnapshot(oversized);
  });

  it("enforces one process-wide publication entry ceiling across many runners and projects", async () => {
    const store = new FastManimSnapshotPublicationStore({ maxEntries: 3 });
    const runners: FastManimSnapshotRunner[] = [];
    for (let index = 0; index < 5; index += 1) {
      runners.push(createRunner(await projectRoot(), producerCommand(), { publicationStore: store }));
    }
    const revisions: number[] = [];
    for (const [index, runner] of runners.entries()) {
      const view = await runner.run(runRequest({ requestId: `snapshot-request-${index + 1}` }));
      if (view.status !== "verified") throw new Error(`Expected runner ${index} to verify.`);
      revisions.push(view.revision);
    }
    // Revisions are one store-global monotonic sequence across all tenants.
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    // Only the three most recent publications survive the shared ceiling, no
    // matter how many projects publish.
    for (const [index, runner] of runners.entries()) {
      const lookup = runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
      if (index < 2) await expect(lookup).rejects.toMatchObject({ status: 404 });
      else expect((await lookup).status).toBe("verified");
    }
  });

  it("enforces the global byte ceiling, rejects oversized items, and releases accounting on close", async () => {
    const probe = await createRunner(await projectRoot(), producerCommand()).run(runRequest());
    if (probe.status !== "verified") throw new Error("Expected the probe run to verify.");
    const entryBytes = Buffer.byteLength(JSON.stringify(probe.snapshot), "utf8");

    const store = new FastManimSnapshotPublicationStore({ maxBytes: Math.floor(entryBytes * 2.5) });
    const runnerA = createRunner(await projectRoot(), producerCommand(), { publicationStore: store });
    const runnerB = createRunner(await projectRoot(), producerCommand(), { publicationStore: store });
    const runnerC = createRunner(await projectRoot(), producerCommand(), { publicationStore: store });
    expect((await runnerA.run(runRequest())).status).toBe("verified");
    expect((await runnerB.run(runRequest({ requestId: "snapshot-request-2" }))).status).toBe("verified");
    expect((await runnerC.run(runRequest({ requestId: "snapshot-request-3" }))).status).toBe("verified");
    // Three entries exceed the shared byte ceiling, so the oldest tenant's
    // publication was deterministically evicted.
    await expectNoSnapshot(runnerA);
    expect((await runnerB.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).status).toBe("verified");

    // A single item above the global ceiling is rejected outright.
    const tinyStore = new FastManimSnapshotPublicationStore({ maxBytes: 1_024 });
    const tiny = createRunner(await projectRoot(), producerCommand(), { publicationStore: tinyStore });
    expectFailure(await tiny.run(runRequest({ requestId: "snapshot-request-4" })), "snapshot-too-large");

    // Closing runners returns their accounting: a new tenant fits again, and
    // the revision sequence continues without reuse.
    await runnerB.close();
    await runnerC.close();
    const runnerD = createRunner(await projectRoot(), producerCommand(), { publicationStore: store });
    const republished = await runnerD.run(runRequest({ requestId: "snapshot-request-5" }));
    if (republished.status !== "verified") throw new Error("Expected the post-close publish to verify.");
    expect(republished.revision).toBe(4);
    expect((await runnerD.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).status).toBe("verified");
  });

  it("expires published snapshots after the retention window without resetting revisions", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand(), { publishRetentionMs: 100 });
    const first = await runner.run(runRequest());
    if (first.status !== "verified") throw new Error("Expected the first publish to verify.");
    expect(first.revision).toBe(1);
    await delay(250);
    await expectNoSnapshot(runner);
    const second = await runner.run(runRequest({ requestId: "snapshot-request-2" }));
    if (second.status !== "verified") throw new Error("Expected the republish to verify.");
    expect(second.revision).toBe(2);
  });

  it("caps concurrent producers process-wide and returns capacity on finish, abort, and close", async () => {
    const controller = new FastManimSnapshotAdmissionController({ maxConcurrent: 1 });
    const rootA = await projectRoot();
    const rootB = await projectRoot();
    // Wide margins: under CI load the short waits below can fire late, so the
    // blocking producers sleep far longer than any expected scheduling jitter.
    const runnerA = createRunner(rootA, producerCommand("--delay-ms=2500"), { admissionController: controller });
    const blockedPid = join(rootB, "blocked.pid");
    const runnerB = createRunner(rootB, producerCommand(`--pid-file=${blockedPid}`), {
      admissionController: controller,
    });
    const running = runnerA.run(runRequest());
    await delay(150);
    expect(controller.activeCount).toBe(1);
    // Above the shared cap: deterministic server-owned 429 with no spawn.
    await expect(runnerB.run(runRequest({ requestId: "snapshot-request-2" }))).rejects.toMatchObject({ status: 429 });
    await expect(readFile(blockedPid, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await running).status).toBe("verified");
    expect(controller.activeCount).toBe(0);
    // Capacity returns after completion.
    expect((await runnerB.run(runRequest({ requestId: "snapshot-request-3" }))).status).toBe("verified");

    // Capacity returns after an abort…
    const abortController = new AbortController();
    const runnerC = createRunner(rootA, producerCommand("--delay-ms=5000"), { admissionController: controller });
    const aborted = runnerC.run(runRequest({ requestId: "snapshot-request-4" }), abortController.signal);
    await delay(150);
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.activeCount).toBe(0);

    // …and after close.
    const runnerD = createRunner(rootA, producerCommand("--delay-ms=5000"), { admissionController: controller });
    const closing = runnerD.run(runRequest({ requestId: "snapshot-request-5" }));
    await delay(150);
    await runnerD.close();
    await expect(closing).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.activeCount).toBe(0);
    expect((await runnerB.run(runRequest({ requestId: "snapshot-request-6" }))).status).toBe("verified");
  });

  it("releases the admission slot and runtime dir when spawn throws synchronously", async () => {
    const controller = new FastManimSnapshotAdmissionController({ maxConcurrent: 1 });
    const root = await projectRoot();
    const runtimeTmpRoot = await mkdtemp(join(tmpdir(), "poietra-runtime-spawn-test-"));
    temporaryRoots.push(runtimeTmpRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeTmpRoot;
    try {
      const broken = createRunner(root, producerCommand(), {
        admissionController: controller,
        // A NUL byte in a server-controlled env value makes Node's spawn throw
        // synchronously before any child exists.
        producerEnv: { POIETRA_BROKEN: `nul${String.fromCharCode(0)}value` },
      });
      await expect(broken.run(runRequest())).rejects.toThrow();
      expect(controller.activeCount).toBe(0);
      expect(await readdir(runtimeTmpRoot)).toEqual([]);
      // The slot is free again: a subsequent run under the same controller is admitted.
      const good = createRunner(root, producerCommand(), { admissionController: controller });
      expect((await good.run(runRequest({ requestId: "snapshot-request-2" }))).status).toBe("verified");
    } finally {
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  });

  it("fails closed before spawning when the source is rewritten in place during the verified read", async () => {
    const root = await projectRoot();
    const bigSource = `${sceneSource}# ${"pad".repeat(40_000)}\n`;
    await writeFile(join(root, "scene.py"), bigSource, "utf8");
    const pidFile = join(root, "torn.pid");
    let rewritten = false;
    const runner = createRunner(root, producerCommand(`--pid-file=${pidFile}`), {
      sourceReadHooks: {
        afterChunk: async (absolutePath, chunkIndex) => {
          if (chunkIndex !== 0 || rewritten) return;
          rewritten = true;
          // Same inode, same byte length; the changed byte sits inside the
          // already-consumed first chunk, so the assembled source is torn.
          const replacement = Buffer.from(bigSource, "utf8");
          replacement[100] = 0x21;
          await writeFile(absolutePath, replacement);
        },
      },
    });
    await expect(runner.run(runRequest())).rejects.toMatchObject({ status: 409 });
    expect(rewritten).toBe(true);
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes runs per Scene, caps concurrency, and reports busy state", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "other.py"), sceneSource, "utf8");
    const runner = createRunner(root, producerCommand("--delay-ms=800"), { maxConcurrentRuns: 1 });
    const running = runner.run(runRequest());
    await delay(100);
    expect(runner.busy).toBe(true);
    await expect(runner.run(runRequest({ requestId: "snapshot-request-2" }))).rejects.toMatchObject({ status: 409 });
    await expect(
      runner.run(runRequest({ requestId: "snapshot-request-3", sourcePath: "other.py" })),
    ).rejects.toMatchObject({ status: 429 });
    expect((await running).status).toBe("verified");
    expect(runner.busy).toBe(false);
  });

  it("aborts in-flight runs on close and never publishes after close", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand("--delay-ms=1500"));
    const running = runner.run(runRequest());
    await delay(200);
    await runner.close();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    // A closed runner refuses lookups outright instead of reporting 404.
    await expect(runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" })).rejects.toMatchObject({
      status: 503,
    });
  });
});
