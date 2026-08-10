import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseVerifiedSceneIrBundleV1, sha256V1Schema, sourceIdentityV1Schema } from "../src/engine/contracts";
import {
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  fastManimRuntimeTraceCoordinateV3Schema,
  fastManimRuntimeTraceSourceBindingEndpointV3Schema,
  fastManimRuntimeTraceSourceBindingV3Schema,
} from "../src/render-pipeline/runtime-trace-v3-shared-contract";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import {
  deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3,
  deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3,
} from "../src/render-pipeline/source-lowering";
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  fastManimRuntimeTraceProducerEnvironment,
  TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
} from "./fast-manim-runtime-trace-producer-identity";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "./manim-render-config";
import { ManimSourceStore } from "./manim-source-store";

const execute = promisify(execFile);
const producerCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND);
const sourceRoot = process.env.POIETRA_SECOND_EDITABLE_SCENE_SOURCE_ROOT?.trim();
const texBin = process.env.POIETRA_CAIRO_TEX_BIN?.trim();
const update = process.env.POIETRA_SECOND_EDITABLE_SCENE_UPDATE === "1";

const SCENE_NAME = "FeynmanDiagram";
const SOURCE_PATH = "legacy/Math-To-Manim/examples/physics/quantum/Hunyuan-T1QED.py";
const PINNED_SOURCE_SHA256 = "50588cf26a63b955f59c0411886f1781276c59c8cd5ad65963dc9c56759a5e9f";
const EVIDENCE_SCHEMA = "poietra.second-editable-scene-v3-runtime-trace-evidence";
const EVIDENCE_VERSION = 1;
const EXPECTED_BINDING_NAMES = ["electron1", "electron2", "photon", "labels"] as const;
const BASELINE_PATH = fileURLToPath(
  new URL("../fixtures/feynman-diagram-v3-runtime-trace-v1/baseline.json", import.meta.url),
);

const evidenceRootSchema = z
  .object({
    binding: fastManimRuntimeTraceSourceBindingV3Schema,
    entityId: sourceIdentityV1Schema,
    evidence: z
      .object({
        endpoints: z
          .object({
            initial: fastManimRuntimeTraceSourceBindingEndpointV3Schema,
            terminal: fastManimRuntimeTraceSourceBindingEndpointV3Schema,
          })
          .strict(),
        updaterStatus: z.literal("none"),
      })
      .strict(),
    sourceCapabilities: z
      .object({ move: z.literal("source-eligible"), uniformResize: z.literal("source-eligible") })
      .strict(),
  })
  .strict();

const feynmanRuntimeTraceEvidenceV1Schema = z
  .object({
    cairoSmoke: z
      .object({
        artifactBytes: z
          .number()
          .int()
          .positive()
          .max(16 * 1024 * 1024),
        artifactSha256: sha256V1Schema,
        pixelHeight: z.literal(480),
        pixelWidth: z.literal(854),
        renderer: z.literal("cairo"),
      })
      .strict(),
    outcome: z.literal("verified"),
    producer: z
      .object({
        fastManimCommit: z.literal(TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit),
        fastManimTree: z.literal(TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree),
      })
      .strict(),
    producerEvidence: z.object({ correlationSha256: sha256V1Schema, semanticsSha256: sha256V1Schema }).strict(),
    roots: z.array(evidenceRootSchema).length(EXPECTED_BINDING_NAMES.length),
    runtimeConfigHash: sha256V1Schema,
    scene: z
      .object({
        className: z.literal(SCENE_NAME),
        repository: z.literal("https://github.com/HarleyCoops/Math-To-Manim.git"),
        revision: z.literal("fcad0674c9791690d47664492fd1a052024b63a0"),
        sourcePath: z.literal(SOURCE_PATH),
        sourceSha256: z.literal(PINNED_SOURCE_SHA256),
        tree: z.literal("d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698"),
      })
      .strict(),
    sceneDuration: fastManimRuntimeTraceCoordinateV3Schema
      .positive()
      .max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3),
    sceneId: sourceIdentityV1Schema,
    schema: z.literal(EVIDENCE_SCHEMA),
    traceDigest: sha256V1Schema,
    version: z.literal(EVIDENCE_VERSION),
  })
  .strict()
  .superRefine(({ roots }, context) => {
    if (roots.some(({ binding }, index) => binding.name !== EXPECTED_BINDING_NAMES[index])) {
      context.addIssue({
        code: "custom",
        message: "Second editable Scene evidence bindings must match the reviewed SourceAnalysis order.",
        path: ["roots"],
      });
    }
    for (const [label, values] of [
      ["binding IDs", roots.map(({ binding }) => binding.id)],
      ["binding names", roots.map(({ binding }) => binding.name)],
      ["binding ordinals", roots.map(({ binding }) => binding.ordinal)],
      ["root entity IDs", roots.map(({ entityId }) => entityId)],
    ] as const) {
      if (new Set(values.map(String)).size !== roots.length) {
        context.addIssue({
          code: "custom",
          message: `Second editable Scene evidence must have unique ${label}.`,
          path: ["roots"],
        });
      }
    }
  });

function readEvidenceBaseline() {
  return feynmanRuntimeTraceEvidenceV1Schema.parse(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
}

async function renderCairoSmoke(root: string, python: string) {
  const mediaRoot = join(root, "cairo-smoke");
  await execute(
    python,
    [
      "-m",
      "manim",
      "-ql",
      "-s",
      "--disable_caching",
      "--renderer",
      "cairo",
      "--resolution",
      "854,480",
      "--media_dir",
      mediaRoot,
      join(root, SOURCE_PATH),
      SCENE_NAME,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: root,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: `${texBin}:${dirname(python)}:/usr/bin:/bin`,
        PYTHONHASHSEED: "0",
        TMPDIR: root,
        XDG_CACHE_HOME: join(root, "cache"),
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const pngPaths = (await readdir(mediaRoot, { recursive: true })).filter((path) => path.endsWith(".png")).sort();
  if (pngPaths.length !== 1) throw new Error("FeynmanDiagram Cairo smoke must produce exactly one PNG.");
  const bytes = readFileSync(join(mediaRoot, pngPaths[0]!));
  return {
    artifactBytes: bytes.byteLength,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    pixelHeight: 480 as const,
    pixelWidth: 854 as const,
    renderer: "cairo" as const,
  };
}

describe("FeynmanDiagram Runtime Trace evidence baseline", () => {
  it.skipIf(update)("is a bounded updater-free fixture for the current producer and source pins", () => {
    const baseline = readEvidenceBaseline();
    expect(baseline.roots.map(({ binding }) => binding.name)).toEqual(EXPECTED_BINDING_NAMES);
    expect(baseline.roots.every(({ evidence }) => evidence.updaterStatus === "none")).toBe(true);
    expect(baseline.roots).toHaveLength(4);
    expect(baseline.sceneDuration).toBe(1);
  });

  it.skipIf(update)("rejects conflicted updater authority and duplicate roots", () => {
    const baseline = readEvidenceBaseline();
    const conflicted = {
      ...baseline,
      roots: baseline.roots.map((root, index) =>
        index === 0 ? { ...root, evidence: { ...root.evidence, updaterStatus: "conflict" } } : root,
      ),
    };
    expect(feynmanRuntimeTraceEvidenceV1Schema.safeParse(conflicted).success).toBe(false);
    const duplicateRoot = structuredClone(baseline);
    duplicateRoot.roots[1]!.entityId = duplicateRoot.roots[0]!.entityId;
    expect(feynmanRuntimeTraceEvidenceV1Schema.safeParse(duplicateRoot).success).toBe(false);
  });

  it.runIf(update)("requires the real pinned producer, source, and TeX toolchain before updating", () => {
    expect(producerCommand, "POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND is required to update evidence.").toBeDefined();
    expect(sourceRoot, "POIETRA_SECOND_EDITABLE_SCENE_SOURCE_ROOT is required to update evidence.").toBeTruthy();
    expect(texBin, "POIETRA_CAIRO_TEX_BIN is required to update evidence.").toBeTruthy();
    expect(ManimSourceStore.supportsVerifiedRead, "Verified source reads are required to update evidence.").toBe(true);
  });
});

describe.skipIf(!producerCommand || !sourceRoot || !texBin || !ManimSourceStore.supportsVerifiedRead)(
  "real FeynmanDiagram Runtime Trace evidence",
  () => {
    it("records the pinned generic V3 preview and independent Cairo smoke", { timeout: 300_000 }, async () => {
      const source = readFileSync(join(sourceRoot!, SOURCE_PATH), "utf8");
      const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
      expect(sourceHash).toBe(PINNED_SOURCE_SHA256);
      const sourceAnalysis = studioSourceAnalysisProviderV1.analyze({
        expectedSourceHash: sourceHash,
        sceneName: SCENE_NAME,
        sourcePath: SOURCE_PATH,
        sourceText: source,
      });

      const root = await mkdtemp(join(tmpdir(), "poietra-feynman-runtime-trace-real-"));
      await mkdir(dirname(join(root, SOURCE_PATH)), { recursive: true });
      await writeFile(join(root, SOURCE_PATH), source, "utf8");
      const runner = new FastManimSnapshotRunner({
        backend: createConfiguredFastManimSandboxBackendV1({
          command: producerCommand,
          deployment: "test",
          localProcessDevOptIn: true,
          producerEnv: fastManimRuntimeTraceProducerEnvironment(),
          projectRoot: root,
        }),
        deployment: "test",
        frame: { height: 8, width: 14.222222222222221 },
        projectId: "second-editable-scene-evidence",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 120_000,
      });
      try {
        const view = await runner.runRuntimeTrace({
          projectId: "second-editable-scene-evidence",
          requestId: "feynman-diagram-v3-runtime-trace-evidence-1",
          responseVersion: 2,
          sceneName: SCENE_NAME,
          sourceHash,
          sourcePath: SOURCE_PATH,
        });
        if (view.status === "failed") {
          throw new Error(`FeynmanDiagram Runtime Trace failed (${view.failure.code}): ${view.failure.message}`);
        }
        if (view.version !== 2) {
          throw new Error("FeynmanDiagram Runtime Trace evidence requires a verified negotiated wire V2 result.");
        }
        const evidence = feynmanRuntimeTraceEvidenceV1Schema.parse({
          cairoSmoke: await renderCairoSmoke(root, producerCommand![0]!),
          outcome: "verified",
          producer: { ...TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY },
          producerEvidence: view.producerEvidence,
          roots: view.roots.map((viewRoot) => {
            const sourceBinding = sourceAnalysis.bindings.find(
              (binding) =>
                binding.scopeId === sourceAnalysis.scene.construct.scopeId &&
                binding.name === viewRoot.binding.name &&
                binding.ordinal === viewRoot.binding.ordinal,
            );
            if (!sourceBinding)
              throw new Error(`Runtime root ${viewRoot.binding.name} lost its SourceAnalysis binding.`);
            return {
              binding: viewRoot.binding,
              entityId: viewRoot.entityId,
              evidence: viewRoot.evidence,
              sourceCapabilities: {
                move: sourceBinding.capabilities.move.status,
                uniformResize: sourceBinding.capabilities.uniformResize.status,
              },
            };
          }),
          runtimeConfigHash: view.runtimeConfigHash,
          scene: {
            className: SCENE_NAME,
            repository: "https://github.com/HarleyCoops/Math-To-Manim.git",
            revision: "fcad0674c9791690d47664492fd1a052024b63a0",
            sourcePath: SOURCE_PATH,
            sourceSha256: PINNED_SOURCE_SHA256,
            tree: "d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698",
          },
          sceneDuration: (await parseVerifiedSceneIrBundleV1(view.bundle)).scene.duration,
          sceneId: view.sceneId,
          schema: EVIDENCE_SCHEMA,
          traceDigest: view.traceDigest,
          version: EVIDENCE_VERSION,
        });
        if (update) await writeFile(BASELINE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
        if (!existsSync(BASELINE_PATH)) {
          throw new Error("FeynmanDiagram evidence is absent. Run once with POIETRA_SECOND_EDITABLE_SCENE_UPDATE=1.");
        }
        expect(evidence).toEqual(readEvidenceBaseline());
      } finally {
        try {
          await runner.close();
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    });

    // The labels VGroup assignment closes on this unique line; a generic
    // initial edit inserts its one statement immediately after it.
    const LABELS_ASSIGNMENT_ANCHOR = ".next_to(photon.get_center(), UP)\n        )\n";

    async function candidateRoundtrip(
      candidateSource: string,
      request: Parameters<FastManimSnapshotRunner["runRuntimeTraceCandidateUnpublished"]>[1],
    ) {
      const root = await mkdtemp(join(tmpdir(), "poietra-feynman-labels-candidate-"));
      await mkdir(dirname(join(root, SOURCE_PATH)), { recursive: true });
      await writeFile(join(root, SOURCE_PATH), readFileSync(join(sourceRoot!, SOURCE_PATH), "utf8"), "utf8");
      const runner = new FastManimSnapshotRunner({
        backend: createConfiguredFastManimSandboxBackendV1({
          command: producerCommand,
          deployment: "test",
          localProcessDevOptIn: true,
          producerEnv: fastManimRuntimeTraceProducerEnvironment(),
          projectRoot: root,
        }),
        deployment: "test",
        frame: { height: 8, width: 14.222222222222221 },
        projectId: "second-editable-scene-evidence",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 120_000,
      });
      try {
        return await runner.runRuntimeTraceCandidateUnpublished(candidateSource, request);
      } finally {
        try {
          await runner.close();
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    }

    it("verifies a real labels initial-move candidate pair on the multi-root Scene", { timeout: 600_000 }, async () => {
      const source = readFileSync(join(sourceRoot!, SOURCE_PATH), "utf8");
      expect(createHash("sha256").update(source, "utf8").digest("hex")).toBe(PINNED_SOURCE_SHA256);
      expect(source.split(LABELS_ASSIGNMENT_ANCHOR)).toHaveLength(2);
      const candidateSource = source.replace(
        LABELS_ASSIGNMENT_ANCHOR,
        `${LABELS_ASSIGNMENT_ANCHOR}        labels.move_to((-1.5, 0.5, 0))\n`,
      );
      const plan = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(
        candidateSource,
        SCENE_NAME,
        SOURCE_PATH,
        "labels",
      );
      expect(plan.baseSource).toBe(source);
      expect(plan.baseSourceHash).toBe(PINNED_SOURCE_SHA256);
      expect(plan.baseBinding.name).toBe("labels");
      expect(plan.expectedWorldCenter).toEqual({ x: -1.5, y: 0.5 });

      const result = await candidateRoundtrip(candidateSource, {
        genericInitialMove: {
          baseBinding: plan.baseBinding,
          baseSourceHash: plan.baseSourceHash,
          entityId: `source:${SOURCE_PATH}#${SCENE_NAME}:labels`,
          expectedWorldCenter: plan.expectedWorldCenter,
          kind: "fast-manim-generic-initial-move-v3",
        },
        projectId: "second-editable-scene-evidence",
        requestId: "feynman-labels-initial-move-v3-candidate",
        sceneName: SCENE_NAME,
        sourcePath: SOURCE_PATH,
      });
      expect(result).toMatchObject({
        sourceHash: createHash("sha256").update(candidateSource, "utf8").digest("hex"),
        status: "verified",
        traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    });

    it("verifies a real labels uniform-resize candidate pair on the multi-root Scene", {
      timeout: 600_000,
    }, async () => {
      const source = readFileSync(join(sourceRoot!, SOURCE_PATH), "utf8");
      expect(createHash("sha256").update(source, "utf8").digest("hex")).toBe(PINNED_SOURCE_SHA256);
      expect(source.split(LABELS_ASSIGNMENT_ANCHOR)).toHaveLength(2);
      const candidateSource = source.replace(
        LABELS_ASSIGNMENT_ANCHOR,
        `${LABELS_ASSIGNMENT_ANCHOR}        labels.scale(1.25)\n`,
      );
      const plan = deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(
        candidateSource,
        SCENE_NAME,
        SOURCE_PATH,
        "labels",
      );
      expect(plan.baseSource).toBe(source);
      expect(plan.baseSourceHash).toBe(PINNED_SOURCE_SHA256);
      expect(plan.baseBinding.name).toBe("labels");
      expect(plan.expectedScaleFactor).toBe(1.25);

      const result = await candidateRoundtrip(candidateSource, {
        genericInitialResize: {
          baseBinding: plan.baseBinding,
          baseSourceHash: plan.baseSourceHash,
          entityId: `source:${SOURCE_PATH}#${SCENE_NAME}:labels`,
          expectedScaleFactor: plan.expectedScaleFactor,
          kind: "fast-manim-generic-initial-resize-v3",
        },
        projectId: "second-editable-scene-evidence",
        requestId: "feynman-labels-initial-resize-v3-candidate",
        sceneName: SCENE_NAME,
        sourcePath: SOURCE_PATH,
      });
      expect(result).toMatchObject({
        sourceHash: createHash("sha256").update(candidateSource, "utf8").digest("hex"),
        status: "verified",
        traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    });
  },
);
