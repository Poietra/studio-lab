import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceV1Schema,
  opaqueIdV1Schema,
  parseVerifiedSceneIrBundleV1,
  type SceneIrBundleV1,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../src/engine/contracts";
import { manimProjectIdSchema, manimSourcePathSchema } from "../src/render-pipeline/contracts";

export const FAST_MANIM_SNAPSHOT_SCHEMA_V1 = "poietra.fast-manim-snapshot-result" as const;
export const ZERO_SHA256 = "0".repeat(64);
export const MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_FAST_MANIM_SNAPSHOT_ISSUES_JSON_BYTES = 256 * 1024;
export const MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES = MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES + 16 * 1024;
export const MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS = 10_000;
export const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH = 64;
export const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES = 25_000;

const MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS = 64;
const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_VALUES = 50_000;

const sceneNameSchema = z
  .string()
  .max(240)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const correlationShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: sceneNameSchema,
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
};

export const expectedFastManimSnapshotCorrelationV1Schema = z.object(correlationShape).strict();

export const fastManimSnapshotIssueCodeV1Schema = z.enum([
  "animation-evidence-incomplete",
  "appearance-evidence-incomplete",
  "asset-evidence-incomplete",
  "camera-evidence-incomplete",
  "geometry-evidence-incomplete",
  "ordering-evidence-incomplete",
  "runtime-semantics-unsupported",
  "source-correlation-incomplete",
]);

const issueSchema = z
  .object({
    code: fastManimSnapshotIssueCodeV1Schema,
    evidence: z.array(evidenceV1Schema).max(64),
    message: evidenceV1Schema,
    runtimeObjectId: sourceIdentityV1Schema.optional(),
  })
  .strict();
const issuesSchema = z
  .array(issueSchema)
  .min(1)
  .max(256)
  .refine((issues) => Buffer.byteLength(JSON.stringify(issues)) <= MAX_FAST_MANIM_SNAPSHOT_ISSUES_JSON_BYTES, {
    message: `Snapshot issues accept at most ${MAX_FAST_MANIM_SNAPSHOT_ISSUES_JSON_BYTES} encoded bytes.`,
  });
const bundleSchema = z.unknown().refine(
  (bundle) => {
    try {
      const json = JSON.stringify(bundle);
      return json !== undefined && Buffer.byteLength(json) <= MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES;
    } catch {
      return false;
    }
  },
  { message: `Snapshot bundles accept at most ${MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES} encoded bytes.` },
);

const resultBaseSchema = z.object({
  ...correlationShape,
  schema: z.literal(FAST_MANIM_SNAPSHOT_SCHEMA_V1),
  version: z.literal(1),
});

export const fastManimSnapshotResultV1Schema = z.discriminatedUnion("kind", [
  resultBaseSchema
    .extend({
      bundle: bundleSchema,
      kind: z.literal("compiled"),
      snapshotHash: sha256V1Schema,
    })
    .strict(),
  resultBaseSchema
    .extend({
      issues: issuesSchema,
      kind: z.literal("unsupported"),
    })
    .strict(),
]);

export type ExpectedFastManimSnapshotCorrelationV1 = z.infer<typeof expectedFastManimSnapshotCorrelationV1Schema>;
export type FastManimSnapshotIssueCodeV1 = z.infer<typeof fastManimSnapshotIssueCodeV1Schema>;
type ParsedFastManimSnapshotResultV1 = z.infer<typeof fastManimSnapshotResultV1Schema>;
export type VerifiedFastManimSnapshotResultV1 =
  | (Omit<Extract<ParsedFastManimSnapshotResultV1, { kind: "compiled" }>, "bundle"> & {
      bundle: SceneIrBundleV1;
    })
  | Extract<ParsedFastManimSnapshotResultV1, { kind: "unsupported" }>;

export type FastManimSnapshotContractErrorCodeV1 =
  | "correlation-mismatch"
  | "provenance-missing"
  | "result-malformed"
  | "result-too-large"
  | "result-too-complex"
  | "snapshot-digest-mismatch"
  | "snapshot-not-sealed"
  | "snapshot-not-unsealed"
  | "snapshot-source-mismatch"
  | "source-kind-mismatch";

export class FastManimSnapshotContractError extends Error {
  readonly code: FastManimSnapshotContractErrorCodeV1;

  constructor(code: FastManimSnapshotContractErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimSnapshotContractError";
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Snapshot canonicalization requires finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Snapshot canonicalization received a non-JSON value.");
}

/**
 * Server-owned snapshot sealing. Producers send the zero digest sentinel and do
 * not need to reproduce JavaScript number serialization.
 */
export function digestFastManimSnapshotBundleV1(bundle: SceneIrBundleV1) {
  if (bundle.scene.source.kind !== "imported-manim-server-snapshot") {
    throw new FastManimSnapshotContractError(
      "source-kind-mismatch",
      "A fast-manim snapshot must use imported-manim-server-snapshot source evidence.",
    );
  }
  const digestInput = {
    ...bundle,
    scene: {
      ...bundle.scene,
      source: { ...bundle.scene.source, snapshotHash: ZERO_SHA256 },
    },
  };
  return createHash("sha256").update(canonicalJson(digestInput)).digest("hex");
}

function assertCorrelation(result: ParsedFastManimSnapshotResultV1, expected: ExpectedFastManimSnapshotCorrelationV1) {
  for (const key of Object.keys(correlationShape) as Array<keyof ExpectedFastManimSnapshotCorrelationV1>) {
    if (result[key] !== expected[key]) {
      throw new FastManimSnapshotContractError(
        "correlation-mismatch",
        `The fast-manim snapshot has stale ${key} correlation.`,
      );
    }
  }
}

function resultStructureError(message: string, cause?: unknown): never {
  throw new FastManimSnapshotContractError("result-too-complex", message, cause === undefined ? undefined : { cause });
}

function assertBoundedPlainJson(value: unknown) {
  const stack: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value }];
  let entries = 0;
  let stringBytes = 0;
  let values = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      values += 1;
      if (values > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_VALUES) {
        resultStructureError("The fast-manim snapshot result contains too many JSON values.");
      }
      if (current.depth > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH) {
        resultStructureError("The fast-manim snapshot result is nested too deeply.");
      }
      const entry = current.value;
      if (typeof entry === "string") {
        stringBytes += Buffer.byteLength(entry, "utf8");
        if (stringBytes > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES) {
          throw new FastManimSnapshotContractError(
            "result-too-large",
            "The fast-manim snapshot result contains too much string data.",
          );
        }
        continue;
      }
      if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
        continue;
      }
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype || Object.getOwnPropertySymbols(entry).length > 0) {
          resultStructureError("The fast-manim snapshot result must contain plain JSON arrays.");
        }
        if (entry.length > MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS) {
          resultStructureError("A fast-manim snapshot JSON array contains too many items.");
        }
        const names = Object.getOwnPropertyNames(entry);
        if (names.length !== entry.length + 1 || !names.includes("length")) {
          resultStructureError("The fast-manim snapshot result must contain dense JSON arrays without properties.");
        }
        entries += entry.length;
        if (entries > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES) {
          resultStructureError("The fast-manim snapshot result contains too many container entries.");
        }
        for (let index = entry.length - 1; index >= 0; index -= 1) {
          if (!Object.hasOwn(entry, index)) {
            resultStructureError("The fast-manim snapshot result must contain dense JSON arrays.");
          }
          stack.push({ depth: current.depth + 1, value: entry[index] });
        }
        continue;
      }
      if (typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype) {
        resultStructureError("The fast-manim snapshot result must contain plain JSON values.");
      }
      const names: string[] = [];
      for (const name in entry) {
        if (!Object.hasOwn(entry, name)) continue;
        names.push(name);
        if (names.length > MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS) {
          resultStructureError("A fast-manim snapshot JSON object contains too many fields.");
        }
      }
      if (Object.getOwnPropertyNames(entry).length !== names.length || Object.getOwnPropertySymbols(entry).length > 0) {
        resultStructureError("The fast-manim snapshot result must not contain hidden or symbol properties.");
      }
      entries += names.length;
      if (entries > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES) {
        resultStructureError("The fast-manim snapshot result contains too many container entries.");
      }
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, names[index]);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          resultStructureError("The fast-manim snapshot result must not contain accessors or hidden fields.");
        }
        stack.push({ depth: current.depth + 1, value: descriptor.value });
      }
    }
  } catch (cause) {
    if (cause instanceof FastManimSnapshotContractError) throw cause;
    resultStructureError("The fast-manim snapshot result could not be inspected safely.", cause);
  }
}

async function parseFastManimSnapshotResultV1(
  value: unknown,
  expectedValue: ExpectedFastManimSnapshotCorrelationV1,
  mode: "producer" | "sealed",
): Promise<VerifiedFastManimSnapshotResultV1> {
  const expected = expectedFastManimSnapshotCorrelationV1Schema.parse(expectedValue);
  assertBoundedPlainJson(value);
  const result = fastManimSnapshotResultV1Schema.parse(value);
  assertCorrelation(result, expected);
  if (result.kind === "unsupported") return result;
  if (mode === "producer" && result.snapshotHash !== ZERO_SHA256) {
    throw new FastManimSnapshotContractError(
      "snapshot-not-unsealed",
      "A fast-manim producer must leave snapshot sealing to the Studio server.",
    );
  }
  if (mode === "sealed" && result.snapshotHash === ZERO_SHA256) {
    throw new FastManimSnapshotContractError(
      "snapshot-not-sealed",
      "A stored fast-manim snapshot must retain its Studio server seal.",
    );
  }

  const bundle = await parseVerifiedSceneIrBundleV1(result.bundle);
  const { source } = bundle.scene;
  if (source.kind !== "imported-manim-server-snapshot") {
    throw new FastManimSnapshotContractError(
      "source-kind-mismatch",
      "A fast-manim snapshot must use imported-manim-server-snapshot source evidence.",
    );
  }
  if (
    bundle.scene.sceneId !== result.sceneId ||
    source.sourceHash !== result.sourceHash ||
    source.runtimeConfigHash !== result.runtimeConfigHash ||
    source.snapshotHash !== result.snapshotHash
  ) {
    throw new FastManimSnapshotContractError(
      "snapshot-source-mismatch",
      "The compiled Scene source evidence does not match its snapshot envelope.",
    );
  }
  if (bundle.scene.provenance.some(({ origin }) => origin !== "fast-manim-server-snapshot")) {
    throw new FastManimSnapshotContractError(
      "provenance-missing",
      "Every provenance record in a compiled fast-manim Scene must originate from its server snapshot.",
    );
  }
  const snapshotHash = digestFastManimSnapshotBundleV1(bundle);
  if (result.snapshotHash !== ZERO_SHA256 && snapshotHash !== result.snapshotHash) {
    throw new FastManimSnapshotContractError(
      "snapshot-digest-mismatch",
      "The compiled fast-manim Scene does not match its canonical snapshot digest.",
    );
  }
  if (mode === "sealed") return { ...result, bundle };

  const sealedBundle = await parseVerifiedSceneIrBundleV1({
    ...bundle,
    scene: { ...bundle.scene, source: { ...source, snapshotHash } },
  });
  return { ...result, bundle: sealedBundle, snapshotHash };
}

function parseProducerJson(value: string | Uint8Array) {
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES) {
    throw new FastManimSnapshotContractError(
      "result-too-large",
      `Fast-manim snapshot results accept at most ${MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES} encoded bytes.`,
    );
  }
  let json: string;
  if (typeof value === "string") {
    json = value;
  } else {
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch (cause) {
      throw new FastManimSnapshotContractError(
        "result-malformed",
        "The fast-manim snapshot result is not UTF-8 JSON.",
        { cause },
      );
    }
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new FastManimSnapshotContractError("result-malformed", "The fast-manim snapshot result is malformed JSON.", {
      cause,
    });
  }
}

/** Bounds raw producer bytes before parsing, requires the zero sentinel, and seals valid bundles server-side. */
export function parseAndSealFastManimSnapshotProducerJsonV1(
  value: string | Uint8Array,
  expected: ExpectedFastManimSnapshotCorrelationV1,
) {
  return parseFastManimSnapshotResultV1(parseProducerJson(value), expected, "producer");
}

/** Revalidates a previously server-sealed result and rejects a zero-hash downgrade. */
export function parseVerifiedFastManimSnapshotResultV1(
  value: unknown,
  expected: ExpectedFastManimSnapshotCorrelationV1,
) {
  return parseFastManimSnapshotResultV1(value, expected, "sealed");
}
