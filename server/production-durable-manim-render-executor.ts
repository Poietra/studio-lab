import type {
  DurableManimRenderCancellationRequestV1,
  DurableManimRenderCleanupRequestV1,
  DurableManimRenderExecutionRequestV1,
  DurableManimRenderExecutorV1,
} from "./durable-manim-render-worker";
import {
  createManimRenderProductionSandboxClientV1,
  type ManimRenderProductionSandboxClientOptionsV1,
} from "./manim-render-production-sandbox-client";
import type { ManimRenderSandboxBackendV1 } from "./manim-render-sandbox-backend";
import {
  canonicalManimRenderFenceTokenV1,
  digestManimRenderSandboxCancellationFenceV1,
  encodeManimRenderStagingLocatorV1,
  MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
  manimRenderBrokerShardIdV1Schema,
  manimRenderSandboxCancellationFenceV1Schema,
  SealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";
import { manimTenantIdSchema } from "./manim-request-principal";
import {
  inspectProjectPngBytesV1,
  PROJECT_PNG_LOGICAL_PATH_V1,
  type ProjectPngBlobStoreV1,
} from "./storage/project-png-storage";
import type { SourceContentBlobStoreV1 } from "./storage/workspace-source-repository";

const MAX_CONCURRENT_RENDER_SESSIONS = 4;

function validConcurrentRenderSessions(value: number | undefined) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENT_RENDER_SESSIONS);
}

export type ProductionDurableManimRenderExecutorOptionsV1 = Readonly<{
  backend: ManimRenderSandboxBackendV1;
  blobs: SourceContentBlobStoreV1;
  brokerShardId: string;
  frame: Readonly<{ height: number; width: number }>;
  maxConcurrentJobs?: number;
  projectPngs: Pick<ProjectPngBlobStoreV1, "close" | "read" | "ready">;
  profileDigest: string;
  runtimeDigest: string;
  stagingRootDigest: string;
  tenantId: string;
}>;

/** Durable executor whose only process boundary is the separately supervised UDS broker. */
export class ProductionDurableManimRenderExecutorV1 implements DurableManimRenderExecutorV1 {
  readonly #backend: ManimRenderSandboxBackendV1;
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #brokerShardId: string;
  readonly #frame: typeof MANIM_RENDER_CANONICAL_SCENE_FRAME_V1;
  readonly #projectPngs: Pick<ProjectPngBlobStoreV1, "close" | "read" | "ready">;
  readonly #profileDigest: string;
  readonly #runtimeDigest: string;
  readonly #stagingRootDigest: string;
  readonly #tenantId: string;
  #closeRequest: Promise<void> | null = null;

  constructor(options: ProductionDurableManimRenderExecutorOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    const brokerShard = manimRenderBrokerShardIdV1Schema.safeParse(options.brokerShardId);
    if (
      !tenant.success ||
      !brokerShard.success ||
      !validConcurrentRenderSessions(options.maxConcurrentJobs) ||
      options.frame.height !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.height ||
      options.frame.width !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.width
    ) {
      throw new TypeError("The production durable render executor configuration is invalid.");
    }
    this.#backend = options.backend;
    this.#blobs = options.blobs;
    this.#brokerShardId = brokerShard.data;
    this.#frame = MANIM_RENDER_CANONICAL_SCENE_FRAME_V1;
    this.#projectPngs = options.projectPngs;
    this.#profileDigest = options.profileDigest;
    this.#runtimeDigest = options.runtimeDigest;
    this.#stagingRootDigest = options.stagingRootDigest;
    this.#tenantId = tenant.data;
  }

  get profileDigest() {
    return this.#profileDigest;
  }

  get brokerShardId() {
    return this.#brokerShardId;
  }

  get runtimeDigest() {
    return this.#runtimeDigest;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Render sandbox readiness timed out.")),
      MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1,
    );
    timer.unref();
    try {
      const [status, projectPngsReady] = await Promise.all([
        this.#backend.status({
          deadlineEpochMs: Date.now() + MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1,
          signal: controller.signal,
        }),
        this.#projectPngs.ready(controller.signal),
      ]);
      return (
        projectPngsReady &&
        status.health === "ready" &&
        status.brokerShardId === this.#brokerShardId &&
        status.profileDigest === this.#profileDigest &&
        status.runtimeDigest === this.#runtimeDigest &&
        status.stagingRootDigest === this.#stagingRootDigest
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async submitOrReattach(request: DurableManimRenderExecutionRequestV1) {
    request.signal.throwIfAborted();
    const { session } = request;
    if (
      session.tenantId !== this.#tenantId ||
      request.jobId !== `${this.#tenantId}/${session.id}` ||
      session.deadline.getTime() <= Date.now()
    ) {
      return { code: "interrupted", kind: "failed", logTail: "" } as const;
    }
    const projectPng = session.projectPng;
    const [source, assets] = await Promise.all([
      this.#blobs.readSource(this.#tenantId, session.patched.blob, request.signal),
      projectPng
        ? this.#projectPngs
            .read(this.#tenantId, session.projectId, projectPng.receipt, request.signal)
            .then((bytes) => {
              const inspected = inspectProjectPngBytesV1(bytes);
              if (
                inspected.byteSize !== projectPng.receipt.byteSize ||
                inspected.digest !== projectPng.receipt.digest
              ) {
                throw new Error("The pinned project image.png bytes do not match the render session.");
              }
              return [
                {
                  byteLength: inspected.byteSize,
                  bytesBase64: Buffer.from(inspected.bytes).toString("base64"),
                  digest: inspected.digest,
                  height: inspected.height,
                  logicalPath: PROJECT_PNG_LOGICAL_PATH_V1,
                  mediaType: "image/png" as const,
                  width: inspected.width,
                } as const,
              ];
            })
        : Promise.resolve([]),
    ]);
    request.signal.throwIfAborted();
    const submit = (kind: "thumbnail" | "video") => {
      const sealed = new SealedManimRenderSandboxRequestV2({
        assets,
        deadlineEpochMs: session.deadline.getTime(),
        fenceToken: canonicalManimRenderFenceTokenV1(session.fenceToken),
        jobId: request.jobId,
        output:
          kind === "video"
            ? { frameRate: 15, kind: "video", mediaType: "video/mp4", pixelHeight: 480, pixelWidth: 854 }
            : { frameRate: 15, kind: "thumbnail", mediaType: "image/png", pixelHeight: 480, pixelWidth: 854 },
        profileDigest: this.#profileDigest,
        projectId: session.projectId,
        runtimeDigest: this.#runtimeDigest,
        sceneFrame: this.#frame,
        sceneName: session.sceneName,
        schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
        sessionId: session.id,
        source,
        sourceDigest: session.patched.blob.digest,
        sourcePath: session.sourcePath,
        tenantId: this.#tenantId,
        version: 2,
      });
      return this.#backend.submitOrReattach(sealed, {
        deadlineEpochMs: session.deadline.getTime(),
        signal: request.signal,
      });
    };
    const [video, thumbnail] = await Promise.all([submit("video"), submit("thumbnail")]);
    if (video.kind === "ready" && thumbnail.kind === "ready") {
      return {
        artifactLocator: encodeManimRenderStagingLocatorV1(video),
        kind: "ready",
        logTail: "",
        stagingLocators: {
          thumbnail: encodeManimRenderStagingLocatorV1(thumbnail),
          video: encodeManimRenderStagingLocatorV1(video),
        },
      } as const;
    }
    const cleanupFailed =
      video.kind === "failed" && video.code === "cleanup-failed"
        ? video
        : thumbnail.kind === "failed" && thumbnail.code === "cleanup-failed"
          ? thumbnail
          : null;
    const cancelled =
      video.kind === "failed" && video.code === "cancelled"
        ? video
        : thumbnail.kind === "failed" && thumbnail.code === "cancelled"
          ? thumbnail
          : null;
    const terminal =
      cleanupFailed ?? cancelled ?? (video.kind === "failed" ? video : thumbnail.kind === "failed" ? thumbnail : null);
    if (!terminal) throw new Error("The render sandbox returned an invalid media bundle.");
    return {
      code:
        terminal.code === "cancelled"
          ? "cancelled"
          : terminal.code === "deadline-exceeded"
            ? "interrupted"
            : "render-failed",
      kind: "failed",
      logTail: "",
    } as const;
  }

  async cancel(request: DurableManimRenderCancellationRequestV1) {
    if (request.tenantId !== this.#tenantId) {
      throw new TypeError("The render cancellation identity is invalid.");
    }
    const fence = manimRenderSandboxCancellationFenceV1Schema.parse(request);
    const acknowledgement = await this.#backend.cancel(fence, {
      deadlineEpochMs: Date.now() + MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1,
      signal: new AbortController().signal,
    });
    const fenceDigest = digestManimRenderSandboxCancellationFenceV1(fence);
    if (acknowledgement.brokerShardId !== this.#brokerShardId || acknowledgement.fenceDigest !== fenceDigest) {
      throw new Error("The render cancellation acknowledgement identity is invalid.");
    }
    return { fenceDigest };
  }

  cleanup(request: DurableManimRenderCleanupRequestV1) {
    if (request.tenantId !== this.#tenantId || request.jobId !== `${request.tenantId}/${request.sessionId}`) {
      return Promise.reject(new TypeError("The render cleanup identity is invalid."));
    }
    return this.#backend.cleanup(request.jobId, {
      deadlineEpochMs: Date.now() + MANIM_RENDER_BROKER_OPERATION_BUDGET_MS_V1,
      signal: new AbortController().signal,
    });
  }

  close() {
    this.#closeRequest ??= (async () => {
      const results = await Promise.allSettled([this.#backend.close(), this.#projectPngs.close()]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "The production render executor did not close cleanly.");
    })();
    return this.#closeRequest;
  }
}

export async function createProductionDurableManimRenderExecutorV1(
  options: Readonly<{
    blobs: SourceContentBlobStoreV1;
    client: ManimRenderProductionSandboxClientOptionsV1;
    frame: Readonly<{ height: number; width: number }>;
    maxConcurrentJobs?: number;
    projectPngs: Pick<ProjectPngBlobStoreV1, "close" | "read" | "ready">;
    tenantId: string;
  }>,
) {
  if (!validConcurrentRenderSessions(options.maxConcurrentJobs)) {
    throw new TypeError("The production durable render executor configuration is invalid.");
  }
  const client = await createManimRenderProductionSandboxClientV1(options.client);
  return new ProductionDurableManimRenderExecutorV1({
    backend: client.backend,
    blobs: options.blobs,
    brokerShardId: client.brokerShardId,
    frame: options.frame,
    ...(options.maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs: options.maxConcurrentJobs }),
    projectPngs: options.projectPngs,
    profileDigest: client.profileDigest,
    runtimeDigest: client.runtimeDigest,
    stagingRootDigest: client.stagingRootDigest,
    tenantId: options.tenantId,
  });
}
