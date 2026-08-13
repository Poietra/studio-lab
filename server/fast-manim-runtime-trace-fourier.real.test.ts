import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  fastManimRuntimeTraceProducerEnvironment,
  TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
} from "./fast-manim-runtime-trace-producer-identity";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "./manim-render-config";
import { ManimSourceStore } from "./manim-source-store";

const producerCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND);
const sourceRoot = process.env.POIETRA_FOURIER_SOURCE_ROOT?.trim();
const update = process.env.POIETRA_FOURIER_RUNTIME_TRACE_UPDATE === "1";

const SCENE_NAME = "FourierSeriesSquareWave";
const SOURCE_PATH = "legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py";
const PINNED_SOURCE_SHA256 = "3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72";
const EVIDENCE_SCHEMA = "poietra.fourier-v3-runtime-trace-evidence";
const EVIDENCE_VERSION = 1;
const EXPECTED_BINDING_NAMES = ["axes_epi", "axes_wave", "epicycles_group", "waves", "trace_lines"] as const;
const BASELINE_PATH = fileURLToPath(new URL("../fixtures/fourier-v3-runtime-trace-v1/baseline.json", import.meta.url));

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
        updaterStatus: z.literal("conflict"),
      })
      .strict(),
  })
  .strict();

const fourierRuntimeTraceEvidenceV1Schema = z
  .object({
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
        sourcePath: z.literal(SOURCE_PATH),
        sourceSha256: z.literal(PINNED_SOURCE_SHA256),
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
        message: "Fourier evidence bindings must match the reviewed source-analysis order.",
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
        context.addIssue({ code: "custom", message: `Fourier evidence must have unique ${label}.`, path: ["roots"] });
      }
    }
  });

function readEvidenceBaseline() {
  return fourierRuntimeTraceEvidenceV1Schema.parse(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
}

describe("FourierSeriesSquareWave Runtime Trace evidence baseline", () => {
  it.skipIf(update)("is a bounded verified fixture for the current producer and source pins", () => {
    const baseline = readEvidenceBaseline();
    expect(baseline.roots.map(({ binding }) => binding.name)).toEqual(EXPECTED_BINDING_NAMES);
    expect(baseline.roots.every(({ evidence }) => evidence.updaterStatus === "conflict")).toBe(true);
    expect(baseline.sceneDuration).toBe(14.5);
  });

  it.skipIf(update)("rejects failed outcomes and duplicate roots", () => {
    const baseline = readEvidenceBaseline();
    expect(
      fourierRuntimeTraceEvidenceV1Schema.safeParse({
        ...baseline,
        failure: { code: "producer-exit" },
        outcome: "failed",
      }).success,
    ).toBe(false);
    const duplicateRoot = structuredClone(baseline);
    duplicateRoot.roots[1]!.entityId = duplicateRoot.roots[0]!.entityId;
    expect(fourierRuntimeTraceEvidenceV1Schema.safeParse(duplicateRoot).success).toBe(false);
  });

  it.runIf(update)("requires the real pinned producer and source before updating", () => {
    expect(producerCommand, "POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND is required to update evidence.").toBeDefined();
    expect(sourceRoot, "POIETRA_FOURIER_SOURCE_ROOT is required to update evidence.").toBeTruthy();
    expect(ManimSourceStore.supportsVerifiedRead, "Verified source reads are required to update evidence.").toBe(true);
  });
});

describe.skipIf(!producerCommand || !sourceRoot || !ManimSourceStore.supportsVerifiedRead)(
  "real FourierSeriesSquareWave Runtime Trace evidence",
  () => {
    it("records the pinned generic V3 preview outcome as reviewable evidence", { timeout: 600_000 }, async () => {
      const source = readFileSync(join(sourceRoot!, SOURCE_PATH), "utf8");
      const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
      expect(sourceHash).toBe(PINNED_SOURCE_SHA256);

      const root = await mkdtemp(join(tmpdir(), "poietra-fourier-runtime-trace-real-"));
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
        projectId: "fourier-evidence",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 300_000,
      });
      try {
        const view = await runner.runRuntimeTrace({
          projectId: "fourier-evidence",
          requestId: "fourier-v3-runtime-trace-evidence-1",
          sceneName: SCENE_NAME,
          sourceHash,
          sourcePath: SOURCE_PATH,
        });
        if (view.status === "failed") {
          throw new Error(`Fourier Runtime Trace failed (${view.failure.code}): ${view.failure.message}`);
        }
        if (view.version !== 2) {
          throw new Error(
            "Fourier Runtime Trace returned an unsupported profile; evidence requires negotiated wire V2.",
          );
        }
        const evidence = fourierRuntimeTraceEvidenceV1Schema.parse({
          outcome: "verified",
          producer: { ...TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY },
          producerEvidence: view.producerEvidence,
          roots: view.roots.map((viewRoot) => ({
            binding: viewRoot.binding,
            entityId: viewRoot.entityId,
            evidence: viewRoot.evidence,
          })),
          runtimeConfigHash: view.runtimeConfigHash,
          scene: { className: SCENE_NAME, sourcePath: SOURCE_PATH, sourceSha256: PINNED_SOURCE_SHA256 },
          sceneDuration: (await parseVerifiedSceneIrBundleV1(view.bundle)).scene.duration,
          sceneId: view.sceneId,
          schema: EVIDENCE_SCHEMA,
          traceDigest: view.traceDigest,
          version: EVIDENCE_VERSION,
        });
        if (update) {
          await writeFile(BASELINE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
        }
        if (!existsSync(BASELINE_PATH)) {
          throw new Error(
            "The Fourier evidence baseline is absent. Run once with POIETRA_FOURIER_RUNTIME_TRACE_UPDATE=1.",
          );
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
  },
);
