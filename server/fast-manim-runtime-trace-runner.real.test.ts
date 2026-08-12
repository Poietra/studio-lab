import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import {
  deriveRuntimeTraceInitialMoveSourceEditPlan,
  deriveRuntimeTraceInitialResizeSourceEditPlan,
  deriveRuntimeTraceInitialRotationSourceEditPlan,
} from "../src/render-pipeline/source-lowering";
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import { fastManimRuntimeTraceProducerEnvironment } from "./fast-manim-runtime-trace-producer-identity";
import { FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 } from "./fast-manim-runtime-trace-profile";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "./manim-render-config";
import { ManimRenderManager } from "./manim-render-manager";
import { ManimSourceStore } from "./manim-source-store";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";

const producerCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND);
const GENERIC_STATIC_SQUARE_SOURCE = readFileSync(
  new URL("../fixtures/real-preview-harness/scene_runtime_trace_v3.py", import.meta.url),
  "utf8",
);

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

    it("emits negotiated V2 source authority for one real generic Scene", { timeout: 30_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-v3-authority-real-"));
      await mkdir(join(root, "scenes"));
      await writeFile(join(root, "scenes/static_square.py"), GENERIC_STATIC_SQUARE_SOURCE, "utf8");
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
          requestId: "runtime-trace-v3-authority-real-1",
          responseVersion: 2,
          sceneName: "StaticSquare",
          sourceHash: createHash("sha256").update(GENERIC_STATIC_SQUARE_SOURCE).digest("hex"),
          sourcePath: "scenes/static_square.py",
        });
        expect(view.status).toBe("verified");
        if (view.status !== "verified") throw new Error(view.failure.message);
        expect(view.version).toBe(2);
        if (view.version !== 2) throw new Error("Expected negotiated Runtime Trace wire V2.");
        expect(view.roots).toMatchObject([
          {
            binding: { name: "square", ordinal: 1 },
            evidence: {
              endpoints: {
                initial: { center: { x: 0, y: 0 }, dimensions: { height: 2, width: 2 }, frameIndex: 0 },
                terminal: { center: { x: 0, y: 0 }, dimensions: { height: 2, width: 2 }, frameIndex: 5 },
              },
              updaterStatus: "none",
            },
          },
        ]);
        const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
        expect(bundle.scene.duration).toBe(0.1);
        expect(bundle.scene.entities.some(({ id }) => id === view.roots[0]?.entityId)).toBe(true);
      } finally {
        await manager.close();
        await rm(root, { force: true, recursive: true });
      }
    });

    it("verifies one real generic initial move as a fresh V3 base/candidate pair", { timeout: 60_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-v3-candidate-real-"));
      await mkdir(join(root, "scenes"));
      const sourcePath = "scenes/static_square.py";
      await writeFile(join(root, sourcePath), GENERIC_STATIC_SQUARE_SOURCE, "utf8");
      const candidateSource = GENERIC_STATIC_SQUARE_SOURCE.replace(
        "        square.set_stroke(WHITE, width=2)\n",
        "        square.move_to((1.25, -0.5, 0))\n        square.set_stroke(WHITE, width=2)\n",
      );
      const plan = deriveRuntimeTraceInitialMoveSourceEditPlan(candidateSource, "StaticSquare", sourcePath, "square");
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
        projectId: "demo",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 60_000,
      });
      try {
        const preflight = await runner.runRuntimeTraceCandidateUnpublished(candidateSource, {
          initialMove: {
            baseBinding: plan.baseBinding,
            baseSourceHash: plan.baseSourceHash,
            entityId: `source:${sourcePath}#StaticSquare:square`,
            expectedWorldCenter: plan.expectedWorldCenter,
            kind: "runtime-trace-initial-move",
          },
          projectId: "demo",
          requestId: "runtime-trace-v3-candidate-real-1",
          sceneName: "StaticSquare",
          sourcePath,
        });
        expect(preflight).toMatchObject({
          sourceHash: createHash("sha256").update(candidateSource).digest("hex"),
          status: "verified",
          traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });

        await writeFile(join(root, sourcePath), candidateSource, "utf8");
        const preview = await runner.runRuntimeTrace({
          projectId: "demo",
          requestId: "runtime-trace-v3-candidate-preview-real-1",
          responseVersion: 2,
          sceneName: "StaticSquare",
          sourceHash: preflight.sourceHash,
          sourcePath,
        });
        expect(preview.status).toBe("verified");
        if (preview.status !== "verified" || preview.version !== 2) {
          throw new Error(preview.status === "verified" ? "Expected Runtime Trace wire V2." : preview.failure.message);
        }
        expect(preview.roots[0]?.evidence.endpoints).toMatchObject({
          initial: { center: plan.expectedWorldCenter, frameIndex: 0 },
          terminal: { center: plan.expectedWorldCenter, frameIndex: 5 },
        });
        const bundle = await parseVerifiedSceneIrBundleV1(preview.bundle);
        expect(bundle.scene.animationChannels).toHaveLength(0);
        const rootId = preview.roots[0]?.entityId;
        const rootEntity = bundle.scene.entities.find(({ id }) => id === rootId);
        const paths = bundle.scene.entities.filter(({ geometry }) => geometry.kind === "cubic-path");
        expect(rootEntity).toMatchObject({ appearance: { kind: "group" }, geometry: { kind: "group" } });
        expect(paths).toHaveLength(1);
        expect(paths[0]?.transform.tx).toBeCloseTo(plan.expectedWorldCenter.x, 12);
        expect(paths[0]?.transform.ty).toBeCloseTo(plan.expectedWorldCenter.y, 12);
      } finally {
        await runner.close();
        await rm(root, { force: true, recursive: true });
      }
    });

    it("verifies one real generic initial uniform resize as a fresh V3 base/candidate pair", {
      timeout: 60_000,
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-v3-resize-real-"));
      await mkdir(join(root, "scenes"));
      const sourcePath = "scenes/static_square.py";
      await writeFile(join(root, sourcePath), GENERIC_STATIC_SQUARE_SOURCE, "utf8");
      const candidateSource = GENERIC_STATIC_SQUARE_SOURCE.replace(
        "        square.set_stroke(WHITE, width=2)\n",
        "        square.scale(1.5)\n        square.set_stroke(WHITE, width=2)\n",
      );
      const plan = deriveRuntimeTraceInitialResizeSourceEditPlan(candidateSource, "StaticSquare", sourcePath, "square");
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
        projectId: "demo",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 60_000,
      });
      try {
        const preflight = await runner.runRuntimeTraceCandidateUnpublished(candidateSource, {
          initialResize: {
            baseBinding: plan.baseBinding,
            baseSourceHash: plan.baseSourceHash,
            entityId: `source:${sourcePath}#StaticSquare:square`,
            expectedScaleFactor: plan.expectedScaleFactor,
            kind: "runtime-trace-initial-resize",
          },
          projectId: "demo",
          requestId: "runtime-trace-v3-resize-real-1",
          sceneName: "StaticSquare",
          sourcePath,
        });
        expect(preflight).toMatchObject({
          sourceHash: createHash("sha256").update(candidateSource).digest("hex"),
          status: "verified",
          traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });

        await writeFile(join(root, sourcePath), candidateSource, "utf8");
        const preview = await runner.runRuntimeTrace({
          projectId: "demo",
          requestId: "runtime-trace-v3-resize-preview-real-1",
          responseVersion: 2,
          sceneName: "StaticSquare",
          sourceHash: preflight.sourceHash,
          sourcePath,
        });
        expect(preview.status).toBe("verified");
        if (preview.status !== "verified" || preview.version !== 2) {
          throw new Error(preview.status === "verified" ? "Expected Runtime Trace wire V2." : preview.failure.message);
        }
        expect(preview.roots[0]?.evidence.endpoints).toMatchObject({
          initial: { center: { x: 0, y: 0 }, dimensions: { height: 3, width: 3 }, frameIndex: 0 },
          terminal: { center: { x: 0, y: 0 }, dimensions: { height: 3, width: 3 }, frameIndex: 5 },
        });
      } finally {
        await runner.close();
        await rm(root, { force: true, recursive: true });
      }
    });

    it("verifies one real generic initial rotation as a fresh V3 base/candidate pair", {
      timeout: 60_000,
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-v3-rotation-real-"));
      await mkdir(join(root, "scenes"));
      const sourcePath = "scenes/triangle.py";
      const baseSource = `from manim import *

class StaticTriangle(Scene):
    def construct(self):
        triangle = Triangle().set_fill(BLUE, opacity=0.6)
        triangle.rotate(0.3)
        triangle.set_stroke(WHITE, width=2)
        self.add(triangle)
        self.wait(0.1)
`;
      await writeFile(join(root, sourcePath), baseSource, "utf8");
      const candidateSource = baseSource.replace(
        "        triangle.rotate(0.3)\n",
        "        triangle.rotate(0.3)\n        triangle.rotate(0.261799387799)\n",
      );
      const plan = deriveRuntimeTraceInitialRotationSourceEditPlan(
        candidateSource,
        "StaticTriangle",
        sourcePath,
        "triangle",
      );
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
        projectId: "demo",
        projectRoot: root,
        tenantId: "test-tenant",
        timeoutMs: 60_000,
      });
      try {
        const preflight = await runner.runRuntimeTraceCandidateUnpublished(candidateSource, {
          initialRotation: {
            baseBinding: plan.baseBinding,
            baseSourceHash: plan.baseSourceHash,
            entityId: `source:${sourcePath}#StaticTriangle:triangle`,
            expectedAngleRadians: plan.expectedAngleRadians,
            kind: "runtime-trace-initial-rotation",
          },
          projectId: "demo",
          requestId: "runtime-trace-v3-rotation-real-1",
          sceneName: "StaticTriangle",
          sourcePath,
        });
        expect(preflight).toMatchObject({
          sourceHash: createHash("sha256").update(candidateSource).digest("hex"),
          status: "verified",
          traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });

        await writeFile(join(root, sourcePath), candidateSource, "utf8");
        const preview = await runner.runRuntimeTrace({
          projectId: "demo",
          requestId: "runtime-trace-v3-rotation-preview-real-1",
          responseVersion: 2,
          sceneName: "StaticTriangle",
          sourceHash: preflight.sourceHash,
          sourcePath,
        });
        expect(preview.status).toBe("verified");
        if (preview.status !== "verified" || preview.version !== 2) {
          throw new Error(preview.status === "verified" ? "Expected Runtime Trace wire V2." : preview.failure.message);
        }
        expect(preview.roots[0]?.evidence.endpoints.initial.center).not.toEqual({ x: 0, y: 0 });
        expect(preview.roots[0]?.evidence.endpoints).toMatchObject({
          initial: { frameIndex: 0 },
          terminal: { frameIndex: 5 },
        });
      } finally {
        await runner.close();
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
        "            run_time=5,\n        )\n        square.move_to((0.806934594169, 2.096532702916, 0))\n        square.scale(1.6071941072)\n        decimal.update(0)\n        self.wait()\n",
      );
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
        const motion = bundle.scene.animationChannels.find((channel) => channel.kind === "affine-transform");
        if (!motion) throw new Error("Expected the retained Runtime Trace motion channel.");
        expect(motion.keyframes.map(({ at }) => at)).toEqual([0, 2.5, 5]);
        const terminalMotion = motion.keyframes.at(-1)?.value;
        expect(terminalMotion).toMatchObject({ tx: 0, ty: 2.5 });
        if (!terminalMotion) throw new Error("Expected the terminal retained motion keyframe.");

        const motionRoot = bundle.scene.entities.find(({ id }) => id === motion.entityId);
        const squareRoot = bundle.scene.entities.find(({ id }) => id.endsWith("/runtime-root:square"));
        const decimalRoot = bundle.scene.entities.find(({ id }) => id.endsWith("/runtime-root:decimal"));
        expect(motionRoot).toMatchObject({ appearance: { kind: "group" }, parentId: null });
        if (!squareRoot || !decimalRoot) throw new Error("Expected the Square and DecimalNumber Runtime Trace roots.");
        const activeAtFive = (entity: (typeof bundle.scene.entities)[number]) =>
          entity.lifetimes.some(({ end, start }) => start <= 5 && 5 < end);
        const squareStates = bundle.scene.entities.filter(
          (entity) =>
            entity.parentId === squareRoot.id && entity.geometry.kind === "cubic-path" && activeAtFive(entity),
        );
        const decimalStates = bundle.scene.entities.filter(
          (entity) =>
            entity.parentId === decimalRoot.id && entity.geometry.kind === "cubic-path" && activeAtFive(entity),
        );
        expect(squareStates).toHaveLength(1);
        expect(decimalStates).toHaveLength(9);
        const square = squareStates[0];
        if (!square || square.geometry.kind !== "cubic-path") throw new Error("Expected the terminal Square state.");
        expect(square.transform.tx).toBeCloseTo(0.806934594169, 12);
        expect(square.transform.ty).toBeCloseTo(2.096532702916 - terminalMotion.ty, 12);
        expect(square.geometry.path.subpaths[0]?.start.x).toBeCloseTo(1.6071941072, 12);
        expect(square.geometry.path.subpaths[0]?.start.y).toBeCloseTo(1.6071941072, 12);
        expect(squareRoot.transform.tx + square.transform.tx + terminalMotion.tx).toBeCloseTo(0.806934594169, 12);
        expect(squareRoot.transform.ty + square.transform.ty + terminalMotion.ty).toBeCloseTo(2.096532702916, 12);
        expect(
          Math.min(...decimalStates.map(({ transform }) => decimalRoot.transform.tx + transform.tx)),
        ).toBeGreaterThan(0.806934594169);
        expect(
          Math.max(
            ...decimalStates.map(({ transform }) =>
              Math.abs(decimalRoot.transform.ty + transform.ty + terminalMotion.ty - 2.096532702916),
            ),
          ),
        ).toBeLessThan(0.2);
      } finally {
        await runner.close();
        await rm(root, { force: true, recursive: true });
      }
    });
  },
);
