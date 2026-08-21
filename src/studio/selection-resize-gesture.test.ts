import { describe, expect, it } from "vitest";

import {
  createSelectionResizeGesture,
  groupResizeEligibleCreationEntityIds,
  importedGroupResizeHistoryIsSupported,
  resizeSelectionAtPoint,
  resizeUnavailableCreationEntityIds,
  selectionResizeCommandTargets,
  uniformScaleResizeOnlyCreationEntityIds,
} from "./selection-resize-gesture";

const positionMutation = (transactionId: string, entityId: string) => ({
  entityId,
  interval: { end: 0, start: 0 },
  kind: "position" as const,
  operationId: `${transactionId}:position:${entityId}`,
  transactionId,
  value: { x: 0, y: 0 },
});

const scaleMutation = (transactionId: string, entityId: string, from: number, to: number) => ({
  entityId,
  from,
  interval: { end: 0, start: 0 },
  kind: "uniform-scale" as const,
  operationId: `${transactionId}:scale:${entityId}`,
  to,
  transactionId,
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

describe("selection resize gesture", () => {
  it("routes only non-identity Rust-projected rotation through uniform resize", () => {
    const entities = [
      { createdLifetime: { start: 0 }, entityId: "rectangle", initialRotation: 0 },
      { createdLifetime: { start: 0 }, entityId: "circle", initialRotation: 0 },
      { createdLifetime: { start: 0 }, entityId: "base-rotated", initialRotation: 0 },
      { createdLifetime: { start: 0 }, entityId: "near-base", initialRotation: 0 },
      { createdLifetime: { start: 0 }, entityId: "after-boundary", initialRotation: 0 },
    ];
    const mutations = [
      { entityId: "rectangle", interval: { start: 0.4 }, kind: "rotation", to: Math.PI / 4 },
      { entityId: "circle", interval: { start: 0.4 }, kind: "rotation", to: Math.PI * 2 },
      { entityId: "base-rotated", interval: { start: 0 }, kind: "rotation", to: Math.PI / 2 },
      { entityId: "near-base", interval: { start: 0.0001 }, kind: "rotation", to: Math.PI / 2 },
      { entityId: "after-boundary", interval: { start: 0.0006 }, kind: "rotation", to: Math.PI / 2 },
    ];
    const eligible = uniformScaleResizeOnlyCreationEntityIds({
      entities,
      mutations,
    });

    expect([...eligible]).toEqual(["rectangle", "after-boundary"]);
    expect([...resizeUnavailableCreationEntityIds({ entities, mutations })]).toEqual(["base-rotated", "near-base"]);
  });

  it("keeps individually rotated Studio-created members eligible for canonical group transforms", () => {
    const entities = [
      { createdLifetime: { start: 0 }, entityId: "left", initialRotation: 0 },
      { createdLifetime: { start: 0 }, entityId: "right", initialRotation: 0 },
    ];
    const eligible = groupResizeEligibleCreationEntityIds({
      entities,
      mutations: [
        {
          entityId: "left",
          interval: { start: 0.4 },
          kind: "rotation",
          to: Math.PI / 4,
          transactionId: "rotate-left",
        },
      ],
    });

    expect([...eligible]).toEqual(["left", "right"]);
    expect(
      groupResizeEligibleCreationEntityIds({
        entities,
        mutations: [{ entityId: "left", interval: { start: 0 }, kind: "rotation", to: Math.PI / 4 }],
      }),
    ).toEqual(new Set(["right"]));
    expect(
      groupResizeEligibleCreationEntityIds({
        entities,
        motions: [{ targetEntityId: "left" }],
        mutations: [],
      }),
    ).toEqual(new Set(["right"]));
  });

  it("hides single-object resize after motion because post-motion transforms are unsupported", () => {
    const projection = {
      entities: [
        { createdLifetime: { start: 0 }, entityId: "rotated-motion", initialRotation: 0 },
        { createdLifetime: { start: 0 }, entityId: "plain-motion", initialRotation: 0 },
      ],
      motions: [{ targetEntityId: "rotated-motion" }, { targetEntityId: "plain-motion" }],
      mutations: [{ entityId: "rotated-motion", interval: { start: 0.4 }, kind: "rotation", to: Math.PI / 4 }],
    };

    expect(uniformScaleResizeOnlyCreationEntityIds(projection)).toEqual(new Set());
    expect(resizeUnavailableCreationEntityIds(projection)).toEqual(new Set(["rotated-motion", "plain-motion"]));
  });

  it("admits the first imported group resize before any static-root edit exists", () => {
    expect(importedGroupResizeHistoryIsSupported(null, null)).toBe(true);
    expect(importedGroupResizeHistoryIsSupported(undefined, null)).toBe(false);
  });

  it("admits repeated Rust-projected group resize transactions", () => {
    expect(
      importedGroupResizeHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("resize-once", "left"),
            positionMutation("resize-once", "right"),
            scaleMutation("resize-once", "left", 1, 1.5),
            scaleMutation("resize-once", "right", 1, 1.5),
            positionMutation("resize-twice", "left"),
            positionMutation("resize-twice", "right"),
            scaleMutation("resize-twice", "left", 1.5, 2),
            scaleMutation("resize-twice", "right", 1.5, 2),
          ],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(true);
  });

  it("admits a complete Rust-projected rotation before group resize", () => {
    expect(
      importedGroupResizeHistoryIsSupported(
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
        null,
      ),
    ).toBe(true);
  });

  it("rejects single-object move-and-scale history", () => {
    expect(
      importedGroupResizeHistoryIsSupported(
        {
          insertions: [],
          mutations: [positionMutation("resize-image", "image"), scaleMutation("resize-image", "image", 1, 2)],
          projectedDuration: 0,
        },
        null,
      ),
    ).toBe(false);
  });

  it("rejects group resize after a persistent remove", () => {
    expect(
      importedGroupResizeHistoryIsSupported(
        {
          insertions: [],
          mutations: [
            positionMutation("resize", "left"),
            positionMutation("resize", "right"),
            scaleMutation("resize", "left", 1, 2),
            scaleMutation("resize", "right", 1, 2),
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

  it("keeps prepared centers, preview deltas, and command positions in Studio viewport units", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 260, left: 120, right: 520, top: 100 },
        entities: [
          { center: { x: 200, y: 180 }, entityId: "left" },
          { center: { x: 440, y: 180 }, entityId: "right" },
        ],
      },
      cameraScale: 2,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 520, y: 260 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 190, y: 170 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 430, y: 170 }, fromScale: 2 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    const { factor, preview } = resizeSelectionAtPoint(gesture, { x: 920, y: 420 });

    expect(factor).toBe(2);
    expect(preview.entities).toEqual([
      { delta: { x: 40, y: 40 }, entityId: "left", scale: 2 },
      { delta: { x: 160, y: 40 }, entityId: "right", scale: 4 },
    ]);
    expect(selectionResizeCommandTargets(gesture, preview)).toEqual([
      { entityId: "left", fromScale: 1, toPosition: { x: 230, y: 210 }, toScale: 2 },
      { entityId: "right", fromScale: 2, toPosition: { x: 590, y: 210 }, toScale: 4 },
    ]);
  });

  it("does not create a gesture when a selected entity lacks prepared Rust geometry", () => {
    expect(
      createSelectionResizeGesture({
        basis: {
          bounds: { bottom: 260, left: 120, right: 520, top: 100 },
          entities: [{ center: { x: 200, y: 180 }, entityId: "left" }],
        },
        cameraScale: 1,
        direction: "se",
        maximumScale: 10,
        minimumScale: 0.1,
        pointerId: 4,
        sourceAnchor: 1,
        start: { x: 520, y: 260 },
        surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
        targets: [
          { entityId: "left", fromPosition: { x: 200, y: 180 }, fromScale: 1 },
          { entityId: "missing", fromPosition: { x: 440, y: 180 }, fromScale: 1 },
        ],
      }),
    ).toBeNull();
  });

  it("refuses to commit a partial preview for a multi-object gesture", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 260, left: 120, right: 520, top: 100 },
        entities: [
          { center: { x: 200, y: 180 }, entityId: "left" },
          { center: { x: 440, y: 180 }, entityId: "right" },
        ],
      },
      cameraScale: 1,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 520, y: 260 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 200, y: 180 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 440, y: 180 }, fromScale: 1 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    expect(() =>
      selectionResizeCommandTargets(gesture, {
        entities: [{ delta: { x: -40, y: 0 }, entityId: "left", scale: 2 }],
        guides: [],
      }),
    ).toThrow("must cover every selected object exactly once");
  });

  it("uses the same snapped factor for pointer preview and commit", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 200, left: 100, right: 200, top: 100 },
        entities: [
          { center: { x: 125, y: 150 }, entityId: "left" },
          { center: { x: 175, y: 150 }, entityId: "right" },
        ],
        frame: { bottom: 360, left: 0, right: 640, top: 0 },
        objects: [{ bounds: { bottom: 80, left: 400, right: 450, top: 20 }, entityId: "target" }],
      },
      cameraScale: 1,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 200, y: 200 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 125, y: 150 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 175, y: 150 }, fromScale: 1 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    const pointer = { x: 395, y: 395 };
    const preview = resizeSelectionAtPoint(gesture, pointer);
    const commit = resizeSelectionAtPoint(gesture, pointer);
    expect(preview).toEqual(commit);
    expect(preview.factor).toBe(3);
    expect(preview.preview.guides).toEqual([{ axis: "x", entityId: "target", kind: "object", position: 400 }]);

    const bypassed = resizeSelectionAtPoint(gesture, pointer, true);
    expect(bypassed.factor).toBe(2.95);
    expect(bypassed.preview.guides).toEqual([]);
  });

  it("does not create a resize gesture from incomplete selected bounds", () => {
    expect(
      createSelectionResizeGesture({
        basis: {
          bounds: { bottom: 200, left: Number.NaN, right: 200, top: 100 },
          entities: [
            { center: { x: 125, y: 150 }, entityId: "left" },
            { center: { x: 175, y: 150 }, entityId: "right" },
          ],
        },
        cameraScale: 1,
        direction: "se",
        maximumScale: 10,
        minimumScale: 0.1,
        pointerId: 4,
        sourceAnchor: 1,
        start: { x: 200, y: 200 },
        surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
        targets: [
          { entityId: "left", fromPosition: { x: 125, y: 150 }, fromScale: 1 },
          { entityId: "right", fromPosition: { x: 175, y: 150 }, fromScale: 1 },
        ],
      }),
    ).toBeNull();
  });

  it("does not snap or commit a resize when the handle was only clicked", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 355, left: 100, right: 200, top: 100 },
        entities: [
          { center: { x: 125, y: 200 }, entityId: "left" },
          { center: { x: 175, y: 200 }, entityId: "right" },
        ],
        frame: { bottom: 360, left: 0, right: 640, top: 0 },
      },
      cameraScale: 1,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 200, y: 355 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 125, y: 200 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 175, y: 200 }, fromScale: 1 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    expect(resizeSelectionAtPoint(gesture, gesture.start)).toEqual({
      factor: 1,
      preview: {
        entities: [
          { delta: { x: 0, y: 0 }, entityId: "left", scale: 1 },
          { delta: { x: 0, y: 0 }, entityId: "right", scale: 1 },
        ],
        guides: [],
      },
    });
  });
});
