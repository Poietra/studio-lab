import { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

import {
  encodeManimRenderSandboxBrokerClientFrameV1,
  type ManimRenderSandboxBrokerClientMessageV1,
  type ManimRenderSandboxBrokerOperationV1,
  ManimRenderSandboxBrokerServerFrameDecoderV1,
  type ManimRenderSandboxBrokerServerMessageV1,
} from "./manim-render-sandbox-broker-protocol";
import type { ManimRenderSandboxBackendV1, ManimRenderSandboxOperationContextV1 } from "./manim-render-sandbox-backend";
import {
  manimRenderSandboxStatusV1Schema,
  manimRenderSandboxTerminalV1Schema,
  manimRenderStagingIdV1,
  type SealedManimRenderSandboxRequestV2,
  verifySealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";

const MAX_ACTIVE_OPERATIONS = 16;
const MAX_ACTIVE_SUBMISSIONS = 8;
const MAX_SOCKET_PATH_BYTES = 96;

function transportError() {
  return new Error("The render sandbox broker transport failed closed.");
}

function abortError() {
  return new DOMException("The render sandbox broker operation was aborted.", "AbortError");
}

function validateDeadline(value: number) {
  if (!Number.isSafeInteger(value) || value <= Date.now()) {
    throw new TypeError("The render sandbox broker deadline must be a future epoch millisecond.");
  }
}

type ActiveOperation = Readonly<{
  abort: () => void;
  kind: ManimRenderSandboxBrokerOperationV1;
  result: Promise<unknown>;
}>;

export class ManimRenderUdsSandboxBackendV1 implements ManimRenderSandboxBackendV1 {
  readonly #active = new Set<ActiveOperation>();
  readonly #socketPath: string;
  #closed = false;

  constructor(options: Readonly<{ socketPath: string }>) {
    if (
      !isAbsolute(options.socketPath) ||
      resolve(options.socketPath) !== options.socketPath ||
      options.socketPath.includes("\0") ||
      Buffer.byteLength(options.socketPath, "utf8") > MAX_SOCKET_PATH_BYTES
    ) {
      throw new TypeError("The render broker socket path must be bounded, canonical, and absolute.");
    }
    this.#socketPath = options.socketPath;
  }

  status(context: ManimRenderSandboxOperationContextV1) {
    return this.#open("status", { deadlineEpochMs: context.deadlineEpochMs, kind: "status" }, context, (message) => {
      if (message.kind !== "status-result") throw transportError();
      return manimRenderSandboxStatusV1Schema.parse(message.status);
    });
  }

  submitOrReattach(request: SealedManimRenderSandboxRequestV2, context: ManimRenderSandboxOperationContextV1) {
    if (!verifySealedManimRenderSandboxRequestV2(request)) {
      return Promise.reject(new TypeError("The render sandbox request seal is invalid."));
    }
    const descriptor = request.parseDescriptor();
    return this.#open(
      "submit",
      {
        deadlineEpochMs: context.deadlineEpochMs,
        kind: "submit",
        requestBytesBase64: Buffer.from(request.copyBytes()).toString("base64"),
        requestDigest: request.requestDigest,
      },
      context,
      (message) => {
        if (message.kind !== "job-result") throw transportError();
        const result = manimRenderSandboxTerminalV1Schema.parse(message.result);
        if (
          result.deadlineEpochMs !== descriptor.deadlineEpochMs ||
          result.fenceToken !== descriptor.fenceToken ||
          result.jobId !== descriptor.jobId ||
          result.profileDigest !== descriptor.profileDigest ||
          result.requestDigest !== request.requestDigest ||
          result.runtimeDigest !== descriptor.runtimeDigest ||
          result.sessionId !== descriptor.sessionId ||
          result.sourceDigest !== descriptor.sourceDigest ||
          result.tenantId !== descriptor.tenantId ||
          (result.kind === "ready" &&
            (result.mediaType !== descriptor.output.mediaType ||
              result.stagingId !== manimRenderStagingIdV1(descriptor.jobId, descriptor.output.kind)))
        ) {
          throw transportError();
        }
        return result;
      },
    );
  }

  async cancel(jobId: string, context: ManimRenderSandboxOperationContextV1) {
    await this.#open(
      "cancel",
      { deadlineEpochMs: context.deadlineEpochMs, jobId, kind: "cancel" },
      context,
      (message) => {
        if (message.kind !== "cancel-result" || message.cancelled !== true) throw transportError();
      },
    );
  }

  async close() {
    this.#closed = true;
    for (const operation of this.#active) operation.abort();
    await Promise.allSettled([...this.#active].map((operation) => operation.result));
  }

  #open<T>(
    operationKind: ManimRenderSandboxBrokerOperationV1,
    message: ManimRenderSandboxBrokerClientMessageV1,
    context: ManimRenderSandboxOperationContextV1,
    decode: (message: ManimRenderSandboxBrokerServerMessageV1) => T,
  ): Promise<T> {
    validateDeadline(context.deadlineEpochMs);
    context.signal.throwIfAborted();
    if (this.#closed) return Promise.reject(abortError());
    if (
      this.#active.size >= MAX_ACTIVE_OPERATIONS ||
      (operationKind === "submit" &&
        [...this.#active].filter((operation) => operation.kind === "submit").length >= MAX_ACTIVE_SUBMISSIONS)
    ) {
      return Promise.reject(new Error("Render broker capacity is exhausted."));
    }
    const socket = new Socket({ allowHalfOpen: true });
    const decoder = new ManimRenderSandboxBrokerServerFrameDecoderV1(operationKind);
    let settled = false;
    let pendingResponse: T | undefined;
    let responseSeen = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let active!: ActiveOperation;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      context.signal.removeEventListener("abort", abort);
      this.#active.delete(active);
    };
    const settle = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveResult(value as T);
      else rejectResult(error);
    };
    const abort = () => {
      settle(abortError());
      socket.destroy();
    };
    active = { abort, kind: operationKind, result };
    this.#active.add(active);
    context.signal.addEventListener("abort", abort, { once: true });
    deadlineTimer = setTimeout(abort, Math.max(1, context.deadlineEpochMs - Date.now()));
    deadlineTimer.unref();
    socket.once("connect", () => socket.end(encodeManimRenderSandboxBrokerClientFrameV1(message)));
    socket.on("data", (chunk) => {
      if (settled) return;
      try {
        if (typeof chunk === "string") throw transportError();
        const response = decoder.push(chunk);
        if (response) {
          pendingResponse = decode(response);
          responseSeen = true;
        }
      } catch {
        settle(transportError());
        socket.destroy();
      }
    });
    socket.once("end", () => {
      try {
        decoder.finish();
        if (!responseSeen) throw transportError();
        settle(undefined, pendingResponse);
      } catch {
        settle(transportError());
      }
    });
    socket.once("error", () => settle(transportError()));
    socket.once("close", () => {
      if (!settled) settle(transportError());
    });
    try {
      socket.connect(this.#socketPath);
    } catch {
      settle(transportError());
      socket.destroy();
    }
    return result;
  }
}
