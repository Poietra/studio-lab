import { type ProgramRenderRequest, renderRequestId } from "../src/render-pipeline/contracts";
import type {
  LoweredProgramBatchSource,
  RuntimeTraceInitialEditPreflight,
} from "../src/render-pipeline/source-lowering";
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
      preflight.kind === "fast-manim-updaters-terminal-v1" ||
      preflight.kind === "fast-manim-opening-terminal-v2" ||
      preflight.kind === "runtime-trace-initial-move" ||
      preflight.kind === "runtime-trace-initial-opacity" ||
      preflight.kind === "runtime-trace-initial-resize" ||
      preflight.kind === "runtime-trace-initial-rotation"
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
    const opening = preflight?.kind === "fast-manim-opening-terminal-v2";
    const initialMove = preflight?.kind === "runtime-trace-initial-move";
    const initialOpacity = preflight?.kind === "runtime-trace-initial-opacity";
    const initialResize = preflight?.kind === "runtime-trace-initial-resize";
    const initialRotation = preflight?.kind === "runtime-trace-initial-rotation";
    const reject = (failure: string): never => {
      this.#logger.warn(
        initialOpacity
          ? "render.runtime_trace_initial_opacity_preflight_rejected"
          : initialRotation
            ? "render.runtime_trace_initial_rotation_preflight_rejected"
            : initialResize
              ? "render.runtime_trace_initial_resize_preflight_rejected"
              : initialMove
                ? "render.runtime_trace_initial_move_preflight_rejected"
                : opening
                  ? "render.opening_terminal_runtime_trace_candidate_preflight_rejected"
                  : "render.updaters_terminal_runtime_trace_candidate_preflight_rejected",
        {
          failure,
          sourcePath: request.sourcePath,
        },
      );
      throw new HttpError(
        initialOpacity
          ? "The edited Manim source could not be verified against its exact initial Runtime Trace opacity. Reimport and try again."
          : initialRotation
            ? "The edited Manim source could not be verified against its exact initial Runtime Trace rotation. Reimport and try again."
            : initialResize
              ? "The edited Manim source could not be verified against its exact initial Runtime Trace resize. Reimport and try again."
              : initialMove
                ? "The edited Manim source could not be verified against its exact initial Runtime Trace move. Reimport and try again."
                : opening
                  ? "The edited OpeningManim source could not be verified against its exact terminal execution. Reimport and try again."
                  : "The edited UpdatersExample source could not be verified against its exact updater execution. Reimport and try again.",
        409,
      );
    };
    const candidatePreflight = preflight ?? reject("runtime-trace-authority-unavailable");
    const initialEditPreflight: RuntimeTraceInitialEditPreflight | null =
      candidatePreflight.kind === "runtime-trace-initial-move" ||
      candidatePreflight.kind === "runtime-trace-initial-opacity" ||
      candidatePreflight.kind === "runtime-trace-initial-resize" ||
      candidatePreflight.kind === "runtime-trace-initial-rotation"
        ? (candidatePreflight as RuntimeTraceInitialEditPreflight)
        : null;
    if (
      (candidatePreflight.kind !== "fast-manim-updaters-terminal-v1" &&
        candidatePreflight.kind !== "fast-manim-opening-terminal-v2" &&
        candidatePreflight.kind !== "runtime-trace-initial-move" &&
        candidatePreflight.kind !== "runtime-trace-initial-opacity" &&
        candidatePreflight.kind !== "runtime-trace-initial-resize" &&
        candidatePreflight.kind !== "runtime-trace-initial-rotation") ||
      request.sourceHash !== candidatePreflight.baseSourceHash
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const preflightRequestBindings = initialEditPreflight
      ? request.sourceBindings.filter(({ entityId }) => entityId === initialEditPreflight.entityId)
      : [];
    if (
      initialEditPreflight !== null &&
      (preflightRequestBindings.length !== 1 ||
        preflightRequestBindings[0]?.sourceVariable !== initialEditPreflight.baseBinding.name ||
        // The gesture entity must BE the canonical Studio identity of the
        // selected binding; a request row aliasing another entity id could
        // otherwise cross-wire an authorized gesture into a different binding.
        initialEditPreflight.entityId !==
          `source:${request.sourcePath}#${request.sceneName}:${initialEditPreflight.baseBinding.name}` ||
        (initialEditPreflight.kind === "runtime-trace-initial-move"
          ? !Number.isFinite(initialEditPreflight.expectedWorldCenter.x) ||
            !Number.isFinite(initialEditPreflight.expectedWorldCenter.y)
          : initialEditPreflight.kind === "runtime-trace-initial-opacity"
            ? !Number.isFinite(initialEditPreflight.expectedOpacity) ||
              initialEditPreflight.expectedOpacity < 0 ||
              initialEditPreflight.expectedOpacity > 1
            : initialEditPreflight.kind === "runtime-trace-initial-resize"
              ? !Number.isFinite(initialEditPreflight.expectedScaleFactor) ||
                initialEditPreflight.expectedScaleFactor <= 0 ||
                initialEditPreflight.expectedScaleFactor === 1
              : !Number.isFinite(initialEditPreflight.expectedAngleRadians) ||
                initialEditPreflight.expectedAngleRadians === 0))
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const runtimeTraceRunner = this.#runtimeTraceRunner ?? reject("runtime-trace-authority-unavailable");
    const candidateHash = sourceHash(lowered.source);
    const runtimeTraceRequest: FastManimRuntimeTraceCandidateRunRequestV1 = initialEditPreflight
      ? {
          ...(initialEditPreflight.kind === "runtime-trace-initial-move"
            ? { initialMove: initialEditPreflight }
            : initialEditPreflight.kind === "runtime-trace-initial-opacity"
              ? { initialOpacity: initialEditPreflight }
              : initialEditPreflight.kind === "runtime-trace-initial-resize"
                ? { initialResize: initialEditPreflight }
                : { initialRotation: initialEditPreflight }),
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
