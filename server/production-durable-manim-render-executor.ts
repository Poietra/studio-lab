import type { DurableManimRenderExecutionRequestV1, DurableManimRenderExecutorV1 } from "./durable-manim-render-worker";
import {
  createManimRenderProductionSandboxClientV1,
  type ManimRenderProductionSandboxClientOptionsV1,
} from "./manim-render-production-sandbox-client";
import type { ManimRenderSandboxBackendV1 } from "./manim-render-sandbox-backend";
import {
  canonicalManimRenderFenceTokenV1,
  encodeManimRenderStagingLocatorV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
  SealedManimRenderSandboxRequestV1,
} from "./manim-render-sandbox-contract";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { SourceContentBlobStoreV1 } from "./storage/workspace-source-repository";

const READINESS_TIMEOUT_MS = 10_000;

export type ProductionDurableManimRenderExecutorOptionsV1 = Readonly<{
  backend: ManimRenderSandboxBackendV1;
  blobs: SourceContentBlobStoreV1;
  frame: Readonly<{ height: number; width: number }>;
  profileDigest: string;
  runtimeDigest: string;
  tenantId: string;
}>;

/** Durable executor whose only process boundary is the separately supervised UDS broker. */
export class ProductionDurableManimRenderExecutorV1 implements DurableManimRenderExecutorV1 {
  readonly #backend: ManimRenderSandboxBackendV1;
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #frame: typeof MANIM_RENDER_CANONICAL_SCENE_FRAME_V1;
  readonly #profileDigest: string;
  readonly #runtimeDigest: string;
  readonly #tenantId: string;

  constructor(options: ProductionDurableManimRenderExecutorOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (
      !tenant.success ||
      options.frame.height !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.height ||
      options.frame.width !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.width
    ) {
      throw new TypeError("The production durable render executor configuration is invalid.");
    }
    this.#backend = options.backend;
    this.#blobs = options.blobs;
    this.#frame = MANIM_RENDER_CANONICAL_SCENE_FRAME_V1;
    this.#profileDigest = options.profileDigest;
    this.#runtimeDigest = options.runtimeDigest;
    this.#tenantId = tenant.data;
  }

  get profileDigest() {
    return this.#profileDigest;
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
      READINESS_TIMEOUT_MS,
    );
    timer.unref();
    try {
      const status = await this.#backend.status({
        deadlineEpochMs: Date.now() + READINESS_TIMEOUT_MS,
        signal: controller.signal,
      });
      return (
        status.health === "ready" &&
        status.profileDigest === this.#profileDigest &&
        status.runtimeDigest === this.#runtimeDigest
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
    const source = await this.#blobs.readSource(this.#tenantId, session.patched.blob, request.signal);
    request.signal.throwIfAborted();
    const submit = (kind: "thumbnail" | "video") => {
      const sealed = new SealedManimRenderSandboxRequestV1({
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
        schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
        sessionId: session.id,
        source,
        sourceDigest: session.patched.blob.digest,
        sourcePath: session.sourcePath,
        tenantId: this.#tenantId,
        version: 1,
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
    const terminal = video.kind === "failed" ? video : thumbnail.kind === "failed" ? thumbnail : null;
    if (!terminal) throw new Error("The render sandbox returned an invalid media bundle.");
    return {
      code: terminal.code === "cancelled" || terminal.code === "deadline-exceeded" ? "interrupted" : "render-failed",
      kind: "failed",
      logTail: "",
    } as const;
  }

  cancel(request: Readonly<{ jobId: string; sessionId: string; tenantId: string }>) {
    if (request.tenantId !== this.#tenantId || request.jobId !== `${request.tenantId}/${request.sessionId}`) {
      return Promise.reject(new TypeError("The render cancellation identity is invalid."));
    }
    return this.#backend.cancel(request.jobId, {
      deadlineEpochMs: Date.now() + READINESS_TIMEOUT_MS,
      signal: new AbortController().signal,
    });
  }

  close() {
    return this.#backend.close();
  }
}

export async function createProductionDurableManimRenderExecutorV1(
  options: Readonly<{
    blobs: SourceContentBlobStoreV1;
    client: ManimRenderProductionSandboxClientOptionsV1;
    frame: Readonly<{ height: number; width: number }>;
    tenantId: string;
  }>,
) {
  const client = await createManimRenderProductionSandboxClientV1(options.client);
  return new ProductionDurableManimRenderExecutorV1({
    backend: client.backend,
    blobs: options.blobs,
    frame: options.frame,
    profileDigest: client.profileDigest,
    runtimeDigest: client.runtimeDigest,
    tenantId: options.tenantId,
  });
}
