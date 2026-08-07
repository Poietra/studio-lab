import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import { fastManimSourceBindingIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import {
  type FastManimRuntimeTraceInitialMoveCandidateErrorV3,
  verifyFastManimRuntimeTraceInitialMoveCandidateV3,
} from "./fast-manim-runtime-trace-v3-candidate";
import {
  createFastManimRuntimeTraceProducerRequestV3,
  fastManimRuntimeTraceSourceBindingsFromAnalysisV3,
} from "./fast-manim-runtime-trace-v3-contract";
import { fastManimRuntimeTraceV3Schema } from "./fast-manim-runtime-trace-v3-result-contract";
import genericRuntimeTraceFixture from "./test-fixtures/fast-manim-runtime-trace-v3-generic.json";

const FRAME = { height: 8, width: 128 / 9 } as const;
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
const TARGET: { x: number; y: number } = { x: 1.25, y: -0.5 };

function request(sourceText: string) {
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const analysis = studioSourceAnalysisProviderV1.analyze({
    expectedSourceHash: sourceHash,
    sceneName: SCENE_NAME,
    sourcePath: SOURCE_PATH,
    sourceText,
  });
  const sceneId = fastManimRuntimeTraceSceneIdV1(SOURCE_PATH, SCENE_NAME);
  return createFastManimRuntimeTraceProducerRequestV3(
    {
      projectId: "generic-preview",
      requestId: "request-staticsquare-v3",
      sceneName: SCENE_NAME,
      sourceHash,
      sourcePath: SOURCE_PATH,
    },
    sourceText,
    {
      constructStartLine: analysis.scene.construct.span.startLine,
      definitionOrdinal: analysis.scene.ordinal,
    },
    FRAME,
    fastManimRuntimeTraceSourceBindingsFromAnalysisV3(analysis, sceneId),
  );
}

function fixture() {
  const baseRequest = request(BASE_SOURCE);
  const candidateRequest = request(CANDIDATE_SOURCE);
  const base = fastManimRuntimeTraceV3Schema.parse(structuredClone(genericRuntimeTraceFixture));
  const candidate = structuredClone(base);
  candidate.sourceHash = candidateRequest.sourceHash;
  candidate.sourceBindings[0]!.binding = structuredClone(candidateRequest.sourceBindings[0]!);
  for (const endpoint of Object.values(candidate.sourceBindings[0]!.endpoints)) {
    endpoint.center.x = TARGET.x;
    endpoint.center.y = TARGET.y;
  }
  for (const frame of candidate.frames) {
    for (const state of frame.states) {
      state.transform.tx += TARGET.x;
      state.transform.ty += TARGET.y;
    }
  }
  return {
    base,
    baseRequest,
    binding: structuredClone(baseRequest.sourceBindings[0]!),
    candidate,
    candidateRequest,
    expectedInitialCenter: TARGET,
  };
}

function rejectCode(
  mutate: (input: ReturnType<typeof fixture>) => void,
  code: FastManimRuntimeTraceInitialMoveCandidateErrorV3["code"],
) {
  const input = fixture();
  mutate(input);
  expect(() => verifyFastManimRuntimeTraceInitialMoveCandidateV3(input)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe("verifyFastManimRuntimeTraceInitialMoveCandidateV3", () => {
  it("accepts one exact full-trace translation and returns only the verified candidate document", () => {
    const input = fixture();

    expect(verifyFastManimRuntimeTraceInitialMoveCandidateV3(input)).toEqual(input.candidate);
    expect(input.base.roots).toEqual(input.candidate.roots);
    expect(input.base.resources).toEqual(input.candidate.resources);
    expect(input.base.draws).toEqual(input.candidate.draws);
  });

  it("rejects stale SourceAnalysis binding evidence and changed runtime roots", () => {
    rejectCode((input) => (input.binding.id = `source-binding:${"f".repeat(64)}`), "base-binding");
    rejectCode((input) => (input.candidate.sourceBindings[0]!.binding.ordinal += 1), "candidate-binding");
    rejectCode((input) => (input.candidate.sourceBindings[0]!.binding.span.endColumn += 1), "candidate-binding");
    rejectCode((input) => (input.candidate.sourceBindings[0]!.updaterStatus = "conflict"), "candidate-binding");
    rejectCode((input) => (input.candidate.roots[0]!.lifetimes[0]!.endFrame += 1), "candidate-root");
  });

  it("rejects endpoint, resource, and per-frame semantic drift", () => {
    rejectCode((input) => (input.candidate.sourceBindings[0]!.endpoints.initial.center.x += 0.1), "candidate-endpoint");
    rejectCode(
      (input) => (input.candidate.sourceBindings[0]!.endpoints.terminal.dimensions.width += 0.1),
      "candidate-endpoint",
    );
    rejectCode((input) => (input.candidate.resources.paths[0]!.path.subpaths[0]!.start.x += 0.1), "candidate-resource");
    rejectCode((input) => (input.candidate.frames[0]!.states[0]!.opacity = 0.5), "candidate-semantic");
    rejectCode((input) => (input.candidate.frames[0]!.states[0]!.transform.tx += 0.1), "candidate-semantic");
  });

  it("rejects a no-op or a target substituted independently of the source-derived result", () => {
    rejectCode((input) => {
      input.candidate.sourceBindings[0]!.endpoints.initial.center = { x: 0, y: 0 };
      input.candidate.sourceBindings[0]!.endpoints.terminal.center = { x: 0, y: 0 };
      input.candidate.frames[0]!.states[0]!.transform = { ...input.base.frames[0]!.states[0]!.transform };
      input.expectedInitialCenter = { x: 0, y: 0 };
    }, "candidate-noop");
    rejectCode((input) => (input.expectedInitialCenter = { x: TARGET.x + 0.25, y: TARGET.y }), "candidate-endpoint");
  });

  it("requires the candidate binding ID to be derived from the edited source hash", () => {
    rejectCode((input) => {
      input.candidate.sourceBindings[0]!.binding.id = fastManimSourceBindingIdentifierV1(
        input.base.sourceHash,
        input.base.sceneId,
        input.candidate.sourceBindings[0]!.binding,
      );
    }, "candidate-binding");
  });
});
