import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES } from "./fast-manim-snapshot-contract";
import type { StructuredLogger } from "./logging/structured-logger";

const MAX_PRODUCER_STDOUT_BYTES = MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES;
const MAX_PRODUCER_STDERR_BYTES = 256 * 1024;
const PRODUCER_KILL_GRACE_MS = 2_000;
const PRODUCER_CLOSE_GRACE_MS = 5_000;
const SPAWN_FAILURE_CLOSE_FALLBACK_MS = 100;
const MAX_PRODUCER_GRACE_MS = 60_000;

export type ProducerProcessTimings = Readonly<{
  closeGraceMs: number;
  killGraceMs: number;
}>;

function producerGrace(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PRODUCER_GRACE_MS) {
    throw new TypeError(`${name} must be a positive integer of at most ${MAX_PRODUCER_GRACE_MS}ms.`);
  }
  return value;
}

export function resolveProducerProcessTimings(overrides: Partial<ProducerProcessTimings> = {}): ProducerProcessTimings {
  return Object.freeze({
    closeGraceMs: producerGrace(overrides.closeGraceMs ?? PRODUCER_CLOSE_GRACE_MS, "Producer close grace"),
    killGraceMs: producerGrace(overrides.killGraceMs ?? PRODUCER_KILL_GRACE_MS, "Producer kill grace"),
  });
}

export type ProducerGroupKill = (pid: number, signalName: NodeJS.Signals) => void;

export const defaultKillProcessGroup: ProducerGroupKill = (pid, signalName) => {
  process.kill(pid, signalName);
};

export function abortError() {
  const error = new Error("The Scene snapshot run was aborted.");
  error.name = "AbortError";
  return error;
}

export type ProducerProcessResult =
  | Readonly<{
      code: "producer-exit" | "producer-output-overflow" | "producer-spawn-failed" | "producer-timeout";
      kind: "failed";
    }>
  | Readonly<{ kind: "ok"; stdout: Uint8Array }>;

export type SuperviseProducerOptions = Readonly<{
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  isHalted: () => boolean;
  killProcessGroup: ProducerGroupKill;
  logger: StructuredLogger;
  /** Registers the spawned child so the caller's close() can request its stop. */
  onSpawned: (child: ChildProcess, requestStop: () => void) => void;
  /** Deregisters the child once it has settled. */
  onSettled: (child: ChildProcess) => void;
  requestId: string;
  requestJson: string;
  signal?: AbortSignal;
  timings: ProducerProcessTimings;
  timeoutMs: number;
}>;

/**
 * Subprocess supervision for one producer run: spawn, drive the single
 * termination state machine, capture bounded stdout while discarding
 * producer-controlled stderr bytes, and settle on the child's `close` (process
 * exit AND EOF on both pipes) under the run deadline.
 *
 * Signals target the process group ONLY while the leader is observably alive: a
 * live leader keeps the PGID from being recycled, so a SIGKILL to the group
 * also reaps same-group descendants (even ones ignoring SIGTERM). After leader
 * exit nothing proves the group still exists — open inherited pipes do not (a
 * descendant can setsid() and keep the fds) — so neither path signals -pid
 * again (it could hit a recycled group). Residual #80 default-off boundary: a
 * descendant that outlives the leader (quiet pipe holder or setsid escapee) is
 * not contained here; the run still settles via the bounded pipe-close grace,
 * but real out-of-group containment needs the OS sandbox (cgroup.kill/pidfd).
 *
 * The caller owns admission and the private runtime directory; this function
 * only registers/deregisters the child through the supplied hooks and never
 * leaves a pending timer that could fire after it resolves.
 */
export async function superviseProducerProcess(options: SuperviseProducerOptions): Promise<ProducerProcessResult> {
  const [executable, ...prefix] = options.command;
  // spawn throws synchronously for invalid argv/env (e.g. a NUL byte in a
  // server-controlled command or producerEnv value); the caller reclaims the
  // admission slot and runtime directory on that path.
  const child = spawn(executable, prefix, {
    // The private runtime directory, never the project root: workspace Python
    // must not import project-local helpers via an implicit cwd sys.path entry.
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let setupComplete = false;
  try {
    let closed = false;
    let spawnFailure = false;
    let timedOut = false;
    let settleExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let exitSettled = false;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      settleExit = (value) => {
        if (exitSettled) return;
        exitSettled = true;
        resolve(value);
      };
    });

    let stopRequested = false;
    let terminationFinished = false;
    let leaderExited = false;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let spawnFailureTimer: NodeJS.Timeout | null = null;
    const signalProducer = (signalName: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      // Checked at send time, so a TERM→KILL escalation armed while the leader
      // lived is suppressed if the leader exits before it fires.
      if (leaderExited) return;
      if (process.platform !== "win32") {
        try {
          options.killProcessGroup(-pid, signalName);
          return;
        } catch {
          // The group may already be empty; fall through to the direct child.
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          options.killProcessGroup(pid, signalName);
        } catch {
          // A concurrent exit means there is nothing left to stop.
        }
      }
    };
    // The pipe-close grace bounds how long the run waits for EOF once
    // termination is under way or the leader is gone.
    const armCloseGrace = () => {
      if (graceTimer || terminationFinished) return;
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settleExit({ code: child.exitCode, signal: child.signalCode });
      }, options.timings.closeGraceMs);
      graceTimer.unref();
    };
    const requestStop = () => {
      if (stopRequested || terminationFinished) return;
      stopRequested = true;
      signalProducer("SIGTERM");
      killTimer = setTimeout(() => {
        if (!terminationFinished) signalProducer("SIGKILL");
      }, options.timings.killGraceMs);
      killTimer.unref();
      // The grace starts from the stop request (abort, overflow, timeout, or
      // manager close), never from the full run timeout.
      armCloseGrace();
    };
    const finishTermination = () => {
      terminationFinished = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (spawnFailureTimer) clearTimeout(spawnFailureTimer);
      clearTimeout(deadlineTimer);
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, options.timeoutMs);
    deadlineTimer.unref();
    options.onSpawned(child, requestStop);
    const onAbort = () => requestStop();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PRODUCER_STDOUT_BYTES) {
        overflowed = true;
        stdoutChunks.length = 0;
        requestStop();
        return;
      }
      stdoutChunks.push(chunk);
    });
    // Producer-controlled stderr bytes never reach logs or HTTP responses:
    // workspace Python can print source fragments, secrets, host paths, or
    // tracebacks. Only the byte count and a digest are retained for support.
    let stderrBytes = 0;
    const stderrDigest = createHash("sha256");
    child.stderr?.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_PRODUCER_STDERR_BYTES) {
        overflowed = true;
        requestStop();
        return;
      }
      stderrDigest.update(chunk);
    });
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(options.requestJson);

    child.once("close", (code, signalCode) => {
      closed = true;
      finishTermination();
      settleExit({ code, signal: signalCode });
    });
    child.once("exit", () => {
      leaderExited = true;
      // A descendant that inherited the pipes must not stall the run to the
      // full deadline; bound the EOF wait from the leader's exit. A clean run's
      // `close` follows immediately and cancels this timer before it fires.
      if (!closed) armCloseGrace();
    });
    child.once("error", () => {
      spawnFailure = true;
      if (terminationFinished) return;
      spawnFailureTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) settleExit({ code: null, signal: null });
      }, SPAWN_FAILURE_CLOSE_FALLBACK_MS);
      spawnFailureTimer.unref();
    });

    setupComplete = true;
    try {
      const exit = await exitPromise;
      if (spawnFailure) return { code: "producer-spawn-failed", kind: "failed" };
      if (overflowed) return { code: "producer-output-overflow", kind: "failed" };
      if (timedOut || !closed) return { code: "producer-timeout", kind: "failed" };
      if (options.isHalted()) throw abortError();
      if (exit.code !== 0) {
        options.logger.warn("snapshot.producer_exit", {
          exitCode: exit.code,
          exitSignal: exit.signal,
          requestId: options.requestId,
          stderrByteCount: stderrBytes,
          stderrSha256: stderrBytes > 0 ? stderrDigest.digest("hex") : null,
        });
        return { code: "producer-exit", kind: "failed" };
      }
      return { kind: "ok", stdout: Buffer.concat(stdoutChunks, stdoutBytes) };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      // Cancel every pending timer so no delayed TERM/KILL escalation fires
      // after this resolves; all escalation happened earlier, while the leader
      // was alive (see the termination-state note above).
      finishTermination();
      options.onSettled(child);
    }
  } catch (error) {
    if (!setupComplete) {
      options.onSettled(child);
      try {
        child.kill("SIGKILL");
      } catch {
        // The child never spawned or already exited.
      }
    }
    throw error;
  }
}
