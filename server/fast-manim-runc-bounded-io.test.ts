import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createFastManimRuncBoundedIoV1, type FastManimRuncBoundedIoV1 } from "./fast-manim-runc-bounded-io";
import {
  DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  type FastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

function limits(overrides: Partial<FastManimSandboxResourceLimitsV1> = {}): FastManimSandboxResourceLimitsV1 {
  return { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, ...overrides };
}

function bind(io: FastManimRuncBoundedIoV1) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  io.bind({ stderr, stdin, stdout });
  return { stderr, stdin, stdout };
}

describe("bounded runc I/O", () => {
  it("installs the exact frozen output reservation before stdio is bound", async () => {
    const configured = limits({ maxResultBytes: 11, maxStderrBytes: 13, maxStdoutBytes: 17 });
    const io = createFastManimRuncBoundedIoV1({ limits: configured, requestBytes: Uint8Array.of(1) });

    expect(io.outputLifecycle.descriptor).toEqual({
      maxResultBytes: 11,
      maxStderrBytes: 13,
      maxStdoutBytes: 17,
      schema: "poietra.fast-manim-sandbox-bounded-output",
      version: 1,
    });
    expect(Object.isFrozen(io.outputLifecycle.descriptor)).toBe(true);
    expect(io.outputLifecycle.closureEvidence()).toBeNull();
    await expect(io.waitForOutput()).rejects.toThrow(/not bound/i);

    await io.outputLifecycle.close("launch-failed");
  });

  it("writes one owned request followed by EOF and refuses replay", async () => {
    const request = Uint8Array.from([1, 2, 3, 4]);
    const io = createFastManimRuncBoundedIoV1({ limits: limits(), requestBytes: request });
    request.fill(9);
    const { stdin } = bind(io);
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

    await io.writeRequest();

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(stdin.writableEnded).toBe(true);
    await expect(io.writeRequest()).rejects.toThrow(/already written/i);
    await io.outputLifecycle.close("completed");
  });

  it("returns fresh bounded result bytes and only diagnostic count plus digest", async () => {
    const io = createFastManimRuncBoundedIoV1({ limits: limits(), requestBytes: Uint8Array.of(1) });
    const { stderr, stdout } = bind(io);
    stdout.end(Buffer.from("result", "utf8"));
    stderr.end(Buffer.from("diagnostic", "utf8"));

    await io.waitForOutput();

    const first = io.copyResultBytes();
    expect(Buffer.from(first).toString("utf8")).toBe("result");
    first.fill(0);
    expect(Buffer.from(io.copyResultBytes()).toString("utf8")).toBe("result");
    expect(io.stderrEvidence()).toEqual({
      byteCount: Buffer.byteLength("diagnostic"),
      sha256: createHash("sha256").update("diagnostic", "utf8").digest("hex"),
    });
    expect(io.stderrEvidence()).not.toHaveProperty("bytes");

    await io.outputLifecycle.close("completed");
    expect(() => io.copyResultBytes()).toThrow(/not available/i);
  });

  it.each([
    {
      expected: "result-overflow" as const,
      limits: limits({ maxResultBytes: 3, maxStdoutBytes: 5 }),
    },
    {
      expected: "stdout-overflow" as const,
      limits: limits({ maxResultBytes: 3, maxStdoutBytes: 3 }),
    },
  ])("classifies $expected deterministically and discards partial result storage", async (fixture) => {
    const io = createFastManimRuncBoundedIoV1({ limits: fixture.limits, requestBytes: Uint8Array.of(1) });
    const { stderr, stdout } = bind(io);
    stdout.end(Buffer.from("1234", "ascii"));
    stderr.end();

    await expect(io.overflow).resolves.toBe(fixture.expected);
    await expect(io.waitForOutput()).rejects.toThrow(/cap/i);
    expect(() => io.copyResultBytes()).toThrow(/not available/i);

    await io.outputLifecycle.close(fixture.expected);
  });

  it("caps stderr without retaining or exposing its raw bytes", async () => {
    const io = createFastManimRuncBoundedIoV1({
      limits: limits({ maxStderrBytes: 3 }),
      requestBytes: Uint8Array.of(1),
    });
    const { stderr, stdout } = bind(io);
    stderr.end(Buffer.from("private diagnostic", "utf8"));
    stdout.end();

    await expect(io.overflow).resolves.toBe("stderr-overflow");
    await expect(io.waitForOutput()).rejects.toThrow(/stderr-overflow/i);
    expect(io.stderrEvidence()).toEqual({ byteCount: 4, sha256: null });

    await io.outputLifecycle.close("stderr-overflow");
  });

  it("keeps the first observed overflow reason when both streams exceed their caps", async () => {
    const io = createFastManimRuncBoundedIoV1({
      limits: limits({ maxResultBytes: 2, maxStderrBytes: 2, maxStdoutBytes: 2 }),
      requestBytes: Uint8Array.of(1),
    });
    const { stderr, stdout } = bind(io);
    stdout.write(Buffer.from("123", "ascii"));
    stderr.write(Buffer.from("456", "ascii"));
    stdout.end();
    stderr.end();

    await expect(io.overflow).resolves.toBe("stdout-overflow");
    await expect(io.waitForOutput()).rejects.toThrow(/stdout-overflow/i);
    expect(io.stderrEvidence()).toEqual({ byteCount: 0, sha256: null });

    await io.outputLifecycle.close("stdout-overflow");
  });

  it("accepts exact-cap boundaries", async () => {
    const io = createFastManimRuncBoundedIoV1({
      limits: limits({ maxResultBytes: 4, maxStderrBytes: 4, maxStdoutBytes: 4 }),
      requestBytes: Uint8Array.of(1),
    });
    const { stderr, stdout } = bind(io);
    stdout.end(Buffer.from("1234", "ascii"));
    stderr.end(Buffer.from("abcd", "ascii"));

    await io.waitForOutput();
    expect(Buffer.from(io.copyResultBytes()).toString("ascii")).toBe("1234");
    expect(io.stderrEvidence().byteCount).toBe(4);

    await io.outputLifecycle.close("completed");
  });

  it("does not report output completion until both readable pipes close", async () => {
    const io = createFastManimRuncBoundedIoV1({ limits: limits(), requestBytes: Uint8Array.of(1) });
    const stdin = new PassThrough();
    const stdout = new PassThrough({ autoDestroy: false });
    const stderr = new PassThrough({ autoDestroy: false });
    io.bind({ stderr, stdin, stdout });
    let settled = false;
    const output = io.waitForOutput().then(() => {
      settled = true;
    });
    stdout.end(Buffer.from("result", "utf8"));
    stderr.end();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(stdout.readableEnded).toBe(true);
    expect(stderr.readableEnded).toBe(true);
    expect(settled).toBe(false);

    stdout.destroy();
    stderr.destroy();
    await output;
    expect(settled).toBe(true);
    await io.outputLifecycle.close("completed");
  });

  it("closes a bound but unwritten lifecycle idempotently and settles output waiters", async () => {
    const io = createFastManimRuncBoundedIoV1({ limits: limits(), requestBytes: Uint8Array.of(1) });
    const { stderr, stdin, stdout } = bind(io);
    const output = io.waitForOutput();

    const firstClose = io.outputLifecycle.close("aborted");
    const secondClose = io.outputLifecycle.close("deadline");
    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);

    await expect(output).rejects.toThrow(/closed before normal/i);
    expect(stdin.destroyed).toBe(true);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
    expect(io.outputLifecycle.closureEvidence()).toEqual({
      resultClosed: true,
      schema: "poietra.fast-manim-sandbox-output-closed",
      stderrClosed: true,
      stdoutClosed: true,
      version: 1,
    });
    await expect(io.writeRequest()).rejects.toThrow(/closed/i);
  });

  it("closes before bind without waiting for streams and rejects later attachment", async () => {
    const io = createFastManimRuncBoundedIoV1({ limits: limits(), requestBytes: Uint8Array.of(1) });

    await io.outputLifecycle.close("launch-failed");

    await expect(io.waitForOutput()).rejects.toThrow(/closed before normal/i);
    expect(io.outputLifecycle.closureEvidence()).not.toBeNull();
    expect(() => bind(io)).toThrow(/closed/i);
    await expect(io.writeRequest()).rejects.toThrow(/closed/i);
  });
});
