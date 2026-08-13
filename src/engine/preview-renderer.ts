import type { CanvasPngAssetTransferV1 } from "./canvas-png-assets";
import {
  type CanvasFrameEvidenceResponseV1,
  CanvasWorkerClientError,
  type CanvasWorkerClientOptions,
  type CaptureCanvasFrameEvidenceInputV1,
  type InstallCanvasSceneInputV1,
  isRecoverableCanvasRenderError,
  PoietraCanvasWorkerClient,
  type PresentedCanvasFrameV1,
  type RenderCanvasFrameInputV1,
  type ReplaceCanvasSceneInputV1,
} from "./canvas-worker-client";
import type { CanvasInteractionResultV1 } from "./canvas-worker-protocol";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import { sceneIrSourceRevisionHash } from "./scene-ir";

/**
 * Bounded surface the Studio preview host may use. It is the retained
 * canvas-worker contract and nothing else: install a verified snapshot once,
 * request correlated frames, dispose. Scheduling (supersede/queue) stays inside
 * the canvas worker client so no additional scheduling path exists.
 * `captureFrameEvidence` is the dev/test-only proof channel bound to this
 * renderer's own presented frames.
 */
export type PreviewRendererV1 = Readonly<{
  captureFrameEvidence?: (input: CaptureCanvasFrameEvidenceInputV1) => Promise<CanvasFrameEvidenceResponseV1>;
  dispose: () => void;
  installScene: (input: InstallCanvasSceneInputV1) => Promise<void>;
  render: (input: RenderCanvasFrameInputV1) => Promise<PresentedCanvasFrameV1>;
  replaceScene: (input: ReplaceCanvasSceneInputV1) => Promise<void>;
}>;

export function createCanvasPreviewRendererV1(options: CanvasWorkerClientOptions = {}): PreviewRendererV1 {
  return new PoietraCanvasWorkerClient(options);
}

export type PreviewFallbackReasonV1 =
  | "capability-unsupported"
  | "disposed"
  | "frame-pending"
  | "frame-stale"
  | "install-failed"
  | "installing"
  | "render-error"
  | "renderer-failed"
  | "sample-out-of-range"
  | "scene-unsupported"
  | "snapshot-unavailable"
  | "snapshot-uncorrelated"
  | "viewport-unavailable";

export type PreviewViewportV1 = Readonly<{ heightPx: number; widthPx: number }>;

export type PreviewFrameRequestV1 = Readonly<{
  sampleTime: number;
  viewport: PreviewViewportV1 | null;
}>;

export type PreviewRendererHostStateV1 =
  | Readonly<{ detail: string | null; phase: "fallback"; reason: PreviewFallbackReasonV1 }>
  | Readonly<{
      frame: Readonly<{
        interaction?: CanvasInteractionResultV1 | null;
        packetId: string;
        revision: string;
        sampleTime: number;
        viewport: PreviewViewportV1;
      }>;
      phase: "presented";
    }>;

export type StudioPreviewRendererHostOptionsV1 = Readonly<{
  createRenderer: () => PreviewRendererV1;
  onStateChange: (state: PreviewRendererHostStateV1) => void;
}>;

export type InstallPreviewSnapshotInputV1 = Readonly<{
  assetPayloads?: readonly CanvasPngAssetTransferV1[];
  canvas: HTMLCanvasElement;
  interactionEntityIds?: readonly string[];
  revision: string;
  snapshot: SceneIrBundleV1;
}>;

export type UpdatePreviewSnapshotInputV1 = Readonly<{
  assetPayloads?: readonly CanvasPngAssetTransferV1[];
  interactionEntityIds?: readonly string[];
  revision: string;
  snapshot: SceneIrBundleV1;
}>;

function sameViewport(left: PreviewViewportV1, right: PreviewViewportV1) {
  return left.heightPx === right.heightPx && left.widthPx === right.widthPx;
}

function sameState(left: PreviewRendererHostStateV1, right: PreviewRendererHostStateV1) {
  if (left.phase === "fallback" && right.phase === "fallback") {
    return left.reason === right.reason && left.detail === right.detail;
  }
  if (left.phase === "presented" && right.phase === "presented") {
    return (
      left.frame.packetId === right.frame.packetId &&
      left.frame.revision === right.frame.revision &&
      left.frame.sampleTime === right.frame.sampleTime &&
      sameViewport(left.frame.viewport, right.frame.viewport)
    );
  }
  return false;
}

function errorDetail(error: CanvasWorkerClientError) {
  return `${error.code}: ${error.message}`;
}

/**
 * Framework-agnostic lifecycle controller for the retained WebGPU preview in
 * the Studio editing surface. It installs one verified snapshot per instance,
 * requests frames through the canvas worker client, and reports "presented"
 * only while the most recently presented frame exactly matches the current
 * revision, sampleTime, and viewport. Every other condition is a whole-Scene
 * fallback with an explicit reason; the host never claims source, export, or
 * final-render success.
 */
export class StudioPreviewRendererHost {
  private readonly createRenderer: () => PreviewRendererV1;
  private readonly onStateChange: (state: PreviewRendererHostStateV1) => void;
  private currentState: PreviewRendererHostStateV1 = { detail: null, phase: "fallback", reason: "installing" };
  private desired: PreviewFrameRequestV1 | null = null;
  private duration = 0;
  private failure: Readonly<{ detail: string | null; reason: PreviewFallbackReasonV1 }> | null = null;
  private lastRenderError: Readonly<{
    detail: string;
    reason: PreviewFallbackReasonV1;
    sampleTime: number;
    viewport: PreviewViewportV1;
  }> | null = null;
  private phase: "disposed" | "failed" | "idle" | "installing" | "ready" | "updating" = "idle";
  private interactionEntityIds: readonly string[] = [];
  private presented: Readonly<{
    interaction: CanvasInteractionResultV1 | null;
    packetId: string;
    sampleTime: number;
    viewport: PreviewViewportV1;
  }> | null = null;
  // True while the retained surface may still show a frame whose presented
  // claim was withdrawn by dispatching a newer render — reported as
  // "frame-stale" rather than "frame-pending" until a fresh frame presents.
  private staleSurface = false;
  private renderGeneration = 0;
  private renderer: PreviewRendererV1 | null = null;
  private revision: string | null = null;
  private updateGeneration = 0;
  private updateTail: Promise<void> = Promise.resolve();
  private queuedRevision: string | null = null;

  constructor(options: StudioPreviewRendererHostOptionsV1) {
    this.createRenderer = options.createRenderer;
    this.onStateChange = options.onStateChange;
  }

  get state(): PreviewRendererHostStateV1 {
    return this.currentState;
  }

  async install(input: InstallPreviewSnapshotInputV1) {
    if (this.phase !== "idle") {
      throw new CanvasWorkerClientError("invalid-state", "The preview renderer host already installed a snapshot.");
    }
    this.phase = "installing";
    this.revision = input.revision;
    this.interactionEntityIds = input.interactionEntityIds ?? [];
    // The playhead range is derived from the installed snapshot itself so no
    // caller can widen it beyond what the Scene actually contains.
    this.duration = input.snapshot.scene.duration;
    this.publish();
    try {
      const snapshot = structuredClone(input.snapshot);
      this.renderer = this.createRenderer();
      await this.renderer.installScene({
        assetPayloads: input.assetPayloads,
        canvas: input.canvas,
        revision: input.revision,
        snapshot,
      });
    } catch (error) {
      if (!this.isDisposed()) {
        this.phase = "failed";
        this.failure = {
          detail: error instanceof CanvasWorkerClientError ? errorDetail(error) : String(error),
          reason: "install-failed",
        };
        this.renderer?.dispose();
        this.renderer = null;
        this.publish();
      }
      return;
    }
    if (this.phase !== "installing") return;
    this.phase = "ready";
    this.queuedRevision = input.revision;
    this.publish();
    if (this.desired) this.renderDesired(this.desired, this.renderGeneration);
  }

  update(input: UpdatePreviewSnapshotInputV1): Promise<void> {
    if ((this.phase !== "ready" && this.phase !== "updating") || !this.renderer || this.revision === null) {
      return Promise.reject(
        new CanvasWorkerClientError("invalid-state", "The preview renderer host has no updatable Scene."),
      );
    }
    const baseRevision = this.queuedRevision ?? this.revision;
    if (input.revision === baseRevision) {
      return Promise.reject(
        new CanvasWorkerClientError("invalid-input", "The preview Scene update revisions are not sequential."),
      );
    }

    let stableInput: UpdatePreviewSnapshotInputV1;
    try {
      stableInput = structuredClone(input);
    } catch (cause) {
      return Promise.reject(
        new CanvasWorkerClientError("invalid-input", "The preview Scene update is not cloneable.", { cause }),
      );
    }
    this.queuedRevision = stableInput.revision;
    this.updateGeneration += 1;
    const generation = this.updateGeneration;
    // Scene mutation and rendering share the worker. Withdraw every visible
    // correlation before either operation can touch the retained surface.
    this.renderGeneration += 1;
    if (this.presented) this.staleSurface = true;
    this.presented = null;
    this.lastRenderError = null;
    this.phase = "updating";
    this.publish();

    const pending = this.updateTail.then(() => this.performUpdate(stableInput, baseRevision, generation));
    // Keep the serialization tail alive so every caller receives its own
    // rejection while later queued work observes the failed host explicitly.
    this.updateTail = pending.catch(() => undefined);
    return pending;
  }

  requestFrame(request: PreviewFrameRequestV1) {
    if (this.phase === "disposed") return;
    this.desired = request;
    this.renderGeneration += 1;
    if (this.phase === "ready") this.renderDesired(request, this.renderGeneration);
    this.publish();
  }

  /**
   * Dev/test-only: reads pixels from the exact frame this host's retained
   * worker last presented, together with that frame's correlation. Throws
   * when the renderer does not expose the evidence channel, when the host is
   * not truthfully presenting (pending, stale, or after a same-target render
   * failure withdrew the presented claim), or when the returned evidence does
   * not match the presented frame's packet/revision/time/viewport exactly.
   */
  async captureEvidence(samples: CaptureCanvasFrameEvidenceInputV1["samples"]) {
    const renderer = this.renderer;
    const revision = this.revision;
    if (this.phase !== "ready" || !renderer || revision === null) {
      throw new CanvasWorkerClientError("invalid-state", "The preview renderer host has no installed snapshot.");
    }
    if (typeof renderer.captureFrameEvidence !== "function") {
      throw new CanvasWorkerClientError("invalid-state", "This renderer does not expose the evidence channel.");
    }
    if (this.currentState.phase !== "presented") {
      throw new CanvasWorkerClientError("invalid-state", "The host is not truthfully presenting a frame to prove.");
    }
    const evidence = await renderer.captureFrameEvidence({ revision, samples });
    // Re-verify after the await: a dispose, teardown, or reinstall during
    // the capture must not let settled evidence pass against a stale claim.
    if (this.phase !== "ready" || this.renderer !== renderer || this.revision !== revision) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        "The preview renderer host changed during the evidence capture.",
      );
    }
    // ...and still truthfully presenting: a supersession or same-target
    // failure in between must not let older evidence pass as proof.
    const state = this.currentState;
    if (state.phase !== "presented") {
      throw new CanvasWorkerClientError("invalid-state", "The host is not truthfully presenting a frame to prove.");
    }
    if (
      evidence.packetId !== state.frame.packetId ||
      evidence.revision !== state.frame.revision ||
      evidence.sampleTime !== state.frame.sampleTime ||
      !sameViewport(evidence.viewport, state.frame.viewport)
    ) {
      throw new CanvasWorkerClientError(
        "protocol-violation",
        "The captured evidence does not match the presented frame.",
      );
    }
    return evidence;
  }

  dispose() {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    // Invalidate the state directly (async callers re-verify against it),
    // deliberately without emitting a callback after dispose.
    this.presented = null;
    this.currentState = { detail: null, phase: "fallback", reason: "disposed" };
    this.renderer?.dispose();
    this.renderer = null;
  }

  private isDisposed() {
    return this.phase === "disposed";
  }

  private async performUpdate(input: UpdatePreviewSnapshotInputV1, baseRevision: string, generation: number) {
    const renderer = this.renderer;
    if (this.phase === "disposed") {
      throw new CanvasWorkerClientError("disposed", "The preview renderer host was disposed.");
    }
    if (this.phase === "failed" || !renderer || this.revision !== baseRevision) {
      throw new CanvasWorkerClientError("invalid-state", "A prior preview Scene update did not commit.");
    }
    try {
      const next = await parseVerifiedSceneIrBundleV1(input.snapshot);
      if (sceneIrSourceRevisionHash(next.scene) !== input.revision) {
        throw new CanvasWorkerClientError(
          "invalid-input",
          "The preview Scene update snapshot revisions do not match the retained host.",
        );
      }
      if (this.isDisposed() || this.renderer !== renderer) return;
      await renderer.replaceScene({
        assetPayloads: input.assetPayloads,
        baseRevision,
        revision: input.revision,
        snapshot: next,
      });
    } catch (error) {
      if (!this.isDisposed() && this.renderer === renderer) {
        const normalized =
          error instanceof CanvasWorkerClientError
            ? error
            : new CanvasWorkerClientError("internal-error", "The preview Scene update failed.", { cause: error });
        this.phase = "failed";
        this.failure = { detail: errorDetail(normalized), reason: "renderer-failed" };
        renderer.dispose();
        this.renderer = null;
        this.publish();
      }
      throw error;
    }
    if (this.isDisposed() || this.renderer !== renderer) return;

    // These authorities advance only after the worker has acknowledged the
    // correlated atomic replacement.
    this.revision = input.revision;
    this.duration = input.snapshot.scene.duration;
    this.interactionEntityIds = input.interactionEntityIds ?? [];
    if (generation !== this.updateGeneration) return;

    this.phase = "ready";
    if (this.desired) this.renderDesired(this.desired, this.renderGeneration);
    this.publish();
  }

  private validationFallback(request: PreviewFrameRequestV1) {
    if (
      request.viewport === null ||
      !Number.isInteger(request.viewport.heightPx) ||
      !Number.isInteger(request.viewport.widthPx) ||
      request.viewport.heightPx < 1 ||
      request.viewport.widthPx < 1
    ) {
      return {
        detail: "The Studio canvas has no measurable viewport.",
        reason: "viewport-unavailable",
      } as const;
    }
    if (!Number.isFinite(request.sampleTime) || request.sampleTime < 0 || request.sampleTime > this.duration) {
      return {
        detail: `Sample time ${request.sampleTime} is outside the installed Scene duration ${this.duration}.`,
        reason: "sample-out-of-range",
      } as const;
    }
    return null;
  }

  private renderDesired(request: PreviewFrameRequestV1, generation: number) {
    const renderer = this.renderer;
    const revision = this.revision;
    if (!renderer || revision === null) return;
    if (this.validationFallback(request) !== null || request.viewport === null) return;
    const target = {
      ...(this.interactionEntityIds.length > 0 ? { interactionEntityIds: this.interactionEntityIds } : {}),
      revision,
      sampleTime: request.sampleTime,
      viewport: request.viewport,
    };
    // A valid fresh attempt supersedes any recoverable failure previously
    // recorded for the same target. Until this generation settles, report a
    // pending/stale surface rather than attributing the old failure to it.
    this.lastRenderError = null;
    // Dispatching a valid attempt withdraws the presented claim
    // synchronously: an earlier render may already be mutating the surface,
    // so re-requesting a previously presented target must never re-claim its
    // old metadata (the A→B→A scrub) until THIS attempt's correlated success.
    if (this.presented) {
      this.presented = null;
      this.staleSurface = true;
    }
    // The render is dispatched synchronously so the canvas worker client's own
    // supersede queue stays the only scheduling path; only a synchronous throw
    // is converted into the regular error handling.
    let pending: Promise<PresentedCanvasFrameV1>;
    try {
      pending = renderer.render(target);
    } catch (error) {
      this.handleRenderError(error, request, generation);
      return;
    }
    void pending
      .then((frame) => this.acceptFrame(frame, target, generation))
      .catch((error: unknown) => this.handleRenderError(error, request, generation));
  }

  private acceptFrame(
    frame: PresentedCanvasFrameV1,
    target: Readonly<{ revision: string; sampleTime: number; viewport: PreviewViewportV1 }>,
    generation: number,
  ) {
    if (this.phase !== "ready") return;
    // The host verifies correlation itself instead of trusting the renderer
    // implementation behind the bounded interface.
    if (
      frame.revision !== target.revision ||
      frame.sampleTime !== target.sampleTime ||
      !sameViewport(frame.viewport, target.viewport)
    ) {
      this.phase = "failed";
      this.failure = {
        detail: "protocol-violation: the presented frame does not match its render request.",
        reason: "renderer-failed",
      };
      this.renderer?.dispose();
      this.renderer = null;
      this.publish();
      return;
    }
    // A completion for a superseded request never overrides a newer one, even
    // when the underlying promises settle out of order.
    if (generation !== this.renderGeneration) return;
    this.presented = {
      interaction: frame.interaction ?? null,
      packetId: frame.packetId,
      sampleTime: frame.sampleTime,
      viewport: frame.viewport,
    };
    // The newest attempt for the current generation succeeded, so the surface
    // matches the claim again and an error recorded by an earlier attempt no
    // longer describes it.
    this.staleSurface = false;
    this.lastRenderError = null;
    this.publish();
  }

  private handleRenderError(error: unknown, request: PreviewFrameRequestV1, generation: number) {
    if (this.phase !== "ready") return;
    const normalized =
      error instanceof CanvasWorkerClientError
        ? error
        : new CanvasWorkerClientError("internal-error", "The preview render failed.", { cause: error });
    if (normalized.code === "stale-response" || normalized.code === "disposed") return;
    // Fatality mirrors the client's own classification: any code the client
    // does not survive leaves a terminated worker behind the interface.
    if (!isRecoverableCanvasRenderError(normalized.code)) {
      this.phase = "failed";
      this.failure = { detail: errorDetail(normalized), reason: "renderer-failed" };
      this.renderer?.dispose();
      this.renderer = null;
      this.publish();
      return;
    }
    if (generation !== this.renderGeneration) return;
    if (request.viewport === null) return;
    // The presented claim for this attempt was already withdrawn when the
    // attempt was dispatched; recording the error makes the fallback name the
    // failure instead of a stale surface. A later success re-presents.
    this.lastRenderError = {
      detail: errorDetail(normalized),
      reason: normalized.code === "unsupported-frame" ? "capability-unsupported" : "render-error",
      sampleTime: request.sampleTime,
      viewport: request.viewport,
    };
    this.publish();
  }

  private computeState(): PreviewRendererHostStateV1 {
    if (this.phase === "disposed") {
      return { detail: null, phase: "fallback", reason: "disposed" };
    }
    if (this.phase === "failed") {
      return {
        detail: this.failure?.detail ?? null,
        phase: "fallback",
        reason: this.failure?.reason ?? "renderer-failed",
      };
    }
    if (this.phase === "updating") {
      return {
        detail: null,
        phase: "fallback",
        reason: this.staleSurface ? "frame-stale" : "frame-pending",
      };
    }
    if (this.phase !== "ready") {
      return { detail: null, phase: "fallback", reason: "installing" };
    }
    const desired = this.desired;
    if (!desired) return { detail: null, phase: "fallback", reason: "frame-pending" };
    const validation = this.validationFallback(desired);
    if (validation) return { detail: validation.detail, phase: "fallback", reason: validation.reason };
    const viewport = desired.viewport;
    if (viewport === null) return { detail: null, phase: "fallback", reason: "viewport-unavailable" };
    if (
      this.presented &&
      this.revision !== null &&
      this.presented.sampleTime === desired.sampleTime &&
      sameViewport(this.presented.viewport, viewport)
    ) {
      return {
        frame: {
          ...(this.presented.interaction ? { interaction: this.presented.interaction } : {}),
          packetId: this.presented.packetId,
          revision: this.revision,
          sampleTime: this.presented.sampleTime,
          viewport: this.presented.viewport,
        },
        phase: "presented",
      };
    }
    if (
      this.lastRenderError &&
      this.lastRenderError.sampleTime === desired.sampleTime &&
      sameViewport(this.lastRenderError.viewport, viewport)
    ) {
      return { detail: this.lastRenderError.detail, phase: "fallback", reason: this.lastRenderError.reason };
    }
    return {
      detail: null,
      phase: "fallback",
      reason: this.presented || this.staleSurface ? "frame-stale" : "frame-pending",
    };
  }

  private publish() {
    if (this.phase === "disposed") return;
    const next = this.computeState();
    if (sameState(this.currentState, next)) return;
    this.currentState = next;
    this.onStateChange(next);
  }
}
