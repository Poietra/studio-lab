import { describe, expect, it, vi } from "vitest";

import { createStudioGesturePreviewStore } from "./studio-gesture-preview-store";

const SYNCHRONOUS_FRAME_SCHEDULER = {
  cancelFrame() {},
  requestFrame(callback: FrameRequestCallback) {
    callback(0);
    return 0;
  },
};

function createFrameScheduler() {
  let callback: FrameRequestCallback | null = null;
  return {
    cancelFrame: vi.fn(() => {
      callback = null;
    }),
    flush() {
      const scheduled = callback;
      callback = null;
      scheduled?.(0);
    },
    requestFrame: vi.fn((scheduled: FrameRequestCallback) => {
      callback = scheduled;
      return 1;
    }),
  };
}

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
    const store = createStudioGesturePreviewStore(SYNCHRONOUS_FRAME_SCHEDULER);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDragPreview({ delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"], guides: [] });
    const first = store.getSnapshot();

    expect(first).toEqual({
      dragPreview: { delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"], guides: [] },
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "drag",
      rotationPreview: null,
      scalePreview: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    store.setDragPreview({ delta: { x: 12, y: -4 }, entityIds: ["entity:a", "entity:b"], guides: [] });
    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setDragPreview({
      delta: { x: 12, y: -4 },
      entityIds: ["entity:a", "entity:b"],
      guides: ["frame-center-x"],
    });
    const guided = store.getSnapshot();
    expect(guided).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);

    store.setDragPreview({
      delta: { x: 12, y: -4 },
      entityIds: ["entity:a", "entity:b"],
      guides: ["frame-center-x"],
    });
    expect(store.getSnapshot()).toBe(guided);
    expect(listener).toHaveBeenCalledTimes(2);

    store.setDragPreview({
      delta: { x: 12, y: -4 },
      entityIds: ["entity:a", "entity:b"],
      guides: [{ axis: "x", entityId: "entity:target", kind: "object", position: 320 }],
    });
    const objectGuided = store.getSnapshot();
    expect(objectGuided).not.toBe(guided);
    expect(listener).toHaveBeenCalledTimes(3);

    store.setDragPreview({
      delta: { x: 12, y: -4 },
      entityIds: ["entity:a", "entity:b"],
      guides: [{ axis: "x", entityId: "entity:target", kind: "object", position: 320 }],
    });
    expect(store.getSnapshot()).toBe(objectGuided);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("compares geometry and scale previews by their observable values", () => {
    const store = createStudioGesturePreviewStore(SYNCHRONOUS_FRAME_SCHEDULER);
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

    store.setScalePreview({ entityId: "entity:rectangle", guides: ["frame-right"], scale: 1.5 });
    const scale = store.getSnapshot();
    expect(scale).toEqual({
      dragPreview: null,
      geometryPreview: null,
      groupRotationPreview: null,
      groupResizePreview: null,
      kind: "scale",
      rotationPreview: null,
      scalePreview: { entityId: "entity:rectangle", guides: ["frame-right"], scale: 1.5 },
    });
    expect(listener).toHaveBeenCalledTimes(2);

    store.setScalePreview({ entityId: "entity:rectangle", guides: ["frame-right"], scale: 1.5 });
    expect(store.getSnapshot()).toBe(scale);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes canonical rotation preview angles without retaining stale resize state", () => {
    const store = createStudioGesturePreviewStore();
    store.setScalePreview({ entityId: "entity:circle", guides: [], scale: 2 });
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
    store.setScalePreview({ entityId: "entity:a", guides: [], scale: 2 });
    store.setGroupResizePreview({
      entities: [
        { delta: { x: -10, y: -5 }, entityId: "entity:a", scale: 1.5 },
        { delta: { x: 10, y: 5 }, entityId: "entity:b", scale: 3 },
      ],
      guides: [],
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
        guides: [],
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
      guides: [],
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
    const store = createStudioGesturePreviewStore(SYNCHRONOUS_FRAME_SCHEDULER);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setScalePreview({ entityId: "entity:circle", guides: [], scale: 2 });
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
    store.setDragPreview({ delta: { x: 1, y: 1 }, entityIds: ["entity:circle"], guides: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("exposes the latest pointer update immediately and notifies once on the next frame", () => {
    const scheduler = createFrameScheduler();
    const store = createStudioGesturePreviewStore(scheduler);
    const observed = vi.fn(() => store.getSnapshot());
    store.subscribe(observed);

    store.setDragPreview({ delta: { x: 1, y: 2 }, entityIds: ["entity:circle"], guides: [] });
    store.setDragPreview({ delta: { x: 3, y: 4 }, entityIds: ["entity:circle"], guides: [] });
    store.setDragPreview({ delta: { x: 5, y: 6 }, entityIds: ["entity:circle"], guides: [] });

    expect(store.getSnapshot().dragPreview?.delta).toEqual({ x: 5, y: 6 });
    expect(observed).not.toHaveBeenCalled();
    expect(scheduler.requestFrame).toHaveBeenCalledTimes(1);

    scheduler.flush();

    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLastReturnedWith(store.getSnapshot());

    store.setDragPreview({ delta: { x: 7, y: 8 }, entityIds: ["entity:circle"], guides: [] });
    expect(scheduler.requestFrame).toHaveBeenCalledTimes(2);
  });

  it("publishes the final state when a gesture changes kind or clears before the frame", () => {
    const scheduler = createFrameScheduler();
    const store = createStudioGesturePreviewStore(scheduler);
    const observedKinds: string[] = [];
    const unsubscribe = store.subscribe(() => observedKinds.push(store.getSnapshot().kind));

    store.setDragPreview({ delta: { x: 1, y: 2 }, entityIds: ["entity:circle"], guides: [] });
    store.setScalePreview({ entityId: "entity:circle", guides: [], scale: 2 });
    store.clear();

    expect(store.getSnapshot().kind).toBe("idle");
    expect(scheduler.requestFrame).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(observedKinds).toEqual(["idle"]);

    store.setScalePreview({ entityId: "entity:circle", guides: [], scale: 3 });
    scheduler.flush();
    expect(observedKinds).toEqual(["idle", "scale"]);

    store.clear();
    expect(store.getSnapshot().kind).toBe("idle");
    scheduler.flush();
    expect(observedKinds).toEqual(["idle", "scale", "idle"]);

    store.setDragPreview({ delta: { x: 4, y: 5 }, entityIds: ["entity:circle"], guides: [] });
    unsubscribe();
    expect(scheduler.cancelFrame).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(observedKinds).toEqual(["idle", "scale", "idle"]);
  });
});
