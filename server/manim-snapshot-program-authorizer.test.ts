import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { MathTexOutlineResponseV1 } from "../src/engine/mathtex-outline";
import { createInspectorEntityEditProgram } from "../src/studio/authoring-commands";
import {
  request as renderRequestFixture,
  sceneSource,
  verifiedSnapshotView,
} from "./manim-render-pipeline-test-fixtures";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { authorizeSnapshotProgramWithSnapshot } from "./manim-snapshot-program-authorizer";
import { importSourceSnapshot, sceneView } from "./manim-workspace";

const compilers = vi.hoisted(() => ({
  content: vi.fn(),
  outline: vi.fn(),
}));

vi.mock("../src/engine/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine/contracts")>();
  return {
    ...actual,
    parseVerifiedSceneIrBundleV1: async (value: unknown) => actual.sceneIrBundleV1Schema.parse(value),
  };
});

vi.mock("../src/engine/mathtex-outline", () => ({
  compileMathTexOutlineV1: compilers.outline,
}));

vi.mock("../src/engine/scene-authoring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/scene-authoring")>()),
  compileApplyStudioMathTexContentEdit: compilers.content,
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

describe("snapshot MathTex content authorization", () => {
  beforeEach(() => {
    compilers.content.mockReset();
    compilers.outline.mockReset();
  });

  it("compiles the replacement outline once before applying the dedicated Rust command", async () => {
    compilers.content.mockResolvedValue({});

    const result = await lowerContent("authorized-content", "compiled");

    expect(compilers.outline).toHaveBeenCalledOnce();
    expect(compilers.outline).toHaveBeenCalledWith(["F", "=", "m", "a"]);
    expect(compilers.content).toHaveBeenCalledOnce();
    expect(compilers.content.mock.calls[0]?.[1]).toMatchObject({
      mathTexOutlines: [{ entityId, path: expect.any(Object), texParts: ["F", "=", "m", "a"] }],
      programs: [{ operations: [{ content: { texParts: ["F", "=", "m", "a"] }, kind: "math-tex-content" }] }],
      schema: "poietra.apply-studio-math-tex-content-edit",
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
    expect(compilers.content).not.toHaveBeenCalled();
  });

  it("reports a Rust content compiler rejection through the snapshot authorization boundary", async () => {
    compilers.content.mockRejectedValue(new Error("content command rejected"));

    await expect(lowerContent("rejected-content", "compiled")).rejects.toMatchObject({
      message: "The Rust core rejected the snapshot Program batch: content command rejected",
      status: 400,
    });
  });
});
