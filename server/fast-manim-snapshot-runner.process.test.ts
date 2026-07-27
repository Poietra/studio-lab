import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import {
  createRunner,
  expectFailure,
  expectNoSnapshot,
  installFastManimSnapshotRunnerFixture,
  processGone,
  producerCommand,
  runRequest,
  runtimeConfig,
  supportsVerifiedRead,
  TEST_PRODUCER_PROCESS_TIMINGS,
  TEST_PRODUCER_TIMER_SETTLE_MS,
  withFakePlatform,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot, reapAfterTest } = installFastManimSnapshotRunnerFixture();

describe("fast-manim snapshot runner portability", () => {
  it("fails closed when no producer is configured or the dev opt-in is missing", async () => {
    const root = await projectRoot();
    expectFailure(await createRunner(root, null).run(runRequest()), "producer-unconfigured");
    // A configured command without the explicit dev opt-in stays fail-closed
    // until OS/network sandboxing (#80) lands.
    const pidFile = join(root, "opt-out.pid");
    const gated = createRunner(root, producerCommand(`--pid-file=${pidFile}`), { enabled: false });
    expectFailure(await gated.run(runRequest()), "producer-unconfigured");
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed with 501 before any Python runs on platforms without verified reads", async () => {
    // Non-Linux is a deliberate 501: verified descriptor containment needs
    // procfs, so an enabled producer must still never spawn there.
    const root = await projectRoot();
    const pidFile = join(root, "unsupported-platform.pid");
    const runner = createRunner(root, producerCommand(`--pid-file=${pidFile}`));
    await withFakePlatform("darwin", async () => {
      await expect(runner.run(runRequest())).rejects.toMatchObject({ status: 501 });
    });
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await runner.close();
  });
});

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot runner", () => {
  it("runs the producer, seals the normalized snapshot server-side, and publishes revisions", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand());
    const first = await runner.run(runRequest());
    expect(first.status).toBe("verified");
    if (first.status !== "verified") throw new Error("Expected a verified snapshot run.");
    expect(first.revision).toBe(1);
    if (first.snapshot.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    expect(first.snapshot.snapshotHash).not.toBe(ZERO_SHA256);
    const sceneId = fastManimSnapshotSceneIdV1("scene.py", "ExampleScene");
    expect(first.snapshot.sceneId).toBe(sceneId);
    // The published hash covers the pinned randomSeed, and the fake producer
    // (like the real CLI) refuses any run without randomSeed 0 and
    // PYTHONHASHSEED=0 — a verified run proves the determinism contract held.
    expect(first.runtimeConfigHash).toBe(digestFastManimSnapshotRuntimeConfigV1(runtimeConfig()));
    const bundle = first.snapshot.bundle as {
      assets: { manifestId: string };
      scene: {
        entities: readonly { id: string }[];
        provenance: readonly { evidence: readonly string[]; id: string; origin: string }[];
        source: { snapshotHash?: string };
      };
    };
    expect(bundle.scene.source.snapshotHash).toBe(first.snapshot.snapshotHash);
    expect(bundle.assets.manifestId).toBe(`${sceneId}/manifest`);
    for (const [index, entity] of bundle.scene.entities.entries()) {
      expect(entity.id).toBe(`${sceneId}/entity:${index}`);
    }
    for (const record of bundle.scene.provenance) {
      expect(record.origin).toBe("fast-manim-server-snapshot");
      expect(record.evidence).toEqual([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1]);
    }

    const wire = JSON.stringify(fastManimSnapshotRunViewV1Schema.parse(first));
    expect(wire).not.toContain(root);
    expect(wire).not.toContain("def construct");

    const fetched = await runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    expect(fetched.status).toBe("verified");
    if (fetched.status !== "verified") throw new Error("Expected a verified published snapshot.");
    expect(fetched.revision).toBe(1);
    expect(fetched.snapshot).toEqual(first.snapshot);

    const second = await runner.run(runRequest({ requestId: "snapshot-request-2" }));
    expect(second.status).toBe("verified");
    if (second.status !== "verified") throw new Error("Expected a verified snapshot rerun.");
    expect(second.revision).toBe(2);
    if (second.snapshot.kind !== "compiled") throw new Error("Expected a compiled snapshot rerun.");
    expect(second.snapshot.snapshotHash).toBe(first.snapshot.snapshotHash);
  });

  it("rejects stale request source correlation before spawning", async () => {
    const runner = createRunner(await projectRoot(), producerCommand());
    expectFailure(await runner.run(runRequest({ sourceHash: "c".repeat(64) })), "source-correlation-stale");
  });

  it("never spawns a producer for an already-aborted request", async () => {
    const root = await projectRoot();
    const pidFile = join(root, "aborted.pid");
    const runner = createRunner(root, producerCommand(`--pid-file=${pidFile}`));
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run(runRequest(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills a hanging producer at the deadline and leaves no child process behind", async () => {
    const root = await projectRoot();
    const pidFile = join(root, "producer.pid");
    const runner = createRunner(root, producerCommand("--mode=hang", `--pid-file=${pidFile}`), { timeoutMs: 500 });
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await processGone(pid)).toBe(true);
  });

  it("does not treat parent exit as completion while a descendant holds the pipes", {
    timeout: 30_000,
  }, async () => {
    const root = await projectRoot();
    const orphanPidFile = join(root, "orphan.pid");
    // orphan-hang: the leader exits immediately, leaving a same-group
    // descendant holding the pipes. The run must not be reported as complete;
    // it settles via the bounded pipe-close grace as a timeout. Containing
    // that descendant is the documented #80 residual (the leader exited
    // first, so the server never blind-signals the negative PGID), so the
    // test owns its cleanup.
    const runner = createRunner(root, producerCommand("--mode=orphan-hang", `--orphan-pid-file=${orphanPidFile}`), {
      timeoutMs: 800,
    });
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    await expectNoSnapshot(runner);
    const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
    expect(Number.isInteger(orphanPid)).toBe(true);
    reapAfterTest(orphanPid);
  });

  it("reaps a same-group producer that ignores SIGTERM while the leader is still alive", {
    timeout: 30_000,
  }, async () => {
    const root = await projectRoot();
    const orphanPidFile = join(root, "orphan-parent-hang.pid");
    const pidFile = join(root, "leader.pid");
    // The leader ignores SIGTERM and hangs, so it is observably alive when the
    // SIGKILL lands on the whole group after the configured grace period: that
    // uncatchable signal reaps both the leader and its same-group descendant.
    const runner = createRunner(
      root,
      producerCommand("--mode=orphan-parent-hang", `--pid-file=${pidFile}`, `--orphan-pid-file=${orphanPidFile}`),
      { timeoutMs: 500 },
    );
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    const leaderPid = Number(await readFile(pidFile, "utf8"));
    const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
    expect(await processGone(leaderPid)).toBe(true);
    expect(await processGone(orphanPid)).toBe(true);
  });

  it("bounds descendant stdout written after the parent exits", { timeout: 30_000 }, async () => {
    const root = await projectRoot();
    const orphanPidFile = join(root, "orphan-flood.pid");
    // The leader exits after emitting the descendant, which then floods the
    // inherited stdout. The overflow guard stops accumulating and the run
    // settles via the pipe-close grace; the flooding descendant is the #80
    // residual, reaped by the test. Keep the production pipe-close grace for
    // this scheduling-sensitive case: the general 150ms test grace can expire
    // before the newly spawned descendant runs on a contended host.
    const runner = createRunner(root, producerCommand("--mode=orphan-flood", `--orphan-pid-file=${orphanPidFile}`), {
      producerProcessTimings: { killGraceMs: TEST_PRODUCER_PROCESS_TIMINGS.killGraceMs },
      timeoutMs: 5_000,
    });
    expectFailure(await runner.run(runRequest()), "producer-output-overflow");
    await expectNoSnapshot(runner);
    const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
    reapAfterTest(orphanPid);
  });

  it("leaves a setsid descendant as a documented default-off residual and never signals its escaped group", {
    timeout: 30_000,
  }, async () => {
    const root = await projectRoot();
    const orphanPidFile = join(root, "orphan-setsid.pid");
    const signals: Array<readonly [number, string]> = [];
    // A descendant that calls setsid() leaves the leader's group entirely.
    // The leader exits naturally with no stop request, so the server sends no
    // group signal at all — and it must never blind-signal the escaped,
    // unverifiable (possibly recycled) negative PGID afterward. Real
    // containment of the escapee needs the OS sandbox (#80); here it is a
    // documented default-off residual that the fixture self-expires and the
    // test best-effort reaps.
    const runner = createRunner(root, producerCommand("--mode=orphan-setsid", `--orphan-pid-file=${orphanPidFile}`), {
      killProcessGroup: (pid, signalName) => {
        signals.push([pid, signalName]);
        process.kill(pid, signalName);
      },
    });
    const view = await runner.run(runRequest());
    expect(view.status).toBe("verified");
    expect(signals).toEqual([]);
    await delay(TEST_PRODUCER_TIMER_SETTLE_MS);
    // No delayed escalation ever fires against the escaped group.
    expect(signals).toEqual([]);
    const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
    expect(Number.isInteger(orphanPid)).toBe(true);
    reapAfterTest(orphanPid);
  });

  it("sends no signal and schedules no delayed kill after a clean successful close", async () => {
    const root = await projectRoot();
    const signals: Array<readonly [number, string]> = [];
    const runner = createRunner(root, producerCommand(), {
      killProcessGroup: (pid, signalName) => {
        signals.push([pid, signalName]);
        process.kill(pid, signalName);
      },
    });
    const view = await runner.run(runRequest());
    expect(view.status).toBe("verified");
    await delay(TEST_PRODUCER_TIMER_SETTLE_MS);
    expect(signals).toEqual([]);
  });

  it("bounds raw producer stdout before any parsing", async () => {
    const runner = createRunner(await projectRoot(), producerCommand("--mode=huge"));
    expectFailure(await runner.run(runRequest()), "producer-output-overflow");
  });

  it("hard-caps cumulative producer stderr and stops the process group", async () => {
    const root = await projectRoot();
    const pidFile = join(root, "stderr-flood.pid");
    const runner = createRunner(root, producerCommand("--mode=stderr-flood", `--pid-file=${pidFile}`));
    expectFailure(await runner.run(runRequest()), "producer-output-overflow");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(await processGone(pid)).toBe(true);
  });

  it("never lets producer stderr bytes reach the structured logs or the HTTP result", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const runner = new FastManimSnapshotRunner({
      command: producerCommand("--mode=exit-2"),
      enabled: true,
      frame: { height: 8, width: 14.222222222222221 },
      logger,
      projectId: "default",
      projectRoot: await projectRoot(),
    });
    const view = await runner.run(runRequest());
    expectFailure(view, "producer-exit");
    // Serialize every log record and the returned envelope: producer stderr
    // (secrets, host paths, tracebacks) must appear in neither; the log keeps
    // only server-owned metadata about the diagnostics channel.
    const serializedLogs = JSON.stringify(records);
    for (const leak of ["never reach the browser", "leaked-workspace-secret-9f8e7d6c5b4a", "/home/builder"]) {
      expect(serializedLogs).not.toContain(leak);
      expect(JSON.stringify(view)).not.toContain(leak);
    }
    const exitRecord = records.find((record) => record.event === "snapshot.producer_exit");
    expect(exitRecord).toBeDefined();
    const exitData = exitRecord?.data as { stderrByteCount?: number; stderrSha256?: string | null };
    expect(exitData.stderrByteCount).toBeGreaterThan(0);
    expect(exitData.stderrSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an unstartable producer as a structured spawn failure", async () => {
    const runner = createRunner(await projectRoot(), ["/nonexistent/fast-manim-producer"]);
    expectFailure(await runner.run(runRequest()), "producer-spawn-failed");
  });

  it("passes only allowlisted environment with a private HOME, TMP, and working directory", async () => {
    const root = await projectRoot();
    const envFile = join(root, "producer-env.json");
    process.env.POIETRA_TEST_SENTINEL_SECRET = "sentinel-value-that-must-not-leak";
    const parentPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = "/opt/poietra-parent-pythonpath-sentinel";
    try {
      const runner = createRunner(root, producerCommand(`--env-probe=${envFile}`));
      const view = await runner.run(runRequest());
      expect(view.status).toBe("verified");
      const producerEnv = JSON.parse(await readFile(envFile, "utf8")) as {
        CWD: string;
        HOME: string | null;
        PATH: string | null;
        PYTHONHASHSEED: string | null;
        PYTHONPATH: string | null;
        SENTINEL: string | null;
        TMPDIR: string | null;
      };
      expect(producerEnv.SENTINEL).toBeNull();
      expect(producerEnv.PATH).toBeTruthy();
      expect(producerEnv.HOME).toContain("poietra-producer-");
      expect(producerEnv.HOME).not.toBe(homedir());
      expect(producerEnv.TMPDIR).toBe(producerEnv.HOME);
      // The producer runs from the private runtime directory, never the
      // project root, and no PYTHONPATH exists at all: only the immutable
      // request sourceText plus installed runtime modules are importable.
      expect(producerEnv.CWD).toBe(producerEnv.HOME);
      expect(producerEnv.CWD).not.toBe(root);
      expect(producerEnv.PYTHONPATH).toBeNull();
      // The deterministic hash seed pairing with runtimeConfig randomSeed: 0.
      expect(producerEnv.PYTHONHASHSEED).toBe("0");
    } finally {
      if (parentPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = parentPythonPath;
    }
  });

  it("refuses producerEnv values that reintroduce the project root", async () => {
    const root = await projectRoot();
    expect(() => createRunner(root, producerCommand(), { producerEnv: { PYTHONPATH: root } })).toThrow(/project root/i);
    expect(() =>
      createRunner(root, producerCommand(), {
        producerEnv: { PYTHONPATH: `/usr/lib/poietra-trusted:${join(root, "lib")}` },
      }),
    ).toThrow(/project root/i);
    // Trusted paths outside the root stay allowed for the real seam.
    expect(() =>
      createRunner(root, producerCommand(), { producerEnv: { PYTHONPATH: "/usr/lib/poietra-trusted" } }),
    ).not.toThrow();
    // The pinned deterministic hash seed cannot be overridden through
    // producerEnv either; restating the pinned value is tolerated.
    expect(() => createRunner(root, producerCommand(), { producerEnv: { PYTHONHASHSEED: "42" } })).toThrow(
      /PYTHONHASHSEED/,
    );
    expect(() => createRunner(root, producerCommand(), { producerEnv: { PYTHONHASHSEED: "0" } })).not.toThrow();
  });

  it("cannot reach project-local helper modules and helper edits can never flip a verified snapshot", async () => {
    const root = await projectRoot();
    // The selected source is unchanged throughout; only the helper mutates.
    await writeFile(join(root, "snapshot_helper.py"), "SHAPE = 'Circle'\n", "utf8");
    const runner = createRunner(root, producerCommand("--mode=import-helper"));
    expectFailure(await runner.run(runRequest()), "producer-exit");
    await expectNoSnapshot(runner);
    await writeFile(join(root, "snapshot_helper.py"), "SHAPE = 'Rectangle'\n", "utf8");
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "producer-exit");
    // No bundle derived from either helper revision was ever published under
    // the unchanged source hash.
    await expectNoSnapshot(runner);
  });

  it("rejects malformed, mis-correlated, and pre-sealed producer output", async () => {
    const root = await projectRoot();
    expectFailure(
      await createRunner(root, producerCommand("--mode=garbage")).run(runRequest()),
      "result-rejected",
      "result-malformed",
    );
    expectFailure(
      await createRunner(root, producerCommand("--mode=stale-correlation")).run(runRequest()),
      "result-rejected",
      "correlation-mismatch",
    );
    expectFailure(
      await createRunner(root, producerCommand("--mode=sealed")).run(runRequest()),
      "result-rejected",
      "snapshot-not-unsealed",
    );
  });

  it("rejects producers whose runtime config or source evidence drifts from the request", async () => {
    const root = await projectRoot();
    expectFailure(
      await createRunner(root, producerCommand("--mode=config-drift")).run(runRequest()),
      "result-rejected",
      "correlation-mismatch",
    );
    expectFailure(
      await createRunner(root, producerCommand("--mode=source-drift")).run(runRequest()),
      "result-rejected",
      "correlation-mismatch",
    );
  });

  it("refuses to publish compiled Scenes requiring capabilities outside the allowlist", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand(), { capabilities: ["shape-primitives"] });
    expectFailure(await runner.run(runRequest()), "capability-unsupported");
    await expectNoSnapshot(runner);
  });

  it("rejects schema-valid cubic constructions outside the proven static profile", async () => {
    const root = await projectRoot();
    for (const mode of ["multi-subpath", "non-convex", "open-stroked"]) {
      const runner = createRunner(root, producerCommand(`--mode=${mode}`));
      expectFailure(await runner.run(runRequest()), "result-rejected", "profile-violation");
      await expectNoSnapshot(runner);
    }
  });

  it("rejects producer identifiers outside the derived Scene namespace", async () => {
    const runner = createRunner(await projectRoot(), producerCommand("--mode=leak-id"));
    expectFailure(await runner.run(runRequest()), "result-rejected", "profile-violation");
  });

  it("rejects unreferenced namespaced provenance so producer suffixes cannot exfiltrate secrets", async () => {
    const runner = createRunner(await projectRoot(), producerCommand("--mode=exfil-provenance"));
    const view = await runner.run(runRequest());
    expectFailure(view, "result-rejected", "profile-violation");
    expect(JSON.stringify(view)).not.toContain("ghp_EXFILTRATED_SECRET");
    await expectNoSnapshot(runner);
  });
});
