import { describe, expect, it } from "vitest";

import { LocalProcessFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import type {
  FastManimSandboxBackendResultV1,
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxJobHandleV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { abortError } from "./fast-manim-snapshot-producer-process";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { ManimRenderManager } from "./manim-render-manager";
import {
  localSandboxReadyStatus,
  productionSandboxReadyStatus,
  SANDBOX_TEST_SHA_A,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";
import {
  createRunner,
  expectFailure,
  installFastManimSnapshotRunnerFixture,
  producerCommand,
  runRequest,
  sceneSource,
  TEST_PRODUCER_PROCESS_TIMINGS,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot } = installFastManimSnapshotRunnerFixture();

class RecordingBackend implements FastManimSandboxBackendV1 {
  contexts: FastManimSandboxJobContextV1[] = [];
  requests: FastManimSandboxRequestBundleV1[] = [];
  starts = 0;
  statusContexts: FastManimSandboxStatusContextV1[] = [];

  constructor(
    private readonly statuses: readonly unknown[],
    private readonly resultFactory: (
      request: FastManimSandboxRequestBundleV1,
      context: FastManimSandboxJobContextV1,
    ) => FastManimSandboxJobHandleV1,
  ) {}

  async close() {}

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    this.starts += 1;
    this.requests.push(request);
    this.contexts.push(context);
    return this.resultFactory(request, context);
  }

  async status(context: FastManimSandboxStatusContextV1) {
    this.statusContexts.push(context);
    return this.statuses[Math.min(this.starts, this.statuses.length - 1)];
  }
}

function failedHandle(
  request: FastManimSandboxRequestBundleV1,
  context: FastManimSandboxJobContextV1,
  overrides: Partial<Extract<FastManimSandboxBackendResultV1, { kind: "failed" }>> = {},
): FastManimSandboxJobHandleV1 {
  return {
    abort() {},
    result: Promise.resolve({
      attestationDigest: context.attestationDigest,
      code: "sandbox-execution-failed",
      kind: "failed",
      requestDigest: request.requestDigest,
      ...overrides,
    }),
  };
}

function blockEventLoop(durationMs: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, durationMs);
}

function nativePromiseWithThrowingOwnThen<T>(promise: Promise<T>, onRead: () => void): Promise<T> {
  // biome-ignore lint/suspicious/noThenProperty: adversarial contract test for a shadowed Promise method.
  Object.defineProperty(promise, "then", {
    get() {
      onRead();
      throw new Error("foreign own then getter must not be read");
    },
  });
  return promise;
}

function nonNativePromiseWithThrowingThen(onRead: () => void): Promise<never> {
  // biome-ignore lint/suspicious/noThenProperty: adversarial contract test for a non-native thenable.
  return Object.defineProperty({}, "then", {
    get() {
      onRead();
      throw new Error("foreign then getter must not be read");
    },
  }) as Promise<never>;
}

function nativePromiseFulfilledBeforeValueIsPoisoned<T extends object>(
  value: T,
  mode: "never-settling" | "throwing",
  onCall: () => void,
  onRead: () => void,
): Promise<T> {
  const fulfilled = Promise.resolve(value);
  // biome-ignore lint/suspicious/noThenProperty: regression for post-fulfillment thenable poisoning.
  Object.defineProperty(value, "then", {
    get() {
      onRead();
      if (mode === "throwing") throw new Error("foreign fulfillment then getter must not run");
      return () => {
        onCall();
      };
    },
  });
  return fulfilled;
}

describe("fast-manim sandbox runner boundary", () => {
  it("defaults an embedding with no deployment to production instead of accepting the local adapter", async () => {
    const root = await projectRoot();
    expect(
      () =>
        new ManimRenderManager({
          command: [process.execPath],
          frame: { height: 8, width: 14.222222222222221 },
          projectRoot: root,
          snapshotProducerCommand: [process.execPath],
          snapshotProducerDevOptIn: true,
        }),
    ).toThrow(/forbidden in production/i);
  });

  it("passes immutable bytes plus opaque lifecycle identity/deadline without host paths or environment", async () => {
    const root = await projectRoot();
    process.env.POIETRA_TEST_SENTINEL_SECRET = "sandbox-sentinel-secret";
    const backend = new RecordingBackend([localSandboxReadyStatus()], failedHandle);
    const runner = createRunner(root, null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");

    const bytes = Buffer.from(backend.requests[0]!.copyBytes()).toString("utf8");
    expect((JSON.parse(bytes) as { sourceText: string }).sourceText).toBe(sceneSource);
    expect(bytes).toContain('"sourcePath":"scene.py"');
    expect(bytes).not.toContain(root);
    expect(bytes).not.toContain("sandbox-sentinel-secret");
    expect(backend.contexts[0]?.identity).toEqual({
      projectId: "default",
      requestId: "snapshot-request-1",
      tenantId: "test-tenant",
    });
    expect(backend.contexts[0]!.deadlineEpochMs).toBeGreaterThan(Date.now());
    expect(backend.contexts[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(backend.statusContexts).toHaveLength(3);
    expect(backend.statusContexts[0]!.identity).toEqual(backend.contexts[0]!.identity);
    expect(backend.statusContexts.every((context) => context.deadlineEpochMs > 0)).toBe(true);
  });

  it("never starts an unverified backend in production", async () => {
    const backend = new RecordingBackend([localSandboxReadyStatus()], failedHandle);
    const runner = createRunner(await projectRoot(), null, { backend, deployment: "production" });
    expectFailure(await runner.run(runRequest()), "sandbox-attestation-rejected");
    expect(backend.starts).toBe(0);
  });

  it("rejects stale request correlation and attestation drift before parsing backend output", async () => {
    const staleResult = new RecordingBackend([productionSandboxReadyStatus()], (request, context) =>
      failedHandle(request, context, { requestDigest: "c".repeat(64) }),
    );
    const staleRunner = createRunner(await projectRoot(), null, {
      attestationVerifier: () => true,
      backend: staleResult,
      deployment: "production",
    });
    expectFailure(await staleRunner.run(runRequest()), "sandbox-result-rejected");

    const drift = new RecordingBackend(
      [productionSandboxReadyStatus(SANDBOX_TEST_SHA_A), productionSandboxReadyStatus("d".repeat(64))],
      failedHandle,
    );
    const driftRunner = createRunner(await projectRoot(), null, {
      attestationVerifier: () => true,
      backend: drift,
      deployment: "production",
    });
    expectFailure(await driftRunner.run(runRequest()), "sandbox-attestation-rejected");
  });

  it("rejects malformed backend result objects at the server boundary", async () => {
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => ({
      abort() {},
      result: Promise.resolve({
        kind: "ok",
        resultBytes: new Uint8Array(),
      }) as Promise<FastManimSandboxBackendResultV1>,
    }));
    const runner = createRunner(await projectRoot(), null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-result-rejected");
  });

  it("propagates caller abort and shutdown to the backend job handle", async () => {
    let started!: () => void;
    let aborts = 0;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => {
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<FastManimSandboxBackendResultV1>((_resolve, reject) => {
        rejectResult = reject;
      });
      started();
      return {
        abort() {
          aborts += 1;
          rejectResult(abortError());
        },
        result,
      };
    });
    const runner = createRunner(await projectRoot(), null, { backend });
    const controller = new AbortController();
    const running = runner.run(runRequest(), controller.signal);
    running.catch(() => undefined);
    await startedPromise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(aborts).toBe(1);

    let closeStarted!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const closingBackend = new RecordingBackend([localSandboxReadyStatus()], () => {
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<FastManimSandboxBackendResultV1>((_resolve, reject) => {
        rejectResult = reject;
      });
      closeStarted();
      return { abort: () => rejectResult(abortError()), result };
    });
    const closingRunner = createRunner(await projectRoot(), null, { backend: closingBackend });
    const closingRun = closingRunner.run(runRequest({ requestId: "snapshot-request-2" }));
    closingRun.catch(() => undefined);
    await closeStartedPromise;
    await closingRunner.close();
    await expect(closingRun).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds and quarantines a status operation that never settles", async () => {
    let starts = 0;
    let statusAborted = false;
    const backend: FastManimSandboxBackendV1 = {
      async close() {},
      start() {
        starts += 1;
        throw new Error("must not start");
      },
      status(context) {
        context.signal.addEventListener("abort", () => {
          statusAborted = true;
        });
        return new Promise<never>(() => undefined);
      },
    };
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    const startedAt = Date.now();
    expectFailure(await runner.run(runRequest()), "sandbox-unavailable");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(statusAborted).toBe(true);
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "sandbox-unavailable");
    expect(starts).toBe(0);
    await expect(runner.close()).rejects.toMatchObject({ status: 500 });
  });

  it.each(["resolve", "reject"] as const)(
    "rejects a status operation that can only %s after its deadline",
    async (outcome) => {
      let starts = 0;
      let statusAborts = 0;
      const backend: FastManimSandboxBackendV1 = {
        async close() {},
        start() {
          starts += 1;
          throw new Error("must not start");
        },
        status(context) {
          return new Promise((resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                statusAborts += 1;
                if (outcome === "resolve") resolve(localSandboxReadyStatus());
                else reject(new Error("late status failure"));
              },
              { once: true },
            );
          });
        },
      };
      const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
      expectFailure(await runner.run(runRequest()), "sandbox-unavailable");
      expect(statusAborts).toBe(1);
      expect(starts).toBe(0);
      await expect(runner.close()).resolves.toBeUndefined();
    },
  );

  it("bounds a never-settling job at its deadline and rejects new work on the quarantined backend", async () => {
    let aborts = 0;
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => ({
      abort: () => {
        aborts += 1;
      },
      result: new Promise<never>(() => undefined),
    }));
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    const startedAt = Date.now();
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(aborts).toBe(1);
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "sandbox-unavailable");
    expect(backend.starts).toBe(1);
    await expect(runner.close()).rejects.toMatchObject({ status: 500 });
  });

  it.each(["ok", "failed"] as const)("rejects a %s job result delivered only after its deadline", async (outcome) => {
    let deadlineAborts = 0;
    const backend = new RecordingBackend([localSandboxReadyStatus()], (request, context) => ({
      abort() {},
      result: new Promise<FastManimSandboxBackendResultV1>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            deadlineAborts += 1;
            resolve(
              outcome === "ok"
                ? {
                    attestationDigest: context.attestationDigest,
                    kind: "ok",
                    requestDigest: request.requestDigest,
                    resultBytes: new Uint8Array(),
                  }
                : {
                    attestationDigest: context.attestationDigest,
                    code: "sandbox-execution-failed",
                    kind: "failed",
                    requestDigest: request.requestDigest,
                  },
            );
          },
          { once: true },
        );
      }),
    }));
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    expectFailure(await runner.run(runRequest()), "producer-timeout");
    expect(deadlineAborts).toBe(1);
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)(
    "rechecks a monotonic status deadline after an event-loop block before accepting %s",
    async (outcome) => {
      let statusAborts = 0;
      let starts = 0;
      const backend: FastManimSandboxBackendV1 = {
        async close() {},
        start() {
          starts += 1;
          throw new Error("must not start");
        },
        status(context) {
          context.signal.addEventListener("abort", () => {
            statusAborts += 1;
          });
          blockEventLoop(40);
          return outcome === "resolve"
            ? Promise.resolve(localSandboxReadyStatus())
            : Promise.reject(new Error("late status rejection"));
        },
      };
      const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
      expectFailure(await runner.run(runRequest()), "sandbox-unavailable");
      expect(statusAborts).toBe(1);
      expect(starts).toBe(0);
      await expect(runner.close()).resolves.toBeUndefined();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "rechecks a monotonic job deadline after an event-loop block before accepting %s",
    async (outcome) => {
      let aborts = 0;
      const backend = new RecordingBackend([localSandboxReadyStatus()], (request, context) => {
        blockEventLoop(40);
        return {
          abort() {
            aborts += 1;
          },
          result:
            outcome === "resolve"
              ? Promise.resolve({
                  attestationDigest: context.attestationDigest,
                  code: "sandbox-execution-failed" as const,
                  kind: "failed" as const,
                  requestDigest: request.requestDigest,
                })
              : Promise.reject(new Error("late job rejection")),
        };
      });
      const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
      expectFailure(await runner.run(runRequest()), "producer-timeout");
      expect(aborts).toBe(1);
      expect(backend.starts).toBe(1);
      await expect(runner.close()).resolves.toBeUndefined();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "rechecks a monotonic close deadline after an event-loop block before accepting %s",
    async (outcome) => {
      const backend: FastManimSandboxBackendV1 = {
        close() {
          blockEventLoop(40);
          return outcome === "resolve" ? Promise.resolve() : Promise.reject(new Error("late close rejection"));
        },
        start() {
          throw new Error("must not start");
        },
        async status() {
          return localSandboxReadyStatus();
        },
      };
      const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
      await expect(runner.close()).rejects.toMatchObject({ status: 500 });
    },
  );

  it("gives caller abort priority over an elapsed job deadline and dispatches abort once", async () => {
    let aborts = 0;
    const controller = new AbortController();
    const backend = new RecordingBackend([localSandboxReadyStatus()], (request, context) => {
      blockEventLoop(40);
      controller.abort();
      return {
        abort() {
          aborts += 1;
        },
        result: Promise.resolve({
          attestationDigest: context.attestationDigest,
          code: "sandbox-execution-failed",
          kind: "failed",
          requestDigest: request.requestDigest,
        }),
      };
    });
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    await expect(runner.run(runRequest(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(aborts).toBe(1);
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it("bounds caller abort and close when a job and backend close both never settle", async () => {
    let started!: () => void;
    let aborts = 0;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => {
      started();
      return {
        abort: () => {
          aborts += 1;
        },
        result: new Promise<never>(() => undefined),
      };
    });
    backend.close = () => new Promise<never>(() => undefined);
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    const controller = new AbortController();
    const running = runner.run(runRequest(), controller.signal);
    running.catch(() => undefined);
    await startedPromise;
    const abortStartedAt = Date.now();
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - abortStartedAt).toBeLessThan(500);
    expect(aborts).toBe(1);

    const closeStartedAt = Date.now();
    await expect(runner.close()).rejects.toMatchObject({ status: 500 });
    expect(Date.now() - closeStartedAt).toBeLessThan(500);
  });

  it("observes native status, result, and close promises without reading poisoned own then getters", async () => {
    let ownThenReads = 0;
    const backend: FastManimSandboxBackendV1 & { starts: number } = {
      starts: 0,
      close() {
        return nativePromiseWithThrowingOwnThen(Promise.resolve(), () => {
          ownThenReads += 1;
        });
      },
      start(request, context) {
        this.starts += 1;
        return {
          abort() {},
          result: nativePromiseWithThrowingOwnThen(
            Promise.resolve({
              attestationDigest: context.attestationDigest,
              code: "sandbox-execution-failed",
              kind: "failed",
              requestDigest: request.requestDigest,
            }),
            () => {
              ownThenReads += 1;
            },
          ),
        };
      },
      status() {
        return nativePromiseWithThrowingOwnThen(Promise.resolve(localSandboxReadyStatus()), () => {
          ownThenReads += 1;
        });
      },
    };
    const runner = createRunner(await projectRoot(), null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");
    expect(runner.busy).toBe(false);
    expect(backend.starts).toBe(1);
    await expect(runner.close()).resolves.toBeUndefined();
    expect(ownThenReads).toBe(0);
  });

  it.each(["never-settling", "throwing"] as const)(
    "keeps %s thenable-poisoned fulfillment values boxed through status, result, and close",
    async (mode) => {
      let fulfillmentThenCalls = 0;
      let fulfillmentThenReads = 0;
      let starts = 0;
      const poison = <T extends object>(value: T) =>
        nativePromiseFulfilledBeforeValueIsPoisoned(
          value,
          mode,
          () => {
            fulfillmentThenCalls += 1;
          },
          () => {
            fulfillmentThenReads += 1;
          },
        );
      const backend: FastManimSandboxBackendV1 = {
        close() {
          return poison({}) as unknown as Promise<void>;
        },
        start(request, context) {
          starts += 1;
          return {
            abort() {},
            result: poison({
              attestationDigest: context.attestationDigest,
              code: "sandbox-execution-failed" as const,
              kind: "failed" as const,
              requestDigest: request.requestDigest,
            }),
          };
        },
        status() {
          return poison({ ...localSandboxReadyStatus() });
        },
      };
      const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 100 });
      const runStartedAt = Date.now();
      expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");
      expect(Date.now() - runStartedAt).toBeLessThan(1_000);
      expect({ busy: runner.busy, fulfillmentThenCalls, fulfillmentThenReads, starts }).toEqual({
        busy: false,
        fulfillmentThenCalls: 0,
        fulfillmentThenReads: 0,
        starts: 1,
      });
      const closeStartedAt = Date.now();
      await expect(runner.close()).resolves.toBeUndefined();
      expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
      expect({ fulfillmentThenCalls, fulfillmentThenReads }).toEqual({
        fulfillmentThenCalls: 0,
        fulfillmentThenReads: 0,
      });
    },
  );

  it("terminally quarantines a non-native status promise without reading its then getter", async () => {
    let starts = 0;
    let statusCalls = 0;
    let thenReads = 0;
    const backend: FastManimSandboxBackendV1 = {
      async close() {},
      start() {
        starts += 1;
        throw new Error("must not start");
      },
      status() {
        statusCalls += 1;
        return nonNativePromiseWithThrowingThen(() => {
          thenReads += 1;
        });
      },
    };
    const runner = createRunner(await projectRoot(), null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-unavailable");
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "sandbox-unavailable");
    expect({ busy: runner.busy, starts, statusCalls, thenReads }).toEqual({
      busy: false,
      starts: 0,
      statusCalls: 1,
      thenReads: 0,
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it("terminally quarantines a non-native result promise and captures handle getters once", async () => {
    let abortReads = 0;
    let aborts = 0;
    let resultReads = 0;
    let thenReads = 0;
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => {
      const handle = {};
      Object.defineProperties(handle, {
        abort: {
          get() {
            abortReads += 1;
            return () => {
              aborts += 1;
            };
          },
        },
        result: {
          get() {
            resultReads += 1;
            return nonNativePromiseWithThrowingThen(() => {
              thenReads += 1;
            });
          },
        },
      });
      return handle as FastManimSandboxJobHandleV1;
    });
    const runner = createRunner(await projectRoot(), null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-result-rejected");
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "sandbox-unavailable");
    expect({ abortReads, aborts, busy: runner.busy, resultReads, starts: backend.starts, thenReads }).toEqual({
      abortReads: 1,
      aborts: 1,
      busy: false,
      resultReads: 1,
      starts: 1,
      thenReads: 0,
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it("bounds and rejects a non-native close promise without reading its then getter", async () => {
    let thenReads = 0;
    const backend: FastManimSandboxBackendV1 = {
      close() {
        return nonNativePromiseWithThrowingThen(() => {
          thenReads += 1;
        });
      },
      start() {
        throw new Error("must not start");
      },
      async status() {
        return localSandboxReadyStatus();
      },
    };
    const runner = createRunner(await projectRoot(), null, { backend, timeoutMs: 25 });
    const startedAt = Date.now();
    await expect(runner.close()).rejects.toMatchObject({ status: 500 });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(thenReads).toBe(0);
  });

  it("aborts an invalid handle exactly once when its result getter throws", async () => {
    let abortReads = 0;
    let aborts = 0;
    let resultReads = 0;
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => {
      const handle = {};
      Object.defineProperties(handle, {
        abort: {
          get() {
            abortReads += 1;
            return () => {
              aborts += 1;
            };
          },
        },
        result: {
          get() {
            resultReads += 1;
            throw new Error("secret result getter failure");
          },
        },
      });
      return handle as FastManimSandboxJobHandleV1;
    });
    const runner = createRunner(await projectRoot(), null, { backend });
    expectFailure(await runner.run(runRequest()), "sandbox-result-rejected");
    expectFailure(await runner.run(runRequest({ requestId: "snapshot-request-2" })), "sandbox-unavailable");
    expect({ abortReads, aborts, busy: runner.busy, resultReads, starts: backend.starts }).toEqual({
      abortReads: 1,
      aborts: 1,
      busy: false,
      resultReads: 1,
      starts: 1,
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it("copies accepted result bytes before an adapter can mutate its original buffer", async () => {
    const root = await projectRoot();
    const delegate = new LocalProcessFastManimSandboxBackendV1({
      command: producerCommand(),
      producerProcessTimings: TEST_PRODUCER_PROCESS_TIMINGS,
      projectRoot: root,
    });
    const captured = { backendBytes: null as Uint8Array | null };
    const backend: FastManimSandboxBackendV1 = {
      close: () => delegate.close(),
      start(request, context) {
        const handle = delegate.start(request, context);
        return {
          abort: handle.abort,
          result: handle.result.then((result) => {
            if (result.kind === "ok") captured.backendBytes = result.resultBytes;
            return result;
          }),
        };
      },
      status(context) {
        // Completion attestation runs after the result schema boundary. A
        // hostile adapter still owns this original view and mutates it here.
        captured.backendBytes?.fill(0);
        return delegate.status(context);
      },
    };
    const runner = createRunner(root, null, { backend });
    expect((await runner.run(runRequest())).status).toBe("verified");
    expect(captured.backendBytes).not.toBeNull();
    expect(captured.backendBytes?.every((byte) => byte === 0)).toBe(true);
    await runner.close();
  });

  it("logs only bounded server metadata when backend health throws sensitive details", async () => {
    const root = await projectRoot();
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const backend: FastManimSandboxBackendV1 = {
      async close() {},
      start() {
        throw new Error("must not start");
      },
      async status() {
        throw new Error(`${root}: ${sceneSource}`);
      },
    };
    const runner = createRunner(root, null, { backend, logger });
    const view = await runner.run(runRequest());
    expectFailure(view, "sandbox-unavailable");
    const serialized = JSON.stringify({ records, view });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("def construct");

    const executionRecords: StructuredLogRecord[] = [];
    const executionLogger = createStructuredLogger({
      sinks: [{ write: (record) => executionRecords.push(record) }],
    });
    const executionBackend = new RecordingBackend([localSandboxReadyStatus()], () => ({
      abort() {},
      result: Promise.reject(new Error(`${root}: ${sceneSource}`)),
    }));
    const executionRunner = createRunner(root, null, { backend: executionBackend, logger: executionLogger });
    expectFailure(await executionRunner.run(runRequest()), "sandbox-execution-failed");
    const executionLogs = JSON.stringify(executionRecords);
    expect(executionLogs).not.toContain(root);
    expect(executionLogs).not.toContain("def construct");
  });

  it("never inspects or logs hostile backend rejection properties or prototypes", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    let getPrototypeOfCalls = 0;
    let rejectionPropertyReads = 0;
    const proxyReason = new Proxy(
      {},
      {
        getPrototypeOf() {
          getPrototypeOfCalls += 1;
          throw new Error("secret prototype trap");
        },
      },
    );
    const throwingProperties = Object.defineProperties(
      {},
      {
        code: {
          get() {
            rejectionPropertyReads += 1;
            throw new Error("secret code getter");
          },
        },
        name: {
          get() {
            rejectionPropertyReads += 1;
            throw new Error("secret name getter");
          },
        },
      },
    );
    const oversizedProperties = Object.assign(Object.create(null) as Record<string, string>, {
      code: `secret-code-${"c".repeat(100_000)}`,
      name: `secret-name-${"n".repeat(100_000)}`,
    });
    const reasons: unknown[] = [proxyReason, throwingProperties, oversizedProperties];
    let rejectionIndex = 0;
    const backend = new RecordingBackend([localSandboxReadyStatus()], () => ({
      abort() {},
      result: Promise.reject(reasons[rejectionIndex++]),
    }));
    const runner = createRunner(await projectRoot(), null, { backend, logger });
    const views = [];
    for (let index = 0; index < reasons.length; index += 1) {
      const view = await runner.run(runRequest({ requestId: `hostile-rejection-${index}` }));
      expectFailure(view, "sandbox-execution-failed");
      views.push(view);
    }
    const serialized = JSON.stringify({ records, views });
    expect(getPrototypeOfCalls).toBe(0);
    expect(rejectionPropertyReads).toBe(0);
    expect(serialized).not.toContain("secret-");
    expect(serialized.length).toBeLessThan(20_000);
    expect(records.filter((record) => record.event === "snapshot.sandbox_execution_failed")).toHaveLength(3);
    await runner.close();
  });
});
