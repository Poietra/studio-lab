import type {
  DurableFastManimSnapshotRunnerFactoryV1,
  DurableFastManimSnapshotRunnerHandleV1,
} from "./durable-fast-manim-snapshot-service";
import {
  createFastManimProductionSandboxClientV1,
  type FastManimProductionSandboxClientOptionsV1,
} from "./fast-manim-production-sandbox-client";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";

export type FastManimProductionSnapshotRunnerFactoryOptionsV1 = Readonly<{
  client: FastManimProductionSandboxClientOptionsV1;
  frame: Readonly<{ height: number; width: number }>;
  tenantId: string;
  timeoutMs?: number;
}>;

/** Creates one independently owned production broker client per durable project runner. */
export class FastManimProductionSnapshotRunnerFactoryV1 implements DurableFastManimSnapshotRunnerFactoryV1 {
  readonly #options: FastManimProductionSnapshotRunnerFactoryOptionsV1;
  #closed = false;

  constructor(options: FastManimProductionSnapshotRunnerFactoryOptionsV1) {
    this.#options = options;
  }

  async create(
    input: Parameters<DurableFastManimSnapshotRunnerFactoryV1["create"]>[0],
  ): Promise<DurableFastManimSnapshotRunnerHandleV1> {
    if (this.#closed) throw new Error("The production snapshot runner factory is closed.");
    const client = await createFastManimProductionSandboxClientV1(this.#options.client);
    if (this.#closed) {
      await client.backend.close();
      throw new Error("The production snapshot runner factory is closed.");
    }
    try {
      return {
        profileDigest: client.profileDigest,
        runner: new FastManimSnapshotRunner({
          attestationVerifier: client.attestationVerifier,
          backend: client.backend,
          deployment: "production",
          frame: this.#options.frame,
          projectId: input.projectId,
          sourceProvider: input.sourceProvider,
          tenantId: this.#options.tenantId,
          ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
        }),
      };
    } catch (error) {
      const cleanup = await client.backend.close().then(
        () => [],
        (cleanupError: unknown) => [cleanupError],
      );
      if (cleanup.length > 0) {
        throw new AggregateError([error, ...cleanup], "Snapshot runner construction and cleanup failed.");
      }
      throw error;
    }
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed) return false;
    let handle: DurableFastManimSnapshotRunnerHandleV1;
    try {
      handle = await this.create({
        projectId: "snapshot-readiness",
        sourceProvider: {
          readVerified: async () => {
            throw new Error("Readiness must not read project source.");
          },
        },
      });
    } catch {
      signal?.throwIfAborted();
      return false;
    }
    let healthy = false;
    try {
      healthy = await handle.runner.ready(signal);
    } catch {
      signal?.throwIfAborted();
    }
    try {
      await handle.runner.close();
    } catch {
      healthy = false;
    }
    signal?.throwIfAborted();
    return healthy;
  }

  async close() {
    this.#closed = true;
  }
}
