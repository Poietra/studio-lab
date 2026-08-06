import { describe, expect, it, vi } from "vitest";

import type { LoweredProgramBatchSource } from "../src/render-pipeline/source-lowering";
import { ManimRenderCandidateVerifierV1 } from "./manim-render-candidate-verifier";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { sourceHash } from "./manim-source-store";
import {
  CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
  CANDIDATE_PREFLIGHT_PROFILES_V1,
} from "./test-fixtures/manim-render-candidate-preflight-fixture";

describe("ManimRenderCandidateVerifierV1", () => {
  it("fails an unregistered candidate profile closed before producer execution", async () => {
    const input = CANDIDATE_PREFLIGHT_PROFILES_V1[0]!.request();
    const { lowered, renderRequest } = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
      projectId: input.projectId,
      request: input,
    });
    expect(lowered.preflight).toBeDefined();
    const unsupported = {
      ...lowered,
      preflight: { ...lowered.preflight, kind: "fast-manim-future-unregistered-v11" },
    } as unknown as LoweredProgramBatchSource;
    const runCandidateUnpublished = vi.fn();
    const verifier = new ManimRenderCandidateVerifierV1({
      frame: { height: 8, width: 14.222222222222221 },
      runner: { runCandidateUnpublished },
    });

    await expect(verifier.verify(unsupported, renderRequest)).rejects.toMatchObject({ status: 409 });

    expect(runCandidateUnpublished).not.toHaveBeenCalled();
  });

  it("delegates UpdatersExample terminal edits to exact Runtime Trace execution", async () => {
    const input = CANDIDATE_PREFLIGHT_PROFILES_V1[0]!.request();
    const { renderRequest: fixtureRequest } = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
      projectId: input.projectId,
      request: input,
    });
    const candidateSource = "from manim import *\nclass UpdatersExample(Scene):\n    pass\n";
    const lowered = {
      anchorLine: 129,
      anchorLines: [129],
      insertedCode: "        square.move_to((2, 1, 0))",
      preflight: {
        baseSourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        kind: "fast-manim-updaters-terminal-v1" as const,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "UpdatersExample",
      sourceHash: lowered.preflight.baseSourceHash,
      sourcePath: "example_scenes/basic.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "a".repeat(64),
    });
    const runCandidateUnpublished = vi.fn();
    const verifier = new ManimRenderCandidateVerifierV1({
      frame: { height: 8, width: 14.222222222222221 },
      runner: { runCandidateUnpublished },
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        projectId: renderRequest.projectId,
        sceneName: "UpdatersExample",
        sourcePath: "example_scenes/basic.py",
      }),
      undefined,
    );
    expect(runCandidateUnpublished).not.toHaveBeenCalled();
  });

  it("delegates OpeningManim terminal position edits to exact Runtime Trace V2 execution", async () => {
    const input = CANDIDATE_PREFLIGHT_PROFILES_V1[0]!.request();
    const { renderRequest: fixtureRequest } = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
      projectId: input.projectId,
      request: input,
    });
    const candidateSource = "from manim import *\nclass OpeningManim(Scene):\n    pass\n";
    const lowered = {
      anchorLine: 68,
      anchorLines: [68],
      insertedCode: "        grid_title.shift((1.25, -0.5, 0))",
      preflight: {
        baseSourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        kind: "fast-manim-opening-terminal-v2" as const,
      },
      source: candidateSource,
    } satisfies LoweredProgramBatchSource;
    const renderRequest = {
      ...fixtureRequest,
      sceneName: "OpeningManim",
      sourceHash: lowered.preflight.baseSourceHash,
      sourcePath: "example_scenes/basic.py",
    };
    const runRuntimeTraceCandidateUnpublished = vi.fn().mockResolvedValue({
      sourceHash: sourceHash(candidateSource),
      status: "verified",
      traceDigest: "b".repeat(64),
    });
    const runCandidateUnpublished = vi.fn();
    const verifier = new ManimRenderCandidateVerifierV1({
      frame: { height: 8, width: 14.222222222222221 },
      runner: { runCandidateUnpublished },
      runtimeTraceRunner: { runRuntimeTraceCandidateUnpublished },
    });

    await expect(verifier.verify(lowered, renderRequest)).resolves.toBeUndefined();
    expect(runRuntimeTraceCandidateUnpublished).toHaveBeenCalledWith(
      candidateSource,
      expect.objectContaining({
        projectId: renderRequest.projectId,
        sceneName: "OpeningManim",
        sourcePath: "example_scenes/basic.py",
      }),
      undefined,
    );
    expect(runCandidateUnpublished).not.toHaveBeenCalled();
  });

  it("fails UpdatersExample edits closed without Runtime Trace authority", async () => {
    const input = CANDIDATE_PREFLIGHT_PROFILES_V1[0]!.request();
    const { renderRequest } = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
      projectId: input.projectId,
      request: input,
    });
    const lowered = {
      anchorLine: 129,
      anchorLines: [129],
      insertedCode: "        square.scale(1.5)",
      preflight: {
        baseSourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
        kind: "fast-manim-updaters-terminal-v1" as const,
      },
      source: "candidate",
    } satisfies LoweredProgramBatchSource;
    const verifier = new ManimRenderCandidateVerifierV1({
      frame: { height: 8, width: 14.222222222222221 },
      runner: { runCandidateUnpublished: vi.fn() },
    });

    await expect(verifier.verify(lowered, renderRequest)).rejects.toMatchObject({ status: 409 });
  });
});
