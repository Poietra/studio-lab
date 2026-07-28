import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerResultBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  type FastManimSandboxBrokerClientMessageV1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerServerMessageV1,
  fastManimSandboxBrokerClientMessageV1Schema,
  MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1,
} from "./fast-manim-sandbox-broker-protocol";
import {
  FastManimUdsSandboxBackendV1,
  MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1,
} from "./fast-manim-uds-sandbox-backend";
import {
  productionSandboxReadyStatus,
  sandboxProducerRequest,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const identity = { projectId: "default", requestId: "uds-client-test", tenantId: "test-tenant" } as const;
const attestationDigest = "c".repeat(64);

type BrokerHandler = (message: FastManimSandboxBrokerClientMessageV1, socket: Socket) => boolean | undefined;
type ServerMessageBody = FastManimSandboxBrokerServerMessageV1 extends infer Message
  ? Message extends FastManimSandboxBrokerServerMessageV1
    ? Omit<Message, "correlationId" | "protocol" | "version">
    : never
  : never;

type TestBroker = Readonly<{
  close: () => Promise<void>;
  path: string;
}>;

function serverMessage(correlationId: string, message: ServerMessageBody): FastManimSandboxBrokerServerMessageV1 {
  return {
    ...message,
    correlationId,
    protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
    version: FAST_MANIM_SANDBOX_BROKER_VERSION_V1,
  } as FastManimSandboxBrokerServerMessageV1;
}

function send(socket: Socket, message: FastManimSandboxBrokerServerMessageV1) {
  socket.write(encodeFastManimSandboxBrokerFrameV1(message));
}

async function listen(server: Server, path: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function createTestBroker(handler: BrokerHandler): Promise<TestBroker> {
  const directory = await mkdtemp(join(tmpdir(), "poietra-uds-client-"));
  const path = join(directory, "broker.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new FastManimSandboxBrokerFrameDecoderV1();
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        socket.destroy();
        return;
      }
      try {
        for (const rawMessage of decoder.push(chunk)) {
          const message = fastManimSandboxBrokerClientMessageV1Schema.parse(rawMessage);
          if (handler(message, socket) === true) continue;
          if (message.kind === "abort") {
            send(
              socket,
              serverMessage(message.correlationId, {
                jobId: message.jobId,
                kind: "abort-ack",
              }),
            );
          } else if (message.kind === "close") {
            send(socket, serverMessage(message.correlationId, { kind: "close-ack" }));
            socket.end();
          }
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await listen(server, path);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    },
    path,
  };
}

async function withBroker(handler: BrokerHandler, run: (broker: TestBroker) => Promise<void>) {
  const broker = await createTestBroker(handler);
  try {
    await run(broker);
  } finally {
    await broker.close();
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

function okResultMessage(
  message: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>,
  resultBytes: Uint8Array,
) {
  return serverMessage(message.correlationId, {
    jobId: message.jobId,
    kind: "job-result",
    result: {
      attestationDigest: message.attestationDigest,
      kind: "ok",
      requestDigest: message.requestDigest,
      resultBytesBase64: encodeFastManimSandboxBrokerResultBytesV1(resultBytes),
    },
  });
}

describe("FastManimUdsSandboxBackendV1", () => {
  it("validates configuration before opening a socket", () => {
    expect(() => new FastManimUdsSandboxBackendV1({ socketPath: "relative.sock" })).toThrow(/absolute/i);
    expect(() => new FastManimUdsSandboxBackendV1({ socketPath: "/tmp/broker\0.sock" })).toThrow(/bounded/i);
    expect(
      () =>
        new FastManimUdsSandboxBackendV1({
          socketPath: `/${"x".repeat(MAX_FAST_MANIM_SANDBOX_BROKER_SOCKET_PATH_BYTES_V1)}`,
        }),
    ).toThrow(/bounded/i);
    expect(() => new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 0, socketPath: "/tmp/broker.sock" })).toThrow(
      /close timeout/i,
    );
  });

  it("validates status and job results received over one UDS session", async () => {
    const status = productionSandboxReadyStatus();
    await withBroker(
      (message, socket) => {
        if (message.kind === "status") {
          send(socket, serverMessage(message.correlationId, { kind: "status-result", status }));
          return true;
        }
        if (message.kind === "start") {
          send(socket, okResultMessage(message, Uint8Array.from([1, 2, 3])));
          return true;
        }
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        await expect(backend.status(statusContext())).resolves.toEqual(status);
        const bundle = request();
        await expect(backend.start(bundle, jobContext()).result).resolves.toEqual({
          attestationDigest,
          kind: "ok",
          requestDigest: bundle.requestDigest,
          resultBytes: Uint8Array.from([1, 2, 3]),
        });
        await backend.close();
      },
    );
  });

  it("multiplexes jobs by correlation ID and accepts out-of-order results", async () => {
    const starts: Extract<FastManimSandboxBrokerClientMessageV1, { kind: "start" }>[] = [];
    await withBroker(
      (message, socket) => {
        if (message.kind !== "start") return;
        starts.push(message);
        if (starts.length === 2) {
          send(socket, okResultMessage(starts[1]!, Uint8Array.from([2])));
          send(socket, okResultMessage(starts[0]!, Uint8Array.from([1])));
        }
        return true;
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        const first = backend.start(request(), jobContext()).result;
        const second = backend.start(request(), jobContext()).result;
        await expect(
          Promise.all([first, second]).then((results) =>
            results.map((result) => (result.kind === "ok" ? [...result.resultBytes] : [])),
          ),
        ).resolves.toEqual([[1], [2]]);
        expect(new Set(starts.map(({ correlationId }) => correlationId)).size).toBe(2);
        expect(new Set(starts.map(({ jobId }) => jobId)).size).toBe(2);
        await backend.close();
      },
    );
  });

  it("fails closed when a broker result changes the request identity", async () => {
    await withBroker(
      (message, socket) => {
        if (message.kind !== "start") return;
        const response = okResultMessage(message, Uint8Array.of(1));
        if (response.kind !== "job-result") throw new Error("Expected a job result fixture.");
        send(socket, {
          ...response,
          result: { ...response.result, requestDigest: "d".repeat(64) },
        });
        return true;
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        await expect(backend.start(request(), jobContext()).result).rejects.toThrow(/failed closed/i);
        await backend.close();
      },
    );
  });

  it("sends a wire abort for the matching active job", async () => {
    let startedJobId: string | undefined;
    let resolveStart!: () => void;
    const startSeen = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let resolveAbort!: (jobId: string) => void;
    const abortSeen = new Promise<string>((resolve) => {
      resolveAbort = resolve;
    });
    await withBroker(
      (message) => {
        if (message.kind === "start") {
          startedJobId = message.jobId;
          resolveStart();
          return true;
        }
        if (message.kind === "abort") resolveAbort(message.jobId);
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        const handle = backend.start(request(), jobContext());
        await startSeen;
        handle.abort();
        await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
        await expect(abortSeen).resolves.toBe(startedJobId);
        await backend.close();
      },
    );
  });

  it("fails every multiplexed operation when the broker disconnects", async () => {
    let disconnected = false;
    await withBroker(
      (message, socket) => {
        if (message.kind === "start" && !disconnected) {
          disconnected = true;
          setImmediate(() => socket.destroy());
        }
        return message.kind === "start";
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        const first = backend.start(request(), jobContext()).result;
        const second = backend.start(request(), jobContext()).result;
        await expect(first).rejects.toThrow(/failed closed/i);
        await expect(second).rejects.toThrow(/failed closed/i);
        await expect(backend.status(statusContext())).rejects.toThrow(/failed closed/i);
        await backend.close();
      },
    );
  });

  it.each(["malformed", "oversized"] as const)("fails all pending operations on a %s response", async (mode) => {
    let sent = false;
    await withBroker(
      (message, socket) => {
        if (message.kind !== "status" || sent) return message.kind === "status";
        sent = true;
        const header = Buffer.alloc(4);
        if (mode === "oversized") {
          header.writeUInt32BE(MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1 + 1);
          socket.write(header);
        } else {
          header.writeUInt32BE(1);
          socket.write(Buffer.concat([header, Buffer.from("{")]));
        }
        return true;
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        const first = backend.status(statusContext());
        const second = backend.status(statusContext());
        await expect(first).rejects.toThrow(/failed closed/i);
        await expect(second).rejects.toThrow(/failed closed/i);
        await backend.close();
      },
    );
  });

  it("aborts active jobs and completes session close within its bound", async () => {
    const seen: string[] = [];
    let resolveStart!: () => void;
    const startSeen = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    await withBroker(
      (message) => {
        seen.push(message.kind);
        if (message.kind === "start") resolveStart();
        return message.kind === "start";
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 500, socketPath: broker.path });
        const handle = backend.start(request(), jobContext());
        await startSeen;
        const result = handle.result.catch((error: unknown) => error);
        await backend.close();
        await expect(result).resolves.toMatchObject({ name: "AbortError" });
        expect(seen).toEqual(["start", "abort", "close"]);
      },
    );
  });

  it("rejects close when the broker does not acknowledge cleanup", async () => {
    const status = productionSandboxReadyStatus();
    await withBroker(
      (message, socket) => {
        if (message.kind === "status") {
          send(socket, serverMessage(message.correlationId, { kind: "status-result", status }));
          return true;
        }
        return message.kind === "close";
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ closeTimeoutMs: 20, socketPath: broker.path });
        await expect(backend.status(statusContext())).resolves.toEqual(status);
        await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
      },
    );
  });

  it("rejects every broker error returned for session close", async () => {
    const status = productionSandboxReadyStatus();
    await withBroker(
      (message, socket) => {
        if (message.kind === "status") {
          send(socket, serverMessage(message.correlationId, { kind: "status-result", status }));
          return true;
        }
        if (message.kind === "close") {
          send(
            socket,
            serverMessage(message.correlationId, {
              code: "unavailable",
              kind: "error",
              operation: "close",
            }),
          );
          return true;
        }
      },
      async (broker) => {
        const backend = new FastManimUdsSandboxBackendV1({ socketPath: broker.path });
        await expect(backend.status(statusContext())).resolves.toEqual(status);
        await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
      },
    );
  });
});
