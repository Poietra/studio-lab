import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceV1Schema,
  MAX_COORDINATE,
  opaqueIdV1Schema,
  parseVerifiedSceneIrBundleV1,
  type SceneIrBundleV1,
  sceneCapabilityV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../src/engine/contracts";
import { canonicalFastManimSnapshotBundleJsonV1, canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  type VerifiedSourceRuntimeIdentityMapV1,
  verifiedSourceRuntimeIdentityMapV1Schema,
} from "../src/engine/source-runtime-identity";
import { manimProjectIdSchema, manimSourcePathSchema } from "../src/render-pipeline/contracts";
import { analyzePythonSource, isPythonStatementStart } from "../src/render-pipeline/python-source-analysis";
import { findSourceSceneBlock } from "../src/render-pipeline/source-import";

export const FAST_MANIM_SNAPSHOT_SCHEMA_V1 = "poietra.fast-manim-snapshot-result" as const;
export const FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1 = "poietra.fast-manim-snapshot-producer-request" as const;
export const FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1 = "poietra.fast-manim-snapshot-run" as const;
export const FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1 = "poietra.fast-manim-runtime-config" as const;
export const ZERO_SHA256 = "0".repeat(64);
export const MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_FAST_MANIM_SNAPSHOT_ISSUES_JSON_BYTES = 256 * 1024;
export const MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES = MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES + 16 * 1024;
/**
 * Current fast-manim combined-document cap: a quoted canonical snapshot may
 * double in size, plus 2 MiB of evidence, 64 KiB of envelope, and one CLI LF.
 */
export const MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES =
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES * 2 + 2 * 1024 * 1024 + 64 * 1024 + 1;
export const MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS = 10_000;
export const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH = 64;
export const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES = 25_000;

export const MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS = 64;
export const MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_VALUES = 50_000;
export const MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2 = 3_600;
export const FAST_MANIM_SNAPSHOT_FRAME_RATE_V2 = 60;

export const fastManimSnapshotProfileVersionV1Schema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type FastManimSnapshotProfileVersionV1 = z.infer<typeof fastManimSnapshotProfileVersionV1Schema>;

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

const snapshotFrameSchema = z
  .object({
    height: z.number().finite().positive(),
    width: z.number().finite().positive(),
  })
  .strict();

const hermeticPngV4NumberSchema = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const hermeticPngV4TransformPlanSchema = z
  .object({
    terminalWait: z.number().finite().positive().max(MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2).nullable(),
    transforms: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("move-to"), x: hermeticPngV4NumberSchema, y: hermeticPngV4NumberSchema }).strict(),
          z.object({ factor: hermeticPngV4NumberSchema.positive(), kind: z.literal("scale") }).strict(),
        ]),
      )
      .max(64),
  })
  .strict();

export type HermeticPngV4TransformPlan = z.infer<typeof hermeticPngV4TransformPlanSchema>;

/**
 * The minimal expected boundary the server holds against a result: the wire
 * correlation fields plus the runtime frame the request was issued for, so
 * the compiled camera view can be re-checked server-side against the exact
 * `runtimeConfig.frame` the producer executed under. The frame is server
 * state, never echoed through the producer envelope.
 */
export const expectedFastManimSnapshotCorrelationV1Schema = z
  .object({
    ...correlationShape,
    frame: snapshotFrameSchema,
    // New V4 publications retain this server-derived plan so a sealed result
    // can be revalidated without trusting producer geometry or retaining the
    // complete source blob. Omission is accepted only for legacy centered V4
    // artifacts, whose geometry remains subject to the old exact base rect.
    hermeticPngV4Plan: hermeticPngV4TransformPlanSchema.optional(),
    // Durable V1 publications predate this correlation field. Treat only an
    // omitted stored value as V1; an explicit unsupported value still fails.
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema.default(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshotVersion !== 4 && value.hermeticPngV4Plan !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Hermetic PNG transform evidence is valid only for snapshot profile V4.",
        path: ["hermeticPngV4Plan"],
      });
    }
  });

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

/**
 * The compiled arm on its own: the browser-facing verified publication
 * envelope must reference this schema, never the full result union, so a
 * status:"verified" view can never carry an unsupported result.
 */
export const fastManimSnapshotCompiledResultV1Schema = resultBaseSchema
  .extend({
    bundle: bundleSchema,
    kind: z.literal("compiled"),
    snapshotHash: sha256V1Schema,
  })
  .strict();

export const fastManimSnapshotResultV1Schema = z.discriminatedUnion("kind", [
  fastManimSnapshotCompiledResultV1Schema,
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
export type VerifiedCompiledFastManimSnapshotResultV1 = Extract<
  VerifiedFastManimSnapshotResultV1,
  { kind: "compiled" }
>;

export const fastManimSnapshotContractErrorCodeV1Schema = z.enum([
  "correlation-mismatch",
  "diagnostic-leak",
  "identity-evidence-invalid",
  "profile-violation",
  "provenance-missing",
  "result-malformed",
  "result-too-large",
  "result-too-complex",
  "snapshot-digest-mismatch",
  "snapshot-not-sealed",
  "snapshot-not-unsealed",
  "snapshot-source-mismatch",
  "source-kind-mismatch",
]);
export type FastManimSnapshotContractErrorCodeV1 = z.infer<typeof fastManimSnapshotContractErrorCodeV1Schema>;

export class FastManimSnapshotContractError extends Error {
  readonly code: FastManimSnapshotContractErrorCodeV1;

  constructor(code: FastManimSnapshotContractErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimSnapshotContractError";
    this.code = code;
  }
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
  return createHash("sha256").update(canonicalFastManimSnapshotBundleJsonV1(bundle)).digest("hex");
}

function assertCorrelation(result: ParsedFastManimSnapshotResultV1, expected: ExpectedFastManimSnapshotCorrelationV1) {
  // Only the wire correlation fields appear in the result; `frame` is
  // server-side expected state re-checked separately in the static profile.
  for (const key of Object.keys(correlationShape) as Array<keyof typeof correlationShape>) {
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

/**
 * Server-owned provenance evidence for the v1 static profile. Producer-sent
 * evidence strings never survive normalization, so no producer free text can
 * reach the browser through provenance records.
 */
export const FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1 = "fast-manim server snapshot static profile v1" as const;
export const FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2 =
  "fast-manim server snapshot variable-duration static profile v2" as const;
export const FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V3 =
  "fast-manim server snapshot hermetic MathTex profile v3" as const;
export const FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V4 = "fast-manim server snapshot hermetic PNG profile v4" as const;

export const FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1: Readonly<Record<FastManimSnapshotIssueCodeV1, string>> = {
  "animation-evidence-incomplete": "The Scene animates in ways the static snapshot profile cannot capture.",
  "appearance-evidence-incomplete": "The Scene uses appearance features outside the static snapshot profile.",
  "asset-evidence-incomplete": "The Scene references assets outside the static snapshot profile.",
  "camera-evidence-incomplete": "The Scene uses camera features outside the static snapshot profile.",
  "geometry-evidence-incomplete": "The Scene uses geometry outside the static snapshot profile.",
  "ordering-evidence-incomplete": "The Scene draw ordering cannot be captured by the static snapshot profile.",
  "runtime-semantics-unsupported": "The Scene relies on runtime semantics outside the static snapshot profile.",
  "source-correlation-incomplete": "The Scene cannot be fully correlated with its Python source.",
};

type ParsedUnsupportedIssues = Extract<ParsedFastManimSnapshotResultV1, { kind: "unsupported" }>["issues"];

/**
 * Structural normalization of unsupported diagnostics: only the enum code
 * survives. Messages become server-owned text, free-text evidence is dropped,
 * and producer runtime object identities never reach the browser.
 */
function normalizeUnsupportedIssuesV1(issues: ParsedUnsupportedIssues): ParsedUnsupportedIssues {
  const codes = [...new Set(issues.map((issue) => issue.code))].sort();
  return codes.map((code) => ({ code, evidence: [], message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1[code] }));
}

/**
 * The only unsupported-issue shape the browser wire schema accepts: the enum
 * code, the exact server-owned message for that code, an empty evidence list,
 * and no runtime object identity — sorted and unique by code. Producer free
 * text (host paths, secrets, tracebacks) is rejected by the schema itself, not
 * just by runtime normalization.
 */
const normalizedUnsupportedIssueV1Schema = z
  .object({
    code: fastManimSnapshotIssueCodeV1Schema,
    evidence: z.array(z.string()).max(0),
    message: z.string().min(1).max(500),
  })
  .strict()
  .refine((issue) => issue.message === FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1[issue.code], {
    message: "Unsupported issue messages must be the exact server-owned text for their code.",
  });

export const fastManimSnapshotNormalizedIssuesV1Schema = z
  .array(normalizedUnsupportedIssueV1Schema)
  .min(1)
  .max(fastManimSnapshotIssueCodeV1Schema.options.length)
  .refine((issues) => issues.every((issue, index) => index === 0 || issues[index - 1]!.code < issue.code), {
    message: "Unsupported issue codes must be sorted and unique.",
  });

function profileViolation(message: string): never {
  throw new FastManimSnapshotContractError("profile-violation", message);
}

/**
 * Exact deterministic identifiers of the v1 static profile, derived from the
 * Scene identity and each entity's sceneOrder. The exporter's v1 profile emits
 * exactly these IDs, so the server refuses any other producer-chosen string:
 * a namespaced-but-free suffix (e.g. `${sceneId}/ghp_...`) would otherwise be
 * an exfiltration channel into browser JSON.
 */
export function fastManimSnapshotManifestIdV1(sceneId: string) {
  return `${sceneId}/manifest`;
}

export function fastManimSnapshotSceneProvenanceIdV1(sceneId: string) {
  return `${sceneId}/provenance:scene`;
}

export function fastManimSnapshotEntityProvenanceIdV1(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Entity provenance identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/provenance:entity:${sceneOrder}`;
}

export function fastManimSnapshotEntityIdV1(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Entity identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/entity:${sceneOrder}`;
}

export function fastManimSnapshotPngAssetIdV4(sceneId: string) {
  return `${sceneId}/asset:image:0`;
}

export function fastManimSnapshotOpacityChannelIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Opacity channel identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/channel:opacity:${sceneOrder}`;
}

export function fastManimSnapshotOpacityChannelProvenanceIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Opacity channel provenance identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/provenance:channel:opacity:${sceneOrder}`;
}

export function fastManimSnapshotAffineTransformChannelIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Affine-transform channel identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/channel:affine-transform:${sceneOrder}`;
}

export function fastManimSnapshotAffineTransformChannelProvenanceIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError(
      "Affine-transform channel provenance identifiers derive from a non-negative integer sceneOrder.",
    );
  }
  return `${sceneId}/provenance:channel:affine-transform:${sceneOrder}`;
}

export function fastManimSnapshotMotionPathChannelIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Motion-path channel identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/channel:motion-path:${sceneOrder}`;
}

export function fastManimSnapshotMotionPathChannelProvenanceIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Motion-path channel provenance identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/provenance:channel:motion-path:${sceneOrder}`;
}

export function fastManimSnapshotPathTrimChannelIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Path-trim channel identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/channel:path-trim:${sceneOrder}`;
}

export function fastManimSnapshotPathTrimChannelProvenanceIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Path-trim channel provenance identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/provenance:channel:path-trim:${sceneOrder}`;
}

export function fastManimSnapshotPathMorphChannelIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Path-morph channel identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/channel:path-morph:${sceneOrder}`;
}

export function fastManimSnapshotPathMorphChannelProvenanceIdV2(sceneId: string, sceneOrder: number) {
  if (!Number.isSafeInteger(sceneOrder) || sceneOrder < 0) {
    throw new TypeError("Path-morph channel provenance identifiers derive from a non-negative integer sceneOrder.");
  }
  return `${sceneId}/provenance:channel:path-morph:${sceneOrder}`;
}

/** The exact static Scene duration the v1 exporter emits. */
export const FAST_MANIM_SNAPSHOT_STATIC_DURATION_SECONDS_V1 = 1;

type StaticProfileEntity = SceneIrBundleV1["scene"]["entities"][number];
type StaticProfileVectorAppearance = Extract<StaticProfileEntity["appearance"], { kind: "vector" }>;
type StaticProfileCubicPath = Extract<StaticProfileEntity["geometry"], { kind: "cubic-path" }>["path"];
type StaticProfilePoint = Readonly<{ x: number; y: number }>;
type StaticProfileSegment = Readonly<{
  control1: StaticProfilePoint;
  control2: StaticProfilePoint;
  end: StaticProfilePoint;
}>;

const MAX_STATIC_PROFILE_CLOSED_SEGMENTS = 16;
const MAX_MATHTEX_PROFILE_SUBPATHS_V3 = 512;
const MAX_MATHTEX_PROFILE_CUBIC_SEGMENTS_V3 = 2_048;
const MATHTEX_PROFILE_COORDINATE_QUANTUM_V3 = 0.000_001;
const MATHTEX_PROFILE_FONT_DIGEST_V3 = "d66ac1cc91c55c24d3636ae2df1238076debdff51841f9893fc5419cc2df3df7";
const MATHTEX_PROFILE_TOOLCHAIN_DIGEST_V3 = "95c98e10edff239e6ee237c9eac99dc96c06ba9fc712c30816ddc47d7db12f9e";
const MATHTEX_PROFILE_CONTENT_DIGEST_EVIDENCE_V3 = /^MathTex content digest [0-9a-f]{64}$/;
const HERMETIC_PNG_SCALE_TO_RESOLUTION_V4 = 1_080;
const HERMETIC_PNG_CAPABILITY_EVIDENCE_V4 = "capability png-image: one verified PNG-backed rectangle";
const HERMETIC_PNG_PROFILE_EVIDENCE_V4 = "fast-manim hermetic PNG Scene snapshot profile v4";
const STATIC_PROFILE_RELATIVE_TOLERANCE = 1e-9;
const CANONICAL_LINE_ROUNDOFF_MULTIPLIER_V1 = 64;

function canonicalLineControl(start: StaticProfilePoint, end: StaticProfilePoint, factor: number) {
  return { x: start.x + (end.x - start.x) * factor, y: start.y + (end.y - start.y) * factor };
}

function pointDistance(left: StaticProfilePoint, right: StaticProfilePoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function fastManimPointsEqual2dV2(left: StaticProfilePoint, right: StaticProfilePoint) {
  const isClose = (leftComponent: number, rightComponent: number) =>
    Math.abs(leftComponent - rightComponent) <= 1e-6 + 1e-5 * Math.abs(rightComponent);
  return isClose(left.x, right.x) && isClose(left.y, right.y);
}

function projectionOntoChord(
  point: StaticProfilePoint,
  start: StaticProfilePoint,
  dx: number,
  dy: number,
  lengthSquared: number,
) {
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
}

/** Accepts only the bounded roundoff produced by canonical Cairo Line controls. */
export function isCanonicalFastManimLineSegmentV1(
  start: StaticProfilePoint,
  segment: StaticProfileSegment,
  roundoffScaleFloor = 1,
) {
  const points = [start, segment.control1, segment.control2, segment.end];
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  const dx = segment.end.x - start.x;
  const dy = segment.end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSquared) || lengthSquared === 0) return false;
  const firstProjection = projectionOntoChord(segment.control1, start, dx, dy, lengthSquared);
  const secondProjection = projectionOntoChord(segment.control2, start, dx, dy, lengthSquared);
  if (
    !Number.isFinite(firstProjection) ||
    !Number.isFinite(secondProjection) ||
    firstProjection < 0 ||
    firstProjection > secondProjection ||
    secondProjection > 1
  ) {
    return false;
  }
  const control1 = canonicalLineControl(start, segment.end, 1 / 3);
  const control2 = canonicalLineControl(start, segment.end, 2 / 3);
  const maximumControlError = Math.max(
    pointDistance(segment.control1, control1),
    pointDistance(segment.control2, control2),
  );
  const coordinateScale = Math.max(
    1,
    roundoffScaleFloor,
    ...points.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]),
  );
  return maximumControlError <= coordinateScale * Number.EPSILON * CANONICAL_LINE_ROUNDOFF_MULTIPLIER_V1;
}

function isConvexControlPolygon(pointsInput: readonly StaticProfilePoint[]) {
  const points = pointsInput.filter(
    (point, index) => index === 0 || point.x !== pointsInput[index - 1]!.x || point.y !== pointsInput[index - 1]!.y,
  );
  while (points.length > 1 && points[0]!.x === points.at(-1)!.x && points[0]!.y === points.at(-1)!.y) points.pop();
  if (points.length < 3) return false;
  let scale = 1;
  for (const point of points) scale = Math.max(scale, Math.abs(point.x), Math.abs(point.y));
  const tolerance = STATIC_PROFILE_RELATIVE_TOLERANCE * scale * scale;
  let orientation = 0;
  for (let index = 0; index < points.length; index += 1) {
    const origin = points[index]!;
    const first = points[(index + 1) % points.length]!;
    const second = points[(index + 2) % points.length]!;
    const cross = (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
    if (Math.abs(cross) <= tolerance) continue;
    const sign = Math.sign(cross);
    if (orientation === 0) orientation = sign;
    else if (sign !== orientation) return false;
  }
  return orientation !== 0;
}

type QuadraticCoefficients = Readonly<{ a: number; b: number; c: number }>;

function crossProduct(left: StaticProfilePoint, right: StaticProfilePoint) {
  return left.x * right.y - left.y * right.x;
}

function subtractPoints(left: StaticProfilePoint, right: StaticProfilePoint) {
  return { x: left.x - right.x, y: left.y - right.y };
}

function interpolatedCrossCoefficients(
  leftFirst: StaticProfilePoint,
  leftSecond: StaticProfilePoint,
  rightFirst: StaticProfilePoint,
  rightSecond: StaticProfilePoint,
): QuadraticCoefficients {
  const firstDelta = subtractPoints(rightFirst, leftFirst);
  const secondDelta = subtractPoints(rightSecond, leftSecond);
  return {
    a: crossProduct(firstDelta, secondDelta),
    b: crossProduct(firstDelta, leftSecond) + crossProduct(leftFirst, secondDelta),
    c: crossProduct(leftFirst, leftSecond),
  };
}

function minimumQuadraticOnUnitInterval({ a, b, c }: QuadraticCoefficients) {
  let minimum = Math.min(c, a + b + c);
  if (a > 0) {
    const vertex = -b / (2 * a);
    if (vertex > 0 && vertex < 1) minimum = Math.min(minimum, (a * vertex + b) * vertex + c);
  }
  return minimum;
}

function orientedQuadratic(coefficients: QuadraticCoefficients, orientation: number): QuadraticCoefficients {
  return {
    a: coefficients.a * orientation,
    b: coefficients.b * orientation,
    c: coefficients.c * orientation,
  };
}

function staticProfileControlPoints(path: StaticProfileCubicPath) {
  const subpath = path.subpaths[0]!;
  return [subpath.start, ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
}

function staticProfileBoundaryAnchors(path: StaticProfileCubicPath) {
  const subpath = path.subpaths[0]!;
  return [subpath.start, ...subpath.segments.map((segment) => segment.end)];
}

function staticProfileBoundaryCenter(path: StaticProfileCubicPath) {
  const anchors = staticProfileBoundaryAnchors(path);
  const xs = anchors.map((point) => point.x);
  const ys = anchors.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function assertMotionPathLocalGeometry(entity: StaticProfileEntity, motionPath: StaticProfileCubicPath) {
  if (entity.geometry.kind !== "cubic-path") {
    profileViolation("Dynamic motion-path channels require canonical cubic-path base geometry.");
  }
  const center = staticProfileBoundaryCenter(entity.geometry.path);
  const anchors = staticProfileBoundaryAnchors(entity.geometry.path);
  const motionStart = motionPath.subpaths[0]!.start;
  const scale = Math.max(
    1,
    Math.abs(motionStart.x),
    Math.abs(motionStart.y),
    ...anchors.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]),
  );
  const tolerance = scale * Number.EPSILON * CANONICAL_LINE_ROUNDOFF_MULTIPLIER_V1;
  if (Math.abs(center.x) > tolerance || Math.abs(center.y) > tolerance) {
    profileViolation("Dynamic motion-path base geometry must be rebased around Manim's boundary center.");
  }

  const localPoints = staticProfileControlPoints(entity.geometry.path);
  const motionPoints = staticProfileControlPoints(motionPath);
  for (const coordinate of ["x", "y"] as const) {
    const local = localPoints.map((point) => point[coordinate]);
    const motion = motionPoints.map((point) => point[coordinate]);
    if (
      Math.min(...local) + Math.min(...motion) < -MAX_COORDINATE ||
      Math.max(...local) + Math.max(...motion) > MAX_COORDINATE
    ) {
      profileViolation("Dynamic motion-path translation can move base geometry outside the bounded coordinate range.");
    }
  }
}

/** Proves the component-wise path lerp stays in the bounded renderable profile for every progress value. */
function assertStaticProfileMorphInterval(left: StaticProfileCubicPath, right: StaticProfileCubicPath) {
  const leftSubpath = left.subpaths[0]!;
  const rightSubpath = right.subpaths[0]!;
  const leftPoints = staticProfileControlPoints(left);
  const rightPoints = staticProfileControlPoints(right);
  const scale = Math.max(
    1,
    ...leftPoints.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]),
    ...rightPoints.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]),
  );
  const tolerance = STATIC_PROFILE_RELATIVE_TOLERANCE * scale * scale;

  if (!leftSubpath.closed) {
    const leftChord = subtractPoints(leftSubpath.segments[0]!.end, leftSubpath.start);
    const rightChord = subtractPoints(rightSubpath.segments[0]!.end, rightSubpath.start);
    const chordDelta = subtractPoints(rightChord, leftChord);
    const minimumLengthSquared = minimumQuadraticOnUnitInterval({
      a: chordDelta.x * chordDelta.x + chordDelta.y * chordDelta.y,
      b: 2 * (leftChord.x * chordDelta.x + leftChord.y * chordDelta.y),
      c: leftChord.x * leftChord.x + leftChord.y * leftChord.y,
    });
    if (minimumLengthSquared <= tolerance) {
      profileViolation("Dynamic Line path-morph interpolation must remain non-degenerate for the whole interval.");
    }
    return;
  }

  const leftAnchor = leftPoints[0]!;
  const rightAnchor = rightPoints[0]!;
  const area = { a: 0, b: 0, c: 0 };
  for (let index = 0; index < leftPoints.length; index += 1) {
    const nextIndex = (index + 1) % leftPoints.length;
    const contribution = interpolatedCrossCoefficients(
      subtractPoints(leftPoints[index]!, leftAnchor),
      subtractPoints(leftPoints[nextIndex]!, leftAnchor),
      subtractPoints(rightPoints[index]!, rightAnchor),
      subtractPoints(rightPoints[nextIndex]!, rightAnchor),
    );
    area.a += contribution.a;
    area.b += contribution.b;
    area.c += contribution.c;
  }
  const orientation = Math.sign(area.c);
  if (orientation === 0 || minimumQuadraticOnUnitInterval(orientedQuadratic(area, orientation)) <= tolerance) {
    profileViolation("Dynamic closed path-morph interpolation must retain non-degenerate signed area.");
  }

  for (let edgeIndex = 0; edgeIndex < leftPoints.length; edgeIndex += 1) {
    const nextIndex = (edgeIndex + 1) % leftPoints.length;
    for (let pointIndex = 0; pointIndex < leftPoints.length; pointIndex += 1) {
      const halfPlane = interpolatedCrossCoefficients(
        subtractPoints(leftPoints[nextIndex]!, leftPoints[edgeIndex]!),
        subtractPoints(leftPoints[pointIndex]!, leftPoints[edgeIndex]!),
        subtractPoints(rightPoints[nextIndex]!, rightPoints[edgeIndex]!),
        subtractPoints(rightPoints[pointIndex]!, rightPoints[edgeIndex]!),
      );
      if (minimumQuadraticOnUnitInterval(orientedQuadratic(halfPlane, orientation)) < -tolerance) {
        profileViolation("Dynamic closed path-morph interpolation must retain a convex control polygon.");
      }
    }
  }
}

function staticProfilePathsHaveMatchingTopology(left: StaticProfileCubicPath, right: StaticProfileCubicPath) {
  return (
    left.subpaths.length === right.subpaths.length &&
    left.subpaths.every(
      (subpath, index) =>
        subpath.closed === right.subpaths[index]?.closed &&
        subpath.segments.length === right.subpaths[index]?.segments.length,
    )
  );
}

function staticProfilePathsAreEqual(left: StaticProfileCubicPath, right: StaticProfileCubicPath) {
  if (!staticProfilePathsHaveMatchingTopology(left, right)) return false;
  return left.subpaths.every((leftSubpath, subpathIndex) => {
    const rightSubpath = right.subpaths[subpathIndex]!;
    return (
      leftSubpath.start.x === rightSubpath.start.x &&
      leftSubpath.start.y === rightSubpath.start.y &&
      leftSubpath.segments.every((leftSegment, segmentIndex) => {
        const rightSegment = rightSubpath.segments[segmentIndex]!;
        return (
          leftSegment.control1.x === rightSegment.control1.x &&
          leftSegment.control1.y === rightSegment.control1.y &&
          leftSegment.control2.x === rightSegment.control2.x &&
          leftSegment.control2.y === rightSegment.control2.y &&
          leftSegment.end.x === rightSegment.end.x &&
          leftSegment.end.y === rightSegment.end.y
        );
      })
    );
  });
}

function assertStaticProfileMorphPath(path: StaticProfileCubicPath) {
  if (path.subpaths.length !== 1) {
    profileViolation("Dynamic path-morph values must contain exactly one cubic subpath.");
  }
  const subpath = path.subpaths[0]!;
  if (!subpath.closed) {
    if (subpath.segments.length !== 1 || !isCanonicalFastManimLineSegmentV1(subpath.start, subpath.segments[0]!)) {
      profileViolation("Dynamic open path-morph values must remain one finite canonical Line cubic.");
    }
    return;
  }
  if (subpath.segments.length > MAX_STATIC_PROFILE_CLOSED_SEGMENTS) {
    profileViolation("Dynamic path-morph values exceed the proven segment budget.");
  }
  const points: StaticProfilePoint[] = [subpath.start];
  for (const segment of subpath.segments) points.push(segment.control1, segment.control2, segment.end);
  if (!isConvexControlPolygon(points)) {
    profileViolation("Dynamic path-morph values must retain a finite convex control polygon.");
  }
}

function assertCanonicalStaticProfileStroke(stroke: NonNullable<StaticProfileVectorAppearance["stroke"]>) {
  if (stroke.cap !== "butt" || stroke.join !== "miter" || stroke.miterLimit !== 10) {
    profileViolation("Static profile strokes must use the canonical butt/miter/10 stroke shape.");
  }
  if (stroke.color.alpha <= 0) {
    profileViolation("Static profile strokes must be visible (non-zero alpha).");
  }
}

function assertStaticProfileEntity(entity: StaticProfileEntity, pathTrimTarget: boolean, roundoffScaleFloor = 1) {
  if (entity.appearance.kind !== "vector") {
    profileViolation("Static profile entities must use vector appearance.");
  }
  if (entity.appearance.opacity !== 1) {
    profileViolation("Static profile entities must use full opacity.");
  }
  const { fill, stroke } = entity.appearance;
  const geometry = entity.geometry;
  // The exporter lowers every static shape to canonical cubic paths: raw
  // circle/rectangle/line primitives (and image geometry) are outside the
  // proven v1 output and are rejected toward the server render fallback.
  if (geometry.kind !== "cubic-path") {
    profileViolation("Static profile geometry must be lowered to canonical cubic paths.");
  }
  if (geometry.path.subpaths.length !== 1) {
    profileViolation("Static profile cubic paths accept exactly one subpath.");
  }
  const subpath = geometry.path.subpaths[0]!;
  if (subpath.closed) {
    if (pathTrimTarget) {
      if (fill !== null || stroke === null) {
        profileViolation("Dynamic path-trim closed cubic paths must be stroked without fill.");
      }
      assertCanonicalStaticProfileStroke(stroke);
    } else {
      if (stroke !== null || fill === null) {
        profileViolation("Static profile closed cubic paths must be filled without stroke.");
      }
      // The exporter always emits nonzero-winding fills for the lowered shapes,
      // and only ever emits visible paint (a fully transparent fill is never a
      // static snapshot the renderer would advertise as verified).
      if (fill.rule !== "nonzero") {
        profileViolation("Static profile fills must use the nonzero winding rule.");
      }
      if (fill.color.alpha <= 0) {
        profileViolation("Static profile fills must be visible (non-zero alpha).");
      }
    }
    if (subpath.segments.length > MAX_STATIC_PROFILE_CLOSED_SEGMENTS) {
      profileViolation("Static profile closed cubic paths exceed the proven segment budget.");
    }
    const points: StaticProfilePoint[] = [subpath.start];
    for (const segment of subpath.segments) points.push(segment.control1, segment.control2, segment.end);
    if (!isConvexControlPolygon(points)) {
      profileViolation("Static profile closed cubic paths must be convex.");
    }
    return;
  }
  if (fill !== null || stroke === null) {
    profileViolation("Static profile open cubic paths must be stroked without fill.");
  }
  // The exporter's Line lowering emits exactly Cairo's default stroke shape
  // with visible paint; a fully transparent stroke is never emitted.
  assertCanonicalStaticProfileStroke(stroke);
  if (
    subpath.segments.length !== 1 ||
    !isCanonicalFastManimLineSegmentV1(subpath.start, subpath.segments[0]!, roundoffScaleFloor)
  ) {
    profileViolation(
      "Static profile open paths must be one finite canonical 1/3–2/3 Line cubic within bounded roundoff.",
    );
  }
}

/**
 * The bounded inline-outline shape emitted by the hermetic MathTex producer.
 * V3 deliberately accepts no generic producer-authored vector surface: one
 * filled cubic entity may contain glyph contours and counters, but every
 * contour is closed and the aggregate uses the Rust compiler's exact budgets,
 * paint, coordinate quantum, and artifact attestation. The server cannot
 * independently recompile a source expression that is intentionally absent
 * from Scene IR; production therefore also depends on the digest-pinned
 * producer image tracked by issue #240.
 */
function assertHermeticMathTexProfileEntityV3(entity: StaticProfileEntity) {
  if (entity.appearance.kind !== "vector" || entity.appearance.opacity !== 1) {
    profileViolation("Hermetic MathTex profile entities must use fully opaque vector appearance.");
  }
  if (entity.appearance.stroke !== null || entity.appearance.fill === null) {
    profileViolation("Hermetic MathTex profile entities must be filled without a stroke.");
  }
  const { color } = entity.appearance.fill;
  if (
    entity.appearance.fill.rule !== "nonzero" ||
    color.alpha !== 1 ||
    color.red !== 1 ||
    color.green !== 1 ||
    color.blue !== 1
  ) {
    profileViolation("Hermetic MathTex profile entities must use the canonical opaque white nonzero-winding fill.");
  }
  if (entity.sourceZIndex !== 0) {
    profileViolation("Hermetic MathTex profile entities must use the canonical zero source z-index.");
  }
  if (entity.geometry.kind !== "cubic-path") {
    profileViolation("Hermetic MathTex profile geometry must be a cubic outline.");
  }
  const { subpaths } = entity.geometry.path;
  if (subpaths.length === 0 || subpaths.length > MAX_MATHTEX_PROFILE_SUBPATHS_V3) {
    profileViolation(`Hermetic MathTex outlines accept at most ${MAX_MATHTEX_PROFILE_SUBPATHS_V3} subpaths.`);
  }
  let segments = 0;
  for (const subpath of subpaths) {
    if (!subpath.closed) profileViolation("Every hermetic MathTex outline subpath must be closed.");
    if (subpath.segments.length === 0) profileViolation("Hermetic MathTex outline subpaths must not be empty.");
    segments += subpath.segments.length;
    if (segments > MAX_MATHTEX_PROFILE_CUBIC_SEGMENTS_V3) {
      profileViolation(
        `Hermetic MathTex outlines accept at most ${MAX_MATHTEX_PROFILE_CUBIC_SEGMENTS_V3} cubic segments.`,
      );
    }
    const points = [
      subpath.start,
      ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
    ];
    if (
      points.some(({ x, y }) =>
        [x, y].some(
          (coordinate) =>
            Math.abs(
              coordinate -
                Math.round(coordinate / MATHTEX_PROFILE_COORDINATE_QUANTUM_V3) * MATHTEX_PROFILE_COORDINATE_QUANTUM_V3,
            ) > 1e-12,
        ),
      )
    ) {
      profileViolation("Hermetic MathTex outline coordinates must use the canonical 1e-6 quantum.");
    }
  }
}

function assertHermeticMathTexProfileProvenanceV3(scene: SceneIrBundleV1["scene"]) {
  const evidence = scene.provenance[1]?.evidence;
  const content = evidence?.at(-3);
  if (
    !evidence ||
    !content ||
    !MATHTEX_PROFILE_CONTENT_DIGEST_EVIDENCE_V3.test(content) ||
    evidence.at(-2) !== `MathTex toolchain digest ${MATHTEX_PROFILE_TOOLCHAIN_DIGEST_V3}` ||
    evidence.at(-1) !== `MathTex font digest ${MATHTEX_PROFILE_FONT_DIGEST_V3}`
  ) {
    profileViolation("Hermetic MathTex provenance must attest the pinned compiler toolchain and embedded font.");
  }
}

const HERMETIC_PNG_V4_NUMBER_LITERAL =
  "-?(?:(?:\\d(?:_?\\d)*)\\.(?:\\d(?:_?\\d)*)?|\\.(?:\\d(?:_?\\d)*)|(?:\\d(?:_?\\d)*))(?:[eE][+-]?\\d(?:_?\\d)*)?";
const HERMETIC_PNG_V4_NUMBER_PATTERN = new RegExp(`^${HERMETIC_PNG_V4_NUMBER_LITERAL}$`);

function hermeticPngV4NumberLiteral(source: string, positive = false) {
  const literal = source.trim();
  if (!HERMETIC_PNG_V4_NUMBER_PATTERN.test(literal)) return null;
  const value = Number(literal.replaceAll("_", ""));
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE || Object.is(value, -0) || (positive && value <= 0)) {
    return null;
  }
  return value;
}

function hermeticPngV4Statements(source: string, sceneName: string) {
  const analysis = analyzePythonSource(source);
  let block: ReturnType<typeof findSourceSceneBlock>;
  try {
    block = findSourceSceneBlock(source, sceneName);
  } catch {
    return null;
  }
  if (!analysis.valid || !block || block.bodyIndent === null) return null;
  const statements: string[] = [];
  for (let index = block.bodyStart; index < block.bodyEnd; index += 1) {
    let line = analysis.lines[index];
    if (!line || !line.hasSignificantToken) continue;
    if (!isPythonStatementStart(line) || line.indentation !== block.bodyIndent) return null;
    const parts = [line.code.trim()];
    while (line.bracketDepthAfter > 0 || line.continuesToNext) {
      index += 1;
      if (index >= block.bodyEnd) return null;
      const continuation = analysis.lines[index];
      if (!continuation || continuation.startsInString || continuation.indentation <= block.bodyIndent) return null;
      parts.push(continuation.code.trim());
      line = continuation;
    }
    const statement = parts.join(" ").trim();
    if (!statement) return null;
    statements.push(statement);
  }
  return statements;
}

/**
 * Independently derives the only V4 post-add mutations the server accepts.
 * Strings and comments are removed by the shared lexical pass; no Python is
 * executed and every unrecognized statement fails closed.
 */
export function deriveHermeticPngV4TransformPlan(source: string, sceneName: string): HermeticPngV4TransformPlan {
  const statements = hermeticPngV4Statements(source, sceneName);
  const assignment = statements?.[0]?.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*ImageMobject\s*\(/);
  const variable = assignment?.[1];
  if (!statements || !variable || !new RegExp(`^self\\.add\\(\\s*${variable}\\s*\\)$`).test(statements[1] ?? "")) {
    profileViolation("Hermetic PNG source does not expose one direct ImageMobject assignment followed by self.add.");
  }
  const tail = statements.slice(2);
  let terminalWait: number | null = null;
  const wait = tail.at(-1)?.match(new RegExp(`^self\\.wait\\(\\s*(${HERMETIC_PNG_V4_NUMBER_LITERAL})\\s*\\)$`));
  if (wait) {
    terminalWait = hermeticPngV4NumberLiteral(wait[1]!, true);
    if (terminalWait === null || terminalWait > MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2) {
      profileViolation("Hermetic PNG terminal wait must be one bounded positive numeric literal.");
    }
    tail.pop();
  }
  if (tail.length > 64) profileViolation("Hermetic PNG source contains too many static transforms.");
  const transforms: Array<HermeticPngV4TransformPlan["transforms"][number]> = [];
  const escapedVariable = variable;
  const movePattern = new RegExp(
    `^${escapedVariable}\\.move_to\\(\\s*\\(\\s*(${HERMETIC_PNG_V4_NUMBER_LITERAL})\\s*,\\s*(${HERMETIC_PNG_V4_NUMBER_LITERAL})\\s*,\\s*0\\s*\\)\\s*\\)$`,
  );
  const scalePattern = new RegExp(`^${escapedVariable}\\.scale\\(\\s*(${HERMETIC_PNG_V4_NUMBER_LITERAL})\\s*\\)$`);
  for (const statement of tail) {
    const move = statement.match(movePattern);
    if (move) {
      const x = hermeticPngV4NumberLiteral(move[1]!);
      const y = hermeticPngV4NumberLiteral(move[2]!);
      if (x === null || y === null) profileViolation("Hermetic PNG move_to coordinates must be bounded literals.");
      transforms.push({ kind: "move-to", x, y });
      continue;
    }
    const scale = statement.match(scalePattern);
    if (scale) {
      const factor = hermeticPngV4NumberLiteral(scale[1]!, true);
      if (factor === null) profileViolation("Hermetic PNG scale factors must be bounded positive literals.");
      transforms.push({ factor, kind: "scale" });
      continue;
    }
    profileViolation("Hermetic PNG source contains a statement outside the static transform profile.");
  }
  return hermeticPngV4TransformPlanSchema.parse({ terminalWait, transforms });
}

function sameHermeticPngV4TransformPlan(left: HermeticPngV4TransformPlan, right: HermeticPngV4TransformPlan) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function expectedHermeticPngLocalRectV4(
  plan: HermeticPngV4TransformPlan | undefined,
  asset: SceneIrBundleV1["assets"]["assets"][number],
  expectedFrame: Readonly<{ height: number; width: number }>,
) {
  const height = (asset.pixelHeight / HERMETIC_PNG_SCALE_TO_RESOLUTION_V4) * expectedFrame.height;
  const width = (height * asset.pixelWidth) / asset.pixelHeight;
  let bottom = -height / 2;
  let left = -width / 2;
  let right = width / 2;
  let top = height / 2;
  for (const transform of plan?.transforms ?? []) {
    const centerX = (left + right) / 2;
    const centerY = (bottom + top) / 2;
    if (transform.kind === "move-to") {
      const deltaX = transform.x - centerX;
      const deltaY = transform.y - centerY;
      left += deltaX;
      right += deltaX;
      bottom += deltaY;
      top += deltaY;
    } else {
      left = (left - centerX) * transform.factor + centerX;
      right = (right - centerX) * transform.factor + centerX;
      bottom = (bottom - centerY) * transform.factor + centerY;
      top = (top - centerY) * transform.factor + centerY;
    }
    if (
      ![bottom, left, right, top].every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE) ||
      !(left < right && bottom < top)
    ) {
      profileViolation("Hermetic PNG transforms produce geometry outside the bounded profile.");
    }
  }
  return { bottom: Object.is(bottom, -0) ? 0 : bottom, left: Object.is(left, -0) ? 0 : left, right, top };
}

function assertHermeticPngProfileEntityV4(
  entity: StaticProfileEntity,
  asset: SceneIrBundleV1["assets"]["assets"][number],
  expectedFrame: Readonly<{ height: number; width: number }>,
  transformPlan: HermeticPngV4TransformPlan | undefined,
) {
  if (entity.appearance.kind !== "image" || entity.appearance.opacity !== 1) {
    profileViolation("Hermetic PNG profile entities must use fully opaque image appearance.");
  }
  if (entity.sourceZIndex !== 0) {
    profileViolation("Hermetic PNG profile entities must use the canonical zero source z-index.");
  }
  if (entity.geometry.kind !== "image") {
    profileViolation("Hermetic PNG profile geometry must be one image rectangle.");
  }
  if (entity.geometry.asset.assetId !== asset.id || entity.geometry.asset.sha256 !== asset.sha256) {
    profileViolation("Hermetic PNG geometry must reference the one verified manifest asset exactly.");
  }

  // ImageMobject's admitted source form retains its default 1080px scaling:
  // one source pixel maps to frameHeight / 1080 scene units. Re-derive the
  // centered rectangle from server-held frame state and manifest dimensions,
  // rather than trusting producer-authored world bounds.
  const expectedLocalRect = expectedHermeticPngLocalRectV4(transformPlan, asset, expectedFrame);
  if (
    entity.geometry.localRect.bottom !== expectedLocalRect.bottom ||
    entity.geometry.localRect.left !== expectedLocalRect.left ||
    entity.geometry.localRect.right !== expectedLocalRect.right ||
    entity.geometry.localRect.top !== expectedLocalRect.top
  ) {
    profileViolation("Hermetic PNG localRect must derive exactly from its pixel dimensions and requested frame.");
  }
}

function assertHermeticPngProfileProvenanceV4(
  scene: SceneIrBundleV1["scene"],
  asset: SceneIrBundleV1["assets"]["assets"][number],
) {
  const sceneEvidence = scene.provenance[0]?.evidence;
  const entityEvidence = scene.provenance[1]?.evidence;
  const geometry = scene.entities[0]?.geometry;
  if (sceneEvidence?.[0] !== HERMETIC_PNG_PROFILE_EVIDENCE_V4) {
    profileViolation("Hermetic PNG scene provenance must attest snapshot profile v4.");
  }
  if (
    !entityEvidence ||
    geometry?.kind !== "image" ||
    !entityEvidence.includes(HERMETIC_PNG_CAPABILITY_EVIDENCE_V4) ||
    entityEvidence.at(-3) !== `PNG encoded digest ${asset.sha256}` ||
    entityEvidence.at(-2) !== `PNG dimensions ${asset.pixelWidth} x ${asset.pixelHeight}` ||
    entityEvidence.at(-1) !== `PNG sampler ${geometry.sampler}`
  ) {
    profileViolation("Hermetic PNG entity provenance must attest the exact asset digest, dimensions, and sampler.");
  }
}

function canonicalSnapshotFrameIndexV2(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2) return null;
  const frames = Math.round(value * FAST_MANIM_SNAPSHOT_FRAME_RATE_V2);
  return Number.isSafeInteger(frames) && frames / FAST_MANIM_SNAPSHOT_FRAME_RATE_V2 === value ? frames : null;
}

function isCanonicalSnapshotFrameTimeV2(value: number) {
  return canonicalSnapshotFrameIndexV2(value) !== null;
}

function isCanonicalDynamicTimedStepV2(start: number, end: number) {
  const startFrame = canonicalSnapshotFrameIndexV2(start);
  const endFrame = canonicalSnapshotFrameIndexV2(end);
  if (startFrame === null || endFrame === null || endFrame <= startFrame) return false;
  const duration = (endFrame - startFrame) / FAST_MANIM_SNAPSHOT_FRAME_RATE_V2;
  const producerFrames = duration / (1 / FAST_MANIM_SNAPSHOT_FRAME_RATE_V2);
  return Number.isInteger(producerFrames) && producerFrames / FAST_MANIM_SNAPSHOT_FRAME_RATE_V2 === duration;
}

function assertDynamicProfileV2(scene: SceneIrBundleV1["scene"]) {
  if (scene.duration > MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2) {
    profileViolation(`Variable-duration snapshots accept at most ${MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2}s.`);
  }
  const hasDynamicEvidence =
    scene.animationChannels.length > 0 ||
    scene.entities.some(
      (entity) =>
        entity.lifetimes.length !== 1 ||
        entity.lifetimes[0]?.start !== 0 ||
        entity.lifetimes[0]?.end !== scene.duration,
    );
  // Frozen-wait V2 snapshots were sealed before the producer adopted the
  // exact frame-grid contract. Continue to verify those immutable stills;
  // every newly admitted membership/Fade timeline must use the 60fps grid.
  if (hasDynamicEvidence && (!isCanonicalSnapshotFrameTimeV2(scene.duration) || scene.duration === 0)) {
    profileViolation(
      `Variable-duration snapshots must end on the canonical ${FAST_MANIM_SNAPSHOT_FRAME_RATE_V2}fps grid.`,
    );
  }

  const entityIndexes = new Map(scene.entities.map((entity, index) => [entity.id, index]));
  let previousEntityIndex = -1;
  let previousKindOrder = -1;
  const channelKindsByEntity = new Map<number, Set<string>>();
  const opacityChannelsByEntity = new Map<
    number,
    Extract<SceneIrBundleV1["scene"]["animationChannels"][number], { kind: "opacity" }>
  >();
  for (const channel of scene.animationChannels) {
    if (
      channel.kind !== "affine-transform" &&
      channel.kind !== "motion-path" &&
      channel.kind !== "opacity" &&
      channel.kind !== "path-morph" &&
      channel.kind !== "path-trim"
    ) {
      profileViolation(
        "Dynamic profile V2 accepts only affine-transform, motion-path, opacity, path-morph, and path-trim animation channels.",
      );
    }
    const entityIndex = entityIndexes.get(channel.entityId);
    const kindOrder =
      channel.kind === "affine-transform"
        ? 0
        : channel.kind === "opacity"
          ? 1
          : channel.kind === "path-trim"
            ? 2
            : channel.kind === "path-morph"
              ? 3
              : 4;
    if (
      entityIndex === undefined ||
      entityIndex < previousEntityIndex ||
      (entityIndex === previousEntityIndex && kindOrder <= previousKindOrder)
    ) {
      profileViolation(
        "Dynamic channels must follow entity sceneOrder, with affine-transform then opacity then path-trim then path-morph then motion-path, without duplicates.",
      );
    }
    previousEntityIndex = entityIndex;
    previousKindOrder = kindOrder;
    const entityKinds = channelKindsByEntity.get(entityIndex) ?? new Set<string>();
    entityKinds.add(channel.kind);
    channelKindsByEntity.set(entityIndex, entityKinds);
    if (entityKinds.has("affine-transform") && entityKinds.has("path-trim")) {
      profileViolation("Dynamic profile V2 does not combine affine-transform and path-trim on one entity.");
    }
    if (entityKinds.has("path-morph") && entityKinds.size > 1) {
      profileViolation("Dynamic profile V2 does not combine path-morph with another channel on one entity.");
    }
    if (entityKinds.has("motion-path") && entityKinds.size > 1) {
      profileViolation("Dynamic profile V2 does not combine motion-path with another channel on one entity.");
    }
    const entity = scene.entities[entityIndex]!;

    if (channel.kind === "affine-transform") {
      if (
        channel.id !== fastManimSnapshotAffineTransformChannelIdV2(scene.sceneId, entityIndex) ||
        channel.provenanceId !== fastManimSnapshotAffineTransformChannelProvenanceIdV2(scene.sceneId, entityIndex)
      ) {
        profileViolation(
          "Dynamic affine-transform channel identifiers must derive from Scene identity and sceneOrder.",
        );
      }
      const lifetime = entity.lifetimes[0]!;
      const identity = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
      const isIdentity = (value: (typeof channel.keyframes)[number]["value"]) =>
        value.m11 === identity.m11 &&
        value.m12 === identity.m12 &&
        value.m21 === identity.m21 &&
        value.m22 === identity.m22 &&
        value.tx === identity.tx &&
        value.ty === identity.ty;
      if (!isIdentity(channel.keyframes[0]!.value)) {
        profileViolation("A dynamic affine-transform channel must begin at the identity base transform.");
      }
      if (channel.keyframes.every((keyframe) => isIdentity(keyframe.value))) {
        profileViolation("A dynamic affine-transform channel must contain a non-identity endpoint.");
      }
      if (entity.geometry.kind !== "cubic-path") {
        profileViolation("Dynamic affine-transform channels require canonical cubic-path base geometry.");
      }
      const points = entity.geometry.path.subpaths.flatMap((subpath) => [
        subpath.start,
        ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
      ]);
      if (points.length > 1 + MAX_STATIC_PROFILE_CLOSED_SEGMENTS * 3) {
        profileViolation("Dynamic affine-transform base geometry exceeds the proven profile segment budget.");
      }
      for (const [keyframeIndex, keyframe] of channel.keyframes.entries()) {
        if (
          !isCanonicalSnapshotFrameTimeV2(keyframe.at) ||
          keyframe.at < lifetime.start ||
          keyframe.at > lifetime.end
        ) {
          profileViolation(
            "Dynamic affine-transform keyframes must lie within the entity lifetime on the canonical 60fps grid.",
          );
        }
        const final = keyframeIndex === channel.keyframes.length - 1;
        if ((!final && keyframe.easingToNext?.kind !== "linear") || (final && keyframe.easingToNext !== null)) {
          profileViolation(
            "Dynamic affine-transform keyframes must use explicit linear easing and a null final easing.",
          );
        }
        const { m11, m12, m21, m22, tx, ty } = keyframe.value;
        if ([m11, m12, m21, m22, tx, ty].some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)) {
          profileViolation("Dynamic affine-transform keyframes contain an out-of-range matrix component.");
        }
        // Do not require a non-zero determinant. Component-linear interpolation
        // from identity to a valid reflection necessarily crosses a singular
        // sample; renderer issue #195 owns draw-local handling at that instant.
        if (
          points.some((point) => {
            const x = m11 * point.x + m12 * point.y + tx;
            const y = m21 * point.x + m22 * point.y + ty;
            return (
              !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE
            );
          })
        ) {
          profileViolation(
            "Dynamic affine-transform keyframes move base geometry outside the bounded coordinate range.",
          );
        }
        if (
          keyframeIndex > 0 &&
          !isCanonicalDynamicTimedStepV2(channel.keyframes[keyframeIndex - 1]!.at, keyframe.at)
        ) {
          profileViolation("Dynamic affine-transform segments must span exact producer-supported 60fps timed steps.");
        }
      }
      continue;
    }

    if (channel.kind === "motion-path") {
      if (
        channel.id !== fastManimSnapshotMotionPathChannelIdV2(scene.sceneId, entityIndex) ||
        channel.provenanceId !== fastManimSnapshotMotionPathChannelProvenanceIdV2(scene.sceneId, entityIndex)
      ) {
        profileViolation("Dynamic motion-path channel identifiers must derive from Scene identity and sceneOrder.");
      }
      if (channel.parameterization !== "manim-point-from-proportion-v1" || channel.orientToPath) {
        profileViolation(
          "Dynamic motion-path channels require manim-point-from-proportion-v1 without tangent orientation.",
        );
      }
      if (channel.path.subpaths.length !== 1) {
        profileViolation("Dynamic motion paths must contain exactly one serialized cubic subpath.");
      }
      const motionSubpath = channel.path.subpaths[0]!;
      if (motionSubpath.segments.length === 0 || motionSubpath.segments.length > MAX_STATIC_PROFILE_CLOSED_SEGMENTS) {
        profileViolation("Dynamic motion paths must contain between one and 16 serialized cubic segments.");
      }
      const motionEndpoint = motionSubpath.segments.at(-1)!.end;
      if (motionSubpath.closed !== fastManimPointsEqual2dV2(motionSubpath.start, motionEndpoint)) {
        profileViolation("Dynamic motion-path closure must match Manim's exact planar endpoint tolerance.");
      }
      assertMotionPathLocalGeometry(entity, channel.path);
      const lifetime = entity.lifetimes[0]!;
      if (channel.keyframes.length !== 2 || channel.keyframes[0]!.value !== 0 || channel.keyframes[1]!.value !== 1) {
        profileViolation("Dynamic motion-path channels must encode one exact zero-to-one MoveAlongPath step.");
      }
      for (const [keyframeIndex, keyframe] of channel.keyframes.entries()) {
        if (
          !isCanonicalSnapshotFrameTimeV2(keyframe.at) ||
          keyframe.at < lifetime.start ||
          keyframe.at > lifetime.end
        ) {
          profileViolation(
            "Dynamic motion-path keyframes must lie within the entity lifetime on the canonical 60fps grid.",
          );
        }
        const final = keyframeIndex === channel.keyframes.length - 1;
        if ((!final && keyframe.easingToNext?.kind !== "linear") || (final && keyframe.easingToNext !== null)) {
          profileViolation("Dynamic motion-path keyframes must use explicit linear easing and a null final easing.");
        }
      }
      if (channel.keyframes[0]!.at !== lifetime.start) {
        profileViolation("A verified MoveAlongPath must begin exactly when its entity lifetime starts.");
      }
      if (!isCanonicalDynamicTimedStepV2(channel.keyframes[0]!.at, channel.keyframes[1]!.at)) {
        profileViolation("A verified MoveAlongPath must span one exact producer-supported 60fps timed step.");
      }
      continue;
    }

    if (channel.kind === "path-trim") {
      if (
        channel.id !== fastManimSnapshotPathTrimChannelIdV2(scene.sceneId, entityIndex) ||
        channel.provenanceId !== fastManimSnapshotPathTrimChannelProvenanceIdV2(scene.sceneId, entityIndex)
      ) {
        profileViolation("Dynamic path-trim channel identifiers must derive from Scene identity and sceneOrder.");
      }
      if (channel.parameterization !== "uniform-cubic-parameter-v1") {
        profileViolation("Dynamic path-trim channels require uniform-cubic-parameter-v1.");
      }
      const lifetime = entity.lifetimes[0]!;
      const values = channel.keyframes.map((keyframe) => keyframe.value);
      const producerPathTrimShape =
        (values.length === 2 && ((values[0] === 0 && values[1] === 1) || (values[0] === 1 && values[1] === 0))) ||
        (values.length === 3 && values[0] === 0 && values[1] === 1 && values[2] === 0) ||
        (values.length === 4 && values[0] === 0 && values[1] === 1 && values[2] === 1 && values[3] === 0);
      if (!producerPathTrimShape) {
        profileViolation("Dynamic path-trim channels must encode one Create, one Uncreate, or one ordered pair.");
      }
      for (const [keyframeIndex, keyframe] of channel.keyframes.entries()) {
        if (
          !isCanonicalSnapshotFrameTimeV2(keyframe.at) ||
          keyframe.at < lifetime.start ||
          keyframe.at > lifetime.end
        ) {
          profileViolation(
            "Dynamic path-trim keyframes must lie within the entity lifetime on the canonical 60fps grid.",
          );
        }
        if (keyframe.value !== 0 && keyframe.value !== 1) {
          profileViolation("Dynamic path-trim keyframes must use the producer's exact zero/one endpoints.");
        }
        const final = keyframeIndex === channel.keyframes.length - 1;
        if ((!final && keyframe.easingToNext?.kind !== "linear") || (final && keyframe.easingToNext !== null)) {
          profileViolation("Dynamic path-trim keyframes must use explicit linear easing and a null final easing.");
        }
      }
      if (values[0] === 0 && channel.keyframes[0]!.at !== lifetime.start) {
        profileViolation("A verified Create must begin exactly when its entity lifetime starts.");
      }
      if (values.at(-1) === 0 && channel.keyframes.at(-1)!.at !== lifetime.end) {
        profileViolation("A verified Uncreate must end exactly when its entity lifetime ends.");
      }
      const pathTrimSegments =
        values.length === 2
          ? [[0, 1]]
          : values.length === 3
            ? [
                [0, 1],
                [1, 2],
              ]
            : [
                [0, 1],
                [2, 3],
              ];
      for (const [startIndex, endIndex] of pathTrimSegments) {
        if (!isCanonicalDynamicTimedStepV2(channel.keyframes[startIndex]!.at, channel.keyframes[endIndex]!.at)) {
          profileViolation("Each verified Create or Uncreate must span one exact producer-supported 60fps timed step.");
        }
      }
      const opacityChannel = opacityChannelsByEntity.get(entityIndex);
      if (opacityChannel) {
        const opacityValues = opacityChannel.keyframes.map((keyframe) => keyframe.value);
        const createThenFadeOut =
          values.length === 2 &&
          values[0] === 0 &&
          values[1] === 1 &&
          opacityValues.length === 2 &&
          opacityValues[0] === 1 &&
          opacityValues[1] === 0 &&
          channel.keyframes[1]!.at <= opacityChannel.keyframes[0]!.at;
        const fadeInThenUncreate =
          opacityValues.length === 2 &&
          opacityValues[0] === 0 &&
          opacityValues[1] === 1 &&
          values.length === 2 &&
          values[0] === 1 &&
          values[1] === 0 &&
          opacityChannel.keyframes[1]!.at <= channel.keyframes[0]!.at;
        if (!createThenFadeOut && !fadeInThenUncreate) {
          profileViolation(
            "Combined opacity and path-trim channels must encode Create then FadeOut or FadeIn then Uncreate without overlap.",
          );
        }
      }
      continue;
    }

    if (channel.kind === "path-morph") {
      if (
        channel.id !== fastManimSnapshotPathMorphChannelIdV2(scene.sceneId, entityIndex) ||
        channel.provenanceId !== fastManimSnapshotPathMorphChannelProvenanceIdV2(scene.sceneId, entityIndex)
      ) {
        profileViolation("Dynamic path-morph channel identifiers must derive from Scene identity and sceneOrder.");
      }
      if (entity.geometry.kind !== "cubic-path") {
        profileViolation("Dynamic path-morph channels require canonical cubic-path base geometry.");
      }
      if (channel.keyframes.length < 2 || channel.keyframes.length > 4) {
        profileViolation(
          "Dynamic path-morph channels must encode one or two direct Transform steps and at most one hold.",
        );
      }
      const lifetime = entity.lifetimes[0]!;
      const basePath = entity.geometry.path;
      if (!staticProfilePathsAreEqual(basePath, channel.keyframes[0]!.value)) {
        profileViolation("A dynamic path-morph channel must begin at the entity's exact base geometry.");
      }
      const transitionKinds: Array<"hold" | "transform"> = [];
      for (const [keyframeIndex, keyframe] of channel.keyframes.entries()) {
        if (
          !isCanonicalSnapshotFrameTimeV2(keyframe.at) ||
          keyframe.at < lifetime.start ||
          keyframe.at > lifetime.end
        ) {
          profileViolation(
            "Dynamic path-morph keyframes must lie within the entity lifetime on the canonical 60fps grid.",
          );
        }
        const final = keyframeIndex === channel.keyframes.length - 1;
        if ((!final && keyframe.easingToNext?.kind !== "linear") || (final && keyframe.easingToNext !== null)) {
          profileViolation("Dynamic path-morph keyframes must use explicit linear easing and a null final easing.");
        }
        if (!staticProfilePathsHaveMatchingTopology(basePath, keyframe.value)) {
          profileViolation("Dynamic path-morph keyframes must preserve the entity's exact cubic topology.");
        }
        assertStaticProfileMorphPath(keyframe.value);
        if (keyframeIndex === 0) continue;
        const previous = channel.keyframes[keyframeIndex - 1]!;
        if (staticProfilePathsAreEqual(previous.value, keyframe.value)) {
          transitionKinds.push("hold");
        } else {
          transitionKinds.push("transform");
          assertStaticProfileMorphInterval(previous.value, keyframe.value);
          if (!isCanonicalDynamicTimedStepV2(previous.at, keyframe.at)) {
            profileViolation("Each verified path morph must span one exact producer-supported 60fps timed step.");
          }
        }
      }
      const producerReachableShape =
        (transitionKinds.length === 1 && transitionKinds[0] === "transform") ||
        (transitionKinds.length === 2 && transitionKinds.every((kind) => kind === "transform")) ||
        (transitionKinds.length === 3 &&
          transitionKinds[0] === "transform" &&
          transitionKinds[1] === "hold" &&
          transitionKinds[2] === "transform");
      if (!producerReachableShape) {
        profileViolation(
          "Dynamic path-morph channels must encode one Transform, two adjacent Transforms, or two Transforms separated by one hold.",
        );
      }
      continue;
    }

    if (
      channel.id !== fastManimSnapshotOpacityChannelIdV2(scene.sceneId, entityIndex) ||
      channel.provenanceId !== fastManimSnapshotOpacityChannelProvenanceIdV2(scene.sceneId, entityIndex)
    ) {
      profileViolation("Dynamic opacity channel identifiers must derive from Scene identity and sceneOrder.");
    }
    const lifetime = entity.lifetimes[0]!;
    const values = channel.keyframes.map((keyframe) => keyframe.value);
    const producerFadeShape =
      (values.length === 2 && ((values[0] === 0 && values[1] === 1) || (values[0] === 1 && values[1] === 0))) ||
      (values.length === 3 && values[0] === 0 && values[1] === 1 && values[2] === 0) ||
      (values.length === 4 && values[0] === 0 && values[1] === 1 && values[2] === 1 && values[3] === 0);
    if (!producerFadeShape) {
      profileViolation("Dynamic opacity channels must encode one FadeIn, one FadeOut, or one ordered pair.");
    }
    for (const [keyframeIndex, keyframe] of channel.keyframes.entries()) {
      if (!isCanonicalSnapshotFrameTimeV2(keyframe.at) || keyframe.at < lifetime.start || keyframe.at > lifetime.end) {
        profileViolation("Dynamic opacity keyframes must lie within the entity lifetime on the canonical 60fps grid.");
      }
      if (keyframe.value !== 0 && keyframe.value !== 1) {
        profileViolation("Dynamic opacity keyframes must use the producer's exact zero/one Fade endpoints.");
      }
      const final = keyframeIndex === channel.keyframes.length - 1;
      if ((!final && keyframe.easingToNext?.kind !== "linear") || (final && keyframe.easingToNext !== null)) {
        profileViolation("Dynamic opacity keyframes must use explicit linear easing and a null final easing.");
      }
    }
    if (values[0] === 0 && channel.keyframes[0]!.at !== lifetime.start) {
      profileViolation("A verified FadeIn must begin exactly when its entity lifetime starts.");
    }
    if (values.at(-1) === 0 && channel.keyframes.at(-1)!.at !== lifetime.end) {
      profileViolation("A verified FadeOut must end exactly when its entity lifetime ends.");
    }
    const fadeSegments =
      values.length === 2
        ? [[0, 1]]
        : values.length === 3
          ? [
              [0, 1],
              [1, 2],
            ]
          : [
              [0, 1],
              [2, 3],
            ];
    for (const [startIndex, endIndex] of fadeSegments) {
      if (!isCanonicalDynamicTimedStepV2(channel.keyframes[startIndex]!.at, channel.keyframes[endIndex]!.at)) {
        profileViolation("Each verified Fade must span one exact producer-supported 60fps timed step.");
      }
    }
    opacityChannelsByEntity.set(entityIndex, channel);
  }
}

/**
 * The v1 static snapshot profile: the only Scene shape the renderer provably
 * supports end to end (static filled convex closed paths lowered from Circle
 * and Rectangle, stroked Lines with canonical 1/3–2/3 cubic controls plus
 * bounded producer roundoff, no animation channels, exact
 * fidelity, no assets). Every identifier must be the exact deterministic ID
 * derived from the Scene identity and sceneOrder, so no producer-chosen string
 * (including unreferenced provenance suffixes) can carry host details or
 * exfiltrated secrets into browser JSON, and every schema-valid-but-unproven
 * cubic construction is rejected toward the server render fallback rather than
 * advertised as verified.
 */
function assertFastManimSnapshotProfileV1(
  bundle: SceneIrBundleV1,
  expectedFrame: Readonly<{ height: number; width: number }>,
  snapshotVersion: FastManimSnapshotProfileVersionV1,
  mode: "producer" | "sealed",
  hermeticPngV4Plan: HermeticPngV4TransformPlan | undefined,
) {
  const { scene } = bundle;
  const sceneId = scene.sceneId;
  if (scene.fidelity.kind !== "exact") profileViolation("Static profile Scenes must report exact fidelity.");
  if (bundle.assets.manifestId !== fastManimSnapshotManifestIdV1(sceneId)) {
    profileViolation("The asset manifest ID must be the exact derived Scene manifest identifier.");
  }
  if (snapshotVersion === 4) {
    if (bundle.assets.assets.length !== 1 || bundle.assets.assets[0]?.id !== fastManimSnapshotPngAssetIdV4(sceneId)) {
      profileViolation("Hermetic PNG profile V4 requires exactly one asset with its derived Scene asset identifier.");
    }
  } else if (bundle.assets.assets.length > 0) {
    profileViolation("Snapshot profiles V1-V3 must use an empty asset manifest.");
  }
  // The exporter's static camera is fixed at the origin with exactly the
  // frame the producer request's runtimeConfig carried; the server re-checks
  // that frame from its own expected boundary, never from producer echo.
  // (The coordinateSpace is already pinned to its single canonical literal
  // shape by the scene-ir schema itself.)
  if (scene.camera.view.center.x !== 0 || scene.camera.view.center.y !== 0) {
    profileViolation("Static profile cameras must be centered at the origin.");
  }
  if (scene.camera.view.frameHeight !== expectedFrame.height || scene.camera.view.frameWidth !== expectedFrame.width) {
    profileViolation("Static profile cameras must use exactly the requested runtime frame.");
  }
  // V1 remains the exact one-second still contract. V2 adds a bounded 60fps
  // timeline with observed membership, exact linear Fade opacity, exact
  // component-linear affine channels, and exact uniform-cubic Create/Uncreate
  // trims. V3 and V4 are separate one-second hermetic MathTex and PNG
  // contracts. Geometry and the entity's base transform stay immutable.
  if (snapshotVersion !== 2 && scene.duration !== FAST_MANIM_SNAPSHOT_STATIC_DURATION_SECONDS_V1) {
    profileViolation("Static profile Scenes must report exactly the canonical 1-second static duration.");
  }
  if (snapshotVersion === 2) assertDynamicProfileV2(scene);
  if (snapshotVersion !== 2 && scene.animationChannels.length > 0) {
    profileViolation("Static profile Scenes must not carry animation channels.");
  }
  if (snapshotVersion === 3 && scene.entities.length !== 1) {
    profileViolation("Hermetic MathTex profile V3 requires exactly one outline entity.");
  }
  if (snapshotVersion === 4 && scene.entities.length !== 1) {
    profileViolation("Hermetic PNG profile V4 requires exactly one image entity.");
  }
  const expectedCapabilities =
    snapshotVersion === 4
      ? (["png-image"] as const)
      : [
          ...(scene.animationChannels.some((channel) => channel.kind === "affine-transform")
            ? (["affine-transform-animation"] as const)
            : []),
          ...(scene.entities.length > 0 ? (["cubic-path-geometry"] as const) : []),
          ...(scene.animationChannels.some((channel) => channel.kind === "motion-path")
            ? (["motion-path-animation"] as const)
            : []),
          ...(scene.animationChannels.some((channel) => channel.kind === "opacity")
            ? (["opacity-animation"] as const)
            : []),
          ...(scene.animationChannels.some((channel) => channel.kind === "path-morph")
            ? (["path-morph-animation"] as const)
            : []),
          ...(scene.animationChannels.some((channel) => channel.kind === "path-trim")
            ? (["path-trim-animation"] as const)
            : []),
        ];
  if (
    scene.requiredCapabilities.length !== expectedCapabilities.length ||
    scene.requiredCapabilities.some((capability, index) => capability !== expectedCapabilities[index])
  ) {
    profileViolation(
      snapshotVersion === 2
        ? "Dynamic profile V2 Scenes must derive affine-transform-animation, cubic-path-geometry, motion-path-animation, opacity-animation, path-morph-animation, and path-trim-animation exactly from their contents."
        : snapshotVersion === 4
          ? "Hermetic PNG profile V4 must require exactly png-image."
          : "Static vector profiles must require exactly cubic-path-geometry, or nothing when empty.",
    );
  }
  // Entities are the exporter's enumerate order: each sceneOrder must equal
  // its array index, contiguous from 0 — duplicates, gaps, and reordering are
  // all rejected — and every derived identifier below is anchored to this
  // validated order, never to a producer-chosen number.
  const pathTrimEntityIds = new Set(
    scene.animationChannels.filter((channel) => channel.kind === "path-trim").map((channel) => channel.entityId),
  );
  const motionPathRoundoffScaleFloorByEntityId = new Map(
    scene.animationChannels
      .filter((channel) => channel.kind === "motion-path")
      .map((channel) => {
        const start = channel.path.subpaths[0]!.start;
        return [channel.entityId, Math.max(1, Math.abs(start.x), Math.abs(start.y))] as const;
      }),
  );
  scene.entities.forEach((entity, index) => {
    if (entity.sceneOrder !== index) {
      profileViolation("Static profile entities must enumerate sceneOrder contiguously in array order.");
    }
    if (entity.id !== fastManimSnapshotEntityIdV1(sceneId, index)) {
      profileViolation("An entity ID must be the exact identifier derived from the Scene identity and sceneOrder.");
    }
    if (entity.provenanceId !== fastManimSnapshotEntityProvenanceIdV1(sceneId, index)) {
      profileViolation("An entity provenance reference must name its own derived entity provenance record.");
    }
    if (entity.parentId !== null) {
      profileViolation("Static profile entities must not declare parent entities.");
    }
    const lifetime = entity.lifetimes[0];
    const fullSceneLifetime = lifetime?.start === 0 && lifetime.end === scene.duration;
    if (
      entity.lifetimes.length !== 1 ||
      !lifetime ||
      (snapshotVersion !== 2 && (lifetime.start !== 0 || lifetime.end !== scene.duration)) ||
      (snapshotVersion === 2 &&
        ((!fullSceneLifetime &&
          (!isCanonicalSnapshotFrameTimeV2(lifetime.start) || !isCanonicalSnapshotFrameTimeV2(lifetime.end))) ||
          lifetime.start >= lifetime.end ||
          lifetime.end > scene.duration))
    ) {
      profileViolation("Entity lifetimes must match the negotiated snapshot timeline profile.");
    }
    const { m11, m12, m21, m22, tx, ty } = entity.transform;
    if (m11 !== 1 || m12 !== 0 || m21 !== 0 || m22 !== 1 || tx !== 0 || ty !== 0) {
      profileViolation(
        "Snapshot profile entities must keep their base transform at identity; V2 affine motion belongs only in affine-transform channels.",
      );
    }
    switch (snapshotVersion) {
      case 1:
      case 2:
        assertStaticProfileEntity(
          entity,
          pathTrimEntityIds.has(entity.id),
          motionPathRoundoffScaleFloorByEntityId.get(entity.id),
        );
        break;
      case 3:
        assertHermeticMathTexProfileEntityV3(entity);
        break;
      case 4:
        assertHermeticPngProfileEntityV4(entity, bundle.assets.assets[0]!, expectedFrame, hermeticPngV4Plan);
        break;
    }
  });
  // The provenance array is exactly the derived scene record followed by one
  // record per entity in validated enumerate order — no extra, missing,
  // reordered, or unreferenced records: a producer-chosen record could
  // otherwise carry an arbitrary suffix into browser JSON.
  const entityIndexById = new Map(scene.entities.map((entity, index) => [entity.id, index]));
  const expectedProvenanceIds = [
    fastManimSnapshotSceneProvenanceIdV1(sceneId),
    ...scene.entities.map((_, index) => fastManimSnapshotEntityProvenanceIdV1(sceneId, index)),
    ...(snapshotVersion === 2
      ? scene.animationChannels.map((channel) => {
          if (
            channel.kind !== "affine-transform" &&
            channel.kind !== "motion-path" &&
            channel.kind !== "opacity" &&
            channel.kind !== "path-morph" &&
            channel.kind !== "path-trim"
          ) {
            profileViolation(
              "Dynamic profile V2 accepts only affine-transform, motion-path, opacity, path-morph, and path-trim animation channels.",
            );
          }
          const entityIndex = entityIndexById.get(channel.entityId);
          if (entityIndex === undefined) {
            profileViolation("Dynamic animation channels must target a validated Scene entity.");
          }
          if (channel.kind === "affine-transform") {
            return fastManimSnapshotAffineTransformChannelProvenanceIdV2(sceneId, entityIndex);
          }
          if (channel.kind === "motion-path") {
            return fastManimSnapshotMotionPathChannelProvenanceIdV2(sceneId, entityIndex);
          }
          if (channel.kind === "opacity") {
            return fastManimSnapshotOpacityChannelProvenanceIdV2(sceneId, entityIndex);
          }
          if (channel.kind === "path-morph") {
            return fastManimSnapshotPathMorphChannelProvenanceIdV2(sceneId, entityIndex);
          }
          if (channel.kind === "path-trim") {
            return fastManimSnapshotPathTrimChannelProvenanceIdV2(sceneId, entityIndex);
          }
          profileViolation("Dynamic animation channel provenance requires one supported channel kind.");
        })
      : []),
  ];
  if (
    scene.provenance.length !== expectedProvenanceIds.length ||
    scene.provenance.some((record, index) => record.id !== expectedProvenanceIds[index])
  ) {
    profileViolation(
      snapshotVersion !== 2
        ? "Static profile provenance must be exactly the derived scene and per-entity records in order."
        : "Dynamic profile V2 provenance must be exactly the derived scene, per-entity, and per-animation-channel records in order.",
    );
  }
  if (snapshotVersion === 3 && mode === "producer") assertHermeticMathTexProfileProvenanceV3(scene);
  if (snapshotVersion === 4 && mode === "producer") {
    assertHermeticPngProfileProvenanceV4(scene, bundle.assets.assets[0]!);
  }
}

function fastManimSnapshotProvenanceEvidence(
  snapshotVersion: FastManimSnapshotProfileVersionV1,
):
  | typeof FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1
  | typeof FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2
  | typeof FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V3
  | typeof FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V4 {
  switch (snapshotVersion) {
    case 1:
      return FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1;
    case 2:
      return FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2;
    case 3:
      return FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V3;
    case 4:
      return FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V4;
  }
}

async function parseFastManimSnapshotResultV1(
  value: unknown,
  expectedValue: ExpectedFastManimSnapshotCorrelationV1,
  mode: "producer" | "sealed",
  sourceText?: string,
): Promise<VerifiedFastManimSnapshotResultV1> {
  const expected = expectedFastManimSnapshotCorrelationV1Schema.parse(expectedValue);
  assertBoundedPlainJson(value);
  const result = fastManimSnapshotResultV1Schema.parse(value);
  assertCorrelation(result, expected);
  if (result.kind === "unsupported") {
    return { ...result, issues: normalizeUnsupportedIssuesV1(result.issues) };
  }
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
    source.snapshotVersion !== expected.snapshotVersion ||
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
  let hermeticPngV4Plan = expected.hermeticPngV4Plan;
  if (expected.snapshotVersion === 4 && mode === "producer" && sourceText !== undefined) {
    if (createHash("sha256").update(sourceText, "utf8").digest("hex") !== expected.sourceHash) {
      throw new FastManimSnapshotContractError(
        "correlation-mismatch",
        "The server-held PNG source does not match the expected source digest.",
      );
    }
    const derivedPlan = deriveHermeticPngV4TransformPlan(sourceText, expected.sceneName);
    if (hermeticPngV4Plan && !sameHermeticPngV4TransformPlan(hermeticPngV4Plan, derivedPlan)) {
      profileViolation("The retained PNG transform plan does not match the server-held source.");
    }
    hermeticPngV4Plan = derivedPlan;
  } else if (expected.snapshotVersion === 4 && mode === "producer" && hermeticPngV4Plan) {
    profileViolation("A retained PNG transform plan requires the exact server-held source during sealing.");
  }
  assertFastManimSnapshotProfileV1(bundle, expected.frame, expected.snapshotVersion, mode, hermeticPngV4Plan);
  // Structural normalization before sealing: provenance evidence is replaced
  // with server-owned text, so the sealed digest never covers producer free
  // text. Re-normalizing an already-normalized stored bundle is a no-op, which
  // keeps the sealed digest comparison meaningful in "sealed" mode.
  const normalizedBundle = await parseVerifiedSceneIrBundleV1({
    ...bundle,
    scene: {
      ...bundle.scene,
      provenance: bundle.scene.provenance.map((record) => ({
        evidence: [fastManimSnapshotProvenanceEvidence(expected.snapshotVersion)],
        id: record.id,
        origin: record.origin,
      })),
    },
  });
  const snapshotHash = digestFastManimSnapshotBundleV1(normalizedBundle);
  if (result.snapshotHash !== ZERO_SHA256 && snapshotHash !== result.snapshotHash) {
    throw new FastManimSnapshotContractError(
      "snapshot-digest-mismatch",
      "The compiled fast-manim Scene does not match its canonical snapshot digest.",
    );
  }
  if (mode === "sealed") return { ...result, bundle: normalizedBundle };

  const sealedBundle = await parseVerifiedSceneIrBundleV1({
    ...normalizedBundle,
    scene: { ...normalizedBundle.scene, source: { ...source, snapshotHash } },
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
  sourceText?: string,
) {
  return parseFastManimSnapshotResultV1(parseProducerJson(value), expected, "producer", sourceText);
}

/** Revalidates a previously server-sealed result and rejects a zero-hash downgrade. */
export function parseVerifiedFastManimSnapshotResultV1(
  value: unknown,
  expected: ExpectedFastManimSnapshotCorrelationV1,
) {
  return parseFastManimSnapshotResultV1(value, expected, "sealed");
}

export type FastManimSnapshotRuntimeCapabilityV1 = z.infer<typeof sceneCapabilityV1Schema>;

/**
 * Scene capabilities this server runtime honors end to end. A deliberately
 * conservative allowlist, NOT the schema capability universe: every entry
 * needs proven evaluator + renderer coverage, so adding a capability to the
 * Scene IR schema must never silently claim support here. The static profile
 * lowers Circle, Rectangle, and Line to cubic paths; V2 additionally admits
 * the strictly verified affine-transform, motion-path, opacity, path-morph,
 * and path-trim slices.
 */
export const FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1 = Object.freeze([
  "affine-transform-animation",
  "cubic-path-geometry",
  "motion-path-animation",
  "opacity-animation",
  "path-morph-animation",
  "path-trim-animation",
  "shape-primitives",
] as const satisfies readonly FastManimSnapshotRuntimeCapabilityV1[]);

export const MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Deterministic bounded ASCII Scene identity. Studio source paths are Unicode
 * and up to 500 characters, while engine source identities are portable ASCII
 * capped at 240, so the wire sceneId is derived by hashing the logical
 * coordinates. Content identity only: requestId and projectId must never be
 * mixed into this digest. Producers recompute and verify this exact rule.
 */
export function fastManimSnapshotSceneIdV1(sourcePath: string, sceneName: string) {
  const parsedSourcePath = manimSourcePathSchema.parse(sourcePath);
  const parsedSceneName = sceneNameSchema.parse(sceneName);
  return `scene:${createHash("sha256").update(`${parsedSourcePath}\u0000${parsedSceneName}`, "utf8").digest("hex")}`;
}

export const fastManimSnapshotRuntimeConfigV1Schema = z
  .object({
    capabilities: z
      .array(sceneCapabilityV1Schema)
      .min(1)
      .max(sceneCapabilityV1Schema.options.length)
      .refine((capabilities) => capabilities.every((entry, index) => index === 0 || capabilities[index - 1]! < entry), {
        message: "Runtime capabilities must be sorted and unique.",
      }),
    frame: snapshotFrameSchema,
    // Mutual determinism contract with the fast-manim CLI: the v1 profile
    // pins the canonical random seed to exactly 0 (and the producer runs
    // under PYTHONHASHSEED=0), so identical inputs digest and lower
    // identically across runs and runtimes. Any other value is a schema
    // violation, not a configuration choice.
    randomSeed: z.literal(0),
    schema: z.literal(FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1),
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((config, context) => {
    const declaresPng = config.capabilities.includes("png-image");
    if (config.snapshotVersion === 4) {
      if (config.capabilities.length !== 1 || !declaresPng) {
        context.addIssue({
          code: "custom",
          message: "Hermetic PNG profile V4 runtime requests must declare exactly png-image.",
          path: ["capabilities"],
        });
      }
    } else if (declaresPng) {
      context.addIssue({
        code: "custom",
        message: "Only hermetic PNG profile V4 runtime requests may declare png-image.",
        path: ["capabilities"],
      });
    }
  });

export type FastManimSnapshotRuntimeConfigV1 = z.infer<typeof fastManimSnapshotRuntimeConfigV1Schema>;

/**
 * Cross-runtime canonical scalar for finite IEEE-754 doubles: "f64:" followed
 * by the 16 lower-case hex digits of the big-endian bit pattern. This spells
 * -0, subnormals, exponent-threshold values, and large finites identically in
 * every runtime — Python producers must use "f64:" + struct.pack(">d", x).hex()
 * — so no digest ever depends on a language's decimal number formatting.
 */
export function canonicalF64HexV1(value: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Cross-runtime scalar canonicalization requires a finite number.");
  }
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value, 0);
  return `f64:${buffer.toString("hex")}`;
}

/**
 * Canonical digest binding a snapshot run to the runtime capability surface it
 * executed under. Every non-integer scalar in the digest input is encoded via
 * canonicalF64HexV1 before canonical JSON, because JSON.stringify and Python's
 * json.dumps disagree on number spelling (e.g. 1e-7 versus 1e-07); the
 * remaining fields are strings and literal small integers, which are spelled
 * identically across runtimes.
 */
export function digestFastManimSnapshotRuntimeConfigV1(config: FastManimSnapshotRuntimeConfigV1) {
  const parsed = fastManimSnapshotRuntimeConfigV1Schema.parse(config);
  const digestInput = {
    ...parsed,
    frame: {
      height: canonicalF64HexV1(parsed.frame.height),
      width: canonicalF64HexV1(parsed.frame.width),
    },
  };
  return createHash("sha256").update(canonicalJsonV1(digestInput)).digest("hex");
}

export const fastManimSnapshotRunRequestV1Schema = z
  .object({
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    sceneName: sceneNameSchema,
    sourceHash: sha256V1Schema.optional(),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

export const fastManimSnapshotQueryV1Schema = z
  .object({
    sceneName: sceneNameSchema,
    sourcePath: manimSourcePathSchema,
  })
  .strict();

/**
 * Wire request the Studio server writes to a producer's stdin. This is the
 * seam for Poietra/fast-manim#4, and every derived field is verifiable from
 * the request itself so nothing can be blindly echoed:
 * - `runtimeConfig` is the canonical object; the producer recomputes
 *   `runtimeConfigHash` from the same canonical JSON and refuses a mismatch.
 * - `sourceText` is the immutable UTF-8 source the producer must compile
 *   (never re-open `sourcePath`, which would allow change-execute-restore
 *   ABA swaps); both sides recompute `sourceHash` from these exact bytes.
 * - `sceneId` is the deterministic bounded ASCII identity
 *   scene:sha256(sourcePath + NUL + sceneName); the producer re-derives it.
 */
export const fastManimSnapshotProducerRequestV1Schema = z
  .object({
    ...correlationShape,
    runtimeConfig: fastManimSnapshotRuntimeConfigV1Schema,
    schema: z.literal(FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1),
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema,
    sourceText: z
      .string()
      .refine((sourceText) => Buffer.byteLength(sourceText, "utf8") <= MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES, {
        message: `Producer request source text accepts at most ${MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES} UTF-8 bytes.`,
      }),
    version: z.literal(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (digestFastManimSnapshotRuntimeConfigV1(request.runtimeConfig) !== request.runtimeConfigHash) {
      context.addIssue({
        code: "custom",
        message: "Producer request runtime config does not match its canonical digest.",
        path: ["runtimeConfigHash"],
      });
    }
    if (request.runtimeConfig.snapshotVersion !== request.snapshotVersion) {
      context.addIssue({
        code: "custom",
        message: "Producer request runtime config declares a different snapshot version.",
        path: ["snapshotVersion"],
      });
    }
    if (createHash("sha256").update(request.sourceText, "utf8").digest("hex") !== request.sourceHash) {
      context.addIssue({
        code: "custom",
        message: "Producer request source text does not match its source hash.",
        path: ["sourceHash"],
      });
    }
    if (fastManimSnapshotSceneIdV1(request.sourcePath, request.sceneName) !== request.sceneId) {
      context.addIssue({
        code: "custom",
        message: "Producer request scene ID does not match its canonical derivation.",
        path: ["sceneId"],
      });
    }
  });

export const fastManimSnapshotRunFailureCodeV1Schema = z.enum([
  "asset-changed",
  "asset-unavailable",
  "capability-unsupported",
  "producer-exit",
  "producer-output-overflow",
  "producer-spawn-failed",
  "producer-timeout",
  "producer-unconfigured",
  "result-rejected",
  "runtime-config-changed",
  "sandbox-attestation-rejected",
  "sandbox-execution-failed",
  "sandbox-result-rejected",
  "sandbox-unavailable",
  "snapshot-too-large",
  "source-changed",
  "source-correlation-stale",
]);

export const fastManimSnapshotFallbackV1Schema = z.object({ kind: z.literal("server-authoritative-render") }).strict();

export const FAST_MANIM_SNAPSHOT_FALLBACK_V1 = Object.freeze({
  kind: "server-authoritative-render",
} as const) satisfies z.infer<typeof fastManimSnapshotFallbackV1Schema>;

const runViewBaseShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneName: sceneNameSchema,
  schema: z.literal(FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1),
  sourcePath: manimSourcePathSchema,
  version: z.literal(1),
};

/**
 * Publication envelope for the snapshot endpoint. Verified snapshots are the
 * only variant carrying a bundle and the wire schema itself requires a
 * compiled result (an unsupported result can never ride a "verified" status);
 * unsupported views carry only normalized server-owned issues; failures carry
 * a bounded structured reason and an explicit server-authoritative fallback
 * instruction.
 */
export const fastManimSnapshotRunViewV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      ...runViewBaseShape,
      publishedAt: z.iso.datetime(),
      revision: z.number().int().positive(),
      snapshot: fastManimSnapshotCompiledResultV1Schema,
      sourceRuntimeIdentity: verifiedSourceRuntimeIdentityMapV1Schema.optional(),
      status: z.literal("verified"),
    })
    .strict(),
  z
    .object({
      ...runViewBaseShape,
      fallback: fastManimSnapshotFallbackV1Schema,
      issues: fastManimSnapshotNormalizedIssuesV1Schema,
      status: z.literal("unsupported"),
    })
    .strict(),
  z
    .object({
      ...runViewBaseShape,
      failure: z
        .object({
          code: fastManimSnapshotRunFailureCodeV1Schema,
          contractCode: fastManimSnapshotContractErrorCodeV1Schema.optional(),
          message: z.string().min(1).max(500),
        })
        .strict(),
      fallback: fastManimSnapshotFallbackV1Schema,
      status: z.literal("failed"),
    })
    .strict(),
  z
    .object({
      ...runViewBaseShape,
      fallback: fastManimSnapshotFallbackV1Schema,
      revision: z.number().int().positive(),
      status: z.literal("stale"),
    })
    .strict(),
]);

const HOST_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'`([{=:;,<>|])\/(?:home|usr|var|tmp|etc|opt|private|users|root|mnt|srv|proc|dev)\//i,
  /\b[a-z]:[\\/][^\s\\/:*?"<>|]/i,
  /\\\\[a-z0-9._$-]+\\/i,
  /file:\/\//i,
];
const MAX_SOURCE_FRAGMENT_PROBES = 64;
const MIN_SOURCE_FRAGMENT_LENGTH = 16;

function collectStringsV1(value: unknown, sink: string[]) {
  if (typeof value === "string") {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringsV1(entry, sink);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringsV1(entry, sink);
  }
}

/**
 * Rejects producer free text (unsupported issues, provenance evidence, IDs,
 * and any other string in the result) that would leak host details to the
 * browser: absolute POSIX or Windows paths, the canonical project root or
 * source absolute path, or raw source fragments. The only host coordinate a
 * result may carry is the logical relative sourcePath. All server-side
 * diagnostics stay in bounded server-owned failure messages instead.
 */
export function assertFastManimSnapshotDiagnosticsSafeV1(
  payload: unknown,
  context: Readonly<{ projectRoot?: string; sourceAbsolutePath?: string; sourceText?: string }>,
) {
  const reject = (): never => {
    throw new FastManimSnapshotContractError(
      "diagnostic-leak",
      "The fast-manim snapshot result contains host path or raw source diagnostics.",
    );
  };
  const literals = [context.projectRoot, context.sourceAbsolutePath].filter(
    (literal): literal is string => typeof literal === "string" && literal.length > 0,
  );
  const fragments: string[] = [];
  for (const line of context.sourceText?.split(/\r?\n/) ?? []) {
    if (fragments.length >= MAX_SOURCE_FRAGMENT_PROBES) break;
    const fragment = line.trim();
    if (fragment.length >= MIN_SOURCE_FRAGMENT_LENGTH) fragments.push(fragment);
  }
  const strings: string[] = [];
  collectStringsV1(payload, strings);
  for (const value of strings) {
    for (const literal of literals) {
      if (value.includes(literal)) reject();
    }
    for (const pattern of HOST_PATH_PATTERNS) {
      if (pattern.test(value)) reject();
    }
    if (value.length >= MIN_SOURCE_FRAGMENT_LENGTH) {
      for (const fragment of fragments) {
        if (value.includes(fragment)) reject();
      }
    }
  }
}

export type FastManimSnapshotProducerRequestV1 = z.infer<typeof fastManimSnapshotProducerRequestV1Schema>;
export type FastManimSnapshotQueryV1 = z.infer<typeof fastManimSnapshotQueryV1Schema>;
export type FastManimSnapshotRunFailureCodeV1 = z.infer<typeof fastManimSnapshotRunFailureCodeV1Schema>;
export type FastManimSnapshotRunRequestV1 = z.infer<typeof fastManimSnapshotRunRequestV1Schema>;
export type FastManimSnapshotRunViewV1 = z.infer<typeof fastManimSnapshotRunViewV1Schema>;
export type { VerifiedSourceRuntimeIdentityMapV1 };
