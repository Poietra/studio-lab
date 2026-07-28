import { createHash } from "node:crypto";

import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
} from "../src/engine/source-runtime-identity";
import {
  FastManimSnapshotContractError,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

const MAX_IDENTITY_JSON_BYTES = 2 * 1024 * 1024;
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

function requireIdentity(condition: unknown, message: string): asserts condition {
  if (!condition) identityError(message);
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: PlainObject, fields: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
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
        requireIdentity(
          frame.previousKey === null || frame.previousKey < key,
          "Producer object keys must be sorted and unique.",
        );
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
 * extracts the exact embedded snapshot bytes. The snapshot is still untrusted:
 * callers must run the existing strict snapshot/Scene IR verifier first.
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
  // Legacy snapshot results predate wire canonicalization. Only the opt-in
  // combined document is held to this exact-byte pairing contract.
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
    slices.size === 5 &&
      ["evidence", "schema", "snapshot", "snapshotDigest", "version"].every((key) => slices.has(key)),
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
