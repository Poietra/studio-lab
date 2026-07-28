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
  fastManimSandboxBackendResultV1Schema,
  fastManimSandboxBackendStatusV1Schema,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  decodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerClientFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  type FastManimSandboxBrokerClientMessageV1,
  type FastManimSandboxBrokerOperationV1,
  FastManimSandboxBrokerServerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
} from "./fast-manim-sandbox-broker-protocol";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CLOSE_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_JOBS = 4;
const MAX_CONCURRENT_STATUSES = 8;
export const MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1 = 96;

export type FastManimUdsSandboxBackendOptionsV1 = Readonly<{
  closeTimeoutMs?: number;
  socketPath: string;
}>;

type ClientOperation = Readonly<{
  abort: () => void;
  cleanup: Promise<void>;
}>;

type ClientOperationWithResult<T> = ClientOperation & Readonly<{ result: Promise<T> }>;

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

function closeTimeout(value: number | undefined) {
  const parsed = value ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CLOSE_TIMEOUT_MS) {
    throw new TypeError(`Close timeout must be an integer from 1 to ${MAX_CLOSE_TIMEOUT_MS}.`);
  }
  return parsed;
}

function validateDeadline(deadlineEpochMs: number, label: string) {
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {
    throw new TypeError(`${label} must be a future epoch millisecond integer.`);
  }
}

function abortError() {
  return new DOMException("The sandbox broker operation was aborted.", "AbortError");
}

function transportError() {
  const error = new Error("The sandbox broker connection failed closed.");
  error.name = "FastManimSandboxBrokerTransportError";
  return error;
}

function brokerError(code: "capacity" | "cleanup" | "internal" | "unavailable") {
  return code === "capacity" || code === "cleanup"
    ? new FastManimSandboxBackendControlError(code)
    : new Error("The sandbox broker rejected the operation.");
}

/** Studio-side adapter. Each UDS connection owns exactly one backend operation. */
export class FastManimUdsSandboxBackendV1 implements FastManimSandboxBackendV1 {
  readonly #closeTimeoutMs: number;
  readonly #operations = new Set<ClientOperation>();
  readonly #socketPath: string;
  #activeJobs = 0;
  #activeStatuses = 0;
  #cleanupFailed = false;
  #closePromise: Promise<void> | undefined;
  #closing = false;

  constructor(options: FastManimUdsSandboxBackendOptionsV1) {
    this.#socketPath = validateSocketPath(options.socketPath);
    this.#closeTimeoutMs = closeTimeout(options.closeTimeoutMs);
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    const identity = parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs, "Sandbox broker status deadline");
    context.signal.throwIfAborted();
    this.#assertOpen();
    if (this.#activeStatuses >= MAX_CONCURRENT_STATUSES) throw new FastManimSandboxBackendControlError("capacity");
    this.#activeStatuses += 1;
    let operation: ClientOperationWithResult<FastManimSandboxBackendStatusV1>;
    try {
      operation = this.#open<FastManimSandboxBackendStatusV1>(
        "status",
        { deadlineEpochMs: context.deadlineEpochMs, identity, kind: "status" },
        context.signal,
        (message) => {
          if (message.kind !== "status-result") throw transportError();
          return fastManimSandboxBackendStatusV1Schema.parse(message.status);
        },
        () => {
          this.#activeStatuses -= 1;
        },
      );
    } catch (error) {
      this.#activeStatuses -= 1;
      throw error;
    }
    return await operation.result;
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const identity = parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs, "Sandbox broker job deadline");
    if (!verifyFastManimSandboxRequestBundleV1(request)) {
      throw new TypeError("Sandbox request bytes do not match their canonical digest.");
    }
    context.signal.throwIfAborted();
    try {
      this.#assertOpen();
    } catch (error) {
      return { abort() {}, result: Promise.reject(error) };
    }
    if (this.#activeJobs >= MAX_CONCURRENT_JOBS) {
      return {
        abort() {},
        result: Promise.reject(new FastManimSandboxBackendControlError("capacity")),
      };
    }
    this.#activeJobs += 1;
    let operation: ClientOperationWithResult<FastManimSandboxBackendResultV1>;
    try {
      operation = this.#open<FastManimSandboxBackendResultV1>(
        "start",
        {
          attestationDigest: context.attestationDigest,
          deadlineEpochMs: context.deadlineEpochMs,
          identity,
          kind: "start",
          requestBytesBase64: encodeFastManimSandboxBrokerRequestBytesV1(request.copyBytes()),
          requestDigest: request.requestDigest,
        },
        context.signal,
        (message) => {
          if (message.kind !== "job-result") throw transportError();
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
          if (
            result.requestDigest !== request.requestDigest ||
            result.attestationDigest !== context.attestationDigest
          ) {
            throw transportError();
          }
          return result;
        },
        () => {
          this.#activeJobs -= 1;
        },
      );
    } catch (error) {
      this.#activeJobs -= 1;
      return { abort() {}, result: Promise.reject(error) };
    }
    return { abort: operation.abort, result: operation.result };
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    for (const operation of this.#operations) operation.abort();
    this.#closePromise = Promise.allSettled([...this.#operations].map((operation) => operation.cleanup)).then(
      (settled) => {
        if (this.#cleanupFailed || settled.some((result) => result.status === "rejected")) {
          throw new FastManimSandboxBackendControlError("cleanup");
        }
      },
    );
    return this.#closePromise;
  }

  #assertOpen() {
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
    if (this.#closing) throw abortError();
  }

  #open<T>(
    kind: FastManimSandboxBrokerOperationV1,
    message: FastManimSandboxBrokerClientMessageV1,
    signal: AbortSignal,
    decode: (response: FastManimSandboxBrokerServerMessageV1) => T,
    release: () => void,
  ) {
    const decoder = new FastManimSandboxBrokerServerFrameDecoderV1(kind);
    const frame = encodeFastManimSandboxBrokerClientFrameV1(message);
    const socket = new Socket({ allowHalfOpen: true });
    let aborted = false;
    let connected = false;
    let dispatched = false;
    let remoteEnded = false;
    let pendingResponse: Readonly<{ error: unknown; kind: "error" }> | Readonly<{ kind: "value"; value: T }>;
    let responseSeen = false;
    let resultSettled = false;
    let transportFailed = false;
    let cleanupSettled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    let resolveCleanup!: () => void;
    let rejectCleanup!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const cleanup = new Promise<void>((resolve, reject) => {
      resolveCleanup = resolve;
      rejectCleanup = reject;
    });
    void cleanup.catch(() => undefined);

    const settleResult = (error: unknown, value?: T) => {
      if (resultSettled) return;
      resultSettled = true;
      if (error === undefined) resolveResult(value as T);
      else rejectResult(error);
    };
    const failTransport = () => {
      transportFailed = true;
      settleResult(transportError());
    };
    const settleCleanup = (error?: unknown) => {
      if (cleanupSettled) return;
      cleanupSettled = true;
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", abort);
      this.#operations.delete(operation);
      release();
      if (error === undefined) resolveCleanup();
      else {
        this.#cleanupFailed = true;
        rejectCleanup(error);
      }
    };
    const startCleanupTimer = () => {
      cleanupTimer ??= setTimeout(() => {
        socket.destroy();
        settleCleanup(new FastManimSandboxBackendControlError("cleanup"));
      }, this.#closeTimeoutMs);
      cleanupTimer.unref();
    };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      settleResult(abortError());
      if (!connected || !dispatched) {
        socket.destroy();
        settleCleanup();
        return;
      }
      startCleanupTimer();
      socket.end();
    };
    const operation: ClientOperationWithResult<T> = { abort, cleanup, result };
    this.#operations.add(operation);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    socket.once("connect", () => {
      connected = true;
      if (aborted || this.#closing) {
        abort();
        if (!socket.destroyed) socket.destroy();
        settleCleanup();
        return;
      }
      dispatched = true;
      socket.write(frame, (error) => {
        if (error) socket.destroy();
      });
    });
    socket.on("data", (chunk) => {
      if (aborted) return;
      let response: FastManimSandboxBrokerServerMessageV1 | undefined;
      try {
        if (typeof chunk === "string") throw transportError();
        response = decoder.push(chunk);
      } catch {
        failTransport();
        socket.destroy();
        return;
      }
      if (!response) return;
      responseSeen = true;
      if (response.kind === "error") {
        const error = brokerError(response.code);
        if (response.code === "cleanup") this.#cleanupFailed = true;
        pendingResponse = { error, kind: "error" };
      } else {
        try {
          pendingResponse = { kind: "value", value: decode(response) };
        } catch {
          pendingResponse = { error: transportError(), kind: "error" };
        }
      }
    });
    socket.once("end", () => {
      remoteEnded = true;
      if (!aborted) {
        try {
          decoder.finish();
          if (!responseSeen || !pendingResponse) throw transportError();
          if (pendingResponse.kind === "error") settleResult(pendingResponse.error);
          else settleResult(undefined, pendingResponse.value);
        } catch {
          failTransport();
        }
      }
      socket.end();
    });
    socket.once("error", () => {
      failTransport();
    });
    socket.once("close", () => {
      if (!resultSettled) failTransport();
      if (!dispatched || (remoteEnded && !transportFailed && (aborted || responseSeen))) settleCleanup();
      else settleCleanup(new FastManimSandboxBackendControlError("cleanup"));
    });
    try {
      if (!aborted) socket.connect(this.#socketPath);
    } catch {
      socket.destroy();
      failTransport();
      settleCleanup();
    }
    return operation;
  }
}
