import { describe, expect, it } from "vitest";
import { planStudioLayerOrder, projectStudioLayers } from "./layer-order";
import type { ProjectedEntity } from "./model";

function entity(id: string, sourceIdentity: ProjectedEntity["sourceIdentity"]): ProjectedEntity {
  return {
    geometry: {
      dimensions: { kind: "known", value: {} },
      position: { kind: "known", value: { x: 0, y: 0 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id,
    opacity: 1,
    position: { x: 0, y: 0 },
    present: true,
    provisional: false,
    scale: 1,
    sourceIdentity,
    type: "Circle",
  };
}

function layers() {
  return projectStudioLayers({
    canonicalEntities: [
      { id: "runtime:imported", sceneOrder: 0, sourceZIndex: 2 },
      { id: "studio:a", sceneOrder: 1, sourceZIndex: 3 },
      { id: "studio:b", sceneOrder: 2, sourceZIndex: 4 },
    ],
    creationSourceAnchors: new Map([
      ["studio:a", 0],
      ["studio:b", 1],
    ]),
    entities: [
      entity("imported", { kind: "known", value: "circle" }),
      entity("studio:a", { kind: "unknown", reason: "Studio-created" }),
      entity("studio:b", { kind: "unknown", reason: "Studio-created" }),
    ],
    sourceRuntimeIdentity: new Map([["circle", { entityId: "runtime:imported" }]]),
  });
}

describe("Studio Layers paint order", () => {
  it("projects the canonical Scene order front-first and keeps imported rows read-only", () => {
    const projected = layers();

    expect(projected.map(({ entity: item }) => item.id)).toEqual(["studio:b", "studio:a", "imported"]);
    expect(projected[2].readOnlyReason).toMatch(/round-trip is not supported/i);
    expect(projected[0].canMove.front).toBe(false);
    expect(projected[1].canMove.forward).toBe(true);
  });

  it("chooses one canonical z-index for one-step and edge movement", () => {
    const projected = layers();

    expect(planStudioLayerOrder(projected, "studio:a", "forward")).toEqual({
      kind: "planned",
      sourceAnchor: 0,
      sourceZIndex: 5,
    });
    expect(planStudioLayerOrder(projected, "studio:a", "back")).toEqual({
      kind: "planned",
      sourceAnchor: 0,
      sourceZIndex: 1,
    });
    expect(planStudioLayerOrder(projected, "studio:a", "front")).toEqual({
      kind: "planned",
      sourceAnchor: 0,
      sourceZIndex: 5,
    });
  });

  it("rejects imported targets and ambiguous equal-z adjacency", () => {
    expect(planStudioLayerOrder(layers(), "imported", "front")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/round-trip/i),
    });
    const tied = projectStudioLayers({
      canonicalEntities: [
        { id: "studio:a", sceneOrder: 0, sourceZIndex: 1 },
        { id: "studio:b", sceneOrder: 1, sourceZIndex: 1 },
      ],
      creationSourceAnchors: new Map([
        ["studio:a", 0],
        ["studio:b", 0],
      ]),
      entities: [
        entity("studio:a", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:b", { kind: "unknown", reason: "Studio-created" }),
      ],
      sourceRuntimeIdentity: null,
    });
    expect(planStudioLayerOrder(tied, "studio:a", "forward")).toMatchObject({ kind: "unavailable" });
  });

  it("reports a Studio-created row as waiting while its creation anchor is unavailable", () => {
    const pending = projectStudioLayers({
      canonicalEntities: [],
      creationSourceAnchors: new Map(),
      entities: [
        {
          ...entity("studio:pending", { kind: "unknown", reason: "Studio-created" }),
          transactionId: "create-pending",
        },
      ],
      sourceRuntimeIdentity: null,
    });

    expect(pending[0].readOnlyReason).toMatch(/wait for the canonical preview/i);
    expect(pending[0].readOnlyReason).not.toMatch(/imported manim/i);
  });
});
