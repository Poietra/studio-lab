import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FastManimSandboxBackendResultV1,
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import {
  FastManimSandboxBackendControlError,
  FastManimSandboxRequestBundleV1 as RequestBundle,
} from "./fast-manim-sandbox-backend";
import {
  encodeFastManimSandboxBrokerClientFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  type FastManimSandboxBrokerClientMessageV1,
  type FastManimSandboxBrokerOperationV1,
  FastManimSandboxBrokerServerFrameDecoderV1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  type FastManimSandboxBrokerServerOptionsV1,
  type FastManimSandboxBrokerServerV1,
  startFastManimSandboxBrokerServerV1 as startBroker,
} from "./fast-manim-sandbox-broker-server";
import { FastManimUdsSandboxBackendV1 } from "./fast-manim-uds-sandbox-backend";
import {
  localSandboxReadyStatus,
  SANDBOX_TEST_SHA_A,
  sandboxProducerRequest,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const roots: string[] = [];
const servers: FastManimSandboxBrokerServerV1[] = [];
const sockets: Socket[] = [];
const socketGroupId = process.getegid?.() ?? -1;
const identity = { projectId: "default", requestId: "snapshot-request-1", tenantId: "tenant-1" };
type StartRequest = Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
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

function start(options: Omit<FastManimSandboxBrokerServerOptionsV1, "socketGroupId">) {
  return startBroker({ ...options, socketGroupId });
}

function startMessage(bundle: FastManimSandboxRequestBundleV1, overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    attestationDigest: SANDBOX_TEST_SHA_A,
    deadlineEpochMs: Date.now() + 10_000,
    identity,
    kind: "start",
    requestBytesBase64: encodeFastManimSandboxBrokerRequestBytesV1(bundle.copyBytes()),
    requestDigest: bundle.requestDigest,
    ...overrides,
  };
}

async function operation(
  path: string,
  kind: FastManimSandboxBrokerOperationV1,
  request: FastManimSandboxBrokerClientMessageV1,
) {
  const socket = createConnection({ allowHalfOpen: true, path });
  sockets.push(socket);
  await once(socket, "connect");
  const decoder = new FastManimSandboxBrokerServerFrameDecoderV1(kind);
  let resolveResponse!: (value: unknown) => void;
  let resolveEnded!: () => void;
  const response = new Promise<unknown>((resolve) => (resolveResponse = resolve));
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  socket.on("data", (chunk) => {
    if (typeof chunk === "string") throw new Error("Unexpected string socket chunk.");
    const decoded = decoder.push(chunk);
    if (decoded) resolveResponse(decoded);
  });
  socket.once("end", () => {
    socket.end();
    resolveEnded();
  });
  socket.write(encodeFastManimSandboxBrokerClientFrameV1(request));
  return {
    abort() {
      socket.end();
    },
    ended,
    response,
    socket,
  };
}

describe("fast-manim single-operation broker server", () => {
  it("serves status and a digest-bound job on separate sockets", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const server = await start({ backend, socketPath: path });
    servers.push(server);
    const bundle = new RequestBundle(sandboxProducerRequest());
    const drift = await operation(
      path,
      "start",
      startMessage(bundle, { identity: { ...identity, requestId: "other" } }),
    );
    await expect(drift.response).resolves.toMatchObject({ code: "internal", kind: "error" });
    expect(backend.starts).toHaveLength(0);
    const client = new FastManimUdsSandboxBackendV1({ socketPath: path });
    await expect(
      client.status({ deadlineEpochMs: Date.now() + 10_000, identity, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ health: "ready" });
    await expect(
      client.start(bundle, {
        attestationDigest: SANDBOX_TEST_SHA_A,
        deadlineEpochMs: Date.now() + 10_000,
        identity,
        signal: new AbortController().signal,
      }).result,
    ).resolves.toMatchObject({ kind: "ok", requestDigest: bundle.requestDigest });
    await client.close();
    expect(backend.starts[0]?.request.copyBytes()).toEqual(bundle.copyBytes());
  });

  it("bounds jobs and acknowledges FIN abort only after backend settlement", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    let settle!: (result: FastManimSandboxBackendResultV1) => void;
    backend.resultFactory = () => new Promise((resolve) => (settle = resolve));
    const server = await start({ backend, maxConcurrentJobs: 1, socketPath: path });
    servers.push(server);
    const bundle = new RequestBundle(sandboxProducerRequest());
    const job = await operation(path, "start", startMessage(bundle));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    const second = await operation(path, "start", startMessage(bundle));
    await expect(second.response).resolves.toMatchObject({ code: "capacity", kind: "error" });

    let acknowledged = false;
    void job.ended.then(() => (acknowledged = true));
    job.abort();
    await vi.waitFor(() => expect(backend.abort).toHaveBeenCalledOnce());
    expect(backend.starts[0]?.context.signal.aborted).toBe(true);
    expect(acknowledged).toBe(false);
    settle({
      attestationDigest: SANDBOX_TEST_SHA_A,
      code: "sandbox-execution-failed",
      kind: "failed",
      requestDigest: bundle.requestDigest,
    });
    await job.ended;
    expect(acknowledged).toBe(true);
  });

  it("drops idle and partial requests before they can exhaust connection capacity", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    const server = await start({ backend, closeTimeoutMs: 20, maxConnections: 1, socketPath: path });
    servers.push(server);

    for (const partialFrame of [undefined, Uint8Array.of(2)]) {
      const socket = createConnection({ path });
      sockets.push(socket);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      if (partialFrame) socket.write(partialFrame);
      await once(socket, "close");
    }

    const status = await operation(path, "status", {
      deadlineEpochMs: Date.now() + 10_000,
      identity,
      kind: "status",
    });
    await expect(status.response).resolves.toMatchObject({ kind: "status-result" });
    expect(backend.status).toHaveBeenCalledOnce();
  });

  it("applies the configured GID and reconciles once", async () => {
    const path = await socketPath();
    const reconcileOrphans = vi.fn(async () => undefined);
    const first = await start({ backend: new TestBackend(), reconcileOrphans, socketPath: path });
    servers.push(first);
    expect(await lstat(path)).toMatchObject({ gid: socketGroupId });
    expect((await lstat(path)).mode & 0o777).toBe(0o660);
    expect(reconcileOrphans).toHaveBeenCalledOnce();
  });

  it("rejects writable parents and an umask that exposes the bind window", async () => {
    const writablePath = await socketPath();
    await chmod(dirname(writablePath), 0o770);
    await expect(start({ backend: new TestBackend(), socketPath: writablePath })).rejects.toThrow(/privately owned/i);

    const maskedPath = await socketPath();
    const previous = process.umask(0o002);
    try {
      await expect(start({ backend: new TestBackend(), socketPath: maskedPath })).rejects.toThrow(/umask/i);
    } finally {
      process.umask(previous);
    }
  });

  it("closes on supervisor abort and latches unprovable cleanup", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    backend.resultFactory = () => new Promise(() => undefined);
    const controller = new AbortController();
    const server = await start({ backend, closeTimeoutMs: 20, signal: controller.signal, socketPath: path });
    servers.push(server);
    const job = await operation(path, "start", startMessage(new RequestBundle(sandboxProducerRequest())));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    controller.abort();
    await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
    job.socket.destroy();

    const replacementBackend = new TestBackend();
    await expect(start({ backend: replacementBackend, socketPath: path })).rejects.toMatchObject({ code: "busy" });
    expect(replacementBackend.close).toHaveBeenCalledOnce();
  });

  it("fails the broker closed when a backend ignores its deadline abort", async () => {
    const path = await socketPath();
    const backend = new TestBackend();
    backend.resultFactory = () => new Promise(() => undefined);
    const server = await start({ backend, closeTimeoutMs: 20, maxConcurrentJobs: 1, socketPath: path });
    servers.push(server);
    const bundle = new RequestBundle(sandboxProducerRequest());
    const job = await operation(path, "start", startMessage(bundle, { deadlineEpochMs: Date.now() + 30 }));
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    await vi.waitFor(() => expect(backend.abort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(backend.close).toHaveBeenCalledOnce());
    await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
    job.socket.destroy();

    const replacementBackend = new TestBackend();
    await expect(start({ backend: replacementBackend, socketPath: path })).rejects.toMatchObject({ code: "busy" });
    expect(replacementBackend.close).toHaveBeenCalledOnce();
  });

  it("reports an internal cleanup failure but not a requested close", async () => {
    const fatalPath = await socketPath();
    const fatalBackend = new TestBackend();
    fatalBackend.resultFactory = async () => {
      throw new FastManimSandboxBackendControlError("cleanup");
    };
    const onFatalClose = vi.fn();
    const fatalServer = await start({ backend: fatalBackend, onFatalClose, socketPath: fatalPath });
    servers.push(fatalServer);
    await operation(fatalPath, "start", startMessage(new RequestBundle(sandboxProducerRequest())));
    await vi.waitFor(() => expect(onFatalClose).toHaveBeenCalledOnce());

    const requestedPath = await socketPath();
    const requestedFatal = vi.fn();
    const requestedServer = await start({
      backend: new TestBackend(),
      onFatalClose: requestedFatal,
      socketPath: requestedPath,
    });
    servers.push(requestedServer);
    await requestedServer.close();
    expect(requestedFatal).not.toHaveBeenCalled();
  });
});
