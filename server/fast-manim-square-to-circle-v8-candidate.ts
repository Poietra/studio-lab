import { createHash } from "node:crypto";

import { MAX_COORDINATE } from "../src/engine/primitives";
import {
  removeDirectSourceStatementsV1,
  SourceAnalysisError,
  studioSourceAnalysisProviderV1,
} from "../src/render-pipeline/source-analysis";

export const FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_SOURCE_PATH_V8 = "example_scenes/basic.py" as const;
export const FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_SCENE_NAME_V8 = "SquareToCircle" as const;
export const FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_BASE_SOURCE_SHA256_V8 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;

export type SquareToCircleV8PositionPlan = Readonly<{
  moveTo: Readonly<{ x: number; y: number }> | null;
}>;

const EMPTY_PLAN = Object.freeze({ moveTo: null }) satisfies SquareToCircleV8PositionPlan;
const CANONICAL_NUMBER = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?";
const MOVE_TO = new RegExp(`^(square|circle)\\.move_to\\(\\((${CANONICAL_NUMBER}), (${CANONICAL_NUMBER}), 0\\)\\)$`);

export class SquareToCircleV8CandidateSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SquareToCircleV8CandidateSourceError";
  }
}

function reject(message: string): never {
  throw new SquareToCircleV8CandidateSourceError(`SquareToCircle profile V8 candidate: ${message}`);
}

function canonicalCoordinate(source: string) {
  const value = Number(source);
  if (
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    Math.abs(value) > MAX_COORDINATE ||
    value.toString() !== source
  ) {
    return null;
  }
  return value;
}

/**
 * Recovers the only source edit admitted by the V8 candidate family without
 * executing Python. Exactly two complete, equally-valued move_to statements
 * may appear after the canonical setup and before Create. Removing them must
 * recover the byte-exact official module, so aliases, expressions, control
 * flow, sibling edits, and reordered dependencies all fail closed.
 */
export function deriveSquareToCircleV8PositionPlan(source: string, sceneName: string): SquareToCircleV8PositionPlan {
  if (sceneName !== FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_SCENE_NAME_V8) {
    reject("source verification requires the exact selected Scene name.");
  }
  const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
  if (sourceDigest === FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_BASE_SOURCE_SHA256_V8) return EMPTY_PLAN;

  let analysis: ReturnType<typeof studioSourceAnalysisProviderV1.analyze>;
  try {
    analysis = studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: sourceDigest,
      sceneName,
      sourcePath: FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_SOURCE_PATH_V8,
      sourceText: source,
    });
  } catch (cause) {
    throw new SquareToCircleV8CandidateSourceError(
      `SquareToCircle profile V8 candidate SourceAnalysis rejected the selected Scene${
        cause instanceof SourceAnalysisError ? ` (${cause.code})` : ""
      }.`,
      { cause },
    );
  }
  const statements = analysis.scene.statements;
  const prefix = [
    "circle = Circle()",
    "square = Square()",
    "square.flip(RIGHT)",
    "square.rotate(-3 * TAU / 8)",
    "circle.set_fill(PINK, opacity=0.5)",
  ] as const;
  const suffix = [
    "self.play(Create(square))",
    "self.play(Transform(square, circle))",
    "self.play(FadeOut(square))",
  ] as const;
  if (
    statements.length !== prefix.length + 2 + suffix.length ||
    prefix.some((text, index) => statements[index]?.text !== text) ||
    suffix.some((text, index) => statements[prefix.length + 2 + index]?.text !== text)
  ) {
    reject("source must retain the exact setup, Transform dependency, and three-play timeline.");
  }

  const squareMove = statements[prefix.length]!;
  const circleMove = statements[prefix.length + 1]!;
  const squareMatch = squareMove.text.match(MOVE_TO);
  const circleMatch = circleMove.text.match(MOVE_TO);
  if (
    squareMatch?.[1] !== "square" ||
    circleMatch?.[1] !== "circle" ||
    squareMove.rawText !== `        ${squareMove.text}` ||
    circleMove.rawText !== `        ${circleMove.text}` ||
    squareMove.line + 1 !== circleMove.line ||
    squareMatch[2] !== circleMatch[2] ||
    squareMatch[3] !== circleMatch[3]
  ) {
    reject("requires adjacent square then circle move_to calls with identical canonical literals.");
  }
  const x = canonicalCoordinate(squareMatch[2]);
  const y = canonicalCoordinate(squareMatch[3]);
  if (x === null || y === null) reject("move_to coordinates must be finite bounded canonical Studio literals.");
  if (x === 0 && y === 0) reject("the paired position candidate must not be a no-op.");

  let reconstructed: string;
  try {
    reconstructed = removeDirectSourceStatementsV1(source, analysis, [
      { expectedText: squareMove.text, statementId: squareMove.id },
      { expectedText: circleMove.text, statementId: circleMove.id },
    ]);
  } catch (cause) {
    throw new SquareToCircleV8CandidateSourceError(
      "SquareToCircle profile V8 candidate edits do not have canonical removable statement spans.",
      { cause },
    );
  }
  if (
    createHash("sha256").update(reconstructed, "utf8").digest("hex") !==
    FAST_MANIM_SQUARE_TO_CIRCLE_CANDIDATE_BASE_SOURCE_SHA256_V8
  ) {
    reject("removing the paired move_to lines must reconstruct the exact official source bytes.");
  }
  return Object.freeze({ moveTo: Object.freeze({ x, y }) });
}
