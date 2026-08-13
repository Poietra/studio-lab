import { type ProgramRenderRequest, renderRequestId } from "../src/render-pipeline/contracts";
import type { LoweredProgramBatchSource, RuntimeTraceEditPreflight } from "../src/render-pipeline/source-lowering";
import type { FastManimRuntimeTraceCandidateRunRequestV1 } from "./fast-manim-snapshot-runner";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { sourceHash } from "./manim-source-store";

export interface ManimRuntimeTraceEditRunner {
  runRuntimeTraceCandidateUnpublished(
    sourceText: string,
    request: FastManimRuntimeTraceCandidateRunRequestV1,
    signal?: AbortSignal,
  ): Promise<Readonly<{ sourceHash: string; status: "verified"; traceDigest: string }>>;
}

export type ManimRuntimeTraceEditVerifierOptions = Readonly<{
  logger?: StructuredLogger;
  runtimeTraceRunner?: ManimRuntimeTraceEditRunner;
}>;

/**
 * Verifies bounded edited source bytes against the exact server-owned runtime
 * identity before either the local or durable render path creates state.
 */
export class ManimRuntimeTraceEditVerifier {
  readonly #logger: StructuredLogger;
  readonly #runtimeTraceRunner: ManimRuntimeTraceEditRunner | undefined;

  constructor(options: ManimRuntimeTraceEditVerifierOptions) {
    this.#logger = options.logger ?? nullLogger;
    this.#runtimeTraceRunner = options.runtimeTraceRunner;
  }

  async verify(lowered: LoweredProgramBatchSource, request: ProgramRenderRequest, signal?: AbortSignal): Promise<void> {
    const preflight = lowered.preflight;
    if (!preflight) return;
    signal?.throwIfAborted();
    if (
      preflight.kind === "runtime-trace-move-edit" ||
      preflight.kind === "runtime-trace-opacity-edit" ||
      preflight.kind === "runtime-trace-resize-edit" ||
      preflight.kind === "runtime-trace-rotation-edit"
    ) {
      await this.#verifyRuntimeTraceCandidate(lowered, request, signal);
      return;
    }
    throw new HttpError("The edited Manim source uses an unsupported Runtime Trace edit.", 409);
  }

  async #verifyRuntimeTraceCandidate(
    lowered: LoweredProgramBatchSource,
    request: ProgramRenderRequest,
    signal?: AbortSignal,
  ) {
    const preflight = lowered.preflight;
    const moveEdit = preflight?.kind === "runtime-trace-move-edit";
    const opacityEdit = preflight?.kind === "runtime-trace-opacity-edit";
    const resizeEdit = preflight?.kind === "runtime-trace-resize-edit";
    const rotationEdit = preflight?.kind === "runtime-trace-rotation-edit";
    const reject = (failure: string): never => {
      this.#logger.warn(
        opacityEdit
          ? "render.runtime_trace_opacity_edit_preflight_rejected"
          : rotationEdit
            ? "render.runtime_trace_rotation_edit_preflight_rejected"
            : resizeEdit
              ? "render.runtime_trace_resize_edit_preflight_rejected"
              : moveEdit
                ? "render.runtime_trace_move_edit_preflight_rejected"
                : "render.runtime_trace_candidate_preflight_rejected",
        {
          failure,
          sourcePath: request.sourcePath,
        },
      );
      throw new HttpError(
        opacityEdit
          ? "The edited Manim source could not be verified against its exact Runtime Trace opacity edit. Reimport and try again."
          : rotationEdit
            ? "The edited Manim source could not be verified against its exact Runtime Trace rotation edit. Reimport and try again."
            : resizeEdit
              ? "The edited Manim source could not be verified against its exact Runtime Trace resize edit. Reimport and try again."
              : moveEdit
                ? "The edited Manim source could not be verified against its exact Runtime Trace move edit. Reimport and try again."
                : "The edited Manim source could not be verified against its exact Runtime Trace execution. Reimport and try again.",
        409,
      );
    };
    const candidatePreflight = preflight ?? reject("runtime-trace-authority-unavailable");
    const editPreflight: RuntimeTraceEditPreflight | null =
      candidatePreflight.kind === "runtime-trace-move-edit" ||
      candidatePreflight.kind === "runtime-trace-opacity-edit" ||
      candidatePreflight.kind === "runtime-trace-resize-edit" ||
      candidatePreflight.kind === "runtime-trace-rotation-edit"
        ? (candidatePreflight as RuntimeTraceEditPreflight)
        : null;
    if (
      (candidatePreflight.kind !== "runtime-trace-move-edit" &&
        candidatePreflight.kind !== "runtime-trace-opacity-edit" &&
        candidatePreflight.kind !== "runtime-trace-resize-edit" &&
        candidatePreflight.kind !== "runtime-trace-rotation-edit") ||
      request.sourceHash !== candidatePreflight.baseSourceHash
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const preflightRequestBindings = editPreflight
      ? request.sourceBindings.filter(({ entityId }) => entityId === editPreflight.entityId)
      : [];
    if (
      editPreflight !== null &&
      (preflightRequestBindings.length !== 1 ||
        preflightRequestBindings[0]?.sourceVariable !== editPreflight.baseBinding.name ||
        // The gesture entity must BE the canonical Studio identity of the
        // selected binding; a request row aliasing another entity id could
        // otherwise cross-wire an authorized gesture into a different binding.
        editPreflight.entityId !==
          `source:${request.sourcePath}#${request.sceneName}:${editPreflight.baseBinding.name}` ||
        !Number.isFinite(editPreflight.sourceAnchor) ||
        editPreflight.sourceAnchor < 0 ||
        (editPreflight.kind === "runtime-trace-move-edit"
          ? !Number.isFinite(editPreflight.expectedWorldCenter.x) ||
            !Number.isFinite(editPreflight.expectedWorldCenter.y)
          : editPreflight.kind === "runtime-trace-opacity-edit"
            ? !Number.isFinite(editPreflight.expectedOpacity) ||
              editPreflight.expectedOpacity < 0 ||
              editPreflight.expectedOpacity > 1
            : editPreflight.kind === "runtime-trace-resize-edit"
              ? !Number.isFinite(editPreflight.expectedScaleFactor) ||
                editPreflight.expectedScaleFactor <= 0 ||
                editPreflight.expectedScaleFactor === 1
              : !Number.isFinite(editPreflight.expectedAngleRadians) ||
                editPreflight.expectedAngleRadians === 0 ||
                editPreflight.sourceAnchor !== 0) ||
        (editPreflight.kind === "runtime-trace-opacity-edit" && editPreflight.sourceAnchor !== 0))
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const runtimeTraceRunner = this.#runtimeTraceRunner ?? reject("runtime-trace-authority-unavailable");
    const candidateHash = sourceHash(lowered.source);
    const runtimeTraceRequest: FastManimRuntimeTraceCandidateRunRequestV1 = editPreflight
      ? {
          ...(editPreflight.kind === "runtime-trace-move-edit"
            ? { moveEdit: editPreflight }
            : editPreflight.kind === "runtime-trace-opacity-edit"
              ? { opacityEdit: editPreflight }
              : editPreflight.kind === "runtime-trace-resize-edit"
                ? { resizeEdit: editPreflight }
                : { rotationEdit: editPreflight }),
          projectId: request.projectId,
          requestId: renderRequestId(request),
          sceneName: request.sceneName,
          sourcePath: request.sourcePath,
        }
      : {
          projectId: request.projectId,
          requestId: renderRequestId(request),
          sceneName: request.sceneName,
          sourcePath: request.sourcePath,
        };
    let result: Awaited<ReturnType<ManimRuntimeTraceEditRunner["runRuntimeTraceCandidateUnpublished"]>>;
    try {
      result = await runtimeTraceRunner.runRuntimeTraceCandidateUnpublished(
        lowered.source,
        runtimeTraceRequest,
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      return reject("runtime-trace-run-rejected");
    }
    signal?.throwIfAborted();
    if (
      result.status !== "verified" ||
      result.sourceHash !== candidateHash ||
      !/^[0-9a-f]{64}$/u.test(result.traceDigest)
    ) {
      reject("runtime-trace-correlation-rejected");
    }
  }
}
