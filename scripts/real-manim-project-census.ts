import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type RealManimCensusOutcome, summarizeRealManimCensusOutcomes } from "./real-manim-census-report";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_ID = /^[a-f0-9]{40}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;
const filePin = z.object({ path: z.string().regex(RELATIVE_PATH), sha256: z.string().regex(SHA256) }).strict();
const source = filePin
  .extend({
    features: z
      .array(
        z.enum(["always-redraw", "mathtex", "mobject-updater", "multiple-objects", "plugin-scene", "value-tracker"]),
      )
      .min(1),
    sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();
const repositoryPin = z
  .object({
    digest: z.string().regex(SHA256),
    repository: z.url(),
    revision: z.string().regex(GIT_ID),
    tree: z.string().regex(GIT_ID),
  })
  .strict();
const codebase = repositoryPin
  .extend({
    demoValue: z.number().int().min(1).max(3),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    implementationCost: z.number().int().min(1).max(3),
    license: filePin.extend({ spdx: z.literal("MIT") }).strict(),
    runtimeDependencies: z.enum(["external-locked", "external-unpinned", "producer-compatible"]),
    source,
    toolchain: z.array(filePin).min(1).max(8),
  })
  .strict();
const executionConfig = z
  .object({
    digest: z.string().regex(SHA256),
    disableCaching: z.literal(true),
    frame: z
      .object({
        height: z.number().positive().max(100),
        width: z.number().positive().max(100),
      })
      .strict(),
    pixelHeight: z.number().int().positive().max(16_384),
    pixelWidth: z.number().int().positive().max(16_384),
    quality: z.literal("low_quality"),
    renderer: z.literal("cairo"),
    saveLastFrame: z.literal(true),
  })
  .strict();
const manifestSchema = z
  .object({
    codebases: z.array(codebase).min(3).max(12),
    execution: executionConfig,
    producer: repositoryPin
      .extend({
        files: z.array(filePin).min(1).max(8),
        manimVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        runtimeTraceModule: z.literal("manim.renderer.runtime_trace"),
        snapshotModule: z.literal("manim.renderer.source_runtime_identity"),
        snapshotProfile: z.literal(2),
      })
      .strict(),
    schema: z.literal("poietra.real-manim-project-census-manifest"),
    version: z.literal(2),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, selected] of manifest.codebases.entries()) {
      if (ids.has(selected.id)) context.addIssue({ code: "custom", message: "Duplicate codebase ID." });
      ids.add(selected.id);
      if (selected.digest !== repositoryDigest(selected)) {
        context.addIssue({ code: "custom", message: "Codebase digest drifted.", path: ["codebases", index, "digest"] });
      }
      if (JSON.stringify([...new Set(selected.source.features)].sort()) !== JSON.stringify(selected.source.features)) {
        context.addIssue({
          code: "custom",
          message: "Features must be sorted and unique.",
          path: ["codebases", index, "source", "features"],
        });
      }
    }
    if (manifest.producer.digest !== repositoryDigest(manifest.producer)) {
      context.addIssue({ code: "custom", message: "Producer digest drifted.", path: ["producer", "digest"] });
    }
    if (manifest.execution.digest !== executionConfigDigest(manifest.execution)) {
      context.addIssue({ code: "custom", message: "Execution config digest drifted.", path: ["execution", "digest"] });
    }
  });

export type RealManimProjectCensusManifest = z.infer<typeof manifestSchema>;
export type RealManimProjectCensusObservation = Readonly<{
  codebaseId: string;
  execution:
    | { artifactBytes: number; artifactDigest: string; status: "passed" }
    | { reason: string; status: "blocked" };
  runtimeTrace:
    | { artifactDigest: string; outcome: "accepted"; reasons: readonly [] }
    | { outcome: "fallback" | "rejected"; reasons: readonly string[] };
  snapshotProbe:
    | { artifactDigest: string; outcome: "accepted"; reasons: readonly [] }
    | { outcome: "fallback" | "rejected"; reasons: readonly string[] };
  staticImport: { entityCount: number; sceneRecognized: boolean; unknownCount: number };
}>;

function repositoryDigest(pin: Readonly<{ repository: string; revision: string; tree: string }>) {
  return createHash("sha256")
    .update(pin.repository)
    .update("\0")
    .update(pin.revision)
    .update("\0")
    .update(pin.tree)
    .digest("hex");
}

function executionConfigDigest(config: Readonly<z.infer<typeof executionConfig>>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        disableCaching: config.disableCaching,
        frame: config.frame,
        pixelHeight: config.pixelHeight,
        pixelWidth: config.pixelWidth,
        quality: config.quality,
        renderer: config.renderer,
        saveLastFrame: config.saveLastFrame,
      }),
    )
    .digest("hex");
}

export async function loadRealManimProjectCensusManifest(path: string | URL) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1024 * 1024) throw new Error("Real Manim project census manifest exceeds 1 MiB.");
  try {
    return manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    throw new Error("Real Manim project census manifest is invalid.", { cause });
  }
}

const stages = ["static-import", "runtime-trace-preview", "selection", "edit", "export", "fresh-validation"] as const;

function validateAttempt(
  observation: RealManimProjectCensusObservation["runtimeTrace"] | RealManimProjectCensusObservation["snapshotProbe"],
) {
  if (observation.outcome === "accepted") {
    if (!SHA256.test(observation.artifactDigest) || observation.reasons.length !== 0) {
      throw new Error("Accepted preview evidence is invalid.");
    }
    return;
  }
  if (observation.reasons.length === 0) throw new Error("Non-accepted preview requires a reason.");
  const expectedPrefix = observation.outcome === "fallback" ? "unsupported:" : "failure:";
  if (!observation.reasons.some((reason) => reason.startsWith(expectedPrefix))) {
    throw new Error(`${observation.outcome} preview reason is invalid.`);
  }
}

export function buildRealManimProjectCensusReport(
  manifest: RealManimProjectCensusManifest,
  observations: readonly RealManimProjectCensusObservation[],
) {
  const parsed = manifestSchema.parse(manifest);
  const observed = new Map<string, RealManimProjectCensusObservation>();
  for (const observation of observations) {
    if (observed.has(observation.codebaseId)) throw new Error(`Duplicate observation: ${observation.codebaseId}`);
    validateAttempt(observation.runtimeTrace);
    validateAttempt(observation.snapshotProbe);
    if (
      (observation.execution.status === "passed" &&
        (!SHA256.test(observation.execution.artifactDigest) ||
          observation.execution.artifactBytes < 1 ||
          observation.execution.artifactBytes > 16 * 1024 * 1024)) ||
      (observation.execution.status === "blocked" && observation.execution.reason.length === 0)
    ) {
      throw new Error("Source execution evidence is invalid.");
    }
    observed.set(observation.codebaseId, observation);
  }
  const missing = parsed.codebases.filter(({ id }) => !observed.has(id)).map(({ id }) => id);
  if (missing.length > 0 || observed.size !== parsed.codebases.length) {
    throw new Error(`Observations do not match the manifest: ${missing.join(", ")}`);
  }
  const featureCounts = Object.fromEntries(
    [...new Set(parsed.codebases.flatMap(({ source: selected }) => selected.features))]
      .sort()
      .map((feature) => [
        feature,
        parsed.codebases.filter(({ source: selected }) => selected.features.includes(feature)).length,
      ]),
  );
  const results = Object.fromEntries(
    parsed.codebases.map((selected) => {
      const observation = observed.get(selected.id)!;
      const staticOutcome: RealManimCensusOutcome =
        observation.staticImport.sceneRecognized && observation.staticImport.entityCount > 0 ? "accepted" : "fallback";
      const blocked = (dependency: string) => ({
        measured: false,
        outcome: "fallback" as const,
        reasons: [`blocked-by:${dependency}`],
      });
      return [
        selected.id,
        {
          execution: observation.execution,
          sceneName: selected.source.sceneName,
          snapshotProbe: observation.snapshotProbe,
          stages: {
            edit: blocked("selection"),
            export: blocked("edit"),
            "fresh-validation": blocked("export"),
            "runtime-trace-preview": { measured: true, ...observation.runtimeTrace },
            selection: blocked("runtime-trace-preview"),
            "static-import": {
              entityCount: observation.staticImport.entityCount,
              measured: true,
              outcome: staticOutcome,
              reasons:
                staticOutcome === "accepted"
                  ? []
                  : [
                      observation.staticImport.sceneRecognized
                        ? "unsupported:runtime-semantics-unsupported"
                        : "unsupported:scene-base-unsupported",
                    ],
              sceneRecognized: observation.staticImport.sceneRecognized,
              unknownCount: observation.staticImport.unknownCount,
            },
          },
        },
      ];
    }),
  );
  const candidates = parsed.codebases.map((selected) => {
    const result = results[selected.id]!;
    return {
      codebaseId: selected.id,
      demoValue: selected.demoValue,
      featureOccurrenceTotal: selected.source.features.reduce((sum, feature) => sum + featureCounts[feature]!, 0),
      implementationCost: selected.implementationCost,
      runtimeTraceOutcome: result.stages["runtime-trace-preview"].outcome,
      snapshotOutcome: result.snapshotProbe.outcome,
      producerCompatible: selected.runtimeDependencies === "producer-compatible",
      sceneRecognized: result.stages["static-import"].sceneRecognized,
      sourceExecution: result.execution.status,
    };
  });
  const safeCandidates = candidates.filter(
    ({ producerCompatible, runtimeTraceOutcome, sceneRecognized, snapshotOutcome, sourceExecution }) =>
      (runtimeTraceOutcome === "accepted" || runtimeTraceOutcome === "fallback") &&
      snapshotOutcome === "fallback" &&
      producerCompatible &&
      sceneRecognized &&
      sourceExecution === "passed",
  );
  const fallbackCandidates = safeCandidates.filter(({ runtimeTraceOutcome }) => runtimeTraceOutcome === "fallback");
  // Preserve the original gap-target ranking while one exists. An accepted
  // generic preview is the deterministic fallback when producer improvements
  // close every measured preview gap.
  const eligible = (fallbackCandidates.length > 0 ? fallbackCandidates : safeCandidates).sort(
    (left, right) =>
      right.demoValue - left.demoValue ||
      left.implementationCost - right.implementationCost ||
      right.featureOccurrenceTotal - left.featureOccurrenceTotal ||
      left.codebaseId.localeCompare(right.codebaseId),
  );
  if (eligible.length === 0) throw new Error("No safe generic Runtime Trace target candidate was measured.");
  const stageSummary = Object.fromEntries(
    stages.map((stage) => {
      const stageResults = Object.values(results).map((result) => result.stages[stage]);
      return [
        stage,
        {
          ...summarizeRealManimCensusOutcomes(stageResults.map(({ outcome }) => outcome as RealManimCensusOutcome)),
          measured: stageResults.filter((result) => result.measured).length,
          unmeasured: stageResults.filter((result) => !result.measured).length,
        },
      ];
    }),
  );
  return {
    schema: "poietra.real-manim-project-census-report",
    version: 2,
    manifestDigest: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
    executionConfigDigest: parsed.execution.digest,
    producerDigest: parsed.producer.digest,
    producerSnapshotProfile: parsed.producer.snapshotProfile,
    featureCounts,
    results,
    stageSummary,
    targetSelection: {
      candidates,
      followUpIssue: 509,
      selectedCodebaseId: eligible[0]!.codebaseId,
      reasons: [
        "bounded-source-execution-passed",
        eligible[0]!.runtimeTraceOutcome === "accepted"
          ? "generic-runtime-trace-preview-accepted"
          : "generic-runtime-trace-gap-observed",
        "safe-snapshot-fallback",
        "source-scene-recognized",
        "producer-compatible-dependencies",
      ],
    },
    v1Reference: {
      compatibilityAttempts: { accepted: 7, fallback: 49, rejected: 0, total: 56 },
      compatibilityScenes: { accepted: 7, fallback: 0, rejected: 0, total: 7 },
      sceneSpecificRuntimeTrace: {
        accepted: 2,
        scenes: ["OpeningManim", "UpdatersExample"],
      },
    },
  } as const;
}
