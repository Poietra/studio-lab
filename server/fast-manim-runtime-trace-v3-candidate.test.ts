import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import { fastManimSourceBindingIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import {
  type FastManimRuntimeTraceInitialEditCandidateErrorV3,
  verifyFastManimRuntimeTraceInitialMoveCandidateV3,
  verifyFastManimRuntimeTraceInitialResizeCandidateV3,
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
  code: FastManimRuntimeTraceInitialEditCandidateErrorV3["code"],
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

const RESIZE_FACTOR = 1.5;
const RESIZE_CANDIDATE_SOURCE = BASE_SOURCE.replace(
  "        square.set_stroke(WHITE, width=2)\n",
  "        square.scale(1.5)\n        square.set_stroke(WHITE, width=2)\n",
);
const SCALED_PATH_ID = `path:${"b".repeat(64)}`;

type ResizeFixture = ReturnType<typeof resizeFixture>;

function scaledPathValue(
  path: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>["resources"]["paths"][number]["path"],
  factor: number,
) {
  // Mirror the producer: scale in binary64 and canonicalize to 13 decimals.
  const canonical = (value: number) => Number((value * factor).toFixed(13));
  return {
    subpaths: path.subpaths.map((subpath) => ({
      closed: subpath.closed,
      segments: subpath.segments.map((segment) => ({
        control1: { x: canonical(segment.control1.x), y: canonical(segment.control1.y) },
        control2: { x: canonical(segment.control2.x), y: canonical(segment.control2.y) },
        end: { x: canonical(segment.end.x), y: canonical(segment.end.y) },
      })),
      start: { x: canonical(subpath.start.x), y: canonical(subpath.start.y) },
    })),
  };
}

function resizeFixture() {
  const baseRequest = request(BASE_SOURCE);
  const candidateRequest = request(RESIZE_CANDIDATE_SOURCE);
  const base = fastManimRuntimeTraceV3Schema.parse(structuredClone(genericRuntimeTraceFixture));
  const candidate = structuredClone(base);
  candidate.sourceHash = candidateRequest.sourceHash;
  candidate.sourceBindings[0]!.binding = structuredClone(candidateRequest.sourceBindings[0]!);
  for (const endpoint of Object.values(candidate.sourceBindings[0]!.endpoints)) {
    endpoint.dimensions.height = Number((endpoint.dimensions.height * RESIZE_FACTOR).toFixed(13));
    endpoint.dimensions.width = Number((endpoint.dimensions.width * RESIZE_FACTOR).toFixed(13));
  }
  candidate.resources.paths = base.resources.paths.map((resource) => ({
    id: SCALED_PATH_ID,
    path: scaledPathValue(resource.path, RESIZE_FACTOR),
  }));
  for (const frame of candidate.frames) {
    for (const state of frame.states) {
      state.pathId = SCALED_PATH_ID;
    }
  }
  return {
    base,
    baseRequest,
    binding: structuredClone(baseRequest.sourceBindings[0]!),
    candidate,
    candidateRequest,
    expectedScaleFactor: RESIZE_FACTOR,
  };
}

function rejectResizeCode(
  mutate: (input: ResizeFixture) => void,
  code: FastManimRuntimeTraceInitialEditCandidateErrorV3["code"],
) {
  const input = resizeFixture();
  mutate(input);
  expect(() => verifyFastManimRuntimeTraceInitialResizeCandidateV3(input)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe("verifyFastManimRuntimeTraceInitialResizeCandidateV3", () => {
  it("accepts one exact center-preserving path scaling and returns only the verified candidate document", () => {
    const input = resizeFixture();

    expect(verifyFastManimRuntimeTraceInitialResizeCandidateV3(input)).toEqual(input.candidate);
    expect(input.base.roots).toEqual(input.candidate.roots);
    expect(input.base.draws).toEqual(input.candidate.draws);
    expect(input.base.resources.appearances).toEqual(input.candidate.resources.appearances);
    expect(input.base.resources.paths).not.toEqual(input.candidate.resources.paths);
  });

  it("rejects endpoint drift, moved placement, and unscaled or foreign path resources", () => {
    rejectResizeCode(
      (input) => (input.candidate.sourceBindings[0]!.endpoints.initial.center.x += 0.1),
      "candidate-endpoint",
    );
    rejectResizeCode(
      (input) => (input.candidate.sourceBindings[0]!.endpoints.terminal.dimensions.width = 2),
      "candidate-endpoint",
    );
    rejectResizeCode((input) => (input.candidate.frames[0]!.states[0]!.transform.tx += 0.1), "candidate-semantic");
    rejectResizeCode((input) => (input.candidate.frames[0]!.states[0]!.opacity = 0.5), "candidate-semantic");
    rejectResizeCode(
      (input) => (input.candidate.resources.paths[0]!.path = structuredClone(input.base.resources.paths[0]!.path)),
      "candidate-resource",
    );
    rejectResizeCode((input) => {
      input.candidate.resources.paths = structuredClone(input.base.resources.paths);
      for (const frame of input.candidate.frames) {
        for (const state of frame.states) {
          state.pathId = input.base.frames[0]!.states[0]!.pathId;
        }
      }
    }, "candidate-resource");
    rejectResizeCode((input) => {
      input.candidate.resources.paths.push({
        id: `path:${"c".repeat(64)}`,
        path: structuredClone(input.base.resources.paths[0]!.path),
      });
    }, "candidate-resource");
  });

  it("rejects appearance drift so a resize can never restyle its paint", () => {
    rejectResizeCode((input) => {
      const stroke = input.candidate.resources.appearances[0]!.stroke;
      if (!stroke) throw new Error("The generic fixture lost its stroke appearance.");
      stroke.widthWorld = Number((stroke.widthWorld * RESIZE_FACTOR).toFixed(13));
    }, "candidate-resource");
  });

  it("rejects an identity factor and a factor substituted independently of the source-derived result", () => {
    rejectResizeCode((input) => (input.expectedScaleFactor = 1), "candidate-noop");
    rejectResizeCode((input) => (input.expectedScaleFactor = 2), "candidate-endpoint");
    rejectResizeCode((input) => (input.expectedScaleFactor = -1.5), "candidate-endpoint");
  });

  it("conjugates off-center draw anchors about the preserved initial center", () => {
    // The producer anchors each drawn family member at its OWN localized-path
    // center, so a genuine scale about the root center must move an off-center
    // member's anchor from a to center + (a - center) * factor.
    const offCenter = (input: ResizeFixture, candidateAnchor: Readonly<{ x: number; y: number }>) => {
      const rootId = input.base.roots[0]!.id;
      const secondDraw = {
        familyPath: [1],
        id: `${rootId}/draw:1`,
        lifetimes: structuredClone(input.base.draws[0]!.lifetimes),
        rootId,
      };
      input.base.draws.push(structuredClone(secondDraw));
      input.candidate.draws.push(structuredClone(secondDraw));
      const baseState = input.base.frames[0]!.states[0]!;
      input.base.frames[0]!.states.push({
        ...structuredClone(baseState),
        drawId: secondDraw.id,
        paintOrder: 1,
        transform: { ...baseState.transform, tx: 1, ty: 0.25 },
      });
      const candidateState = input.candidate.frames[0]!.states[0]!;
      input.candidate.frames[0]!.states.push({
        ...structuredClone(candidateState),
        drawId: secondDraw.id,
        paintOrder: 1,
        transform: { ...candidateState.transform, tx: candidateAnchor.x, ty: candidateAnchor.y },
      });
    };

    const conjugated = resizeFixture();
    offCenter(conjugated, { x: 1.5, y: 0.375 });
    expect(verifyFastManimRuntimeTraceInitialResizeCandidateV3(conjugated)).toEqual(conjugated.candidate);

    rejectResizeCode((input) => offCenter(input, { x: 1, y: 0.25 }), "candidate-semantic");
    rejectResizeCode((input) => offCenter(input, { x: 2, y: 0.5 }), "candidate-semantic");
  });
});
