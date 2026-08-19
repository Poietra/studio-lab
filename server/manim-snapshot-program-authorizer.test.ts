import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { MathTexOutlineResponseV1 } from "../src/engine/mathtex-outline";
import { createInspectorEntityEditProgram, createStudioEntitiesProgram } from "../src/studio/authoring-commands";
import {
  mathTexTransformProgram,
  motionProgram,
  request as renderRequestFixture,
  sceneSource,
  verifiedSnapshotView,
} from "./manim-render-pipeline-test-fixtures";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { authorizeSnapshotProgramWithSnapshot } from "./manim-snapshot-program-authorizer";
import { importSourceSnapshot, sceneView } from "./manim-workspace";

const compilers = vi.hoisted(() => ({
  creation: vi.fn(),
  mathTexTransform: vi.fn(),
  outline: vi.fn(),
  staticRoot: vi.fn(),
  textOutline: vi.fn(),
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

async function lowerContent(transactionId: string, outlineResult: MathTexOutlineResponseV1["result"] | "compiled") {
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
    snapshotProgramAuthorizer: (input) => authorizeSnapshotProgramWithSnapshot(input, async () => snapshot),
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
            textLayout: { alignment: "left", fontSize: 1.75, lineHeight: 1.2 },
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
    compilers.textOutline.mockResolvedValue({
      result: {
        bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
        fillRule: "nonzero",
        kind: "compiled",
        path: entity.geometry.path,
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
      layout: { alignment: "left", lineHeight: 1.2 },
      text: "Sized Text",
    });
    expect(compilers.creation.mock.calls[0]?.[1]).toMatchObject({
      textOutlines: [
        { entityId: creation.entityIds[0], layout: { alignment: "left", fontSize: 1.75, lineHeight: 1.2 } },
      ],
    });
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
