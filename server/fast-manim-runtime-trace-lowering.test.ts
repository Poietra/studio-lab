import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { verifyFastManimRuntimeTraceTerminalCandidateV1 } from "./fast-manim-runtime-trace-candidate";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceAppearanceV1,
  digestFastManimRuntimeTracePathV1,
  type TrustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-contract";
import {
  lowerFastManimRuntimeTraceProducerJsonV1,
  lowerVerifiedFastManimRuntimeTraceTerminalCandidateV1,
} from "./fast-manim-runtime-trace-lowering";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import {
  RUNTIME_TRACE_CONFIG_HASH,
  RUNTIME_TRACE_SOURCE_TEXT,
  runtimeTraceFixture,
  runtimeTraceRequestFixture,
  sealRuntimeTraceFixture,
  trustedRuntimeTraceProducer,
} from "./test-fixtures/fast-manim-runtime-trace-fixture";

async function lower(trace = runtimeTraceFixture(), trusted?: TrustedFastManimRuntimeTraceProducerV1) {
  const sealed = sealRuntimeTraceFixture(trace);
  return lowerFastManimRuntimeTraceProducerJsonV1(
    canonicalJsonV1(sealed),
    runtimeTraceRequestFixture(),
    trusted ?? trustedRuntimeTraceProducer(sealed),
  );
}

async function frameAt(bundle: Awaited<ReturnType<typeof lower>>, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets: bundle.assets,
    packetId: `runtime-trace-${sampleTime}`,
    sampleTime,
    scene: bundle.scene,
    viewport: { heightPx: 720, widthPx: 1_280 },
  });
  if (result.kind !== "ready") throw new Error(result.message);
  return result.frame;
}

const terminalCandidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
  "            run_time=5,\n        )\n        self.wait()\n",
  "            run_time=5,\n        )\n        square.move_to((1.25, 2.5, 0))\n        square.scale(0.5)\n        decimal.update(0)\n        self.wait()\n",
);

function terminalCandidateFixture() {
  const base = runtimeTraceFixture();
  const candidate = structuredClone(base);
  const request = runtimeTraceRequestFixture(terminalCandidateSource);
  candidate.sourceHash = request.sourceHash;
  candidate.roots.forEach((root) => {
    root.binding.id = fastManimSourceBindingIdentifierV1(candidate.sourceHash, candidate.sceneId, root.binding);
  });

  const officialSquarePath = candidate.resources.paths[0];
  if (!officialSquarePath) throw new Error("Expected the Square path fixture.");
  const scaledSquarePath = structuredClone(officialSquarePath.path);
  for (const subpath of scaledSquarePath.subpaths) {
    subpath.start.x = canonicalFastManimRuntimeTraceCoordinateV1(subpath.start.x * 0.5);
    subpath.start.y = canonicalFastManimRuntimeTraceCoordinateV1(subpath.start.y * 0.5);
    for (const segment of subpath.segments) {
      for (const point of [segment.control1, segment.control2, segment.end]) {
        point.x = canonicalFastManimRuntimeTraceCoordinateV1(point.x * 0.5);
        point.y = canonicalFastManimRuntimeTraceCoordinateV1(point.y * 0.5);
      }
    }
  }
  const scaledSquarePathId = `path:${digestFastManimRuntimeTracePathV1(scaledSquarePath)}`;
  candidate.resources.paths.push({ id: scaledSquarePathId, path: scaledSquarePath });

  for (let frameIndex = 300; frameIndex < candidate.frames.length; frameIndex += 1) {
    const frame = candidate.frames[frameIndex];
    frame.motionY = 2.5;
    frame.draws[0].localPosition.x = 1.25;
    frame.draws[0].pathId = scaledSquarePathId;
    for (const draw of frame.draws.slice(1)) {
      draw.localPosition.x = canonicalFastManimRuntimeTraceCoordinateV1(draw.localPosition.x + 0.75);
    }
  }
  sealRuntimeTraceFixture(candidate);
  return {
    base,
    request,
    verified: verifyFastManimRuntimeTraceTerminalCandidateV1({
      base,
      candidate,
      candidateRequest: request,
      trusted: trustedRuntimeTraceProducer(base),
    }),
  };
}

function comparablePathDraw(draw: Awaited<ReturnType<typeof frameAt>>["packet"]["draws"][number]) {
  if (draw.kind !== "path") throw new Error("Expected a path draw.");
  return {
    fill: draw.fill,
    opacity: draw.opacity,
    path: draw.path,
    stroke: draw.stroke,
    transform: draw.transform,
  };
}

describe("fast-manim Runtime Trace V1 lowering", () => {
  it("preserves frame 299 and folds terminal move, scale, and updater geometry into frame 300", async () => {
    const { base, request, verified } = terminalCandidateFixture();
    const [officialBundle, candidateBundle] = await Promise.all([
      lower(base),
      lowerVerifiedFastManimRuntimeTraceTerminalCandidateV1(verified),
    ]);

    expect(candidateBundle.scene.source).toMatchObject({
      kind: "imported-manim-runtime-trace",
      sourceHash: request.sourceHash,
      traceVersion: 1,
    });
    expect(candidateBundle.scene.animationChannels).toEqual(officialBundle.scene.animationChannels);

    const [officialProtected, candidateProtected, officialTerminal, candidateTerminal] = await Promise.all([
      frameAt(officialBundle, 299 / 60),
      frameAt(candidateBundle, 299 / 60),
      frameAt(officialBundle, 5),
      frameAt(candidateBundle, 5),
    ]);
    expect(candidateProtected.packet.draws.map(comparablePathDraw)).toEqual(
      officialProtected.packet.draws.map(comparablePathDraw),
    );

    const officialSquare = comparablePathDraw(officialTerminal.packet.draws[0]);
    const candidateSquare = comparablePathDraw(candidateTerminal.packet.draws[0]);
    expect(candidateSquare.transform.tx).toBeCloseTo(1.25, 12);
    expect(candidateSquare.transform.ty).toBeCloseTo(2.5, 12);
    expect(candidateSquare.path.subpaths[0].segments[0].end.x).toBeCloseTo(
      officialSquare.path.subpaths[0].segments[0].end.x * 0.5,
      12,
    );

    const officialDecimal = officialTerminal.packet.draws.slice(1).map(comparablePathDraw);
    const candidateDecimal = candidateTerminal.packet.draws.slice(1).map(comparablePathDraw);
    expect(candidateDecimal).toHaveLength(9);
    candidateDecimal.forEach((draw, index) => {
      expect(draw.transform.tx).toBeCloseTo(officialDecimal[index].transform.tx + 0.75, 12);
      expect(draw.transform.ty).toBeCloseTo(2.5, 12);
    });
  });

  it("normalizes the measured trace into existing Scene IR groups, states, and motion", async () => {
    const trace = runtimeTraceFixture();
    const bundle = await lower(trace);

    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: RUNTIME_TRACE_CONFIG_HASH,
      traceVersion: 1,
    });
    expect(bundle.scene.requiredCapabilities).toEqual([
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
    ]);
    expect(bundle.scene.entities).toHaveLength(13);
    expect(bundle.scene.entities.filter(({ geometry }) => geometry.kind === "group")).toHaveLength(3);
    expect(bundle.scene.animationChannels).toHaveLength(1);

    for (const [sampleTime, expectedY] of [
      [0, 2.5],
      [2.5, -2.5],
      [5, 2.5],
      [6, 2.5],
    ] as const) {
      const frame = await frameAt(bundle, sampleTime);
      expect(frame.packet.compositing).toBe("manim-cairo-srgb");
      expect(frame.packet.draws).toHaveLength(10);
      expect(frame.packet.draws[0].transform.ty).toBeCloseTo(expectedY, 12);
      expect(frame.packet.draws.map(({ paintOrder }) => paintOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });

  it("deduplicates recurring visual states into bounded half-open lifetime runs", async () => {
    const trace = runtimeTraceFixture();
    for (let frameIndex = 0; frameIndex < 300; frameIndex += 1) {
      trace.frames[frameIndex].draws[1].localPosition.x = canonicalFastManimRuntimeTraceCoordinateV1(
        (frameIndex % 3) / 10,
      );
    }
    const bundle = await lower(trace);
    expect(bundle.scene.entities).toHaveLength(18);
    expect(Math.max(...bundle.scene.entities.map(({ lifetimes }) => lifetimes.length))).toBe(64);
    expect(bundle.scene.entities.reduce((total, entity) => total + entity.lifetimes.length, 0)).toBe(313);

    for (const frameIndex of [0, 1, 2, 149, 299]) {
      const frame = await frameAt(bundle, frameIndex * (1 / 60));
      expect(frame.packet.draws).toHaveLength(10);
      expect(frame.packet.draws[1].transform.tx).toBeCloseTo(1.25 + (frameIndex % 3) / 10, 12);
    }
    const betweenFrames = await frameAt(bundle, 31.5 / 60);
    expect(betweenFrames.packet.draws[1].transform.tx).toBeCloseTo(1.25 + (31 % 3) / 10, 12);
  });

  it("rejects motion substitution even when the structural wire contract is valid", async () => {
    const trace = runtimeTraceFixture();
    trace.frames[1].motionY = 0;
    await expect(lower(trace)).rejects.toMatchObject({
      code: "semantic-mismatch",
    });
  });

  it("fails closed before publishing an over-budget normalized Scene", async () => {
    const trace = runtimeTraceFixture();
    for (let frameIndex = 0; frameIndex < 300; frameIndex += 1) {
      for (let drawIndex = 1; drawIndex <= 3; drawIndex += 1) {
        trace.frames[frameIndex].draws[drawIndex].localPosition.x = canonicalFastManimRuntimeTraceCoordinateV1(
          drawIndex + frameIndex / 1_000,
        );
      }
    }
    await expect(lower(trace)).rejects.toMatchObject({
      code: "normalization-budget",
      message: expect.stringContaining("0 bytes"),
    });
  });

  it("rejects re-addressed visual substitutions against independent trusted evidence", async () => {
    const original = runtimeTraceFixture();
    const trusted = trustedRuntimeTraceProducer(original);
    const substitutions = [
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        const resource = trace.resources.paths[0];
        const previousId = resource.id;
        resource.path.subpaths[0].start.x = 0.25;
        resource.id = `path:${digestFastManimRuntimeTracePathV1(resource.path)}`;
        trace.frames.forEach((frame) => {
          frame.draws.forEach((draw) => {
            if (draw.pathId === previousId) draw.pathId = resource.id;
          });
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        const resource = trace.resources.appearances[0];
        const previousId = resource.id;
        if (!resource.fill) throw new Error("Expected filled fixture appearance.");
        resource.fill.color.red = 0.5;
        resource.id = `appearance:${digestFastManimRuntimeTraceAppearanceV1({
          fill: resource.fill,
          stroke: resource.stroke,
        })}`;
        trace.frames.forEach((frame) => {
          frame.draws.forEach((draw) => {
            if (draw.appearanceId === previousId) draw.appearanceId = resource.id;
          });
        });
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames[1].draws[0].opacity = 0.5;
      },
      (trace: ReturnType<typeof runtimeTraceFixture>) => {
        trace.frames[1].draws[0].localPosition.x = 0.125;
      },
    ];

    for (const substitute of substitutions) {
      const changed = structuredClone(original);
      substitute(changed);
      await expect(lower(changed, trusted)).rejects.toThrow(/stale producer correlation/);
    }
  });

  it("pins lowering to the exact reviewed official source bytes", async () => {
    const request = runtimeTraceRequestFixture(`${RUNTIME_TRACE_SOURCE_TEXT}\n`);
    const trace = runtimeTraceFixture();
    trace.sourceHash = request.sourceHash;
    sealRuntimeTraceFixture(trace);
    await expect(
      lowerFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(trace), request, trustedRuntimeTraceProducer(trace)),
    ).rejects.toMatchObject({ code: "semantic-mismatch" });
  });

  it("rechecks producer correlation before any lowering", async () => {
    const trace = runtimeTraceFixture();
    trace.sourceHash = "f".repeat(64);
    await expect(
      lowerFastManimRuntimeTraceProducerJsonV1(
        canonicalJsonV1(trace),
        runtimeTraceRequestFixture(),
        trustedRuntimeTraceProducer(trace),
      ),
    ).rejects.toThrow(/stale sourceHash correlation/);
  });
});
