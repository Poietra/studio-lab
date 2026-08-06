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

const candidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
  "            run_time=5,\n        )\n        self.wait()\n",
  "            run_time=5,\n        )\n        square.move_to((1.25, 1.5, 0))\n        self.wait()\n",
);

function candidateFixture(
  mutateTerminal: (trace: ReturnType<typeof runtimeTraceFixture>) => void = (trace) => {
    for (let frameIndex = 300; frameIndex < trace.frames.length; frameIndex += 1) {
      trace.frames[frameIndex].motionY = 1.5;
      trace.frames[frameIndex].draws[0].localPosition.x = 1.25;
    }
  },
) {
  const trace = structuredClone(runtimeTraceFixture());
  const request = runtimeTraceRequestFixture(candidateSource);
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
  it("accepts an exact protected prefix and a real Square edit on the terminal hold", () => {
    const { request, trace } = candidateFixture();
    expect(verify(trace, request)).toEqual(trace);
    expect(trace.frames.slice(0, 300)).toEqual(runtimeTraceFixture().frames.slice(0, 300));
  });

  it("rejects any change during the protected updater animation", () => {
    const { trace } = candidateFixture();
    trace.frames[299].motionY = canonicalFastManimRuntimeTraceCoordinateV1(trace.frames[299].motionY + 0.125);
    sealRuntimeTraceFixture(trace);
    expect(() => verify(trace)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-prefix" }),
    );
  });

  it("rejects a different producer, shifted source binding, or stale request", () => {
    const producerChanged = candidateFixture().trace;
    producerChanged.producer.fastManimTree = "e".repeat(40);
    sealRuntimeTraceFixture(producerChanged);
    expect(() => verify(producerChanged)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-producer" }),
    );

    const rootChanged = candidateFixture().trace;
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

    const stale = candidateFixture().trace;
    expect(() => verify(stale, runtimeTraceRequestFixture(`${candidateSource}\n`))).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-correlation" }),
    );
  });

  it("rejects unused producer payload, a no-op, and a dependent-only change", () => {
    const unused = candidateFixture().trace;
    const extraPath = structuredClone(unused.resources.paths[0].path);
    extraPath.subpaths[0].start.x = 0.25;
    unused.resources.paths.push({ id: `path:${digestFastManimRuntimeTracePathV1(extraPath)}`, path: extraPath });
    sealRuntimeTraceFixture(unused);
    expect(() => verify(unused)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-resource" }),
    );

    const noOp = candidateFixture(() => {}).trace;
    expect(() => verify(noOp)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-noop" }),
    );

    const dependentOnly = candidateFixture((trace) => {
      for (let frameIndex = 300; frameIndex < trace.frames.length; frameIndex += 1) {
        trace.frames[frameIndex].draws[1].localPosition.x = 0.125;
      }
    }).trace;
    expect(() => verify(dependentOnly)).toThrowError(
      expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV1>>({ code: "candidate-noop" }),
    );
  });
});
