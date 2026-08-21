import { describe, expect, it } from "vitest";

import {
  createSelectionRotationGesture,
  currentCreationTransformForEntity,
  importedGroupRotationHistoryIsSupported,
  latestCreationPositionForEntity,
  selectionRotationCommandTargets,
  selectionRotationPreviewAtAngle,
  studioCreationStaticTransformAnchorForEntity,
} from "./selection-rotation-gesture";

const positionMutation = (transactionId: string, entityId: string) => ({
  entityId,
  interval: { end: 0, start: 0 },
  kind: "position" as const,
  operationId: `${transactionId}:position:${entityId}`,
  transactionId,
  value: { x: 0, y: 0 },
});

const rotationMutation = (transactionId: string, entityId: string) => ({
  entityId,
  from: 0,
  interval: { end: 0, start: 0 },
  kind: "rotation" as const,
  operationId: `${transactionId}:rotation:${entityId}`,
  to: Math.PI / 2,
  transactionId,
});

const scaleMutation = (transactionId: string, entityId: string) => ({
  entityId,
  from: 1,
  interval: { end: 0, start: 0 },
  kind: "uniform-scale" as const,
  operationId: `${transactionId}:scale:${entityId}`,
  to: 2,
  transactionId,
});

const basis = {
  bounds: { bottom: 260, left: 120, right: 520, top: 100 },
  entities: [
    { center: { x: 200, y: 180 }, entityId: "left" },
    { center: { x: 440, y: 180 }, entityId: "right" },
  ],
};

describe("selection rotation gesture", () => {
  it("admits the first imported group rotation before any static-root edit exists", () => {
    expect(importedGroupRotationHistoryIsSupported(null, null)).toBe(true);
    expect(importedGroupRotationHistoryIsSupported(undefined, null)).toBe(false);
  });

  it("admits repeated Rust-projected group rotation transactions", () => {
    expect(
      importedGroupRotationHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("rotate-once", "left"),
            positionMutation("rotate-once", "right"),
            rotationMutation("rotate-once", "left"),
            rotationMutation("rotate-once", "right"),
            positionMutation("rotate-twice", "left"),
            positionMutation("rotate-twice", "right"),
            rotationMutation("rotate-twice", "left"),
            rotationMutation("rotate-twice", "right"),
          ],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(true);
  });

  it("admits a complete Rust-projected resize before group rotation", () => {
    expect(
      importedGroupRotationHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("resize", "left"),
            positionMutation("resize", "right"),
            scaleMutation("resize", "left"),
            scaleMutation("resize", "right"),
          ],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(true);
  });

  it("rejects incomplete or mixed-family single transactions", () => {
    expect(
      importedGroupRotationHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("rotate", "left"),
            positionMutation("rotate", "right"),
            rotationMutation("rotate", "left"),
          ],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(false);
    expect(
      importedGroupRotationHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("ambiguous", "left"),
            positionMutation("ambiguous", "right"),
            scaleMutation("ambiguous", "left"),
            scaleMutation("ambiguous", "right"),
            rotationMutation("ambiguous", "left"),
            rotationMutation("ambiguous", "right"),
          ],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(false);
  });

  it("rejects group rotation after a persistent remove", () => {
    expect(
      importedGroupRotationHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("rotate", "left"),
            positionMutation("rotate", "right"),
            rotationMutation("rotate", "left"),
            rotationMutation("rotate", "right"),
          ],
          projectedDuration: 0,
        },
        {
          removals: [
            {
              affectedSceneEntityIds: ["left"],
              fadeInterval: null,
              operationId: "remove-left",
              removedAt: 0,
              resultingLifetimeEnd: 0,
              sceneEntityId: "left",
              studioEntityId: "source:left",
              transactionId: "remove-left",
            },
          ],
        },
      ),
    ).toBe(false);
  });

  it("uses the latest Rust creation position mutation as canonical command state", () => {
    const projection = {
      mutations: [
        { entityId: "left", kind: "position", value: { x: 100, y: 200 } },
        { entityId: "right", kind: "position", value: { x: 300, y: 200 } },
        {
          entityId: "left",
          fromPosition: { x: 100, y: 200 },
          kind: "resize",
          toPosition: { x: 140, y: 230 },
        },
      ],
    };

    expect(latestCreationPositionForEntity(projection, "left")).toEqual({ x: 140, y: 230 });
    expect(latestCreationPositionForEntity(projection, "right")).toEqual({ x: 300, y: 200 });
    expect(latestCreationPositionForEntity(projection, "missing")).toBeNull();
  });

  it("selects the final Rust-projected transform without replaying geometry", () => {
    const projection = {
      entities: [{ entityId: "left" }],
      mutations: [
        { entityId: "left", kind: "position", value: { x: 100, y: 200 } },
        { entityId: "left", kind: "rotation", to: Math.PI / 2 },
        { entityId: "left", kind: "resize", toPosition: { x: 120, y: 220 } },
        { entityId: "left", kind: "rotation", to: Math.PI },
      ],
    };

    expect(currentCreationTransformForEntity(projection, "left")).toEqual({
      rotation: Math.PI,
      transformOrigin: { x: 120, y: 220 },
    });
    expect(currentCreationTransformForEntity(projection, "missing")).toBeNull();
  });

  it("keeps one Studio-created static transform lane at the Rust-admitted anchor", () => {
    const programs = [
      { anchor: { resolvedSeconds: 0.5 }, transactionId: "create" },
      { anchor: { resolvedSeconds: 0.85 }, transactionId: "resize" },
      { anchor: { resolvedSeconds: 0.85 }, transactionId: "rotate" },
      { anchor: { resolvedSeconds: 0.85 }, transactionId: "scale" },
    ];
    const projection = {
      entities: [{ entityId: "circle", transactionId: "create" }],
      motions: [],
      mutations: [
        { entityId: "circle", kind: "position", transactionId: "create" },
        { entityId: "circle", kind: "resize", transactionId: "resize" },
        { entityId: "circle", kind: "rotation", transactionId: "rotate" },
        { entityId: "circle", kind: "uniform-scale", transactionId: "scale" },
      ],
      removals: [],
    };

    expect(studioCreationStaticTransformAnchorForEntity(projection, programs, "circle")).toBe(0.85);
  });

  it("keeps motion, transform tracks, removals, and split static anchors outside the lane", () => {
    const programs = [
      { anchor: { resolvedSeconds: 0.5 }, transactionId: "create" },
      { anchor: { resolvedSeconds: 0.85 }, transactionId: "resize" },
      { anchor: { resolvedSeconds: 1.2 }, transactionId: "rotate" },
    ];
    const base = {
      entities: [{ entityId: "circle", transactionId: "create" }],
      mutations: [{ entityId: "circle", kind: "resize", transactionId: "resize" }],
    };

    expect(
      studioCreationStaticTransformAnchorForEntity(
        { ...base, motions: [{ targetEntityId: "circle" }] },
        programs,
        "circle",
      ),
    ).toBeNull();
    expect(
      studioCreationStaticTransformAnchorForEntity(
        {
          ...base,
          mutations: [...base.mutations, { entityId: "circle", kind: "rotation-keyframes", transactionId: "create" }],
        },
        programs,
        "circle",
      ),
    ).toBeNull();
    expect(
      studioCreationStaticTransformAnchorForEntity(
        { ...base, removals: [{ studioEntityId: "circle" }] },
        programs,
        "circle",
      ),
    ).toBeNull();
    expect(
      studioCreationStaticTransformAnchorForEntity(
        {
          ...base,
          mutations: [...base.mutations, { entityId: "circle", kind: "rotation", transactionId: "rotate" }],
        },
        programs,
        "circle",
      ),
    ).toBeNull();
  });

  it("rotates prepared centers from the Rust-projected origin after an asymmetric shape resize", () => {
    const projection = {
      entities: [{ entityId: "left" }, { entityId: "right" }],
      mutations: [
        { entityId: "left", kind: "position", value: { x: 200, y: 180 } },
        { entityId: "right", kind: "position", value: { x: 440, y: 180 } },
        { entityId: "left", kind: "resize", toPosition: { x: 250, y: 170 } },
        { entityId: "right", kind: "resize", toPosition: { x: 370, y: 170 } },
      ],
    };
    const targets = ["left", "right"].flatMap((entityId) => {
      const transform = currentCreationTransformForEntity(projection, entityId);
      return transform ? [{ entityId, fromPosition: transform.transformOrigin }] : [];
    });
    expect(targets).toHaveLength(2);
    const gesture = createSelectionRotationGesture({
      basis,
      cameraScale: 2,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 320, y: 100 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets,
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
