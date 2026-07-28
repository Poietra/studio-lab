import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FastManimSandboxBackendResultV1,
  FastManimSandboxBackendStatusV1,
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { FastManimSandboxRequestBundleV1 as RequestBundle } from "./fast-manim-sandbox-backend";
import {
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  type FastManimSandboxBrokerClientMessageV1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  type FastManimSandboxBrokerServerOptionsV1,
  type FastManimSandboxBrokerServerV1,
  startFastManimSandboxBrokerServerV1 as startBrokerServer,
} from "./fast-manim-sandbox-broker-server";
import {
  localSandboxReadyStatus,
  SANDBOX_TEST_SHA_A,
  sandboxProducerRequest,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const roots: string[] = [];
const servers: FastManimSandboxBrokerServerV1[] = [];
const socketGroupId = process.getegid?.() ?? -1;

function startFastManimSandboxBrokerServerV1(options: Omit<FastManimSandboxBrokerServerOptionsV1, "socketGroupId">) {
  return startBrokerServer({ ...options, socketGroupId });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

class TestBackend implements FastManimSandboxBackendV1 {
  readonly close = vi.fn(async () => undefined);
  readonly status = vi.fn(async (_context: FastManimSandboxStatusContextV1) => localSandboxReadyStatus());
  readonly starts: Array<
    Readonly<{ context: FastManimSandboxJobContextV1; request: FastManimSandboxRequestBundleV1 }>
  > = [];
  abort = vi.fn();
  resultFactory: (
    request: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
  ) => Promise<FastManimSandboxBackendResultV1> = async (request, context) => ({
    attestationDigest: context.attestationDigest,
    kind: "ok",
    requestDigest: request.requestDigest,
    resultBytes: Uint8Array.of(1, 2, 3),
  });

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    this.starts.push({ context, request });
    return { abort: this.abort, result: this.resultFactory(request, context) };
  }
}

async function socketPath() {
  const root = await mkdtemp(join(tmpdir(), "poietra-broker-"));
  roots.push(root);
  return join(root, "broker.sock");
}

function connect(path: string) {
  return new Promise<Socket>((resolveConnect, rejectConnect) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", rejectConnect);
  });
}

function testClient(socket: Socket) {
  const decoder = new FastManimSandboxBrokerFrameDecoderV1();
  const queued: FastManimSandboxBrokerServerMessageV1[] = [];
  const waiters: Array<(message: FastManimSandboxBrokerServerMessageV1) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    for (const decoded of decoder.push(chunk)) {
      if (!["status-result", "job-result", "abort-ack", "close-ack", "error"].includes(decoded.kind)) continue;
      const message = decoded as FastManimSandboxBrokerServerMessageV1;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });
  return {
    next() {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      return new Promise<FastManimSandboxBrokerServerMessageV1>((resolveMessage) => waiters.push(resolveMessage));
    },
    send(message: FastManimSandboxBrokerClientMessageV1) {
      socket.write(encodeFastManimSandboxBrokerFrameV1(message));
    },
  };
}

const identity = { projectId: "default", requestId: "snapshot-request-1", tenantId: "tenant-1" };
const common = {
  protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  version: 1 as const,
};

function startMessage(
  bundle: FastManimSandboxRequestBundleV1,
  overrides: Partial<Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>> = {},
): Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }> {
  return {
    ...common,
    attestationDigest: SANDBOX_TEST_SHA_A,
    correlationId: "start-1",
    deadlineEpochMs: Date.now() + 10_000,
    identity,
    jobId: "job-1",
    kind: "start",
    requestBytesBase64: encodeFastManimSandboxBrokerRequestBytesV1(bundle.copyBytes()),
    requestDigest: bundle.requestDigest,
    ...overrides,
  };
}

describe("fast-manim sandbox broker server", () => {
  it("multiplexes status and jobs without exposing a runtime socket", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const server = await startFastManimSandboxBrokerServerV1({ backend, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    const client = testClient(socket);
    const bundle = new RequestBundle(sandboxProducerRequest());

    client.send({
      ...common,
      correlationId: "status-1",
      deadlineEpochMs: Date.now() + 10_000,
      identity,
      kind: "status",
    });
    client.send(startMessage(bundle));

    const responses = [await client.next(), await client.next()];
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correlationId: "status-1", kind: "status-result" }),
        expect.objectContaining({
          correlationId: "start-1",
          jobId: "job-1",
          kind: "job-result",
          result: expect.objectContaining({ kind: "ok", requestDigest: bundle.requestDigest }),
        }),
      ]),
    );
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0]?.request.copyBytes()).toEqual(bundle.copyBytes());

    client.send({ ...common, correlationId: "close-1", kind: "close" });
    await expect(client.next()).resolves.toMatchObject({ correlationId: "close-1", kind: "close-ack" });
    await new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
  });

  it("aborts every connection-owned job when Studio disconnects", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    let settle!: (result: FastManimSandboxBackendResultV1) => void;
    backend.resultFactory = (request, context) =>
      new Promise((resolveResult) => {
        settle = resolveResult;
        context.signal.addEventListener(
          "abort",
          () =>
            resolveResult({
              attestationDigest: context.attestationDigest,
              code: "sandbox-execution-failed",
              kind: "failed",
              requestDigest: request.requestDigest,
            }),
          { once: true },
        );
      });
    const server = await startFastManimSandboxBrokerServerV1({ backend, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    const client = testClient(socket);
    client.send(startMessage(new RequestBundle(sandboxProducerRequest())));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));

    socket.destroy();
    await vi.waitFor(() => expect(backend.abort).toHaveBeenCalledOnce());
    expect(backend.starts[0]?.context.signal.aborted).toBe(true);
    settle({
      attestationDigest: SANDBOX_TEST_SHA_A,
      code: "sandbox-execution-failed",
      kind: "failed",
      requestDigest: backend.starts[0]!.request.requestDigest,
    });
  });

  it("enforces the per-connection job limit and keeps abort idempotent", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    let resolveLateResult!: (result: FastManimSandboxBackendResultV1) => void;
    backend.resultFactory = () =>
      new Promise((resolveResult) => {
        resolveLateResult = resolveResult;
      });
    const server = await startFastManimSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 50,
      maxJobsPerConnection: 1,
      socketPath: path,
    });
    servers.push(server);
    const socket = await connect(path);
    const client = testClient(socket);
    const bundle = new RequestBundle(sandboxProducerRequest());
    client.send(startMessage(bundle));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    client.send(startMessage(bundle, { correlationId: "start-2", jobId: "job-2" }));
    await expect(client.next()).resolves.toMatchObject({ code: "capacity", correlationId: "start-2", kind: "error" });

    client.send({ ...common, correlationId: "abort-1", jobId: "job-1", kind: "abort" });
    client.send({ ...common, correlationId: "abort-2", jobId: "missing-job", kind: "abort" });
    await expect(client.next()).resolves.toMatchObject({ correlationId: "abort-1", kind: "abort-ack" });
    await expect(client.next()).resolves.toMatchObject({ correlationId: "abort-2", kind: "abort-ack" });
    expect(backend.abort).toHaveBeenCalledOnce();
    resolveLateResult({
      attestationDigest: SANDBOX_TEST_SHA_A,
      kind: "ok",
      requestDigest: bundle.requestDigest,
      resultBytes: Uint8Array.of(1),
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    client.send({ ...common, correlationId: "close-after-abort", kind: "close" });
    await expect(client.next()).resolves.toMatchObject({ correlationId: "close-after-abort", kind: "close-ack" });
  });

  it("best-effort aborts a malformed backend handle and shuts the broker down", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const malformedAbort = vi.fn();
    backend.start = vi.fn(() => ({ abort: malformedAbort, result: {} as Promise<FastManimSandboxBackendResultV1> }));
    const server = await startFastManimSandboxBrokerServerV1({ backend, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    testClient(socket).send(startMessage(new RequestBundle(sandboxProducerRequest())));

    await vi.waitFor(() => expect(malformedAbort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("stops accepted sessions before awaiting listener shutdown", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    backend.resultFactory = (request, context) =>
      new Promise((resolveResult) => {
        context.signal.addEventListener(
          "abort",
          () =>
            resolveResult({
              attestationDigest: context.attestationDigest,
              code: "sandbox-execution-failed",
              kind: "failed",
              requestDigest: request.requestDigest,
            }),
          { once: true },
        );
      });
    const server = await startFastManimSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 500,
      socketPath: path,
    });
    const socket = await connect(path);
    testClient(socket).send(startMessage(new RequestBundle(sandboxProducerRequest())));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));

    await expect(server.close()).resolves.toBeUndefined();
    expect(backend.abort).toHaveBeenCalledOnce();
    expect(backend.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it("reconciles orphans before listening and rejects unsafe socket parents", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const reconcileOrphans = vi.fn(async () => undefined);
    const server = await startFastManimSandboxBrokerServerV1({ backend, reconcileOrphans, socketPath: path });
    servers.push(server);
    expect(reconcileOrphans).toHaveBeenCalledOnce();

    await expect(
      startFastManimSandboxBrokerServerV1({ backend: new TestBackend(), socketPath: join(tmpdir(), "unsafe.sock") }),
    ).rejects.toThrow(/privately owned/i);
  });

  it("owns the listener before reconciliation and rejects a second broker", async () => {
    const path = await socketPath();
    const firstReconcile = vi.fn(async () => undefined);
    const first = await startFastManimSandboxBrokerServerV1({
      backend: new TestBackend(),
      reconcileOrphans: firstReconcile,
      socketPath: path,
    });
    servers.push(first);
    const secondBackend = new TestBackend();
    const secondReconcile = vi.fn(async () => undefined);

    await expect(
      startFastManimSandboxBrokerServerV1({
        backend: secondBackend,
        reconcileOrphans: secondReconcile,
        socketPath: path,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(firstReconcile).toHaveBeenCalledOnce();
    expect(secondReconcile).not.toHaveBeenCalled();
    expect(secondBackend.close).toHaveBeenCalledOnce();
  });

  it("rejects a group-writable socket parent", async () => {
    const path = await socketPath();
    await chmod(dirname(path), 0o770);
    await expect(startFastManimSandboxBrokerServerV1({ backend: new TestBackend(), socketPath: path })).rejects.toThrow(
      /privately owned/i,
    );
  });

  it("bounds concurrent status work and aborts it on session close", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const statusSignals: AbortSignal[] = [];
    backend.status.mockImplementation(
      (context: FastManimSandboxStatusContextV1) =>
        new Promise<FastManimSandboxBackendStatusV1>((resolve) => {
          statusSignals.push(context.signal);
          context.signal.addEventListener("abort", () => resolve(localSandboxReadyStatus()), { once: true });
        }),
    );
    const server = await startFastManimSandboxBrokerServerV1({ backend, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    const client = testClient(socket);
    for (let index = 0; index < 9; index += 1) {
      client.send({
        ...common,
        correlationId: `status-${index}`,
        deadlineEpochMs: Date.now() + 10_000,
        identity,
        kind: "status",
      });
    }
    await expect(client.next()).resolves.toMatchObject({ code: "capacity", correlationId: "status-8", kind: "error" });
    client.send({ ...common, correlationId: "close-statuses", kind: "close" });
    await expect(client.next()).resolves.toMatchObject({ correlationId: "close-statuses", kind: "close-ack" });
    expect(statusSignals).toHaveLength(8);
    expect(statusSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects outer/inner identity drift before dispatch", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const server = await startFastManimSandboxBrokerServerV1({ backend, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    const client = testClient(socket);
    const bundle = new RequestBundle(sandboxProducerRequest());
    client.send(startMessage(bundle, { identity: { ...identity, requestId: "different-request" } }));
    await expect(client.next()).resolves.toMatchObject({ code: "internal", correlationId: "start-1", kind: "error" });
    expect(backend.starts).toHaveLength(0);
  });

  it("closes when the supervisor signal aborts", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const controller = new AbortController();
    const server = await startFastManimSandboxBrokerServerV1({
      backend,
      signal: controller.signal,
      socketPath: path,
    });
    controller.abort();
    await expect(server.close()).resolves.toBeUndefined();
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("retains singleton ownership when job cleanup cannot be proven", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    backend.resultFactory = () => new Promise(() => undefined);
    const server = await startFastManimSandboxBrokerServerV1({ backend, closeTimeoutMs: 20, socketPath: path });
    servers.push(server);
    const socket = await connect(path);
    testClient(socket).send(startMessage(new RequestBundle(sandboxProducerRequest())));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));

    await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
    const replacementBackend = new TestBackend();
    await expect(
      startFastManimSandboxBrokerServerV1({ backend: replacementBackend, socketPath: path }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(replacementBackend.close).toHaveBeenCalledOnce();
  });
});
