import { createHash } from "node:crypto";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
} from "../src/engine/source-runtime-identity";
import {
  FastManimSnapshotContractError,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

const MAX_IDENTITY_JSON_BYTES = 2 * 1024 * 1024;
const COMBINED_FIELDS = ["evidence", "schema", "snapshotDigest", "snapshotJson", "version"] as const;
type PlainObject = Record<string, unknown>;

export type ParsedFastManimProducerDocumentV1 = Readonly<{
  combined: null | Readonly<{
    document: PlainObject;
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

function resultTooLarge(): never {
  throw new FastManimSnapshotContractError(
    "result-too-large",
    `Fast-manim producer results accept at most ${MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES} encoded bytes.`,
  );
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

/**
 * Splits the current fast-manim `snapshotJson` envelope without rescanning the
 * nested snapshot. Legacy snapshot-only producers remain accepted unchanged;
 * the strict snapshot verifier applies their smaller result budget afterward.
 */
export function parseFastManimProducerDocumentV1(value: string | Uint8Array): ParsedFastManimProducerDocumentV1 {
  const encodedBytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (encodedBytes > MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES) resultTooLarge();

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

  requireIdentity(
    exactFields(document, COMBINED_FIELDS),
    "The combined identity result must contain exactly the current v1 fields.",
  );
  requireIdentity(
    document.version === FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
    "The combined identity result version is unsupported.",
  );
  requireIdentity(typeof document.snapshotJson === "string", "snapshotJson must be a JSON string.");
  requireIdentity(
    Buffer.byteLength(document.snapshotJson, "utf8") <= MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
    "snapshotJson exceeds its decoded byte bound.",
  );

  // fast-manim emits one exact canonical JSON document and the CLI may append
  // one LF. Re-canonicalization is now safe because the snapshot's floating
  // point JSON is an opaque string rather than a nested object.
  const canonicalText = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (Buffer.byteLength(canonicalText, "utf8") > MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES - 1) {
    resultTooLarge();
  }
  try {
    requireIdentity(
      canonicalJsonV1(document) === canonicalText,
      "The raw combined identity result must be exact canonical JSON with at most one trailing LF.",
    );
    requireIdentity(
      Buffer.byteLength(canonicalJsonV1(document.evidence), "utf8") <= MAX_IDENTITY_JSON_BYTES,
      "Identity evidence exceeds its encoded byte bound.",
    );
  } catch (cause) {
    if (cause instanceof FastManimSnapshotContractError) throw cause;
    identityError("The combined identity result is not bounded canonical JSON.", cause);
  }

  const snapshotDigest = createHash("sha256").update(document.snapshotJson, "utf8").digest("hex");
  return { combined: { document, snapshotDigest }, snapshotJson: document.snapshotJson };
}
