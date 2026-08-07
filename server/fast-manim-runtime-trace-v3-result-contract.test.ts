import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createFastManimRuntimeTraceProducerRequestV3 } from "./fast-manim-runtime-trace-v3-contract";
import {
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
const trusted = {
  fastManimCommit: "0".repeat(40),
  fastManimTree: "1".repeat(40),
  manimVersion: "0.20.1",
} as const;

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

describe("generic Runtime Trace V3 producer result", () => {
  it("parses the byte-for-byte producer fixture with correlated preview-only authority", async () => {
    const bytes = await readFile(fixturePath);
    const trace = parseFastManimRuntimeTraceProducerJsonV3(bytes, request(), trusted);
    expect(trace).toMatchObject({
      authority: "preview-only",
      profileVersion: 3,
      sceneName: "StaticSquare",
      sourceHash,
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

  it("rejects stale source, untrusted producer, and state/lifetime drift", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(
        JSON.stringify(fixture),
        { ...request(), sourceHash: "f".repeat(64) },
        trusted,
      ),
    ).toThrow();
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), request(), {
        ...trusted,
        fastManimCommit: "2".repeat(40),
      }),
    ).toThrow("not trusted");
    fixture.draws[0].lifetimes[0].endFrame = 2;
    expect(() => parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), request(), trusted)).toThrow();
  });

  it("rejects non-canonical path coordinates", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.resources.paths[0].path.subpaths[0].start.x += 1e-14;

    expect(() => parseFastManimRuntimeTraceProducerJsonV3(JSON.stringify(fixture), request(), trusted)).toThrow(
      "path coordinates must use the canonical 13-digit precision",
    );
  });
});
