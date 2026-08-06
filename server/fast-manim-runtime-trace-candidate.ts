import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  deriveUpdatersTerminalSourceEditPlanV1,
  type UpdatersTerminalSourceEditPlanV1,
} from "../src/render-pipeline/source-lowering";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTracePathV1,
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
  | "candidate-root"
  | "candidate-semantic"
  | "candidate-source";

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

type RuntimeTraceDrawV1 = FastManimRuntimeTraceV1["frames"][number]["draws"][number];
type RuntimeTracePathV1 = FastManimRuntimeTraceV1["resources"]["paths"][number]["path"];

const DECIMAL_CHARACTERS_V1 = "0123456789+-.";

function roundedPositiveFixed3Integer(value: number) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value), false);
  const bits = view.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const binaryExponent = exponentBits === 0 ? -1_074 : exponentBits - 1_023 - 52;
  let numerator = significand * 1_000n;
  let denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && rounded % 2n === 1n)) rounded += 1n;
  return rounded;
}

/** Mirrors Python's signed `,.3f` plus DecimalNumber's negative-zero repair. */
function formatRuntimeTraceDecimalV1(value: number) {
  const fixed = roundedPositiveFixed3Integer(value);
  const integral = (fixed / 1_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fractional = (fixed % 1_000n).toString().padStart(3, "0");
  const negative = value < 0 || Object.is(value, -0);
  // numpy.round uses a binary64 multiply/rint fast path. A negative value
  // rounded to zero has its sign replaced by DecimalNumber._get_num_string.
  const numpyRoundedToZero = Math.abs(value * 1_000) <= 0.5;
  return `${negative && !numpyRoundedToZero ? "-" : "+"}${integral}.${fractional}`;
}

function pathPoints(path: RuntimeTracePathV1) {
  return path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
  ]);
}

function pathSize(path: RuntimeTracePathV1) {
  const points = pathPoints(path);
  return {
    height: Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y)),
    width: Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x)),
  };
}

function canonicalSquarePath(factor: number): RuntimeTracePathV1 {
  const anchors = [
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
  ] as const;
  const point = (
    start: Readonly<{ x: number; y: number }>,
    end: Readonly<{ x: number; y: number }>,
    alpha: number,
  ) => ({
    // Preserve the pinned Manim/NumPy operation order: Square constructs each
    // cubic point before scale(), and the producer quantizes only afterwards.
    x: canonicalFastManimRuntimeTraceCoordinateV1(((1 - alpha) * start.x + alpha * end.x) * factor),
    y: canonicalFastManimRuntimeTraceCoordinateV1(((1 - alpha) * start.y + alpha * end.y) * factor),
  });
  return {
    subpaths: [
      {
        closed: true,
        segments: anchors.slice(0, -1).map((start, index) => {
          const end = anchors[index + 1]!;
          return {
            control1: point(start, end, 1 / 3),
            control2: point(start, end, 2 / 3),
            end: point(start, end, 1),
          };
        }),
        start: point(anchors[0], anchors[1], 0),
      },
    ],
  };
}

function fixedDrawSemantics(draw: RuntimeTraceDrawV1) {
  return {
    appearanceId: draw.appearanceId,
    familyPath: draw.familyPath,
    opacity: draw.opacity,
    paintOrder: draw.paintOrder,
    rootId: draw.rootId,
    sourceZIndex: draw.sourceZIndex,
  };
}

function sourceEditPlan(request: FastManimRuntimeTraceProducerRequestV1) {
  let plan: UpdatersTerminalSourceEditPlanV1;
  try {
    plan = deriveUpdatersTerminalSourceEditPlanV1(request.sourceText, request.sceneName);
  } catch {
    reject("candidate-source", "The Runtime Trace candidate source has no independently derivable terminal edit plan.");
  }
  if ((plan.moveTo === null && plan.scale === null) || !plan.refreshDependentUpdater) {
    reject("candidate-source", "The Runtime Trace candidate source contains no terminal Square edit.");
  }
  return plan;
}

function decimalGlyphOracle(base: FastManimRuntimeTraceV1) {
  const paths = new Map(base.resources.paths.map((resource) => [resource.id, resource.path]));
  const glyphPathIds = new Map<string, string>();
  for (const frame of base.frames) {
    const formatted = formatRuntimeTraceDecimalV1(frame.motionY);
    if (formatted.length !== 6 || [...formatted].some((character) => !DECIMAL_CHARACTERS_V1.includes(character))) {
      reject("base-mismatch", "The trusted Runtime Trace base left its signed three-decimal glyph closure.");
    }
    [...formatted].forEach((character, index) => {
      const pathId = frame.draws[index + 1]?.pathId;
      const previous = glyphPathIds.get(character);
      if (!pathId || (previous !== undefined && previous !== pathId)) {
        reject("base-mismatch", "The trusted Runtime Trace base does not define a stable decimal glyph oracle.");
      }
      glyphPathIds.set(character, pathId);
    });
  }
  if ([...DECIMAL_CHARACTERS_V1].some((character) => !glyphPathIds.has(character))) {
    reject("base-mismatch", "The trusted Runtime Trace base does not cover the sealed decimal glyph alphabet.");
  }
  for (const pathId of glyphPathIds.values()) {
    if (!paths.has(pathId)) reject("base-mismatch", "The trusted decimal glyph oracle references a missing path.");
  }
  return { glyphPathIds, paths };
}

function expectedTerminalDraws(
  base: FastManimRuntimeTraceV1,
  plan: UpdatersTerminalSourceEditPlanV1,
): Readonly<{ draws: RuntimeTraceDrawV1[]; motionY: number }> {
  const baseTerminal = base.frames[TERMINAL_FRAME_INDEX_V1];
  const baseSquare = baseTerminal?.draws[0];
  const squareRoot = base.roots[0];
  const decimalRoot = base.roots[1];
  if (!baseTerminal || !baseSquare || !squareRoot || !decimalRoot) {
    reject("base-mismatch", "The trusted Runtime Trace base has no terminal Square/DecimalNumber oracle.");
  }
  const oracle = decimalGlyphOracle(base);
  const baseSquarePath = oracle.paths.get(baseSquare.pathId);
  if (!baseSquarePath) reject("base-mismatch", "The trusted Runtime Trace base has no Square path.");
  if (!same(baseSquarePath, canonicalSquarePath(1))) {
    reject("base-mismatch", "The trusted Runtime Trace base diverged from the pinned Square geometry.");
  }

  const terminalScale = plan.scale ?? 1;
  const expectedSquarePath = canonicalSquarePath(terminalScale);
  const expectedSquarePathId = `path:${digestFastManimRuntimeTracePathV1(expectedSquarePath)}`;
  const squareX = canonicalFastManimRuntimeTraceCoordinateV1(plan.moveTo?.x ?? baseSquare.localPosition.x);
  const squareY = canonicalFastManimRuntimeTraceCoordinateV1(plan.moveTo?.y ?? baseTerminal.motionY);
  const squareDraw: RuntimeTraceDrawV1 = {
    ...baseSquare,
    localPosition: { x: squareX, y: baseSquare.localPosition.y },
    pathId: expectedSquarePathId,
  };

  const baseFormatted = formatRuntimeTraceDecimalV1(baseTerminal.motionY);
  const targetFormatted = formatRuntimeTraceDecimalV1(squareY);
  if (
    baseFormatted.length !== 6 ||
    targetFormatted.length !== 6 ||
    [...targetFormatted].some((character) => !DECIMAL_CHARACTERS_V1.includes(character))
  ) {
    reject("candidate-source", "The terminal Square position leaves the sealed six-character DecimalNumber profile.");
  }
  const baseGlyphDraws = baseTerminal.draws.slice(1, 7);
  const baseEllipsisDraws = baseTerminal.draws.slice(7);
  if (baseGlyphDraws.length !== 6 || baseEllipsisDraws.length !== 3) {
    reject("base-mismatch", "The trusted Runtime Trace base has an incomplete DecimalNumber family.");
  }
  const targetPathIds = [...targetFormatted].map((character) => oracle.glyphPathIds.get(character)!);
  const targetSizes = targetPathIds.map((pathId) => pathSize(oracle.paths.get(pathId)!));
  const baseSizes = [...baseFormatted].map((character) =>
    pathSize(oracle.paths.get(oracle.glyphPathIds.get(character)!)!),
  );
  const ellipsisSizes = baseEllipsisDraws.map(({ pathId }) => {
    const path = oracle.paths.get(pathId);
    if (!path) reject("base-mismatch", "The trusted Runtime Trace base has a missing ellipsis path.");
    return pathSize(path);
  });
  const maximumHeight = Math.max(
    ...targetSizes.map(({ height }) => height),
    ...ellipsisSizes.map(({ height }) => height),
  );
  // The source proof pins `Square()` itself: side length 2 before the optional
  // scale. Do not let producer-supplied path bounds define updater placement.
  const decimalPlacementDelta = squareX + terminalScale + 0.25 - decimalRoot.offset.x;
  let precedingWidthDelta = 0;
  const decimalDraws = baseGlyphDraws.map((baseDraw, index): RuntimeTraceDrawV1 => {
    const size = targetSizes[index]!;
    const baseSize = baseSizes[index]!;
    const draw = {
      ...baseDraw,
      localPosition: {
        x: canonicalFastManimRuntimeTraceCoordinateV1(
          baseDraw.localPosition.x + decimalPlacementDelta + precedingWidthDelta + (size.width - baseSize.width) / 2,
        ),
        y: canonicalFastManimRuntimeTraceCoordinateV1(size.height / 2 - maximumHeight / 2),
      },
      pathId: targetPathIds[index]!,
    };
    precedingWidthDelta += size.width - baseSize.width;
    return draw;
  });
  if (targetFormatted[0] === "-") {
    const sign = decimalDraws[0]!;
    const next = decimalDraws[1]!;
    sign.localPosition.y = canonicalFastManimRuntimeTraceCoordinateV1(
      next.localPosition.y - targetSizes[0]!.height / 2,
    );
  }
  const baseMaximumHeight = Math.max(
    ...baseSizes.map(({ height }) => height),
    ...ellipsisSizes.map(({ height }) => height),
  );
  decimalDraws.push(
    ...baseEllipsisDraws.map(
      (draw): RuntimeTraceDrawV1 => ({
        ...draw,
        localPosition: {
          x: canonicalFastManimRuntimeTraceCoordinateV1(
            draw.localPosition.x + decimalPlacementDelta + precedingWidthDelta,
          ),
          y: canonicalFastManimRuntimeTraceCoordinateV1(draw.localPosition.y + (baseMaximumHeight - maximumHeight) / 2),
        },
      }),
    ),
  );
  return { draws: [squareDraw, ...decimalDraws], motionY: squareY };
}

function assertTerminalSemantics(
  base: FastManimRuntimeTraceV1,
  candidate: FastManimRuntimeTraceV1,
  plan: UpdatersTerminalSourceEditPlanV1,
) {
  const expected = expectedTerminalDraws(base, plan);
  const actual = candidate.frames[TERMINAL_FRAME_INDEX_V1];
  if (!actual || actual.motionY !== expected.motionY || actual.draws.length !== expected.draws.length) {
    reject("candidate-semantic", "The Runtime Trace candidate terminal frame does not match its source edit plan.");
  }
  actual.draws.forEach((draw, index) => {
    const expectedDraw = expected.draws[index];
    if (
      !expectedDraw ||
      !same(fixedDrawSemantics(draw), fixedDrawSemantics(expectedDraw)) ||
      draw.pathId !== expectedDraw.pathId ||
      !same(draw.localPosition, expectedDraw.localPosition)
    ) {
      reject(
        "candidate-semantic",
        `The Runtime Trace candidate draw ${index} does not match the source-derived Square/updater semantics.`,
      );
    }
  });
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
  const plan = sourceEditPlan(request);

  assertCandidateRoots(base, candidate);
  assertEveryResourceIsUsed(candidate);

  for (let frameIndex = 0; frameIndex < TERMINAL_FRAME_INDEX_V1; frameIndex += 1) {
    if (!same(candidate.frames[frameIndex], base.frames[frameIndex])) {
      reject("candidate-prefix", `A Runtime Trace candidate changed protected frame ${frameIndex}.`);
    }
  }

  const baseTerminal = base.frames[TERMINAL_FRAME_INDEX_V1];
  const candidateTerminal = candidate.frames[TERMINAL_FRAME_INDEX_V1];
  assertTerminalSemantics(base, candidate, plan);
  if (!baseTerminal || !candidateTerminal || same(candidateTerminal, baseTerminal)) {
    reject("candidate-noop", "A Runtime Trace candidate did not change the editable terminal hold.");
  }

  return candidate;
}
