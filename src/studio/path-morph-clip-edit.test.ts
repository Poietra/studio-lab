import { describe, expect, it } from "vitest";

import type { StudioCubicBezierPath } from "../engine/cubic-bezier-authoring";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import {
  createPathMorphProgram,
  pathMorphClipFromProgram,
  replacePathMorphPoint,
  replacePathMorphProgram,
} from "./path-morph-clip-edit";

const ROOT_ID = "tx:create-pen/entity:curve";
const FROM_PATH: StudioCubicBezierPath = {
  closed: false,
  segments: [
    {
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: 1 },
      end: { x: 2, y: 0 },
    },
  ],
  start: { x: -2, y: 0 },
};

function studioScene(): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [ROOT_ID]: {
          geometry: {
            dimensions: { kind: "known", value: { height: 1, width: 4 } },
            position: { kind: "known", value: { x: 0, y: 0 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: { strokeColor: "#ffffff", strokeWidth: 0.04 } },
          },
          id: ROOT_ID,
          lifetime: [{ end: 8, start: 1 }],
          provisional: false,
          sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
          transactionId: "create-pen",
          type: "CubicBezier",
        },
      },
    },
  };
}

describe("Studio Pen Path Morph clip editing", () => {
  it("creates and edits one same-topology clip without changing its identity", () => {
    const to = replacePathMorphPoint(
      FROM_PATH,
      { kind: "segment", point: "control2", segmentIndex: 0 },
      {
        x: 1,
        y: -1,
      },
    );
    const created = createPathMorphProgram({
      capturedPlayhead: 2,
      easing: "smooth",
      end: 3,
      entityId: ROOT_ID,
      from: FROM_PATH,
      scene: studioScene(),
      start: 2,
      to,
      transactionId: "morph-curve",
    });

    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    const clip = pathMorphClipFromProgram(created.program);
    expect(clip).toMatchObject({
      easing: "smooth",
      entityId: ROOT_ID,
      interval: { end: 3, start: 2 },
      to,
      transactionId: "morph-curve",
    });

    const editedTarget = replacePathMorphPoint(
      to,
      { kind: "segment", point: "end", segmentIndex: 0 },
      {
        x: 2,
        y: 0.5,
      },
    );
    const edited = replacePathMorphProgram({
      baseProgram: created.program,
      duration: 1.5,
      easing: "linear",
      scene: studioScene(),
      to: editedTarget,
    });
    expect(edited.kind, JSON.stringify(edited.issues)).toBe("valid");
    expect(pathMorphClipFromProgram(edited.program)).toMatchObject({
      easing: "linear",
      interval: { end: 3.5, start: 2 },
      operationId: clip?.operationId,
      to: editedTarget,
    });
  });

  it("rejects mismatched topology and intervals outside the Pen lifetime", () => {
    const mismatched = createPathMorphProgram({
      capturedPlayhead: 2,
      easing: "smooth",
      end: 3,
      entityId: ROOT_ID,
      from: FROM_PATH,
      scene: studioScene(),
      start: 2,
      to: { ...FROM_PATH, closed: true },
      transactionId: "morph-topology",
    });
    expect(mismatched.kind).toBe("invalid");
    expect(mismatched.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: "path" })]));

    expect(() =>
      createPathMorphProgram({
        capturedPlayhead: 7.5,
        easing: "smooth",
        end: 8.5,
        entityId: ROOT_ID,
        from: FROM_PATH,
        scene: studioScene(),
        start: 7.5,
        to: replacePathMorphPoint(FROM_PATH, { kind: "start" }, { x: -2, y: 0.5 }),
        transactionId: "morph-too-long",
      }),
    ).toThrow(/lifetime/);
  });
});
