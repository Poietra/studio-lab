import { z } from "zod";
import { type EvidenceCanvasV1, installCanvasFrameEvidenceCaptureV1 } from "./canvas-frame-evidence";
import { type CanvasWorkerClientEvidenceAdapterV1, CanvasWorkerClientError } from "./canvas-worker-client";
import {
  canvasWorkerRequestEnvelopeV1,
  canvasWorkerResponseEnvelopeV1,
  canvasWorkerResponseV1Schema,
  POIETRA_CANVAS_WORKER_VERSION,
} from "./canvas-worker-protocol";
import type { CanvasWorkerEvidenceSupportV1 } from "./poietra-canvas.worker";
import { finiteNumberV1Schema, opaqueIdV1Schema, sha256V1Schema } from "./primitives";
import { renderViewportV1Schema } from "./render-packet";

/**
 * Dev/test-only frame-evidence extension for the retained canvas worker: the
 * extended protocol (capture request + evidence response), the worker-side
 * support that arms GPU readback, and the client-side adapter that dispatches
 * captures against the dev worker entry. Production builds import none of
 * this module's values, so no evidence protocol or readback code reaches the
 * production bundles.
 */
export const MAX_CANVAS_EVIDENCE_SAMPLES = 16;

const evidenceSamplePointV1Schema = z
  .object({
    fractionX: finiteNumberV1Schema.min(0).max(1),
    fractionY: finiteNumberV1Schema.min(0).max(1),
  })
  .strict();

export const captureFrameEvidenceRequestV1Schema = z
  .object({
    ...canvasWorkerRequestEnvelopeV1,
    kind: z.literal("capture-frame-evidence"),
    revision: sha256V1Schema,
    samples: z.array(evidenceSamplePointV1Schema).min(1).max(MAX_CANVAS_EVIDENCE_SAMPLES),
  })
  .strict();

const rgbaSampleV1Schema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

// Pixels read back from the exact surface frame the worker last presented,
// with that frame's correlation, so E2E can prove the retained host worker
// rendered the presented content itself.
export const frameEvidenceResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    kind: z.literal("frame-evidence"),
    packetId: opaqueIdV1Schema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    samples: z.array(rgbaSampleV1Schema).min(1).max(MAX_CANVAS_EVIDENCE_SAMPLES),
    surfaceFormat: z.string().min(1).max(64),
    viewport: renderViewportV1Schema,
  })
  .strict();

export const canvasWorkerResponseWithEvidenceV1Schema = z.discriminatedUnion("kind", [
  ...canvasWorkerResponseV1Schema.options,
  frameEvidenceResponseV1Schema,
]);

export type CanvasEvidenceSamplePointV1 = z.infer<typeof evidenceSamplePointV1Schema>;
export type CanvasFrameEvidenceResponseV1 = z.infer<typeof frameEvidenceResponseV1Schema>;

/** Worker-side support, injected by the dev worker entry. */
export function createCanvasWorkerEvidenceSupportV1(): CanvasWorkerEvidenceSupportV1 {
  return {
    createCapture: (canvas) => installCanvasFrameEvidenceCaptureV1(canvas as unknown as EvidenceCanvasV1),
    handleRequest: async (value, host) => {
      const parsed = captureFrameEvidenceRequestV1Schema.safeParse(value);
      if (!parsed.success) return false;
      const request = parsed.data;
      if (!host.capture) {
        host.postError(request, "invalid-state", null, "Frame evidence capture is not enabled on this worker.");
        return true;
      }
      if (request.revision !== host.revision) {
        host.postError(request, "stale-revision", null, "The evidence revision is stale.");
        return true;
      }
      let evidence: Awaited<ReturnType<NonNullable<typeof host.capture>["readSamples"]>>;
      try {
        evidence = await host.capture.readSamples(request.samples);
      } catch (error) {
        host.postError(request, "internal-error", error, "Frame evidence readback failed.");
        return true;
      }
      if (!evidence) {
        host.postError(request, "invalid-state", null, "No presented frame has been captured yet.");
        return true;
      }
      // The response carries the revision retained with the captured frame,
      // never the requester's claim; another revision's frame is refused.
      if (evidence.correlation.revision !== request.revision) {
        host.postError(request, "invalid-state", null, "No presented frame has been captured for this revision.");
        return true;
      }
      host.postResponse({
        kind: "frame-evidence",
        packetId: evidence.correlation.packetId,
        requestId: request.requestId,
        revision: evidence.correlation.revision,
        sampleTime: evidence.correlation.sampleTime,
        samples: evidence.samples.map((sample) => [...sample] as [number, number, number, number]),
        schema: "poietra.canvas-worker-response",
        surfaceFormat: evidence.surfaceFormat,
        version: POIETRA_CANVAS_WORKER_VERSION,
        viewport: evidence.correlation.viewport,
      });
      return true;
    },
  };
}

/** Client-side adapter, wired in by dev/test snapshot providers only. */
export function createCanvasWorkerClientEvidenceAdapterV1(): CanvasWorkerClientEvidenceAdapterV1 {
  return {
    capture: async ({ dispatch, requestId, revision, samples }) => {
      const request = captureFrameEvidenceRequestV1Schema.parse({
        kind: "capture-frame-evidence",
        requestId,
        revision,
        samples,
        schema: "poietra.canvas-worker-request",
        version: POIETRA_CANVAS_WORKER_VERSION,
      });
      const response = (await dispatch(request, "frame-evidence")) as CanvasFrameEvidenceResponseV1;
      if (response.kind !== "frame-evidence") {
        throw new CanvasWorkerClientError("protocol-violation", "The canvas worker did not return frame evidence.");
      }
      // The worker reports the revision retained with the captured frame; the
      // client refuses evidence relabeled for a revision it was not drawn for.
      if (response.revision !== revision) {
        throw new CanvasWorkerClientError(
          "protocol-violation",
          "The frame evidence is for a different Scene revision.",
        );
      }
      return response;
    },
    createWorker: () => new Worker(new URL("./poietra-canvas.dev.worker.ts", import.meta.url), { type: "module" }),
    parseResponse: (value) =>
      canvasWorkerResponseWithEvidenceV1Schema.safeParse(value) as ReturnType<
        typeof canvasWorkerResponseV1Schema.safeParse
      >,
  };
}
