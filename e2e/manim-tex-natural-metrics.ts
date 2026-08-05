import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COLOR = z.string().regex(/^#[0-9A-F]{6}$/);
const COORDINATE = z.number().finite().min(-1_000).max(1_000);
const DIMENSION = z.number().finite().positive().max(1_000);
const TOLERANCE = 2e-10;

export const MANIM_TEX_NATURAL_METRICS_ROOT_V1 = "fixtures/manim-tex-natural-metrics-v1";
export const MANIM_TEX_NATURAL_METRICS_GENERATOR_V1 = "scripts/generate-manim-tex-natural-metrics.py";

function near(left: number, right: number) {
  return Math.abs(left - right) <= TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

const boundsSchema = z
  .strictObject({ bottom: COORDINATE, left: COORDINATE, right: COORDINATE, top: COORDINATE })
  .refine(({ left, right }) => right > left, "bounds width must be positive")
  .refine(({ bottom, top }) => top > bottom, "bounds height must be positive");

const geometryShape = {
  anchorBounds: boundsSchema,
  center: z.strictObject({ x: COORDINATE, y: COORDINATE, z: z.literal(0) }),
  size: z.strictObject({ height: DIMENSION, width: DIMENSION }),
  tightBounds: boundsSchema,
} as const;

const geometryObjectSchema = z.strictObject(geometryShape);
type GeometryShapeV1 = z.infer<typeof geometryObjectSchema>;

function refineGeometry({ anchorBounds, center, size, tightBounds }: GeometryShapeV1, context: z.RefinementCtx) {
  const expectations = [
    [size.width, anchorBounds.right - anchorBounds.left, "size.width"],
    [size.height, anchorBounds.top - anchorBounds.bottom, "size.height"],
    [center.x, (anchorBounds.left + anchorBounds.right) / 2, "center.x"],
    [center.y, (anchorBounds.bottom + anchorBounds.top) / 2, "center.y"],
  ] as const;
  for (const [actual, expected, label] of expectations) {
    if (!near(actual, expected)) context.addIssue({ code: "custom", message: `${label} contradicts anchor bounds` });
  }
  const containment = [
    [tightBounds.left, anchorBounds.left, true, "tightBounds.left"],
    [tightBounds.right, anchorBounds.right, false, "tightBounds.right"],
    [tightBounds.bottom, anchorBounds.bottom, true, "tightBounds.bottom"],
    [tightBounds.top, anchorBounds.top, false, "tightBounds.top"],
  ] as const;
  for (const [outer, inner, lower, label] of containment) {
    if ((lower ? outer > inner : outer < inner) && !near(outer, inner)) {
      context.addIssue({ code: "custom", message: `${label} does not contain the corresponding anchor bound` });
    }
  }
}

const geometrySchema = geometryObjectSchema.superRefine(refineGeometry);

const familySchema = z
  .strictObject({
    ...geometryShape,
    familyPath: z.array(z.number().int().nonnegative().max(4_095)).min(1).max(64),
    kind: z.enum(["glyph", "rule"]),
    order: z.number().int().nonnegative().max(4_095),
    paint: z.strictObject({
      fillColor: COLOR,
      fillOpacity: z.number().finite().min(0).max(1),
      strokeColor: COLOR,
      strokeOpacity: z.number().finite().min(0).max(1),
      strokeWidth: z.number().finite().nonnegative().max(1_000),
    }),
    pointCount: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .refine((count) => count % 4 === 0),
    pointsSha256: SHA256,
    runtimeType: z.string().min(1).max(256),
  })
  .superRefine((family, context) => {
    refineGeometry(family, context);
    const expectedRuntimeType =
      family.kind === "glyph"
        ? "manim.mobject.svg.svg_mobject.VMobjectFromSVGPath"
        : "manim.mobject.geometry.polygram.Rectangle";
    if (family.runtimeType !== expectedRuntimeType) {
      context.addIssue({ code: "custom", message: `${family.kind} has an unexpected Manim runtime type` });
    }
  });

const metricSnapshotSchema = z
  .strictObject({
    ...geometryShape,
    families: z.array(familySchema).min(1).max(4_096),
    familyCount: z.number().int().positive().max(4_096),
  })
  .superRefine((snapshot, context) => {
    const { families, familyCount } = snapshot;
    refineGeometry(snapshot, context);
    if (families.length !== familyCount) context.addIssue({ code: "custom", message: "familyCount is inconsistent" });
    for (const [index, family] of families.entries()) {
      if (family.order !== index) context.addIssue({ code: "custom", message: "family order must be contiguous" });
    }
    for (const key of ["anchorBounds", "tightBounds"] as const) {
      const union = {
        bottom: Math.min(...families.map((family) => family[key].bottom)),
        left: Math.min(...families.map((family) => family[key].left)),
        right: Math.max(...families.map((family) => family[key].right)),
        top: Math.max(...families.map((family) => family[key].top)),
      };
      for (const edge of ["bottom", "left", "right", "top"] as const) {
        if (!near(snapshot[key][edge], union[edge])) {
          context.addIssue({ code: "custom", message: `root ${key}.${edge} contradicts the family union` });
        }
      }
    }
  });

const constructorSchema = z.strictObject({
  argSeparator: z.string().max(16),
  colorMap: z.array(z.strictObject({ color: COLOR, literal: z.string().min(1).max(1_024) })).max(64),
  fontSize: z.number().finite().positive().max(1_000),
  kind: z.enum(["mathtex", "tex"]),
  texEnvironment: z.string().min(1).max(64),
  texParts: z.array(z.string().min(1).max(16_384)).min(1).max(64),
});

const sourceTransformSchema = z.strictObject({
  scale: z.number().finite().positive().max(1_000),
  shift: z.strictObject({ x: COORDINATE, y: COORDINATE }),
});

function caseSchema(id: string) {
  return z.strictObject({
    constructor: constructorSchema,
    id: z.literal(id),
    naturalMetrics: metricSnapshotSchema,
    sourceSvg: z.strictObject({ byteLength: z.number().int().positive().max(16_000_000), sha256: SHA256 }),
    sourceTransform: sourceTransformSchema,
    worldMetrics: metricSnapshotSchema,
  });
}

const layoutChildSchema = z.strictObject({
  ...geometryShape,
  caseId: z.enum(["official-write-stuff-tex", "official-write-stuff-mathtex"]),
});
const layoutStageSchema = z.strictObject({
  children: z.tuple([layoutChildSchema, layoutChildSchema]),
  group: geometrySchema,
});

export const manimTexNaturalMetricsReferenceV1Schema = z.strictObject({
  cases: z.tuple([
    caseSchema("pi-default-48"),
    caseSchema("pi-explicit-72"),
    caseSchema("pi-scale-7-shift"),
    caseSchema("official-write-stuff-tex"),
    caseSchema("official-write-stuff-mathtex"),
  ]),
  generator: z.strictObject({ path: z.literal(MANIM_TEX_NATURAL_METRICS_GENERATOR_V1), sha256: SHA256 }),
  layout: z.strictObject({
    afterArrange: layoutStageSchema,
    afterWidth: layoutStageSchema,
    arrange: z.strictObject({
      buffer: z.number().finite().nonnegative().max(100),
      center: z.literal(true),
      direction: z.strictObject({ x: z.literal(0), y: z.literal(-1) }),
    }),
    frameWidth: DIMENSION,
    id: z.literal("official-write-stuff"),
    largeBuffer: z.number().finite().nonnegative().max(100),
    targetWidth: DIMENSION,
    uniformScale: z.number().finite().positive().max(1_000),
  }),
  metricContract: z.strictObject({
    anchorBounds: z.literal("VMobject family cubic start/end anchors"),
    coordinateDecimals: z.literal(12),
    coordinateSpace: z.literal("manim-scene-units"),
    fontSizeScaling: z.literal("reference bounds multiplied by requestedFontSize / 48 before source transforms"),
    naturalSize: z.literal("case naturalMetrics.size before source transforms, from Mobject width/height"),
    referenceFontSize: z.literal(48),
    sourceTransformOrder: z.literal("constructor-font-size -> source-scale -> source-shift -> group-layout"),
    tightBounds: z.literal("analytic cubic extrema over family_members_with_points"),
  }),
  producer: z.strictObject({
    defaultFontSize: z.literal(48),
    fastManimCommit: z.literal("842cdecc97a5ba32c2a30e0254c5f5dcd74382f0"),
    fastManimTree: z.literal("6fad77addc72e1a97440265e27d02630cf5b37b4"),
    identitySha256: SHA256,
    manimVersion: z.string().min(1).max(64),
    numpyVersion: z.string().min(1).max(64),
    pythonExecutableSha256: SHA256,
    pythonImplementation: z.literal("CPython"),
    pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    sceneConfig: z.strictObject({ frameHeight: z.literal(8), frameWidth: z.literal(128 / 9) }),
    texTemplate: z.strictObject({ bodySha256: SHA256, compiler: z.literal("latex"), outputFormat: z.literal(".dvi") }),
    texToolchain: z.strictObject({
      dvisvgm: z.strictObject({ executableSha256: SHA256, version: z.string().min(1).max(256) }),
      latex: z.strictObject({ executableSha256: SHA256, version: z.string().min(1).max(256) }),
    }),
    uvLockSha256: SHA256,
  }),
  reproducibility: z.strictObject({
    environment: z.strictObject({ PYTHONHASHSEED: z.literal("0") }),
    seeds: z.strictObject({ numpy: z.literal(0), pythonRandom: z.literal(0) }),
  }),
  schema: z.literal("poietra.manim-tex-natural-metrics-reference"),
  source: z.strictObject({
    classClosureSha256: z.literal("83c3d356c18305086c551fdb8f718b1683ba8fcc0fb44bf070dd98695ef81247"),
    className: z.literal("WriteStuff"),
    repository: z.literal("Poietra/fast-manim"),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: z.literal("d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"),
  }),
  version: z.literal(1),
});

export type ManimTexNaturalMetricsReferenceV1 = z.infer<typeof manimTexNaturalMetricsReferenceV1Schema>;
type GeometryV1 = z.infer<typeof geometrySchema>;
type SnapshotV1 = z.infer<typeof metricSnapshotSchema>;

function requireNear(actual: number, expected: number, label: string) {
  if (!near(actual, expected)) throw new Error(`${label} is ${actual}, expected ${expected}`);
}

function requireEqual(actual: unknown, expected: unknown, label: string) {
  if (canonicalJsonV1(actual) !== canonicalJsonV1(expected)) throw new Error(`${label} is inconsistent`);
}

function requireGeometryTransform(
  actual: GeometryV1,
  source: GeometryV1,
  scale: number,
  shiftX: number,
  shiftY: number,
  label: string,
) {
  for (const key of ["anchorBounds", "tightBounds"] as const) {
    for (const edge of ["left", "right"] as const) {
      requireNear(actual[key][edge], source[key][edge] * scale + shiftX, `${label} ${key}.${edge}`);
    }
    for (const edge of ["bottom", "top"] as const) {
      requireNear(actual[key][edge], source[key][edge] * scale + shiftY, `${label} ${key}.${edge}`);
    }
  }
  requireNear(actual.size.width, source.size.width * scale, `${label} width`);
  requireNear(actual.size.height, source.size.height * scale, `${label} height`);
  requireNear(actual.center.x, source.center.x * scale + shiftX, `${label} center.x`);
  requireNear(actual.center.y, source.center.y * scale + shiftY, `${label} center.y`);
}

function requireSnapshotTransform(
  actual: SnapshotV1,
  source: SnapshotV1,
  scale: number,
  shiftX: number,
  shiftY: number,
  label: string,
) {
  requireGeometryTransform(actual, source, scale, shiftX, shiftY, label);
  requireEqual(actual.familyCount, source.familyCount, `${label} familyCount`);
  for (const [index, family] of actual.families.entries()) {
    const sourceFamily = source.families[index];
    if (!sourceFamily) throw new Error(`${label} family ${index} is missing`);
    requireGeometryTransform(family, sourceFamily, scale, shiftX, shiftY, `${label} family ${index}`);
    for (const key of ["familyPath", "kind", "order", "paint", "pointCount", "runtimeType"] as const) {
      requireEqual(family[key], sourceFamily[key], `${label} family ${index} ${key}`);
    }
  }
}

function verifySemantics(reference: ManimTexNaturalMetricsReferenceV1) {
  const [pi48, pi72, piTransformed, officialText, officialMath] = reference.cases;
  const expectedTransforms = [
    [1, 0, 0],
    [1, 0, 0],
    [7, -2.25, 1.5],
    [1, 0, 0],
    [1, 0, 0],
  ] as const;
  for (const [index, metricCase] of reference.cases.entries()) {
    const transform = expectedTransforms[index];
    if (!transform) throw new Error(`unexpected metric case ${index}`);
    requireEqual(
      metricCase.sourceTransform,
      { scale: transform[0], shift: { x: transform[1], y: transform[2] } },
      `${metricCase.id} source transform`,
    );
    requireSnapshotTransform(
      metricCase.worldMetrics,
      metricCase.naturalMetrics,
      transform[0],
      transform[1],
      transform[2],
      `${metricCase.id} world metrics`,
    );
  }
  requireSnapshotTransform(pi72.naturalMetrics, pi48.naturalMetrics, 1.5, 0, 0, "72px font scaling");
  requireEqual(pi72.sourceSvg, pi48.sourceSvg, "font-size source SVG");
  requireEqual(piTransformed.naturalMetrics, pi48.naturalMetrics, "pre-transform pi metrics");
  requireEqual(piTransformed.sourceSvg, pi48.sourceSvg, "transformed pi source SVG");
  requireEqual(officialText.naturalMetrics.familyCount, 15, "official Tex family count");
  requireEqual(officialMath.naturalMetrics.familyCount, 14, "official MathTex family count");
  requireEqual(
    officialMath.naturalMetrics.families.map(({ kind, order }) => ({ kind, order })),
    Array.from({ length: 14 }, (_, order) => ({ kind: order === 6 || order === 12 ? "rule" : "glyph", order })),
    "official MathTex family order",
  );

  const { afterArrange, afterWidth } = reference.layout;
  requireEqual(
    afterArrange.children.map(({ caseId }) => caseId),
    [officialText.id, officialMath.id],
    "layout child order",
  );
  requireGeometryTransform(
    afterArrange.children[0],
    officialText.naturalMetrics,
    1,
    0,
    afterArrange.children[0].center.y,
    "arranged Tex",
  );
  requireGeometryTransform(
    afterArrange.children[1],
    officialMath.naturalMetrics,
    1,
    0,
    afterArrange.children[1].center.y,
    "arranged MathTex",
  );
  requireNear(
    afterArrange.children[0].anchorBounds.bottom - afterArrange.children[1].anchorBounds.top,
    reference.layout.arrange.buffer,
    "arrange gap",
  );
  requireNear(
    reference.layout.targetWidth,
    reference.layout.frameWidth - 2 * reference.layout.largeBuffer,
    "layout target width",
  );
  requireNear(
    reference.layout.uniformScale,
    reference.layout.targetWidth / afterArrange.group.size.width,
    "layout uniform scale",
  );
  requireGeometryTransform(
    afterWidth.group,
    afterArrange.group,
    reference.layout.uniformScale,
    0,
    0,
    "width-scaled group",
  );
  for (const index of [0, 1] as const) {
    requireGeometryTransform(
      afterWidth.children[index],
      afterArrange.children[index],
      reference.layout.uniformScale,
      0,
      0,
      `width-scaled child ${index}`,
    );
  }
  requireNear(afterWidth.group.size.width, reference.layout.targetWidth, "final group width");
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readManimTexNaturalMetricsReferenceV1(
  root = MANIM_TEX_NATURAL_METRICS_ROOT_V1,
  repositoryRoot = process.cwd(),
) {
  const [referenceBytes, digestText] = await Promise.all([
    readFile(join(root, "reference.json")),
    readFile(join(root, "reference.json.sha256"), "utf8"),
  ]);
  const digestMatch = /^([0-9a-f]{64}) {2}reference\.json\n$/.exec(digestText);
  if (!digestMatch) throw new Error("the Manim Tex natural-metrics digest sidecar is malformed");
  requireDigest(sha256(referenceBytes), digestMatch[1], "the Manim Tex natural-metrics reference");

  const referenceText = referenceBytes.toString("utf8");
  const reference = manimTexNaturalMetricsReferenceV1Schema.parse(JSON.parse(referenceText));
  const { identitySha256, ...producerIdentity } = reference.producer;
  requireDigest(sha256(canonicalJsonV1(producerIdentity)), identitySha256, "the Manim Tex metrics producer identity");
  requireDigest(
    sha256(await readFile(join(repositoryRoot, reference.generator.path))),
    reference.generator.sha256,
    "the Manim Tex metrics generator",
  );
  verifySemantics(reference);
  return reference;
}
