import { describe, expect, it } from "vitest";
import {
  type FastManimRuntimeTraceCandidateErrorV1,
  verifyFastManimRuntimeTraceTerminalCandidateV1,
} from "./fast-manim-runtime-trace-candidate";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTracePathV1,
} from "./fast-manim-runtime-trace-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import {
  RUNTIME_TRACE_SOURCE_TEXT,
  runtimeTraceFixture,
  runtimeTraceRequestFixture,
  sealRuntimeTraceFixture,
  trustedRuntimeTraceProducer,
} from "./test-fixtures/fast-manim-runtime-trace-fixture";

const terminalBoundary = "            run_time=5,\n        )\n        self.wait()\n";
const dependentUpdaterRefresh = "decimal.update(0)";

function editedSource(...statements: string[]) {
  return RUNTIME_TRACE_SOURCE_TEXT.replace(
    terminalBoundary,
    `            run_time=5,\n        )\n${[...statements, dependentUpdaterRefresh]
      .map((statement) => `        ${statement}\n`)
      .join("")}        self.wait()\n`,
  );
}

const candidateSource = editedSource("square.move_to((1.25, 2.5, 0))");

type TerminalEdit = Readonly<{
  moveTo: Readonly<{ x: number; y: number }> | null;
  scale: number | null;
  source: string;
}>;

const moveEdit = { moveTo: { x: 1.25, y: 2.5 }, scale: null, source: candidateSource } as const;
const scaleEdit = { moveTo: null, scale: 0.5, source: editedSource("square.scale(0.5)") } as const;
const combinedEdit = {
  moveTo: { x: 1.25, y: 2.5 },
  scale: 0.5,
  source: editedSource("square.move_to((1.25, 2.5, 0))", "square.scale(0.5)"),
} as const;

function scaleSquarePath(trace: ReturnType<typeof runtimeTraceFixture>, factor: number) {
  const official = trace.resources.paths[0];
  if (!official) throw new Error("Expected the fixture Square path.");
  const path = structuredClone(official.path);
  for (const subpath of path.subpaths) {
    for (const point of [
      subpath.start,
      ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
    ]) {
      point.x = canonicalFastManimRuntimeTraceCoordinateV1(point.x * factor);
      point.y = canonicalFastManimRuntimeTraceCoordinateV1(point.y * factor);
    }
  }
  const id = `path:${digestFastManimRuntimeTracePathV1(path)}`;
  if (!trace.resources.paths.some((resource) => resource.id === id)) trace.resources.paths.push({ id, path });
  return id;
}

function applyTerminalEdit(trace: ReturnType<typeof runtimeTraceFixture>, edit: TerminalEdit) {
  const scale = edit.scale ?? 1;
  const squareX = edit.moveTo?.x ?? 0;
  const squareY = edit.moveTo?.y ?? 2.5;
  const decimalShift = squareX + scale - 1;
  const squarePathId = edit.scale === null ? trace.resources.paths[0]!.id : scaleSquarePath(trace, scale);
  for (let frameIndex = 300; frameIndex < trace.frames.length; frameIndex += 1) {
    const frame = trace.frames[frameIndex];
    frame.motionY = squareY;
    frame.draws[0].localPosition.x = squareX;
    frame.draws[0].pathId = squarePathId;
    for (const draw of frame.draws.slice(1)) {
      draw.localPosition.x = canonicalFastManimRuntimeTraceCoordinateV1(draw.localPosition.x + decimalShift);
    }
  }
}

function candidateFixture(
  edit: TerminalEdit = moveEdit,
  mutateTerminal: (trace: ReturnType<typeof runtimeTraceFixture>) => void = (trace) => applyTerminalEdit(trace, edit),
) {
  const trace = structuredClone(runtimeTraceFixture());
  const request = runtimeTraceRequestFixture(edit.source);
  trace.sourceHash = request.sourceHash;
  trace.roots.forEach((root) => {
    root.binding.id = fastManimSourceBindingIdentifierV1(trace.sourceHash, trace.sceneId, root.binding);
  });
  mutateTerminal(trace);
  return { request, trace: sealRuntimeTraceFixture(trace) };
}

function verify(trace: ReturnType<typeof runtimeTraceFixture>, request = runtimeTraceRequestFixture(candidateSource)) {
  const base = runtimeTraceFixture();
  return verifyFastManimRuntimeTraceTerminalCandidateV1({
    base,
    candidate: trace,
    candidateRequest: request,
    trusted: trustedRuntimeTraceProducer(base),
  });
}

describe("fast-manim Runtime Trace V1 terminal candidate", () => {
  it.each([
    ["move-only", moveEdit],
    ["scale-only", scaleEdit],
    ["move then scale", combinedEdit],
  ] as const)("accepts an exact protected prefix and source-matched %s terminal edit", (_label, edit) => {
    const { request, trace } = candidateFixture(edit);
    expect(verify(trace, request)).toEqual(trace);
    expect(trace.frames.slice(0, 300)).toEqual(runtimeTraceFixture().frames.slice(0, 300));
  });

  it("rejects any change during the protected updater animation", () => {
    const { trace } = candidateFixture(moveEdit);
    trace.frames[299].motionY = canonicalFastManimRuntimeTraceCoordinateV1(trace.frames[299].motionY + 0.125);
    sealRuntimeTraceFixture(trace);
    expect(() => verify(trace)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-prefix" }),
    );
  });

  it("rejects a different producer, shifted source binding, or stale request", () => {
    const producerChanged = candidateFixture(moveEdit).trace;
    producerChanged.producer.fastManimTree = "e".repeat(40);
    sealRuntimeTraceFixture(producerChanged);
    expect(() => verify(producerChanged)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-producer" }),
    );

    const rootChanged = candidateFixture(moveEdit).trace;
    rootChanged.roots[0].binding.span.startColumn += 1;
    rootChanged.roots[0].binding.id = fastManimSourceBindingIdentifierV1(
      rootChanged.sourceHash,
      rootChanged.sceneId,
      rootChanged.roots[0].binding,
    );
    sealRuntimeTraceFixture(rootChanged);
    expect(() => verify(rootChanged)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-root" }),
    );

    const stale = candidateFixture(moveEdit).trace;
    expect(() => verify(stale, runtimeTraceRequestFixture(`${candidateSource}\n`))).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-correlation" }),
    );
  });

  it("rejects unused producer payload, a no-op, and a dependent-only change", () => {
    const unused = candidateFixture(moveEdit).trace;
    const extraPath = structuredClone(unused.resources.paths[0].path);
    extraPath.subpaths[0].start.x = 0.25;
    unused.resources.paths.push({ id: `path:${digestFastManimRuntimeTracePathV1(extraPath)}`, path: extraPath });
    sealRuntimeTraceFixture(unused);
    expect(() => verify(unused)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-resource" }),
    );

    const noOpEdit = {
      moveTo: { x: 0, y: 2.5 },
      scale: null,
      source: editedSource("square.move_to((0, 2.5, 0))"),
    } as const;
    const noOp = candidateFixture(noOpEdit).trace;
    expect(() => verify(noOp, runtimeTraceRequestFixture(noOpEdit.source))).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-noop" }),
    );

    const dependentOnly = candidateFixture(moveEdit, (trace) => {
      for (let frameIndex = 300; frameIndex < trace.frames.length; frameIndex += 1) {
        trace.frames[frameIndex].draws[1].localPosition.x = 0.125;
      }
    }).trace;
    expect(() => verify(dependentOnly)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-semantic" }),
    );
  });

  it("rejects a source-matched trace when the dependent-updater refresh sentinel is absent", () => {
    const editWithoutRefresh = {
      ...moveEdit,
      source: candidateSource.replace("        decimal.update(0)\n", ""),
    };
    const { request, trace } = candidateFixture(editWithoutRefresh);
    expect(() => verify(trace, request)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-source" }),
    );
  });

  it("rejects Square motion, position, path, or paint that disagrees with the source plan", () => {
    const mutations = [
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.motionY = 2.25;
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[0].localPosition.x = 1;
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[0].pathId = frame.draws[1].pathId;
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[0].opacity = 0.5;
        });
      },
    ];
    for (const mutate of mutations) {
      const { request, trace } = candidateFixture(moveEdit, (candidate) => {
        applyTerminalEdit(candidate, moveEdit);
        mutate(candidate);
      });
      sealRuntimeTraceFixture(trace);
      expect(() => verify(trace, request)).toThrowError(
        expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-semantic" }),
      );
    }
  });

  it("rejects a forged DecimalNumber glyph or updater placement", () => {
    const mutations = [
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[2].pathId = frame.draws[0].pathId;
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[1].localPosition.x += 0.125;
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames.slice(300).forEach((frame) => {
          frame.draws[1].localPosition.y = 0.125;
        });
      },
    ];
    for (const mutate of mutations) {
      const { request, trace } = candidateFixture(moveEdit, (candidate) => {
        applyTerminalEdit(candidate, moveEdit);
        mutate(candidate);
      });
      sealRuntimeTraceFixture(trace);
      expect(() => verify(trace, request)).toThrowError(
        expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-semantic" }),
      );
    }
  });
});
