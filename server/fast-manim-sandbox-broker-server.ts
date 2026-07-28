import { createHash } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  copyFastManimSandboxUint8ArrayV1,
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendV1,
  FastManimSandboxRequestBundleV1,
  fastManimSandboxBackendControlErrorCode,
  fastManimSandboxBackendResultV1Schema,
  fastManimSandboxBackendStatusV1Schema,
} from "./fast-manim-sandbox-backend";
import {
  decodeFastManimSandboxBrokerRequestBytesV1,
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerResultBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  type FastManimSandboxBrokerClientMessageV1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  fastManimSnapshotProducerRequestV1Schema,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_JOBS_PER_CONNECTION = 4;
const MAX_MESSAGES_PER_CONNECTION = 4_096;
const MAX_UNIX_SOCKET_PATH_BYTES = 96;

type BrokerSession = Readonly<{
  close: () => Promise<void>;
}>;

type BrokerJob = Readonly<{
  abort: () => void;
  result: Promise<void>;
}>;

type BrokerOperation = Readonly<{
  abort: () => void;
  result: Promise<void>;
}>;

type BrokerServerMessageBody = FastManimSandboxBrokerServerMessageV1 extends infer Message
  ? Message extends FastManimSandboxBrokerServerMessageV1
    ? Omit<Message, "protocol" | "version">
    : never
  : never;

export type FastManimSandboxBrokerServerV1 = Readonly<{
  close: () => Promise<void>;
  socketPath: string;
}>;

export type FastManimSandboxBrokerServerOptionsV1 = Readonly<{
  backend: FastManimSandboxBackendV1;
  closeTimeoutMs?: number;
  maxConnections?: number;
  maxJobsPerConnection?: number;
  reconcileOrphans?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  socketPath: string;
}>;

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return candidate;
}

async function validateSocketPath(socketPath: string) {
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new TypeError("The sandbox broker socket path must be a bounded canonical absolute path.");
  }
  const parent = dirname(socketPath);
  const [metadata, canonicalParent] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!metadata.isDirectory() || canonicalParent !== parent || (metadata.mode & 0o002) !== 0) {
    throw new TypeError("The sandbox broker socket parent must be a canonical non-world-writable directory.");
  }
}

function brokerMessage(message: BrokerServerMessageBody): FastManimSandboxBrokerServerMessageV1 {
  return {
    ...message,
    protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
    version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  } as FastManimSandboxBrokerServerMessageV1;
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

function listen(server: Server, socketPath: string) {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeListener(server: Server) {
  return new Promise<void>((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function createBrokerSession(
  socket: Socket,
  backend: FastManimSandboxBackendV1,
  options: Readonly<{ closeTimeoutMs: number; maxJobs: number }>,
  onClosed: (session: BrokerSession) => void,
): BrokerSession {
  const decoder = new FastManimSandboxBrokerFrameDecoderV1();
  const jobs = new Map<string, BrokerJob>();
  const operations = new Map<string, BrokerOperation>();
  const shutdownController = new AbortController();
  let closing = false;
  let messageCount = 0;
  let closeRequest: Promise<void> | null = null;

  const send = (message: FastManimSandboxBrokerServerMessageV1) => {
    if (closing || !socket.writable) return;
    socket.write(encodeFastManimSandboxBrokerFrameV1(message));
  };
  const sendError = (
    request: FastManimSandboxBrokerClientMessageV1,
    code: "capacity" | "cleanup" | "internal" | "unavailable",
  ) => {
    send(
      brokerMessage({
        code,
        correlationId: request.correlationId,
        kind: "error",
        operation: request.kind,
      }),
    );
  };
  const abortJob = (job: BrokerJob | undefined) => {
    if (!job) return;
    try {
      job.abort();
    } catch {
      socket.destroy();
    }
  };

  const finish = () => {
    closeRequest ??= (async () => {
      closing = true;
      shutdownController.abort();
      for (const operation of operations.values()) operation.abort();
      for (const job of jobs.values()) abortJob(job);
      await settleWithin(
        Promise.allSettled([
          ...[...operations.values()].map((operation) => operation.result),
          ...[...jobs.values()].map((job) => job.result),
        ]),
        options.closeTimeoutMs,
      );
      socket.destroy();
    })().finally(() => onClosed(session));
    return closeRequest;
  };

  const handleStatus = (request: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "status" }>) => {
    if (operations.has(request.correlationId) || request.deadlineEpochMs <= Date.now()) {
      sendError(request, "unavailable");
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    shutdownController.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.max(1, request.deadlineEpochMs - Date.now()));
    timer.unref();
    const result = Promise.resolve()
      .then(() =>
        backend.status({
          deadlineEpochMs: request.deadlineEpochMs,
          identity: request.identity,
          signal: controller.signal,
        }),
      )
      .then((status) => {
        const parsed = fastManimSandboxBackendStatusV1Schema.parse(status);
        send(brokerMessage({ correlationId: request.correlationId, kind: "status-result", status: parsed }));
      })
      .catch(() => {
        if (!closing) sendError(request, "unavailable");
      })
      .finally(() => {
        clearTimeout(timer);
        shutdownController.signal.removeEventListener("abort", stop);
        operations.delete(request.correlationId);
      });
    operations.set(request.correlationId, { abort: stop, result });
  };

  const handleStart = (request: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>) => {
    if (jobs.has(request.jobId) || jobs.size >= options.maxJobs) {
      sendError(request, "capacity");
      return;
    }
    if (request.deadlineEpochMs <= Date.now()) {
      sendError(request, "unavailable");
      return;
    }
    let requestBundle: FastManimSandboxRequestBundleV1;
    try {
      const requestBytes = decodeFastManimSandboxBrokerRequestBytesV1(request.requestBytesBase64);
      if (createHash("sha256").update(requestBytes).digest("hex") !== request.requestDigest) throw new Error();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
      const parsed = fastManimSnapshotProducerRequestV1Schema.parse(JSON.parse(source));
      requestBundle = new FastManimSandboxRequestBundleV1(parsed);
      if (!Buffer.from(requestBundle.copyBytes()).equals(Buffer.from(requestBytes))) throw new Error();
    } catch {
      sendError(request, "internal");
      return;
    }

    const controller = new AbortController();
    const stop = () => controller.abort();
    shutdownController.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.max(1, request.deadlineEpochMs - Date.now()));
    timer.unref();
    let handle: ReturnType<FastManimSandboxBackendV1["start"]>;
    try {
      handle = backend.start(requestBundle, {
        attestationDigest: request.attestationDigest,
        deadlineEpochMs: request.deadlineEpochMs,
        identity: request.identity,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      shutdownController.signal.removeEventListener("abort", stop);
      const control = fastManimSandboxBackendControlErrorCode(error);
      sendError(request, control ?? "internal");
      return;
    }
    const abort = () => {
      controller.abort();
      handle.abort();
    };
    const result = Promise.resolve(handle.result)
      .then((value) => {
        const parsed = fastManimSandboxBackendResultV1Schema.parse(value);
        const wireResult = (() => {
          if (parsed.kind !== "ok") return parsed;
          const { resultBytes, ...correlation } = parsed;
          return {
            ...correlation,
            resultBytesBase64: encodeFastManimSandboxBrokerResultBytesV1(
              copyFastManimSandboxUint8ArrayV1(resultBytes, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES),
            ),
          };
        })();
        send(
          brokerMessage({
            correlationId: request.correlationId,
            jobId: request.jobId,
            kind: "job-result",
            result: wireResult,
          }),
        );
      })
      .catch((error: unknown) => {
        if (closing || controller.signal.aborted) return;
        const control = fastManimSandboxBackendControlErrorCode(error);
        sendError(request, control ?? "internal");
      })
      .finally(() => {
        clearTimeout(timer);
        shutdownController.signal.removeEventListener("abort", stop);
        jobs.delete(request.jobId);
      });
    jobs.set(request.jobId, { abort, result });
  };

  const handle = (request: FastManimSandboxBrokerClientMessageV1) => {
    if (closing) return;
    messageCount += 1;
    if (messageCount > MAX_MESSAGES_PER_CONNECTION) {
      socket.destroy();
      return;
    }
    if (request.kind === "status") {
      handleStatus(request);
      return;
    }
    if (request.kind === "start") {
      handleStart(request);
      return;
    }
    if (request.kind === "abort") {
      abortJob(jobs.get(request.jobId));
      send(brokerMessage({ correlationId: request.correlationId, jobId: request.jobId, kind: "abort-ack" }));
      return;
    }
    closing = true;
    for (const job of jobs.values()) abortJob(job);
    void settleWithin(Promise.allSettled([...jobs.values()].map((job) => job.result)), options.closeTimeoutMs).then(
      (settled) => {
        if (settled && socket.writable) {
          socket.end(
            encodeFastManimSandboxBrokerFrameV1(
              brokerMessage({ correlationId: request.correlationId, kind: "close-ack" }),
            ),
          );
        } else {
          socket.destroy();
        }
      },
    );
  };

  const session: BrokerSession = { close: finish };
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (["status", "start", "abort", "close"].includes(message.kind)) {
          handle(message as FastManimSandboxBrokerClientMessageV1);
        } else {
          socket.destroy();
        }
      }
    } catch {
      socket.destroy();
    }
  });
  socket.once("error", () => void finish());
  socket.once("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
    }
  });
  socket.once("close", () => void finish());
  return session;
}

/**
 * Starts the separately supervised broker boundary. Filesystem permissions are
 * the connection admission mechanism; the Docker/runtime socket stays owned by
 * this process and is never exposed through the protocol.
 */
export async function startFastManimSandboxBrokerServerV1(
  options: FastManimSandboxBrokerServerOptionsV1,
): Promise<FastManimSandboxBrokerServerV1> {
  if (!options?.backend || typeof options.backend.start !== "function") {
    throw new TypeError("The sandbox broker requires a backend.");
  }
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "Broker close timeout");
  const maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, "Broker connection limit");
  const maxJobs = positiveInteger(
    options.maxJobsPerConnection,
    DEFAULT_MAX_JOBS_PER_CONNECTION,
    "Broker per-connection job limit",
  );
  await validateSocketPath(options.socketPath);
  options.signal?.throwIfAborted();
  if (options.reconcileOrphans) await options.reconcileOrphans(options.signal ?? new AbortController().signal);
  options.signal?.throwIfAborted();

  const sessions = new Set<BrokerSession>();
  const server = createServer((socket) => {
    const session = createBrokerSession(socket, options.backend, { closeTimeoutMs, maxJobs }, (closed) => {
      sessions.delete(closed);
    });
    sessions.add(session);
  });
  server.maxConnections = maxConnections;
  await listen(server, options.socketPath);
  try {
    await chmod(options.socketPath, 0o660);
    const socketMetadata = await lstat(options.socketPath);
    if (!socketMetadata.isSocket() || (socketMetadata.mode & 0o007) !== 0) {
      throw new Error("The sandbox broker socket permissions are not closed.");
    }
  } catch (error) {
    await closeListener(server).catch(() => undefined);
    throw error;
  }
  server.on("error", () => {
    for (const session of sessions) void session.close();
  });

  let closeRequest: Promise<void> | null = null;
  return {
    close() {
      closeRequest ??= (async () => {
        const errors: unknown[] = [];
        // Stop accepting first, but do not await Node's close callback before
        // terminating accepted sockets: that callback waits for them.
        const listenerClosed = closeListener(server);
        const sessionCleanup = Promise.allSettled([...sessions].map((session) => session.close()));
        if (!(await settleWithin(sessionCleanup, closeTimeoutMs))) {
          errors.push(new FastManimSandboxBackendControlError("cleanup"));
        }
        if (!(await settleWithin(listenerClosed, closeTimeoutMs))) {
          errors.push(new FastManimSandboxBackendControlError("cleanup"));
        }
        const backendClosed = await settleWithin(
          Promise.resolve().then(() => options.backend.close()),
          closeTimeoutMs,
        );
        if (!backendClosed) errors.push(new FastManimSandboxBackendControlError("cleanup"));
        if (errors.length > 0) throw new AggregateError(errors, "The sandbox broker could not close safely.");
      })();
      return closeRequest;
    },
    socketPath: options.socketPath,
  };
}
