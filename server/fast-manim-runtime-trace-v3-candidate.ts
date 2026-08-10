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

export type FastManimRuntimeTraceInitialEditCandidateErrorCodeV3 =
  | "base-binding"
  | "candidate-binding"
  | "candidate-correlation"
  | "candidate-endpoint"
  | "candidate-noop"
  | "candidate-producer"
  | "candidate-resource"
  | "candidate-root"
  | "candidate-semantic";

export class FastManimRuntimeTraceInitialEditCandidateErrorV3 extends Error {
  constructor(
    readonly code: FastManimRuntimeTraceInitialEditCandidateErrorCodeV3,
    message: string,
  ) {
    super(message);
    this.name = "FastManimRuntimeTraceInitialEditCandidateErrorV3";
  }
}

function reject(code: FastManimRuntimeTraceInitialEditCandidateErrorCodeV3, message: string): never {
  throw new FastManimRuntimeTraceInitialEditCandidateErrorV3(code, message);
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

function scaledCoordinateMatches(actual: number, expected: number, factor: number) {
  // Multiplying a 13-decimal canonical coordinate by the factor amplifies its
  // quantization error, so the admitted decimal roundoff scales with it.
  const decimalRoundoff = 1e-12 * Math.max(1, Math.abs(factor));
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
  const matching = trace.sourceBindings.filter(({ binding }) => binding.name === expected.name);
  const mapping = matching[0];
  if (matching.length !== 1 || !mapping) {
    reject(`${side}-binding`, `A generic Runtime Trace ${side} must map the selected source binding exactly once.`);
  }
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

function siblingMappingSummary(mapping: FastManimRuntimeTraceV3["sourceBindings"][number]) {
  // Sibling spans legitimately shift when the edit statement is inserted, so
  // sibling identity compares everything except the source span and the
  // sourceHash-derived binding id.
  return {
    endpoints: mapping.endpoints,
    name: mapping.binding.name,
    ordinal: mapping.binding.ordinal,
    rootId: mapping.rootId,
    updaterStatus: mapping.updaterStatus,
  };
}

function verifySiblingMappingsUnchanged(
  base: FastManimRuntimeTraceV3,
  candidate: FastManimRuntimeTraceV3,
  selectedName: string,
) {
  const baseSiblings = base.sourceBindings.filter(({ binding }) => binding.name !== selectedName);
  const candidateSiblings = candidate.sourceBindings.filter(({ binding }) => binding.name !== selectedName);
  if (
    baseSiblings.length !== candidateSiblings.length ||
    baseSiblings.some(
      (sibling, index) =>
        !candidateSiblings[index] ||
        !same(siblingMappingSummary(sibling), siblingMappingSummary(candidateSiblings[index]!)),
    )
  ) {
    reject("candidate-binding", "A generic initial edit changed a sibling source binding it did not select.");
  }
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
 * Verifies the request/trace correlation, producer identity, exact binding,
 * and single stable root shared by every generic initial-edit candidate pair.
 */
function verifiedGenericInitialCandidatePairV3(
  input: Readonly<{
    base: FastManimRuntimeTraceV3;
    baseRequest: FastManimRuntimeTraceProducerRequestV3;
    binding: FastManimRuntimeTraceSourceBindingV3;
    candidate: FastManimRuntimeTraceV3;
    candidateRequest: FastManimRuntimeTraceProducerRequestV3;
  }>,
) {
  const base = fastManimRuntimeTraceV3Schema.parse(input.base);
  const candidate = fastManimRuntimeTraceV3Schema.parse(input.candidate);
  const baseRequest = fastManimRuntimeTraceProducerRequestV3Schema.parse(input.baseRequest);
  const candidateRequest = fastManimRuntimeTraceProducerRequestV3Schema.parse(input.candidateRequest);
  const binding = fastManimRuntimeTraceSourceBindingV3Schema.parse(input.binding);

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
    reject("candidate-correlation", "A generic initial-edit pair is not correlated to one exact Scene request.");
  }
  if (!same(producerIdentity(base.producer), producerIdentity(candidate.producer))) {
    reject("candidate-producer", "A generic initial-edit pair was produced by different toolchains.");
  }

  exactRequestedBinding(baseRequest, binding, "base");
  exactRequestedBinding(candidateRequest, binding, "candidate");
  const baseMapping = exactMappingForBinding(base, binding, "base");
  const candidateMapping = exactMappingForBinding(candidate, binding, "candidate");
  verifySiblingMappingsUnchanged(base, candidate, binding.name);

  const selectedRoot = base.roots.find(({ id }) => id === baseMapping.rootId);
  if (
    !same(base.roots, candidate.roots) ||
    !selectedRoot ||
    candidateMapping.rootId !== baseMapping.rootId ||
    selectedRoot.lifetimes.length !== 1 ||
    selectedRoot.lifetimes[0]!.startFrame !== 0
  ) {
    reject("candidate-root", "A generic initial edit requires one stable selected top-level root from frame zero.");
  }
  if (!same(base.draws, candidate.draws)) {
    reject("candidate-root", "A generic initial edit changed its root draw identity or lifetime topology.");
  }
  return { base, baseMapping, candidate, candidateMapping };
}

/**
 * Proves one generic initial move after both documents have independently
 * crossed the closed V3 producer contract. The source lowerer owns the exact
 * `move_to` rewrite; this verifier owns the runtime claim that the one
 * source-bound root and every presented draw are only translated. `move_to`
 * places the constructed object, which an entrance animation reveals over
 * time, so the settled (terminal) endpoint is the observable anchor that must
 * land exactly on the requested world center; a Scene whose settled endpoint
 * is not that constructed placement fails closed here.
 */
export function verifyFastManimRuntimeTraceInitialMoveCandidateV3(
  input: Readonly<{
    base: FastManimRuntimeTraceV3;
    baseRequest: FastManimRuntimeTraceProducerRequestV3;
    binding: FastManimRuntimeTraceSourceBindingV3;
    candidate: FastManimRuntimeTraceV3;
    candidateRequest: FastManimRuntimeTraceProducerRequestV3;
    expectedWorldCenter: Readonly<{ x: number; y: number }>;
  }>,
) {
  const expectedWorldCenter = {
    x: fastManimRuntimeTraceCoordinateV3Schema.parse(input.expectedWorldCenter.x),
    y: fastManimRuntimeTraceCoordinateV3Schema.parse(input.expectedWorldCenter.y),
  };
  const { base, baseMapping, candidate, candidateMapping } = verifiedGenericInitialCandidatePairV3(input);
  if (!same(base.resources, candidate.resources)) {
    reject("candidate-resource", "A generic initial move changed visual resources.");
  }

  const baseInitial = baseMapping.endpoints.initial;
  const baseTerminal = baseMapping.endpoints.terminal;
  const candidateTerminal = candidateMapping.endpoints.terminal;
  const delta = {
    x: candidateTerminal.center.x - baseTerminal.center.x,
    y: candidateTerminal.center.y - baseTerminal.center.y,
  };
  if (
    baseInitial.frameIndex !== 0 ||
    baseInitial.sampleTime !== 0 ||
    !Number.isFinite(delta.x) ||
    !Number.isFinite(delta.y) ||
    (coordinateMatches(delta.x, 0) && coordinateMatches(delta.y, 0))
  ) {
    reject("candidate-noop", "A generic initial move must produce one finite non-zero full-trace translation.");
  }
  if (
    !coordinateMatches(candidateTerminal.center.x, expectedWorldCenter.x) ||
    !coordinateMatches(candidateTerminal.center.y, expectedWorldCenter.y)
  ) {
    reject("candidate-endpoint", "The candidate settled center does not match the server-derived move target.");
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
      if (!candidateState || !draw) {
        reject(
          "candidate-semantic",
          `A generic initial move changed non-translation semantics in frame ${frameIndex}, state ${stateIndex}.`,
        );
      }
      if (draw.rootId !== baseMapping.rootId) {
        // Non-selected roots must replay byte-identically.
        if (!same(baseState, candidateState)) {
          reject(
            "candidate-semantic",
            `A generic initial move disturbed a non-selected root in frame ${frameIndex}, state ${stateIndex}.`,
          );
        }
        return;
      }
      if (
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

type FastManimRuntimeTracePathResourceV3 = FastManimRuntimeTraceV3["resources"]["paths"][number];

function scaledPathMatches(
  basePath: FastManimRuntimeTracePathResourceV3["path"],
  candidatePath: FastManimRuntimeTracePathResourceV3["path"],
  factor: number,
) {
  if (basePath.subpaths.length !== candidatePath.subpaths.length) return false;
  return basePath.subpaths.every((baseSubpath, subpathIndex) => {
    const candidateSubpath = candidatePath.subpaths[subpathIndex]!;
    if (
      baseSubpath.closed !== candidateSubpath.closed ||
      baseSubpath.segments.length !== candidateSubpath.segments.length ||
      !scaledCoordinateMatches(candidateSubpath.start.x, baseSubpath.start.x * factor, factor) ||
      !scaledCoordinateMatches(candidateSubpath.start.y, baseSubpath.start.y * factor, factor)
    ) {
      return false;
    }
    return baseSubpath.segments.every((baseSegment, segmentIndex) => {
      const candidateSegment = candidateSubpath.segments[segmentIndex]!;
      return (["control1", "control2", "end"] as const).every(
        (pointName) =>
          scaledCoordinateMatches(candidateSegment[pointName].x, baseSegment[pointName].x * factor, factor) &&
          scaledCoordinateMatches(candidateSegment[pointName].y, baseSegment[pointName].y * factor, factor),
      );
    });
  });
}

function pathResourcesById(trace: FastManimRuntimeTraceV3, side: "base" | "candidate") {
  const paths = new Map(trace.resources.paths.map((resource) => [resource.id, resource] as const));
  if (paths.size !== trace.resources.paths.length) {
    reject("candidate-resource", `A generic initial resize ${side} repeats a path resource identity.`);
  }
  return paths;
}

/**
 * Proves one generic initial uniform resize after both documents have
 * independently crossed the closed V3 producer contract. The producer bakes a
 * scale into localized path bytes while keeping translation-only state
 * transforms, so this verifier proves that every presented draw keeps its
 * appearance, that each draw anchor conjugates about the preserved settled
 * (terminal) center, and that its path geometry is uniformly scaled.
 */
export function verifyFastManimRuntimeTraceInitialResizeCandidateV3(
  input: Readonly<{
    base: FastManimRuntimeTraceV3;
    baseRequest: FastManimRuntimeTraceProducerRequestV3;
    binding: FastManimRuntimeTraceSourceBindingV3;
    candidate: FastManimRuntimeTraceV3;
    candidateRequest: FastManimRuntimeTraceProducerRequestV3;
    expectedScaleFactor: number;
  }>,
) {
  const factor = fastManimRuntimeTraceCoordinateV3Schema.parse(input.expectedScaleFactor);
  if (factor <= 0) {
    reject("candidate-endpoint", "A generic initial resize requires one positive server-derived scale factor.");
  }
  if (coordinateMatches(factor, 1)) {
    reject("candidate-noop", "A generic initial resize must change the verified dimensions.");
  }
  const { base, baseMapping, candidate, candidateMapping } = verifiedGenericInitialCandidatePairV3(input);
  if (!same(base.resources.appearances, candidate.resources.appearances)) {
    reject("candidate-resource", "A generic initial resize changed paint appearances.");
  }

  const baseInitial = baseMapping.endpoints.initial;
  if (baseInitial.frameIndex !== 0 || baseInitial.sampleTime !== 0) {
    reject("candidate-noop", "A generic initial resize requires one frame-zero base endpoint.");
  }
  // `scale` conjugates about the constructed object center, which the settled
  // (terminal) endpoint observes; an entrance animation's partial frame-zero
  // box scales about that same pivot rather than its own transient center.
  const pivot = baseMapping.endpoints.terminal.center;
  for (const endpointName of ["initial", "terminal"] as const) {
    const baseEndpoint = baseMapping.endpoints[endpointName];
    const candidateEndpoint = candidateMapping.endpoints[endpointName];
    if (
      baseEndpoint.frameIndex !== candidateEndpoint.frameIndex ||
      baseEndpoint.sampleTime !== candidateEndpoint.sampleTime ||
      baseEndpoint.dimensions.height <= 0 ||
      baseEndpoint.dimensions.width <= 0 ||
      candidateEndpoint.dimensions.height <= 0 ||
      candidateEndpoint.dimensions.width <= 0 ||
      !scaledCoordinateMatches(
        candidateEndpoint.center.x,
        pivot.x + (baseEndpoint.center.x - pivot.x) * factor,
        factor,
      ) ||
      !scaledCoordinateMatches(
        candidateEndpoint.center.y,
        pivot.y + (baseEndpoint.center.y - pivot.y) * factor,
        factor,
      ) ||
      !scaledCoordinateMatches(candidateEndpoint.dimensions.height, baseEndpoint.dimensions.height * factor, factor) ||
      !scaledCoordinateMatches(candidateEndpoint.dimensions.width, baseEndpoint.dimensions.width * factor, factor)
    ) {
      reject(
        "candidate-endpoint",
        `The candidate ${endpointName} endpoint is not the exact pivot-conjugated scaled base geometry.`,
      );
    }
  }

  const drawById = new Map(base.draws.map((draw) => [draw.id, draw] as const));
  const candidatePathIdByBasePathId = new Map<string, string>();
  const referencedBasePathIds = new Set<string>();
  const referencedCandidatePathIds = new Set<string>();
  const basePathIdByCandidatePathId = new Map<string, string>();
  if (base.frames.length !== candidate.frames.length) {
    reject("candidate-semantic", "A generic initial resize changed its frame count.");
  }
  // Producer states anchor each draw at its own localized-path center, so a
  // uniform scale about the preserved constructed center conjugates every
  // anchor: an off-center draw must land at pivot + (anchor - pivot) * factor.
  const center = pivot;
  base.frames.forEach((baseFrame, frameIndex) => {
    const candidateFrame = candidate.frames[frameIndex];
    if (
      !candidateFrame ||
      baseFrame.frameIndex !== candidateFrame.frameIndex ||
      baseFrame.sampleTime !== candidateFrame.sampleTime ||
      baseFrame.states.length !== candidateFrame.states.length
    ) {
      reject("candidate-semantic", `A generic initial resize changed frame ${frameIndex} structure.`);
    }
    baseFrame.states.forEach((baseState, stateIndex) => {
      const candidateState = candidateFrame.states[stateIndex];
      const draw = drawById.get(baseState.drawId);
      if (!candidateState || !draw) {
        reject(
          "candidate-semantic",
          `A generic initial resize changed non-scale semantics in frame ${frameIndex}, state ${stateIndex}.`,
        );
      }
      if (draw.rootId !== baseMapping.rootId) {
        // Non-selected roots must replay byte-identically, path bytes included.
        if (!same(baseState, candidateState)) {
          reject(
            "candidate-semantic",
            `A generic initial resize disturbed a non-selected root in frame ${frameIndex}, state ${stateIndex}.`,
          );
        }
        referencedBasePathIds.add(baseState.pathId);
        referencedCandidatePathIds.add(candidateState.pathId);
        return;
      }
      if (
        baseState.appearanceId !== candidateState.appearanceId ||
        baseState.drawId !== candidateState.drawId ||
        baseState.opacity !== candidateState.opacity ||
        baseState.paintOrder !== candidateState.paintOrder ||
        baseState.sourceZIndex !== candidateState.sourceZIndex ||
        !same(baseState.pathTrim, candidateState.pathTrim) ||
        baseState.transform.a !== candidateState.transform.a ||
        baseState.transform.b !== candidateState.transform.b ||
        baseState.transform.c !== candidateState.transform.c ||
        baseState.transform.d !== candidateState.transform.d ||
        !scaledCoordinateMatches(
          candidateState.transform.tx,
          center.x + (baseState.transform.tx - center.x) * factor,
          factor,
        ) ||
        !scaledCoordinateMatches(
          candidateState.transform.ty,
          center.y + (baseState.transform.ty - center.y) * factor,
          factor,
        )
      ) {
        reject(
          "candidate-semantic",
          `A generic initial resize changed non-scale semantics in frame ${frameIndex}, state ${stateIndex}.`,
        );
      }
      const mappedCandidatePathId = candidatePathIdByBasePathId.get(baseState.pathId);
      const mappedBasePathId = basePathIdByCandidatePathId.get(candidateState.pathId);
      if (
        (mappedCandidatePathId !== undefined && mappedCandidatePathId !== candidateState.pathId) ||
        (mappedBasePathId !== undefined && mappedBasePathId !== baseState.pathId)
      ) {
        reject(
          "candidate-semantic",
          `A generic initial resize broke its path correspondence in frame ${frameIndex}, state ${stateIndex}.`,
        );
      }
      candidatePathIdByBasePathId.set(baseState.pathId, candidateState.pathId);
      basePathIdByCandidatePathId.set(candidateState.pathId, baseState.pathId);
      referencedBasePathIds.add(baseState.pathId);
      referencedCandidatePathIds.add(candidateState.pathId);
    });
  });

  const basePaths = pathResourcesById(base, "base");
  const candidatePaths = pathResourcesById(candidate, "candidate");
  if (
    basePaths.size !== referencedBasePathIds.size ||
    candidatePaths.size !== referencedCandidatePathIds.size ||
    ![...basePaths.keys()].every((pathId) => referencedBasePathIds.has(pathId)) ||
    ![...candidatePaths.keys()].every((pathId) => referencedCandidatePathIds.has(pathId))
  ) {
    reject("candidate-resource", "A generic initial resize carries path resources outside its presented states.");
  }
  // A path shared between the selected and a non-selected root keeps its
  // original bytes for the non-selected usage; identical ids must stay
  // byte-identical on both sides.
  for (const [pathId, basePath] of basePaths) {
    const candidatePath = candidatePaths.get(pathId);
    if (candidatePath && !same(basePath.path, candidatePath.path)) {
      reject("candidate-resource", "A generic initial resize changed a retained path resource in place.");
    }
  }
  for (const [basePathId, candidatePathId] of candidatePathIdByBasePathId) {
    const basePath = basePaths.get(basePathId);
    const candidatePath = candidatePaths.get(candidatePathId);
    if (!basePath || !candidatePath || !scaledPathMatches(basePath.path, candidatePath.path, factor)) {
      reject("candidate-resource", "A generic initial resize path is not the exact uniformly scaled base path.");
    }
  }
  if ([...candidatePathIdByBasePathId].every(([basePathId, candidatePathId]) => basePathId === candidatePathId)) {
    reject("candidate-noop", "A generic initial resize did not scale any presented path.");
  }
  return candidate;
}
