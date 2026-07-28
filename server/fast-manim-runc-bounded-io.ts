import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { FastManimSandboxBoundedOutputLifecycleV1 } from "./fast-manim-linux-cgroup-v2";
import { copyFastManimSandboxUint8ArrayV1, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES } from "./fast-manim-sandbox-backend";
import {
  FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1,
  FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1,
  type FastManimSandboxResourceLimitsV1,
  parseFastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

export type FastManimRuncOutputOverflowV1 = "result-overflow" | "stderr-overflow" | "stdout-overflow";

export type FastManimRuncStdioV1 = Readonly<{
  stderr: Readable;
  stdin: Writable;
  stdout: Readable;
}>;

export type FastManimRuncStderrEvidenceV1 = Readonly<{
  byteCount: number;
  sha256: string | null;
}>;

export type FastManimRuncBoundedIoV1 = Readonly<{
  /** Binds exactly one set of already-created runc stdio pipes. */
  bind: (stdio: FastManimRuncStdioV1) => void;
  /** Returns a fresh result copy only after both output pipes closed normally. */
  copyResultBytes: () => Uint8Array;
  /** Resolves once with the first deterministic output overflow classification. */
  overflow: Promise<FastManimRuncOutputOverflowV1>;
  /** Resource-controller lifecycle. Construct this value before admission. */
  outputLifecycle: FastManimSandboxBoundedOutputLifecycleV1;
  /** Never returns raw diagnostic bytes. A digest exists only for a complete bounded stream. */
  stderrEvidence: () => FastManimRuncStderrEvidenceV1;
  /** Waits for both stdout and stderr close events, not merely their end events. */
  waitForOutput: () => Promise<void>;
  /** Writes the owned request exactly once and closes stdin with EOF. */
  writeRequest: () => Promise<void>;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function validReadable(value: Readable) {
  return (
    typeof value?.destroy === "function" &&
    typeof value.on === "function" &&
    typeof value.once === "function" &&
    typeof value.off === "function"
  );
}

function validWritable(value: Writable) {
  return (
    typeof value?.destroy === "function" &&
    typeof value.end === "function" &&
    typeof value.once === "function" &&
    typeof value.off === "function"
  );
}

class FastManimRuncBoundedIoStateV1 {
  readonly outputLifecycle: FastManimSandboxBoundedOutputLifecycleV1;
  readonly overflow: Promise<FastManimRuncOutputOverflowV1>;
  readonly #limits: FastManimSandboxResourceLimitsV1;
  readonly #output = deferred<void>();
  readonly #overflow = deferred<FastManimRuncOutputOverflowV1>();
  readonly #requestBytes: Uint8Array;
  readonly #stderrClose = deferred<void>();
  readonly #stderrDigest = createHash("sha256");
  readonly #stdinClose = deferred<void>();
  readonly #stdoutClose = deferred<void>();
  #bound = false;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #closing = false;
  #outputFailure: Error | null = null;
  #overflowReason: FastManimRuncOutputOverflowV1 | null = null;
  #requestWrite: Promise<void> | null = null;
  #resultBytes = 0;
  #resultChunks: Uint8Array[] = [];
  #stderrBytes = 0;
  #stderrClosed = false;
  #stderrEnded = false;
  #stderrStream: Readable | null = null;
  #stdinStream: Writable | null = null;
  #stdoutClosed = false;
  #stdoutEnded = false;
  #stdoutStream: Readable | null = null;

  constructor(limitsValue: unknown, requestBytesValue: Uint8Array) {
    this.#limits = parseFastManimSandboxResourceLimitsV1(limitsValue);
    this.#requestBytes = copyFastManimSandboxUint8ArrayV1(requestBytesValue, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    this.overflow = this.#overflow.promise;
    // Callers commonly attach only after admission; retain a rejection handler
    // for the close-before-bind path without changing the public promise.
    this.#output.promise.catch(() => undefined);
    this.outputLifecycle = Object.freeze({
      close: () => this.close(),
      closureEvidence: () =>
        this.#closed
          ? Object.freeze({
              resultClosed: true as const,
              schema: FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1,
              stderrClosed: true as const,
              stdoutClosed: true as const,
              version: 1 as const,
            })
          : null,
      descriptor: Object.freeze({
        maxResultBytes: this.#limits.maxResultBytes,
        maxStderrBytes: this.#limits.maxStderrBytes,
        maxStdoutBytes: this.#limits.maxStdoutBytes,
        schema: FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1,
        version: 1 as const,
      }),
    });
  }

  bind(stdio: FastManimRuncStdioV1) {
    if (this.#closed || this.#closing) throw new Error("The bounded runc I/O lifecycle is closed.");
    if (this.#bound) throw new Error("The bounded runc I/O lifecycle is already bound.");
    if (!validWritable(stdio?.stdin) || !validReadable(stdio?.stdout) || !validReadable(stdio?.stderr)) {
      throw new TypeError("The runc stdio binding is malformed.");
    }
    this.#bound = true;
    this.#stdinStream = stdio.stdin;
    this.#stdoutStream = stdio.stdout;
    this.#stderrStream = stdio.stderr;

    const stdoutData = (chunk: unknown) => this.#captureStdout(chunk);
    const stderrData = (chunk: unknown) => this.#captureStderr(chunk);
    stdio.stdout.on("data", stdoutData);
    stdio.stderr.on("data", stderrData);
    stdio.stdout.once("end", () => {
      this.#stdoutEnded = true;
    });
    stdio.stderr.once("end", () => {
      this.#stderrEnded = true;
    });
    stdio.stdout.once("error", () => {
      this.#outputFailure ??= new Error("The bounded runc stdout pipe failed.");
    });
    stdio.stderr.once("error", () => {
      this.#outputFailure ??= new Error("The bounded runc stderr pipe failed.");
    });
    stdio.stdout.once("close", () => {
      stdio.stdout.off("data", stdoutData);
      this.#stdoutClosed = true;
      this.#stdoutClose.resolve();
      if (!this.#stdoutEnded && !this.#closing) {
        this.#outputFailure ??= new Error("The bounded runc stdout pipe closed prematurely.");
      }
      this.#settleOutput();
    });
    stdio.stderr.once("close", () => {
      stdio.stderr.off("data", stderrData);
      this.#stderrClosed = true;
      this.#stderrClose.resolve();
      if (!this.#stderrEnded && !this.#closing) {
        this.#outputFailure ??= new Error("The bounded runc stderr pipe closed prematurely.");
      }
      this.#settleOutput();
    });
    stdio.stdin.once("close", () => {
      this.#stdinClose.resolve();
    });

    if (stdio.stdout.readableEnded) this.#stdoutEnded = true;
    if (stdio.stderr.readableEnded) this.#stderrEnded = true;
    if (stdio.stdout.closed) {
      this.#stdoutClosed = true;
      this.#stdoutClose.resolve();
    }
    if (stdio.stderr.closed) {
      this.#stderrClosed = true;
      this.#stderrClose.resolve();
    }
    if (stdio.stdin.closed) {
      this.#stdinClose.resolve();
    }
    this.#settleOutput();
  }

  writeRequest() {
    if (this.#closed || this.#closing) return Promise.reject(new Error("The bounded runc I/O lifecycle is closed."));
    if (!this.#bound || !this.#stdinStream) {
      return Promise.reject(new Error("The bounded runc I/O lifecycle is not bound."));
    }
    if (this.#requestWrite) return Promise.reject(new Error("The bounded runc request was already written."));

    const stdin = this.#stdinStream;
    const writeBytes = copyFastManimSandboxUint8ArrayV1(this.#requestBytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    this.#requestWrite = new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        stdin.off("error", onError);
        stdin.off("finish", onFinish);
        stdin.off("close", onClose);
        this.#requestBytes.fill(0);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const onError = () => settle(new Error("The bounded runc stdin pipe failed."));
      const onFinish = () => settle();
      const onClose = () => {
        if (!stdin.writableFinished) settle(new Error("The bounded runc stdin pipe closed before EOF."));
      };
      stdin.once("error", onError);
      stdin.once("finish", onFinish);
      stdin.once("close", onClose);
      try {
        stdin.end(writeBytes);
      } catch {
        settle(new Error("The bounded runc request could not be written."));
      }
    });
    this.#requestWrite.catch(() => undefined);
    return this.#requestWrite;
  }

  waitForOutput() {
    if (!this.#bound && !this.#closing && !this.#closed) {
      return Promise.reject(new Error("The bounded runc I/O lifecycle is not bound."));
    }
    return this.#output.promise;
  }

  copyResultBytes() {
    if (!this.#stdoutClosed || !this.#stderrClosed || this.#outputFailure || this.#overflowReason || this.#closing) {
      throw new Error("The bounded runc result is not available.");
    }
    const result = new Uint8Array(this.#resultBytes);
    let offset = 0;
    for (const chunk of this.#resultChunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return copyFastManimSandboxUint8ArrayV1(result, this.#limits.maxResultBytes);
  }

  stderrEvidence(): FastManimRuncStderrEvidenceV1 {
    const digest =
      this.#stderrEnded && this.#stderrClosed && this.#overflowReason !== "stderr-overflow" && this.#stderrBytes > 0
        ? this.#stderrDigest.copy().digest("hex")
        : null;
    return Object.freeze({ byteCount: this.#stderrBytes, sha256: digest });
  }

  close() {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce() {
    this.#closing = true;
    this.#requestBytes.fill(0);
    this.#resultChunks = [];
    this.#resultBytes = 0;
    if (!this.#bound) {
      this.#stdoutClosed = true;
      this.#stderrClosed = true;
      this.#stdinClose.resolve();
      this.#stdoutClose.resolve();
      this.#stderrClose.resolve();
      this.#settleOutput();
      this.#closed = true;
      return;
    }

    const streams = [this.#stdinStream, this.#stdoutStream, this.#stderrStream].filter(
      (stream): stream is Readable | Writable => stream !== null,
    );
    for (const stream of streams) {
      if (!stream.destroyed) stream.destroy();
    }
    await Promise.all([this.#stdinClose.promise, this.#stdoutClose.promise, this.#stderrClose.promise]);
    this.#settleOutput();
    this.#closed = true;
  }

  #captureStdout(value: unknown) {
    if (this.#closing || this.#stdoutClosed || this.#overflowReason) return;
    let chunk: Uint8Array;
    try {
      chunk = copyFastManimSandboxUint8ArrayV1(value, this.#limits.maxStdoutBytes);
    } catch {
      this.#recordOverflow("stdout-overflow");
      return;
    }
    const nextBytes = this.#resultBytes + chunk.byteLength;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > this.#limits.maxStdoutBytes) {
      this.#recordOverflow("stdout-overflow");
      return;
    }
    if (nextBytes > this.#limits.maxResultBytes) {
      this.#recordOverflow("result-overflow");
      return;
    }
    this.#resultBytes = nextBytes;
    this.#resultChunks.push(chunk);
  }

  #captureStderr(value: unknown) {
    if (this.#closing || this.#stderrClosed || this.#overflowReason) return;
    let chunk: Uint8Array;
    try {
      chunk = copyFastManimSandboxUint8ArrayV1(value, this.#limits.maxStderrBytes);
    } catch {
      this.#recordOverflow("stderr-overflow");
      return;
    }
    const nextBytes = this.#stderrBytes + chunk.byteLength;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > this.#limits.maxStderrBytes) {
      this.#recordOverflow("stderr-overflow");
      return;
    }
    this.#stderrBytes = nextBytes;
    this.#stderrDigest.update(chunk);
  }

  #recordOverflow(reason: FastManimRuncOutputOverflowV1) {
    if (this.#overflowReason) return;
    this.#overflowReason = reason;
    if (reason === "stderr-overflow") this.#stderrBytes = this.#limits.maxStderrBytes + 1;
    else {
      this.#resultBytes =
        reason === "stdout-overflow" ? this.#limits.maxStdoutBytes + 1 : this.#limits.maxResultBytes + 1;
      this.#resultChunks = [];
    }
    this.#overflow.resolve(reason);
  }

  #settleOutput() {
    if (!this.#stdoutClosed || !this.#stderrClosed) return;
    const error =
      this.#outputFailure ??
      (this.#overflowReason ? new Error(`The bounded runc output exceeded its ${this.#overflowReason} cap.`) : null) ??
      (this.#closing || !this.#stdoutEnded || !this.#stderrEnded
        ? new Error("The bounded runc output lifecycle closed before normal output completion.")
        : null);
    if (error) this.#output.reject(error);
    else this.#output.resolve();
  }
}

export function createFastManimRuncBoundedIoV1(
  options: Readonly<{ limits: unknown; requestBytes: Uint8Array }>,
): FastManimRuncBoundedIoV1 {
  const state = new FastManimRuncBoundedIoStateV1(options.limits, options.requestBytes);
  return Object.freeze({
    bind: state.bind.bind(state),
    copyResultBytes: state.copyResultBytes.bind(state),
    outputLifecycle: state.outputLifecycle,
    overflow: state.overflow,
    stderrEvidence: state.stderrEvidence.bind(state),
    waitForOutput: state.waitForOutput.bind(state),
    writeRequest: state.writeRequest.bind(state),
  });
}
