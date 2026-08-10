import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import { type ProgramRenderRequest, renderRequestId } from "../src/render-pipeline/contracts";
import type {
  GenericRuntimeTraceInitialEditPreflightV3,
  LoweredProgramBatchSource,
} from "../src/render-pipeline/source-lowering";
import {
  digestFastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotProfileVersionV1,
  type FastManimSnapshotRunRequestV1,
} from "./fast-manim-snapshot-contract";
import { fastManimSnapshotRuntimeConfigForProfileV1 } from "./fast-manim-snapshot-profile-selection";
import type {
  FastManimRuntimeTraceCandidateRunRequestV1,
  FastManimUnpublishedSnapshotRunViewV1,
} from "./fast-manim-snapshot-runner";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { sourceHash } from "./manim-source-store";
import { importSourceSnapshot, sceneView } from "./manim-workspace";

export interface ManimRenderCandidateSnapshotRunnerV1 {
  runCandidateUnpublished(
    sourceText: string,
    request: Omit<FastManimSnapshotRunRequestV1, "sourceHash">,
    signal?: AbortSignal,
  ): Promise<FastManimUnpublishedSnapshotRunViewV1>;
}

export interface ManimRenderCandidateRuntimeTraceRunnerV1 {
  runRuntimeTraceCandidateUnpublished(
    sourceText: string,
    request: FastManimRuntimeTraceCandidateRunRequestV1,
    signal?: AbortSignal,
  ): Promise<Readonly<{ sourceHash: string; status: "verified"; traceDigest: string }>>;
}

type CandidateBindingProfileV1 = Readonly<{
  columnEnd: number;
  familyPath: readonly number[];
  line: number;
  name: string;
  ordinal: number;
  parentSceneOrder: number | null;
  sceneOrder: number;
}>;

type CandidateProfileV1 = Readonly<{
  bindings: readonly CandidateBindingProfileV1[];
  entityCount: number;
  kind: string;
  label: string;
  logEvent: string;
  snapshotVersion: FastManimSnapshotProfileVersionV1;
  sourceNames: readonly string[];
}>;

const CANDIDATE_PROFILES_V1 = new Map<string, CandidateProfileV1>([
  [
    "fast-manim-square-to-circle-v8",
    {
      bindings: [
        {
          columnEnd: 14,
          familyPath: [],
          line: 75,
          name: "square",
          ordinal: 2,
          parentSceneOrder: null,
          sceneOrder: 0,
        },
      ],
      entityCount: 1,
      kind: "fast-manim-square-to-circle-v8",
      label: "SquareToCircle",
      logEvent: "render.square_to_circle_v8_candidate_preflight_rejected",
      snapshotVersion: 8,
      // `circle` is a source dependency and must receive the same initial
      // position, but only the transformed `square` survives as runtime
      // identity. Keep those two authorities explicit instead of inventing a
      // runtime entity for the hidden Transform target.
      sourceNames: ["circle", "square"],
    },
  ],
  [
    "fast-manim-warp-square-v9",
    {
      bindings: [
        {
          columnEnd: 14,
          familyPath: [],
          line: 87,
          name: "square",
          ordinal: 1,
          parentSceneOrder: null,
          sceneOrder: 0,
        },
      ],
      entityCount: 1,
      kind: "fast-manim-warp-square-v9",
      label: "WarpSquare",
      logEvent: "render.warp_square_v9_candidate_preflight_rejected",
      snapshotVersion: 9,
      sourceNames: ["square"],
    },
  ],
  [
    "fast-manim-line-joints-v10",
    {
      bindings: [
        {
          columnEnd: 11,
          familyPath: [],
          line: 173,
          name: "grp",
          ordinal: 4,
          parentSceneOrder: null,
          sceneOrder: 0,
        },
        {
          columnEnd: 10,
          familyPath: [0],
          line: 169,
          name: "t1",
          ordinal: 1,
          parentSceneOrder: 0,
          sceneOrder: 1,
        },
        {
          columnEnd: 10,
          familyPath: [1],
          line: 170,
          name: "t2",
          ordinal: 2,
          parentSceneOrder: 0,
          sceneOrder: 2,
        },
        {
          columnEnd: 10,
          familyPath: [2],
          line: 171,
          name: "t3",
          ordinal: 3,
          parentSceneOrder: 0,
          sceneOrder: 3,
        },
      ],
      entityCount: 4,
      kind: "fast-manim-line-joints-v10",
      label: "LineJoints",
      logEvent: "render.line_joints_v10_candidate_preflight_rejected",
      snapshotVersion: 10,
      sourceNames: ["t1", "t2", "t3", "grp"],
    },
  ],
  [
    "fast-manim-write-stuff-v12",
    {
      bindings: [
        {
          columnEnd: 13,
          familyPath: [],
          line: 103,
          name: "group",
          ordinal: 3,
          parentSceneOrder: null,
          sceneOrder: 0,
        },
        {
          columnEnd: 20,
          familyPath: [0],
          line: 99,
          name: "example_text",
          ordinal: 1,
          parentSceneOrder: 0,
          sceneOrder: 1,
        },
        {
          columnEnd: 19,
          familyPath: [1],
          line: 100,
          name: "example_tex",
          ordinal: 2,
          parentSceneOrder: 0,
          sceneOrder: 32,
        },
      ],
      entityCount: 61,
      kind: "fast-manim-write-stuff-v12",
      label: "WriteStuff",
      logEvent: "render.write_stuff_v12_candidate_preflight_rejected",
      snapshotVersion: 12,
      sourceNames: ["example_text", "example_tex", "group"],
    },
  ],
]);

export type ManimRenderCandidateVerifierOptionsV1 = Readonly<{
  frame: Readonly<{ height: number; width: number }>;
  logger?: StructuredLogger;
  runner: ManimRenderCandidateSnapshotRunnerV1;
  runtimeTraceRunner?: ManimRenderCandidateRuntimeTraceRunnerV1;
}>;

/**
 * Verifies bounded edited source bytes against the exact server-owned runtime
 * identity before either the local or durable render path creates state.
 */
export class ManimRenderCandidateVerifierV1 {
  readonly #frame: Readonly<{ height: number; width: number }>;
  readonly #logger: StructuredLogger;
  readonly #runner: ManimRenderCandidateSnapshotRunnerV1;
  readonly #runtimeTraceRunner: ManimRenderCandidateRuntimeTraceRunnerV1 | undefined;

  constructor(options: ManimRenderCandidateVerifierOptionsV1) {
    this.#frame = options.frame;
    this.#logger = options.logger ?? nullLogger;
    this.#runner = options.runner;
    this.#runtimeTraceRunner = options.runtimeTraceRunner;
  }

  async verify(lowered: LoweredProgramBatchSource, request: ProgramRenderRequest, signal?: AbortSignal): Promise<void> {
    const preflight = lowered.preflight;
    if (!preflight) return;
    signal?.throwIfAborted();
    if (
      preflight.kind === "fast-manim-updaters-terminal-v1" ||
      preflight.kind === "fast-manim-opening-terminal-v2" ||
      preflight.kind === "fast-manim-generic-initial-move-v3" ||
      preflight.kind === "fast-manim-generic-initial-resize-v3"
    ) {
      await this.#verifyRuntimeTraceCandidate(lowered, request, signal);
      return;
    }
    const profile = CANDIDATE_PROFILES_V1.get((preflight as Readonly<{ kind: string }>).kind);
    if (!profile) {
      throw new HttpError("The edited Manim source uses an unsupported candidate verification profile.", 409);
    }
    const reject = (): never => {
      throw new HttpError(
        `The edited ${profile.label} source could not be verified against its exact runtime identity. Reimport and try again.`,
        409,
      );
    };
    if (request.sourceHash !== preflight.baseSourceHash) reject();

    const candidateHash = sourceHash(lowered.source);
    let candidateScene: ReturnType<typeof sceneView>;
    try {
      candidateScene = sceneView(
        importSourceSnapshot(lowered.source, request.sourcePath, this.#frame).view,
        request.sceneName,
      );
    } catch {
      return reject();
    }
    const sourceVariables = candidateScene ? new Map(Object.entries(candidateScene.sourceVariables)) : new Map();
    const bindingsByName = new Map(
      request.sourceBindings.map(({ entityId, sourceVariable }) => [sourceVariable, entityId]),
    );
    const expectedSourceNames = profile.sourceNames;
    if (
      !candidateScene ||
      candidateScene.sourceHash !== candidateHash ||
      request.sourceBindings.length !== expectedSourceNames.length ||
      bindingsByName.size !== expectedSourceNames.length ||
      sourceVariables.size !== expectedSourceNames.length ||
      new Set(request.sourceBindings.map(({ entityId }) => entityId)).size !== expectedSourceNames.length ||
      expectedSourceNames.some((name) => {
        const entityId = bindingsByName.get(name);
        return entityId === undefined || sourceVariables.get(entityId) !== name;
      })
    ) {
      reject();
    }

    const result: FastManimUnpublishedSnapshotRunViewV1 = await (async () => {
      try {
        return await this.#runner.runCandidateUnpublished(
          lowered.source,
          {
            projectId: request.projectId,
            requestId: renderRequestId(request),
            sceneName: request.sceneName,
            sourcePath: request.sourcePath,
          },
          signal,
        );
      } catch {
        signal?.throwIfAborted();
        this.#logger.warn(profile.logEvent, { failure: "snapshot-run-rejected", sourcePath: request.sourcePath });
        return reject();
      }
    })();
    signal?.throwIfAborted();
    const verifiedResult = result.status === "verified" ? result : reject();
    const bundle = await parseVerifiedSceneIrBundleV1(verifiedResult.snapshot.bundle).catch(() => reject());
    const scene = bundle.scene;
    const identity = verifiedResult.sourceRuntimeIdentity ?? reject();
    const expectedRuntimeConfigHash = digestFastManimSnapshotRuntimeConfigV1(
      fastManimSnapshotRuntimeConfigForProfileV1(profile.snapshotVersion, this.#frame),
    );
    if (
      verifiedResult.projectId !== request.projectId ||
      verifiedResult.requestId !== renderRequestId(request) ||
      verifiedResult.sceneName !== request.sceneName ||
      verifiedResult.sourcePath !== request.sourcePath ||
      verifiedResult.snapshot.projectId !== request.projectId ||
      verifiedResult.snapshot.requestId !== renderRequestId(request) ||
      verifiedResult.snapshot.sceneId !== scene.sceneId ||
      verifiedResult.snapshot.sceneName !== request.sceneName ||
      verifiedResult.snapshot.sourcePath !== request.sourcePath ||
      verifiedResult.snapshot.sourceHash !== candidateHash ||
      verifiedResult.runtimeConfigHash !== expectedRuntimeConfigHash ||
      verifiedResult.snapshot.runtimeConfigHash !== verifiedResult.runtimeConfigHash ||
      scene.source.kind !== "imported-manim-server-snapshot" ||
      verifiedResult.snapshot.snapshotHash !== scene.source.snapshotHash ||
      scene.source.snapshotVersion !== profile.snapshotVersion ||
      scene.source.sourceHash !== candidateHash ||
      scene.source.runtimeConfigHash !== verifiedResult.runtimeConfigHash ||
      identity.sourceHash !== candidateHash ||
      identity.sceneId !== scene.sceneId ||
      identity.runtimeConfigHash !== verifiedResult.runtimeConfigHash ||
      identity.snapshotHash !== verifiedResult.snapshot.snapshotHash
    ) {
      reject();
    }

    const entitiesBySceneOrder = new Map(scene.entities.map((entity) => [entity.sceneOrder, entity]));
    const mappingsByName = new Map(identity.mappings.map((mapping) => [mapping.binding.name, mapping]));
    if (
      scene.entities.length !== profile.entityCount ||
      entitiesBySceneOrder.size !== profile.entityCount ||
      identity.mappings.length !== profile.bindings.length ||
      mappingsByName.size !== profile.bindings.length ||
      profile.bindings.some((expected) => {
        const entity = entitiesBySceneOrder.get(expected.sceneOrder);
        const parent =
          expected.parentSceneOrder === null ? null : entitiesBySceneOrder.get(expected.parentSceneOrder)?.id;
        const mapping = mappingsByName.get(expected.name);
        return (
          !entity ||
          entity.parentId !== parent ||
          !mapping ||
          mapping.entityId !== entity.id ||
          mapping.provenanceId !== entity.provenanceId ||
          mapping.familyPath.length !== expected.familyPath.length ||
          mapping.familyPath.some((value, index) => value !== expected.familyPath[index]) ||
          mapping.binding.ordinal !== expected.ordinal ||
          mapping.binding.span.startLine !== expected.line ||
          mapping.binding.span.endLine !== expected.line ||
          mapping.binding.span.startColumn !== 8 ||
          mapping.binding.span.endColumn !== expected.columnEnd
        );
      })
    ) {
      reject();
    }
  }

  async #verifyRuntimeTraceCandidate(
    lowered: LoweredProgramBatchSource,
    request: ProgramRenderRequest,
    signal?: AbortSignal,
  ) {
    const preflight = lowered.preflight;
    const opening = preflight?.kind === "fast-manim-opening-terminal-v2";
    const genericMove = preflight?.kind === "fast-manim-generic-initial-move-v3";
    const genericResize = preflight?.kind === "fast-manim-generic-initial-resize-v3";
    const reject = (failure: string): never => {
      this.#logger.warn(
        genericResize
          ? "render.generic_initial_resize_runtime_trace_candidate_preflight_rejected"
          : genericMove
            ? "render.generic_initial_move_runtime_trace_candidate_preflight_rejected"
            : opening
              ? "render.opening_terminal_runtime_trace_candidate_preflight_rejected"
              : "render.updaters_terminal_runtime_trace_candidate_preflight_rejected",
        {
          failure,
          sourcePath: request.sourcePath,
        },
      );
      throw new HttpError(
        genericResize
          ? "The edited generic Manim source could not be verified against its exact initial Runtime Trace resize. Reimport and try again."
          : genericMove
            ? "The edited generic Manim source could not be verified against its exact initial Runtime Trace move. Reimport and try again."
            : opening
              ? "The edited OpeningManim source could not be verified against its exact terminal execution. Reimport and try again."
              : "The edited UpdatersExample source could not be verified against its exact updater execution. Reimport and try again.",
        409,
      );
    };
    const candidatePreflight = preflight ?? reject("runtime-trace-authority-unavailable");
    const genericPreflight: GenericRuntimeTraceInitialEditPreflightV3 | null =
      candidatePreflight.kind === "fast-manim-generic-initial-move-v3" ||
      candidatePreflight.kind === "fast-manim-generic-initial-resize-v3"
        ? (candidatePreflight as GenericRuntimeTraceInitialEditPreflightV3)
        : null;
    if (
      (candidatePreflight.kind !== "fast-manim-updaters-terminal-v1" &&
        candidatePreflight.kind !== "fast-manim-opening-terminal-v2" &&
        candidatePreflight.kind !== "fast-manim-generic-initial-move-v3" &&
        candidatePreflight.kind !== "fast-manim-generic-initial-resize-v3") ||
      request.sourceHash !== candidatePreflight.baseSourceHash
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const preflightRequestBindings = genericPreflight
      ? request.sourceBindings.filter(({ entityId }) => entityId === genericPreflight.entityId)
      : [];
    if (
      genericPreflight !== null &&
      (preflightRequestBindings.length !== 1 ||
        preflightRequestBindings[0]?.sourceVariable !== genericPreflight.baseBinding.name ||
        // The gesture entity must BE the canonical Studio identity of the
        // selected binding; a request row aliasing another entity id could
        // otherwise cross-wire an authorized gesture into a different binding.
        genericPreflight.entityId !==
          `source:${request.sourcePath}#${request.sceneName}:${genericPreflight.baseBinding.name}` ||
        (genericPreflight.kind === "fast-manim-generic-initial-move-v3"
          ? !Number.isFinite(genericPreflight.expectedWorldCenter.x) ||
            !Number.isFinite(genericPreflight.expectedWorldCenter.y)
          : !Number.isFinite(genericPreflight.expectedScaleFactor) ||
            genericPreflight.expectedScaleFactor <= 0 ||
            genericPreflight.expectedScaleFactor === 1))
    ) {
      reject("runtime-trace-authority-unavailable");
    }
    const runtimeTraceRunner = this.#runtimeTraceRunner ?? reject("runtime-trace-authority-unavailable");
    const candidateHash = sourceHash(lowered.source);
    const runtimeTraceRequest: FastManimRuntimeTraceCandidateRunRequestV1 = genericPreflight
      ? {
          ...(genericPreflight.kind === "fast-manim-generic-initial-move-v3"
            ? { genericInitialMove: genericPreflight }
            : { genericInitialResize: genericPreflight }),
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
    let result: Awaited<ReturnType<ManimRenderCandidateRuntimeTraceRunnerV1["runRuntimeTraceCandidateUnpublished"]>>;
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
