import { DurableMaintenanceWorkerCoreV1 } from "./durable-gc-core";
import {
  MAX_DURABLE_RENDER_RETENTION_MS_V1,
  MIN_DURABLE_RENDER_RETENTION_MS_V1,
  type RenderSessionRetentionRepositoryV1,
} from "./render-session-repository";

const MAX_BATCH_SIZE = 256;

export type RenderSessionRetentionSweepResultV1 = Readonly<{
  projectPngGenerationsOrphaned: number;
  purgedSessions: number;
  releasedSessionIds: readonly string[];
  sourceBlobsOrphaned: number;
}>;

export type DurableRenderSessionRetentionWorkerOptionsV1 = Readonly<{
  auditRetentionMs: number;
  batchSize: number;
  inputRetentionMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: RenderSessionRetentionRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Releases retained inputs first, then purges only already-released audit rows. */
export class DurableRenderSessionRetentionWorkerV1 extends DurableMaintenanceWorkerCoreV1<RenderSessionRetentionSweepResultV1> {
  constructor(options: DurableRenderSessionRetentionWorkerOptionsV1) {
    boundedInteger(options.batchSize, 1, MAX_BATCH_SIZE, "Render-session retention batchSize");
    boundedInteger(
      options.inputRetentionMs,
      MIN_DURABLE_RENDER_RETENTION_MS_V1,
      MAX_DURABLE_RENDER_RETENTION_MS_V1,
      "Render-session inputRetentionMs",
    );
    boundedInteger(
      options.auditRetentionMs,
      MIN_DURABLE_RENDER_RETENTION_MS_V1,
      MAX_DURABLE_RENDER_RETENTION_MS_V1,
      "Render-session auditRetentionMs",
    );
    super({
      intervalMs: options.intervalMs,
      onFailure: options.onFailure,
      startOnceError: "The render-session retention worker can only be started once.",
      sweepTimeoutMs: options.sweepTimeoutMs,
      validationPrefix: "Render-session retention",
      run: async (signal) => {
        if (!(await options.repository.ready(signal))) {
          throw new Error("Render-session retention storage readiness is unavailable.");
        }
        signal.throwIfAborted();
        const released = await options.repository.releaseExpiredInputs(
          {
            maximum: options.batchSize,
            retentionMs: options.inputRetentionMs,
            tenantId: options.tenantId,
          },
          signal,
        );
        const purgedSessions = await options.repository.purgeReleasedSessions(
          {
            auditRetentionMs: options.auditRetentionMs,
            maximum: options.batchSize,
            tenantId: options.tenantId,
          },
          signal,
        );
        return { ...released, purgedSessions };
      },
    });
  }
}

export async function createDurableRenderSessionRetentionWorkerV1(
  options: DurableRenderSessionRetentionWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableRenderSessionRetentionWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
