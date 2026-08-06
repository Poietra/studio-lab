import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import { FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 } from "./fast-manim-runtime-trace-profile";
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
  },
);
