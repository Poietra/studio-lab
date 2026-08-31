import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { MathTexOutlineResponseV1 } from "../src/engine/mathtex-outline";
import { createInspectorEntityEditProgram, createStudioEntitiesProgram } from "../src/studio/authoring-commands";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import { HttpError } from "./http/json";
import {
  createCircleProgram,
  mathTexTransformProgram,
  motionProgram,
  request as renderRequestFixture,
  sceneSource,
  verifiedSnapshotView,
} from "./manim-render-pipeline-test-fixtures";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import {
  authorizeSnapshotProgramWithSnapshot,
  authorizeStudioCreationProgramWithRuntimeTrace,
} from "./manim-snapshot-program-authorizer";
import { importSourceSnapshot, sceneView } from "./manim-workspace";

const compilers = vi.hoisted(() => ({
  creation: vi.fn(),
  mathTexTransform: vi.fn(),
  outline: vi.fn(),
  staticRoot: vi.fn(),
  textOutline: vi.fn(),
}));

const snapshots = vi.hoisted(() => ({
  lookup: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../src/engine/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine/contracts")>();
  return {
    ...actual,
    parseVerifiedSceneIrBundleV1: async (value: unknown) => actual.sceneIrBundleV1Schema.parse(value),
  };
});

vi.mock("../src/engine/mathtex-outline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/mathtex-outline")>()),
  compileMathTexOutlineV1: compilers.outline,
  compileTextOutlineV1: compilers.textOutline,
}));

vi.mock("../src/engine/scene-authoring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/scene-authoring")>()),
  compileApplyStudioCreationEdit: compilers.creation,
  compileApplyStudioMathTexTransformEdit: compilers.mathTexTransform,
  compileApplyStaticRootTransformEdit: compilers.staticRoot,
}));

const entityId = "source:scene.py#GroupedEquation:equation";
const frame = { height: 8, width: 14.222 } as const;
const sourceWithZeroAnchor = sceneSource.replace(
  "        self.add(equation)\n",
  "        self.add(equation)\n        # poietra:anchor 0.000\n",
);

async function lowerContent(
  transactionId: string,
  outlineResult: MathTexOutlineResponseV1["result"] | "compiled",
  snapshotState: "published" | "missing" | "lookup-failed" = "published",
) {
  const runtimeSceneState = sceneView(
    importSourceSnapshot(sourceWithZeroAnchor, "scene.py", frame).view,
    "GroupedEquation",
  )?.runtimeSceneState;
  if (!runtimeSceneState) throw new Error("The MathTex authorization fixture did not import.");
  const edit = createInspectorEntityEditProgram({
    capturedPlayhead: 0,
    edits: { content: { displayLines: ["F = ma"], label: "F = ma", texParts: ["F", "=", "m", "a"] } },
    entityId,
    from: { position: { x: 0, y: 0 }, scale: 1 },
    scene: runtimeSceneState,
    transactionId,
  });
  if (edit.kind !== "valid") throw new Error("The MathTex authorization fixture did not validate.");
  const base = renderRequestFixture();
  const request = {
    ...base,
    program: edit.program,
    sourceHash: createHash("sha256").update(sourceWithZeroAnchor).digest("hex"),
  };
  const snapshot = await verifiedSnapshotView(request, "equation");
  if (snapshot.status !== "verified") throw new Error("The snapshot authorization fixture is not verified.");
  snapshots.lookup.mockImplementation(async () => {
    if (snapshotState === "missing") throw new HttpError("No verified Scene snapshot has been published.", 404);
    if (snapshotState === "lookup-failed") throw new HttpError("Snapshot storage is unavailable.", 503);
    return snapshot;
  });
  snapshots.run.mockResolvedValue(snapshot);
  if (outlineResult === "compiled") {
    const bundle = snapshot.snapshot.bundle as SceneIrBundleV1;
    const entity = bundle.scene.entities.find(({ geometry }) => geometry.kind === "cubic-path");
    if (!entity || entity.geometry.kind !== "cubic-path") throw new Error("The snapshot has no MathTex path.");
    compilers.outline.mockResolvedValue({
      result: {
        bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
        contentDigest: "a".repeat(64),
        fillRule: "nonzero",
        fontDigest: "b".repeat(64),
        kind: "compiled",
        path: entity.geometry.path,
        toolchainDigest: "c".repeat(64),
      },
      schema: "poietra.mathtex-outline-response",
      version: 1,
    });
  } else {
    compilers.outline.mockResolvedValue({
      result: outlineResult,
      schema: "poietra.mathtex-outline-response",
      version: 1,
    });
  }
  return lowerManimRenderRequest({
    frame,
    originalSource: sourceWithZeroAnchor,
    projectId: request.projectId,
    request,
    snapshotProgramAuthorizer: (input) =>
      authorizeSnapshotProgramWithSnapshot(input, snapshots.lookup, undefined, snapshots.run),
  });
}

async function lowerTransformMotion(transactionId: string) {
  const runtimeSceneState = sceneView(
    importSourceSnapshot(sceneSource, "scene.py", frame).view,
    "GroupedEquation",
  )?.runtimeSceneState;
  if (!runtimeSceneState) throw new Error("The MathTex transform authorization fixture did not import.");
  const transform = mathTexTransformProgram(transactionId);
  const finalTargetEntityId = `tx:${transactionId}/entity:restored`;
  const motion = motionProgram(7, `${transactionId}-motion`, finalTargetEntityId);
  const base = renderRequestFixture();
  const request = { ...base, program: transform, programs: [transform, motion] };
  const snapshot = await verifiedSnapshotView(request, "equation");
  if (snapshot.status !== "verified") throw new Error("The snapshot authorization fixture is not verified.");
  const bundle = snapshot.snapshot.bundle as SceneIrBundleV1;
  const entity = bundle.scene.entities.find(({ geometry }) => geometry.kind === "cubic-path");
  if (!entity || entity.geometry.kind !== "cubic-path") throw new Error("The snapshot has no MathTex path.");
  compilers.outline.mockResolvedValue({
    result: {
      bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
      contentDigest: "a".repeat(64),
      fillRule: "nonzero",
      fontDigest: "b".repeat(64),
      kind: "compiled",
      path: entity.geometry.path,
      toolchainDigest: "c".repeat(64),
    },
    schema: "poietra.mathtex-outline-response",
    version: 1,
  });
  const result = lowerManimRenderRequest({
    frame,
    originalSource: sceneSource,
    projectId: request.projectId,
    request,
    snapshotProgramAuthorizer: (input) => authorizeSnapshotProgramWithSnapshot(input, async () => snapshot),
  });
  return { finalTargetEntityId, motion, result, transform } as const;
}

describe("snapshot MathTex authorization", () => {
  beforeEach(() => {
    compilers.creation.mockReset();
    compilers.mathTexTransform.mockReset();
    compilers.outline.mockReset();
    compilers.staticRoot.mockReset();
    compilers.textOutline.mockReset();
    snapshots.lookup.mockReset();
    snapshots.run.mockReset();
  });

  it("keeps canonical Text size out of unit-outline compilation and in the Rust creation command", async () => {
    const imported = importSourceSnapshot(sourceWithZeroAnchor, "scene.py", frame);
    const runtimeSceneState = sceneView(imported.view, "GroupedEquation")?.runtimeSceneState;
    if (!runtimeSceneState) throw new Error("The Text authorization fixture did not import.");
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [
        {
          content: {
            displayLines: ["Sized Text"],
            text: "Sized Text",
            textLayout: {
              alignment: "left",
              fontFamily: "mono",
              fontSize: 1.75,
              fontWeight: "bold",
              lineHeight: 1.2,
            },
          },
          position: { x: 320, y: 180 },
          type: "Text",
        },
      ],
      scene: runtimeSceneState,
      transactionId: "authorized-sized-text",
    });
    const base = renderRequestFixture();
    const request = {
      ...base,
      program: creation.validation.program,
      sourceHash: createHash("sha256").update(sourceWithZeroAnchor).digest("hex"),
    };
    const snapshot = await verifiedSnapshotView(request, "equation");
    if (snapshot.status !== "verified") throw new Error("The Text authorization snapshot is not verified.");
    const bundle = snapshot.snapshot.bundle as SceneIrBundleV1;
    const entity = bundle.scene.entities.find(({ geometry }) => geometry.kind === "cubic-path");
    if (!entity || entity.geometry.kind !== "cubic-path") throw new Error("The snapshot has no outline path.");
    const glyphPath = entity.geometry.path;
    const fragments = [..."Sized Text"]
      .filter((character) => !/\s/u.test(character))
      .map((character, order) => ({
        order,
        path: glyphPath,
        sourceCorrelation: { key: character, kind: "nfc-scalar" as const },
      }));
    const outlinePath = {
      subpaths: fragments.flatMap((fragment) => fragment.path.subpaths),
    };
    compilers.textOutline.mockResolvedValue({
      result: {
        bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
        fillRule: "nonzero",
        fragments,
        kind: "compiled",
        path: outlinePath,
      },
      schema: "poietra.text-outline-response",
      version: 1,
    });
    compilers.creation.mockResolvedValue({});

    const result = lowerManimRenderRequest({
      frame,
      originalSource: sourceWithZeroAnchor,
      projectId: request.projectId,
      request,
      snapshotProgramAuthorizer: (input) => authorizeSnapshotProgramWithSnapshot(input, async () => snapshot),
    });

    await expect(result).resolves.toBeDefined();
    expect(compilers.textOutline).toHaveBeenCalledWith({
      layout: { alignment: "left", fontFamily: "mono", fontWeight: "bold", lineHeight: 1.2 },
      text: "Sized Text",
    });
    expect(compilers.creation.mock.calls[0]?.[1]).toMatchObject({
      textOutlines: [
        {
          entityId: creation.entityIds[0],
          fragments,
          layout: {
            alignment: "left",
            fontFamily: "mono",
            fontSize: 1.75,
            fontWeight: "bold",
            lineHeight: 1.2,
          },
        },
      ],
    });
  });

  it("authorizes Studio creation from a fresh verified Runtime Trace when no static snapshot exists", async () => {
    const imported = importSourceSnapshot(sceneSource, "scene.py", frame);
    const runtimeSceneState = sceneView(imported.view, "GroupedEquation")?.runtimeSceneState;
    if (!runtimeSceneState) throw new Error("The Runtime Trace creation fixture did not import.");
    const program = createCircleProgram("runtime-trace-creation");
    const request = { ...renderRequestFixture(), program };
    const published = await verifiedSnapshotView(request);
    if (published.status !== "verified") throw new Error("The Runtime Trace base fixture is not verified.");
    const publishedBundle = published.snapshot.bundle as SceneIrBundleV1;
    const traceDigest = "f".repeat(64);
    const runtimeConfigHash = "d".repeat(64);
    const sceneId = fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName);
    const bundle: SceneIrBundleV1 = {
      assets: publishedBundle.assets,
      scene: {
        ...publishedBundle.scene,
        sceneId,
        source: {
          kind: "imported-manim-runtime-trace",
          runtimeConfigHash,
          sourceHash: request.sourceHash,
          traceDigest,
          traceVersion: 3,
        },
      },
    };
    compilers.creation.mockResolvedValue({});
    const lookup = vi.fn(async (runtimeRequest) => ({
      bundle,
      producerEvidence: { correlationSha256: "a".repeat(64), semanticsSha256: "b".repeat(64) },
      projectId: runtimeRequest.projectId,
      requestId: runtimeRequest.requestId,
      roots: [],
      runtimeConfigHash,
      sceneId,
      sceneName: runtimeRequest.sceneName,
      schema: "poietra.fast-manim-runtime-trace-run" as const,
      sourceHash: runtimeRequest.sourceHash,
      sourcePath: runtimeRequest.sourcePath,
      status: "verified" as const,
      traceDigest,
      version: 2 as const,
    }));

    await authorizeStudioCreationProgramWithRuntimeTrace(
      {
        authorizationKind: "studio-creation",
        frame,
        programs: [program],
        projectId: request.projectId,
        request,
        runtimeSceneState,
      },
      lookup,
    );

    expect(lookup).toHaveBeenCalledOnce();
    expect(compilers.creation).toHaveBeenCalledOnce();
    expect(compilers.creation.mock.calls[0]?.[1]).toMatchObject({
      expectedBaseRevision: traceDigest,
      programs: [
        {
          operations: [{ kind: "create" }, { kind: "position" }, { kind: "fade-in" }],
          transactionId: program.transactionId,
        },
      ],
    });
  });

  it("rejects a stale Runtime Trace before invoking the Rust creation compiler", async () => {
    const imported = importSourceSnapshot(sceneSource, "scene.py", frame);
    const runtimeSceneState = sceneView(imported.view, "GroupedEquation")?.runtimeSceneState;
    if (!runtimeSceneState) throw new Error("The stale Runtime Trace fixture did not import.");
    const program = createCircleProgram("stale-runtime-trace-creation");
    const request = { ...renderRequestFixture(), program };

    await expect(
      authorizeStudioCreationProgramWithRuntimeTrace(
        {
          authorizationKind: "studio-creation",
          frame,
          programs: [program],
          projectId: request.projectId,
          request,
          runtimeSceneState,
        },
        async (runtimeRequest) => ({
          bundle: {},
          producerEvidence: { correlationSha256: "a".repeat(64), semanticsSha256: "b".repeat(64) },
          projectId: runtimeRequest.projectId,
          requestId: "stale-request",
          roots: [],
          runtimeConfigHash: "d".repeat(64),
          sceneId: fastManimRuntimeTraceSceneIdV1(runtimeRequest.sourcePath, runtimeRequest.sceneName),
          sceneName: runtimeRequest.sceneName,
          schema: "poietra.fast-manim-runtime-trace-run",
          sourceHash: runtimeRequest.sourceHash,
          sourcePath: runtimeRequest.sourcePath,
          status: "verified",
          traceDigest: "f".repeat(64),
          version: 2,
        }),
      ),
    ).rejects.toMatchObject({
      message: "The verified Runtime Trace does not match this render request.",
      status: 409,
    });
    expect(compilers.creation).not.toHaveBeenCalled();
  });

  it("compiles the replacement outline once before applying the existing static-root command", async () => {
    compilers.staticRoot.mockResolvedValue({});

    const result = await lowerContent("authorized-content", "compiled");

    expect(compilers.outline).toHaveBeenCalledOnce();
    expect(compilers.outline).toHaveBeenCalledWith(["F", "=", "m", "a"]);
    expect(compilers.staticRoot).toHaveBeenCalledOnce();
    expect(compilers.staticRoot.mock.calls[0]?.[1]).toMatchObject({
      mathTexOutlines: [{ entityId, path: expect.any(Object), texParts: ["F", "=", "m", "a"] }],
      programs: [{ operations: [{ content: { texParts: ["F", "=", "m", "a"] }, kind: "math-tex-content" }] }],
      schema: "poietra.apply-static-root-transform-edit",
      version: 1,
    });
    expect(result.lowered.source).toContain('equation.become(MathTex("F", "=", "m", "a")');
    expect(snapshots.run).not.toHaveBeenCalled();
  });

  it("runs one fresh verified snapshot when imported MathTex Apply has no publication", async () => {
    compilers.staticRoot.mockResolvedValue({});

    const result = await lowerContent("lazy-snapshot-content", "compiled", "missing");

    expect(result.lowered.source).toContain('equation.become(MathTex("F", "=", "m", "a")');
    expect(snapshots.lookup).toHaveBeenCalledOnce();
    expect(snapshots.run).toHaveBeenCalledOnce();
    expect(snapshots.run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        sceneName: "GroupedEquation",
        sourceHash: createHash("sha256").update(sourceWithZeroAnchor).digest("hex"),
        sourcePath: "scene.py",
      }),
      undefined,
    );
    expect(compilers.staticRoot).toHaveBeenCalledOnce();
  });

  it("does not run a snapshot when publication lookup fails for another reason", async () => {
    await expect(lowerContent("failed-snapshot-lookup", "compiled", "lookup-failed")).rejects.toMatchObject({
      message: "Snapshot storage is unavailable.",
      status: 503,
    });
    expect(snapshots.run).not.toHaveBeenCalled();
    expect(compilers.staticRoot).not.toHaveBeenCalled();
  });

  it("returns the outline compiler's unsupported result as a client error", async () => {
    await expect(
      lowerContent("unsupported-content", {
        code: "syntax-unsupported",
        kind: "unsupported",
        message: "unsupported command",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("syntax-unsupported"),
      status: 400,
    });
    expect(compilers.staticRoot).not.toHaveBeenCalled();
  });

  it("reports a Rust content compiler rejection through the snapshot authorization boundary", async () => {
    compilers.staticRoot.mockRejectedValue(new Error("content command rejected"));

    await expect(lowerContent("rejected-content", "compiled")).rejects.toMatchObject({
      message: "The Rust core rejected the snapshot Program batch: content command rejected",
      status: 400,
    });
  });

  it("authorizes a MathTex transform chain and its final motion as one Rust command", async () => {
    compilers.mathTexTransform.mockResolvedValue({});

    const { finalTargetEntityId, motion, result, transform } = await lowerTransformMotion("transform-motion");

    await expect(result).resolves.toBeDefined();
    expect(compilers.outline).toHaveBeenCalledTimes(2);
    expect(compilers.mathTexTransform).toHaveBeenCalledOnce();
    expect(compilers.mathTexTransform.mock.calls[0]?.[1]).toMatchObject({
      frame,
      programs: [
        {
          operations: [
            { kind: "transform-content" },
            { kind: "transform-content", targetEntityId: finalTargetEntityId },
          ],
          transactionId: transform.transactionId,
        },
        {
          operations: [{ kind: "create-motion", targetEntityIds: [finalTargetEntityId] }],
          transactionId: motion.transactionId,
        },
      ],
      schema: "poietra.apply-studio-math-tex-transform-edit",
      version: 1,
      viewport: { height: 360, width: 640 },
    });
  });

  it("rejects a mixed MathTex transform and motion atomically when Rust rejects the command", async () => {
    compilers.mathTexTransform.mockRejectedValue(new Error("transform motion rejected"));

    const { result } = await lowerTransformMotion("rejected-transform-motion");

    await expect(result).rejects.toMatchObject({
      message: "The Rust core rejected the snapshot Program batch: transform motion rejected",
      status: 400,
    });
    expect(compilers.mathTexTransform).toHaveBeenCalledOnce();
  });
});
