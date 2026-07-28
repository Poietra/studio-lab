import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { FastManimRuncCliRuntimeV1, isProductionFastManimRuncRuntimeV1 } from "./fast-manim-runc-runtime";

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
  stateRoot = "/run/poietra/runc-state",
) {
  return new FastManimRuncCliRuntimeV1({
    bundleRoot,
    spawnProcess: implementation as never,
    stateRoot,
  });
}

describe("FastManimRuncCliRuntimeV1", () => {
  it("brands only the fixed production runc process boundary", () => {
    expect(
      isProductionFastManimRuncRuntimeV1(
        new FastManimRuncCliRuntimeV1({ bundleRoot, stateRoot: "/run/poietra/runc-state" }),
      ),
    ).toBe(true);
    expect(isProductionFastManimRuncRuntimeV1(runtimeWith(() => fakeChild()))).toBe(false);
    class OverriddenRuntime extends FastManimRuncCliRuntimeV1 {}
    expect(
      isProductionFastManimRuncRuntimeV1(new OverriddenRuntime({ bundleRoot, stateRoot: "/run/poietra/runc-state" })),
    ).toBe(false);
  });

  it("probes the fixed runc binary only from a private runner-owned state root", async () => {
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "poietra-runc-state-")));
    const stateRootLink = `${stateRoot}-link`;
    const spawnProcess = vi.fn(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end("runc version 1.3.4\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });
    const runtime = runtimeWith(spawnProcess, stateRoot);
    try {
      await expect(runtime.assertReady(deadlineEpochMs(), new AbortController().signal)).resolves.toBeUndefined();
      expect(spawnProcess).toHaveBeenCalledWith(
        "/usr/bin/runc",
        ["--rootless=true", "--root", stateRoot, "--version"],
        {
          cwd: "/",
          env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      await chmod(stateRoot, 0o750);
      await expect(runtime.assertReady(deadlineEpochMs(), new AbortController().signal)).rejects.toThrow(/mode/u);
      expect(spawnProcess).toHaveBeenCalledOnce();

      const aborted = new AbortController();
      aborted.abort();
      await expect(runtime.assertReady(deadlineEpochMs(), aborted.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(spawnProcess).toHaveBeenCalledOnce();

      await chmod(stateRoot, 0o700);
      await symlink(stateRoot, stateRootLink, "dir");
      await expect(
        runtimeWith(spawnProcess, stateRootLink).assertReady(deadlineEpochMs(), new AbortController().signal),
      ).rejects.toThrow(/state root/u);
      expect(spawnProcess).toHaveBeenCalledOnce();
    } finally {
      await rm(stateRootLink, { force: true });
      await rm(stateRoot, { force: true, recursive: true });
    }
  });

  it("runs only the fixed create operation and resolves at CLI exit without consuming OCI stdio", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const runtime = runtimeWith(spawnProcess);

    const created = runtime.create({ bundlePath, containerId, deadlineEpochMs: deadlineEpochMs() });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/runc",
      ["--rootless=true", "--root", "/run/poietra/runc-state", "create", "--bundle", bundlePath, containerId],
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

  it("accepts an OCI stopped state without a live init PID", async () => {
    const child = fakeChild();
    const runtime = runtimeWith(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ bundle: bundlePath, id: containerId, pid: 0, status: "stopped" }));
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    await expect(runtime.state(containerId, deadlineEpochMs())).resolves.toMatchObject({ pid: 0, status: "stopped" });
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
      ["--rootless=true", "--root", "/run/poietra/runc-state", "start", containerId],
      ["--rootless=true", "--root", "/run/poietra/runc-state", "kill", containerId, "KILL"],
      ["--rootless=true", "--root", "/run/poietra/runc-state", "delete", "--force", containerId],
    ]);
  });

  it("terminates ordinary control commands on abort without coupling cleanup commands to that signal", async () => {
    const child = fakeChild();
    const runtime = runtimeWith(() => child);
    const controller = new AbortController();
    const state = runtime.state(containerId, deadlineEpochMs(), controller.signal);
    let settled = false;
    state
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    controller.abort();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(state).rejects.toThrowError(/aborted/u);
  });

  it("does not report a terminated create client reaped before its real exit", async () => {
    const child = fakeChild();
    const runtime = runtimeWith(() => child);
    const created = runtime.create({ bundlePath, containerId, deadlineEpochMs: deadlineEpochMs() });
    let settled = false;
    created.created
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    created.terminateCreateClient();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("exit", null, "SIGKILL");
    await expect(created.created).rejects.toThrowError(/terminated/u);
  });
});
