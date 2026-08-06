import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { deriveOpeningManimTerminalPositionSourceEditPlanV2 } from "../src/render-pipeline/source-lowering";
import type { FastManimRuntimeTraceProducerRequestV2 } from "./fast-manim-runtime-trace-v2-contract";
import { fastManimRuntimeTraceProducerRequestV2Schema } from "./fast-manim-runtime-trace-v2-contract";
import {
  canonicalFastManimRuntimeTraceCoordinateV2,
  type FastManimRuntimeTraceV2,
  type SelfSealedFastManimRuntimeTraceV2,
  type TrustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-result-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";

export const FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2 = 840 as const;

export type FastManimRuntimeTraceCandidateErrorCodeV2 =
  | "base-mismatch"
  | "candidate-correlation"
  | "candidate-noop"
  | "candidate-prefix"
  | "candidate-producer"
  | "candidate-resource"
  | "candidate-root"
  | "candidate-semantic"
  | "candidate-source";

export class FastManimRuntimeTraceCandidateErrorV2 extends Error {
  readonly code: FastManimRuntimeTraceCandidateErrorCodeV2;

  constructor(code: FastManimRuntimeTraceCandidateErrorCodeV2, message: string) {
    super(message);
    this.name = "FastManimRuntimeTraceCandidateErrorV2";
    this.code = code;
  }
}

function reject(code: FastManimRuntimeTraceCandidateErrorCodeV2, message: string): never {
  throw new FastManimRuntimeTraceCandidateErrorV2(code, message);
}

function same(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function producerIdentity(producer: FastManimRuntimeTraceV2["producer"]) {
  const { semanticsSha256: _semanticsSha256, ...identity } = producer;
  return identity;
}

function traceCorrelation(trace: FastManimRuntimeTraceV2) {
  return {
    projectId: trace.projectId,
    requestId: trace.requestId,
    runtimeConfigHash: trace.runtimeConfigHash,
    sceneId: trace.sceneId,
    sceneName: trace.sceneName,
    sceneOccurrence: trace.sceneOccurrence,
    sourceHash: trace.sourceHash,
    sourcePath: trace.sourcePath,
  };
}

function requestCorrelation(request: FastManimRuntimeTraceProducerRequestV2) {
  return {
    projectId: request.projectId,
    requestId: request.requestId,
    runtimeConfigHash: request.runtimeConfigHash,
    sceneId: request.sceneId,
    sceneName: request.sceneName,
    sceneOccurrence: request.sceneOccurrence,
    sourceHash: request.sourceHash,
    sourcePath: request.sourcePath,
  };
}

function assertCandidateRoots(base: FastManimRuntimeTraceV2, candidate: FastManimRuntimeTraceV2) {
  if (candidate.roots.length !== base.roots.length) {
    reject("candidate-root", "An OpeningManim candidate changed the number of source roots.");
  }
  candidate.roots.forEach((root, index) => {
    const baseRoot = base.roots[index];
    if (!baseRoot) reject("candidate-root", "An OpeningManim candidate introduced an unknown source root.");
    const expectedBindingId = fastManimSourceBindingIdentifierV1(candidate.sourceHash, candidate.sceneId, root.binding);
    const { id: _candidateBindingId, ...candidateBinding } = root.binding;
    const { id: _baseBindingId, ...baseBinding } = baseRoot.binding;
    if (
      root.binding.id !== expectedBindingId ||
      !same({ ...root, binding: candidateBinding }, { ...baseRoot, binding: baseBinding })
    ) {
      reject("candidate-root", "An OpeningManim candidate changed its source-root identity.");
    }
  });
}

function sourceTranslation(request: FastManimRuntimeTraceProducerRequestV2) {
  let plan: ReturnType<typeof deriveOpeningManimTerminalPositionSourceEditPlanV2>;
  try {
    plan = deriveOpeningManimTerminalPositionSourceEditPlanV2(request.sourceText, request.sceneName);
  } catch {
    reject("candidate-source", "The OpeningManim candidate has no independently derivable position edit plan.");
  }
  if (
    plan.sourceTime !== 14 ||
    plan.binding.name !== "grid_title" ||
    plan.binding.sourceLine !== 38 ||
    plan.translation === null
  ) {
    reject("candidate-source", "The OpeningManim candidate is outside the reviewed grid_title shift at t=14.");
  }
  const x = canonicalFastManimRuntimeTraceCoordinateV2(plan.translation.x);
  const y = canonicalFastManimRuntimeTraceCoordinateV2(plan.translation.y);
  if (x === 0 && y === 0) reject("candidate-noop", "An OpeningManim candidate shift must change position.");
  return { x, y } as const;
}

function fixedDrawSemantics(draw: FastManimRuntimeTraceV2["frames"][number]["draws"][number]) {
  const { translation: _translation, ...fixed } = draw;
  return fixed;
}

/**
 * Proves the narrow #496 temporal claim after both documents cross the V2
 * wire schema. SourceAnalysis independently proves that the only source edit
 * is one direct `grid_title.shift(...)` immediately before the final wait.
 */
export function verifyFastManimRuntimeTraceOpeningPositionCandidateV2(input: {
  base: SelfSealedFastManimRuntimeTraceV2;
  candidate: SelfSealedFastManimRuntimeTraceV2;
  candidateRequest: FastManimRuntimeTraceProducerRequestV2;
  trusted: TrustedFastManimRuntimeTraceProducerV2;
}) {
  const base = input.base;
  const candidate = input.candidate;
  const request = fastManimRuntimeTraceProducerRequestV2Schema.parse(input.candidateRequest);

  if (!same(base.producer, input.trusted.producer) || !same(base.roots, input.trusted.roots)) {
    reject("base-mismatch", "The OpeningManim candidate base is not the independently trusted official trace.");
  }
  if (
    !same(traceCorrelation(candidate), requestCorrelation(request)) ||
    !same(candidate.camera, request.runtimeConfig.camera)
  ) {
    reject("candidate-correlation", "An OpeningManim candidate is stale for its exact source request.");
  }
  if (!same(producerIdentity(candidate.producer), producerIdentity(base.producer))) {
    reject("candidate-producer", "An OpeningManim candidate was produced by a different toolchain.");
  }
  if (candidate.sourceHash === base.sourceHash) {
    reject("candidate-correlation", "An OpeningManim candidate must identify distinct edited source bytes.");
  }

  const translation = sourceTranslation(request);
  assertCandidateRoots(base, candidate);
  if (!same(candidate.resources, base.resources)) {
    reject("candidate-resource", "An OpeningManim position candidate changed visual resources.");
  }

  for (let frameIndex = 0; frameIndex < FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2; frameIndex += 1) {
    if (!same(candidate.frames[frameIndex], base.frames[frameIndex])) {
      reject("candidate-prefix", `An OpeningManim candidate changed protected frame ${frameIndex}.`);
    }
  }

  let changedGridTitleDraws = 0;
  for (
    let frameIndex = FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2;
    frameIndex < candidate.frames.length;
    frameIndex += 1
  ) {
    const baseFrame = base.frames[frameIndex];
    const candidateFrame = candidate.frames[frameIndex];
    if (!baseFrame || !candidateFrame || baseFrame.draws.length !== candidateFrame.draws.length) {
      reject("candidate-semantic", `OpeningManim candidate frame ${frameIndex} changed its draw layout.`);
    }
    for (let drawIndex = 0; drawIndex < candidateFrame.draws.length; drawIndex += 1) {
      const baseDraw = baseFrame.draws[drawIndex];
      const candidateDraw = candidateFrame.draws[drawIndex];
      if (!baseDraw || !candidateDraw) {
        reject("candidate-semantic", `OpeningManim candidate frame ${frameIndex} changed draw ${drawIndex}.`);
      }
      if (baseDraw.rootId !== `${base.sceneId}/runtime-root:grid-title`) {
        if (!same(candidateDraw, baseDraw)) {
          reject(
            "candidate-semantic",
            `OpeningManim candidate changed non-grid_title draw ${drawIndex} in frame ${frameIndex}.`,
          );
        }
        continue;
      }
      const expectedTranslation = {
        x: canonicalFastManimRuntimeTraceCoordinateV2(baseDraw.translation.x + translation.x),
        y: canonicalFastManimRuntimeTraceCoordinateV2(baseDraw.translation.y + translation.y),
      };
      if (
        !same(fixedDrawSemantics(candidateDraw), fixedDrawSemantics(baseDraw)) ||
        !same(candidateDraw.translation, expectedTranslation)
      ) {
        reject(
          "candidate-semantic",
          `OpeningManim candidate grid_title draw ${drawIndex} in frame ${frameIndex} is not the source-derived translation.`,
        );
      }
      if (!same(candidateDraw.translation, baseDraw.translation)) changedGridTitleDraws += 1;
    }
  }
  if (changedGridTitleDraws === 0) {
    reject("candidate-noop", "An OpeningManim candidate did not change the editable final hold.");
  }
  return candidate;
}
