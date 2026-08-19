import { describe, expect, it, vi } from "vitest";

import { createStudioGesturePreviewStore } from "./studio-gesture-preview-store";

describe("Studio gesture preview store", () => {
  it("keeps one stable idle snapshot until the preview changes", () => {
    const store = createStudioGesturePreviewStore();
    const initial = store.getSnapshot();

    expect(initial).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "idle",
      rotationPreview: null,
      scalePreview: null,
    });
    expect(store.getSnapshot()).toBe(initial);

    store.clear();
    expect(store.getSnapshot()).toBe(initial);
  });

  it("publishes drag changes while preserving identity for value-equal updates", () => {
    const store = createStudioGesturePreviewStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDragPreview({ delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"] });
    const first = store.getSnapshot();

    expect(first).toEqual({
      dragPreview: { delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"] },
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "drag",
      rotationPreview: null,
      scalePreview: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    store.setDragPreview({ delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"] });
    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setDragPreview({ delta: { x: 13, y: -4 }, entityIds: ["entity:a", "entity:b"] });
    expect(store.getSnapshot()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("compares geometry and scale previews by their observable values", () => {
    const store = createStudioGesturePreviewStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setGeometryPreview({
      dimensions: { height: 2, width: 4 },
      entityId: "entity:rectangle",
      position: { x: 320, y: 180 },
    });
    const geometry = store.getSnapshot();
    store.setGeometryPreview({
      dimensions: { height: 2, width: 4 },
      entityId: "entity:rectangle",
      position: { x: 320, y: 180 },
    });

    expect(store.getSnapshot()).toBe(geometry);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setScalePreview({ entityId: "entity:rectangle", scale: 1.5 });
    const scale = store.getSnapshot();
    expect(scale).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "scale",
      rotationPreview: null,
      scalePreview: { entityId: "entity:rectangle", scale: 1.5 },
    });
    expect(listener).toHaveBeenCalledTimes(2);

    store.setScalePreview({ entityId: "entity:rectangle", scale: 1.5 });
    expect(store.getSnapshot()).toBe(scale);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes canonical rotation preview angles without retaining stale resize state", () => {
    const store = createStudioGesturePreviewStore();
    store.setScalePreview({ entityId: "entity:circle", scale: 2 });
    store.setRotationPreview({ angleRadians: Math.PI / 4, entityId: "entity:circle" });
    const rotation = store.getSnapshot();

    expect(rotation).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "rotation",
      rotationPreview: { angleRadians: Math.PI / 4, entityId: "entity:circle" },
      scalePreview: null,
    });

    store.setRotationPreview({ angleRadians: Math.PI / 4, entityId: "entity:circle" });
    expect(store.getSnapshot()).toBe(rotation);
  });

  it("publishes one multi-entity resize preview without retaining single-entity state", () => {
    const store = createStudioGesturePreviewStore();
    store.setScalePreview({ entityId: "entity:a", scale: 2 });
    store.setGroupResizePreview({
      entities: [
        { delta: { x: -10, y: -5 }, entityId: "entity:a", scale: 1.5 },
        { delta: { x: 10, y: 5 }, entityId: "entity:b", scale: 3 },
      ],
    });
    const preview = store.getSnapshot();

    expect(preview).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: {
        entities: [
          { delta: { x: -10, y: -5 }, entityId: "entity:a", scale: 1.5 },
          { delta: { x: 10, y: 5 }, entityId: "entity:b", scale: 3 },
        ],
      },
      kind: "group-resize",
      rotationPreview: null,
      scalePreview: null,
    });
    store.setGroupResizePreview(preview.groupResizePreview!);
    expect(store.getSnapshot()).toBe(preview);
  });

  it("publishes one multi-entity rotation preview without retaining resize state", () => {
    const store = createStudioGesturePreviewStore();
    store.setGroupResizePreview({
      entities: [{ delta: { x: 1, y: 2 }, entityId: "entity:a", scale: 2 }],
    });
    store.setGroupRotationPreview({
      entities: [
        { angleRadians: Math.PI / 2, delta: { x: 20, y: 30 }, entityId: "entity:a" },
        { angleRadians: Math.PI / 2, delta: { x: -20, y: -30 }, entityId: "entity:b" },
      ],
    });
    const preview = store.getSnapshot();

    expect(preview).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupResizePreview: null,
      groupRotationPreview: {
        entities: [
          { angleRadians: Math.PI / 2, delta: { x: 20, y: 30 }, entityId: "entity:a" },
          { angleRadians: Math.PI / 2, delta: { x: -20, y: -30 }, entityId: "entity:b" },
        ],
      },
      kind: "group-rotation",
      rotationPreview: null,
      scalePreview: null,
    });
    store.setGroupRotationPreview(preview.groupRotationPreview!);
    expect(store.getSnapshot()).toBe(preview);
  });

  it("clears an active preview once and stops notifying unsubscribed listeners", () => {
    const store = createStudioGesturePreviewStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setScalePreview({ entityId: "entity:circle", scale: 2 });
    const active = store.getSnapshot();
    store.clear();
    const cleared = store.getSnapshot();

    expect(cleared).not.toBe(active);
    expect(cleared.kind).toBe("idle");
    expect(listener).toHaveBeenCalledTimes(2);

    store.clear();
    expect(store.getSnapshot()).toBe(cleared);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.setDragPreview({ delta: { x: 1, y: 1 }, entityIds: ["entity:circle"] });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
