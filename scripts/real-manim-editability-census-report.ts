import { createHash } from "node:crypto";
import { z } from "zod";
import { type RealManimCensusManifest, realManimCensusRuntimeTraceCaseId } from "./real-manim-census-report";

const REPORT_SCHEMA = "poietra.real-manim-editability-census-report";
const SHA256 = /^[a-f0-9]{64}$/;

export const REAL_MANIM_EDITABILITY_CAPABILITIES = [
  "preview",
  "selection",
  "edit",
  "edited-export",
  "validated-roundtrip",
] as const;
export const REAL_MANIM_EDITABILITY_BLOCKERS = ["source-edit-anchor-unavailable"] as const;
export const REAL_MANIM_EDITABILITY_CENSUS_CASES = [
  {
    caseId: "fast-manim-basic/OpeningManim/runtime-trace-v2",
    runtimeTraceVersion: 2,
    sceneName: "OpeningManim",
  },
  {
    caseId: "fast-manim-basic/UpdatersExample/runtime-trace-v1",
    runtimeTraceVersion: 1,
    sceneName: "UpdatersExample",
  },
] as const;
export const REAL_MANIM_EDITABILITY_MANIFEST_DIGEST =
  "e81a9c823ccea20c49c4c81c043d126176c36960de7b36574d7b5c3a649de6d7";
export const REAL_MANIM_EDITABILITY_PRODUCER_DIGEST =
  "2fa2c66781e589051e8219c0b71aa3f67832fe376dcf4325a7c6d8047943969a";

const capabilitySchema = z.enum(REAL_MANIM_EDITABILITY_CAPABILITIES);
const blockerSchema = z.enum(REAL_MANIM_EDITABILITY_BLOCKERS);
const caseIdSchema = z.enum([
  REAL_MANIM_EDITABILITY_CENSUS_CASES[0].caseId,
  REAL_MANIM_EDITABILITY_CENSUS_CASES[1].caseId,
]);
const observationSchema = z.discriminatedUnion("status", [
  z.object({ capability: capabilitySchema, caseId: caseIdSchema, status: z.literal("proven") }).strict(),
  z
    .object({
      blocker: blockerSchema,
      capability: capabilitySchema,
      caseId: caseIdSchema,
      status: z.literal("blocked"),
    })
    .strict(),
]);
const evidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("proven") }).strict(),
  z.object({ blocker: blockerSchema, status: z.literal("blocked") }).strict(),
]);
const capabilitiesSchema = z
  .object({
    preview: evidenceSchema,
    selection: evidenceSchema,
    edit: evidenceSchema,
    "edited-export": evidenceSchema,
    "validated-roundtrip": evidenceSchema,
  })
  .strict();
const caseResultSchema = z
  .object({
    capabilities: capabilitiesSchema,
    runtimeTraceVersion: z.union([z.literal(1), z.literal(2)]),
    sceneName: z.enum(["OpeningManim", "UpdatersExample"]),
  })
  .strict();

const reportSchema = z
  .object({
    capabilities: z.tuple(
      REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability) => z.literal(capability)) as [
        z.ZodLiteral<"preview">,
        z.ZodLiteral<"selection">,
        z.ZodLiteral<"edit">,
        z.ZodLiteral<"edited-export">,
        z.ZodLiteral<"validated-roundtrip">,
      ],
    ),
    manifestDigest: z.string().regex(SHA256),
    manifestVersion: z.literal(1),
    producerDigest: z.string().regex(SHA256),
    results: z.record(caseIdSchema, caseResultSchema),
    schema: z.literal(REPORT_SCHEMA),
    version: z.literal(1),
  })
  .strict()
  .superRefine((report, context) => {
    for (const expected of REAL_MANIM_EDITABILITY_CENSUS_CASES) {
      const result = report.results[expected.caseId];
      if (result.sceneName !== expected.sceneName || result.runtimeTraceVersion !== expected.runtimeTraceVersion) {
        context.addIssue({
          code: "custom",
          message: "Case metadata does not match its pinned Runtime Trace.",
          path: ["results", expected.caseId],
        });
      }
      let blocked = false;
      for (const capability of REAL_MANIM_EDITABILITY_CAPABILITIES) {
        const evidence = result.capabilities[capability];
        if (blocked && evidence.status === "proven") {
          context.addIssue({
            code: "custom",
            message: "A capability cannot be proven while an earlier dependency is blocked.",
            path: ["results", expected.caseId, "capabilities", capability],
          });
        }
        blocked ||= evidence.status === "blocked";
      }
    }
  });

type CapabilityEvidence = z.infer<typeof evidenceSchema>;
type CaseCapabilities = z.infer<typeof capabilitiesSchema>;
export type RealManimEditabilityCapability = z.infer<typeof capabilitySchema>;
export type RealManimEditabilityCensusCaseId = z.infer<typeof caseIdSchema>;
export type RealManimEditabilityCensusObservation = z.input<typeof observationSchema>;
export type RealManimEditabilityCensusReport = z.infer<typeof reportSchema>;

function buildCaseCapabilities(
  caseId: RealManimEditabilityCensusCaseId,
  inputs: readonly RealManimEditabilityCensusObservation[],
): CaseCapabilities {
  const evidence = new Map<RealManimEditabilityCapability, CapabilityEvidence>();
  for (const input of inputs) {
    const observation = observationSchema.parse(input);
    if (observation.caseId !== caseId) throw new Error(`Observation belongs to ${observation.caseId}.`);
    if (evidence.has(observation.capability)) {
      throw new Error(`Duplicate editability observation: ${caseId}/${observation.capability}`);
    }
    evidence.set(
      observation.capability,
      observation.status === "proven" ? { status: "proven" } : { blocker: observation.blocker, status: "blocked" },
    );
  }
  const missing = REAL_MANIM_EDITABILITY_CAPABILITIES.filter((capability) => !evidence.has(capability));
  if (missing.length > 0) throw new Error(`Missing editability observations for ${caseId}: ${missing.join(", ")}`);
  return capabilitiesSchema.parse(
    Object.fromEntries(REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability) => [capability, evidence.get(capability)])),
  );
}

function manifestRuntimeTraceCases(manifest: RealManimCensusManifest) {
  return manifest.sources
    .flatMap((source) =>
      source.scenes.flatMap((scene) =>
        (scene.runtimeTraceVersions ?? []).map((runtimeTraceVersion) => ({
          caseId: realManimCensusRuntimeTraceCaseId(source.id, scene.name, runtimeTraceVersion),
          runtimeTraceVersion,
          sceneName: scene.name,
        })),
      ),
    )
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
}

export function buildRealManimEditabilityCensusReport(
  manifest: RealManimCensusManifest,
  producerDigest: string,
  inputs: readonly RealManimEditabilityCensusObservation[],
): RealManimEditabilityCensusReport {
  const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  if (
    manifest.version !== 1 ||
    manifestDigest !== REAL_MANIM_EDITABILITY_MANIFEST_DIGEST ||
    manifest.producer.digest !== REAL_MANIM_EDITABILITY_PRODUCER_DIGEST ||
    producerDigest !== REAL_MANIM_EDITABILITY_PRODUCER_DIGEST
  ) {
    throw new Error("Producer or manifest does not match the pinned playback census.");
  }
  if (JSON.stringify(manifestRuntimeTraceCases(manifest)) !== JSON.stringify(REAL_MANIM_EDITABILITY_CENSUS_CASES)) {
    throw new Error("Manifest must contain exactly the two pinned Runtime Trace cases.");
  }
  const grouped = new Map<RealManimEditabilityCensusCaseId, RealManimEditabilityCensusObservation[]>();
  for (const input of inputs) {
    const observation = observationSchema.parse(input);
    grouped.set(observation.caseId, [...(grouped.get(observation.caseId) ?? []), observation]);
  }
  const results = Object.fromEntries(
    REAL_MANIM_EDITABILITY_CENSUS_CASES.map((expected) => [
      expected.caseId,
      {
        capabilities: buildCaseCapabilities(expected.caseId, grouped.get(expected.caseId) ?? []),
        runtimeTraceVersion: expected.runtimeTraceVersion,
        sceneName: expected.sceneName,
      },
    ]),
  );
  return reportSchema.parse({
    capabilities: REAL_MANIM_EDITABILITY_CAPABILITIES,
    manifestDigest,
    manifestVersion: manifest.version,
    producerDigest,
    results,
    schema: REPORT_SCHEMA,
    version: 1,
  });
}

function assertCaseFloor(
  caseId: RealManimEditabilityCensusCaseId,
  capabilities: CaseCapabilities,
  baseline: RealManimEditabilityCensusReport,
) {
  for (const capability of REAL_MANIM_EDITABILITY_CAPABILITIES) {
    if (
      baseline.results[caseId].capabilities[capability].status === "proven" &&
      capabilities[capability].status !== "proven"
    ) {
      throw new Error(`Previously proven capability is now blocked: ${caseId}/${capability}`);
    }
  }
}

export function assertRealManimEditabilityCensusCaseFloor(
  caseIdInput: RealManimEditabilityCensusCaseId,
  inputs: readonly RealManimEditabilityCensusObservation[],
  baselineInput: unknown,
): void {
  const caseId = caseIdSchema.parse(caseIdInput);
  const capabilities = buildCaseCapabilities(caseId, inputs);
  const baseline = reportSchema.parse(baselineInput);
  reportSchema.parse({
    ...baseline,
    results: {
      ...baseline.results,
      [caseId]: { ...baseline.results[caseId], capabilities },
    },
  });
  assertCaseFloor(caseId, capabilities, baseline);
}

export function assertRealManimEditabilityCensusFloor(reportInput: unknown, baselineInput: unknown): void {
  const report = reportSchema.parse(reportInput);
  const baseline = reportSchema.parse(baselineInput);
  if (
    report.manifestVersion !== baseline.manifestVersion ||
    report.manifestDigest !== baseline.manifestDigest ||
    report.producerDigest !== baseline.producerDigest
  ) {
    throw new Error("Report and baseline use different producer or manifest pins.");
  }
  for (const { caseId } of REAL_MANIM_EDITABILITY_CENSUS_CASES) {
    assertCaseFloor(caseId, report.results[caseId].capabilities, baseline);
  }
}
