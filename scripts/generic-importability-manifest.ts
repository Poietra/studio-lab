import { readFile } from "node:fs/promises";
import { z } from "zod";

const statusSchema = z.enum(["pass", "fail", "unmeasured"]);
const operationStatusesSchema = z
  .object({ move: statusSchema, opacity: statusSchema, rotation: statusSchema, "uniform-resize": statusSchema })
  .strict();
const stagesSchema = z
  .object({
    binding: statusSchema,
    discovery: statusSchema,
    edit: operationStatusesSchema,
    "fresh-validation": statusSchema,
    preview: statusSchema,
    "py-export": statusSchema,
    reimport: statusSchema,
    selection: statusSchema,
  })
  .strict();
const measuredRootCoverageFields = {
  accepted: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  fixturePath: z.string().min(1),
  missing: z.number().int().nonnegative(),
  silentOmissions: z.number().int().nonnegative(),
};
const rootCoverageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unmeasured") }).strict(),
  z.object({ ...measuredRootCoverageFields, status: z.literal("pass") }).strict(),
  z.object({ ...measuredRootCoverageFields, reason: z.string().min(1), status: z.literal("fail") }).strict(),
]);
const completionSchema = z
  .object({
    acceptedVisibleRootMissing: z.object({ met: z.boolean(), observed: z.number(), required: z.literal(0) }).strict(),
    claimedEditRoundtripPercent: z
      .object({ met: z.boolean(), observed: z.number().min(0).max(100), required: z.literal(100) })
      .strict(),
    silentOmissions: z.object({ met: z.boolean(), observed: z.number(), required: z.literal(0) }).strict(),
  })
  .strict();
const caseSchema = z
  .object({
    failures: z.record(z.string(), z.enum(["read-only", "unsupported"])).optional(),
    fixturePaths: z.array(z.string().min(1)).min(1),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    notes: z.record(z.string(), z.string().min(1)),
    rootCoverage: rootCoverageSchema,
    sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    sourcePath: z.string().min(1),
    stages: stagesSchema,
  })
  .strict();

function flattenedStatuses(stages: z.infer<typeof stagesSchema>) {
  return new Map<string, z.infer<typeof statusSchema>>([
    ["discovery", stages.discovery],
    ["preview", stages.preview],
    ["binding", stages.binding],
    ["selection", stages.selection],
    ["py-export", stages["py-export"]],
    ["reimport", stages.reimport],
    ["fresh-validation", stages["fresh-validation"]],
    ...Object.entries(stages.edit).map(([operation, status]) => [`edit.${operation}`, status] as const),
  ]);
}

const manifestSchema = z
  .object({
    cases: z.array(caseSchema).min(1),
    completion: completionSchema,
    evidenceTests: z.array(z.string().regex(/\.test\.tsx?$/u)).min(1),
    schema: z.literal("poietra.generic-importability-scoreboard"),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, entry] of manifest.cases.entries()) {
      if (ids.has(entry.id))
        context.addIssue({ code: "custom", message: "Duplicate case ID.", path: ["cases", index, "id"] });
      ids.add(entry.id);
      const statuses = flattenedStatuses(entry.stages);
      for (const [key, status] of statuses) {
        if (status !== "pass" && !entry.notes[key]) {
          context.addIssue({
            code: "custom",
            message: `${status} status requires a note.`,
            path: ["cases", index, "notes", key],
          });
        }
        if ((status === "fail") !== Boolean(entry.failures?.[key])) {
          context.addIssue({
            code: "custom",
            message: "Only failed stages require a failure kind.",
            path: ["cases", index, "failures", key],
          });
        }
      }
      for (const key of [...Object.keys(entry.notes), ...Object.keys(entry.failures ?? {})]) {
        if (!statuses.has(key))
          context.addIssue({ code: "custom", message: "Unknown stage key.", path: ["cases", index, key] });
      }
      if (
        entry.rootCoverage.status !== "unmeasured" &&
        (entry.rootCoverage.accepted + entry.rootCoverage.missing !== entry.rootCoverage.expected ||
          entry.rootCoverage.silentOmissions > entry.rootCoverage.missing)
      ) {
        context.addIssue({
          code: "custom",
          message: "Root coverage totals do not balance.",
          path: ["cases", index, "rootCoverage"],
        });
      }
      if (
        entry.rootCoverage.status === "pass" &&
        (entry.rootCoverage.missing !== 0 || entry.rootCoverage.silentOmissions !== 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Passing root coverage cannot contain missing or silent roots.",
          path: ["cases", index, "rootCoverage"],
        });
      }
      if (
        entry.rootCoverage.status === "fail" &&
        entry.rootCoverage.missing === 0 &&
        entry.rootCoverage.silentOmissions === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Failed root coverage must identify a missing or silent root.",
          path: ["cases", index, "rootCoverage"],
        });
      }
    }
  });

export type GenericImportabilityManifest = z.infer<typeof manifestSchema>;

export async function loadGenericImportabilityManifest(path: string): Promise<GenericImportabilityManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function calculateGenericImportabilityCompletion(manifest: GenericImportabilityManifest) {
  const measuredRoots = manifest.cases.flatMap(({ rootCoverage }) =>
    rootCoverage.status === "unmeasured" ? [] : [rootCoverage],
  );
  const silentOmissions = measuredRoots.reduce((sum, coverage) => sum + coverage.silentOmissions, 0);
  const acceptedVisibleRootMissing = measuredRoots.reduce((sum, coverage) => sum + coverage.missing, 0);
  let claimedEdits = 0;
  let roundtrippedEdits = 0;
  for (const entry of manifest.cases) {
    const operations = Object.values(entry.stages.edit).filter((status) => status === "pass").length;
    claimedEdits += operations;
    if (
      entry.stages["py-export"] === "pass" &&
      entry.stages.reimport === "pass" &&
      entry.stages["fresh-validation"] === "pass"
    ) {
      roundtrippedEdits += operations;
    }
  }
  const claimedEditRoundtripPercent = claimedEdits === 0 ? 100 : (roundtrippedEdits / claimedEdits) * 100;
  return {
    acceptedVisibleRootMissing: {
      met: acceptedVisibleRootMissing === 0,
      observed: acceptedVisibleRootMissing,
      required: 0 as const,
    },
    claimedEditRoundtripPercent: {
      met: claimedEditRoundtripPercent === 100,
      observed: claimedEditRoundtripPercent,
      required: 100 as const,
    },
    silentOmissions: { met: silentOmissions === 0, observed: silentOmissions, required: 0 as const },
  };
}
