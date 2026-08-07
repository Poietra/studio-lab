import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  fastManimRuntimeTraceCoordinateV3Schema,
  fastManimRuntimeTraceSourceBindingV3Schema,
} from "../src/render-pipeline/runtime-trace-v3-shared-contract";
import { fastManimSourceBindingIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import {
  type FastManimRuntimeTraceProducerRequestV3,
  type FastManimRuntimeTraceSourceBindingV3,
  fastManimRuntimeTraceProducerRequestV3Schema,
} from "./fast-manim-runtime-trace-v3-contract";
import {
  type FastManimRuntimeTraceV3,
  fastManimRuntimeTraceV3Schema,
} from "./fast-manim-runtime-trace-v3-result-contract";

export type FastManimRuntimeTraceInitialMoveCandidateErrorCodeV3 =
  | "base-binding"
  | "candidate-binding"
  | "candidate-correlation"
  | "candidate-endpoint"
  | "candidate-noop"
  | "candidate-producer"
  | "candidate-resource"
  | "candidate-root"
  | "candidate-semantic";

export class FastManimRuntimeTraceInitialMoveCandidateErrorV3 extends Error {
  constructor(
    readonly code: FastManimRuntimeTraceInitialMoveCandidateErrorCodeV3,
    message: string,
  ) {
    super(message);
    this.name = "FastManimRuntimeTraceInitialMoveCandidateErrorV3";
  }
}

function reject(code: FastManimRuntimeTraceInitialMoveCandidateErrorCodeV3, message: string): never {
  throw new FastManimRuntimeTraceInitialMoveCandidateErrorV3(code, message);
}

function same(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function coordinateMatches(actual: number, expected: number) {
  // Source coordinates are serialized to twelve decimal places while V3
  // producer coordinates are canonicalized to thirteen. Admit only that
  // decimal boundary plus the binary64 addition noise from base + delta.
  const decimalRoundoff = 1e-12;
  const binaryRoundoff = Number.EPSILON * 16 * Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= Math.max(decimalRoundoff, binaryRoundoff);
}

function bindingWithoutId(binding: FastManimRuntimeTraceSourceBindingV3) {
  const { id: _id, ...structural } = binding;
  return structural;
}

function producerIdentity(producer: FastManimRuntimeTraceV3["producer"]) {
  const { correlationSha256: _correlationSha256, semanticsSha256: _semanticsSha256, ...identity } = producer;
  return identity;
}

function requestFixedCorrelation(request: FastManimRuntimeTraceProducerRequestV3) {
  return {
    projectId: request.projectId,
    requestId: request.requestId,
    runtimeConfig: request.runtimeConfig,
    runtimeConfigHash: request.runtimeConfigHash,
    sceneId: request.sceneId,
    sceneName: request.sceneName,
    sceneOccurrence: request.sceneOccurrence,
    schema: request.schema,
    sourcePath: request.sourcePath,
    version: request.version,
  };
}

function traceFixedCorrelation(trace: FastManimRuntimeTraceV3) {
  return {
    authority: trace.authority,
    camera: trace.camera,
    compositing: trace.compositing,
    coordinatePrecisionDigits: trace.coordinatePrecisionDigits,
    profileVersion: trace.profileVersion,
    projectId: trace.projectId,
    requestId: trace.requestId,
    runtimeConfigHash: trace.runtimeConfigHash,
    sampleSchedule: trace.sampleSchedule,
    sceneId: trace.sceneId,
    sceneName: trace.sceneName,
    sceneOccurrence: trace.sceneOccurrence,
    schema: trace.schema,
    sourcePath: trace.sourcePath,
    version: trace.version,
  };
}

function exactMappingForBinding(
  trace: FastManimRuntimeTraceV3,
  expected: FastManimRuntimeTraceSourceBindingV3,
  side: "base" | "candidate",
) {
  if (trace.sourceBindings.length !== 1) {
    reject(`${side}-binding`, `A generic Runtime Trace ${side} must map exactly one source binding.`);
  }
  const mapping = trace.sourceBindings[0]!;
  const expectedId = fastManimSourceBindingIdentifierV1(trace.sourceHash, trace.sceneId, mapping.binding);
  if (
    mapping.binding.id !== expectedId ||
    (side === "base" && mapping.binding.id !== expected.id) ||
    !same(bindingWithoutId(mapping.binding), bindingWithoutId(expected)) ||
    mapping.updaterStatus !== "none"
  ) {
    reject(`${side}-binding`, `A generic Runtime Trace ${side} changed its exact source binding authority.`);
  }
  return mapping;
}

function exactRequestedBinding(
  request: FastManimRuntimeTraceProducerRequestV3,
  expected: FastManimRuntimeTraceSourceBindingV3,
  side: "base" | "candidate",
) {
  const matching = request.sourceBindings.filter(({ name }) => name === expected.name);
  const binding = matching[0];
  if (
    matching.length !== 1 ||
    !binding ||
    binding.id !== fastManimSourceBindingIdentifierV1(request.sourceHash, request.sceneId, binding) ||
    (side === "base" && binding.id !== expected.id) ||
    !same(bindingWithoutId(binding), bindingWithoutId(expected))
  ) {
    reject(`${side}-binding`, `The generic Runtime Trace ${side} request lost its exact SourceAnalysis binding.`);
  }
  return binding;
}

function fixedState(state: FastManimRuntimeTraceV3["frames"][number]["states"][number]) {
  return {
    appearanceId: state.appearanceId,
    drawId: state.drawId,
    opacity: state.opacity,
    paintOrder: state.paintOrder,
    pathId: state.pathId,
    pathTrim: state.pathTrim,
    sourceZIndex: state.sourceZIndex,
    transform: {
      a: state.transform.a,
      b: state.transform.b,
      c: state.transform.c,
      d: state.transform.d,
    },
  };
}

/**
 * Proves one generic initial move after both documents have independently
 * crossed the closed V3 producer contract. The source lowerer owns the exact
 * `move_to` rewrite; this verifier owns the runtime claim that the one
 * source-bound root and every presented draw are only translated.
 */
export function verifyFastManimRuntimeTraceInitialMoveCandidateV3(
  input: Readonly<{
    base: FastManimRuntimeTraceV3;
    baseRequest: FastManimRuntimeTraceProducerRequestV3;
    binding: FastManimRuntimeTraceSourceBindingV3;
    candidate: FastManimRuntimeTraceV3;
    candidateRequest: FastManimRuntimeTraceProducerRequestV3;
    expectedInitialCenter: Readonly<{ x: number; y: number }>;
  }>,
) {
  const base = fastManimRuntimeTraceV3Schema.parse(input.base);
  const candidate = fastManimRuntimeTraceV3Schema.parse(input.candidate);
  const baseRequest = fastManimRuntimeTraceProducerRequestV3Schema.parse(input.baseRequest);
  const candidateRequest = fastManimRuntimeTraceProducerRequestV3Schema.parse(input.candidateRequest);
  const binding = fastManimRuntimeTraceSourceBindingV3Schema.parse(input.binding);
  const expectedInitialCenter = {
    x: fastManimRuntimeTraceCoordinateV3Schema.parse(input.expectedInitialCenter.x),
    y: fastManimRuntimeTraceCoordinateV3Schema.parse(input.expectedInitialCenter.y),
  };

  if (
    !same(requestFixedCorrelation(baseRequest), requestFixedCorrelation(candidateRequest)) ||
    baseRequest.sourceHash === candidateRequest.sourceHash ||
    base.sourceHash !== baseRequest.sourceHash ||
    candidate.sourceHash !== candidateRequest.sourceHash ||
    !same(traceFixedCorrelation(base), traceFixedCorrelation(candidate)) ||
    !same(traceFixedCorrelation(base), {
      authority: base.authority,
      camera: baseRequest.runtimeConfig.camera,
      compositing: baseRequest.runtimeConfig.compositing,
      coordinatePrecisionDigits: baseRequest.runtimeConfig.coordinatePrecisionDigits,
      profileVersion: baseRequest.profileVersion,
      projectId: baseRequest.projectId,
      requestId: baseRequest.requestId,
      runtimeConfigHash: baseRequest.runtimeConfigHash,
      sampleSchedule: base.sampleSchedule,
      sceneId: baseRequest.sceneId,
      sceneName: baseRequest.sceneName,
      sceneOccurrence: baseRequest.sceneOccurrence,
      schema: base.schema,
      sourcePath: baseRequest.sourcePath,
      version: baseRequest.version,
    })
  ) {
    reject("candidate-correlation", "A generic initial-move pair is not correlated to one exact Scene request.");
  }
  if (!same(producerIdentity(base.producer), producerIdentity(candidate.producer))) {
    reject("candidate-producer", "A generic initial-move pair was produced by different toolchains.");
  }

  exactRequestedBinding(baseRequest, binding, "base");
  exactRequestedBinding(candidateRequest, binding, "candidate");
  const baseMapping = exactMappingForBinding(base, binding, "base");
  const candidateMapping = exactMappingForBinding(candidate, binding, "candidate");

  if (
    base.roots.length !== 1 ||
    candidate.roots.length !== 1 ||
    !same(base.roots, candidate.roots) ||
    baseMapping.rootId !== base.roots[0]!.id ||
    candidateMapping.rootId !== baseMapping.rootId ||
    base.roots[0]!.lifetimes.length !== 1 ||
    base.roots[0]!.lifetimes[0]!.startFrame !== 0
  ) {
    reject("candidate-root", "A generic initial move requires one stable top-level root from frame zero.");
  }
  if (!same(base.draws, candidate.draws)) {
    reject("candidate-root", "A generic initial move changed its root draw identity or lifetime topology.");
  }
  if (!same(base.resources, candidate.resources)) {
    reject("candidate-resource", "A generic initial move changed visual resources.");
  }

  const baseInitial = baseMapping.endpoints.initial;
  const candidateInitial = candidateMapping.endpoints.initial;
  const delta = {
    x: candidateInitial.center.x - baseInitial.center.x,
    y: candidateInitial.center.y - baseInitial.center.y,
  };
  if (
    baseInitial.frameIndex !== 0 ||
    baseInitial.sampleTime !== 0 ||
    !Number.isFinite(delta.x) ||
    !Number.isFinite(delta.y) ||
    (coordinateMatches(delta.x, 0) && coordinateMatches(delta.y, 0))
  ) {
    reject("candidate-noop", "A generic initial move must produce one finite non-zero frame-zero translation.");
  }
  if (
    !coordinateMatches(candidateInitial.center.x, expectedInitialCenter.x) ||
    !coordinateMatches(candidateInitial.center.y, expectedInitialCenter.y)
  ) {
    reject("candidate-endpoint", "The candidate initial center does not match the server-derived move target.");
  }

  for (const endpointName of ["initial", "terminal"] as const) {
    const baseEndpoint = baseMapping.endpoints[endpointName];
    const candidateEndpoint = candidateMapping.endpoints[endpointName];
    if (
      baseEndpoint.frameIndex !== candidateEndpoint.frameIndex ||
      baseEndpoint.sampleTime !== candidateEndpoint.sampleTime ||
      !same(baseEndpoint.dimensions, candidateEndpoint.dimensions) ||
      baseEndpoint.dimensions.height <= 0 ||
      baseEndpoint.dimensions.width <= 0 ||
      !coordinateMatches(candidateEndpoint.center.x, baseEndpoint.center.x + delta.x) ||
      !coordinateMatches(candidateEndpoint.center.y, baseEndpoint.center.y + delta.y)
    ) {
      reject("candidate-endpoint", `The candidate ${endpointName} endpoint is not the exact translated base geometry.`);
    }
  }

  const drawById = new Map(base.draws.map((draw) => [draw.id, draw] as const));
  let changedStates = 0;
  if (base.frames.length !== candidate.frames.length) {
    reject("candidate-semantic", "A generic initial move changed its frame count.");
  }
  base.frames.forEach((baseFrame, frameIndex) => {
    const candidateFrame = candidate.frames[frameIndex];
    if (
      !candidateFrame ||
      baseFrame.frameIndex !== candidateFrame.frameIndex ||
      baseFrame.sampleTime !== candidateFrame.sampleTime ||
      baseFrame.states.length !== candidateFrame.states.length
    ) {
      reject("candidate-semantic", `A generic initial move changed frame ${frameIndex} structure.`);
    }
    baseFrame.states.forEach((baseState, stateIndex) => {
      const candidateState = candidateFrame.states[stateIndex];
      const draw = drawById.get(baseState.drawId);
      if (
        !candidateState ||
        !draw ||
        draw.rootId !== baseMapping.rootId ||
        !same(fixedState(baseState), fixedState(candidateState)) ||
        !coordinateMatches(candidateState.transform.tx, baseState.transform.tx + delta.x) ||
        !coordinateMatches(candidateState.transform.ty, baseState.transform.ty + delta.y)
      ) {
        reject(
          "candidate-semantic",
          `A generic initial move changed non-translation semantics in frame ${frameIndex}, state ${stateIndex}.`,
        );
      }
      if (
        !coordinateMatches(candidateState.transform.tx, baseState.transform.tx) ||
        !coordinateMatches(candidateState.transform.ty, baseState.transform.ty)
      ) {
        changedStates += 1;
      }
    });
  });
  if (changedStates === 0) reject("candidate-noop", "A generic initial move did not translate any presented state.");
  return candidate;
}
