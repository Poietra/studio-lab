import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import { fastManimSourceBindingIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import {
  type FastManimRuntimeTraceInitialEditCandidateErrorV3,
  verifyFastManimRuntimeTraceInitialMoveCandidateV3,
  verifyFastManimRuntimeTraceInitialResizeCandidateV3,
  verifyFastManimRuntimeTraceInitialRotationCandidateV3,
} from "./fast-manim-runtime-trace-v3-candidate";
import {
  createFastManimRuntimeTraceProducerRequestV3,
  fastManimRuntimeTraceSourceBindingsFromAnalysisV3,
} from "./fast-manim-runtime-trace-v3-contract";
import { fastManimRuntimeTraceV3Schema } from "./fast-manim-runtime-trace-v3-result-contract";
import genericRuntimeTraceFixture from "./test-fixtures/fast-manim-runtime-trace-v3-generic.json";

type TraceDocument = ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>;

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
    expectedWorldCenter: TARGET,
  };
}

function withSiblingRoot(input: Readonly<{ base: TraceDocument; candidate: TraceDocument }>) {
  // Extend both traces with one Feynman-shaped sibling: a second top-level
  // root carrying its own updater-free source mapping, byte-identical on both
  // sides so only the selected binding may move or scale.
  const { base, candidate } = input;
  const baseRoot = base.roots[0]!;
  const rootId = `${baseRoot.id.slice(0, -1)}1`;
  const siblingMapping = structuredClone(base.sourceBindings[0]!);
  siblingMapping.binding.id = `source-binding:${"a".repeat(64)}`;
  siblingMapping.binding.name = "circle";
  siblingMapping.binding.ordinal = 2;
  siblingMapping.rootId = rootId;
  siblingMapping.endpoints.initial.center.x += 3;
  siblingMapping.endpoints.terminal.center.x += 3;
  for (const trace of [base, candidate]) {
    trace.roots.push({ id: rootId, lifetimes: structuredClone(baseRoot.lifetimes), sceneOrder: 1 });
    trace.draws.push({
      familyPath: [],
      id: `${rootId}/draw:0`,
      lifetimes: structuredClone(baseRoot.lifetimes),
      rootId,
    });
    trace.sourceBindings.push(structuredClone(siblingMapping));
  }
  // Inserting the edit statement legitimately shifts sibling spans and their
  // sourceHash-derived ids on the candidate side; sibling invariance must
  // still hold across exactly that divergence.
  const candidateSibling = candidate.sourceBindings.at(-1)!;
  candidateSibling.binding.id = `source-binding:${"b".repeat(64)}`;
  candidateSibling.binding.span.endLine += 1;
  candidateSibling.binding.span.startLine += 1;
  base.frames.forEach((baseFrame, frameIndex) => {
    const siblingState = {
      ...structuredClone(baseFrame.states[0]!),
      drawId: `${rootId}/draw:0`,
      paintOrder: baseFrame.states.length,
    };
    siblingState.transform.tx += 3;
    baseFrame.states.push(structuredClone(siblingState));
    candidate.frames[frameIndex]!.states.push(structuredClone(siblingState));
  });
  return rootId;
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
      input.expectedWorldCenter = { x: 0, y: 0 };
    }, "candidate-noop");
    rejectCode((input) => (input.expectedWorldCenter = { x: TARGET.x + 0.25, y: TARGET.y }), "candidate-endpoint");
  });

  it("anchors the move target on the settled endpoint when an entrance animation offsets frame zero", () => {
    // Feynman-shaped evidence: the frame-zero box of a Write()-revealed group
    // sits offset from the constructed placement that move_to positions, so
    // the settled (terminal) endpoint is what must land on the target.
    const entrance = fixture();
    entrance.base.sourceBindings[0]!.endpoints.initial.center = { x: -0.5, y: 0.25 };
    entrance.candidate.sourceBindings[0]!.endpoints.initial.center = { x: -0.5 + TARGET.x, y: 0.25 + TARGET.y };

    expect(verifyFastManimRuntimeTraceInitialMoveCandidateV3(entrance)).toEqual(entrance.candidate);

    // The old initial-center anchoring is a wrong accept here: a candidate
    // landing its transient frame-zero center on the target while the settled
    // placement misses it must reject.
    rejectCode((input) => {
      input.base.sourceBindings[0]!.endpoints.initial.center = { x: -0.5, y: 0.25 };
      input.candidate.sourceBindings[0]!.endpoints.initial.center = { x: TARGET.x, y: TARGET.y };
      input.candidate.sourceBindings[0]!.endpoints.terminal.center = { x: TARGET.x + 0.5, y: TARGET.y - 0.25 };
    }, "candidate-endpoint");
  });

  it("multi-root: accepts a selected-only translation beside an untouched sibling root and mapping", () => {
    const input = fixture();
    withSiblingRoot(input);

    expect(verifyFastManimRuntimeTraceInitialMoveCandidateV3(input)).toEqual(input.candidate);
    expect(input.candidate.roots).toHaveLength(2);
    expect(input.candidate.sourceBindings).toHaveLength(2);
  });

  it("multi-root: rejects a move that disturbs a sibling mapping, sibling state, or the root selection", () => {
    rejectCode((input) => {
      withSiblingRoot(input);
      input.candidate.sourceBindings[1]!.endpoints.initial.center.x += 0.1;
    }, "candidate-binding");
    rejectCode((input) => {
      withSiblingRoot(input);
      input.candidate.frames[0]!.states[1]!.transform.tx += 0.1;
    }, "candidate-semantic");
    rejectCode((input) => {
      withSiblingRoot(input);
      input.candidate.roots[1]!.lifetimes[0]!.endFrame += 1;
    }, "candidate-root");
    rejectCode((input) => {
      const rootId = withSiblingRoot(input);
      input.candidate.sourceBindings[0]!.rootId = rootId;
    }, "candidate-root");
  });

  it("multi-root: rejects an ambiguous selected-name mapping on either side", () => {
    rejectCode((input) => {
      withSiblingRoot(input);
      input.base.sourceBindings.push(structuredClone(input.base.sourceBindings[0]!));
    }, "base-binding");
    rejectCode((input) => {
      withSiblingRoot(input);
      input.candidate.sourceBindings.push(structuredClone(input.candidate.sourceBindings[0]!));
    }, "candidate-binding");
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

  it("conjugates an entrance-offset frame-zero endpoint about the settled pivot", () => {
    // scale() acts about the constructed center that the settled endpoint
    // observes; the transient frame-zero box must conjugate about that pivot
    // rather than keep its own center.
    const entrance = resizeFixture();
    entrance.base.sourceBindings[0]!.endpoints.initial.center = { x: -0.5, y: 0.25 };
    entrance.candidate.sourceBindings[0]!.endpoints.initial.center = { x: -0.75, y: 0.375 };

    expect(verifyFastManimRuntimeTraceInitialResizeCandidateV3(entrance)).toEqual(entrance.candidate);

    // A candidate preserving the transient frame-zero center (the old
    // initial-center anchoring) is a wrong accept and must reject.
    rejectResizeCode((input) => {
      input.base.sourceBindings[0]!.endpoints.initial.center = { x: -0.5, y: 0.25 };
      input.candidate.sourceBindings[0]!.endpoints.initial.center = { x: -0.5, y: 0.25 };
    }, "candidate-endpoint");
  });

  it("multi-root: accepts a selected-only resize that retains the sibling's original path bytes", () => {
    const input = resizeFixture();
    withSiblingRoot(input);
    input.candidate.resources.paths.push(structuredClone(input.base.resources.paths[0]!));

    expect(verifyFastManimRuntimeTraceInitialResizeCandidateV3(input)).toEqual(input.candidate);
    expect(input.candidate.resources.paths.map(({ id }) => id).sort()).toEqual(
      [input.base.resources.paths[0]!.id, SCALED_PATH_ID].sort(),
    );
  });

  it("multi-root: rejects a resize that rescales the sibling's usage or loses or mutates its retained path", () => {
    rejectResizeCode((input) => {
      withSiblingRoot(input);
      input.candidate.resources.paths.push(structuredClone(input.base.resources.paths[0]!));
      for (const frame of input.candidate.frames) {
        for (const state of frame.states) state.pathId = SCALED_PATH_ID;
      }
    }, "candidate-semantic");
    rejectResizeCode((input) => {
      withSiblingRoot(input);
      const retained = structuredClone(input.base.resources.paths[0]!);
      retained.path.subpaths[0]!.start.x += 0.1;
      input.candidate.resources.paths.push(retained);
    }, "candidate-resource");
    rejectResizeCode((input) => {
      withSiblingRoot(input);
    }, "candidate-resource");
  });

  it("conjugates off-center draw anchors about the preserved settled center", () => {
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

const ROTATION_ANGLE_RADIANS = 0.523598775598;
const ROTATION_CANDIDATE_SOURCE = BASE_SOURCE.replace(
  "        square.set_stroke(WHITE, width=2)\n",
  `        square.rotate(${ROTATION_ANGLE_RADIANS})\n        square.set_stroke(WHITE, width=2)\n`,
);
const ROTATED_PATH_ID = `path:${"d".repeat(64)}`;

function rotatedPathValue(
  path: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>["resources"]["paths"][number]["path"],
  angleRadians: number,
) {
  const cosine = Math.cos(angleRadians);
  const sine = Math.sin(angleRadians);
  const rotate = ({ x, y }: Readonly<{ x: number; y: number }>) => ({
    x: Number((cosine * x - sine * y).toFixed(13)),
    y: Number((sine * x + cosine * y).toFixed(13)),
  });
  return {
    subpaths: path.subpaths.map((subpath) => ({
      closed: subpath.closed,
      segments: subpath.segments.map((segment) => ({
        control1: rotate(segment.control1),
        control2: rotate(segment.control2),
        end: rotate(segment.end),
      })),
      start: rotate(subpath.start),
    })),
  };
}

function rotationFixture() {
  const baseRequest = request(BASE_SOURCE);
  const candidateRequest = request(ROTATION_CANDIDATE_SOURCE);
  const base = fastManimRuntimeTraceV3Schema.parse(structuredClone(genericRuntimeTraceFixture));
  const candidate = structuredClone(base);
  candidate.sourceHash = candidateRequest.sourceHash;
  candidate.sourceBindings[0]!.binding = structuredClone(candidateRequest.sourceBindings[0]!);
  const rotatedExtent = Number(
    (2 * (Math.abs(Math.cos(ROTATION_ANGLE_RADIANS)) + Math.abs(Math.sin(ROTATION_ANGLE_RADIANS)))).toFixed(13),
  );
  for (const endpoint of Object.values(candidate.sourceBindings[0]!.endpoints)) {
    endpoint.dimensions = { height: rotatedExtent, width: rotatedExtent };
  }
  candidate.resources.paths = base.resources.paths.map((resource) => ({
    id: ROTATED_PATH_ID,
    path: rotatedPathValue(resource.path, ROTATION_ANGLE_RADIANS),
  }));
  for (const frame of candidate.frames) {
    for (const state of frame.states) state.pathId = ROTATED_PATH_ID;
  }
  return {
    base,
    baseRequest,
    binding: structuredClone(baseRequest.sourceBindings[0]!),
    candidate,
    candidateRequest,
    expectedAngleRadians: ROTATION_ANGLE_RADIANS,
  };
}

function asymmetricRotationFixture() {
  const input = rotationFixture();
  const canonical = (value: number) => Number(value.toFixed(13));
  const line = (from: Readonly<{ x: number; y: number }>, to: Readonly<{ x: number; y: number }>) => ({
    control1: { x: canonical(from.x + (to.x - from.x) / 3), y: canonical(from.y + (to.y - from.y) / 3) },
    control2: {
      x: canonical(from.x + (2 * (to.x - from.x)) / 3),
      y: canonical(from.y + (2 * (to.y - from.y)) / 3),
    },
    end: { ...to },
  });
  const top = { x: 0, y: 1 } as const;
  const left = { x: -1, y: -1 } as const;
  const right = { x: 1, y: -1 } as const;
  const trianglePath = {
    subpaths: [
      {
        closed: true,
        segments: [line(top, left), line(left, right), line(right, top)],
        start: { ...top },
      },
    ],
  };
  input.base.resources.paths[0]!.path = trianglePath;
  input.candidate.resources.paths[0]!.path = rotatedPathValue(trianglePath, ROTATION_ANGLE_RADIANS);
  const candidatePoints = input.candidate.resources.paths[0]!.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
  ]);
  const xs = candidatePoints.map(({ x }) => x);
  const ys = candidatePoints.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const center = {
    x: Number(((minX + maxX) / 2).toFixed(13)),
    y: Number(((minY + maxY) / 2).toFixed(13)),
  };
  for (const point of candidatePoints) {
    point.x = Number((point.x - center.x).toFixed(13));
    point.y = Number((point.y - center.y).toFixed(13));
  }
  for (const frame of input.candidate.frames) {
    for (const state of frame.states) {
      state.transform.tx = center.x;
      state.transform.ty = center.y;
    }
  }
  for (const endpoint of Object.values(input.base.sourceBindings[0]!.endpoints)) {
    endpoint.center = { x: 0, y: 0 };
    endpoint.dimensions = { height: 2, width: 2 };
  }
  for (const endpoint of Object.values(input.candidate.sourceBindings[0]!.endpoints)) {
    endpoint.center = center;
    endpoint.dimensions = {
      height: Number((maxY - minY).toFixed(13)),
      width: Number((maxX - minX).toFixed(13)),
    };
  }
  return input;
}

type RotationFixture = ReturnType<typeof rotationFixture>;

function rejectRotationCode(
  mutate: (input: RotationFixture) => void,
  code: FastManimRuntimeTraceInitialEditCandidateErrorV3["code"],
) {
  const input = rotationFixture();
  mutate(input);
  expect(() => verifyFastManimRuntimeTraceInitialRotationCandidateV3(input)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe("verifyFastManimRuntimeTraceInitialRotationCandidateV3", () => {
  it("accepts one exact center-preserving path rotation", () => {
    const input = rotationFixture();

    expect(verifyFastManimRuntimeTraceInitialRotationCandidateV3(input)).toEqual(input.candidate);
    expect(input.base.resources.paths).not.toEqual(input.candidate.resources.paths);
    expect(input.base.resources.appearances).toEqual(input.candidate.resources.appearances);
  });

  it("accepts an asymmetric path when rotation changes its localized AABB anchor", () => {
    const input = asymmetricRotationFixture();

    expect(input.candidate.sourceBindings[0]!.endpoints.initial.center).not.toEqual({ x: 0, y: 0 });
    expect(verifyFastManimRuntimeTraceInitialRotationCandidateV3(input)).toEqual(input.candidate);
  });

  it("rejects a selected path or draw anchor that does not match the requested rotation", () => {
    rejectRotationCode((input) => {
      const start = input.candidate.resources.paths[0]!.path.subpaths[0]!.start;
      start.x = Number((start.x + 0.1).toFixed(13));
    }, "candidate-semantic");
    rejectRotationCode((input) => {
      input.candidate.frames[0]!.states[0]!.transform.tx += 0.1;
    }, "candidate-semantic");
  });

  it("accepts an untouched sibling and rejects any sibling state change", () => {
    const input = rotationFixture();
    withSiblingRoot(input);
    input.candidate.resources.paths.push(structuredClone(input.base.resources.paths[0]!));

    expect(verifyFastManimRuntimeTraceInitialRotationCandidateV3(input)).toEqual(input.candidate);

    rejectRotationCode((changed) => {
      withSiblingRoot(changed);
      changed.candidate.resources.paths.push(structuredClone(changed.base.resources.paths[0]!));
      changed.candidate.frames[0]!.states[1]!.transform.tx += 0.1;
    }, "candidate-semantic");
  });

  it("rejects zero and full-turn angles as no-ops", () => {
    rejectRotationCode((input) => (input.expectedAngleRadians = 0), "candidate-noop");
    rejectRotationCode((input) => (input.expectedAngleRadians = 6.2831853071796), "candidate-noop");
  });
});
