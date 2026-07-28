import { createHash } from "node:crypto";
import { chmod, chown, lstat, realpath } from "node:fs/promises";
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
  encodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerServerFrameV1,
  FastManimSandboxBrokerClientFrameDecoderV1,
  type FastManimSandboxBrokerClientMessageV1,
  type FastManimSandboxBrokerServerMessageV1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  fastManimSnapshotProducerRequestV1Schema,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_CLOSE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_JOBS = 16;
const DEFAULT_MAX_STATUSES = 16;
const MAX_BROKER_DEADLINE_HORIZON_MS = 5 * 60_000;
const MAX_UNIX_SOCKET_PATH_BYTES = 96;

type BrokerConnection = Readonly<{ close: () => Promise<void> }>;
type CapacityKind = "start" | "status";

export type FastManimSandboxBrokerServerV1 = Readonly<{
  close: () => Promise<void>;
  socketPath: string;
}>;

export type FastManimSandboxBrokerServerOptionsV1 = Readonly<{
  backend: FastManimSandboxBackendV1;
  closeTimeoutMs?: number;
  maxConcurrentJobs?: number;
  maxConcurrentStatuses?: number;
  maxConnections?: number;
  reconcileOrphans?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Numeric GID of the only local Studio principal group admitted by the UDS. */
  socketGroupId: number;
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

function deadlineAccepted(deadlineEpochMs: number) {
  const remainingMs = deadlineEpochMs - Date.now();
  return remainingMs > 0 && remainingMs <= MAX_BROKER_DEADLINE_HORIZON_MS;
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
    (process.umask() & 0o022) !== 0o022
  ) {
    throw new TypeError("The sandbox broker socket parent or process umask is not privately owned.");
  }
  return effectiveUid;
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
    if (!server.listening) return resolveClose();
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function createBrokerConnection(
  socket: Socket,
  backend: FastManimSandboxBackendV1,
  options: Readonly<{
    acquire: (kind: CapacityKind) => (() => void) | undefined;
    closeTimeoutMs: number;
  }>,
  onClosed: (connection: BrokerConnection) => void,
  onCleanupFailure: () => void,
): BrokerConnection {
  const decoder = new FastManimSandboxBrokerClientFrameDecoderV1();
  const controller = new AbortController();
  let abortBackend: (() => void) | undefined;
  let closeRequest: Promise<void> | null = null;
  let operation: Promise<void> | undefined;
  let operationFinished = false;
  let peerAborted = false;
  let requestSeen = false;

  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    try {
      abortBackend?.();
    } catch {
      onCleanupFailure();
    }
  };

  const finishSocket = (frame?: Uint8Array) => {
    if (socket.destroyed || socket.writableEnded) return;
    const destroy = () => socket.destroy();
    if (frame) socket.end(frame, destroy);
    else socket.end(destroy);
  };

  const send = (kind: CapacityKind, message: FastManimSandboxBrokerServerMessageV1) => {
    if (peerAborted || socket.destroyed || !socket.writable) return;
    finishSocket(encodeFastManimSandboxBrokerServerFrameV1(kind, message));
  };

  const sendError = (kind: CapacityKind, code: "capacity" | "cleanup" | "internal" | "unavailable") => {
    send(kind, { code, kind: "error" });
  };

  const runStatus = async (request: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "status" }>) => {
    if (!deadlineAccepted(request.deadlineEpochMs)) {
      sendError("status", "unavailable");
      return;
    }
    const release = options.acquire("status");
    if (!release) {
      sendError("status", "capacity");
      return;
    }
    const timer = setTimeout(abort, Math.max(1, request.deadlineEpochMs - Date.now()));
    timer.unref();
    try {
      const status = await backend.status({
        deadlineEpochMs: request.deadlineEpochMs,
        identity: request.identity,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        send("status", { kind: "status-result", status: fastManimSandboxBackendStatusV1Schema.parse(status) });
      }
    } catch {
      if (!controller.signal.aborted) sendError("status", "unavailable");
    } finally {
      clearTimeout(timer);
      release();
    }
  };

  const runStart = async (request: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>) => {
    if (!deadlineAccepted(request.deadlineEpochMs)) {
      sendError("start", "unavailable");
      return;
    }
    const release = options.acquire("start");
    if (!release) {
      sendError("start", "capacity");
      return;
    }
    let bundle: FastManimSandboxRequestBundleV1;
    try {
      const bytes = decodeFastManimSandboxBrokerRequestBytesV1(request.requestBytesBase64);
      if (createHash("sha256").update(bytes).digest("hex") !== request.requestDigest) throw new Error();
      const producer = fastManimSnapshotProducerRequestV1Schema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (producer.projectId !== request.identity.projectId || producer.requestId !== request.identity.requestId) {
        throw new Error();
      }
      bundle = new FastManimSandboxRequestBundleV1(producer);
      if (!Buffer.from(bundle.copyBytes()).equals(Buffer.from(bytes))) throw new Error();
    } catch {
      release();
      sendError("start", "internal");
      return;
    }

    const timer = setTimeout(abort, Math.max(1, request.deadlineEpochMs - Date.now()));
    timer.unref();
    let backendResult: Promise<unknown>;
    let capturedAbort: (() => void) | undefined;
    try {
      const handle = backend.start(bundle, {
        attestationDigest: request.attestationDigest,
        deadlineEpochMs: request.deadlineEpochMs,
        identity: request.identity,
        signal: controller.signal,
      });
      const abortMember = handle?.abort;
      const resultMember = handle?.result;
      if (typeof abortMember === "function") capturedAbort = () => Reflect.apply(abortMember, handle, []);
      if (!capturedAbort || !(resultMember instanceof Promise)) throw new Error();
      abortBackend = capturedAbort;
      backendResult = resultMember;
    } catch (error) {
      abort();
      try {
        capturedAbort?.();
      } catch {
        // Cleanup uncertainty is latched below.
      }
      clearTimeout(timer);
      release();
      const control = fastManimSandboxBackendControlErrorCode(error);
      sendError("start", control ?? "cleanup");
      if (control !== "capacity") onCleanupFailure();
      return;
    }

    try {
      const parsed = fastManimSandboxBackendResultV1Schema.parse(await backendResult);
      if (controller.signal.aborted) return;
      if (parsed.requestDigest !== request.requestDigest || parsed.attestationDigest !== request.attestationDigest) {
        throw new Error();
      }
      if (parsed.kind === "ok") {
        const { resultBytes, ...correlation } = parsed;
        send("start", {
          kind: "job-result",
          result: {
            ...correlation,
            resultBytesBase64: encodeFastManimSandboxBrokerResultBytesV1(
              copyFastManimSandboxUint8ArrayV1(resultBytes, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES),
            ),
          },
        });
      } else send("start", { kind: "job-result", result: parsed });
    } catch (error) {
      if (controller.signal.aborted) return;
      const control = fastManimSandboxBackendControlErrorCode(error);
      sendError("start", control ?? "internal");
      if (control !== "capacity") onCleanupFailure();
    } finally {
      clearTimeout(timer);
      release();
    }
  };

  const begin = (request: FastManimSandboxBrokerClientMessageV1) => {
    requestSeen = true;
    operation = (request.kind === "status" ? runStatus(request) : runStart(request))
      .catch(() => onCleanupFailure())
      .finally(() => {
        operationFinished = true;
        if (peerAborted) finishSocket();
      });
  };

  const connection: BrokerConnection = {
    close() {
      closeRequest ??= (async () => {
        peerAborted = true;
        if (!operationFinished) abort();
        const settled = await settleWithin(operation ?? Promise.resolve(), options.closeTimeoutMs);
        socket.destroy();
        if (!settled) {
          onCleanupFailure();
          throw new FastManimSandboxBackendControlError("cleanup");
        }
      })().finally(() => onClosed(connection));
      return closeRequest;
    },
  };

  socket.on("data", (chunk: Buffer) => {
    try {
      const request = decoder.push(chunk);
      if (request) begin(request);
    } catch {
      socket.destroy();
    }
  });
  socket.once("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
      return;
    }
    peerAborted = true;
    if (!operationFinished) abort();
    else finishSocket();
  });
  socket.once("error", () => undefined);
  socket.once("close", () => {
    peerAborted = true;
    if (requestSeen && !operationFinished) abort();
    void connection.close().catch(() => undefined);
  });
  return connection;
}

/** Starts the separately supervised, filesystem-permission-gated broker. */
export async function startFastManimSandboxBrokerServerV1(
  options: FastManimSandboxBrokerServerOptionsV1,
): Promise<FastManimSandboxBrokerServerV1> {
  if (!options?.backend || typeof options.backend.start !== "function") throw new TypeError("A backend is required.");
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "Broker close timeout");
  if (closeTimeoutMs > MAX_CLOSE_TIMEOUT_MS) throw new TypeError("Broker close timeout exceeds its maximum.");
  const maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, "Broker connection limit");
  const maxJobs = positiveInteger(options.maxConcurrentJobs, DEFAULT_MAX_JOBS, "Broker job limit");
  const maxStatuses = positiveInteger(options.maxConcurrentStatuses, DEFAULT_MAX_STATUSES, "Broker status limit");
  const socketGroupId = unixGroupId(options.socketGroupId);
  const effectiveUid = await validateSocketPath(options.socketPath);
  options.signal?.throwIfAborted();

  let lease: Awaited<ReturnType<typeof acquireFastManimSandboxBrokerLeaseV1>>;
  try {
    lease = await acquireFastManimSandboxBrokerLeaseV1(options.socketPath);
  } catch (error) {
    const closed = await settleWithin(
      Promise.resolve().then(() => options.backend.close()),
      closeTimeoutMs,
    );
    if (!closed) throw new AggregateError([error, new FastManimSandboxBackendControlError("cleanup")]);
    throw error;
  }

  const connections = new Set<BrokerConnection>();
  let activeJobs = 0;
  let activeStatuses = 0;
  let accepting = false;
  let closeRequest: Promise<void> | null = null;
  let closeBroker!: () => Promise<void>;
  const acquire = (kind: CapacityKind) => {
    if (kind === "start") {
      if (activeJobs >= maxJobs) return undefined;
      activeJobs += 1;
      return () => {
        activeJobs -= 1;
      };
    }
    if (activeStatuses >= maxStatuses) return undefined;
    activeStatuses += 1;
    return () => {
      activeStatuses -= 1;
    };
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!accepting) return socket.destroy();
    const connection = createBrokerConnection(
      socket,
      options.backend,
      { acquire, closeTimeoutMs },
      (closed) => connections.delete(closed),
      () => {
        accepting = false;
        void closeBroker().catch(() => undefined);
      },
    );
    connections.add(connection);
  });
  server.maxConnections = maxConnections;

  try {
    await listen(server, options.socketPath);
    await chown(options.socketPath, effectiveUid, socketGroupId);
    await chmod(options.socketPath, 0o660);
    const metadata = await lstat(options.socketPath);
    if (
      !metadata.isSocket() ||
      metadata.uid !== effectiveUid ||
      metadata.gid !== socketGroupId ||
      (metadata.mode & 0o777) !== 0o660
    ) {
      throw new Error("The sandbox broker socket permissions are not closed.");
    }
    if (options.reconcileOrphans) await options.reconcileOrphans(options.signal ?? new AbortController().signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    const resources = Promise.allSettled([
      closeListener(server),
      Promise.resolve().then(() => options.backend.close()),
    ]);
    if (!(await settleWithin(resources, closeTimeoutMs))) {
      throw new AggregateError([error, new FastManimSandboxBackendControlError("cleanup")]);
    }
    const cleanup = await resources;
    const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors]);
    await lease.close();
    throw error;
  }
  accepting = true;

  const abortFromSignal = () => void closeBroker().catch(() => undefined);
  closeBroker = () => {
    closeRequest ??= (async () => {
      accepting = false;
      options.signal?.removeEventListener("abort", abortFromSignal);
      const errors: unknown[] = [];
      const listenerClosed = closeListener(server);
      const connectionCleanup = Promise.all([...connections].map((connection) => connection.close()));
      if (!(await settleWithin(connectionCleanup, closeTimeoutMs))) {
        errors.push(new FastManimSandboxBackendControlError("cleanup"));
      }
      if (!(await settleWithin(listenerClosed, closeTimeoutMs))) {
        errors.push(new FastManimSandboxBackendControlError("cleanup"));
      }
      if (
        !(await settleWithin(
          Promise.resolve().then(() => options.backend.close()),
          closeTimeoutMs,
        ))
      ) {
        errors.push(new FastManimSandboxBackendControlError("cleanup"));
      }
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
  return { close: closeBroker, socketPath: options.socketPath };
}
