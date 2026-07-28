import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { FastManimRuncCliRuntimeV1 } from "./fast-manim-runc-runtime";

const bundleRoot = "/var/lib/poietra/runc/bundles";
const bundlePath = `${bundleRoot}/job-1`;
const containerId = `poietra-job-v1-${"a".repeat(32)}-1`;
const deadlineEpochMs = () => Date.now() + 10_000;

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function runtimeWith(
  implementation: (
    file: string,
    arguments_: readonly string[],
    options: Readonly<Record<string, unknown>>,
  ) => FakeChild,
) {
  return new FastManimRuncCliRuntimeV1({
    bundleRoot,
    spawnProcess: implementation as never,
    stateRoot: "/run/poietra/runc-state",
  });
}

describe("FastManimRuncCliRuntimeV1", () => {
  it("runs only the fixed create operation and resolves at CLI exit without consuming OCI stdio", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const runtime = runtimeWith(spawnProcess);

    const created = runtime.create({ bundlePath, containerId, deadlineEpochMs: deadlineEpochMs() });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/runc",
      ["--root", "/run/poietra/runc-state", "create", "--bundle", bundlePath, containerId],
      {
        cwd: "/",
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.emit("exit", 0, null);

    await expect(created.created).resolves.toBeUndefined();
    expect(created.stdin).toBe(child.stdin);
    expect(created.stdout).toBe(child.stdout);
    expect(created.stderr).toBe(child.stderr);
    expect(child.stdout.destroyed).toBe(false);
  });

  it("rejects caller paths and identities outside the server-owned namespace", () => {
    const runtime = runtimeWith(() => fakeChild());
    expect(() =>
      runtime.create({ bundlePath: "/tmp/request-path", containerId, deadlineEpochMs: deadlineEpochMs() }),
    ).toThrowError(/below the configured bundle root/u);
    expect(() =>
      runtime.create({ bundlePath, containerId: "tenant-controlled", deadlineEpochMs: deadlineEpochMs() }),
    ).toThrowError(/server-generated/u);
  });

  it("bounds and validates runc state before returning it", async () => {
    const child = fakeChild();
    const runtime = runtimeWith(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ bundle: bundlePath, id: containerId, pid: 4321, status: "created" }));
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    await expect(runtime.state(containerId, deadlineEpochMs())).resolves.toMatchObject({
      bundle: bundlePath,
      id: containerId,
      pid: 4321,
      status: "created",
    });
  });

  it("rejects state whose bundle escapes the configured root", async () => {
    const child = fakeChild();
    const runtime = runtimeWith(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ bundle: "/tmp/other", id: containerId, pid: 4321, status: "created" }));
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    await expect(runtime.state(containerId, deadlineEpochMs())).rejects.toThrowError(/untrusted bundle path/u);
  });

  it("uses a closed command set and rejects unexpected control stdout", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runtime = runtimeWith((_file, arguments_) => {
      mutableCalls.push([...arguments_]);
      const child = fakeChild();
      queueMicrotask(() => {
        if (arguments_.includes("start")) child.stdout.write("unexpected");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    await expect(runtime.start(containerId, deadlineEpochMs())).rejects.toThrowError(/byte budget/u);
    await expect(runtime.kill(containerId, deadlineEpochMs())).resolves.toBeUndefined();
    await expect(runtime.delete(containerId, deadlineEpochMs())).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["--root", "/run/poietra/runc-state", "start", containerId],
      ["--root", "/run/poietra/runc-state", "kill", containerId, "KILL"],
      ["--root", "/run/poietra/runc-state", "delete", "--force", containerId],
    ]);
  });
});
