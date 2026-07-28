import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceV1Schema,
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

export const fastManimSnapshotProfileVersionV1Schema = z.union([z.literal(1), z.literal(2)]);
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
    // Durable V1 publications predate this correlation field. Treat only an
    // omitted stored value as V1; an explicit unsupported value still fails.
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema.default(1),
  })
  .strict();

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

/** The exact static Scene duration the v1 exporter emits. */
export const FAST_MANIM_SNAPSHOT_STATIC_DURATION_SECONDS_V1 = 1;

type StaticProfileEntity = SceneIrBundleV1["scene"]["entities"][number];
type StaticProfilePoint = Readonly<{ x: number; y: number }>;
type StaticProfileSegment = Readonly<{
  control1: StaticProfilePoint;
  control2: StaticProfilePoint;
  end: StaticProfilePoint;
}>;

const MAX_STATIC_PROFILE_CLOSED_SEGMENTS = 16;
const STATIC_PROFILE_RELATIVE_TOLERANCE = 1e-9;
const MAX_CANONICAL_LINE_CONTROL_ULPS_V1 = 1n;
const F64_SIGN_MASK = 1n << 63n;
const F64_BIT_MASK = (1n << 64n) - 1n;

function canonicalLineControl(start: StaticProfilePoint, end: StaticProfilePoint, factor: number) {
  return { x: start.x + (end.x - start.x) * factor, y: start.y + (end.y - start.y) * factor };
}

function orderedFiniteF64Bits(value: number) {
  const bits = BigInt(`0x${canonicalF64HexV1(value).slice(4)}`);
  return (bits & F64_SIGN_MASK) === 0n ? bits | F64_SIGN_MASK : F64_BIT_MASK ^ bits;
}

function finiteF64sWithinOneUlp(left: number, right: number) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const leftBits = orderedFiniteF64Bits(left);
  const rightBits = orderedFiniteF64Bits(right);
  const distance = leftBits >= rightBits ? leftBits - rightBits : rightBits - leftBits;
  return distance <= MAX_CANONICAL_LINE_CONTROL_ULPS_V1;
}

/** Mirrors the Rust WGPU stroke slice's finite canonical-Line predicate. */
export function isCanonicalFastManimLineSegmentV1(start: StaticProfilePoint, segment: StaticProfileSegment) {
  if (
    ![start.x, start.y, segment.end.x, segment.end.y].every(Number.isFinite) ||
    (start.x === segment.end.x && start.y === segment.end.y)
  )
    return false;
  const control1 = canonicalLineControl(start, segment.end, 1 / 3);
  const control2 = canonicalLineControl(start, segment.end, 2 / 3);
  return (
    finiteF64sWithinOneUlp(segment.control1.x, control1.x) &&
    finiteF64sWithinOneUlp(segment.control1.y, control1.y) &&
    finiteF64sWithinOneUlp(segment.control2.x, control2.x) &&
    finiteF64sWithinOneUlp(segment.control2.y, control2.y)
  );
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

function assertStaticProfileEntity(entity: StaticProfileEntity) {
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
  if (stroke.cap !== "butt" || stroke.join !== "miter" || stroke.miterLimit !== 10) {
    profileViolation("Static profile strokes must use the canonical butt/miter/10 stroke shape.");
  }
  if (stroke.color.alpha <= 0) {
    profileViolation("Static profile strokes must be visible (non-zero alpha).");
  }
  if (subpath.segments.length !== 1 || !isCanonicalFastManimLineSegmentV1(subpath.start, subpath.segments[0]!)) {
    profileViolation("Static profile open paths must be one finite canonical 1/3–2/3 Line cubic (±1 f64 ULP).");
  }
}

/**
 * The v1 static snapshot profile: the only Scene shape the renderer provably
 * supports end to end (static filled convex closed paths lowered from Circle
 * and Rectangle, stroked Lines with canonical 1/3–2/3 cubic controls (±1
 * ordered-f64 ULP), no animation channels, exact
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
) {
  const { scene } = bundle;
  const sceneId = scene.sceneId;
  if (scene.fidelity.kind !== "exact") profileViolation("Static profile Scenes must report exact fidelity.");
  if (bundle.assets.assets.length > 0) profileViolation("Static profile Scenes must use an empty asset manifest.");
  if (bundle.assets.manifestId !== fastManimSnapshotManifestIdV1(sceneId)) {
    profileViolation("The asset manifest ID must be the exact derived Scene manifest identifier.");
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
  // V1 remains the exact one-second still contract. V2 adds only a bounded
  // frozen final wait; animation channels and mutable geometry remain out of
  // profile until their runtime evidence is independently proven.
  if (snapshotVersion === 1 && scene.duration !== FAST_MANIM_SNAPSHOT_STATIC_DURATION_SECONDS_V1) {
    profileViolation("Static profile Scenes must report exactly the canonical 1-second static duration.");
  }
  if (snapshotVersion === 2 && scene.duration > MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2) {
    profileViolation(`Variable-duration snapshots accept at most ${MAX_FAST_MANIM_SNAPSHOT_DURATION_SECONDS_V2}s.`);
  }
  if (scene.animationChannels.length > 0) {
    profileViolation("Static profile Scenes must not carry animation channels.");
  }
  const expectedCapabilities = scene.entities.length > 0 ? ["cubic-path-geometry"] : [];
  if (
    scene.requiredCapabilities.length !== expectedCapabilities.length ||
    scene.requiredCapabilities.some((capability, index) => capability !== expectedCapabilities[index])
  ) {
    profileViolation("Static profile Scenes must require exactly cubic-path-geometry, or nothing when empty.");
  }
  // Entities are the exporter's enumerate order: each sceneOrder must equal
  // its array index, contiguous from 0 — duplicates, gaps, and reordering are
  // all rejected — and every derived identifier below is anchored to this
  // validated order, never to a producer-chosen number.
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
    if (entity.lifetimes.length !== 1 || lifetime?.start !== 0 || lifetime.end !== scene.duration) {
      profileViolation("Static profile entities must live for exactly the full static duration.");
    }
    const { m11, m12, m21, m22, tx, ty } = entity.transform;
    if (m11 !== 1 || m12 !== 0 || m21 !== 0 || m22 !== 1 || tx !== 0 || ty !== 0) {
      profileViolation("Static profile entities must use the identity transform.");
    }
    assertStaticProfileEntity(entity);
  });
  // The provenance array is exactly the derived scene record followed by one
  // record per entity in validated enumerate order — no extra, missing,
  // reordered, or unreferenced records: a producer-chosen record could
  // otherwise carry an arbitrary suffix into browser JSON.
  const expectedProvenanceIds = [
    fastManimSnapshotSceneProvenanceIdV1(sceneId),
    ...scene.entities.map((_, index) => fastManimSnapshotEntityProvenanceIdV1(sceneId, index)),
  ];
  if (
    scene.provenance.length !== expectedProvenanceIds.length ||
    scene.provenance.some((record, index) => record.id !== expectedProvenanceIds[index])
  ) {
    profileViolation("Static profile provenance must be exactly the derived scene and per-entity records in order.");
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
  assertFastManimSnapshotProfileV1(bundle, expected.frame, expected.snapshotVersion);
  // Structural normalization before sealing: provenance evidence is replaced
  // with server-owned text, so the sealed digest never covers producer free
  // text. Re-normalizing an already-normalized stored bundle is a no-op, which
  // keeps the sealed digest comparison meaningful in "sealed" mode.
  const normalizedBundle = await parseVerifiedSceneIrBundleV1({
    ...bundle,
    scene: {
      ...bundle.scene,
      provenance: bundle.scene.provenance.map((record) => ({
        evidence: [
          expected.snapshotVersion === 1
            ? FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1
            : FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
        ],
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

export type FastManimSnapshotRuntimeCapabilityV1 = z.infer<typeof sceneCapabilityV1Schema>;

/**
 * Scene capabilities this server runtime honors end to end. A deliberately
 * conservative allowlist, NOT the schema capability universe: every entry
 * needs proven evaluator + renderer coverage, so adding a capability to the
 * Scene IR schema must never silently claim support here. The fast-manim#4
 * initial profile lowers Circle, Rectangle, and Line to cubic paths and
 * reports cubic-path-geometry.
 */
export const FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1 = Object.freeze([
  "cubic-path-geometry",
  "opacity-animation",
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
  .strict();

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
