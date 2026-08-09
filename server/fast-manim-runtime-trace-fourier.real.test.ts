import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
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
const BASELINE_PATH = fileURLToPath(new URL("../fixtures/fourier-v3-runtime-trace-v1/baseline.json", import.meta.url));

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
          responseVersion: 2,
          sceneName: SCENE_NAME,
          sourceHash,
          sourcePath: SOURCE_PATH,
        });
        // Failure messages may embed run-scoped paths; the reviewable record
        // keeps only the bounded failure code.
        const evidence =
          view.status === "verified" && view.version === 2
            ? {
                outcome: "verified" as const,
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
                schema: "poietra.fourier-v3-runtime-trace-evidence",
                traceDigest: view.traceDigest,
                version: 1,
              }
            : {
                failure: { code: view.status === "failed" ? view.failure.code : "unsupported-profile" },
                outcome: "failed" as const,
                producer: { ...TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY },
                scene: { className: SCENE_NAME, sourcePath: SOURCE_PATH, sourceSha256: PINNED_SOURCE_SHA256 },
                schema: "poietra.fourier-v3-runtime-trace-evidence",
                version: 1,
              };
        if (view.status === "failed") {
          console.log(`Fourier Runtime Trace failed (${view.failure.code}): ${view.failure.message}`);
        }
        if (update) {
          await writeFile(BASELINE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
        }
        if (!existsSync(BASELINE_PATH)) {
          throw new Error(
            "The Fourier evidence baseline is absent. Run once with POIETRA_FOURIER_RUNTIME_TRACE_UPDATE=1.",
          );
        }
        expect(evidence).toEqual(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
      } finally {
        await runner.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  },
);
