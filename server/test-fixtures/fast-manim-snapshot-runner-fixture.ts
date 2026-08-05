import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect } from "vitest";
import { LocalProcessFastManimSandboxBackendV1 } from "../fast-manim-local-process-sandbox-backend";
import type {
  FastManimSandboxAttestationVerifierV1,
  FastManimSandboxBackendV1,
  FastManimSandboxDeployment,
} from "../fast-manim-sandbox-backend";
import {
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V11,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V12,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  type FastManimSnapshotProfileVersionV1,
  type FastManimSnapshotRuntimeCapabilityV1,
  type FastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotRunViewV1,
} from "../fast-manim-snapshot-contract";
import type { FastManimSnapshotPngProviderV1 } from "../fast-manim-snapshot-png-provider";
import type { ProducerGroupKill, ProducerProcessTimings } from "../fast-manim-snapshot-producer-process";
import {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
  FastManimSnapshotRunner,
} from "../fast-manim-snapshot-runner";
import type { StructuredLogger } from "../logging/structured-logger";
import type { ManimRenderManager } from "../manim-render-manager";
import { type ManimSourceReadHooks, ManimSourceStore } from "../manim-source-store";

export const fakeManim = fileURLToPath(new URL("./fake-manim.mjs", import.meta.url));
const fakeProducer = fileURLToPath(new URL("./fake-fast-manim-producer.mjs", import.meta.url));
const bundleFixture = fileURLToPath(new URL("./fast-manim-static-bundle.json", import.meta.url));

export const TEST_PRODUCER_PROCESS_TIMINGS = Object.freeze({
  closeGraceMs: 150,
  killGraceMs: 75,
}) satisfies ProducerProcessTimings;
export const TEST_PRODUCER_TIMER_SETTLE_MS = 250;

export const sceneSource = `from manim import *

class ExampleScene(Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.wait(1)
`;

export const supportsVerifiedRead = ManimSourceStore.supportsVerifiedRead;

export function installFastManimSnapshotRunnerFixture() {
  const temporaryRoots: string[] = [];
  const managers: ManimRenderManager[] = [];
  const servers: Server[] = [];

  // Best-effort reaper for the residual descendants (leader-exits-first pipe
  // holders, setsid escapees) the server deliberately does NOT signal before
  // #80: the test owns their cleanup so no fixture process leaks past the run.
  const survivingOrphans: number[] = [];

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

  function reapAfterTest(pid: number) {
    survivingOrphans.push(pid);
  }

  return { managers, projectRoot, reapAfterTest, servers, temporaryRoots };
}

export function producerCommand(...extra: string[]) {
  return ["node", fakeProducer, `--bundle=${bundleFixture}`, ...extra] as const;
}

export function createRunner(
  root: string,
  command: readonly string[] | null,
  options: Readonly<{
    admissionController?: FastManimSnapshotAdmissionController;
    automaticProfileSelection?: boolean;
    attestationVerifier?: FastManimSandboxAttestationVerifierV1;
    backend?: FastManimSandboxBackendV1;
    capabilities?: readonly FastManimSnapshotRuntimeCapabilityV1[];
    deployment?: FastManimSandboxDeployment;
    enabled?: boolean;
    killProcessGroup?: ProducerGroupKill;
    logger?: StructuredLogger;
    maxConcurrentRuns?: number;
    maxPublishedBytes?: number;
    maxPublishedSnapshots?: number;
    producerEnv?: Readonly<Record<string, string>>;
    producerProcessTimings?: Partial<ProducerProcessTimings>;
    pngProvider?: FastManimSnapshotPngProviderV1;
    publicationStore?: FastManimSnapshotPublicationStore;
    publishRetentionMs?: number;
    runtimeDirectoryRemover?: (runtimeDir: string) => Promise<void>;
    snapshotVersion?: FastManimSnapshotProfileVersionV1;
    sourceReadHooks?: ManimSourceReadHooks;
    timeoutMs?: number;
  }> = {},
) {
  const backend =
    options.backend ??
    (command && options.enabled !== false
      ? new LocalProcessFastManimSandboxBackendV1({
          admissionController: options.admissionController ?? new FastManimSnapshotAdmissionController(),
          command,
          killProcessGroup: options.killProcessGroup,
          logger: options.logger,
          producerEnv: options.producerEnv,
          producerProcessTimings: options.producerProcessTimings ?? TEST_PRODUCER_PROCESS_TIMINGS,
          projectRoot: root,
          runtimeDirectoryRemover: options.runtimeDirectoryRemover,
        })
      : undefined);
  return new FastManimSnapshotRunner({
    // Tests isolate admission and publication state by default; shared-cap
    // and shared-budget tests inject one instance across runners explicitly.
    attestationVerifier: options.attestationVerifier,
    backend,
    capabilities: options.capabilities,
    deployment: options.deployment ?? "test",
    frame: { height: 8, width: 14.222222222222221 },
    logger: options.logger,
    maxConcurrentRuns: options.maxConcurrentRuns,
    maxPublishedBytes: options.maxPublishedBytes,
    maxPublishedSnapshots: options.maxPublishedSnapshots,
    projectId: "default",
    projectRoot: root,
    pngProvider: options.pngProvider,
    publicationStore: options.publicationStore ?? new FastManimSnapshotPublicationStore(),
    publishRetentionMs: options.publishRetentionMs,
    sourceReadHooks: options.sourceReadHooks,
    // Existing runner unit tests exercise one concrete historical profile.
    // Opt in explicitly when a test targets the producer-owned selector.
    snapshotVersion: options.automaticProfileSelection ? undefined : (options.snapshotVersion ?? 1),
    tenantId: "test-tenant",
    timeoutMs: options.timeoutMs,
  });
}

export function runRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    projectId: "default",
    requestId: "snapshot-request-1",
    sceneName: "ExampleScene",
    sourcePath: "scene.py",
    ...overrides,
  };
}

export function expectFailure(view: FastManimSnapshotRunViewV1, code: string, contractCode?: string) {
  expect(view.status).toBe("failed");
  if (view.status !== "failed") throw new Error("Expected a failed snapshot run.");
  expect(view.failure.code).toBe(code);
  if (contractCode !== undefined) expect(view.failure.contractCode).toBe(contractCode);
  expect(view.fallback).toEqual({ kind: "server-authoritative-render" });
}

export const exampleQuery = { sceneName: "ExampleScene", sourcePath: "scene.py" } as const;

/** Asserts the Scene has no published snapshot (GET returns 404). */
export async function expectNoSnapshot(runner: FastManimSnapshotRunner, query = exampleQuery) {
  await expect(runner.snapshot(query)).rejects.toMatchObject({ status: 404 });
}

export async function processGone(pid: number) {
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

export const mkfifo = async (path: string) => {
  await promisify(execFile)("mkfifo", [path]);
};

const PRODUCER_GATE_TIMEOUT_MS = 3_000;
const PRODUCER_GATE_RELEASE_BACKSTOP_MS = 1_000;

type ProducerGateOutcome =
  | Readonly<{ kind: "operation-rejected"; reason: unknown }>
  | Readonly<{ kind: "operation-resolved" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "ready-rejected"; reason: unknown }>
  | Readonly<{ kind: "timeout" }>;

function producerGateTimeout(): Readonly<{ cancel: () => void; outcome: Promise<ProducerGateOutcome> }> {
  let timer: NodeJS.Timeout;
  const outcome = new Promise<ProducerGateOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), PRODUCER_GATE_TIMEOUT_MS);
    timer.unref();
  });
  return { cancel: () => clearTimeout(timer), outcome };
}

/**
 * Creates a pair of FIFOs that lets a subprocess test wait for the producer
 * to finish parsing its immutable request, then release it without sleeping.
 * Read/write anchors make both FIFO opens nonblocking; every wait is bounded
 * below Vitest's watchdog and closes those anchors on every settlement path.
 */
export async function producerGate(root: string, name: string) {
  const readyPath = join(root, `${name}.ready.fifo`);
  const releasePath = join(root, `${name}.release.fifo`);
  await Promise.all([mkfifo(readyPath), mkfifo(releasePath)]);
  const [readyHandle, releaseHandle] = await Promise.all([open(readyPath, "r+"), open(releasePath, "r+")]);
  const ready = readyHandle.read(Buffer.alloc(16), 0, 16, null);
  let releaseAction: Promise<void> | null = null;
  let releaseBackstop: NodeJS.Timeout | null = null;
  let releaseClosed = false;
  const closeRelease = async () => {
    if (releaseBackstop) clearTimeout(releaseBackstop);
    releaseBackstop = null;
    if (releaseClosed) return;
    releaseClosed = true;
    await releaseHandle.close();
  };
  return {
    arguments: [`--ready-fifo=${readyPath}`, `--release-fifo=${releasePath}`] as const,
    async waitFor(operation: Promise<unknown>) {
      const operationOutcome = operation.then<ProducerGateOutcome, ProducerGateOutcome>(
        () => ({ kind: "operation-resolved" }),
        (reason: unknown) => ({ kind: "operation-rejected", reason }),
      );
      const readyOutcome = ready.then<ProducerGateOutcome, ProducerGateOutcome>(
        () => ({ kind: "ready" }),
        (reason: unknown) => ({ kind: "ready-rejected", reason }),
      );
      const timeout = producerGateTimeout();
      const outcome = await Promise.race([readyOutcome, operationOutcome, timeout.outcome]);
      timeout.cancel();
      const closeAfterOperation = () => releaseAction ?? closeRelease();
      void operation.then(closeAfterOperation, closeAfterOperation).catch(() => undefined);
      if (outcome.kind === "ready") {
        await readyHandle.close();
        releaseBackstop = setTimeout(
          () => void closeRelease().catch(() => undefined),
          PRODUCER_GATE_RELEASE_BACKSTOP_MS,
        );
        releaseBackstop.unref();
        return;
      }

      // The r+ anchor guarantees this cleanup writer can open and unblocks the
      // pending read even when no producer ever reached its readiness write.
      await writeFile(readyPath, "cancel", "utf8");
      await Promise.allSettled([ready, readyHandle.close(), closeRelease()]);
      if (outcome.kind === "operation-rejected") throw outcome.reason;
      if (outcome.kind === "ready-rejected") throw outcome.reason;
      if (outcome.kind === "operation-resolved") {
        throw new Error(`Producer operation settled before the ${name} readiness gate.`);
      }
      throw new Error(`Producer readiness gate ${name} timed out after ${PRODUCER_GATE_TIMEOUT_MS}ms.`);
    },
    async release() {
      if (!releaseAction) {
        releaseAction = (async () => {
          if (releaseBackstop) clearTimeout(releaseBackstop);
          releaseBackstop = null;
          if (releaseClosed) return;
          try {
            await releaseHandle.write("continue");
          } finally {
            await closeRelease();
          }
        })();
      }
      await releaseAction;
    },
  };
}

export async function withFakePlatform<T>(platform: string, run: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("process.platform descriptor is missing.");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

export function runtimeConfig(
  snapshotVersion: FastManimSnapshotProfileVersionV1 = 1,
): FastManimSnapshotRuntimeConfigV1 {
  return {
    capabilities:
      snapshotVersion === 4
        ? ["png-image"]
        : snapshotVersion === 9
          ? [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9]
          : snapshotVersion === 10
            ? [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10]
            : snapshotVersion === 11
              ? [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V11]
              : snapshotVersion === 12
                ? [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V12]
                : [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1],
    frame: { height: 8, width: 14.222222222222221 },
    randomSeed: 0,
    schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
    snapshotVersion,
    version: 1,
  };
}
