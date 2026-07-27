import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { sceneCapabilityV1Schema } from "../src/engine/contracts";
import {
  canonicalF64HexV1,
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  fastManimSnapshotProducerRequestV1Schema,
  type FastManimSnapshotRuntimeCapabilityV1,
  type FastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotRunViewV1,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
  FastManimSnapshotRunner,
  type ProducerGroupKill,
} from "./fast-manim-snapshot-runner";
import type { ProducerProcessTimings } from "./fast-manim-snapshot-producer-process";
import { createStructuredLogger, type StructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { handleManimRequest } from "./manim-render-http";
import { ManimRenderManager } from "./manim-render-manager";
import { ManimSourceStore, type ManimSourceReadHooks, sourceHash } from "./manim-source-store";

const fakeProducer = fileURLToPath(new URL("./test-fixtures/fake-fast-manim-producer.mjs", import.meta.url));
const fakeManim = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
const bundleFixture = fileURLToPath(new URL("./test-fixtures/fast-manim-static-bundle.json", import.meta.url));
const TEST_PRODUCER_PROCESS_TIMINGS = Object.freeze({
  closeGraceMs: 150,
  killGraceMs: 75,
}) satisfies ProducerProcessTimings;
const TEST_PRODUCER_TIMER_SETTLE_MS = 250;

const sceneSource = `from manim import *

class ExampleScene(Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.wait(1)
`;

const temporaryRoots: string[] = [];
const managers: ManimRenderManager[] = [];
const servers: Server[] = [];

afterEach(async () => {
  delete process.env.POIETRA_TEST_SENTINEL_SECRET;
  for (const pid of survivingOrphans.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function projectRoot() {
  const root = await mkdtemp(join(tmpdir(), "poietra-snapshot-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "scene.py"), sceneSource, "utf8");
  return root;
}

function producerCommand(...extra: string[]) {
  return ["node", fakeProducer, `--bundle=${bundleFixture}`, ...extra] as const;
}

function createRunner(
  root: string,
  command: readonly string[] | null,
  options: Readonly<{
    admissionController?: FastManimSnapshotAdmissionController;
    capabilities?: readonly FastManimSnapshotRuntimeCapabilityV1[];
    enabled?: boolean;
    killProcessGroup?: ProducerGroupKill;
    logger?: StructuredLogger;
    maxConcurrentRuns?: number;
    maxPublishedBytes?: number;
    maxPublishedSnapshots?: number;
    producerEnv?: Readonly<Record<string, string>>;
    producerProcessTimings?: Partial<ProducerProcessTimings>;
    publicationStore?: FastManimSnapshotPublicationStore;
    publishRetentionMs?: number;
    runtimeDirectoryRemover?: (runtimeDir: string) => Promise<void>;
    sourceReadHooks?: ManimSourceReadHooks;
    timeoutMs?: number;
  }> = {},
) {
  return new FastManimSnapshotRunner({
    // Tests isolate admission and publication state by default; shared-cap
    // and shared-budget tests inject one instance across runners explicitly.
    admissionController: new FastManimSnapshotAdmissionController(),
    command,
    enabled: true,
    frame: { height: 8, width: 14.222222222222221 },
    producerProcessTimings: options.producerProcessTimings ?? TEST_PRODUCER_PROCESS_TIMINGS,
    projectId: "default",
    projectRoot: root,
    publicationStore: new FastManimSnapshotPublicationStore(),
    ...options,
  });
}

function runRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    projectId: "default",
    requestId: "snapshot-request-1",
    sceneName: "ExampleScene",
    sourcePath: "scene.py",
    ...overrides,
  };
}

function expectFailure(view: FastManimSnapshotRunViewV1, code: string, contractCode?: string) {
  expect(view.status).toBe("failed");
  if (view.status !== "failed") throw new Error("Expected a failed snapshot run.");
  expect(view.failure.code).toBe(code);
  if (contractCode !== undefined) expect(view.failure.contractCode).toBe(contractCode);
  expect(view.fallback).toEqual({ kind: "server-authoritative-render" });
}

const exampleQuery = { sceneName: "ExampleScene", sourcePath: "scene.py" } as const;

/** Asserts the Scene has no published snapshot (GET returns 404). */
async function expectNoSnapshot(runner: FastManimSnapshotRunner, query = exampleQuery) {
  await expect(runner.snapshot(query)).rejects.toMatchObject({ status: 404 });
}

async function processGone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

const supportsVerifiedRead = ManimSourceStore.supportsVerifiedRead;

const mkfifo = async (path: string) => {
  await promisify(execFile)("mkfifo", [path]);
};

async function withFakePlatform<T>(platform: string, run: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("process.platform descriptor is missing.");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

async function leakedProducerDirs(before: readonly string[]) {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("poietra-producer-") && !before.includes(name));
}

// Best-effort reaper for the residual descendants (leader-exits-first pipe
// holders, setsid escapees) the server deliberately does NOT signal before
// #80: the test owns their cleanup so no fixture process leaks past the run.
const survivingOrphans: number[] = [];
function reapAfterTest(pid: number) {
  survivingOrphans.push(pid);
}

function runtimeConfig(): FastManimSnapshotRuntimeConfigV1 {
  return {
    capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1],
    frame: { height: 8, width: 14.222222222222221 },
    randomSeed: 0,
    schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
    snapshotVersion: 1,
    version: 1,
  };
}

describe("fast-manim snapshot runtime config", () => {
  it("keeps the runtime allowlist conservative instead of mirroring the schema universe", () => {
    expect([...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1]).toEqual([
      "cubic-path-geometry",
      "opacity-animation",
      "shape-primitives",
    ]);
    const universe = sceneCapabilityV1Schema.options;
    for (const capability of FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1) {
      expect(universe).toContain(capability);
    }
    expect(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1.length).toBeLessThan(universe.length);
    expect(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1).not.toContain("png-image");
  });

  it("encodes doubles as cross-runtime IEEE-754 bit patterns with pinned golden values", () => {
    expect(canonicalF64HexV1(1)).toBe("f64:3ff0000000000000");
    expect(canonicalF64HexV1(-0)).toBe("f64:8000000000000000");
    expect(canonicalF64HexV1(0)).toBe("f64:0000000000000000");
    expect(canonicalF64HexV1(5e-324)).toBe("f64:0000000000000001");
    expect(canonicalF64HexV1(1e-7)).toBe("f64:3e7ad7f29abcaf48");
    expect(canonicalF64HexV1(8)).toBe("f64:4020000000000000");
    expect(canonicalF64HexV1(14.222)).toBe("f64:402c71a9fbe76c8b");
    // The canonical snapshot frame width (128/9) producers normalize against.
    expect(canonicalF64HexV1(14.222222222222221)).toBe("f64:402c71c71c71c71c");
    expect(canonicalF64HexV1(1.7976931348623157e308)).toBe("f64:7fefffffffffffff");
    expect(() => canonicalF64HexV1(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
    expect(() => canonicalF64HexV1(Number.NaN)).toThrow(/finite/i);
  });

  it("digests the runtime capability surface deterministically", () => {
    const config = runtimeConfig();
    const digest = digestFastManimSnapshotRuntimeConfigV1(config);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestFastManimSnapshotRuntimeConfigV1(config)).toBe(digest);
    expect(
      digestFastManimSnapshotRuntimeConfigV1({
        ...config,
        capabilities: config.capabilities.filter((capability) => capability !== "opacity-animation"),
      }),
    ).not.toBe(digest);
    expect(
      digestFastManimSnapshotRuntimeConfigV1({ ...config, frame: { ...config.frame, width: 14.2220000001 } }),
    ).not.toBe(digest);
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...config,
        capabilities: [...config.capabilities].reverse(),
      }),
    ).toThrow(/sorted/i);
  });

  it("pins the canonical randomSeed to exactly 0 in the runtime config contract", () => {
    const config = runtimeConfig();
    expect(config.randomSeed).toBe(0);
    expect(digestFastManimSnapshotRuntimeConfigV1(config)).toMatch(/^[0-9a-f]{64}$/);
    // Any other seed — or omitting the field — is a schema violation, so the
    // digest can never silently cover a differently seeded run.
    const { randomSeed: _omitted, ...withoutSeed } = config;
    for (const drifted of [{ ...config, randomSeed: 1 }, { ...config, randomSeed: null }, withoutSeed]) {
      expect(() => digestFastManimSnapshotRuntimeConfigV1(drifted as FastManimSnapshotRuntimeConfigV1)).toThrow();
    }
  });

  it("binds the producer request to the runtime config, source text, and Scene identity it claims", () => {
    const config = runtimeConfig();
    const producerRequest = {
      projectId: "default",
      requestId: "snapshot-request-1",
      runtimeConfig: config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(config),
      sceneId: fastManimSnapshotSceneIdV1("scene.py", "ExampleScene"),
      sceneName: "ExampleScene",
      schema: "poietra.fast-manim-snapshot-producer-request",
      snapshotVersion: 1,
      sourceHash: sourceHash(sceneSource),
      sourcePath: "scene.py",
      sourceText: sceneSource,
      version: 1,
    };
    expect(producerRequest.sceneId).toMatch(/^scene:[0-9a-f]{64}$/);
    expect(fastManimSnapshotSceneIdV1("scene.py", "OtherScene")).not.toBe(producerRequest.sceneId);
    expect(fastManimSnapshotProducerRequestV1Schema.parse(producerRequest)).toEqual(producerRequest);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({ ...producerRequest, runtimeConfigHash: "b".repeat(64) }),
    ).toThrow(/canonical digest/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        runtimeConfig: { ...config, capabilities: config.capabilities.slice(1) },
      }),
    ).toThrow(/canonical digest/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        sourceText: `${sceneSource}\n# tampered\n`,
      }),
    ).toThrow(/source hash/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        sceneId: fastManimSnapshotSceneIdV1("scene.py", "OtherScene"),
      }),
    ).toThrow(/canonical derivation/i);
  });
});

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
    const before = await readdir(tmpdir());
    const root = await projectRoot();
    // Normal: cleanup completes before run() resolves, not fire-and-forget.
    const runner = createRunner(root, producerCommand());
    expect((await runner.run(runRequest())).status).toBe("verified");
    expect(await leakedProducerDirs(before)).toEqual([]);
    // Timeout.
    const hung = createRunner(root, producerCommand("--mode=hang"), { timeoutMs: 500 });
    expectFailure(await hung.run(runRequest({ requestId: "snapshot-request-2" })), "producer-timeout");
    expect(await leakedProducerDirs(before)).toEqual([]);
    // Abort.
    const abortController = new AbortController();
    const slow = createRunner(root, producerCommand("--delay-ms=5000"));
    const aborted = slow.run(runRequest({ requestId: "snapshot-request-3" }), abortController.signal);
    await delay(150);
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(await leakedProducerDirs(before)).toEqual([]);
    // Close: close() itself must not resolve before the deletion completed.
    const closing = createRunner(root, producerCommand("--delay-ms=5000"));
    const closingRun = closing.run(runRequest({ requestId: "snapshot-request-4" }));
    await delay(150);
    await closing.close();
    await expect(closingRun).rejects.toMatchObject({ name: "AbortError" });
    expect(await leakedProducerDirs(before)).toEqual([]);
  });

  it("surfaces sanitized runtime-directory cleanup failures from both run and close", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const admissionController = new FastManimSnapshotAdmissionController();
    const publicationStore = new FastManimSnapshotPublicationStore();
    let runtimeDir = "";
    let removalCount = 0;
    const runner = createRunner(await projectRoot(), producerCommand(), {
      admissionController,
      logger,
      publicationStore,
      runtimeDirectoryRemover: async (path) => {
        runtimeDir = path;
        await rm(path, { force: true, recursive: true });
        removalCount += 1;
        if (removalCount === 1) return;
        throw Object.assign(new Error(`private path: ${path}`), { code: "ECLEANUP" });
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
    const serializedLogs = JSON.stringify(records);
    expect(serializedLogs).not.toContain(runtimeDir);
    expect(serializedLogs).toContain('"code":"ECLEANUP"');
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
    const runner = createRunner(root, producerCommand(), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (holdLookup) await holdLookup;
        },
      },
    });
    expect((await runner.run(runRequest())).status).toBe("verified");
    holdLookup = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    const lookup = runner.snapshot({ sceneName: "ExampleScene", sourcePath: "scene.py" });
    lookup.catch(() => undefined);
    await delay(100);
    expect(runner.busy).toBe(true);
    let closeSettled = false;
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await delay(150);
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
    // The freshness read is paused mid-flight; while it is held, close()
    // begins and the source is swapped so the read will fail. On release the
    // lookup must observe shutdown and fail 503, not unpublish + return stale.
    const runner = createRunner(root, producerCommand(), {
      sourceReadHooks: {
        beforeOpen: async () => {
          if (holdLookup) {
            const gate = holdLookup;
            holdLookup = null;
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
    await delay(100);
    const closing = runner.close();
    await delay(50);
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
    await delay(100);
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
    const runner = createRunner(root, producerCommand("--delay-ms=800"));
    const running = runner.run(runRequest());
    await delay(150);
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# swapped mid-run\n`, "utf8");
    await delay(150);
    await writeFile(join(root, "scene.py"), sceneSource, "utf8");
    const view = await running;
    expect(view.status).toBe("verified");
    if (view.status !== "verified") throw new Error("Expected the restored source to verify.");
    if (view.snapshot.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    expect(view.snapshot.sourceHash).toBe(sourceHash(sceneSource));
  });

  it("refuses to publish when the source changes during the run", async () => {
    const root = await projectRoot();
    const runner = createRunner(root, producerCommand("--delay-ms=600"));
    const running = runner.run(runRequest());
    await delay(200);
    await writeFile(join(root, "scene.py"), `${sceneSource}\n# edited mid-run\n`, "utf8");
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
    const producerDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("poietra-producer-"));
    const dirsBefore = await producerDirs();
    const broken = createRunner(root, producerCommand(), {
      admissionController: controller,
      // A NUL byte in a server-controlled env value makes Node's spawn throw
      // synchronously before any child exists.
      producerEnv: { POIETRA_BROKEN: `nul${String.fromCharCode(0)}value` },
    });
    await expect(broken.run(runRequest())).rejects.toThrow();
    expect(controller.activeCount).toBe(0);
    const leakedDirs = (await producerDirs()).filter((name) => !dirsBefore.includes(name));
    expect(leakedDirs).toEqual([]);
    // The slot is free again: a subsequent run under the same controller is admitted.
    const good = createRunner(root, producerCommand(), { admissionController: controller });
    expect((await good.run(runRequest({ requestId: "snapshot-request-2" }))).status).toBe("verified");
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

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot endpoint", () => {
  async function startServer(manager: ManimRenderManager) {
    const server = createServer((request, response) => {
      void handleManimRequest(manager, request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves verified snapshots over HTTP and validates the wire envelope", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
      snapshotProducerCommand: producerCommand(),
      snapshotProducerEnabled: true,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const posted = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" },
      method: "POST",
    });
    expect(posted.status).toBe(200);
    const postedText = await posted.text();
    const postedView = fastManimSnapshotRunViewV1Schema.parse(JSON.parse(postedText));
    expect(postedView.status).toBe("verified");
    if (postedView.status !== "verified") throw new Error("Expected a verified endpoint response.");
    expect(postedView.revision).toBe(1);
    expect(postedText).not.toContain(root);
    expect(postedText).not.toContain("def construct");

    const fetched = await fetch(
      `${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py&sceneName=ExampleScene`,
    );
    expect(fetched.status).toBe(200);
    const fetchedView = fastManimSnapshotRunViewV1Schema.parse(await fetched.json());
    expect(fetchedView.status).toBe("verified");

    const missing = await fetch(
      `${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py&sceneName=OtherScene`,
    );
    expect(missing.status).toBe(404);

    const invalidQuery = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots?sourcePath=scene.py`);
    expect(invalidQuery.status).toBe(400);

    const mismatch = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest({ projectId: "other" })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(mismatch.status).toBe(409);

    const unknownProject = await fetch(`${baseUrl}/api/manim/projects/other/scene-snapshots`, {
      body: JSON.stringify(runRequest({ projectId: "other" })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unknownProject.status).toBe(404);
  });

  it("rejects cross-origin snapshot mutations before executing project Python", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
      snapshotProducerCommand: producerCommand(),
      snapshotProducerEnabled: true,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const endpoint = `${baseUrl}/api/manim/projects/default/scene-snapshots`;

    const crossSite = await fetch(endpoint, {
      body: JSON.stringify(runRequest()),
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toEqual({ error: "Cross-origin mutation requests are not allowed." });

    const foreignOrigin = await fetch(endpoint, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
    });
    expect(foreignOrigin.status).toBe(403);
    await expect(foreignOrigin.json()).resolves.toEqual({ error: "Mutation requests require a same-origin request." });

    await expect(
      manager.sceneSnapshot("default", { sceneName: "ExampleScene", sourcePath: "scene.py" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns a structured failure envelope over HTTP when the producer is not configured", async () => {
    const root = await projectRoot();
    const manager = new ManimRenderManager({
      command: ["node", fakeManim],
      frame: { height: 8, width: 14.222222222222221 },
      projectRoot: root,
    });
    managers.push(manager);
    const baseUrl = await startServer(manager);
    const posted = await fetch(`${baseUrl}/api/manim/projects/default/scene-snapshots`, {
      body: JSON.stringify(runRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(posted.status).toBe(200);
    const view = fastManimSnapshotRunViewV1Schema.parse(await posted.json());
    expectFailure(view, "producer-unconfigured");
  });
});
