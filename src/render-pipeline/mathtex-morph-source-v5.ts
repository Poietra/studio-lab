import { analyzePythonSource, isPythonStatementStart } from "./python-source-analysis";
import { findSceneBlocks, findSourceSceneStatements } from "./source-import";

export const HERMETIC_MATHTEX_MORPH_PROFILE_VERSION_V5 = 5 as const;
export const HERMETIC_MATHTEX_MORPH_FRAME_RATE_V5 = 60 as const;
export const HERMETIC_MATHTEX_MORPH_MAX_DURATION_SECONDS_V5 = 3_600 as const;
export const HERMETIC_MATHTEX_MORPH_MAX_WAITS_V5 = 8 as const;

const MAX_MATHTEX_SOURCE_BYTES_V5 = 2_000;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER_SOURCE =
  "(?:(?:\\d(?:_?\\d)*)\\.(?:\\d(?:_?\\d)*)?|\\.(?:\\d(?:_?\\d)*)|(?:\\d(?:_?\\d)*))(?:[eE][+-]?\\d(?:_?\\d)*)?";
const PYTHON_KEYWORDS = [
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
] as const;
const V5_RESERVED_NAMES = new Set([
  ...PYTHON_KEYWORDS,
  "MathTex",
  "Scene",
  "TransformMatchingTex",
  "self",
  "smoothstep",
]);

export const HERMETIC_MATHTEX_MORPH_SOURCE_REFUSAL_MESSAGE_V5 =
  "The source is outside Studio's bounded two-stage hermetic MathTex morph profile.";

export type HermeticMathTexMorphStagePlanV5 = Readonly<{
  placementSourceName: string;
  reboundAliases: readonly string[];
  runTime: number;
  sourceName: string;
  targetName: string;
  targetTexParts: readonly [string];
}>;

export type HermeticMathTexMorphTimelineStepV5 =
  | Readonly<{ duration: number; kind: "wait" }>
  | Readonly<{ duration: number; kind: "path-morph"; stageIndex: 0 | 1 }>;

export type HermeticMathTexMorphSourcePlanV5 = Readonly<{
  initialName: string;
  initialTexParts: readonly [string];
  stages: readonly [HermeticMathTexMorphStagePlanV5, HermeticMathTexMorphStagePlanV5];
  timeline: readonly HermeticMathTexMorphTimelineStepV5[];
  version: typeof HERMETIC_MATHTEX_MORPH_PROFILE_VERSION_V5;
}>;

export type HermeticMathTexMorphSourceResultV5 =
  | Readonly<{ kind: "accepted"; plan: HermeticMathTexMorphSourcePlanV5 }>
  | Readonly<{
      code: "source-profile-mismatch";
      kind: "refused";
      message: typeof HERMETIC_MATHTEX_MORPH_SOURCE_REFUSAL_MESSAGE_V5;
    }>;

const SOURCE_REFUSAL: Extract<HermeticMathTexMorphSourceResultV5, { kind: "refused" }> = {
  code: "source-profile-mismatch",
  kind: "refused",
  message: HERMETIC_MATHTEX_MORPH_SOURCE_REFUSAL_MESSAGE_V5,
};

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalFrames(duration: number) {
  const frameDuration = 1 / HERMETIC_MATHTEX_MORPH_FRAME_RATE_V5;
  if (
    !Number.isFinite(duration) ||
    duration < frameDuration ||
    duration > HERMETIC_MATHTEX_MORPH_MAX_DURATION_SECONDS_V5
  ) {
    return null;
  }
  // Match fast-manim's canonical_dynamic_timed_step_frames predicate exactly.
  // The producer's frozen-wait and animation paths round a non-integral
  // duration/dt quotient differently, even when duration*60 happens to round
  // to an integer (for example 23/60 in binary floating point).
  const framesValue = duration / frameDuration;
  if (!Number.isInteger(framesValue)) return null;
  const frames = framesValue;
  return Number.isSafeInteger(frames) && frames >= 1 && frames / HERMETIC_MATHTEX_MORPH_FRAME_RATE_V5 === duration
    ? frames
    : null;
}

function sourceByteLength(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    }
  }
  return new TextEncoder().encode(value).byteLength;
}

function literalMathTexAssignment(statement: string) {
  const match = statement.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*MathTex\(([rR]?)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\)$/s,
  );
  if (!match) return null;
  let value: unknown;
  const doubleQuotedBody = match[3];
  const singleQuotedBody = match[4];
  const body = doubleQuotedBody ?? singleQuotedBody;
  if (match[2]) {
    // The upstream V5 profile accepts direct raw string constants. Studio's
    // bounded parser admits the non-ambiguous form whose delimiter is not
    // escaped, preserving every TeX-significant backslash byte.
    const delimiter = doubleQuotedBody === undefined ? "'" : '"';
    if (body!.includes(`\\${delimiter}`)) return null;
    value = body;
  } else if (doubleQuotedBody !== undefined) {
    try {
      value = JSON.parse(`"${doubleQuotedBody}"`);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (typeof value !== "string") return null;
  const bytes = sourceByteLength(value);
  if (value.trim().length === 0 || bytes === null || bytes > MAX_MATHTEX_SOURCE_BYTES_V5) return null;
  return { name: match[1], texParts: [value] as const };
}

function frozenWaitDuration(statement: string) {
  const match = statement.match(
    new RegExp(`^self\\.wait\\(\\s*(${NUMBER_SOURCE})\\s*,\\s*frozen_frame\\s*=\\s*True\\s*\\)$`, "s"),
  );
  if (!match) return null;
  const duration = Number(match[1]!.replaceAll("_", ""));
  return canonicalFrames(duration) === null ? null : duration;
}

function morphPlayDuration(statement: string, sourceName: string, targetName: string) {
  const source = escapePattern(sourceName);
  const target = escapePattern(targetName);
  const match = statement.match(
    new RegExp(
      `^self\\.play\\(\\s*TransformMatchingTex\\(\\s*${source}\\s*,\\s*${target}\\s*,\\s*transform_mismatches\\s*=\\s*True\\s*\\)\\s*,\\s*run_time\\s*=\\s*(${NUMBER_SOURCE})\\s*,\\s*rate_func\\s*=\\s*smoothstep\\s*,?\\s*\\)$`,
      "s",
    ),
  );
  if (!match) return null;
  const duration = Number(match[1]!.replaceAll("_", ""));
  return canonicalFrames(duration) === null ? null : duration;
}

function placedAtSourceCenter(statement: string, targetName: string, sourceName: string) {
  return new RegExp(
    `^${escapePattern(targetName)}\\.move_to\\(\\s*${escapePattern(sourceName)}\\.get_center\\(\\s*\\)\\s*\\)$`,
    "s",
  ).test(statement);
}

function aliasRebinding(statement: string) {
  const match = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)$/s);
  return match ? ([match[1], match[2]] as const) : null;
}

function exactTopLevelStructure(source: string, sceneName: string) {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) return null;
  const significantTopLevel = analysis.lines.flatMap((line, index) =>
    isPythonStatementStart(line) && line.indentation === 0 ? [{ index, text: line.raw.trim() }] : [],
  );
  const importedNames = significantTopLevel[0]?.text
    .match(/^from manim import (.+)$/)?.[1]
    ?.split(",")
    .map((name) => name.trim());
  if (
    significantTopLevel.length !== 2 ||
    !importedNames ||
    importedNames.length !== 4 ||
    new Set(importedNames).size !== 4 ||
    importedNames.some((name) => !["MathTex", "Scene", "TransformMatchingTex", "smoothstep"].includes(name)) ||
    significantTopLevel[1]?.text !== `class ${sceneName}(Scene):`
  ) {
    return null;
  }
  const scenes = findSceneBlocks(source);
  if (scenes.length !== 1 || scenes[0]?.name !== sceneName || scenes[0].bodyIndent !== 8) return null;
  const scene = scenes[0];
  const nextTopLevel = analysis.lines.findIndex(
    (line, index) => index > scene.classLine && isPythonStatementStart(line) && line.indentation === 0,
  );
  const classEnd = nextTopLevel < 0 ? analysis.lines.length : nextTopLevel;
  const classStatements = analysis.lines.flatMap((line, index) =>
    index > scene.classLine && index < classEnd && isPythonStatementStart(line) && line.indentation === 4
      ? [{ index, text: line.raw.trim() }]
      : [],
  );
  if (
    classStatements.length !== 1 ||
    classStatements[0]?.index !== scene.bodyStart - 1 ||
    classStatements[0]?.text !== "def construct(self):"
  ) {
    return null;
  }
  return findSourceSceneStatements(source, sceneName).filter((statement) => !statement.text.startsWith("#"));
}

/**
 * Re-derives the bounded source plan without executing Python. Refusals carry
 * no source excerpt or TeX payload, so callers can safely surface or log them.
 */
export function deriveHermeticMathTexMorphSourcePlanV5(
  source: string,
  sceneName: string,
): HermeticMathTexMorphSourceResultV5 {
  if (!IDENTIFIER_PATTERN.test(sceneName) || V5_RESERVED_NAMES.has(sceneName)) return SOURCE_REFUSAL;
  const body = exactTopLevelStructure(source, sceneName);
  if (!body || body.length < 11) return SOURCE_REFUSAL;
  const initial = literalMathTexAssignment(body[0]?.text ?? "");
  if (!initial || V5_RESERVED_NAMES.has(initial.name)) return SOURCE_REFUSAL;
  if (body[1]?.text !== `self.add(${initial.name})`) return SOURCE_REFUSAL;

  const waits = new Map<number, number>();
  const core: Array<Readonly<{ bodyIndex: number; text: string }>> = [];
  for (const [bodyIndex, statement] of body.slice(2).entries()) {
    const duration = frozenWaitDuration(statement.text);
    if (duration !== null) waits.set(bodyIndex + 2, duration);
    else core.push({ bodyIndex: bodyIndex + 2, text: statement.text });
  }
  if (waits.size > HERMETIC_MATHTEX_MORPH_MAX_WAITS_V5 || core.length !== 9) return SOURCE_REFUSAL;

  const firstTarget = literalMathTexAssignment(core[0]?.text ?? "");
  const secondTarget = literalMathTexAssignment(core[4]?.text ?? "");
  if (
    !firstTarget ||
    !secondTarget ||
    new Set([initial.name, firstTarget.name, secondTarget.name]).size !== 3 ||
    V5_RESERVED_NAMES.has(firstTarget.name) ||
    V5_RESERVED_NAMES.has(secondTarget.name) ||
    firstTarget.texParts[0] === initial.texParts[0] ||
    secondTarget.texParts[0] !== initial.texParts[0]
  ) {
    return SOURCE_REFUSAL;
  }
  if (
    !placedAtSourceCenter(core[1]?.text ?? "", firstTarget.name, initial.name) ||
    !placedAtSourceCenter(core[5]?.text ?? "", secondTarget.name, firstTarget.name)
  ) {
    return SOURCE_REFUSAL;
  }
  const firstRunTime = morphPlayDuration(core[2]?.text ?? "", initial.name, firstTarget.name);
  const secondRunTime = morphPlayDuration(core[6]?.text ?? "", firstTarget.name, secondTarget.name);
  if (firstRunTime === null || secondRunTime === null) return SOURCE_REFUSAL;
  const firstRebinding = aliasRebinding(core[3]?.text ?? "");
  const finalRebindings = [aliasRebinding(core[7]?.text ?? ""), aliasRebinding(core[8]?.text ?? "")];
  if (
    firstRebinding?.[0] !== initial.name ||
    firstRebinding[1] !== firstTarget.name ||
    finalRebindings.some((entry) => entry === null) ||
    !finalRebindings.some((entry) => entry?.[0] === firstTarget.name && entry[1] === secondTarget.name) ||
    !finalRebindings.some((entry) => entry?.[0] === initial.name && entry[1] === secondTarget.name)
  ) {
    return SOURCE_REFUSAL;
  }

  const timeline: HermeticMathTexMorphTimelineStepV5[] = [];
  for (let bodyIndex = 2; bodyIndex < body.length; bodyIndex += 1) {
    const wait = waits.get(bodyIndex);
    if (wait !== undefined) timeline.push({ duration: wait, kind: "wait" });
    else if (bodyIndex === core[2]?.bodyIndex) {
      timeline.push({ duration: firstRunTime, kind: "path-morph", stageIndex: 0 });
    } else if (bodyIndex === core[6]?.bodyIndex) {
      timeline.push({ duration: secondRunTime, kind: "path-morph", stageIndex: 1 });
    }
  }
  const timelineFrames = timeline.reduce((total, step) => total + (canonicalFrames(step.duration) ?? 0), 0);
  if (timelineFrames > HERMETIC_MATHTEX_MORPH_MAX_DURATION_SECONDS_V5 * HERMETIC_MATHTEX_MORPH_FRAME_RATE_V5) {
    return SOURCE_REFUSAL;
  }

  return {
    kind: "accepted",
    plan: {
      initialName: initial.name,
      initialTexParts: initial.texParts,
      stages: [
        {
          placementSourceName: initial.name,
          reboundAliases: [initial.name],
          runTime: firstRunTime,
          sourceName: initial.name,
          targetName: firstTarget.name,
          targetTexParts: firstTarget.texParts,
        },
        {
          placementSourceName: firstTarget.name,
          reboundAliases: [firstTarget.name, initial.name],
          runTime: secondRunTime,
          sourceName: firstTarget.name,
          targetName: secondTarget.name,
          targetTexParts: secondTarget.texParts,
        },
      ],
      timeline,
      version: HERMETIC_MATHTEX_MORPH_PROFILE_VERSION_V5,
    },
  };
}
