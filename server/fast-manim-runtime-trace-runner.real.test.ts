import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
  fastManimRuntimeTraceProducerEnvironmentV1,
} from "./fast-manim-runtime-trace-profile";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "./manim-render-config";
import { ManimRenderManager } from "./manim-render-manager";
import { ManimSourceStore } from "./manim-source-store";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";

const producerCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND);

describe.skipIf(!producerCommand || !ManimSourceStore.supportsVerifiedRead)(
  "real fast-manim Runtime Trace runner",
  () => {
    it("executes the public one-shot CLI and lowers its verified artifact", { timeout: 30_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-real-"));
      await mkdir(join(root, "example_scenes"));
      await writeFile(join(root, "example_scenes/basic.py"), RUNTIME_TRACE_SOURCE_TEXT, "utf8");
      const manager = new ManimRenderManager({
        command: ["manim"],
        frame: { height: 8, width: 14.222222222222221 },
        projectId: "demo",
        projectRoot: root,
        runtimeTraceProducerCommand: producerCommand,
        runtimeTraceProducerDevOptIn: true,
        snapshotSandboxDeployment: "test",
        tenantId: "test-tenant",
      });
      try {
        const view = await manager.runRuntimeTrace({
          projectId: "demo",
          requestId: "runtime-trace-real-1",
          sceneName: "UpdatersExample",
          sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
          sourcePath: "example_scenes/basic.py",
        });
        expect(view.status).toBe("verified");
        if (view.status !== "verified") throw new Error(view.failure.message);
        const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
        expect(bundle.scene.duration).toBe(6);
        expect(bundle.scene.entities).toHaveLength(570);
        expect(bundle.scene.animationChannels).toHaveLength(1);
      } finally {
        await manager.close();
        await rm(root, { force: true, recursive: true });
      }
    });

    it("executes and verifies one real terminal Square edit with its updater response", {
      timeout: 60_000,
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-candidate-real-"));
      await mkdir(join(root, "example_scenes"));
      await writeFile(join(root, "example_scenes/basic.py"), RUNTIME_TRACE_SOURCE_TEXT, "utf8");
      const candidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
        "            run_time=5,\n        )\n        self.wait()\n",
        "            run_time=5,\n        )\n        square.move_to((1.25, -1.5, 0))\n        square.scale(0.5)\n        self.wait()\n",
      );
      const runner = new FastManimSnapshotRunner({
        backend: createConfiguredFastManimSandboxBackendV1({
          command: producerCommand,
          deployment: "test",
          localProcessDevOptIn: true,
          producerEnv: fastManimRuntimeTraceProducerEnvironmentV1(),
          projectRoot: root,
        }),
        deployment: "test",
        frame: { height: 8, width: 14.222222222222221 },
        projectId: "demo",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 60_000,
      });
      try {
        const preflight = await runner.runRuntimeTraceCandidateUnpublished(candidateSource, {
          projectId: "demo",
          requestId: "runtime-trace-terminal-edit-real-1",
          sceneName: "UpdatersExample",
          sourcePath: "example_scenes/basic.py",
        });
        expect(preflight).toMatchObject({
          sourceHash: expect.not.stringMatching(FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1),
          status: "verified",
          traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        await writeFile(join(root, "example_scenes/basic.py"), candidateSource, "utf8");
        const preview = await runner.runRuntimeTrace({
          projectId: "demo",
          requestId: "runtime-trace-terminal-edit-preview-real-1",
          sceneName: "UpdatersExample",
          sourceHash: preflight.sourceHash,
          sourcePath: "example_scenes/basic.py",
        });
        expect(preview.status).toBe("verified");
        if (preview.status !== "verified") throw new Error(preview.failure.message);
        const bundle = await parseVerifiedSceneIrBundleV1(preview.bundle);
        expect(bundle.scene.source).toMatchObject({
          kind: "imported-manim-runtime-trace",
          sourceHash: preflight.sourceHash,
          traceDigest: preview.traceDigest,
        });
        const terminal = await compileEngineFrameV1({
          assets: bundle.assets,
          packetId: "runtime-trace-terminal-edit-preview-real-1",
          sampleTime: 5,
          scene: bundle.scene,
          viewport: { heightPx: 486, widthPx: 864 },
        });
        expect(terminal.kind).toBe("ready");
        if (terminal.kind !== "ready") throw new Error(terminal.message);
        expect(terminal.frame.packet.draws[0]?.transform.tx).toBeCloseTo(1.25, 12);
        expect(terminal.frame.packet.draws[0]?.transform.ty).toBeCloseTo(-1.5, 12);
        const decimalDraws = terminal.frame.packet.draws.slice(1);
        expect(decimalDraws).not.toEqual([]);
        expect(Math.min(...decimalDraws.map(({ transform }) => transform.tx))).toBeGreaterThan(1.25);
        expect(Math.max(...decimalDraws.map(({ transform }) => Math.abs(transform.ty + 1.5)))).toBeLessThan(0.2);
      } finally {
        await runner.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  },
);
