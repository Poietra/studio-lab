import { createHash } from "node:crypto";
import { chmod, chown, lstat, realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import { acquireFastManimSandboxBrokerLeaseV1 } from "./fast-manim-sandbox-broker-lease";
import {
  ManimRenderSandboxBrokerClientFrameDecoderV1,
  type ManimRenderSandboxBrokerClientMessageV1,
  encodeManimRenderSandboxBrokerServerFrameV1,
} from "./manim-render-sandbox-broker-protocol";
import type { ManimRenderSandboxBackendV1 } from "./manim-render-sandbox-backend";
import {
  manimRenderSandboxDescriptorV1Schema,
  MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1,
  SealedManimRenderSandboxRequestV1,
} from "./manim-render-sandbox-contract";

const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_JOBS = 8;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_CLOSE_TIMEOUT_MS = 5 * 60_000;
const MAX_DEADLINE_HORIZON_MS = 15 * 60 * 1_000;
const MAX_SOCKET_PATH_BYTES = 96;
const RECEIVE_TIMEOUT_MS = 2_000;

type Connection = Readonly<{ close: () => Promise<void> }>;

export type ManimRenderSandboxBrokerServerOptionsV1 = Readonly<{
  backend: ManimRenderSandboxBackendV1;
  closeTimeoutMs?: number;
  maxConcurrentJobs?: number;
  maxConnections?: number;
  socketGroupId: number;
  socketPath: string;
}>;

function positiveInteger(value: number | undefined, fallback: number) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new TypeError("Broker limits must be positive integers.");
  return selected;
}

async function validateSocketPath(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    throw new TypeError("The render broker socket path is invalid.");
  }
  const parent = dirname(path);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  const userId = process.geteuid?.();
  if (
    userId === undefined ||
    canonical !== parent ||
    !metadata.isDirectory() ||
    metadata.uid !== userId ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new TypeError("The render broker socket directory is not privately owned.");
  }
  return userId;
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(path, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose, rejectClose) => {
    if (!server.listening) return resolveClose();
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    timer.unref();
  });
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer!));
}

function deadlineAccepted(value: number) {
  const remaining = value - Date.now();
  return remaining > 0 && remaining <= MAX_DEADLINE_HORIZON_MS;
}

function createConnection(
  socket: Socket,
  backend: ManimRenderSandboxBackendV1,
  acquireJob: () => (() => void) | undefined,
  closeTimeoutMs: number,
  onClose: (connection: Connection) => void,
  onCleanupFailure: () => void,
) {
  const decoder = new ManimRenderSandboxBrokerClientFrameDecoderV1();
  const controller = new AbortController();
  let closeRequest: Promise<void> | undefined;
  let operation: Promise<void> | undefined;
  let operationFinished = false;
  let pendingRequest: ManimRenderSandboxBrokerClientMessageV1 | undefined;
  let requestSeen = false;
  const receiveTimer = setTimeout(() => socket.destroy(), RECEIVE_TIMEOUT_MS);
  receiveTimer.unref();

  const send = (
    operationKind: "cancel" | "status" | "submit",
    value: Parameters<typeof encodeManimRenderSandboxBrokerServerFrameV1>[1],
  ) => {
    if (!socket.destroyed && socket.writable)
      socket.end(encodeManimRenderSandboxBrokerServerFrameV1(operationKind, value));
  };
  const error = (
    operationKind: "cancel" | "status" | "submit",
    code: "capacity" | "cleanup" | "internal" | "unavailable",
  ) => send(operationKind, { code, kind: "error" });

  const run = async (request: ManimRenderSandboxBrokerClientMessageV1) => {
    if (!deadlineAccepted(request.deadlineEpochMs)) return error(request.kind, "unavailable");
    let deadlineGraceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      deadlineGraceTimer = setTimeout(() => {
        if (!operationFinished) onCleanupFailure();
      }, closeTimeoutMs);
      deadlineGraceTimer.unref();
    }, request.deadlineEpochMs - Date.now());
    timer.unref();
    try {
      if (request.kind === "status") {
        const status = await backend.status({ deadlineEpochMs: request.deadlineEpochMs, signal: controller.signal });
        controller.signal.throwIfAborted();
        return send("status", { kind: "status-result", status });
      }
      if (request.kind === "cancel") {
        await backend.cancel(request.jobId, { deadlineEpochMs: request.deadlineEpochMs, signal: controller.signal });
        controller.signal.throwIfAborted();
        return send("cancel", { cancelled: true, kind: "cancel-result" });
      }
      const release = acquireJob();
      if (!release) return error("submit", "capacity");
      try {
        const bytes = Buffer.from(request.requestBytesBase64, "base64");
        if (
          bytes.byteLength > MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1 ||
          createHash("sha256").update(bytes).digest("hex") !== request.requestDigest
        ) {
          throw new Error();
        }
        const descriptor = manimRenderSandboxDescriptorV1Schema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        const sealed = new SealedManimRenderSandboxRequestV1(descriptor);
        if (sealed.requestDigest !== request.requestDigest || !Buffer.from(sealed.copyBytes()).equals(bytes)) {
          throw new Error();
        }
        const result = await backend.submitOrReattach(sealed, {
          deadlineEpochMs: request.deadlineEpochMs,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return send("submit", { kind: "job-result", result });
      } finally {
        release();
      }
    } catch {
      if (controller.signal.aborted) socket.destroy();
      else error(request.kind, "internal");
    } finally {
      clearTimeout(timer);
      if (deadlineGraceTimer) clearTimeout(deadlineGraceTimer);
    }
  };

  const connection: Connection = {
    close() {
      closeRequest ??= (async () => {
        clearTimeout(receiveTimer);
        controller.abort();
        socket.destroy();
        const settled = await settleWithin(operation ?? Promise.resolve(), closeTimeoutMs);
        if (!settled) {
          onCleanupFailure();
          throw new Error("The render broker operation did not stop within its cleanup deadline.");
        }
      })().finally(() => onClose(connection));
      return closeRequest;
    },
  };

  socket.on("data", (chunk: Buffer) => {
    if (requestSeen) return socket.destroy();
    try {
      const request = decoder.push(chunk);
      if (request) {
        requestSeen = true;
        pendingRequest = request;
      }
    } catch {
      socket.destroy();
    }
  });
  socket.once("end", () => {
    try {
      decoder.finish();
      if (!pendingRequest) throw new Error("The render broker request ended before one complete frame.");
      clearTimeout(receiveTimer);
      operation = run(pendingRequest).finally(() => {
        operationFinished = true;
      });
    } catch {
      socket.destroy();
    }
  });
  socket.once("error", () => undefined);
  socket.once("close", () => {
    clearTimeout(receiveTimer);
    controller.abort();
    void connection.close().catch(() => undefined);
  });
  return connection;
}

export async function startManimRenderSandboxBrokerServerV1(options: ManimRenderSandboxBrokerServerOptionsV1) {
  const userId = await validateSocketPath(options.socketPath);
  if (!Number.isSafeInteger(options.socketGroupId) || options.socketGroupId < 0) {
    throw new TypeError("The render broker socket group is invalid.");
  }
  const maxJobs = positiveInteger(options.maxConcurrentJobs, DEFAULT_MAX_JOBS);
  const maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS);
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  if (closeTimeoutMs > MAX_CLOSE_TIMEOUT_MS) throw new TypeError("The render broker close timeout is too large.");
  let lease: Awaited<ReturnType<typeof acquireFastManimSandboxBrokerLeaseV1>>;
  try {
    lease = await acquireFastManimSandboxBrokerLeaseV1(options.socketPath);
  } catch (error) {
    const backendClosed = await settleWithin(
      Promise.resolve().then(() => options.backend.close()),
      closeTimeoutMs,
    );
    if (!backendClosed) throw new AggregateError([error, new Error("The render backend cleanup timed out.")]);
    throw error;
  }
  const connections = new Set<Connection>();
  let activeJobs = 0;
  let accepting = false;
  let closeRequest: Promise<void> | undefined;
  let closeBroker!: () => Promise<void>;
  let fatalReported = false;
  let reportFatal!: () => void;
  const fatal = new Promise<void>((resolveFatal) => {
    reportFatal = resolveFatal;
  });
  const reportFatalClose = () => {
    if (fatalReported) return;
    fatalReported = true;
    reportFatal();
  };
  const acquireJob = () => {
    if (activeJobs >= maxJobs) return undefined;
    activeJobs += 1;
    return () => {
      activeJobs -= 1;
    };
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!accepting) return socket.destroy();
    const connection = createConnection(
      socket,
      options.backend,
      acquireJob,
      closeTimeoutMs,
      (closed) => connections.delete(closed),
      () => {
        accepting = false;
        reportFatalClose();
        void closeBroker().catch(() => undefined);
      },
    );
    connections.add(connection);
  });
  server.maxConnections = maxConnections;
  const closeAll = async () => {
    accepting = false;
    const failures: unknown[] = [];
    const transport = Promise.allSettled([
      closeServer(server),
      ...[...connections].map((connection) => connection.close()),
    ]);
    if (!(await settleWithin(transport, closeTimeoutMs)))
      failures.push(new Error("Render broker transport cleanup timed out."));
    else failures.push(...(await transport).flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    const backend = Promise.resolve().then(() => options.backend.close());
    if (!(await settleWithin(backend, closeTimeoutMs))) failures.push(new Error("Render backend cleanup timed out."));
    else await backend.catch((error: unknown) => failures.push(error));
    const leaseClose = lease.close();
    if (!(await settleWithin(leaseClose, closeTimeoutMs)))
      failures.push(new Error("Render broker lease cleanup timed out."));
    else await leaseClose.catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      reportFatalClose();
      throw new AggregateError(failures, "The render broker did not close safely.");
    }
  };
  closeBroker = () => {
    closeRequest ??= closeAll();
    return closeRequest;
  };
  const onFatalServerError = () => {
    reportFatalClose();
    void closeBroker().catch(() => undefined);
  };
  try {
    await listen(server, options.socketPath);
    server.on("error", onFatalServerError);
    await chown(options.socketPath, userId, options.socketGroupId);
    await chmod(options.socketPath, 0o660);
    const metadata = await lstat(options.socketPath);
    if (
      !metadata.isSocket() ||
      metadata.uid !== userId ||
      metadata.gid !== options.socketGroupId ||
      (metadata.mode & 0o777) !== 0o660
    ) {
      throw new Error("The render broker socket permissions are not closed.");
    }
    accepting = true;
  } catch (error) {
    try {
      await closeBroker();
    } catch (cleanupError) {
      const cleanupFailures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([error, ...cleanupFailures], "The render broker failed to start and close safely.");
    }
    throw error;
  }
  return {
    fatal,
    socketPath: options.socketPath,
    close() {
      return closeBroker();
    },
  };
}
