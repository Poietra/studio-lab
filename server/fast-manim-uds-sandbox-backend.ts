import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

import {
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  fastManimSandboxBackendControlErrorCode,
  fastManimSandboxBackendResultV1Schema,
  fastManimSandboxBackendStatusV1Schema,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  decodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  type FastManimSandboxBrokerClientMessageV1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
  fastManimSandboxBrokerServerMessageV1Schema,
} from "./fast-manim-sandbox-broker-protocol";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CLOSE_TIMEOUT_MS = 60_000;
/** Conservative bound shared with the broker's Unix-socket listener. */
export const MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1 = 96;

export type FastManimUdsSandboxBackendOptionsV1 = Readonly<{
  closeTimeoutMs?: number;
  socketPath: string;
}>;

type StatusPending = Readonly<{
  correlationId: string;
  kind: "status";
  reject: (reason: unknown) => void;
  resolve: (status: FastManimSandboxBackendStatusV1) => void;
}> & { aborted: boolean; cleanup: () => void };

type JobPending = Readonly<{
  attestationDigest: string;
  correlationId: string;
  jobId: string;
  kind: "start";
  reject: (reason: unknown) => void;
  requestDigest: string;
  resolve: (result: FastManimSandboxBackendResultV1) => void;
}> & { aborted: boolean; abortSent: boolean; cleanup: () => void; dispatched: boolean };

type AbortPending = Readonly<{
  correlationId: string;
  jobId: string;
  kind: "abort";
}>;

type ClosePending = Readonly<{
  correlationId: string;
  kind: "close";
}>;

type Pending = AbortPending | ClosePending | JobPending | StatusPending;

function validateSocketPath(socketPath: string) {
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath, "utf8") > MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1
  ) {
    throw new TypeError("The sandbox broker socket path must be an absolute, bounded Unix socket path.");
  }
  return socketPath;
}

function validateCloseTimeoutMs(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CLOSE_TIMEOUT_MS) {
    throw new TypeError(`The sandbox broker close timeout must be an integer from 1 to ${MAX_CLOSE_TIMEOUT_MS}ms.`);
  }
  return value;
}

function validateDeadline(deadlineEpochMs: number, label: string) {
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) {
    throw new TypeError(`${label} must be a positive epoch millisecond integer.`);
  }
}

function transportError() {
  const error = new Error("The sandbox broker connection failed closed.");
  error.name = "FastManimSandboxBrokerTransportError";
  return error;
}

function abortError() {
  const error = new Error("The sandbox broker operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Studio-side production boundary for a separately managed sandbox broker.
 * The connection itself is the broker session: operations multiplex by
 * correlationId, while jobId is stable across start and abort.
 */
export class FastManimUdsSandboxBackendV1 implements FastManimSandboxBackendV1 {
  readonly #closeTimeoutMs: number;
  readonly #decoder = new FastManimSandboxBrokerFrameDecoderV1();
  readonly #jobs = new Map<string, JobPending>();
  readonly #pending = new Map<string, Pending>();
  readonly #socketPath: string;
  #closePromise: Promise<void> | undefined;
  #closeReject: ((reason: unknown) => void) | undefined;
  #closeResolve: (() => void) | undefined;
  #closeTimer: NodeJS.Timeout | undefined;
  #connection: Promise<Socket> | undefined;
  #failed = false;
  #closing = false;
  #closed = false;
  #socket: Socket | undefined;
  #terminalError: Error | undefined;

  constructor(options: FastManimUdsSandboxBackendOptionsV1) {
    this.#socketPath = validateSocketPath(options.socketPath);
    this.#closeTimeoutMs = validateCloseTimeoutMs(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    const identity = parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs, "Sandbox broker status deadline");
    context.signal.throwIfAborted();
    if (this.#closing || this.#closed) throw abortError();
    if (this.#failed) throw this.#terminalError ?? transportError();

    return await new Promise<FastManimSandboxBackendStatusV1>((resolve, reject) => {
      const correlationId = this.#nextId("status");
      const pending: StatusPending = {
        aborted: false,
        cleanup: () => undefined,
        correlationId,
        kind: "status",
        reject,
        resolve,
      };
      const onAbort = () => {
        if (pending.aborted) return;
        pending.aborted = true;
        pending.cleanup();
        reject(abortError());
      };
      pending.cleanup = () => context.signal.removeEventListener("abort", onAbort);
      this.#pending.set(correlationId, pending);
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
      this.#queue({
        correlationId,
        deadlineEpochMs: context.deadlineEpochMs,
        identity,
        kind: "status",
        protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
        version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
      });
    });
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const identity = parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs, "Sandbox broker job deadline");
    if (!verifyFastManimSandboxRequestBundleV1(request)) {
      throw new TypeError("Sandbox request bytes do not match their canonical digest.");
    }
    context.signal.throwIfAborted();

    let abort: () => void = () => undefined;
    const result = new Promise<FastManimSandboxBackendResultV1>((resolve, reject) => {
      if (this.#closing || this.#closed) {
        reject(abortError());
        return;
      }
      if (this.#failed) {
        reject(this.#terminalError ?? transportError());
        return;
      }

      const correlationId = this.#nextId("start");
      const jobId = this.#nextId("job");
      const pending: JobPending = {
        aborted: false,
        abortSent: false,
        attestationDigest: context.attestationDigest,
        cleanup: () => undefined,
        correlationId,
        dispatched: false,
        jobId,
        kind: "start",
        reject,
        requestDigest: request.requestDigest,
        resolve,
      };
      abort = () => this.#abortJob(pending);
      const onAbort = () => abort();
      pending.cleanup = () => context.signal.removeEventListener("abort", onAbort);
      this.#jobs.set(jobId, pending);
      this.#pending.set(correlationId, pending);
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
      this.#queue({
        attestationDigest: context.attestationDigest,
        correlationId,
        deadlineEpochMs: context.deadlineEpochMs,
        identity,
        jobId,
        kind: "start",
        protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
        requestBytesBase64: encodeFastManimSandboxBrokerRequestBytesV1(request.copyBytes()),
        requestDigest: request.requestDigest,
        version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
      });
      pending.dispatched = true;
      if (pending.aborted) this.#sendAbort(pending);
    });
    return { abort: () => abort(), result };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed || this.#failed) return Promise.resolve();
    this.#closing = true;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#closeReject = reject;
      this.#closeResolve = resolve;
    });
    for (const job of [...this.#jobs.values()]) this.#abortJob(job);
    if (!this.#socket) {
      this.#finishClose();
      return this.#closePromise;
    }

    const correlationId = this.#nextId("close");
    this.#pending.set(correlationId, { correlationId, kind: "close" });
    this.#queue({
      correlationId,
      kind: "close",
      protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
      version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
    });
    this.#closeTimer = setTimeout(
      () => this.#finishClose(new FastManimSandboxBackendControlError("cleanup")),
      this.#closeTimeoutMs,
    );
    this.#closeTimer.unref();
    return this.#closePromise;
  }

  #abortJob(job: JobPending) {
    if (job.aborted || this.#jobs.get(job.jobId) !== job) return;
    job.aborted = true;
    job.cleanup();
    job.reject(abortError());
    if (job.dispatched) this.#sendAbort(job);
  }

  #sendAbort(job: JobPending) {
    if (job.abortSent) return;
    job.abortSent = true;
    const correlationId = this.#nextId("abort");
    this.#pending.set(correlationId, { correlationId, jobId: job.jobId, kind: "abort" });
    this.#queue({
      correlationId,
      jobId: job.jobId,
      kind: "abort",
      protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
      version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
    });
  }

  #nextId(prefix: string) {
    let candidate: string;
    do candidate = `${prefix}-${randomUUID()}`;
    while (this.#pending.has(candidate) || this.#jobs.has(candidate));
    return candidate;
  }

  #queue(message: FastManimSandboxBrokerClientMessageV1) {
    let frame: Uint8Array;
    try {
      frame = encodeFastManimSandboxBrokerFrameV1(message);
    } catch {
      this.#fail(transportError());
      return;
    }
    void this.#connect()
      .then((socket) => {
        if (this.#failed || this.#closed) return;
        socket.write(frame, (error) => {
          if (error) this.#fail(transportError());
        });
      })
      .catch(() => undefined);
  }

  #connect() {
    if (this.#connection) return this.#connection;
    const socket = new Socket();
    this.#socket = socket;
    this.#connection = new Promise<Socket>((resolve, reject) => {
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        resolve(socket);
      });
      socket.once("error", () => {
        if (!connected) reject(transportError());
      });
      socket.once("close", () => {
        if (!connected) reject(transportError());
      });
    });
    this.#connection.catch(() => this.#fail(transportError()));
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") this.#fail(transportError());
      else this.#onData(chunk);
    });
    socket.on("end", () => {
      try {
        this.#decoder.finish();
      } catch {
        this.#fail(transportError());
        return;
      }
      this.#onTransportClosed();
    });
    socket.on("error", () => this.#fail(transportError()));
    socket.on("close", () => this.#onTransportClosed());
    socket.connect(this.#socketPath);
    return this.#connection;
  }

  #onData(chunk: Uint8Array) {
    if (this.#failed || this.#closed) return;
    try {
      for (const rawMessage of this.#decoder.push(chunk)) {
        const message = fastManimSandboxBrokerServerMessageV1Schema.parse(rawMessage);
        this.#onMessage(message);
      }
    } catch {
      this.#fail(transportError());
    }
  }

  #onMessage(message: FastManimSandboxBrokerServerMessageV1) {
    const pending = this.#pending.get(message.correlationId);
    if (!pending) throw new Error("Unexpected sandbox broker correlation.");
    if (message.kind === "error") {
      this.#onBrokerError(pending, message.operation, message.code);
      return;
    }
    if (message.kind === "status-result") {
      if (pending.kind !== "status") throw new Error("Mismatched sandbox broker response.");
      this.#deletePending(pending);
      const status = fastManimSandboxBackendStatusV1Schema.parse(message.status);
      if (!pending.aborted) pending.resolve(status);
      return;
    }
    if (message.kind === "job-result") {
      if (pending.kind !== "start" || pending.jobId !== message.jobId) {
        throw new Error("Mismatched sandbox broker response.");
      }
      const result = fastManimSandboxBackendResultV1Schema.parse(
        message.result.kind === "ok"
          ? {
              attestationDigest: message.result.attestationDigest,
              kind: "ok",
              requestDigest: message.result.requestDigest,
              resultBytes: decodeFastManimSandboxBrokerResultBytesV1(message.result.resultBytesBase64),
            }
          : message.result,
      );
      if (result.requestDigest !== pending.requestDigest || result.attestationDigest !== pending.attestationDigest) {
        throw new Error("Mismatched sandbox broker result identity.");
      }
      this.#deletePending(pending);
      if (!pending.aborted) pending.resolve(result);
      return;
    }
    if (message.kind === "abort-ack") {
      if (pending.kind !== "abort" || pending.jobId !== message.jobId) {
        throw new Error("Mismatched sandbox broker response.");
      }
      this.#deletePending(pending);
      const job = this.#jobs.get(message.jobId);
      if (job?.aborted) this.#deletePending(job);
      return;
    }
    if (pending.kind !== "close" || message.kind !== "close-ack") {
      throw new Error("Mismatched sandbox broker response.");
    }
    this.#deletePending(pending);
    this.#finishClose();
  }

  #onBrokerError(pending: Pending, operation: "abort" | "close" | "start" | "status", code: string) {
    if (pending.kind !== operation) throw new Error("Mismatched sandbox broker error.");
    const error =
      code === "capacity" || code === "cleanup"
        ? new FastManimSandboxBackendControlError(code)
        : new Error("The sandbox broker rejected the operation.");
    this.#deletePending(pending);
    if (pending.kind === "status" || pending.kind === "start") pending.reject(error);
    if (pending.kind === "abort") {
      const job = this.#jobs.get(pending.jobId);
      if (job) this.#deletePending(job);
    }
    if (pending.kind === "close") this.#finishClose(new FastManimSandboxBackendControlError("cleanup"));
    else if (code === "cleanup") this.#fail(error);
  }

  #deletePending(pending: Pending) {
    this.#pending.delete(pending.correlationId);
    if (pending.kind === "status") pending.cleanup();
    if (pending.kind === "start") {
      pending.cleanup();
      this.#jobs.delete(pending.jobId);
    }
  }

  #onTransportClosed() {
    if (this.#closed || this.#failed) return;
    if (this.#closing) this.#finishClose(new FastManimSandboxBackendControlError("cleanup"));
    else this.#fail(transportError());
  }

  #fail(error: Error) {
    if (this.#closed || this.#failed) return;
    if (this.#closing) {
      this.#finishClose(
        fastManimSandboxBackendControlErrorCode(error) === "cleanup"
          ? error
          : new FastManimSandboxBackendControlError("cleanup"),
      );
      return;
    }
    this.#failed = true;
    this.#terminalError = error;
    this.#socket?.destroy();
    for (const pending of this.#pending.values()) {
      if (pending.kind === "status" || pending.kind === "start") pending.reject(error);
      this.#deletePending(pending);
    }
  }

  #finishClose(error?: unknown) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#socket?.destroy();
    const pendingError = abortError();
    for (const pending of this.#pending.values()) {
      if (pending.kind === "status" || pending.kind === "start") pending.reject(pendingError);
      this.#deletePending(pending);
    }
    if (error === undefined) this.#closeResolve?.();
    else this.#closeReject?.(error);
  }
}
