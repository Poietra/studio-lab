import { describe, expect, it } from "vitest";

import {
  createSelectionRotationGesture,
  latestCreationPositionForEntity,
  selectionRotationCommandTargets,
  selectionRotationPreviewAtAngle,
} from "./selection-rotation-gesture";

const basis = {
  bounds: { bottom: 260, left: 120, right: 520, top: 100 },
  entities: [
    { center: { x: 200, y: 180 }, entityId: "left" },
    { center: { x: 440, y: 180 }, entityId: "right" },
  ],
};

describe("selection rotation gesture", () => {
  it("uses the latest Rust creation position mutation as canonical command state", () => {
    const projection = {
      mutations: [
        { entityId: "left", kind: "position", value: { x: 100, y: 200 } },
        { entityId: "right", kind: "position", value: { x: 300, y: 200 } },
        { entityId: "left", kind: "position", value: { x: 120, y: 220 } },
      ],
    };

    expect(latestCreationPositionForEntity(projection, "left")).toEqual({ x: 120, y: 220 });
    expect(latestCreationPositionForEntity(projection, "right")).toEqual({ x: 300, y: 200 });
    expect(latestCreationPositionForEntity(projection, "missing")).toBeNull();
  });

  it("rotates prepared centers around their aggregate pivot but commits from Rust-projected positions", () => {
    const gesture = createSelectionRotationGesture({
      basis,
      cameraScale: 2,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 320, y: 100 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 250, y: 170 } },
        { entityId: "right", fromPosition: { x: 370, y: 170 } },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    const preview = selectionRotationPreviewAtAngle(gesture, Math.PI / 2);

    expect(preview.entities).toEqual([
      { angleRadians: Math.PI / 2, delta: { x: 60, y: 60 }, entityId: "left" },
      { angleRadians: Math.PI / 2, delta: { x: -60, y: -60 }, entityId: "right" },
    ]);
    expect(selectionRotationCommandTargets(gesture, preview)).toEqual([
      { entityId: "left", toPosition: { x: 310, y: 230 } },
      { entityId: "right", toPosition: { x: 310, y: 110 } },
    ]);
  });

  it("does not create a gesture when any selected entity lacks prepared Rust geometry", () => {
    expect(
      createSelectionRotationGesture({
        basis: { ...basis, entities: basis.entities.slice(0, 1) },
        cameraScale: 1,
        pointerId: 4,
        sourceAnchor: 1,
        start: { x: 320, y: 100 },
        surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
        targets: [
          { entityId: "left", fromPosition: { x: 200, y: 180 } },
          { entityId: "right", fromPosition: { x: 440, y: 180 } },
        ],
      }),
    ).toBeNull();
  });

  it("refuses to commit a partial or duplicate preview", () => {
    const gesture = createSelectionRotationGesture({
      basis,
      cameraScale: 1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 320, y: 100 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 200, y: 180 } },
        { entityId: "right", fromPosition: { x: 440, y: 180 } },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    expect(() =>
      selectionRotationCommandTargets(gesture, {
        entities: [{ angleRadians: Math.PI / 2, delta: { x: 0, y: 0 }, entityId: "left" }],
      }),
    ).toThrow("must cover every selected object exactly once");
    expect(() =>
      selectionRotationCommandTargets(gesture, {
        entities: [
          { angleRadians: Math.PI / 2, delta: { x: 0, y: 0 }, entityId: "left" },
          { angleRadians: Math.PI / 2, delta: { x: 0, y: 0 }, entityId: "left" },
        ],
      }),
    ).toThrow("must cover every selected object exactly once");
  });
});
