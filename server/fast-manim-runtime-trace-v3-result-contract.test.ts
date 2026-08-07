import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import {
  createFastManimRuntimeTraceProducerRequestV3,
  digestFastManimRuntimeTraceDomainV3,
  fastManimRuntimeTraceSourceBindingsFromAnalysisV3,
} from "./fast-manim-runtime-trace-v3-contract";
import { trustedFastManimRuntimeTraceProducerV3 } from "./fast-manim-runtime-trace-v3-profile";
import {
  digestFastManimRuntimeTraceSourceBindingsV3,
  type FastManimRuntimeTraceV3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_CHANNELS_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_KEYFRAMES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V3,
  parseFastManimRuntimeTraceProducerJsonV3,
} from "./fast-manim-runtime-trace-v3-result-contract";

const sourceText = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
const fixturePath = new URL("./test-fixtures/fast-manim-runtime-trace-v3-generic.json", import.meta.url);
const trusted = trustedFastManimRuntimeTraceProducerV3();

function request() {
  return createFastManimRuntimeTraceProducerRequestV3(
    {
      projectId: "generic-preview",
      requestId: "request-staticsquare-v3",
      sceneName: "StaticSquare",
      sourceHash,
      sourcePath: "scenes/staticsquare.py",
    },
    sourceText,
    { constructStartLine: 4, definitionOrdinal: 1 },
    { height: 8, width: 128 / 9 },
  );
}

function requestWithSourceBindingsFor(sourceTextValue: string) {
  const sourceHashValue = createHash("sha256").update(sourceTextValue, "utf8").digest("hex");
  const generic = createFastManimRuntimeTraceProducerRequestV3(
    {
      projectId: "generic-preview",
      requestId: "request-staticsquare-v3",
      sceneName: "StaticSquare",
      sourceHash: sourceHashValue,
      sourcePath: "scenes/staticsquare.py",
    },
    sourceTextValue,
    { constructStartLine: 4, definitionOrdinal: 1 },
    { height: 8, width: 128 / 9 },
  );
  const analysis = studioSourceAnalysisProviderV1.analyze({
    expectedSourceHash: sourceHashValue,
    sceneName: "StaticSquare",
    sourcePath: "scenes/staticsquare.py",
    sourceText: sourceTextValue,
  });
  return createFastManimRuntimeTraceProducerRequestV3(
    {
      projectId: "generic-preview",
      requestId: "request-staticsquare-v3",
      sceneName: "StaticSquare",
      sourceHash: sourceHashValue,
      sourcePath: "scenes/staticsquare.py",
    },
    sourceTextValue,
    { constructStartLine: 4, definitionOrdinal: 1 },
    { height: 8, width: 128 / 9 },
    fastManimRuntimeTraceSourceBindingsFromAnalysisV3(analysis, generic.sceneId),
  );
}

function requestWithSourceBindings() {
  return requestWithSourceBindingsFor(sourceText);
}

function sealSourceBindings(
  fixture: {
    producer: { correlationSha256: string };
    sourceBindings: FastManimRuntimeTraceV3["sourceBindings"];
  },
  producerRequest = requestWithSourceBindings(),
) {
  fixture.producer.correlationSha256 = digestFastManimRuntimeTraceSourceBindingsV3(
    producerRequest.sourceHash,
    producerRequest.sceneId,
    fixture.sourceBindings,
  );
}

function sealVisualSemantics(fixture: FastManimRuntimeTraceV3) {
  fixture.producer.semanticsSha256 = digestFastManimRuntimeTraceDomainV3(
    "poietra.fast-manim-runtime-trace-visual-semantics.v3",
    {
      camera: fixture.camera,
      compositing: fixture.compositing,
      coordinatePrecisionDigits: fixture.coordinatePrecisionDigits,
      draws: fixture.draws,
      frames: fixture.frames,
      resources: fixture.resources,
      roots: fixture.roots,
      sampleSchedule: fixture.sampleSchedule,
    },
  );
}

describe("generic Runtime Trace V3 producer result", () => {
  it("parses the byte-for-byte producer fixture with correlated preview-only authority", async () => {
    const bytes = await readFile(fixturePath);
    const trace = parseFastManimRuntimeTraceProducerJsonV3(bytes, requestWithSourceBindings(), trusted);
    expect(trace).toMatchObject({
      authority: "preview-only",
      profileVersion: 3,
      sceneName: "StaticSquare",
      sourceHash,
      sourceBindings: [{ binding: { name: "square", ordinal: 1 }, updaterStatus: "none" }],
      version: 3,
    });
    expect(trace.draws).toHaveLength(1);
    expect(trace.frames).toHaveLength(1);
    expect(trace.roots).toHaveLength(1);
    expect(MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V3).toBe(100_000);
    expect(MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3).toBe(8 * 1024 * 1024);
    expect({
      channels: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_CHANNELS_V3,
      entities: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V3,
      keyframes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_KEYFRAMES_V3,
      pathSegments: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V3,
    }).toEqual({ channels: 10_000, entities: 10_000, keyframes: 100_000, pathSegments: 100_000 });
  });

  it("accepts only ordered request-bound roots with lifetime endpoint evidence", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const producerRequest = requestWithSourceBindings();

    const trace = parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), producerRequest, trusted);
    expect(trace.sourceBindings[0]).toMatchObject({
      binding: { name: "square", ordinal: 1 },
      rootId: trace.roots[0]!.id,
      updaterStatus: "none",
    });
    expect(() => parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), request(), trusted)).toThrow(
      "stale or ambiguous",
    );

    const staleBinding = structuredClone(fixture);
    staleBinding.sourceBindings[0].binding.name = "forged";
    sealSourceBindings(staleBinding, producerRequest);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(staleBinding), producerRequest, trusted),
    ).toThrow("stale or ambiguous");

    const staleEndpoint = structuredClone(fixture);
    staleEndpoint.sourceBindings[0].endpoints.terminal.frameIndex = 1;
    staleEndpoint.sourceBindings[0].endpoints.terminal.sampleTime = Number((1 / 60).toFixed(13));
    sealSourceBindings(staleEndpoint, producerRequest);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(staleEndpoint), producerRequest, trusted),
    ).toThrow("lifetime boundary");

    const forgedCenter = structuredClone(fixture);
    forgedCenter.sourceBindings[0].endpoints.initial.center.x = 0.25;
    sealSourceBindings(forgedCenter, producerRequest);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(forgedCenter), producerRequest, trusted),
    ).toThrow("endpoint-frame geometry");

    const forgedDimensions = structuredClone(fixture);
    forgedDimensions.sourceBindings[0].endpoints.terminal.dimensions.width = 3;
    sealSourceBindings(forgedDimensions, producerRequest);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(forgedDimensions), producerRequest, trusted),
    ).toThrow("endpoint-frame geometry");

    const staleDigest = structuredClone(fixture);
    staleDigest.producer.correlationSha256 = "f".repeat(64);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(staleDigest), producerRequest, trusted),
    ).toThrow("correlation digest");
  });

  it("accepts the producer all-point center for a non-VMobject root without weakening direct VMobject roots", async () => {
    const groupSourceText = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        curve = Group(CubicBezier([0, 0, 0], [0, 2, 0], [1, 2, 0], [1, 0, 0]))
        self.add(curve)
        self.wait(1 / 60)
`;
    const producerRequest = requestWithSourceBindingsFor(groupSourceText);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as FastManimRuntimeTraceV3;
    const path = {
      subpaths: [
        {
          closed: false,
          segments: [
            {
              control1: { x: -0.5, y: 1 },
              control2: { x: 0.5, y: 1 },
              end: { x: 0.5, y: -1 },
            },
          ],
          start: { x: -0.5, y: -1 },
        },
      ],
    };
    const pathId = `path:${digestFastManimRuntimeTraceDomainV3("poietra.runtime-trace-v3-path", path)}`;
    fixture.sourceHash = producerRequest.sourceHash;
    fixture.draws[0]!.familyPath = [0];
    fixture.resources.paths = [{ id: pathId, path }];
    fixture.frames[0]!.states[0]!.pathId = pathId;
    fixture.frames[0]!.states[0]!.transform.tx = 0.5;
    fixture.frames[0]!.states[0]!.transform.ty = 1;
    fixture.sourceBindings = [
      {
        binding: producerRequest.sourceBindings[0]!,
        endpoints: {
          initial: {
            center: { x: 0.5, y: 1 },
            dimensions: { height: 2, width: 1 },
            frameIndex: 0,
            sampleTime: 0,
          },
          terminal: {
            center: { x: 0.5, y: 1 },
            dimensions: { height: 2, width: 1 },
            frameIndex: 0,
            sampleTime: 0,
          },
        },
        rootId: fixture.roots[0]!.id,
        updaterStatus: "none",
      },
    ];
    sealVisualSemantics(fixture);
    sealSourceBindings(fixture, producerRequest);

    expect(
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), producerRequest, trusted).sourceBindings[0]
        ?.endpoints.initial.center,
    ).toEqual({ x: 0.5, y: 1 });

    const forgedDirectRoot = structuredClone(fixture);
    forgedDirectRoot.draws[0]!.familyPath = [];
    sealVisualSemantics(forgedDirectRoot);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(forgedDirectRoot), producerRequest, trusted),
    ).toThrow("endpoint-frame geometry");
  });

  it("rejects stale source, untrusted producer, and state/lifetime drift", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(
        JSON.stringify(fixture),
        { ...requestWithSourceBindings(), sourceHash: "f".repeat(64) },
        trusted,
      ),
    ).toThrow();
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), requestWithSourceBindings(), {
        ...trusted,
        fastManimCommit: "2".repeat(40),
      }),
    ).toThrow("not trusted");
    fixture.draws[0].lifetimes[0].endFrame = 2;
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), requestWithSourceBindings(), trusted),
    ).toThrow();
  });

  it("rejects non-canonical path coordinates", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.resources.paths[0].path.subpaths[0].start.x += 1e-14;

    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), requestWithSourceBindings(), trusted),
    ).toThrow("path coordinates must use the canonical 13-digit precision");
  });
});
