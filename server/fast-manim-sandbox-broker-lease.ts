import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";

const SOCKET_PROBE_TIMEOUT_MS = 1_000;

export class FastManimSandboxBrokerLeaseErrorV1 extends Error {
  readonly code: "busy" | "unsafe";

  constructor(code: "busy" | "unsafe") {
    super(code === "busy" ? "Another sandbox broker owns the lease." : "The sandbox broker lease is unsafe.");
    this.name = "FastManimSandboxBrokerLeaseErrorV1";
    this.code = code;
  }
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function listen(server: Server, address: string) {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function probeSocket(socketPath: string) {
  return new Promise<"active" | "missing" | "stale">((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: "active" | "missing" | "stale") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectProbe(new FastManimSandboxBrokerLeaseErrorV1("unsafe"));
    }, SOCKET_PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("missing");
      else if (error.code === "ECONNREFUSED") finish("stale");
      else {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        rejectProbe(new FastManimSandboxBrokerLeaseErrorV1("unsafe"));
      }
    });
  });
}

export type FastManimSandboxBrokerLeaseV1 = Readonly<{
  close: () => Promise<void>;
}>;

async function acquireKernelLease(scope: "broker" | "owner", identity: string): Promise<FastManimSandboxBrokerLeaseV1> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined || process.platform !== "linux") {
    throw new FastManimSandboxBrokerLeaseErrorV1("unsafe");
  }
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  const leaseAddress = `\0poietra-fm-${scope}-v1-${effectiveUid}-${digest}`;
  const server = createServer((socket) => socket.destroy());
  try {
    await listen(server, leaseAddress);
    server.unref();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new FastManimSandboxBrokerLeaseErrorV1("busy");
    }
    throw new FastManimSandboxBrokerLeaseErrorV1("unsafe");
  }
  let closeRequest: Promise<void> | null = null;
  return {
    close() {
      closeRequest ??= closeServer(server);
      return closeRequest;
    },
  };
}

/** Elects one process for a shared immutable owner namespace without touching the filesystem. */
export function acquireFastManimSandboxOwnerLeaseV1(ownerDigest: string) {
  if (!/^[a-f0-9]{64}$/u.test(ownerDigest)) {
    return Promise.reject(new FastManimSandboxBrokerLeaseErrorV1("unsafe"));
  }
  return acquireKernelLease("owner", ownerDigest);
}

/**
 * Acquires a kernel-owned singleton before touching a stale filesystem socket.
 * Linux abstract UDS names disappear with the process, so crash recovery needs
 * neither a stale PID heuristic nor a racy lock-file replacement protocol.
 * All broker instances for one filesystem socket must share the host network
 * namespace; the production service topology must not containerize this lease.
 */
export async function acquireFastManimSandboxBrokerLeaseV1(socketPath: string): Promise<FastManimSandboxBrokerLeaseV1> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) throw new FastManimSandboxBrokerLeaseErrorV1("unsafe");
  const lease = await acquireKernelLease("broker", socketPath);

  try {
    const socketState = await probeSocket(socketPath);
    if (socketState === "active") throw new FastManimSandboxBrokerLeaseErrorV1("busy");
    if (socketState === "stale") {
      const metadata = await lstat(socketPath);
      if (!metadata.isSocket() || metadata.uid !== effectiveUid) {
        throw new FastManimSandboxBrokerLeaseErrorV1("unsafe");
      }
      await unlink(socketPath);
    }
  } catch (error) {
    await lease.close().catch(() => undefined);
    throw error;
  }
  return lease;
}
