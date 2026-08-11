import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3,
  deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3,
} from "../src/render-pipeline/source-lowering";
import type { FastManimRuntimeTraceProducerRequestV3 } from "./fast-manim-runtime-trace-v3-contract";
import { digestFastManimRuntimeTraceDomainV3 } from "./fast-manim-runtime-trace-v3-contract";
import { trustedFastManimRuntimeTraceProducerV3 } from "./fast-manim-runtime-trace-v3-profile";
import {
  digestFastManimRuntimeTraceSourceBindingsV3,
  type FastManimRuntimeTraceV3,
} from "./fast-manim-runtime-trace-v3-result-contract";
import type {
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { ManimSourceStore } from "./manim-source-store";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const ARTIFACT_PATH = new URL("./test-fixtures/fast-manim-runtime-trace-v3-generic.json", import.meta.url);
const SOURCE_PATH = "scenes/staticsquare.py";
const SCENE_NAME = "StaticSquare";
const BASE_SOURCE = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
const CANDIDATE_SOURCE = BASE_SOURCE.replace(
  "        square.set_stroke(WHITE, width=2)\n",
  "        square.move_to((1.25, -0.5, 0))\n        square.set_stroke(WHITE, width=2)\n",
);
const PLAN = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(CANDIDATE_SOURCE, SCENE_NAME, SOURCE_PATH, "square");
const RESIZE_CANDIDATE_SOURCE = BASE_SOURCE.replace(
  "        square.set_stroke(WHITE, width=2)\n",
  "        square.scale(1.5)\n        square.set_stroke(WHITE, width=2)\n",
);
const RESIZE_PLAN = deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(
  RESIZE_CANDIDATE_SOURCE,
  SCENE_NAME,
  SOURCE_PATH,
  "square",
);
// A Scene whose construct projects two top-level bindings: the edited one is
// the second occurrence, so a producer request narrowed to the first binding
// cannot carry the selected authority.
const MULTI_BINDING_BASE_SOURCE = BASE_SOURCE.replace(
  "        self.add(square)\n",
  "        circle = Circle()\n        self.add(square)\n        self.add(circle)\n",
);
const MULTI_BINDING_CANDIDATE_SOURCE = MULTI_BINDING_BASE_SOURCE.replace(
  "        self.add(square)\n",
  "        circle.move_to((1.25, -0.5, 0))\n        self.add(square)\n",
);
const MULTI_BINDING_PLAN = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(
  MULTI_BINDING_CANDIDATE_SOURCE,
  SCENE_NAME,
  SOURCE_PATH,
  "circle",
);

function visualSemanticsDigest(trace: FastManimRuntimeTraceV3) {
  return digestFastManimRuntimeTraceDomainV3("poietra.fast-manim-runtime-trace-visual-semantics.v3", {
    camera: trace.camera,
    compositing: trace.compositing,
    coordinatePrecisionDigits: trace.coordinatePrecisionDigits,
    draws: trace.draws,
    frames: trace.frames,
    resources: trace.resources,
    roots: trace.roots,
    sampleSchedule: trace.sampleSchedule,
  });
}

class GenericCandidateArtifactBackend implements FastManimSandboxBackendV1 {
  readonly requests: FastManimRuntimeTraceProducerRequestV3[] = [];

  constructor(
    private readonly corruptCandidate = false,
    private readonly onStart: ((count: number) => Promise<void> | void) | undefined = undefined,
    private readonly edit: "move" | "resize" = "move",
    private readonly selected: Readonly<{
      baseSourceHash: string;
      expectedWorldCenter: Readonly<{ x: number; y: number }>;
      name: string;
    }> = { baseSourceHash: PLAN.baseSourceHash, expectedWorldCenter: PLAN.expectedWorldCenter, name: "square" },
  ) {}

  async close() {}

  start(bundle: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const request = JSON.parse(
      Buffer.from(bundle.copyProducerRequestBytes()).toString("utf8"),
    ) as FastManimRuntimeTraceProducerRequestV3;
    this.requests.push(request);
    return {
      abort() {},
      result: this.result(bundle, context, request, this.requests.length),
    };
  }

  private async result(
    bundle: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
    request: FastManimRuntimeTraceProducerRequestV3,
    count: number,
  ) {
    await this.onStart?.(count);
    const trace = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as FastManimRuntimeTraceV3;
    Object.assign(trace, {
      camera: request.runtimeConfig.camera,
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash: request.runtimeConfigHash,
      sceneId: request.sceneId,
      sceneName: request.sceneName,
      sceneOccurrence: request.sceneOccurrence,
      sourceHash: request.sourceHash,
      sourcePath: request.sourcePath,
    });
    Object.assign(trace.producer, trustedFastManimRuntimeTraceProducerV3());
    const binding = request.sourceBindings.find(({ name }) => name === this.selected.name);
    if (!binding) throw new Error(`Synthetic V3 request lost its ${this.selected.name} binding.`);
    trace.sourceBindings[0]!.binding = binding;
    const candidate = request.sourceHash !== this.selected.baseSourceHash;
    if (candidate && this.edit === "move") {
      for (const endpoint of Object.values(trace.sourceBindings[0]!.endpoints)) {
        endpoint.center.x = this.selected.expectedWorldCenter.x;
        endpoint.center.y = this.selected.expectedWorldCenter.y;
      }
      for (const frame of trace.frames) {
        for (const state of frame.states) {
          state.transform.tx += this.selected.expectedWorldCenter.x;
          state.transform.ty += this.selected.expectedWorldCenter.y;
        }
      }
    }
    if (candidate && this.edit === "resize") {
      const factor = RESIZE_PLAN.expectedScaleFactor;
      const canonical = (value: number) => Number((value * factor).toFixed(13));
      for (const endpoint of Object.values(trace.sourceBindings[0]!.endpoints)) {
        endpoint.dimensions.height = canonical(endpoint.dimensions.height);
        endpoint.dimensions.width = canonical(endpoint.dimensions.width);
      }
      const scaledPathIds = new Map<string, string>();
      trace.resources.paths = trace.resources.paths.map((resource) => {
        const path = {
          subpaths: resource.path.subpaths.map((subpath) => ({
            closed: subpath.closed,
            segments: subpath.segments.map((segment) => ({
              control1: { x: canonical(segment.control1.x), y: canonical(segment.control1.y) },
              control2: { x: canonical(segment.control2.x), y: canonical(segment.control2.y) },
              end: { x: canonical(segment.end.x), y: canonical(segment.end.y) },
            })),
            start: { x: canonical(subpath.start.x), y: canonical(subpath.start.y) },
          })),
        };
        const id = `path:${digestFastManimRuntimeTraceDomainV3("poietra.runtime-trace-v3-path", path)}`;
        scaledPathIds.set(resource.id, id);
        return { id, path };
      });
      for (const frame of trace.frames) {
        for (const state of frame.states) {
          state.pathId = scaledPathIds.get(state.pathId) ?? state.pathId;
        }
      }
    }
    if (candidate && this.corruptCandidate) trace.frames[0]!.states[0]!.opacity = 0.5;
    trace.producer.correlationSha256 = digestFastManimRuntimeTraceSourceBindingsV3(
      trace.sourceHash,
      trace.sceneId,
      trace.sourceBindings,
    );
    trace.producer.semanticsSha256 = visualSemanticsDigest(trace);
    return {
      attestationDigest: context.attestationDigest,
      kind: "ok" as const,
      requestDigest: bundle.requestDigest,
      resultBytes: Buffer.from(JSON.stringify(trace), "utf8"),
    };
  }

  async status(context: FastManimSandboxStatusContextV1) {
    context.signal.throwIfAborted();
    return localSandboxReadyStatus();
  }
}

class BlockingStatusBackend implements FastManimSandboxBackendV1 {
  private resolveStatusCall: (() => void) | undefined;
  private statusCalls = 0;

  async close() {}

  start(): never {
    throw new Error("A blocked admission test must not execute the producer.");
  }

  async status(context: FastManimSandboxStatusContextV1) {
    context.signal.throwIfAborted();
    this.statusCalls += 1;
    this.resolveStatusCall?.();
    return await new Promise<ReturnType<typeof localSandboxReadyStatus>>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
  }

  waitForStatusCall() {
    if (this.statusCalls > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveStatusCall = resolve;
    });
  }
}

const projectRoots: string[] = [];
const runners: FastManimSnapshotRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(projectRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function projectRoot(baseSource = BASE_SOURCE) {
  const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-v3-candidate-"));
  projectRoots.push(root);
  await mkdir(join(root, "scenes"));
  await writeFile(join(root, SOURCE_PATH), baseSource, "utf8");
  return root;
}

function runner(root: string, backend: FastManimSandboxBackendV1) {
  const instance = new FastManimSnapshotRunner({
    backend,
    deployment: "test",
    frame: { height: 8, width: 128 / 9 },
    maxConcurrentRuns: 2,
    projectId: "generic-preview",
    projectRoot: root,
    tenantId: "test-tenant",
  });
  runners.push(instance);
  return instance;
}

function candidateRequest() {
  return {
    genericInitialMove: {
      baseBinding: PLAN.baseBinding,
      baseSourceHash: PLAN.baseSourceHash,
      entityId: `source:${SOURCE_PATH}#${SCENE_NAME}:square`,
      expectedWorldCenter: PLAN.expectedWorldCenter,
      kind: "fast-manim-generic-initial-move-v3" as const,
    },
    projectId: "generic-preview",
    requestId: "generic-initial-move-v3-candidate",
    sceneName: SCENE_NAME,
    sourcePath: SOURCE_PATH,
  };
}

function multiBindingCandidateRequest() {
  return {
    genericInitialMove: {
      baseBinding: MULTI_BINDING_PLAN.baseBinding,
      baseSourceHash: MULTI_BINDING_PLAN.baseSourceHash,
      entityId: `source:${SOURCE_PATH}#${SCENE_NAME}:circle`,
      expectedWorldCenter: MULTI_BINDING_PLAN.expectedWorldCenter,
      kind: "fast-manim-generic-initial-move-v3" as const,
    },
    projectId: "generic-preview",
    requestId: "generic-initial-move-v3-multi-binding-candidate",
    sceneName: SCENE_NAME,
    sourcePath: SOURCE_PATH,
  };
}

function resizeCandidateRequest() {
  return {
    genericInitialResize: {
      baseBinding: RESIZE_PLAN.baseBinding,
      baseSourceHash: RESIZE_PLAN.baseSourceHash,
      entityId: `source:${SOURCE_PATH}#${SCENE_NAME}:square`,
      expectedScaleFactor: RESIZE_PLAN.expectedScaleFactor,
      kind: "fast-manim-generic-initial-resize-v3" as const,
    },
    projectId: "generic-preview",
    requestId: "generic-initial-resize-v3-candidate",
    sceneName: SCENE_NAME,
    sourcePath: SOURCE_PATH,
  };
}

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)(
  "generic Runtime Trace V3 initial-move candidate runner",
  () => {
    it("executes fresh base and candidate V3 traces without publishing either raw artifact", async () => {
      const backend = new GenericCandidateArtifactBackend();
      const result = await runner(await projectRoot(), backend).runRuntimeTraceCandidateUnpublished(
        CANDIDATE_SOURCE,
        candidateRequest(),
      );

      expect(result).toMatchObject({
        sourceHash: expect.not.stringMatching(PLAN.baseSourceHash),
        status: "verified",
        traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(backend.requests).toHaveLength(2);
      expect(backend.requests.map(({ sourceHash, version }) => ({ sourceHash, version }))).toEqual([
        { sourceHash: PLAN.baseSourceHash, version: 3 },
        { sourceHash: result.sourceHash, version: 3 },
      ]);
      expect(backend.requests.map(({ sourceBindings }) => sourceBindings[0]?.name)).toEqual(["square", "square"]);
      expect(backend.requests[0]?.sourceBindings[0]?.id).toBe(PLAN.baseBinding.id);
      expect(backend.requests[1]?.sourceBindings[0]?.id).toBe(PLAN.candidateBinding.id);
    });

    it("sends every projected binding to the producer and selects the requested non-first binding", async () => {
      const backend = new GenericCandidateArtifactBackend(false, undefined, "move", {
        baseSourceHash: MULTI_BINDING_PLAN.baseSourceHash,
        expectedWorldCenter: MULTI_BINDING_PLAN.expectedWorldCenter,
        name: "circle",
      });
      const result = await runner(
        await projectRoot(MULTI_BINDING_BASE_SOURCE),
        backend,
      ).runRuntimeTraceCandidateUnpublished(MULTI_BINDING_CANDIDATE_SOURCE, multiBindingCandidateRequest());

      expect(MULTI_BINDING_PLAN.baseBinding.name).toBe("circle");
      expect(MULTI_BINDING_PLAN.baseSource).toBe(MULTI_BINDING_BASE_SOURCE);
      expect(result).toMatchObject({
        sourceHash: expect.not.stringMatching(MULTI_BINDING_PLAN.baseSourceHash),
        status: "verified",
        traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(backend.requests).toHaveLength(2);
      expect(backend.requests.map(({ sourceHash, version }) => ({ sourceHash, version }))).toEqual([
        { sourceHash: MULTI_BINDING_PLAN.baseSourceHash, version: 3 },
        { sourceHash: result.sourceHash, version: 3 },
      ]);
      // Both projected bindings correlate every producer run; a request
      // narrowed to the first binding would strand the selected authority.
      expect(backend.requests.map(({ sourceBindings }) => sourceBindings.map(({ name }) => name))).toEqual([
        ["square", "circle"],
        ["square", "circle"],
      ]);
      expect(backend.requests[0]?.sourceBindings[1]?.id).toBe(MULTI_BINDING_PLAN.baseBinding.id);
      expect(backend.requests[1]?.sourceBindings[1]?.id).toBe(MULTI_BINDING_PLAN.candidateBinding.id);
      expect(backend.requests[0]?.sourceBindings[0]?.id).not.toBe(MULTI_BINDING_PLAN.baseBinding.id);
    });

    it("executes fresh base and resize-candidate V3 traces and verifies the scaled pair", async () => {
      const backend = new GenericCandidateArtifactBackend(false, undefined, "resize");
      const result = await runner(await projectRoot(), backend).runRuntimeTraceCandidateUnpublished(
        RESIZE_CANDIDATE_SOURCE,
        resizeCandidateRequest(),
      );

      expect(result).toMatchObject({
        sourceHash: expect.not.stringMatching(RESIZE_PLAN.baseSourceHash),
        status: "verified",
        traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(backend.requests).toHaveLength(2);
      expect(backend.requests.map(({ sourceHash, version }) => ({ sourceHash, version }))).toEqual([
        { sourceHash: RESIZE_PLAN.baseSourceHash, version: 3 },
        { sourceHash: result.sourceHash, version: 3 },
      ]);
      expect(backend.requests[0]?.sourceBindings[0]?.id).toBe(RESIZE_PLAN.baseBinding.id);
      expect(backend.requests[1]?.sourceBindings[0]?.id).toBe(RESIZE_PLAN.candidateBinding.id);
    });

    it("rejects a request carrying both generic initial-edit authorities", async () => {
      const backend = new GenericCandidateArtifactBackend();
      await expect(
        runner(await projectRoot(), backend).runRuntimeTraceCandidateUnpublished(RESIZE_CANDIDATE_SOURCE, {
          ...resizeCandidateRequest(),
          genericInitialMove: candidateRequest().genericInitialMove,
        }),
      ).rejects.toThrow(/exactly one initial-edit authority/i);
      expect(backend.requests).toHaveLength(0);
    });

    it("rejects a resize candidate whose producer pair did not actually scale", async () => {
      // The fake backend replays the base artifact for the candidate, so the
      // scaled-path proof must fail closed instead of trusting the preflight.
      const backend = new GenericCandidateArtifactBackend(false, undefined, "move");
      await expect(
        runner(await projectRoot(), backend).runRuntimeTraceCandidateUnpublished(
          RESIZE_CANDIDATE_SOURCE,
          resizeCandidateRequest(),
        ),
      ).rejects.toMatchObject({ code: "candidate-endpoint" });
    });

    it("fails closed on stale authority, semantic drift, and a base source changed during execution", async () => {
      const staleBackend = new GenericCandidateArtifactBackend();
      await expect(
        runner(await projectRoot(), staleBackend).runRuntimeTraceCandidateUnpublished(CANDIDATE_SOURCE, {
          ...candidateRequest(),
          genericInitialMove: { ...candidateRequest().genericInitialMove, baseSourceHash: "f".repeat(64) },
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(staleBackend.requests).toHaveLength(0);

      await expect(
        runner(await projectRoot(), new GenericCandidateArtifactBackend(true)).runRuntimeTraceCandidateUnpublished(
          CANDIDATE_SOURCE,
          candidateRequest(),
        ),
      ).rejects.toMatchObject({ code: "candidate-semantic" });

      const changingRoot = await projectRoot();
      const changingBackend = new GenericCandidateArtifactBackend(false, async (count) => {
        if (count === 2) await writeFile(join(changingRoot, SOURCE_PATH), `${BASE_SOURCE}\n`, "utf8");
      });
      await expect(
        runner(changingRoot, changingBackend).runRuntimeTraceCandidateUnpublished(CANDIDATE_SOURCE, candidateRequest()),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("reserves the full producer capacity while the V3 pair is in flight", async () => {
      const backend = new BlockingStatusBackend();
      const instance = runner(await projectRoot(), backend);
      const abort = new AbortController();
      const pair = instance.runRuntimeTraceCandidateUnpublished(CANDIDATE_SOURCE, candidateRequest(), abort.signal);
      pair.catch(() => undefined);
      await backend.waitForStatusCall();

      await expect(
        instance.runRuntimeTrace({
          projectId: "generic-preview",
          requestId: "concurrent-preview",
          sceneName: SCENE_NAME,
          sourceHash: PLAN.baseSourceHash,
          sourcePath: SOURCE_PATH,
        }),
      ).rejects.toMatchObject({ status: 429 });
      abort.abort();
      await expect(pair).rejects.toMatchObject({ name: "AbortError" });
    });
  },
);
