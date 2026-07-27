import { z } from "zod";

export const ENGINE_GOLDEN_FIXTURE_IDS = [
  "eng-v1-001-empty-camera",
  "eng-v1-002-frame-edge-rebase",
  "eng-v1-003-shape-primitives",
  "eng-v1-004-cubic-paint",
  "eng-v1-005-alpha-z-order",
  "eng-v1-006-affine-hierarchy",
  "eng-v1-007-png-samplers",
  "eng-v1-008-camera-pan-zoom",
  "eng-v1-009-create-trim",
  "eng-v1-010-fade-opacity",
  "eng-v1-011-path-morph",
  "eng-v1-012-move-along-path",
  "eng-v1-013-cairo-opengl-bridge",
  "eng-v1-014-stress-geometry",
  "eng-v1-015-stress-scrub-mixed",
] as const;

export const REQUIRED_ENGINE_GOLDEN_FEATURES = [
  "empty-scene",
  "orthographic-camera",
  "camera-relative-precision",
  "shape-primitives",
  "cubic-path",
  "fill-rule",
  "stroke-style",
  "alpha-compositing",
  "z-order",
  "hierarchy",
  "affine-transform",
  "png-image",
  "image-sampling",
  "camera-animation",
  "cubic-bezier-easing",
  "path-trim",
  "opacity-animation",
  "path-morph",
  "motion-path",
  "orient-to-path",
  "fast-manim-cairo-bridge",
  "fast-manim-opengl-bridge",
  "resource-limits",
  "deterministic-scrub",
] as const;

export const REQUIRED_ENGINE_GOLDEN_WORKLOAD_CATEGORIES = [
  "baseline",
  "correctness",
  "basic-vector",
  "asset-cold",
  "scrub",
  "adapter-conformance",
  "stress-geometry",
  "stress-mixed",
] as const;

export const REQUIRED_ENGINE_GOLDEN_NEGATIVE_CASES = [
  "unknown-contract-version",
  "unknown-field",
  "unknown-capability",
  "stale-manifest-digest",
  "non-finite-coordinate",
  "transform-overflow",
  "viewport-aspect-mismatch",
  "invalid-shape-dimension",
  "invalid-rounded-corner",
  "missing-line-stroke",
  "invalid-cubic-data",
  "empty-subpath",
  "missing-path-paint",
  "invalid-paint-order",
  "duplicate-draw-id",
  "hierarchy-cycle",
  "child-lifetime-outside-parent",
  "duplicate-channel-target",
  "stale-asset-hash",
  "image-dimension-mismatch",
  "unsupported-image-sampler",
  "duplicate-camera-channel",
  "final-keyframe-easing",
  "invalid-path-trim-target",
  "out-of-range-channel-value",
  "missing-active-draw",
  "path-morph-topology-mismatch",
  "motion-path-multiple-subpaths",
  "undefined-motion-tangent",
  "malformed-backend-curve",
  "non-finite-z-index",
  "unsupported-fast-manim-style",
  "aggregate-path-segment-limit",
] as const;

const expectedFactSchema = z.enum([
  "empty-draw-list",
  "exact-render-capabilities",
  "exact-camera-extents",
  "camera-relative-f32",
  "shape-to-cubic",
  "line-control-thirds",
  "absolute-cubic-order",
  "paint-style-enums",
  "linear-premultiplied-source-over",
  "z-scene-paint-order",
  "root-to-leaf-affine",
  "world-space-stroke-width",
  "png-row-zero-top",
  "premultiply-before-filter",
  "asset-integrity",
  "camera-aspect-preserved",
  "css-cubic-bezier",
  "arc-length-path-trim",
  "canonical-zero-trim",
  "smooth-opacity-values",
  "component-wise-path-morph",
  "arc-length-motion-path",
  "previous-tangent-at-cusp",
  "quadratic-to-cubic",
  "aggregate-segment-limit",
  "deterministic-packet-digest",
  "one-draw-per-active-entity",
  "upload-assets-once",
]);

export const engineGoldenFixtureIdSchema = z.enum(ENGINE_GOLDEN_FIXTURE_IDS);
export const engineGoldenFeatureSchema = z.enum(REQUIRED_ENGINE_GOLDEN_FEATURES);
export const engineGoldenWorkloadCategorySchema = z.enum(REQUIRED_ENGINE_GOLDEN_WORKLOAD_CATEGORIES);
export const engineGoldenNegativeCaseCodeSchema = z.enum(REQUIRED_ENGINE_GOLDEN_NEGATIVE_CASES);

const finiteTimeSchema = z.number().finite().min(0);
const explicitSamplePlanSchema = z
  .object({
    kind: z.literal("explicit"),
    times: z.array(finiteTimeSchema).min(1).max(1_001),
  })
  .strict()
  .superRefine((plan, context) => {
    plan.times.forEach((time, index) => {
      if (index > 0 && time <= plan.times[index - 1]) {
        context.addIssue({
          code: "custom",
          message: "Sample times must be strictly increasing.",
          path: ["times", index],
        });
      }
    });
  });

const uniformSamplePlanSchema = z
  .object({
    count: z.number().int().min(2).max(1_001),
    end: finiteTimeSchema,
    kind: z.literal("uniform"),
    start: finiteTimeSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.end <= plan.start) {
      context.addIssue({
        code: "custom",
        message: "A uniform sample range must have positive duration.",
        path: ["end"],
      });
    }
  });

export const engineGoldenSamplePlanSchema = z.discriminatedUnion("kind", [
  explicitSamplePlanSchema,
  uniformSamplePlanSchema,
]);

export type EngineGoldenSamplePlan = z.infer<typeof engineGoldenSamplePlanSchema>;

export function expandEngineGoldenSampleTimes(plan: EngineGoldenSamplePlan): number[] {
  if (plan.kind === "explicit") return [...plan.times];
  const step = (plan.end - plan.start) / (plan.count - 1);
  return Array.from({ length: plan.count }, (_, index) =>
    index === plan.count - 1 ? plan.end : plan.start + step * index,
  );
}

const checkpointSchema = z
  .object({
    at: finiteTimeSchema,
    draws: z.number().int().min(0),
    segments: z.number().int().min(0),
  })
  .strict();

const canonicalSegmentCountSchema = z
  .object({
    segments: z.number().int().min(1),
    target: z.enum([
      "circle",
      "rectangle",
      "rounded-rectangle",
      "line",
      "morph-source",
      "morph-target",
      "normalized-quadratic",
    ]),
  })
  .strict();

const referenceSchema = z
  .object({
    category: z.enum(["analytic", "contract-cpu", "deterministic-generator", "fast-manim"]),
    locator: z.string().trim().min(1).max(500),
    role: z.enum(["primary", "secondary"]),
  })
  .strict();

const negativeCaseSchema = z
  .object({
    code: engineGoldenNegativeCaseCodeSchema,
    expected: z.literal("reject-before-submit"),
    stage: z.enum(["adapter", "schema", "integrity", "evaluation"]),
  })
  .strict();

function reportDuplicateStrings(values: readonly string[], path: string, context: z.RefinementCtx) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `Duplicate ${path} value ${value}.`, path: [path, index] });
    }
    seen.add(value);
  });
}

function containsTime(times: readonly number[], target: number) {
  return times.some((time) => Math.abs(time - target) <= Number.EPSILON * 8);
}

export const engineGoldenFixtureSchema = z
  .object({
    durationSeconds: finiteTimeSchema.positive(),
    expectations: z
      .object({
        canonicalSegmentCounts: z.array(canonicalSegmentCountSchema),
        checkpoints: z.array(checkpointSchema).min(1),
        facts: z.array(expectedFactSchema).min(1),
      })
      .strict(),
    features: z.array(engineGoldenFeatureSchema).min(1),
    id: engineGoldenFixtureIdSchema,
    negativeCases: z.array(negativeCaseSchema).min(1),
    references: z.array(referenceSchema).min(1),
    samplePlan: engineGoldenSamplePlanSchema,
    workloadCategories: z.array(engineGoldenWorkloadCategorySchema).min(1),
  })
  .strict()
  .superRefine((fixture, context) => {
    reportDuplicateStrings(fixture.features, "features", context);
    reportDuplicateStrings(fixture.workloadCategories, "workloadCategories", context);
    reportDuplicateStrings(
      fixture.negativeCases.map((negativeCase) => negativeCase.code),
      "negativeCases",
      context,
    );
    reportDuplicateStrings(fixture.expectations.facts, "facts", context);
    reportDuplicateStrings(
      fixture.expectations.canonicalSegmentCounts.map(({ target }) => target),
      "canonicalSegmentCounts",
      context,
    );
    reportDuplicateStrings(
      fixture.references.map(({ category, locator, role }) => `${category}:${role}:${locator}`),
      "references",
      context,
    );

    if (!fixture.references.some((reference) => reference.role === "primary")) {
      context.addIssue({ code: "custom", message: "Every fixture needs a primary reference.", path: ["references"] });
    }
    fixture.references.forEach((reference, index) => {
      if (reference.category === "fast-manim" && reference.role !== "secondary") {
        context.addIssue({
          code: "custom",
          message: "fast-manim is a secondary compatibility reference, not the engine oracle.",
          path: ["references", index, "role"],
        });
      }
    });

    const sampleTimes = expandEngineGoldenSampleTimes(fixture.samplePlan);
    if (sampleTimes.at(-1)! > fixture.durationSeconds) {
      context.addIssue({
        code: "custom",
        message: "Sample times must fit within fixture duration.",
        path: ["samplePlan"],
      });
    }
    fixture.expectations.checkpoints.forEach((checkpoint, index) => {
      if (!containsTime(sampleTimes, checkpoint.at)) {
        context.addIssue({
          code: "custom",
          message: "Expectation checkpoints must be present in the sample plan.",
          path: ["expectations", "checkpoints", index, "at"],
        });
      }
      if (checkpoint.at === fixture.durationSeconds && checkpoint.draws !== 0) {
        context.addIssue({
          code: "custom",
          message: "A checkpoint at Scene duration cannot contain draws because lifetimes are half-open.",
          path: ["expectations", "checkpoints", index, "draws"],
        });
      }
    });
    reportDuplicateStrings(
      fixture.expectations.checkpoints.map(({ at }) => String(at)),
      "checkpoints",
      context,
    );
  });

function reportMissingCoverage(
  required: readonly string[],
  covered: ReadonlySet<string>,
  path: string,
  context: z.RefinementCtx,
) {
  for (const value of required) {
    if (!covered.has(value)) {
      context.addIssue({ code: "custom", message: `Missing required ${path} value ${value}.`, path: ["fixtures"] });
    }
  }
}

export const engineGoldenFixtureCatalogSchema = z
  .object({
    fixtures: z.array(engineGoldenFixtureSchema).length(ENGINE_GOLDEN_FIXTURE_IDS.length),
    schema: z.literal("poietra.engine-golden-fixture-catalog"),
    version: z.literal(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    reportDuplicateStrings(
      catalog.fixtures.map(({ id }) => id),
      "fixtures",
      context,
    );
    ENGINE_GOLDEN_FIXTURE_IDS.forEach((id, index) => {
      if (catalog.fixtures[index]?.id !== id) {
        context.addIssue({
          code: "custom",
          message: `Fixture ${index} must be ${id}.`,
          path: ["fixtures", index, "id"],
        });
      }
    });
    reportMissingCoverage(
      REQUIRED_ENGINE_GOLDEN_FEATURES,
      new Set(catalog.fixtures.flatMap(({ features }) => features)),
      "feature",
      context,
    );
    reportMissingCoverage(
      REQUIRED_ENGINE_GOLDEN_WORKLOAD_CATEGORIES,
      new Set(catalog.fixtures.flatMap(({ workloadCategories }) => workloadCategories)),
      "workload category",
      context,
    );
    reportMissingCoverage(
      REQUIRED_ENGINE_GOLDEN_NEGATIVE_CASES,
      new Set(catalog.fixtures.flatMap(({ negativeCases }) => negativeCases.map(({ code }) => code))),
      "negative case",
      context,
    );
  });

const EXPECT_REJECT = "reject-before-submit" as const;

const catalogInput: z.input<typeof engineGoldenFixtureCatalogSchema> = {
  fixtures: [
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0, draws: 0, segments: 0 }],
        facts: ["empty-draw-list", "exact-render-capabilities", "exact-camera-extents", "asset-integrity"],
      },
      features: ["empty-scene", "orthographic-camera"],
      id: "eng-v1-001-empty-camera",
      negativeCases: [
        { code: "unknown-contract-version", expected: EXPECT_REJECT, stage: "schema" },
        { code: "unknown-field", expected: EXPECT_REJECT, stage: "schema" },
        { code: "unknown-capability", expected: EXPECT_REJECT, stage: "schema" },
        { code: "stale-manifest-digest", expected: EXPECT_REJECT, stage: "integrity" },
      ],
      references: [
        { category: "analytic", locator: "inline:empty-frame", role: "primary" },
        {
          category: "fast-manim",
          locator: "tests/test_scene_rendering/infallible_scenes.py::Wait1",
          role: "secondary",
        },
      ],
      samplePlan: { kind: "explicit", times: [0] },
      workloadCategories: ["baseline"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0.5, draws: 2, segments: 2 }],
        facts: ["exact-camera-extents", "camera-relative-f32", "absolute-cubic-order"],
      },
      features: ["orthographic-camera", "camera-relative-precision", "cubic-path"],
      id: "eng-v1-002-frame-edge-rebase",
      negativeCases: [
        { code: "non-finite-coordinate", expected: EXPECT_REJECT, stage: "schema" },
        { code: "transform-overflow", expected: EXPECT_REJECT, stage: "evaluation" },
        { code: "viewport-aspect-mismatch", expected: EXPECT_REJECT, stage: "evaluation" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:camera-relative-reference", role: "primary" },
        { category: "fast-manim", locator: "custom:large-coordinate-frame-edges", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["correctness"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [
          { segments: 4, target: "circle" },
          { segments: 4, target: "rectangle" },
          { segments: 8, target: "rounded-rectangle" },
          { segments: 1, target: "line" },
        ],
        checkpoints: [{ at: 0.5, draws: 4, segments: 17 }],
        facts: ["shape-to-cubic", "line-control-thirds"],
      },
      features: ["shape-primitives", "cubic-path"],
      id: "eng-v1-003-shape-primitives",
      negativeCases: [
        { code: "invalid-shape-dimension", expected: EXPECT_REJECT, stage: "schema" },
        { code: "invalid-rounded-corner", expected: EXPECT_REJECT, stage: "schema" },
        { code: "missing-line-stroke", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:shape-to-cubic", role: "primary" },
        {
          category: "fast-manim",
          locator: "tests/test_graphical_units/test_geometry.py + control_data/*.npz",
          role: "secondary",
        },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["basic-vector"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0.5, draws: 4, segments: 14 }],
        facts: ["absolute-cubic-order", "paint-style-enums"],
      },
      features: ["cubic-path", "fill-rule", "stroke-style"],
      id: "eng-v1-004-cubic-paint",
      negativeCases: [
        { code: "invalid-cubic-data", expected: EXPECT_REJECT, stage: "schema" },
        { code: "empty-subpath", expected: EXPECT_REJECT, stage: "schema" },
        { code: "missing-path-paint", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:absolute-cubic-and-paint", role: "primary" },
        { category: "fast-manim", locator: "CubicPath + cap/join graphical-unit tests", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["basic-vector"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0.5, draws: 4, segments: 16 }],
        facts: ["linear-premultiplied-source-over", "z-scene-paint-order"],
      },
      features: ["alpha-compositing", "z-order", "shape-primitives"],
      id: "eng-v1-005-alpha-z-order",
      negativeCases: [
        { code: "invalid-paint-order", expected: EXPECT_REJECT, stage: "evaluation" },
        { code: "duplicate-draw-id", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "analytic", locator: "inline:linear-premultiplied-source-over", role: "primary" },
        { category: "fast-manim", locator: "ZIndex graphical-unit tests", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["basic-vector"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [
          { at: 0, draws: 2, segments: 8 },
          { at: 0.5, draws: 2, segments: 8 },
          { at: 1, draws: 2, segments: 8 },
        ],
        facts: ["root-to-leaf-affine", "world-space-stroke-width"],
      },
      features: ["hierarchy", "affine-transform"],
      id: "eng-v1-006-affine-hierarchy",
      negativeCases: [
        { code: "hierarchy-cycle", expected: EXPECT_REJECT, stage: "schema" },
        { code: "child-lifetime-outside-parent", expected: EXPECT_REJECT, stage: "schema" },
        { code: "duplicate-channel-target", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:root-to-leaf-affine", role: "primary" },
        { category: "fast-manim", locator: "custom:nested-VGroup-affine", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.5, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0.5, draws: 2, segments: 0 }],
        facts: ["png-row-zero-top", "premultiply-before-filter", "asset-integrity"],
      },
      features: ["png-image", "image-sampling"],
      id: "eng-v1-007-png-samplers",
      negativeCases: [
        { code: "stale-asset-hash", expected: EXPECT_REJECT, stage: "integrity" },
        { code: "image-dimension-mismatch", expected: EXPECT_REJECT, stage: "integrity" },
        { code: "unsupported-image-sampler", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:png-sampler-reference", role: "primary" },
        {
          category: "fast-manim",
          locator: "tests/test_graphical_units/test_img_and_svg.py::test_ImageInterpolation",
          role: "secondary",
        },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["asset-cold", "basic-vector"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [{ segments: 4, target: "circle" }],
        checkpoints: [
          { at: 0, draws: 1, segments: 4 },
          { at: 0.25, draws: 1, segments: 4 },
          { at: 0.5, draws: 1, segments: 4 },
          { at: 0.75, draws: 1, segments: 4 },
          { at: 1, draws: 1, segments: 4 },
        ],
        facts: ["exact-camera-extents", "camera-aspect-preserved", "css-cubic-bezier"],
      },
      features: ["orthographic-camera", "camera-animation", "cubic-bezier-easing"],
      id: "eng-v1-008-camera-pan-zoom",
      negativeCases: [
        { code: "duplicate-camera-channel", expected: EXPECT_REJECT, stage: "schema" },
        { code: "final-keyframe-easing", expected: EXPECT_REJECT, stage: "schema" },
        { code: "viewport-aspect-mismatch", expected: EXPECT_REJECT, stage: "evaluation" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:camera-channel-and-css-bezier", role: "primary" },
        { category: "fast-manim", locator: "custom:MovingCameraScene-pan-zoom", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.25, 0.5, 0.75, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [
          { at: 0, draws: 1, segments: 1 },
          { at: 0.125, draws: 1, segments: 1 },
          { at: 0.25, draws: 1, segments: 1 },
          { at: 0.5, draws: 1, segments: 2 },
          { at: 0.75, draws: 1, segments: 3 },
          { at: 1, draws: 1, segments: 4 },
        ],
        facts: ["arc-length-path-trim", "canonical-zero-trim"],
      },
      features: ["path-trim", "cubic-path"],
      id: "eng-v1-009-create-trim",
      negativeCases: [
        { code: "invalid-path-trim-target", expected: EXPECT_REJECT, stage: "schema" },
        { code: "out-of-range-channel-value", expected: EXPECT_REJECT, stage: "schema" },
        { code: "missing-active-draw", expected: EXPECT_REJECT, stage: "evaluation" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:de-casteljau-path-trim", role: "primary" },
        {
          category: "fast-manim",
          locator: "tests/test_graphical_units/test_creation.py::test_create + control_data/*.npz",
          role: "secondary",
        },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.125, 0.25, 0.5, 0.75, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [{ segments: 4, target: "rectangle" }],
        checkpoints: [
          { at: 0, draws: 1, segments: 4 },
          { at: 0.25, draws: 1, segments: 4 },
          { at: 0.5, draws: 1, segments: 4 },
          { at: 0.75, draws: 1, segments: 4 },
          { at: 1, draws: 1, segments: 4 },
        ],
        facts: ["smooth-opacity-values"],
      },
      features: ["opacity-animation"],
      id: "eng-v1-010-fade-opacity",
      negativeCases: [
        { code: "duplicate-channel-target", expected: EXPECT_REJECT, stage: "schema" },
        { code: "final-keyframe-easing", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "analytic", locator: "inline:smoothstep-opacity-0-.15625-.5-.84375-1", role: "primary" },
        { category: "fast-manim", locator: "FadeIn graphical-unit tests", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.25, 0.5, 0.75, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [
          { segments: 4, target: "morph-source" },
          { segments: 4, target: "morph-target" },
        ],
        checkpoints: [
          { at: 0, draws: 1, segments: 4 },
          { at: 0.5, draws: 1, segments: 4 },
          { at: 1, draws: 1, segments: 4 },
        ],
        facts: ["component-wise-path-morph"],
      },
      features: ["path-morph"],
      id: "eng-v1-011-path-morph",
      negativeCases: [{ code: "path-morph-topology-mismatch", expected: EXPECT_REJECT, stage: "schema" }],
      references: [
        { category: "contract-cpu", locator: "engine-v1:component-wise-four-cubic-morph", role: "primary" },
        { category: "fast-manim", locator: "Transform graphical-unit tests", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.5, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [{ segments: 4, target: "circle" }],
        checkpoints: [
          { at: 0, draws: 1, segments: 4 },
          { at: 0.25, draws: 1, segments: 4 },
          { at: 0.5, draws: 1, segments: 4 },
          { at: 0.75, draws: 1, segments: 4 },
          { at: 1, draws: 1, segments: 4 },
        ],
        facts: ["arc-length-motion-path", "previous-tangent-at-cusp"],
      },
      features: ["motion-path", "orient-to-path"],
      id: "eng-v1-012-move-along-path",
      negativeCases: [
        { code: "motion-path-multiple-subpaths", expected: EXPECT_REJECT, stage: "schema" },
        { code: "undefined-motion-tangent", expected: EXPECT_REJECT, stage: "evaluation" },
        { code: "duplicate-channel-target", expected: EXPECT_REJECT, stage: "schema" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:arc-length-motion-path", role: "primary" },
        { category: "fast-manim", locator: "MoveAlongPath graphical-unit tests", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0, 0.25, 0.5, 0.75, 1] },
      workloadCategories: ["scrub"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [{ segments: 1, target: "normalized-quadratic" }],
        checkpoints: [{ at: 0.5, draws: 1, segments: 1 }],
        facts: ["quadratic-to-cubic"],
      },
      features: ["fast-manim-cairo-bridge", "fast-manim-opengl-bridge"],
      id: "eng-v1-013-cairo-opengl-bridge",
      negativeCases: [
        { code: "malformed-backend-curve", expected: EXPECT_REJECT, stage: "adapter" },
        { code: "non-finite-z-index", expected: EXPECT_REJECT, stage: "adapter" },
        { code: "unsupported-fast-manim-style", expected: EXPECT_REJECT, stage: "adapter" },
      ],
      references: [
        { category: "analytic", locator: "inline:quadratic-controls-(2/3,2/3)-(4/3,2/3)", role: "primary" },
        { category: "fast-manim", locator: "custom:Cairo-cubic/OpenGL-quadratic-adapter", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["adapter-conformance"],
    },
    {
      durationSeconds: 1,
      expectations: {
        canonicalSegmentCounts: [],
        checkpoints: [{ at: 0.5, draws: 4_096, segments: 98_304 }],
        facts: ["aggregate-segment-limit", "deterministic-packet-digest"],
      },
      features: ["resource-limits", "cubic-path"],
      id: "eng-v1-014-stress-geometry",
      negativeCases: [{ code: "aggregate-path-segment-limit", expected: EXPECT_REJECT, stage: "schema" }],
      references: [
        { category: "contract-cpu", locator: "engine-v1:aggregate-segment-accounting", role: "primary" },
        { category: "deterministic-generator", locator: "generator:4096x24-open-cubic-entities", role: "secondary" },
      ],
      samplePlan: { kind: "explicit", times: [0.5] },
      workloadCategories: ["stress-geometry"],
    },
    {
      durationSeconds: 2,
      expectations: {
        canonicalSegmentCounts: [{ segments: 4, target: "circle" }],
        checkpoints: [
          { at: 0, draws: 2_048, segments: 7_680 },
          { at: 0.5, draws: 2_048, segments: 7_680 },
          { at: 1, draws: 2_048, segments: 7_680 },
        ],
        facts: ["deterministic-packet-digest", "one-draw-per-active-entity", "upload-assets-once"],
      },
      features: ["deterministic-scrub", "png-image", "opacity-animation", "affine-transform"],
      id: "eng-v1-015-stress-scrub-mixed",
      negativeCases: [
        { code: "duplicate-channel-target", expected: EXPECT_REJECT, stage: "schema" },
        { code: "stale-asset-hash", expected: EXPECT_REJECT, stage: "integrity" },
        { code: "missing-active-draw", expected: EXPECT_REJECT, stage: "evaluation" },
      ],
      references: [
        { category: "contract-cpu", locator: "engine-v1:mixed-scrub-digest", role: "primary" },
        {
          category: "deterministic-generator",
          locator: "generator:1920-circles+128-images+2048-channels+8-assets",
          role: "secondary",
        },
      ],
      samplePlan: { count: 301, end: 1, kind: "uniform", start: 0 },
      workloadCategories: ["stress-mixed", "scrub"],
    },
  ],
  schema: "poietra.engine-golden-fixture-catalog",
  version: 1,
};

export const ENGINE_GOLDEN_FIXTURE_CATALOG = engineGoldenFixtureCatalogSchema.parse(catalogInput);

export type EngineGoldenFixture = z.infer<typeof engineGoldenFixtureSchema>;
export type EngineGoldenFixtureCatalog = z.infer<typeof engineGoldenFixtureCatalogSchema>;
