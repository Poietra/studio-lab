import { createHash } from "node:crypto";

import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
  STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1,
  type SourceBindingV1,
  type VerifiedSourceRuntimeIdentityMapV1,
  verifiedSourceRuntimeIdentityMapV1Schema,
} from "../src/engine/source-runtime-identity";
import { findSourceSceneBlock } from "../src/render-pipeline/source-import";
import { analyzePythonSource, isPythonStatementStart } from "../src/render-pipeline/python-source-analysis";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  FastManimSnapshotContractError,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedFastManimSnapshotResultV1,
} from "./fast-manim-snapshot-contract";

const MAX_IDENTITY_JSON_BYTES = 2 * 1024 * 1024;
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

export type ParsedFastManimProducerDocumentV1 = Readonly<{
  combined: null | Readonly<{
    document: PlainObject;
    evidenceEncodedBytes: number;
    snapshotDigest: string;
  }>;
  snapshotJson: string;
}>;

function identityError(message: string, cause?: unknown): never {
  throw new FastManimSnapshotContractError(
    "identity-evidence-invalid",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function malformedResult(message: string, cause?: unknown): never {
  throw new FastManimSnapshotContractError("result-malformed", message, cause === undefined ? undefined : { cause });
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

function scanStringEnd(text: string, start: number) {
  requireIdentity(text[start] === '"', "The combined identity envelope contains a malformed JSON key.");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  identityError("The combined identity envelope contains an unterminated JSON string.");
}

function scanValueEnd(text: string, start: number) {
  const first = text[start];
  if (first === '"') return scanStringEnd(text, start);
  if (first === "{" || first === "[") {
    const stack = [first];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        requireIdentity(
          (opening === "{" && character === "}") || (opening === "[" && character === "]"),
          "The combined identity envelope contains mismatched JSON containers.",
        );
        if (stack.length === 0) return index + 1;
      }
    }
    identityError("The combined identity envelope contains an unterminated JSON value.");
  }
  let index = start;
  while (index < text.length && !/[\s,}]/.test(text[index] ?? "")) index += 1;
  requireIdentity(index > start, "The combined identity envelope contains an empty JSON value.");
  return index;
}

function skipWhitespace(text: string, start: number) {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

/**
 * Enforces the canonical producer structure without reserializing Python
 * floats through JavaScript: no string-external whitespace, sorted unique
 * closed-contract object keys at every depth, and at most one trailing LF.
 */
function assertCanonicalProducerJson(text: string) {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  requireIdentity(body.length > 0 && !body.endsWith("\r"), "The producer JSON has a noncanonical line ending.");
  type Frame =
    | { allowEnd: boolean; kind: "array"; state: "comma-or-end" | "value" }
    | {
        allowEnd: boolean;
        kind: "object";
        previousKey: string | null;
        state: "colon" | "comma-or-end" | "key" | "value";
      };
  const stack: Frame[] = [];
  let cursor = 0;
  let rootComplete = false;
  const completeValue = () => {
    const parent = stack.at(-1);
    if (!parent) {
      rootComplete = true;
      return;
    }
    requireIdentity(parent.state === "value", "The producer JSON contains a value in an invalid position.");
    parent.state = "comma-or-end";
  };
  const closeContainer = () => {
    stack.pop();
    completeValue();
  };
  const beginValue = () => {
    const first = body[cursor];
    if (first === '"') {
      cursor = scanStringEnd(body, cursor);
      completeValue();
      return;
    }
    if (first === "{") {
      cursor += 1;
      stack.push({ allowEnd: true, kind: "object", previousKey: null, state: "key" });
      requireIdentity(stack.length <= 64, "The combined producer JSON is nested too deeply.");
      return;
    }
    if (first === "[") {
      cursor += 1;
      stack.push({ allowEnd: true, kind: "array", state: "value" });
      requireIdentity(stack.length <= 64, "The combined producer JSON is nested too deeply.");
      return;
    }
    if (body.startsWith("true", cursor)) cursor += 4;
    else if (body.startsWith("false", cursor)) cursor += 5;
    else if (body.startsWith("null", cursor)) cursor += 4;
    else {
      numberPattern.lastIndex = cursor;
      const number = numberPattern.exec(body)?.[0];
      requireIdentity(number !== undefined, "The producer JSON contains a malformed value.");
      cursor = numberPattern.lastIndex;
    }
    completeValue();
  };

  beginValue();
  while (!rootComplete) {
    const frame = stack.at(-1);
    requireIdentity(frame !== undefined, "The producer JSON ended before its root value completed.");
    if (frame.kind === "object") {
      if (frame.state === "key") {
        if (body[cursor] === "}" && frame.allowEnd) {
          cursor += 1;
          closeContainer();
          continue;
        }
        requireIdentity(body[cursor] === '"', "A canonical producer object key must be a string.");
        const start = cursor;
        cursor = scanStringEnd(body, cursor);
        const raw = body.slice(start, cursor);
        const key = JSON.parse(raw) as unknown;
        requireIdentity(
          typeof key === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(key) && JSON.stringify(key) === raw,
          "A producer object key is outside the canonical closed contract.",
        );
        requireIdentity(frame.previousKey === null || frame.previousKey < key, "Producer object keys must be sorted and unique.");
        frame.previousKey = key;
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        requireIdentity(body[cursor] === ":", "Canonical producer JSON cannot contain separator whitespace.");
        cursor += 1;
        frame.state = "value";
        continue;
      }
    }
    if (frame.state === "value") {
      if (frame.kind === "array" && body[cursor] === "]" && frame.allowEnd) {
        cursor += 1;
        closeContainer();
      } else beginValue();
      continue;
    }
    const closing = frame.kind === "object" ? "}" : "]";
    if (body[cursor] === closing) {
      cursor += 1;
      closeContainer();
      continue;
    }
    requireIdentity(body[cursor] === ",", "Canonical producer JSON has malformed container separation.");
    cursor += 1;
    frame.allowEnd = false;
    frame.state = frame.kind === "object" ? "key" : "value";
  }
  requireIdentity(
    stack.length === 0 && cursor === body.length,
    "The producer result is not one canonical JSON document with an optional LF.",
  );
}

function topLevelPropertySlices(text: string) {
  const slices = new Map<string, Readonly<{ end: number; start: number }>>();
  let cursor = skipWhitespace(text, 0);
  requireIdentity(text[cursor] === "{", "The combined identity result must be a JSON object.");
  cursor = skipWhitespace(text, cursor + 1);
  while (text[cursor] !== "}") {
    const keyStart = cursor;
    const keyEnd = scanStringEnd(text, keyStart);
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch (cause) {
      identityError("The combined identity envelope contains a malformed JSON key.", cause);
    }
    requireIdentity(typeof key === "string" && !slices.has(key), "Combined identity fields must be unique.");
    cursor = skipWhitespace(text, keyEnd);
    requireIdentity(text[cursor] === ":", "A combined identity field is missing its JSON separator.");
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = scanValueEnd(text, valueStart);
    slices.set(key, { end: valueEnd, start: valueStart });
    cursor = skipWhitespace(text, valueEnd);
    if (text[cursor] === ",") {
      cursor = skipWhitespace(text, cursor + 1);
      continue;
    }
    requireIdentity(text[cursor] === "}", "The combined identity envelope contains malformed field separation.");
  }
  cursor = skipWhitespace(text, cursor + 1);
  requireIdentity(cursor === text.length, "The combined identity envelope contains trailing non-whitespace data.");
  return slices;
}

/**
 * Decodes one bounded producer document and, for the opt-in combined schema,
 * extracts the exact embedded snapshot bytes. The snapshot is still untrusted
 * here: callers must run the existing strict snapshot/Scene IR verifier before
 * invoking the identity verifier below.
 */
export function parseFastManimProducerDocumentV1(value: string | Uint8Array): ParsedFastManimProducerDocumentV1 {
  const encodedBytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (encodedBytes > MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES) {
    throw new FastManimSnapshotContractError(
      "result-too-large",
      `Fast-manim producer results accept at most ${MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES} encoded bytes.`,
    );
  }
  let text: string;
  try {
    text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    malformedResult("The fast-manim producer result is not UTF-8 JSON.", cause);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    malformedResult("The fast-manim producer result is malformed JSON.", cause);
  }
  if (!isPlainObject(document) || document.schema !== FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1) {
    return { combined: null, snapshotJson: text };
  }
  // The legacy snapshot result predates this wire-level canonicalization
  // contract. Only the new combined producer document opts into it.
  assertCanonicalProducerJson(text);
  requireIdentity(
    exactFields(document, ["evidence", "schema", "snapshot", "snapshotDigest", "version"]),
    "The combined identity result must contain exactly the v1 fields.",
  );
  requireIdentity(
    document.version === FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
    "The combined identity result version is unsupported.",
  );
  const slices = topLevelPropertySlices(text);
  requireIdentity(
    slices.size === 5 && ["evidence", "schema", "snapshot", "snapshotDigest", "version"].every((key) => slices.has(key)),
    "The combined identity wire object must contain exactly the v1 fields.",
  );
  const snapshot = slices.get("snapshot");
  const evidence = slices.get("evidence");
  requireIdentity(snapshot !== undefined && evidence !== undefined, "The combined identity result is incomplete.");
  const evidenceEncodedBytes = Buffer.byteLength(text.slice(evidence.start, evidence.end), "utf8");
  requireIdentity(evidenceEncodedBytes <= MAX_IDENTITY_JSON_BYTES, "Identity evidence exceeds its encoded byte bound.");
  const snapshotJson = text.slice(snapshot.start, snapshot.end);
  const snapshotDigest = createHash("sha256").update(snapshotJson, "utf8").digest("hex");
  return { combined: { document, evidenceEncodedBytes, snapshotDigest }, snapshotJson };
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
  studioSites: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
}>;

const STUDIO_SUPPORTED_CONSTRUCTORS = new Set([
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

/**
 * Builds all byte-exact Python Name-token coordinates once. It also derives a
 * deliberately narrower Studio site set only when every construct binding
 * ordinal can be accounted for by one simple, single-line Name assignment.
 * Claims then perform bounded O(1) lookups rather than rescanning source.
 */
function buildSourceBindingLookup(
  sourceText: string,
  analysis: ReturnType<typeof analyzePythonSource>,
  sourceBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
) {
  const sourceLines = sourceText.split(/\r?\n/);
  const tokens = new Set<string>();
  const studioCandidates = new Set<string>();
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
    const code = line.code;
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
      line.bracketDepthAfter !== 0 ||
      line.continuesToNext ||
      line.continuedFromPrevious
    ) {
      proofComplete = false;
      continue;
    }
    bindingOrdinal += 1;
    const name = direct[1]!;
    const constructor = code.slice(direct[0].length).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    if (
      line.indentation !== sourceBlock.bodyIndent ||
      constructor === undefined ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !STUDIO_SUPPORTED_CONSTRUCTORS.has(constructor)
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
    studioCandidates.add(sourceBindingKey({ name, ordinal: bindingOrdinal, span }));
  }
  return { studioSites: proofComplete ? studioCandidates : new Set<string>(), tokens } satisfies SourceBindingLookup;
}

function parseBinding(
  value: unknown,
  sourceBindings: SourceBindingLookup,
  sourceHash: string,
  sceneId: string,
): Readonly<{ binding: SourceBindingV1; studioSupported: boolean }> {
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
  requireIdentity(sourceBindings.tokens.has(sourceTokenKey(binding)), "A source binding span is not one exact Python Name token.");
  return {
    binding,
    studioSupported: sourceBindings.studioSites.has(sourceBindingKey(binding)),
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
    requireIdentity(Array.isArray(issue.evidence) && issue.evidence.length <= 64, "Identity issue evidence is unbounded.");
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
  requireIdentity(map.snapshotHash === snapshot.snapshotHash, "The source/runtime identity map has a stale snapshot seal.");
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
  return map;
}

/** Revalidates a previously server-produced browser-safe map on publication reads. */
export function parseVerifiedSourceRuntimeIdentityMapV1(
  value: unknown,
  snapshot: VerifiedCompiledFastManimSnapshotResultV1,
) {
  return validatePublishedMap(value, snapshot);
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
  requireIdentity(document.snapshotDigest === parsed.snapshotDigest, "snapshotDigest does not pair the embedded snapshot bytes.");
  const evidence = document.evidence;
  requireIdentity(isPlainObject(evidence) && exactFields(evidence, EVIDENCE_FIELDS), "Identity evidence has unsupported fields.");
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
  requireIdentity(evidence.snapshotDigest === parsed.snapshotDigest, "Identity evidence is not paired with its snapshot.");
  const complete = evidence.kind === "complete";
  requireIdentity(
    complete || evidence.kind === "unsupported",
    "The identity evidence kind is unsupported.",
  );
  requireIdentity(input.snapshot.kind === "compiled" || !complete, "An unsupported snapshot cannot carry complete identity evidence.");
  const overflowIssue = validateIssues(evidence.issues, complete);
  const records = evidence.records;
  requireIdentity(Array.isArray(records) && records.length <= MAX_ENTITIES, "Identity records exceed the entity bound.");
  const sourceAnalysis = analyzePythonSource(input.sourceText);
  requireIdentity(sourceAnalysis.valid, "The correlated source cannot be lexically verified.");
  let sourceBlock: ReturnType<typeof findSourceSceneBlock>;
  try {
    sourceBlock = findSourceSceneBlock(input.sourceText, input.expected.sceneName, input.expected.sourcePath);
  } catch (cause) {
    identityError("The selected source Scene cannot be identified unambiguously.", cause);
  }
  requireIdentity(sourceBlock !== null, "The selected source Scene is missing from its correlated source.");
  const sourceBindings = buildSourceBindingLookup(input.sourceText, sourceAnalysis, sourceBlock);

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
    requireIdentity(entityId === `${input.expected.sceneId}/entity:${sceneOrder}`, "An identity entity ID is not canonical.");
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
    requireIdentity(!complete || runtimeType !== "unsupported-runtime-type", "Complete evidence has an unsupported runtime type.");
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
    requireIdentity(Array.isArray(recordValue.lifecycle) && recordValue.lifecycle.length <= 64, "Identity lifecycle is unbounded.");
    let lastLifecycleSequence = 0;
    for (const event of recordValue.lifecycle) {
      requireIdentity(
        isPlainObject(event) && exactFields(event, ["action", "sequence"]),
        "An identity lifecycle event has unsupported fields.",
      );
      requireIdentity(typeof event.action === "string" && LIFECYCLE_ACTIONS.has(event.action), "A lifecycle action is unknown.");
      const sequence = safeInteger(event.sequence, 1, MAX_LIFECYCLE_SEQUENCE, "lifecycle.sequence");
      requireIdentity(sequence > lastLifecycleSequence, "Lifecycle sequences must increase.");
      lastLifecycleSequence = sequence;
    }

    requireIdentity(
      Array.isArray(recordValue.bindings) && recordValue.bindings.length <= MAX_BINDINGS_PER_ENTITY,
      "Source binding history is unbounded.",
    );
    const active: Array<Readonly<{ binding: SourceBindingV1; studioSupported: boolean }>> = [];
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
        requireIdentity(!activeBindingNames.has(binding.name), "One source name is active on several runtime entities.");
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
