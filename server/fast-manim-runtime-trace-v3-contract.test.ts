import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createFastManimRuntimeTraceConfigV3,
  createFastManimRuntimeTraceProducerRequestV3,
  digestFastManimRuntimeTraceConfigV3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  fastManimRuntimeTraceProducerRequestV3Schema,
} from "./fast-manim-runtime-trace-v3-contract";

const frame = { height: 8, width: 128 / 9 } as const;
const sourceText = [
  "from manim import *",
  "",
  "class DynamicDemo(Scene):",
  "    def construct(self):",
  "        self.add(Square())",
  "",
].join("\n");
const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");

function run(sceneName = "DynamicDemo") {
  return {
    projectId: "demo",
    requestId: `trace-${sceneName.toLowerCase()}`,
    sceneName,
    sourceHash,
    sourcePath: "scenes/demo.py",
  };
}

describe("generic Runtime Trace V3 request contract", () => {
  it("matches the producer's canonical config digest", () => {
    const config = createFastManimRuntimeTraceConfigV3(frame);
    expect(config.maxFrameCount).toBe(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3);
    expect(digestFastManimRuntimeTraceConfigV3(config)).toBe(
      "746f68cc656a3045643730e4fab8a94d35351c04354d83d5a2ca88808fcef720",
    );
  });

  it("builds requests without a Scene-name or source-hash allowlist", () => {
    const request = createFastManimRuntimeTraceProducerRequestV3(
      run(),
      sourceText,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(request).toMatchObject({
      profileVersion: 3,
      sceneName: "DynamicDemo",
      sourceHash,
      version: 3,
    });

    const secondSource = sourceText.replace("DynamicDemo", "AnotherDemo");
    const second = createFastManimRuntimeTraceProducerRequestV3(
      {
        ...run("AnotherDemo"),
        sourceHash: createHash("sha256").update(secondSource, "utf8").digest("hex"),
      },
      secondSource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(second.sceneName).toBe("AnotherDemo");
    expect(second.sceneId).not.toBe(request.sceneId);
  });

  it("rejects stale source identity, non-canonical cameras, and invalid Unicode", () => {
    const request = createFastManimRuntimeTraceProducerRequestV3(
      run(),
      sourceText,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(
      fastManimRuntimeTraceProducerRequestV3Schema.safeParse({ ...request, sourceHash: "0".repeat(64) }).success,
    ).toBe(false);
    expect(() => createFastManimRuntimeTraceConfigV3({ height: 8, width: 16 })).toThrow();
    expect(fastManimRuntimeTraceProducerRequestV3Schema.safeParse({ ...request, sourceText: "\ud800" }).success).toBe(
      false,
    );
  });
});
