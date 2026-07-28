import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  encodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerServerFrameV1,
  FastManimSandboxBrokerClientFrameDecoderV1,
  type FastManimSandboxBrokerClientMessageV1,
  type FastManimSandboxBrokerServerMessageV1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  FastManimUdsSandboxBackendV1,
  MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1,
} from "./fast-manim-uds-sandbox-backend";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const identity = { projectId: "default", requestId: "uds-client-test", tenantId: "test-tenant" } as const;
const attestationDigest = "c".repeat(64);
type Reply = (message: FastManimSandboxBrokerServerMessageV1) => void;
type Handler = (message: FastManimSandboxBrokerClientMessageV1, socket: Socket, reply: Reply) => void;

async function withBroker(handler: Handler, run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "poietra-uds-client-"));
  const path = join(root, "broker.sock");
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const decoder = new FastManimSandboxBrokerClientFrameDecoderV1();
    let handled = false;
    socket.on("data", (chunk) => {
      try {
        if (typeof chunk === "string") throw new Error("Unexpected string socket chunk.");
        const message = decoder.push(chunk);
        if (!message || handled) return;
        handled = true;
        handler(message, socket, (response) => {
          const frame = encodeFastManimSandboxBrokerServerFrameV1(message.kind, response);
          socket.end(frame);
        });
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  try {
    await run(path);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
}

function statusContext(signal = new AbortController().signal) {
  return { deadlineEpochMs: Date.now() + 30_000, identity, signal };
}

function jobContext(signal = new AbortController().signal) {
  return { ...statusContext(signal), attestationDigest };
}

function request() {
  return new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
}

function ok(message: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>, bytes: Uint8Array) {
  return {
    kind: "job-result" as const,
    result: {
      attestationDigest: message.attestationDigest,
      kind: "ok" as const,
      requestDigest: message.requestDigest,
      resultBytesBase64: encodeFastManimSandboxBrokerResultBytesV1(bytes),
    },
  };
}

describe("FastManimUdsSandboxBackendV1 single-operation sockets", () => {
  it("validates configuration before opening a socket", () => {
    expect(() => new FastManimUdsSandboxBackendV1({ socketPath: "relative.sock" })).toThrow(/absolute/i);
    expect(
      () =>
        new FastManimUdsSandboxBackendV1({
          socketPath: `/${"x".repeat(MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1)}`,
        }),
    ).toThrow(/bounded/i);
    expect(() => new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 0, socketPath: "/tmp/broker.sock" })).toThrow(
      /timeout/i,
    );
  });

  it("rejects a result whose request identity changed", async () => {
    await withBroker(
      (message, _socket, reply) => {
        if (message.kind !== "start") return;
        const response = ok(message, Uint8Array.of(1));
        reply({ ...response, result: { ...response.result, requestDigest: "d".repeat(64) } });
      },
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: path });
        await expect(backend.start(request(), jobContext()).result).rejects.toThrow(/failed closed/i);
        await expect(backend.close()).resolves.toBeUndefined();
      },
    );
  });

  it("uses FIN for abort and waits for broker FIN before close resolves", async () => {
    let releaseCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => (releaseCleanup = resolve));
    let markRequestSeen!: () => void;
    const requestSeen = new Promise<void>((resolve) => (markRequestSeen = resolve));
    let markAbortSeen!: () => void;
    const abortSeen = new Promise<void>((resolve) => (markAbortSeen = resolve));
    await withBroker(
      (message, socket) => {
        if (message.kind !== "start") return;
        markRequestSeen();
        socket.once("end", () => {
          markAbortSeen();
          void cleanupAllowed.then(() => socket.end());
        });
      },
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 500, socketPath: path });
        const handle = backend.start(request(), jobContext());
        const result = handle.result.catch((error: unknown) => error);
        await requestSeen;
        handle.abort();
        await expect(result).resolves.toMatchObject({ name: "AbortError" });
        await abortSeen;
        let closed = false;
        const close = backend.close().then(() => (closed = true));
        await new Promise((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        releaseCleanup();
        await close;
        expect(closed).toBe(true);
      },
    );
  });

  it("does not connect when abort wins during listener registration", async () => {
    await withBroker(
      () => {
        throw new Error("The aborted operation must not reach the broker.");
      },
      async (path) => {
        const controller = new AbortController();
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
          addEventListener(type, listener, options);
          controller.abort();
        });
        const connect = vi.spyOn(Socket.prototype, "connect");
        try {
          const backend = new FastManimUdsSandboxBackendV1({ socketPath: path });
          await expect(backend.start(request(), jobContext(controller.signal)).result).rejects.toMatchObject({
            name: "AbortError",
          });
          expect(connect).not.toHaveBeenCalled();
          await expect(backend.close()).resolves.toBeUndefined();
        } finally {
          connect.mockRestore();
        }
      },
    );
  });

  it("fails cleanup when a dispatched operation loses transport without broker FIN", async () => {
    await withBroker(
      (_message, socket) => socket.destroy(),
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: path });
        await expect(backend.start(request(), jobContext()).result).rejects.toThrow(/failed closed/i);
        await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
      },
    );
  });

  it("enforces client job capacity before writing another request", async () => {
    let connections = 0;
    let markRequestSeen!: () => void;
    const requestsSeen = new Promise<void>((resolve) => (markRequestSeen = resolve));
    await withBroker(
      (message, socket) => {
        if (message.kind !== "start") return;
        connections += 1;
        if (connections === 4) markRequestSeen();
        socket.once("end", () => socket.end());
      },
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: path });
        const active = Array.from({ length: 4 }, () => backend.start(request(), jobContext()));
        const results = active.map((handle) => handle.result.catch((error: unknown) => error));
        await requestsSeen;
        await expect(backend.start(request(), jobContext()).result).rejects.toMatchObject({ code: "capacity" });
        expect(connections).toBe(4);
        for (const handle of active) handle.abort();
        await expect(Promise.all(results)).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "AbortError" })]),
        );
        await backend.close();
      },
    );
  });

  it("latches broker cleanup errors and close acknowledgement timeouts", async () => {
    await withBroker(
      (message, _socket, reply) => {
        if (message.kind === "status") reply({ code: "cleanup", kind: "error" });
      },
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: path });
        await expect(backend.status(statusContext())).rejects.toMatchObject({ code: "cleanup" });
        await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
      },
    );

    let markRequestSeen!: () => void;
    const requestSeen = new Promise<void>((resolve) => (markRequestSeen = resolve));
    await withBroker(
      (message, _socket) => {
        if (message.kind !== "start") throw new Error();
        markRequestSeen();
      },
      async (path) => {
        const backend = new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 20, socketPath: path });
        const handle = backend.start(request(), jobContext());
        const result = handle.result.catch(() => undefined);
        await requestSeen;
        await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
        await result;
      },
    );
  });
});
