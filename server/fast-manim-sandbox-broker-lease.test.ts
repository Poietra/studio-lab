import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireFastManimSandboxBrokerLeaseV1,
  acquireFastManimSandboxOwnerLeaseV1,
} from "./fast-manim-sandbox-broker-lease";

const roots: string[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function path() {
  const root = await mkdtemp(join(tmpdir(), "poietra-lease-"));
  roots.push(root);
  return join(root, "broker.sock");
}

describe("fast-manim sandbox broker lease", () => {
  it("elects one process per owner digest while allowing unrelated owners", async () => {
    const first = await acquireFastManimSandboxOwnerLeaseV1("a".repeat(64));
    const unrelated = await acquireFastManimSandboxOwnerLeaseV1("b".repeat(64));
    await expect(acquireFastManimSandboxOwnerLeaseV1("a".repeat(64))).rejects.toMatchObject({ code: "busy" });
    await Promise.all([first.close(), unrelated.close()]);
  });

  it("admits one live broker and releases ownership cleanly", async () => {
    const socketPath = await path();
    const first = await acquireFastManimSandboxBrokerLeaseV1(socketPath);
    await expect(acquireFastManimSandboxBrokerLeaseV1(socketPath)).rejects.toMatchObject({ code: "busy" });

    await first.close();
    const replacement = await acquireFastManimSandboxBrokerLeaseV1(socketPath);
    await replacement.close();
  });

  it("atomically elects one winner across concurrent contenders", async () => {
    const socketPath = await path();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireFastManimSandboxBrokerLeaseV1(socketPath)),
    );
    const winners = attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(7);
    await winners[0]?.close();
  });

  it("does not steal a legacy broker's active socket", async () => {
    const socketPath = await path();
    const listener = createServer((socket) => socket.end());
    listeners.push(listener);
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once("error", rejectListen);
      listener.listen(socketPath, resolveListen);
    });

    await expect(acquireFastManimSandboxBrokerLeaseV1(socketPath)).rejects.toMatchObject({ code: "busy" });
  });
});
