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
import { acquireFastManimSandboxBrokerLeaseV1 } from "./fast-manim-sandbox-broker-lease";
import {
  decodeFastManimSandboxBrokerRequestBytesV1,
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerResultBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  type FastManimSandboxBrokerClientMessageV1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
  MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  fastManimSnapshotProducerRequestV1Schema,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_CLOSE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_JOBS_PER_CONNECTION = 4;
const MAX_BROKER_DEADLINE_HORIZON_MS = 5 * 60_000;
const MAX_STATUS_OPERATIONS_PER_CONNECTION = 8;
const MAX_MESSAGES_PER_CONNECTION = 4_096;
const MAX_UNIX_SOCKET_PATH_BYTES = 96;
const MAX_WRITE_BUFFER_BYTES = 2 * (MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1 + 4);

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
  /** Numeric GID of the only local Studio principal group admitted by the UDS. */
  socketGroupId: number;
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

function unixGroupId(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError("Broker socket group ID must be an unsigned 32-bit integer.");
  }
  return value;
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
  const effectiveUid = process.geteuid?.();
  if (
    effectiveUid === undefined ||
    !metadata.isDirectory() ||
    canonicalParent !== parent ||
    (metadata.uid !== 0 && metadata.uid !== effectiveUid) ||
    (metadata.mode & 0o022) !== 0 ||
    (process.umask() & 0o002) === 0
  ) {
    throw new TypeError("The sandbox broker socket parent or process umask is not privately owned.");
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
  onCleanupFailure: () => void,
): BrokerSession {
  const decoder = new FastManimSandboxBrokerFrameDecoderV1();
  const correlations = new Set<string>();
  const jobs = new Map<string, BrokerJob>();
  const operations = new Map<string, BrokerOperation>();
  const seenJobIds = new Set<string>();
  const shutdownController = new AbortController();
  let closing = false;
  let messageCount = 0;
  let closeRequest: Promise<void> | null = null;

  const send = (message: FastManimSandboxBrokerServerMessageV1) => {
    if (closing || !socket.writable) return;
    const frame = encodeFastManimSandboxBrokerFrameV1(message);
    if (socket.writableLength + frame.byteLength > MAX_WRITE_BUFFER_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(frame);
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
      const settled = await settleWithin(
        Promise.allSettled([
          ...[...operations.values()].map((operation) => operation.result),
          ...[...jobs.values()].map((job) => job.result),
        ]),
        options.closeTimeoutMs,
      );
      socket.destroy();
      if (!settled) throw new FastManimSandboxBackendControlError("cleanup");
    })().finally(() => onClosed(session));
    return closeRequest;
  };

  const handleStatus = (request: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "status" }>) => {
    if (operations.size >= MAX_STATUS_OPERATIONS_PER_CONNECTION) {
      sendError(request, "capacity");
      return;
    }
    if (
      operations.has(request.correlationId) ||
      request.deadlineEpochMs <= Date.now() ||
      request.deadlineEpochMs - Date.now() > MAX_BROKER_DEADLINE_HORIZON_MS
    ) {
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
    if (seenJobIds.has(request.jobId) || jobs.size >= options.maxJobs) {
      sendError(request, "capacity");
      return;
    }
    seenJobIds.add(request.jobId);
    if (
      request.deadlineEpochMs <= Date.now() ||
      request.deadlineEpochMs - Date.now() > MAX_BROKER_DEADLINE_HORIZON_MS
    ) {
      sendError(request, "unavailable");
      return;
    }
    let requestBundle: FastManimSandboxRequestBundleV1;
    try {
      const requestBytes = decodeFastManimSandboxBrokerRequestBytesV1(request.requestBytesBase64);
      if (createHash("sha256").update(requestBytes).digest("hex") !== request.requestDigest) throw new Error();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
      const parsed = fastManimSnapshotProducerRequestV1Schema.parse(JSON.parse(source));
      if (parsed.projectId !== request.identity.projectId || parsed.requestId !== request.identity.requestId) {
        throw new Error();
      }
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
    let capturedAbort: (() => void) | undefined;
    let backendAbort!: () => void;
    let backendResult: Promise<unknown>;
    try {
      const handle = backend.start(requestBundle, {
        attestationDigest: request.attestationDigest,
        deadlineEpochMs: request.deadlineEpochMs,
        identity: request.identity,
        signal: controller.signal,
      });
      const abortMember = handle?.abort;
      const resultMember = handle?.result;
      if (typeof abortMember === "function") capturedAbort = () => Reflect.apply(abortMember, handle, []);
      if (!capturedAbort || !(resultMember instanceof Promise)) throw new Error();
      backendAbort = capturedAbort;
      backendResult = resultMember;
    } catch (error) {
      controller.abort();
      try {
        capturedAbort?.();
      } catch {
        // A malformed handle cannot be trusted to clean itself up. The broker
        // is latched unavailable below regardless of this best-effort abort.
      }
      clearTimeout(timer);
      shutdownController.signal.removeEventListener("abort", stop);
      const control = fastManimSandboxBackendControlErrorCode(error);
      sendError(request, control ?? "cleanup");
      if (control !== "capacity") onCleanupFailure();
      return;
    }
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      controller.abort();
      backendAbort();
    };
    const result = backendResult
      .then((value) => {
        // `abort-ack` is terminal for this session-owned job. A backend may
        // race and fulfill after abort, but forwarding that stale result would
        // reuse a correlation the Studio client has already released.
        if (closing || controller.signal.aborted) return;
        const parsed = fastManimSandboxBackendResultV1Schema.parse(value);
        if (parsed.requestDigest !== request.requestDigest || parsed.attestationDigest !== request.attestationDigest) {
          throw new Error();
        }
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
        if (control !== "capacity") onCleanupFailure();
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
    if (messageCount > MAX_MESSAGES_PER_CONNECTION || correlations.has(request.correlationId)) {
      socket.destroy();
      return;
    }
    correlations.add(request.correlationId);
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
    shutdownController.abort();
    for (const operation of operations.values()) operation.abort();
    for (const job of jobs.values()) abortJob(job);
    void settleWithin(
      Promise.allSettled([
        ...[...operations.values()].map((operation) => operation.result),
        ...[...jobs.values()].map((job) => job.result),
      ]),
      options.closeTimeoutMs,
    ).then((settled) => {
      if (settled && socket.writable) {
        const frame = encodeFastManimSandboxBrokerFrameV1(
          brokerMessage({ correlationId: request.correlationId, kind: "close-ack" }),
        );
        if (socket.writableLength + frame.byteLength <= MAX_WRITE_BUFFER_BYTES) socket.end(frame);
        else socket.destroy();
      } else {
        socket.destroy();
      }
    });
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
  const closeAfterTransport = () => {
    void finish().catch(() => onCleanupFailure());
  };
  socket.once("error", closeAfterTransport);
  socket.once("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
    }
  });
  socket.once("close", closeAfterTransport);
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
  if (closeTimeoutMs > MAX_CLOSE_TIMEOUT_MS) {
    throw new TypeError(`Broker close timeout must not exceed ${MAX_CLOSE_TIMEOUT_MS}ms.`);
  }
  const socketGroupId = unixGroupId(options.socketGroupId);
  const maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, "Broker connection limit");
  const maxJobs = positiveInteger(
    options.maxJobsPerConnection,
    DEFAULT_MAX_JOBS_PER_CONNECTION,
    "Broker per-connection job limit",
  );
  await validateSocketPath(options.socketPath);
  options.signal?.throwIfAborted();
  let lease: Awaited<ReturnType<typeof acquireFastManimSandboxBrokerLeaseV1>>;
  try {
    lease = await acquireFastManimSandboxBrokerLeaseV1(options.socketPath);
  } catch (error) {
    const backendClosed = await settleWithin(
      Promise.resolve().then(() => options.backend.close()),
      closeTimeoutMs,
    );
    if (!backendClosed) {
      throw new AggregateError([error, new FastManimSandboxBackendControlError("cleanup")]);
    }
    throw error;
  }

  const sessions = new Set<BrokerSession>();
  let accepting = false;
  let closeRequest: Promise<void> | null = null;
  let closeBroker!: () => Promise<void>;
  const server = createServer((socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    const session = createBrokerSession(
      socket,
      options.backend,
      { closeTimeoutMs, maxJobs },
      (closed) => sessions.delete(closed),
      () => {
        accepting = false;
        void closeBroker().catch(() => undefined);
      },
    );
    sessions.add(session);
  });
  server.maxConnections = maxConnections;
  try {
    await listen(server, options.socketPath);
    await chmod(options.socketPath, 0o660);
    const socketMetadata = await lstat(options.socketPath);
    const effectiveUid = process.geteuid?.();
    if (
      effectiveUid === undefined ||
      !socketMetadata.isSocket() ||
      socketMetadata.uid !== effectiveUid ||
      socketMetadata.gid !== socketGroupId ||
      (socketMetadata.mode & 0o777) !== 0o660
    ) {
      throw new Error("The sandbox broker socket permissions are not closed.");
    }
    if (options.reconcileOrphans) await options.reconcileOrphans(options.signal ?? new AbortController().signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    const resourceCleanup = Promise.allSettled([
      closeListener(server),
      Promise.resolve().then(() => options.backend.close()),
    ]);
    if (!(await settleWithin(resourceCleanup, closeTimeoutMs))) {
      // Keep the kernel lease alive. Releasing it while the listener or
      // backend might still own work would let a replacement broker overlap.
      throw new AggregateError([error, new FastManimSandboxBackendControlError("cleanup")]);
    }
    const cleanup = await resourceCleanup;
    const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Sandbox broker startup and cleanup both failed.");
    }
    try {
      await lease.close();
    } catch (leaseError) {
      throw new AggregateError([error, leaseError], "Sandbox broker startup and lease cleanup both failed.");
    }
    throw error;
  }
  accepting = true;

  const abortFromSignal = () => void closeBroker().catch(() => undefined);
  closeBroker = () => {
    closeRequest ??= (async () => {
      accepting = false;
      options.signal?.removeEventListener("abort", abortFromSignal);
      const errors: unknown[] = [];
      // Stop accepting first, but do not await Node's close callback before
      // terminating accepted sockets: that callback waits for them.
      const listenerClosed = closeListener(server);
      const sessionCleanup = Promise.all([...sessions].map((session) => session.close()));
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
      // A replacement broker may start only after every owned resource has
      // stopped. On any uncertainty, retain the kernel lease until process exit.
      if (errors.length === 0) await lease.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0) throw new AggregateError(errors, "The sandbox broker could not close safely.");
    })();
    return closeRequest;
  };
  options.signal?.addEventListener("abort", abortFromSignal, { once: true });
  if (options.signal?.aborted) abortFromSignal();
  server.on("error", () => {
    accepting = false;
    void closeBroker().catch(() => undefined);
  });

  return {
    close: closeBroker,
    socketPath: options.socketPath,
  };
}
