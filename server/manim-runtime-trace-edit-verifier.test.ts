import { describe, expect, it, vi } from "vitest";

import type { LoweredProgramBatchSource } from "../src/render-pipeline/source-lowering";
import { request } from "./manim-render-pipeline-test-fixtures";
import { ManimRuntimeTraceEditVerifier } from "./manim-runtime-trace-edit-verifier";
import { sourceHash } from "./manim-source-store";

describe("ManimRuntimeTraceEditVerifier", () => {
  it("fails an unregistered candidate profile closed before producer execution", async () => {
    const renderRequest = request();
    const unsupported = {
      anchorLine: 1,
      anchorLines: [1],
      insertedCode: "pass",
      preflight: { baseSourceHash: renderRequest.sourceHash, kind: "fast-manim-future-unregistered" },
      source: "candidate",
    } as unknown as LoweredProgramBatchSource;
    const verifier = new ManimRuntimeTraceEditVerifier({});

    await expect(verifier.verify(unsupported, renderRequest)).rejects.toMatchObject({ status: 409 });
  });

  it("delegates one source-bound generic move edit with its server-derived target evidence", async () => {
    const fixtureRequest = request();
    const candidateSource = "from manim import *\nclass StaticSquare(Scene):\n    pass\n";
    const entityId = "source:scenes/static_square.py#StaticSquare:square";
    const baseSourceHash = "c".repeat(64);
    const lowered = {
      anchorLine: 5,
      anchorLines: [5],
      insertedCode: "        square.move_to((1.25, -0.5, 0))",
      preflight: {
        baseBinding: {
          id: `source-binding:${"d".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
        baseSourceHash,
        entityId,
        expectedWorldCenter: { x: 1.25, y: -0.5 },
        kind: "runtime-trace-move-edit" as const,
        sourceAnchor: 0,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "StaticSquare",
      sourceBindings: [{ entityId, sourceVariable: "square" }],
      sourceHash: baseSourceHash,
      sourcePath: "scenes/static_square.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "e".repeat(64),
    });
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        moveEdit: lowered.preflight,
        projectId: renderRequest.projectId,
        sceneName: "StaticSquare",
        sourcePath: "scenes/static_square.py",
      }),
      undefined,
    );
  });

  it("forwards a nonzero static-wait source anchor to the generic candidate runner", async () => {
    const fixtureRequest = request();
    const candidateSource = "from manim import *\nclass StaticSquare(Scene):\n    pass\n";
    const entityId = "source:scenes/static_square.py#StaticSquare:square";
    const baseSourceHash = "c".repeat(64);
    const lowered = {
      anchorLine: 9,
      anchorLines: [9],
      insertedCode: "        square.move_to((1.25, -0.5, 0))",
      preflight: {
        baseBinding: {
          id: `source-binding:${"d".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
        baseSourceHash,
        entityId,
        expectedWorldCenter: { x: 1.25, y: -0.5 },
        kind: "runtime-trace-move-edit" as const,
        sourceAnchor: 5,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "StaticSquare",
      sourceBindings: [{ entityId, sourceVariable: "square" }],
      sourceHash: baseSourceHash,
      sourcePath: "scenes/static_square.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "e".repeat(64),
    });
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({ moveEdit: lowered.preflight }),
      undefined,
    );
  });

  it("delegates one source-bound generic resize edit with its server-derived factor evidence", async () => {
    const fixtureRequest = request();
    const candidateSource = "from manim import *\nclass StaticSquare(Scene):\n    pass\n";
    const entityId = "source:scenes/static_square.py#StaticSquare:square";
    const baseSourceHash = "c".repeat(64);
    const lowered = {
      anchorLine: 5,
      anchorLines: [5],
      insertedCode: "        square.scale(1.5)",
      preflight: {
        baseBinding: {
          id: `source-binding:${"d".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
        baseSourceHash,
        entityId,
        expectedScaleFactor: 1.5,
        kind: "runtime-trace-resize-edit" as const,
        sourceAnchor: 0,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "StaticSquare",
      sourceBindings: [{ entityId, sourceVariable: "square" }],
      sourceHash: baseSourceHash,
      sourcePath: "scenes/static_square.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "e".repeat(64),
    });
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        resizeEdit: lowered.preflight,
        projectId: renderRequest.projectId,
        sceneName: "StaticSquare",
        sourcePath: "scenes/static_square.py",
      }),
      undefined,
    );
  });

  it("delegates one source-bound generic opacity edit with its server-derived value", async () => {
    const fixtureRequest = request();
    const candidateSource = "from manim import *\nclass StaticSquare(Scene):\n    pass\n";
    const entityId = "source:scenes/static_square.py#StaticSquare:square";
    const baseSourceHash = "c".repeat(64);
    const lowered = {
      anchorLine: 5,
      anchorLines: [5],
      insertedCode: "        square.set_opacity(0.35)",
      preflight: {
        baseBinding: {
          id: `source-binding:${"d".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
        baseSourceHash,
        entityId,
        expectedOpacity: 0.35,
        kind: "runtime-trace-opacity-edit" as const,
        sourceAnchor: 0,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "StaticSquare",
      sourceBindings: [{ entityId, sourceVariable: "square" }],
      sourceHash: baseSourceHash,
      sourcePath: "scenes/static_square.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "e".repeat(64),
    });
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        opacityEdit: lowered.preflight,
        projectId: renderRequest.projectId,
        sceneName: "StaticSquare",
        sourcePath: "scenes/static_square.py",
      }),
      undefined,
    );
  });

  it("delegates one source-bound generic rotation edit with its server-derived angle evidence", async () => {
    const fixtureRequest = request();
    const candidateSource = "from manim import *\nclass StaticSquare(Scene):\n    pass\n";
    const entityId = "source:scenes/static_square.py#StaticSquare:square";
    const baseSourceHash = "c".repeat(64);
    const lowered = {
      anchorLine: 5,
      anchorLines: [5],
      insertedCode: "        square.rotate(0.5)",
      preflight: {
        baseBinding: {
          id: `source-binding:${"d".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
        baseSourceHash,
        entityId,
        expectedAngleRadians: 0.5,
        kind: "runtime-trace-rotation-edit" as const,
        sourceAnchor: 0,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "StaticSquare",
      sourceBindings: [{ entityId, sourceVariable: "square" }],
      sourceHash: baseSourceHash,
      sourcePath: "scenes/static_square.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "e".repeat(64),
    });
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        rotationEdit: lowered.preflight,
        projectId: renderRequest.projectId,
        sceneName: "StaticSquare",
        sourcePath: "scenes/static_square.py",
      }),
      undefined,
    );
  });

  it("rejects a generic resize edit whose factor is not a positive non-identity number", async () => {
    const candidateSource = "candidate";
    const entityId = "source:scene.py#StaticSquare:square";
    const runRuntimeTraceCandidateUnpublished = vi.fn();
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });
    for (const expectedScaleFactor of [1, 0, -1.5, Number.NaN]) {
      const lowered = {
        anchorLine: 1,
        anchorLines: [1],
        insertedCode: "square.scale(1.5)",
        preflight: {
          baseBinding: {
            id: `source-binding:${"a".repeat(64)}`,
            name: "square",
            ordinal: 1,
            span: { endColumn: 6, endLine: 1, startColumn: 0, startLine: 1 },
          },
          baseSourceHash: "c".repeat(64),
          entityId,
          expectedScaleFactor,
          kind: "runtime-trace-resize-edit" as const,
          sourceAnchor: 0,
        },
        source: candidateSource,
      } satisfies LoweredProgramBatchSource;
      const renderRequest = {
        ...request(),
        sceneName: "StaticSquare",
        sourceBindings: [{ entityId, sourceVariable: "square" }],
        sourceHash: "c".repeat(64),
        sourcePath: "scene.py",
      };
      await expect(verifier.verify(lowered, renderRequest)).rejects.toMatchObject({ status: 409 });
    }
    expect(runRuntimeTraceCandidateUnpublished).not.toHaveBeenCalled();
  });

  it("rejects a generic opacity edit outside the closed unit interval", async () => {
    const entityId = "source:scene.py#StaticSquare:square";
    const runRuntimeTraceCandidateUnpublished = vi.fn();
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });
    for (const expectedOpacity of [-0.1, 1.1, Number.NaN]) {
      const lowered = {
        anchorLine: 1,
        anchorLines: [1],
        insertedCode: "square.set_opacity(0.35)",
        preflight: {
          baseBinding: {
            id: `source-binding:${"a".repeat(64)}`,
            name: "square",
            ordinal: 1,
            span: { endColumn: 6, endLine: 1, startColumn: 0, startLine: 1 },
          },
          baseSourceHash: "c".repeat(64),
          entityId,
          expectedOpacity,
          kind: "runtime-trace-opacity-edit" as const,
          sourceAnchor: 0,
        },
        source: "candidate",
      } satisfies LoweredProgramBatchSource;
      await expect(
        verifier.verify(lowered, {
          ...request(),
          sceneName: "StaticSquare",
          sourceBindings: [{ entityId, sourceVariable: "square" }],
          sourceHash: lowered.preflight.baseSourceHash,
          sourcePath: "scene.py",
        }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(runRuntimeTraceCandidateUnpublished).not.toHaveBeenCalled();
  });

  it("rejects a generic move edit whose request binding does not match its server preflight", async () => {
    const candidateSource = "candidate";
    const entityId = "source:scene.py#StaticSquare:square";
    const lowered = {
      anchorLine: 1,
      anchorLines: [1],
      insertedCode: "square.move_to((1, 1, 0))",
      preflight: {
        baseBinding: {
          id: `source-binding:${"a".repeat(64)}`,
          name: "square",
          ordinal: 1,
          span: { endColumn: 6, endLine: 1, startColumn: 0, startLine: 1 },
        },
        baseSourceHash: "b".repeat(64),
        entityId,
        expectedWorldCenter: { x: 1, y: 1 },
        kind: "runtime-trace-move-edit" as const,
        sourceAnchor: 0,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const runRuntimeTraceCandidateUnpublished = vi.fn();
    const verifier = new ManimRuntimeTraceEditVerifier({
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(
      verifier.verify(lowered, {
        ...request(),
        sourceBindings: [{ entityId: "another-entity", sourceVariable: "square" }],
        sourceHash: lowered.preflight.baseSourceHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(runRuntimeTraceCandidateUnpublished).not.toHaveBeenCalled();
  });
});
