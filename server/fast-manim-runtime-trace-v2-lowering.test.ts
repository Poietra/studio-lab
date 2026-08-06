import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import {
  lowerVerifiedFastManimRuntimeTraceV2,
  type VerifiedFastManimRuntimeTraceV2,
} from "./fast-manim-runtime-trace-v2-lowering";

const SHA = "a".repeat(64);
const SCENE_ID = `scene:${SHA}`;
const TITLE_ROOT = `${SCENE_ID}/runtime-root:title`;
const BASEL_ROOT = `${SCENE_ID}/runtime-root:basel`;
const INITIAL_APPEARANCE_ID = `appearance:${"c".repeat(64)}`;
const FINAL_APPEARANCE_ID = `appearance:${"d".repeat(64)}`;

function path(drawIndex: number) {
  const offset = drawIndex / 100;
  return {
    subpaths: [
      {
        closed: false,
        segments: [
          {
            control1: { x: offset + 0.25, y: 0.5 },
            control2: { x: offset + 0.75, y: 0.5 },
            end: { x: offset + 1, y: 0 },
          },
        ],
        start: { x: offset, y: 0 },
      },
    ],
  };
}

function pathId(drawIndex: number) {
  return `path:${(drawIndex % 24).toString(16).padStart(64, "0")}`;
}

const initialAppearance = {
  fill: { color: { alpha: 0, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
  stroke: {
    cap: "butt" as const,
    color: { alpha: 1, blue: 1, green: 1, red: 1 },
    join: "miter" as const,
    miterLimit: 4,
    widthWorld: 0.05,
  },
};

const finalAppearance = {
  fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
  stroke: null,
};

function fixture(): VerifiedFastManimRuntimeTraceV2 {
  return {
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      center: { x: 0, y: 0 },
      frameHeight: 8,
      frameWidth: 128 / 9,
    },
    durationSeconds: 3,
    frames: Array.from({ length: 180 }, (_, frameIndex) => ({
      draws: Array.from({ length: 29 }, (_, drawIndex) => {
        const title = drawIndex < 15;
        const localOrder = title ? drawIndex : drawIndex - 15;
        const rootId = title ? TITLE_ROOT : BASEL_ROOT;
        const progress = Math.min(1, frameIndex / 60);
        return {
          appearanceId: title && frameIndex < 60 ? INITIAL_APPEARANCE_ID : FINAL_APPEARANCE_ID,
          drawId: `${rootId}/runtime-draw:${localOrder}`,
          familyPath: [0, localOrder],
          opacity: title ? 1 : progress,
          paintOrder: drawIndex,
          pathId: pathId(drawIndex),
          pathTrim: { end: title ? Math.min(1, frameIndex / 60) : 1, start: 0 },
          present: true,
          rootId,
          sourceZIndex: 0,
          translation: { x: drawIndex / 10, y: title ? 0 : progress - 1 },
        };
      }),
      frameIndex,
    })),
    producer: {
      fastManimCommit: "1".repeat(40),
      geometryResourceSha256: "e".repeat(64),
      texToolchainSha256: "f".repeat(64),
    },
    resources: {
      appearances: [
        { ...initialAppearance, id: INITIAL_APPEARANCE_ID },
        { ...finalAppearance, id: FINAL_APPEARANCE_ID },
      ],
      paths: Array.from({ length: 24 }, (_, drawIndex) => ({ id: pathId(drawIndex), path: path(drawIndex) })),
    },
    roots: [
      { binding: { id: `source-binding:${"1".repeat(64)}` }, id: TITLE_ROOT, role: "title" },
      { binding: { id: `source-binding:${"2".repeat(64)}` }, id: BASEL_ROOT, role: "basel" },
    ],
    runtimeConfigHash: "3".repeat(64),
    sceneId: SCENE_ID,
    sourceHash: "4".repeat(64),
  };
}

async function frameAt(bundle: Awaited<ReturnType<typeof lowerVerifiedFastManimRuntimeTraceV2>>, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets: bundle.assets,
    packetId: `opening-v2:${sampleTime}`,
    sampleTime,
    scene: bundle.scene,
    viewport: { heightPx: 720, widthPx: 1_280 },
  });
  if (result.kind !== "ready") throw new Error(result.message);
  return result.frame;
}

describe("OpeningManim Runtime Trace V2 lowering", () => {
  it("maps captured presentation frames to existing retained Scene IR channels", async () => {
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(fixture());

    expect(bundle.scene.source).toMatchObject({ kind: "imported-manim-runtime-trace", traceVersion: 2 });
    expect(bundle.scene.entities).toHaveLength(47);
    expect(bundle.scene.entities.filter((entity) => entity.geometry.kind === "group")).toHaveLength(3);
    expect(bundle.scene.requiredCapabilities).toEqual([
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
      "opacity-animation",
      "path-trim-animation",
      "vector-appearance-animation",
    ]);

    const initial = await frameAt(bundle, 0);
    expect(initial.packet.draws).toHaveLength(44);
    expect(initial.packet.draws[1].kind).toBe("empty");
    expect(initial.packet.draws[30].opacity).toBe(0);
    expect(initial.packet.draws[30].transform.ty).toBe(-1);

    const midpoint = await frameAt(bundle, 0.5);
    expect(midpoint.packet.draws[1].kind).toBe("path");
    expect(midpoint.packet.draws[30].opacity).toBe(0.5);
    expect(midpoint.packet.draws[30].transform.ty).toBe(-0.5);

    const hold = await frameAt(bundle, 3);
    expect(hold.packet.draws).toHaveLength(44);
    expect(hold.packet.draws[1]).toMatchObject({
      kind: "path",
      stroke: { color: { alpha: 0 } },
    });
    expect(hold.packet.draws[30].opacity).toBe(1);
    expect(hold.packet.draws[30].transform.ty).toBe(0);

    expect(await frameAt(bundle, 0.5)).toEqual(midpoint);
  });

  it("fails closed when one frame changes stable draw identity", async () => {
    const original = fixture();
    const trace = {
      ...original,
      frames: original.frames.map((frame, frameIndex) =>
        frameIndex === 1
          ? {
              ...frame,
              draws: frame.draws.map((draw, drawIndex) =>
                drawIndex === 0 ? { ...draw, pathId: `path:${"9".repeat(64)}` } : draw,
              ),
            }
          : frame,
      ),
    };
    await expect(lowerVerifiedFastManimRuntimeTraceV2(trace)).rejects.toMatchObject({
      code: "semantic-mismatch",
    });
  });

  it("rejects a visible partial fill that the stroke-only trim channel cannot represent", async () => {
    const original = fixture();
    const trace = {
      ...original,
      frames: original.frames.map((frame, frameIndex) =>
        frameIndex === 1
          ? {
              ...frame,
              draws: frame.draws.map((draw, drawIndex) =>
                drawIndex === 0 ? { ...draw, appearanceId: FINAL_APPEARANCE_ID } : draw,
              ),
            }
          : frame,
      ),
    };
    await expect(lowerVerifiedFastManimRuntimeTraceV2(trace)).rejects.toThrow(/visible partial fill/);
  });
});
