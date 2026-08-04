import { describe, expect, it, vi } from "vitest";

import type { LoweredProgramBatchSource } from "../src/render-pipeline/source-lowering";
import { ManimRenderCandidateVerifierV1 } from "./manim-render-candidate-verifier";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
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
});
