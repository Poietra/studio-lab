import { createHash } from "node:crypto";

import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
  type SourceBindingV1,
  STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1,
  type VerifiedSourceRuntimeIdentityMapV1,
  verifiedSourceRuntimeIdentityMapV1Schema,
} from "../src/engine/source-runtime-identity";
import { analyzePythonSource, isPythonStatementStart } from "../src/render-pipeline/python-source-analysis";
import { findSourceSceneBlock } from "../src/render-pipeline/source-import";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_MATHTEX_PROVENANCE_EVIDENCE_V7,
  FastManimSnapshotContractError,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedFastManimSnapshotResultV1,
} from "./fast-manim-snapshot-contract";
import type { ParsedFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";

const MAX_ENTITIES = 10_000;
const MAX_BINDING_CLAIMS = 10_000;
const MAX_BINDINGS_PER_ENTITY = 64;
const MAX_BINDING_OBSERVATIONS = 100_000;
const OVERFLOW_RELEASE_SEQUENCE = MAX_BINDING_OBSERVATIONS + 1;
const MAX_LIFECYCLE_SEQUENCE = 1_000_000;
const MAX_FAMILY_PATH_DEPTH = 64;
const MAX_SUBMOBJECTS_PER_PARENT = 10_000;
const MAX_BOUND_STRING_BYTES = 500;
const MAX_IDENTITY_STRING_BYTES = 240;

const EVIDENCE_FIELDS = [
  "issues",
  "kind",
  "projectId",
  "records",
  "requestId",
  "runtimeConfigHash",
  "sceneId",
  "sceneName",
  "snapshotDigest",
  "sourceHash",
  "sourcePath",
] as const;
const RECORD_FIELDS = [
  "bindings",
  "entityId",
  "familyPath",
  "lifecycle",
  "provenanceId",
  "reasons",
  "runtimeType",
  "sceneOrder",
  "status",
] as const;
const ISSUE_CODES = new Set([
  "animation-evidence-incomplete",
  "appearance-evidence-incomplete",
  "asset-evidence-incomplete",
  "camera-evidence-incomplete",
  "geometry-evidence-incomplete",
  "identity-evidence-incomplete",
  "ordering-evidence-incomplete",
  "runtime-semantics-unsupported",
  "source-binding-unsupported",
  "source-correlation-incomplete",
]);
const LIFECYCLE_ACTIONS = new Set(["add", "remove", "replace-source", "replace-target"]);
const REASONS = new Set([
  "duplicate-runtime-reference",
  "multiple-active-source-bindings",
  "no-active-source-binding",
  "snapshot-unsupported",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PYTHON_IDENTIFIER = /^(?:_|\p{ID_Start})(?:_|\p{ID_Continue})*$/u;

type PlainObject = Record<string, unknown>;

function identityError(message: string, cause?: unknown): never {
  throw new FastManimSnapshotContractError(
    "identity-evidence-invalid",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: PlainObject, fields: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function requireIdentity(condition: unknown, message: string): asserts condition {
  if (!condition) identityError(message);
}

function boundedString(value: unknown, maximumBytes: number, label: string): string {
  requireIdentity(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= maximumBytes &&
      !CONTROL_CHARACTERS.test(value),
    `${label} is not a bounded identity string.`,
  );
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  requireIdentity(
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} is outside the bounded integer range.`,
  );
  return value;
}

function bindingIdentifier(
  sourceHash: string,
  sceneId: string,
  binding: Readonly<{ name: string; ordinal: number; span: SourceBindingV1["span"] }>,
) {
  const payload = [
    FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
    String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
    sourceHash,
    sceneId,
    binding.name,
    String(binding.ordinal),
    String(binding.span.startLine),
    String(binding.span.startColumn),
    String(binding.span.endLine),
    String(binding.span.endColumn),
  ].join("\u0000");
  return `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

type SourceBindingLookup = Readonly<{
  constructors: ReadonlyMap<string, string>;
  studioSites: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
}>;

const STUDIO_SUPPORTED_CONSTRUCTORS_V1_TO_V3 = new Set([
  "Arrow",
  "Circle",
  "Dot",
  "Group",
  "Line",
  "MathTex",
  "Rectangle",
  "RegularPolygon",
  "Square",
  "SurroundingRectangle",
  "Text",
  "VGroup",
]);

const STUDIO_SUPPORTED_CONSTRUCTORS_V6 = new Set([
  "Arc",
  "Circle",
  "CubicBezier",
  "Line",
  "Polygon",
  "Rectangle",
  "Square",
  "Triangle",
]);

const STUDIO_SUPPORTED_CONSTRUCTORS_V7 = new Set(["Circle", "Line", "MathTex", "Rectangle"]);
const STUDIO_SUPPORTED_CONSTRUCTORS_V8 = new Set(["Square"]);

/**
 * Exact producer-owned runtime classes admitted by mixed dynamic V7.
 *
 * Constructor spelling alone is not runtime identity: without this binding a
 * producer could pair a lexical Rectangle claim with a Circle record (or a
 * normal, non-hermetic MathTex) while still satisfying the broad V7 role
 * check. Keep this table closed and fully qualified so subclasses, aliases,
 * and cross-vector substitutions fail closed.
 */
const STUDIO_RUNTIME_TYPES_BY_CONSTRUCTOR_V7: ReadonlyMap<string, string> = new Map([
  ["Circle", "manim.mobject.geometry.arc.Circle"],
  ["Line", "manim.mobject.geometry.line.Line"],
  ["MathTex", "manim.renderer._scene_snapshot.mathtex.HermeticMathTexSnapshotMobject"],
  ["Rectangle", "manim.mobject.geometry.polygram.Rectangle"],
] as const);
const STUDIO_SQUARE_RUNTIME_TYPE_V8 = "manim.mobject.geometry.polygram.Square" as const;

function studioSupportsConstructor(
  constructor: string,
  snapshotVersion: ExpectedFastManimSnapshotCorrelationV1["snapshotVersion"],
) {
  // V5 intentionally represents one aggregate render track whose three live
  // Python aliases cannot identify one editable source object. It remains
  // display-only even if producer evidence attempts to select one alias.
  if (snapshotVersion === 5) return false;
  if (snapshotVersion === 4) return constructor === "ImageMobject";
  if (snapshotVersion === 6) return STUDIO_SUPPORTED_CONSTRUCTORS_V6.has(constructor);
  if (snapshotVersion === 7) return STUDIO_SUPPORTED_CONSTRUCTORS_V7.has(constructor);
  if (snapshotVersion === 8) return STUDIO_SUPPORTED_CONSTRUCTORS_V8.has(constructor);
  return STUDIO_SUPPORTED_CONSTRUCTORS_V1_TO_V3.has(constructor);
}

function sourceBindingKey(binding: Readonly<{ name: string; ordinal?: number; span: SourceBindingV1["span"] }>) {
  const { endColumn, endLine, startColumn, startLine } = binding.span;
  return `${binding.name}\u0000${binding.ordinal ?? ""}\u0000${startLine}\u0000${startColumn}\u0000${endLine}\u0000${endColumn}`;
}

function sourceTokenKey(binding: Readonly<{ name: string; span: SourceBindingV1["span"] }>) {
  return sourceBindingKey({ ...binding, ordinal: undefined });
}

function topLevelAssignmentOperators(code: string) {
  let depth = 0;
  let count = 0;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (
      character === "=" &&
      depth === 0 &&
      code[index + 1] !== "=" &&
      !/[=!<>:+\-*/%@&|^]/.test(code[index - 1] ?? "")
    ) {
      count += 1;
    }
  }
  return count;
}

function unwrapDirectParenthesizedExpression(source: string) {
  let expression = source.trim();
  while (expression.startsWith("(")) {
    const stack: string[] = [];
    let closesAt = -1;
    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index]!;
      if (character === "(" || character === "[" || character === "{") {
        stack.push(character);
        continue;
      }
      if (character !== ")" && character !== "]" && character !== "}") continue;
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) {
        closesAt = index;
        break;
      }
    }
    if (closesAt !== expression.length - 1) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function directConstructorName(source: string) {
  const expression = unwrapDirectParenthesizedExpression(source);
  return expression?.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
}

function bracketContinuedStatementCode(
  lines: ReturnType<typeof analyzePythonSource>["lines"],
  startIndex: number,
  endIndexExclusive: number,
) {
  const parts: string[] = [];
  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    const line = lines[index];
    if (
      !line ||
      line.continuedFromPrevious ||
      line.continuesToNext ||
      /\\\s*$/.test(line.code) ||
      (index > startIndex && line.bracketDepthBefore === 0)
    ) {
      return null;
    }
    parts.push(line.code);
    if (line.bracketDepthAfter === 0) return parts.join("\n");
  }
  return null;
}

/**
 * Builds all byte-exact Python Name-token coordinates once. It also derives a
 * deliberately narrower Studio site set only when every construct binding
 * ordinal can be accounted for by one simple Name assignment. Parenthesized
 * continuations are treated as one logical statement; explicit backslash
 * continuations and every other ambiguous binding form still fail closed.
 * Claims then perform bounded O(1) lookups rather than rescanning source.
 */
function buildSourceBindingLookup(
  sourceText: string,
  analysis: ReturnType<typeof analyzePythonSource>,
  sourceBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  snapshotVersion: ExpectedFastManimSnapshotCorrelationV1["snapshotVersion"],
) {
  const sourceLines = sourceText.split(/\r?\n/);
  const tokens = new Set<string>();
  const studioCandidates = new Set<string>();
  const studioConstructors = new Map<string, string>();
  const identifierPattern = /(?:_|\p{ID_Start})(?:_|\p{ID_Continue})*/gu;
  for (const [lineIndex, line] of analysis.lines.entries()) {
    identifierPattern.lastIndex = 0;
    for (let match = identifierPattern.exec(line.code); match; match = identifierPattern.exec(line.code)) {
      const name = match[0];
      const raw = sourceLines[lineIndex] ?? "";
      const startColumn = Buffer.byteLength(raw.slice(0, match.index), "utf8");
      const endColumn = startColumn + Buffer.byteLength(name, "utf8");
      tokens.add(
        sourceTokenKey({
          name,
          span: { endColumn, endLine: lineIndex + 1, startColumn, startLine: lineIndex + 1 },
        }),
      );
    }
  }

  let bindingOrdinal = 0;
  let proofComplete = sourceBlock.bodyIndent !== null;
  for (let lineIndex = sourceBlock.bodyStart; lineIndex < sourceBlock.bodyEnd; lineIndex += 1) {
    const line = analysis.lines[lineIndex];
    if (!line || !isPythonStatementStart(line)) continue;
    let code = line.code;
    if (snapshotVersion === 6 || snapshotVersion === 7 || snapshotVersion === 8) {
      const continuedCode = bracketContinuedStatementCode(analysis.lines, lineIndex, sourceBlock.bodyEnd);
      if (continuedCode === null) {
        proofComplete = false;
        continue;
      }
      code = continuedCode;
    }
    if (
      /:=/.test(code) ||
      /^\s*(?:_|\p{ID_Start})(?:_|\p{ID_Continue})*\s*(?::|(?:\*\*|\/\/|<<|>>|[+\-*/%@&|^])=)/u.test(code) ||
      /^\s*(?:(?:async\s+)?(?:def|class|for|with)\b|(?:del|global|import|match|nonlocal)\b|from\s+\S+\s+import\b|except\b)/.test(
        code,
      )
    ) {
      proofComplete = false;
      continue;
    }
    const assignments = topLevelAssignmentOperators(code);
    if (assignments === 0) continue;
    const direct = code.match(/^\s*((?:_|\p{ID_Start})(?:_|\p{ID_Continue})*)\s*=(?!=)/u);
    if (
      assignments !== 1 ||
      !direct ||
      (snapshotVersion !== 6 &&
        snapshotVersion !== 7 &&
        snapshotVersion !== 8 &&
        (line.bracketDepthAfter !== 0 || line.continuesToNext || line.continuedFromPrevious))
    ) {
      proofComplete = false;
      continue;
    }
    bindingOrdinal += 1;
    const name = direct[1]!;
    const constructor = directConstructorName(code.slice(direct[0].length));
    if (
      line.indentation !== sourceBlock.bodyIndent ||
      constructor === undefined ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !studioSupportsConstructor(constructor, snapshotVersion)
    ) {
      continue;
    }
    const raw = sourceLines[lineIndex] ?? "";
    const nameIndex = code.indexOf(name);
    const startColumn = Buffer.byteLength(raw.slice(0, nameIndex), "utf8");
    const span = {
      endColumn: startColumn + Buffer.byteLength(name, "utf8"),
      endLine: lineIndex + 1,
      startColumn,
      startLine: lineIndex + 1,
    };
    const key = sourceBindingKey({ name, ordinal: bindingOrdinal, span });
    studioCandidates.add(key);
    studioConstructors.set(key, constructor);
  }
  return {
    constructors: proofComplete ? studioConstructors : new Map<string, string>(),
    studioSites: proofComplete ? studioCandidates : new Set<string>(),
    tokens,
  } satisfies SourceBindingLookup;
}

function parseBinding(
  value: unknown,
  sourceBindings: SourceBindingLookup,
  sourceHash: string,
  sceneId: string,
): Readonly<{ binding: SourceBindingV1; constructor: string | null; studioSupported: boolean }> {
  requireIdentity(
    isPlainObject(value) && exactFields(value, ["id", "name", "ordinal", "span"]),
    "A source binding has unsupported fields.",
  );
  const name = boundedString(value.name, MAX_IDENTITY_STRING_BYTES, "binding.name");
  requireIdentity(PYTHON_IDENTIFIER.test(name), "A source binding name is not a Python identifier.");
  const ordinal = safeInteger(value.ordinal, 1, MAX_BINDING_CLAIMS, "binding.ordinal");
  const spanValue = value.span;
  requireIdentity(
    isPlainObject(spanValue) && exactFields(spanValue, ["endColumn", "endLine", "startColumn", "startLine"]),
    "A source binding span has unsupported fields.",
  );
  const span = {
    endColumn: safeInteger(spanValue.endColumn, 0, Number.MAX_SAFE_INTEGER, "binding.span.endColumn"),
    endLine: safeInteger(spanValue.endLine, 1, Number.MAX_SAFE_INTEGER, "binding.span.endLine"),
    startColumn: safeInteger(spanValue.startColumn, 0, Number.MAX_SAFE_INTEGER, "binding.span.startColumn"),
    startLine: safeInteger(spanValue.startLine, 1, Number.MAX_SAFE_INTEGER, "binding.span.startLine"),
  };
  const id = boundedString(value.id, MAX_IDENTITY_STRING_BYTES, "binding.id");
  requireIdentity(
    /^source-binding:[0-9a-f]{64}$/.test(id) && id === bindingIdentifier(sourceHash, sceneId, { name, ordinal, span }),
    "A source binding identifier cannot be re-derived from its correlated source claim.",
  );
  const binding = { id, name, ordinal, span };
  requireIdentity(
    sourceBindings.tokens.has(sourceTokenKey(binding)),
    "A source binding span is not one exact Python Name token.",
  );
  const key = sourceBindingKey(binding);
  return {
    binding,
    constructor: sourceBindings.constructors.get(key) ?? null,
    studioSupported: sourceBindings.studioSites.has(key),
  };
}

function compareFamilyMembership(
  left: Readonly<{ familyPath: readonly number[]; sceneOrder: number }>,
  right: Readonly<{ familyPath: readonly number[]; sceneOrder: number }>,
) {
  if (left.sceneOrder !== right.sceneOrder) return left.sceneOrder - right.sceneOrder;
  const common = Math.min(left.familyPath.length, right.familyPath.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left.familyPath[index]! - right.familyPath[index]!;
    if (difference !== 0) return difference;
  }
  return left.familyPath.length - right.familyPath.length;
}

function validateIssues(value: unknown, complete: boolean) {
  requireIdentity(Array.isArray(value) && value.length <= 64, "Identity issues are unbounded.");
  requireIdentity(complete ? value.length === 0 : value.length > 0, "Identity issue presence does not match its kind.");
  let overflowIssue = false;
  for (const issue of value) {
    requireIdentity(
      isPlainObject(issue) && exactFields(issue, ["code", "evidence", "message"]),
      "An identity issue has unsupported fields.",
    );
    const code = boundedString(issue.code, MAX_IDENTITY_STRING_BYTES, "issue.code");
    requireIdentity(ISSUE_CODES.has(code), "An identity issue code is unknown.");
    const message = boundedString(issue.message, MAX_BOUND_STRING_BYTES, "issue.message");
    requireIdentity(
      Array.isArray(issue.evidence) && issue.evidence.length <= 64,
      "Identity issue evidence is unbounded.",
    );
    for (const entry of issue.evidence) boundedString(entry, MAX_BOUND_STRING_BYTES, "issue.evidence");
    if (
      code === "identity-evidence-incomplete" &&
      message === "Source identity evidence exceeded its closed structural bounds." &&
      issue.evidence.length === 0
    ) {
      overflowIssue = true;
    }
  }
  return overflowIssue;
}

function freezeVerifiedMap(map: VerifiedSourceRuntimeIdentityMapV1): VerifiedSourceRuntimeIdentityMapV1 {
  const owned: VerifiedSourceRuntimeIdentityMapV1 = {
    ...map,
    mappings: map.mappings.map((mapping) => ({
      ...mapping,
      binding: { ...mapping.binding, span: { ...mapping.binding.span } },
      familyPath: [...mapping.familyPath],
    })),
  };
  for (const mapping of owned.mappings) {
    Object.freeze(mapping.binding.span);
    Object.freeze(mapping.binding);
    Object.freeze(mapping.familyPath);
    Object.freeze(mapping);
  }
  Object.freeze(owned.mappings);
  Object.freeze(owned);
  return owned;
}

/** Copies validated wire data into an immutable server-owned identity map. */
export function parseServerOwnedSourceRuntimeIdentityMapV1(value: unknown): VerifiedSourceRuntimeIdentityMapV1 {
  const parsed = verifiedSourceRuntimeIdentityMapV1Schema.safeParse(value);
  if (!parsed.success) identityError("A source/runtime identity map is malformed.", parsed.error);
  return freezeVerifiedMap(parsed.data);
}

function validatePublishedMap(
  value: unknown,
  snapshot: VerifiedCompiledFastManimSnapshotResultV1,
): VerifiedSourceRuntimeIdentityMapV1 {
  const map = parseServerOwnedSourceRuntimeIdentityMapV1(value);
  requireIdentity(map.sceneId === snapshot.sceneId, "The source/runtime identity map has a stale Scene ID.");
  requireIdentity(map.sourceHash === snapshot.sourceHash, "The source/runtime identity map has a stale source hash.");
  requireIdentity(
    map.runtimeConfigHash === snapshot.runtimeConfigHash,
    "The source/runtime identity map has a stale runtime configuration.",
  );
  requireIdentity(
    map.snapshotHash === snapshot.snapshotHash,
    "The source/runtime identity map has a stale snapshot seal.",
  );
  const entities = new Map(snapshot.bundle.scene.entities.map((entity) => [entity.id, entity]));
  const names = new Set<string>();
  const bindings = new Set<string>();
  const entityIds = new Set<string>();
  for (const mapping of map.mappings) {
    const entity = entities.get(mapping.entityId);
    requireIdentity(
      entity !== undefined && entity.provenanceId === mapping.provenanceId && mapping.familyPath.length === 0,
      "A source/runtime mapping does not name one exact snapshot entity.",
    );
    requireIdentity(!names.has(mapping.binding.name), "One source name appears in several published mappings.");
    requireIdentity(!bindings.has(mapping.binding.id), "One source binding appears in several published mappings.");
    requireIdentity(!entityIds.has(mapping.entityId), "One runtime entity appears in several published mappings.");
    names.add(mapping.binding.name);
    bindings.add(mapping.binding.id);
    entityIds.add(mapping.entityId);
  }
  const source = snapshot.bundle.scene.source;
  if (
    source?.kind === "imported-manim-server-snapshot" &&
    (source.snapshotVersion === 7 || source.snapshotVersion === 8)
  ) {
    requireIdentity(
      entityIds.size === entities.size,
      "Snapshot profiles V7 and V8 require one verified source/runtime mapping for every Scene entity.",
    );
  }
  return map;
}

/** Revalidates a previously server-produced browser-safe map on publication reads. */
export function parseVerifiedSourceRuntimeIdentityMapV1(
  value: unknown,
  snapshot: VerifiedCompiledFastManimSnapshotResultV1,
) {
  return validatePublishedMap(value, snapshot);
}

/** Enforces profile-level identity publication requirements after snapshot sealing and on every durable read. */
export function assertFastManimSnapshotIdentityAuthorityV1(
  snapshot: VerifiedFastManimSnapshotResultV1,
  identity: VerifiedSourceRuntimeIdentityMapV1 | null,
) {
  if (
    snapshot.kind !== "compiled" ||
    snapshot.bundle.scene.source.kind !== "imported-manim-server-snapshot" ||
    (snapshot.bundle.scene.source.snapshotVersion !== 7 && snapshot.bundle.scene.source.snapshotVersion !== 8)
  ) {
    return;
  }
  requireIdentity(
    identity !== null,
    "Snapshot profiles V7 and V8 require complete source/runtime identity evidence before publication.",
  );
  validatePublishedMap(identity, snapshot);
}

/**
 * Strict same-run identity verification. This must be called only after the
 * paired embedded snapshot has passed the existing Snapshot/Scene IR verifier.
 */
export function verifyFastManimSourceRuntimeIdentityV1(
  parsed: NonNullable<ParsedFastManimProducerDocumentV1["combined"]>,
  input: Readonly<{
    expected: ExpectedFastManimSnapshotCorrelationV1;
    snapshot: VerifiedFastManimSnapshotResultV1;
    sourceText: string;
  }>,
): VerifiedSourceRuntimeIdentityMapV1 | null {
  const { document } = parsed;
  requireIdentity(
    document.snapshotDigest === parsed.snapshotDigest,
    "snapshotDigest does not pair the embedded snapshot bytes.",
  );
  const evidence = document.evidence;
  requireIdentity(
    isPlainObject(evidence) && exactFields(evidence, EVIDENCE_FIELDS),
    "Identity evidence has unsupported fields.",
  );
  for (const [field, expected] of [
    ["projectId", input.expected.projectId],
    ["requestId", input.expected.requestId],
    ["runtimeConfigHash", input.expected.runtimeConfigHash],
    ["sceneId", input.expected.sceneId],
    ["sceneName", input.expected.sceneName],
    ["sourceHash", input.expected.sourceHash],
    ["sourcePath", input.expected.sourcePath],
  ] as const) {
    requireIdentity(evidence[field] === expected, `Identity evidence has stale ${field} correlation.`);
  }
  requireIdentity(
    evidence.snapshotDigest === parsed.snapshotDigest,
    "Identity evidence is not paired with its snapshot.",
  );
  const complete = evidence.kind === "complete";
  requireIdentity(complete || evidence.kind === "unsupported", "The identity evidence kind is unsupported.");
  requireIdentity(
    input.snapshot.kind === "compiled" || !complete,
    "An unsupported snapshot cannot carry complete identity evidence.",
  );
  const overflowIssue = validateIssues(evidence.issues, complete);
  const records = evidence.records;
  requireIdentity(
    Array.isArray(records) && records.length <= MAX_ENTITIES,
    "Identity records exceed the entity bound.",
  );
  if (input.expected.snapshotVersion === 8 && input.snapshot.kind === "compiled") {
    requireIdentity(
      complete && records.length === 1,
      "SquareToCircle profile V8 requires one complete runtime identity record.",
    );
  }
  const sourceAnalysis = analyzePythonSource(input.sourceText);
  requireIdentity(sourceAnalysis.valid, "The correlated source cannot be lexically verified.");
  let sourceBlock: ReturnType<typeof findSourceSceneBlock>;
  try {
    sourceBlock = findSourceSceneBlock(input.sourceText, input.expected.sceneName, input.expected.sourcePath);
  } catch (cause) {
    identityError("The selected source Scene cannot be identified unambiguously.", cause);
  }
  requireIdentity(sourceBlock !== null, "The selected source Scene is missing from its correlated source.");
  const sourceBindings = buildSourceBindingLookup(
    input.sourceText,
    sourceAnalysis,
    sourceBlock,
    input.expected.snapshotVersion,
  );
  let mixedDynamicMathTexEntityId: string | null = null;
  if (input.expected.snapshotVersion === 7 && input.snapshot.kind === "compiled") {
    const compiledSnapshot = input.snapshot;
    const candidates = compiledSnapshot.bundle.scene.entities.filter((entity) => {
      const evidence = compiledSnapshot.bundle.scene.provenance.find(({ id }) => id === entity.provenanceId)?.evidence;
      return evidence?.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_MATHTEX_PROVENANCE_EVIDENCE_V7;
    });
    requireIdentity(candidates.length === 1, "Mixed dynamic profile V7 has ambiguous MathTex identity authority.");
    mixedDynamicMathTexEntityId = candidates[0]!.id;
  }

  const seenMemberships = new Set<string>();
  const activeBindingNames = new Set<string>();
  const activeBindingOccurrences = new Map<string, number>();
  const activeMappedBindings = new Set<string>();
  const boundSequenceNames = new Map<number, string>();
  const normalReleaseSequenceNames = new Map<number, string>();
  const bindingHistoryByName = new Map<string, Array<readonly [number, number | null]>>();
  const mappings: Array<{
    binding: SourceBindingV1;
    entityId: string;
    familyPath: number[];
    provenanceId: string;
  }> = [];
  let overflowSentinelUsed = false;
  let totalClaims = 0;
  let previousMembership: Readonly<{ familyPath: readonly number[]; sceneOrder: number }> | null = null;

  for (const recordValue of records) {
    requireIdentity(
      isPlainObject(recordValue) && exactFields(recordValue, RECORD_FIELDS),
      "An identity record has unsupported fields.",
    );
    const sceneOrder = safeInteger(recordValue.sceneOrder, 0, MAX_ENTITIES - 1, "record.sceneOrder");
    const entityId = boundedString(recordValue.entityId, MAX_IDENTITY_STRING_BYTES, "record.entityId");
    const provenanceId = boundedString(recordValue.provenanceId, MAX_IDENTITY_STRING_BYTES, "record.provenanceId");
    requireIdentity(
      entityId === `${input.expected.sceneId}/entity:${sceneOrder}`,
      "An identity entity ID is not canonical.",
    );
    requireIdentity(
      provenanceId === `${input.expected.sceneId}/provenance:entity:${sceneOrder}`,
      "An identity provenance ID is not canonical.",
    );
    requireIdentity(
      Array.isArray(recordValue.familyPath) && recordValue.familyPath.length <= MAX_FAMILY_PATH_DEPTH,
      "An identity family path exceeds its bound.",
    );
    const familyPath = recordValue.familyPath.map((entry) =>
      safeInteger(entry, 0, MAX_SUBMOBJECTS_PER_PARENT - 1, "record.familyPath"),
    );
    const membership = { familyPath, sceneOrder };
    const membershipKey = JSON.stringify([entityId, familyPath]);
    requireIdentity(!seenMemberships.has(membershipKey), "Duplicate identity membership evidence is forbidden.");
    requireIdentity(
      previousMembership === null || compareFamilyMembership(previousMembership, membership) < 0,
      "Identity records are not in canonical Scene-family order.",
    );
    seenMemberships.add(membershipKey);
    previousMembership = membership;

    const runtimeType = boundedString(recordValue.runtimeType, MAX_IDENTITY_STRING_BYTES, "record.runtimeType");
    requireIdentity(
      !complete || runtimeType !== "unsupported-runtime-type",
      "Complete evidence has an unsupported runtime type.",
    );
    const status = recordValue.status;
    requireIdentity(
      status === "mapped" || status === "unmatched" || status === "ambiguous" || status === "unsupported",
      "An identity record status is unknown.",
    );
    requireIdentity(
      Array.isArray(recordValue.reasons) &&
        recordValue.reasons.length <= 3 &&
        recordValue.reasons.every((reason) => typeof reason === "string" && REASONS.has(reason)),
      "Identity record reasons are unsupported.",
    );
    const reasons = recordValue.reasons as string[];
    requireIdentity(
      Array.isArray(recordValue.lifecycle) && recordValue.lifecycle.length <= 64,
      "Identity lifecycle is unbounded.",
    );
    let lastLifecycleSequence = 0;
    for (const event of recordValue.lifecycle) {
      requireIdentity(
        isPlainObject(event) && exactFields(event, ["action", "sequence"]),
        "An identity lifecycle event has unsupported fields.",
      );
      requireIdentity(
        typeof event.action === "string" && LIFECYCLE_ACTIONS.has(event.action),
        "A lifecycle action is unknown.",
      );
      const sequence = safeInteger(event.sequence, 1, MAX_LIFECYCLE_SEQUENCE, "lifecycle.sequence");
      requireIdentity(sequence > lastLifecycleSequence, "Lifecycle sequences must increase.");
      lastLifecycleSequence = sequence;
    }
    if (input.expected.snapshotVersion === 8) {
      const [added, removed] = recordValue.lifecycle;
      requireIdentity(
        sceneOrder === 0 &&
          familyPath.length === 0 &&
          recordValue.lifecycle.length === 2 &&
          isPlainObject(added) &&
          added.action === "add" &&
          added.sequence === 5 &&
          isPlainObject(removed) &&
          removed.action === "remove" &&
          removed.sequence === 13,
        "SquareToCircle profile V8 requires the exact stable Square add/remove lifecycle.",
      );
    }

    requireIdentity(
      Array.isArray(recordValue.bindings) && recordValue.bindings.length <= MAX_BINDINGS_PER_ENTITY,
      "Source binding history is unbounded.",
    );
    const active: Array<Readonly<{ binding: SourceBindingV1; constructor: string | null; studioSupported: boolean }>> =
      [];
    let lastBoundSequence = 0;
    for (const claim of recordValue.bindings) {
      totalClaims += 1;
      requireIdentity(totalClaims <= MAX_BINDING_CLAIMS, "Identity claims exceed the global bound.");
      requireIdentity(
        isPlainObject(claim) && exactFields(claim, ["binding", "boundSequence", "releasedSequence"]),
        "A source binding claim has unsupported fields.",
      );
      const parsedBinding = parseBinding(
        claim.binding,
        sourceBindings,
        input.expected.sourceHash,
        input.expected.sceneId,
      );
      const { binding } = parsedBinding;
      const bound = safeInteger(claim.boundSequence, 1, MAX_BINDING_OBSERVATIONS, "claim.boundSequence");
      requireIdentity(bound > lastBoundSequence, "Binding sequences must increase within an entity.");
      requireIdentity(!boundSequenceNames.has(bound), "A binding sequence cannot appear more than once.");
      boundSequenceNames.set(bound, binding.name);
      let released: number | null = null;
      if (claim.releasedSequence !== null) {
        released = safeInteger(claim.releasedSequence, bound + 1, OVERFLOW_RELEASE_SEQUENCE, "claim.releasedSequence");
        if (released === OVERFLOW_RELEASE_SEQUENCE) {
          requireIdentity(!complete, "Complete evidence cannot use the overflow release sentinel.");
          overflowSentinelUsed = true;
        } else {
          requireIdentity(!normalReleaseSequenceNames.has(released), "A normal release sequence cannot repeat.");
          normalReleaseSequenceNames.set(released, binding.name);
        }
      }
      const history = bindingHistoryByName.get(binding.name) ?? [];
      history.push([bound, released]);
      bindingHistoryByName.set(binding.name, history);
      lastBoundSequence = bound;
      if (released === null) {
        active.push(parsedBinding);
        requireIdentity(
          !activeBindingNames.has(binding.name),
          "One source name is active on several runtime entities.",
        );
        activeBindingNames.add(binding.name);
        activeBindingOccurrences.set(binding.id, (activeBindingOccurrences.get(binding.id) ?? 0) + 1);
      }
    }

    if (!complete) {
      const expectedReasons = [
        "snapshot-unsupported",
        ...(reasons.includes("duplicate-runtime-reference") ? ["duplicate-runtime-reference"] : []),
        ...(active.length > 1 ? ["multiple-active-source-bindings"] : []),
      ];
      requireIdentity(
        status === "unsupported" && JSON.stringify(reasons) === JSON.stringify(expectedReasons),
        "Unsupported identity evidence exposes a usable or noncanonical status.",
      );
    } else if (status === "mapped") {
      requireIdentity(active.length === 1 && reasons.length === 0, "Mapped evidence must be one-to-one.");
      const activeClaim = active[0]!;
      const { binding } = activeClaim;
      if (input.expected.snapshotVersion === 7 && input.snapshot.kind === "compiled") {
        const mathTexTarget = entityId === mixedDynamicMathTexEntityId;
        const expectedRuntimeType =
          activeClaim.constructor === null
            ? undefined
            : STUDIO_RUNTIME_TYPES_BY_CONSTRUCTOR_V7.get(activeClaim.constructor);
        requireIdentity(
          activeClaim.studioSupported &&
            expectedRuntimeType !== undefined &&
            runtimeType === expectedRuntimeType &&
            (mathTexTarget
              ? activeClaim.constructor === "MathTex"
              : activeClaim.constructor !== null &&
                STUDIO_SUPPORTED_CONSTRUCTORS_V7.has(activeClaim.constructor) &&
                activeClaim.constructor !== "MathTex"),
          "Mixed dynamic profile V7 source constructors do not match their exact verified runtime entity types.",
        );
      }
      if (input.expected.snapshotVersion === 8 && input.snapshot.kind === "compiled") {
        requireIdentity(
          activeClaim.studioSupported &&
            activeClaim.constructor === "Square" &&
            binding.name === "square" &&
            binding.ordinal === 2 &&
            recordValue.bindings.length === 1 &&
            (recordValue.bindings[0] as PlainObject).boundSequence === 2 &&
            (recordValue.bindings[0] as PlainObject).releasedSequence === null &&
            runtimeType === STUDIO_SQUARE_RUNTIME_TYPE_V8,
          "SquareToCircle profile V8 must map only the exact source Square binding to its exact runtime type.",
        );
      }
      requireIdentity(!activeMappedBindings.has(binding.id), "One source binding maps to several runtime entities.");
      activeMappedBindings.add(binding.id);
      if (activeClaim.studioSupported) mappings.push({ binding, entityId, familyPath, provenanceId });
    } else if (status === "unmatched") {
      requireIdentity(
        active.length === 0 && JSON.stringify(reasons) === JSON.stringify(["no-active-source-binding"]),
        "Unmatched evidence must carry no active source claim.",
      );
    } else if (status === "ambiguous") {
      const expectedReasons = [
        ...(reasons.includes("duplicate-runtime-reference") ? ["duplicate-runtime-reference"] : []),
        ...(active.length > 1 ? ["multiple-active-source-bindings"] : []),
      ];
      requireIdentity(
        expectedReasons.length > 0 && JSON.stringify(reasons) === JSON.stringify(expectedReasons),
        "Ambiguous evidence does not exhibit its claimed ambiguity.",
      );
    } else {
      identityError("Complete identity evidence cannot contain unsupported records.");
    }
  }

  for (const [sequence, releaseName] of normalReleaseSequenceNames) {
    const reboundName = boundSequenceNames.get(sequence);
    requireIdentity(
      reboundName === undefined || reboundName === releaseName,
      "A release shares a binding sequence with a different source name.",
    );
  }
  for (const history of bindingHistoryByName.values()) {
    const ordered = history.toSorted(([left], [right]) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const priorRelease = ordered[index - 1]![1];
      const nextBound = ordered[index]![0];
      requireIdentity(priorRelease !== null, "A source name was rebound while its prior claim remained active.");
      requireIdentity(priorRelease <= nextBound, "A source name was released after its next binding.");
    }
  }
  requireIdentity(!overflowSentinelUsed || overflowIssue, "The overflow release sentinel lacks its canonical issue.");
  for (const binding of activeMappedBindings) {
    requireIdentity(
      activeBindingOccurrences.get(binding) === 1,
      "A mapped source binding also appears on another runtime entity.",
    );
  }

  if (
    (input.expected.snapshotVersion === 7 || input.expected.snapshotVersion === 8) &&
    input.snapshot.kind === "compiled"
  ) {
    requireIdentity(complete, "Snapshot profiles V7 and V8 require complete source/runtime identity evidence.");
  }
  if (!complete) return null;
  requireIdentity(input.snapshot.kind === "compiled", "Complete identity evidence requires a compiled snapshot.");
  const snapshotEntities = input.snapshot.bundle.scene.entities;
  requireIdentity(
    records.length === snapshotEntities.length,
    "Complete identity evidence is missing snapshot entity records.",
  );
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as PlainObject;
    const entity = snapshotEntities[index]!;
    requireIdentity(
      Array.isArray(record.familyPath) &&
        record.familyPath.length === 0 &&
        record.entityId === entity.id &&
        record.provenanceId === entity.provenanceId,
      "Complete identity evidence does not correspond one-to-one with snapshot provenance.",
    );
  }
  if (input.expected.snapshotVersion === 5) {
    const record = records[0];
    requireIdentity(
      records.length === 1 &&
        isPlainObject(record) &&
        record.status === "ambiguous" &&
        Array.isArray(record.reasons) &&
        JSON.stringify(record.reasons) === JSON.stringify(["multiple-active-source-bindings"]) &&
        mappings.length === 0,
      "Hermetic MathTex morph V5 identity must remain one explicitly ambiguous display-only render track.",
    );
  }
  if (input.expected.snapshotVersion === 8) {
    requireIdentity(
      mappings.length === 1 && mappings[0]?.binding.name === "square",
      "SquareToCircle profile V8 must publish exactly one verified Square mapping.",
    );
  }
  const map = {
    mappings,
    runtimeConfigHash: input.expected.runtimeConfigHash,
    sceneId: input.expected.sceneId,
    schema: STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1,
    snapshotDigest: parsed.snapshotDigest,
    snapshotHash: input.snapshot.snapshotHash,
    sourceHash: input.expected.sourceHash,
    version: 1,
  } satisfies VerifiedSourceRuntimeIdentityMapV1;
  return validatePublishedMap(map, input.snapshot);
}
