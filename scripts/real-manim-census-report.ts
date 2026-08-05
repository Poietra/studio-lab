import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  fastManimSnapshotContractErrorCodeV1Schema,
  fastManimSnapshotIssueCodeV1Schema,
  fastManimSnapshotRunFailureCodeV1Schema,
} from "../server/fast-manim-snapshot-contract";

const MANIFEST_SCHEMA = "poietra.real-manim-census-manifest";
const REPORT_SCHEMA = "poietra.real-manim-census-report";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_ID = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;
const FAST_MANIM_BASIC_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";

export const REAL_MANIM_CENSUS_FEATURES = [
  "always-redraw",
  "animation-builder",
  "apply-pointwise-function",
  "asset",
  "create",
  "custom-easing",
  "default-manim-easing",
  "fade",
  "hierarchy",
  "mathtex",
  "mobject-updater",
  "module-global-default",
  "multi-animation-play",
  "multi-scene-module",
  "runtime-generated-geometry",
  "spiral-in",
  "style",
  "tex",
  "transform",
  "value-tracker",
  "write",
] as const;

const corpusSchema = z.enum(["calibration", "compatibility"]);
const featureSchema = z.enum(REAL_MANIM_CENSUS_FEATURES);
const profileSchema = z.number().int().min(1).max(12);
const sceneSchema = z
  .object({
    features: z.array(featureSchema).max(32).optional(),
    name: z.string().min(1).max(128).regex(IDENTIFIER),
    profiles: z.array(profileSchema).min(1).max(8),
  })
  .strict()
  .superRefine((scene, context) => {
    for (const [field, values, sorted] of [
      ["profiles", scene.profiles, [...scene.profiles].sort((left, right) => left - right)],
      ["features", scene.features ?? [], [...(scene.features ?? [])].sort()],
    ] as const) {
      if (new Set(values).size !== values.length || sorted.some((value, index) => value !== values[index])) {
        context.addIssue({ code: "custom", message: `${field} must be sorted and unique.`, path: [field] });
      }
    }
  });
const assetSchema = z
  .object({
    id: z.string().min(1).max(80).regex(SLUG),
    sha256: z.string().regex(SHA256),
    versionToken: z.string().min(1).max(128),
  })
  .strict();
const manifestSchema = z
  .object({
    assets: z.array(assetSchema).max(32),
    producer: z
      .object({
        digest: z.string().regex(SHA256),
        digestAlgorithm: z.literal("sha256(repository-nul-revision-nul-tree)"),
        licenses: z
          .array(
            z
              .object({
                path: z.string().min(1).max(256).regex(RELATIVE_PATH),
                spdx: z.string().min(1).max(80),
              })
              .strict(),
          )
          .min(1)
          .max(8),
        module: z.string().min(1).max(256),
        repository: z.url(),
        revision: z.string().regex(GIT_ID),
        tree: z.string().regex(GIT_ID),
      })
      .strict(),
    schema: z.literal(MANIFEST_SCHEMA),
    sources: z
      .array(
        z
          .object({
            asset: z.string().min(1).max(80).regex(SLUG).optional(),
            corpus: corpusSchema,
            id: z.string().min(1).max(80).regex(SLUG),
            path: z.string().min(1).max(512).regex(RELATIVE_PATH),
            repository: z.enum(["fast-manim", "studio-lab"]),
            scenes: z.array(sceneSchema).min(1).max(128),
            sha256: z.string().regex(SHA256),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    version: z.literal(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const assetIds = new Set<string>();
    for (const [assetIndex, asset] of manifest.assets.entries()) {
      if (assetIds.has(asset.id)) {
        context.addIssue({ code: "custom", message: "Duplicate asset ID.", path: ["assets", assetIndex, "id"] });
      }
      assetIds.add(asset.id);
    }
    const sourceIds = new Set<string>();
    const sceneIds = new Set<string>();
    for (const [sourceIndex, source] of manifest.sources.entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({ code: "custom", message: "Duplicate source ID.", path: ["sources", sourceIndex, "id"] });
      }
      sourceIds.add(source.id);
      if (source.asset !== undefined && !assetIds.has(source.asset)) {
        context.addIssue({ code: "custom", message: "Unknown asset ID.", path: ["sources", sourceIndex, "asset"] });
      }
      for (const [sceneIndex, scene] of source.scenes.entries()) {
        if (
          scene.profiles.includes(8) &&
          !(
            source.asset === undefined &&
            source.corpus === "compatibility" &&
            source.id === "fast-manim-basic" &&
            source.path === "example_scenes/basic.py" &&
            source.repository === "fast-manim" &&
            source.sha256 === FAST_MANIM_BASIC_SOURCE_SHA256 &&
            scene.name === "SquareToCircle"
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Profile V8 is reserved for the exact pinned fast-manim SquareToCircle source.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "profiles"],
          });
        }
        if (
          scene.profiles.includes(9) &&
          !(
            source.asset === undefined &&
            source.corpus === "compatibility" &&
            source.id === "fast-manim-basic" &&
            source.path === "example_scenes/basic.py" &&
            source.repository === "fast-manim" &&
            source.sha256 === FAST_MANIM_BASIC_SOURCE_SHA256 &&
            scene.name === "WarpSquare"
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Profile V9 is reserved for the exact pinned fast-manim WarpSquare source.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "profiles"],
          });
        }
        if (
          scene.profiles.includes(10) &&
          !(
            source.asset === undefined &&
            source.corpus === "compatibility" &&
            source.id === "fast-manim-basic" &&
            source.path === "example_scenes/basic.py" &&
            source.repository === "fast-manim" &&
            source.sha256 === FAST_MANIM_BASIC_SOURCE_SHA256 &&
            scene.name === "LineJoints"
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Profile V10 is reserved for the exact pinned fast-manim LineJoints source.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "profiles"],
          });
        }
        if (
          scene.profiles.includes(11) &&
          !(
            source.asset === undefined &&
            source.corpus === "compatibility" &&
            source.id === "fast-manim-basic" &&
            source.path === "example_scenes/basic.py" &&
            source.repository === "fast-manim" &&
            source.sha256 === FAST_MANIM_BASIC_SOURCE_SHA256 &&
            scene.name === "SpiralInExample"
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Profile V11 is reserved for the exact pinned fast-manim SpiralInExample source.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "profiles"],
          });
        }
        if (
          scene.profiles.includes(12) &&
          !(
            source.asset === undefined &&
            source.corpus === "compatibility" &&
            source.id === "fast-manim-basic" &&
            source.path === "example_scenes/basic.py" &&
            source.repository === "fast-manim" &&
            source.sha256 === FAST_MANIM_BASIC_SOURCE_SHA256 &&
            scene.name === "WriteStuff"
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Profile V12 is reserved for the exact pinned fast-manim WriteStuff source.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "profiles"],
          });
        }
        const sceneId = realManimCensusSceneId(source.id, scene.name);
        if (sceneIds.has(sceneId)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate scene ID.",
            path: ["sources", sourceIndex, "scenes", sceneIndex, "name"],
          });
        }
        sceneIds.add(sceneId);
      }
    }
  });

export type RealManimCensusManifest = z.infer<typeof manifestSchema>;
export type RealManimCensusCorpus = z.infer<typeof corpusSchema>;
export type RealManimCensusOutcome = "accepted" | "fallback" | "rejected";

const outcomeSchema = z.enum(["accepted", "fallback", "rejected"]);
const fallbackReasons = new Set(fastManimSnapshotIssueCodeV1Schema.options.map((code) => `unsupported:${code}`));
const failureReasons = new Set(fastManimSnapshotRunFailureCodeV1Schema.options.map((code) => `failure:${code}`));
const contractReasons = new Set(fastManimSnapshotContractErrorCodeV1Schema.options.map((code) => `contract:${code}`));
const knownReasons = new Set([...fallbackReasons, ...failureReasons, ...contractReasons]);
const reasonSchema = z.string().refine((reason) => knownReasons.has(reason), "Unknown census reason.");
const resultEvidenceSchema = z
  .object({
    outcome: outcomeSchema,
    reasons: z.array(reasonSchema).max(24),
    snapshotHash: z.string().regex(SHA256).optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const canonical = [...new Set(evidence.reasons)].sort();
    if (
      canonical.some((reason, index) => reason !== evidence.reasons[index]) ||
      canonical.length !== evidence.reasons.length
    ) {
      context.addIssue({ code: "custom", message: "Reasons must be sorted and unique.", path: ["reasons"] });
    }
    const accepted = evidence.outcome === "accepted";
    if (accepted !== (evidence.snapshotHash !== undefined) || accepted !== (evidence.reasons.length === 0)) {
      context.addIssue({ code: "custom", message: "Attempt outcome evidence is inconsistent." });
    }
    if (evidence.outcome === "fallback" && evidence.reasons.some((reason) => !fallbackReasons.has(reason))) {
      context.addIssue({ code: "custom", message: "Fallback accepts only unsupported reasons.", path: ["reasons"] });
    }
    if (
      evidence.outcome === "rejected" &&
      (evidence.reasons.some((reason) => fallbackReasons.has(reason)) ||
        !evidence.reasons.some((reason) => failureReasons.has(reason)))
    ) {
      context.addIssue({ code: "custom", message: "Rejected attempts require a failure reason.", path: ["reasons"] });
    }
  });
const attemptSchema = z
  .object({
    caseId: z.string().min(1).max(256),
    corpus: corpusSchema,
    features: z.array(featureSchema).max(32),
    outcome: outcomeSchema,
    profile: profileSchema,
    reasons: z.array(reasonSchema).max(24),
    sceneName: z.string().min(1).max(128).regex(IDENTIFIER),
    snapshotHash: z.string().regex(SHA256).optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const parsed = resultEvidenceSchema.safeParse({
      outcome: attempt.outcome,
      reasons: attempt.reasons,
      snapshotHash: attempt.snapshotHash,
    });
    for (const issue of parsed.error?.issues ?? []) context.addIssue(issue);
  });

export type RealManimCensusAttempt = z.input<typeof attemptSchema>;

const countSchema = z.number().int().nonnegative();
const countsSchema = z
  .object({ accepted: countSchema, fallback: countSchema, rejected: countSchema, total: countSchema })
  .strict();
const corpusCountsSchema = z.object({ attempts: countsSchema, scenes: countsSchema }).strict();
const reportSchema = z
  .object({
    corpusDigest: z.string().regex(SHA256),
    manifestDigest: z.string().regex(SHA256),
    manifestVersion: z.literal(1),
    producerDigest: z.string().regex(SHA256),
    reasonCounts: z.record(reasonSchema, countSchema),
    results: z.record(z.string().min(1).max(256), resultEvidenceSchema),
    scenes: z.record(z.string().min(1).max(240), outcomeSchema),
    schema: z.literal(REPORT_SCHEMA),
    summary: z
      .object({
        attempts: countsSchema,
        corpora: z.object({ calibration: corpusCountsSchema, compatibility: corpusCountsSchema }).strict(),
        scenes: countsSchema,
      })
      .strict(),
    version: z.literal(1),
  })
  .strict();

export type RealManimCensusReport = z.infer<typeof reportSchema>;

export function realManimCensusSceneId(sourceId: string, sceneName: string) {
  return `${sourceId}/${sceneName}`;
}

export function realManimCensusCaseId(sourceId: string, sceneName: string, profile: number) {
  return `${realManimCensusSceneId(sourceId, sceneName)}/v${profile}`;
}

export async function loadRealManimCensusManifest(path: string | URL): Promise<RealManimCensusManifest> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1024 * 1024) throw new Error("Real Manim census manifest exceeds 1 MiB.");
  try {
    return manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    throw new Error("Real Manim census manifest is invalid.", { cause });
  }
}

type Counts = { accepted: number; fallback: number; rejected: number; total: number };
const emptyCounts = (): Counts => ({ accepted: 0, fallback: 0, rejected: 0, total: 0 });
function increment(counts: Counts, outcome: RealManimCensusOutcome) {
  counts[outcome] += 1;
  counts.total += 1;
}

export function buildRealManimCensusReport(
  manifestInput: RealManimCensusManifest,
  producerDigest: string,
  attemptsInput: readonly RealManimCensusAttempt[],
): RealManimCensusReport {
  const manifest = manifestSchema.parse(manifestInput);
  if (producerDigest !== manifest.producer.digest) throw new Error("Producer digest does not match the manifest pin.");
  const expected = new Map<
    string,
    { corpus: RealManimCensusCorpus; features: string[]; profile: number; sceneId: string; sceneName: string }
  >();
  for (const source of manifest.sources) {
    for (const scene of source.scenes) {
      const sceneId = realManimCensusSceneId(source.id, scene.name);
      for (const profile of scene.profiles) {
        expected.set(realManimCensusCaseId(source.id, scene.name, profile), {
          corpus: source.corpus,
          features: [...(scene.features ?? [])],
          profile,
          sceneId,
          sceneName: scene.name,
        });
      }
    }
  }
  const seen = new Set<string>();
  const sceneAttempts = new Map<string, Array<z.infer<typeof attemptSchema>>>();
  const results = attemptsInput.map((input) => {
    const attempt = attemptSchema.parse(input);
    if (seen.has(attempt.caseId)) throw new Error(`Duplicate census attempt: ${attempt.caseId}`);
    seen.add(attempt.caseId);
    const pinned = expected.get(attempt.caseId);
    if (
      pinned === undefined ||
      pinned.corpus !== attempt.corpus ||
      pinned.profile !== attempt.profile ||
      pinned.sceneName !== attempt.sceneName ||
      JSON.stringify(pinned.features) !== JSON.stringify(attempt.features)
    ) {
      throw new Error(`Census attempt does not match the manifest: ${attempt.caseId}`);
    }
    const selected = sceneAttempts.get(pinned.sceneId) ?? [];
    selected.push(attempt);
    sceneAttempts.set(pinned.sceneId, selected);
    return attempt;
  });
  const missing = [...expected.keys()].filter((caseId) => !seen.has(caseId)).sort();
  if (missing.length > 0) throw new Error(`Missing census attempts: ${missing.join(", ")}`);
  results.sort((left, right) => left.caseId.localeCompare(right.caseId));

  const attempts = emptyCounts();
  const corpusAttempts = { calibration: emptyCounts(), compatibility: emptyCounts() };
  const reasonCounts = new Map<string, number>();
  for (const result of results) {
    increment(attempts, result.outcome);
    increment(corpusAttempts[result.corpus], result.outcome);
    for (const reason of result.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const scenes = [...sceneAttempts.entries()]
    .map(([sceneId, values]) => {
      const first = values[0]!;
      const outcome = values.some((value) => value.outcome === "accepted")
        ? "accepted"
        : values.every((value) => value.outcome === "fallback")
          ? "fallback"
          : "rejected";
      return { corpus: first.corpus, features: first.features, outcome, sceneId, sceneName: first.sceneName };
    })
    .sort((left, right) => left.sceneId.localeCompare(right.sceneId));
  const sceneCounts = emptyCounts();
  const corpusScenes = { calibration: emptyCounts(), compatibility: emptyCounts() };
  for (const scene of scenes) {
    increment(sceneCounts, scene.outcome);
    increment(corpusScenes[scene.corpus], scene.outcome);
  }
  return reportSchema.parse({
    corpusDigest: createHash("sha256")
      .update(JSON.stringify({ assets: manifest.assets, sources: manifest.sources }))
      .digest("hex"),
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    manifestVersion: manifest.version,
    producerDigest,
    reasonCounts: Object.fromEntries([...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    results: Object.fromEntries(
      results.map(({ caseId, outcome, reasons, snapshotHash }) => [
        caseId,
        { outcome, reasons, ...(snapshotHash ? { snapshotHash } : {}) },
      ]),
    ),
    scenes: Object.fromEntries(scenes.map(({ outcome, sceneId }) => [sceneId, outcome])),
    schema: REPORT_SCHEMA,
    summary: {
      attempts,
      corpora: {
        calibration: { attempts: corpusAttempts.calibration, scenes: corpusScenes.calibration },
        compatibility: { attempts: corpusAttempts.compatibility, scenes: corpusScenes.compatibility },
      },
      scenes: sceneCounts,
    },
    version: 1,
  });
}

export function assertRealManimCensusFloor(reportInput: unknown, baselineInput: unknown): void {
  const report = reportSchema.parse(reportInput);
  const baseline = reportSchema.parse(baselineInput);
  if (report.corpusDigest !== baseline.corpusDigest || report.manifestVersion !== baseline.manifestVersion) {
    throw new Error("Census report and baseline use different corpora.");
  }
  const acceptedFloors = [
    ["Accepted scene", report.summary.scenes.accepted, baseline.summary.scenes.accepted],
    ["Accepted attempt", report.summary.attempts.accepted, baseline.summary.attempts.accepted],
    ...(["calibration", "compatibility"] as const).flatMap((corpus) => [
      [
        `Accepted ${corpus} scene`,
        report.summary.corpora[corpus].scenes.accepted,
        baseline.summary.corpora[corpus].scenes.accepted,
      ] as const,
      [
        `Accepted ${corpus} attempt`,
        report.summary.corpora[corpus].attempts.accepted,
        baseline.summary.corpora[corpus].attempts.accepted,
      ] as const,
    ]),
  ] as const;
  for (const [name, current, floor] of acceptedFloors) {
    if (current < floor) throw new Error(`${name} count is below the census baseline.`);
  }
  const reportKeys = Object.keys(report.results);
  const baselineKeys = Object.keys(baseline.results);
  if (
    [...reportKeys].sort().some((caseId, index) => caseId !== reportKeys[index]) ||
    [...baselineKeys].sort().some((caseId, index) => caseId !== baselineKeys[index]) ||
    reportKeys.length !== baselineKeys.length ||
    reportKeys.some((caseId, index) => caseId !== baselineKeys[index])
  ) {
    throw new Error("Census report case IDs are noncanonical or differ from the baseline.");
  }
  for (const [caseId, result] of Object.entries(baseline.results)) {
    if (result.outcome !== "accepted") continue;
    const current = report.results[caseId];
    if (current?.outcome !== "accepted") {
      throw new Error(`Previously accepted census case is no longer accepted: ${caseId}`);
    }
    if (report.producerDigest === baseline.producerDigest && current.snapshotHash !== result.snapshotHash) {
      throw new Error(`Accepted census snapshot changed under the same producer pin: ${caseId}`);
    }
  }
  if (report.summary.attempts.rejected > baseline.summary.attempts.rejected) {
    throw new Error("Rejected attempt count exceeds the census baseline.");
  }
  for (const corpus of ["calibration", "compatibility"] as const) {
    if (report.summary.corpora[corpus].attempts.rejected > baseline.summary.corpora[corpus].attempts.rejected) {
      throw new Error(`Unexpected ${corpus}-corpus rejections exceed the census baseline.`);
    }
  }
  for (const [caseId, result] of Object.entries(baseline.results)) {
    if (result.outcome === "fallback" && report.results[caseId]?.outcome === "rejected") {
      throw new Error(`Previously safe fallback census case is now rejected: ${caseId}`);
    }
  }
}
