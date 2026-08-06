import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  type FastManimRuntimeTraceProducerRequestV1,
  type FastManimRuntimeTraceV1,
  fastManimRuntimeTraceProducerRequestV1Schema,
  fastManimRuntimeTraceV1Schema,
  type TrustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";

const TERMINAL_FRAME_INDEX_V1 = 300;

export type FastManimRuntimeTraceCandidateErrorCodeV1 =
  | "base-mismatch"
  | "candidate-correlation"
  | "candidate-noop"
  | "candidate-prefix"
  | "candidate-producer"
  | "candidate-resource"
  | "candidate-root";

export class FastManimRuntimeTraceCandidateErrorV1 extends Error {
  readonly code: FastManimRuntimeTraceCandidateErrorCodeV1;

  constructor(code: FastManimRuntimeTraceCandidateErrorCodeV1, message: string) {
    super(message);
    this.name = "FastManimRuntimeTraceCandidateErrorV1";
    this.code = code;
  }
}

function reject(code: FastManimRuntimeTraceCandidateErrorCodeV1, message: string): never {
  throw new FastManimRuntimeTraceCandidateErrorV1(code, message);
}

function same(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function producerIdentity(producer: FastManimRuntimeTraceV1["producer"]) {
  return {
    fastManimCommit: producer.fastManimCommit,
    fastManimTree: producer.fastManimTree,
    glyphProviderSha256: producer.glyphProviderSha256,
    manimVersion: producer.manimVersion,
  };
}

function traceCorrelation(trace: FastManimRuntimeTraceV1) {
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

function requestCorrelation(request: FastManimRuntimeTraceProducerRequestV1) {
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

function assertCandidateRoots(base: FastManimRuntimeTraceV1, candidate: FastManimRuntimeTraceV1) {
  if (candidate.roots.length !== base.roots.length) {
    reject("candidate-root", "A Runtime Trace candidate changed the number of source roots.");
  }
  candidate.roots.forEach((root, index) => {
    const baseRoot = base.roots[index];
    if (!baseRoot) reject("candidate-root", "A Runtime Trace candidate introduced an unknown source root.");
    const expectedBindingId = fastManimSourceBindingIdentifierV1(candidate.sourceHash, candidate.sceneId, root.binding);
    const { id: _candidateBindingId, ...candidateBinding } = root.binding;
    const { id: _baseBindingId, ...baseBinding } = baseRoot.binding;
    if (
      root.binding.id !== expectedBindingId ||
      !same({ ...root, binding: candidateBinding }, { ...baseRoot, binding: baseBinding })
    ) {
      reject("candidate-root", "A Runtime Trace candidate changed its source-root identity.");
    }
  });
}

function assertEveryResourceIsUsed(trace: FastManimRuntimeTraceV1) {
  const appearanceIds = new Set<string>();
  const pathIds = new Set<string>();
  for (const frame of trace.frames) {
    for (const draw of frame.draws) {
      appearanceIds.add(draw.appearanceId);
      pathIds.add(draw.pathId);
    }
  }
  if (
    trace.resources.appearances.some(({ id }) => !appearanceIds.has(id)) ||
    trace.resources.paths.some(({ id }) => !pathIds.has(id))
  ) {
    reject("candidate-resource", "A Runtime Trace candidate contains an unreferenced visual resource.");
  }
}

/**
 * Verifies the narrow #492 temporal claim after both documents have crossed
 * their bounded wire schemas. Source analysis separately proves that the only
 * candidate-source change is one terminal Square edit. This verifier proves
 * that executing those bytes preserved every animated frame and changed only
 * the one-second hold where the edit is allowed to take effect.
 */
export function verifyFastManimRuntimeTraceTerminalCandidateV1(input: {
  base: FastManimRuntimeTraceV1;
  candidate: FastManimRuntimeTraceV1;
  candidateRequest: FastManimRuntimeTraceProducerRequestV1;
  trusted: TrustedFastManimRuntimeTraceProducerV1;
}) {
  const base = fastManimRuntimeTraceV1Schema.parse(input.base);
  const candidate = fastManimRuntimeTraceV1Schema.parse(input.candidate);
  const request = fastManimRuntimeTraceProducerRequestV1Schema.parse(input.candidateRequest);

  if (!same(base.producer, input.trusted.producer) || !same(base.roots, input.trusted.roots)) {
    reject("base-mismatch", "The Runtime Trace candidate base is not the independently trusted official trace.");
  }
  if (
    !same(traceCorrelation(candidate), requestCorrelation(request)) ||
    !same(candidate.camera, request.runtimeConfig.camera)
  ) {
    reject("candidate-correlation", "A Runtime Trace candidate is stale for its exact source request.");
  }
  if (!same(producerIdentity(candidate.producer), producerIdentity(base.producer))) {
    reject("candidate-producer", "A Runtime Trace candidate was produced by a different toolchain.");
  }
  if (candidate.sourceHash === base.sourceHash) {
    reject("candidate-correlation", "A Runtime Trace candidate must identify distinct edited source bytes.");
  }

  assertCandidateRoots(base, candidate);
  assertEveryResourceIsUsed(candidate);

  for (let frameIndex = 0; frameIndex < TERMINAL_FRAME_INDEX_V1; frameIndex += 1) {
    if (!same(candidate.frames[frameIndex], base.frames[frameIndex])) {
      reject("candidate-prefix", `A Runtime Trace candidate changed protected frame ${frameIndex}.`);
    }
  }

  const baseTerminal = base.frames[TERMINAL_FRAME_INDEX_V1];
  const candidateTerminal = candidate.frames[TERMINAL_FRAME_INDEX_V1];
  if (!baseTerminal || !candidateTerminal || same(candidateTerminal, baseTerminal)) {
    reject("candidate-noop", "A Runtime Trace candidate did not change the editable terminal hold.");
  }
  if (
    same(candidateTerminal.motionY, baseTerminal.motionY) &&
    same(candidateTerminal.draws[0], baseTerminal.draws[0])
  ) {
    reject("candidate-noop", "A Runtime Trace candidate changed only the dependent DecimalNumber family.");
  }

  return candidate;
}
