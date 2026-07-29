import { opaqueIdV1Schema } from "../src/engine/primitives";
import {
  type ManimRenderGatedOciBaseResultV1,
  ManimRenderGatedOciJobRunnerV1,
} from "./manim-render-gated-oci-job-runner";
import {
  digestManimRenderSandboxCancellationFenceV1,
  MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
  MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
  type ManimRenderSandboxCancellationAcknowledgementV1,
  type ManimRenderSandboxCancellationFenceV1,
  type ManimRenderSandboxStatusV1,
  type ManimRenderSandboxTerminalV1,
  manimRenderBrokerShardIdV1Schema,
  type SealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";

export type ManimRenderSandboxOperationContextV1 = Readonly<{
  deadlineEpochMs: number;
  signal: AbortSignal;
}>;

export interface ManimRenderSandboxBackendV1 {
  cancel(
    fence: ManimRenderSandboxCancellationFenceV1,
    context: ManimRenderSandboxOperationContextV1,
  ): Promise<ManimRenderSandboxCancellationAcknowledgementV1>;
  cleanup(jobId: string, context: ManimRenderSandboxOperationContextV1): Promise<void>;
  close(): Promise<void>;
  status(context: ManimRenderSandboxOperationContextV1): Promise<ManimRenderSandboxStatusV1>;
  submitOrReattach(
    request: SealedManimRenderSandboxRequestV2,
    context: ManimRenderSandboxOperationContextV1,
  ): Promise<ManimRenderSandboxTerminalV1>;
}

function terminal(
  request: SealedManimRenderSandboxRequestV2,
  result: ManimRenderGatedOciBaseResultV1,
): ManimRenderSandboxTerminalV1 {
  const descriptor = request.parseDescriptor();
  const correlation = {
    deadlineEpochMs: descriptor.deadlineEpochMs,
    fenceToken: descriptor.fenceToken,
    jobId: descriptor.jobId,
    profileDigest: descriptor.profileDigest,
    requestDigest: request.requestDigest,
    runtimeDigest: descriptor.runtimeDigest,
    schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
    sessionId: descriptor.sessionId,
    sourceDigest: descriptor.sourceDigest,
    tenantId: descriptor.tenantId,
    version: 1 as const,
  };
  return result.kind === "ready"
    ? { ...correlation, ...result, logTail: "" }
    : { ...correlation, code: result.code, kind: "failed", logTail: result.diagnostic ?? "" };
}

/** Concrete broker-side backend; the only execution target is the fixed OCI runner. */
export class ManimRenderGatedOciBackendV1 implements ManimRenderSandboxBackendV1 {
  readonly #brokerShardId: string;
  readonly #runner: ManimRenderGatedOciJobRunnerV1;

  constructor(runner: ManimRenderGatedOciJobRunnerV1, brokerShardId: string) {
    if (!(runner instanceof ManimRenderGatedOciJobRunnerV1)) {
      throw new TypeError("The render sandbox backend requires the concrete gated OCI runner.");
    }
    this.#brokerShardId = manimRenderBrokerShardIdV1Schema.parse(brokerShardId);
    this.#runner = runner;
  }

  async status(context: ManimRenderSandboxOperationContextV1): Promise<ManimRenderSandboxStatusV1> {
    context.signal.throwIfAborted();
    const healthy = await this.#runner.ready(context.signal).catch(() => false);
    context.signal.throwIfAborted();
    return {
      backendId: "manim-render-gated-oci-v1",
      brokerShardId: this.#brokerShardId,
      health: healthy ? "ready" : "unavailable",
      profileDigest: this.#runner.profileDigest,
      runtimeDigest: this.#runner.runtimeDigest,
      stagingRootDigest: this.#runner.stagingRootDigest,
      schema: MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
      version: 1,
    };
  }

  async submitOrReattach(request: SealedManimRenderSandboxRequestV2, context: ManimRenderSandboxOperationContextV1) {
    context.signal.throwIfAborted();
    if (context.deadlineEpochMs !== request.parseDescriptor().deadlineEpochMs) {
      return terminal(request, { code: "request-mismatch", kind: "failed" });
    }
    return terminal(request, await this.#runner.submitOrReattach(request, context.deadlineEpochMs, context.signal));
  }

  async cancel(fence: ManimRenderSandboxCancellationFenceV1, context: ManimRenderSandboxOperationContextV1) {
    context.signal.throwIfAborted();
    await this.#runner.cancel(fence, context.deadlineEpochMs, context.signal);
    return {
      brokerShardId: this.#brokerShardId,
      fenceDigest: digestManimRenderSandboxCancellationFenceV1(fence),
    };
  }

  async cleanup(jobId: string, context: ManimRenderSandboxOperationContextV1) {
    context.signal.throwIfAborted();
    await this.#runner.cleanup(opaqueIdV1Schema.parse(jobId), context.deadlineEpochMs, context.signal);
  }

  close() {
    return this.#runner.close();
  }
}
