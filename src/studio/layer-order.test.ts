import { describe, expect, it } from "vitest";
import {
  filterStudioCanvasEntitiesByVisibility,
  planStudioLayerGroup,
  planStudioLayerGroupOrder,
  planStudioLayerOrder,
  planStudioLayerReorder,
  projectStudioLayers,
  selectedStudioLayerGroup,
  selectionContainsGroupedChild,
} from "./layer-order";
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

  it("chooses the canonical slot requested by a front-first drag", () => {
    const projected = layers();

    expect(planStudioLayerReorder(projected, "studio:a", 0)).toEqual({
      kind: "planned",
      sourceAnchor: 0,
      sourceZIndex: 5,
    });
    expect(planStudioLayerReorder(projected, "studio:a", 2)).toEqual({
      kind: "planned",
      sourceAnchor: 0,
      sourceZIndex: 1,
    });
    expect(planStudioLayerReorder(projected, "studio:b", 1)).toEqual({
      kind: "planned",
      sourceAnchor: 1,
      sourceZIndex: 2.5,
    });
  });

  it("rejects no-op, invalid, and partially unresolved drag destinations", () => {
    expect(planStudioLayerReorder(layers(), "studio:a", 1)).toMatchObject({ kind: "unavailable" });
    expect(planStudioLayerReorder(layers(), "studio:a", -1)).toMatchObject({ kind: "unavailable" });
    expect(
      planStudioLayerReorder(
        [
          ...layers(),
          {
            canMove: { back: false, backward: false, forward: false, front: false },
            entity: entity("pending", { kind: "unknown", reason: "Studio-created" }),
            readOnlyReason: "Wait for preview.",
            sceneOrder: null,
            sourceAnchor: 0,
            sourceZIndex: null,
            visibilityReadOnlyReason: "Wait for preview.",
            visible: true,
          },
        ],
        "studio:a",
        0,
      ),
    ).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/every layer/i) });
  });

  it("rejects imported targets and ambiguous equal-z adjacency", () => {
    expect(planStudioLayerOrder(layers(), "imported", "front")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/round-trip/i),
    });
    expect(planStudioLayerReorder(layers(), "imported", 0)).toMatchObject({
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

  it("keeps hidden rows in Layers while removing only their Canvas overlay", () => {
    const projected = projectStudioLayers({
      canonicalEntities: [
        { id: "studio:visible", sceneOrder: 0, sourceZIndex: 0 },
        { id: "studio:hidden", sceneOrder: 1, sourceZIndex: 1, visible: false },
      ],
      creationSourceAnchors: new Map([
        ["studio:visible", 0],
        ["studio:hidden", 0],
      ]),
      entities: [
        entity("studio:visible", { kind: "unknown", reason: "Studio-created" }),
        {
          ...entity("studio:hidden", { kind: "unknown", reason: "Studio-created" }),
          transactionId: "tx:create-hidden",
        },
      ],
      sourceRuntimeIdentity: null,
    });

    expect(projected.find(({ entity: item }) => item.id === "studio:hidden")?.visible).toBe(false);
    expect(
      filterStudioCanvasEntitiesByVisibility(
        projected.map(({ entity: item }) => item),
        [{ id: "studio:visible" }, { id: "studio:hidden", visible: false }],
      ).map(({ id }) => id),
    ).toEqual(["studio:visible"]);
  });

  it("projects one-level groups and plans only contiguous visible root leaves", () => {
    const projected = projectStudioLayers({
      canonicalEntities: [
        { geometry: { kind: "group" }, id: "tx:group/entity:group", parentId: null, sceneOrder: 3, sourceZIndex: 1 },
        { id: "studio:a", parentId: "tx:group/entity:group", sceneOrder: 0, sourceZIndex: 0 },
        { id: "studio:b", parentId: "tx:group/entity:group", sceneOrder: 1, sourceZIndex: 1 },
        { id: "studio:c", parentId: null, sceneOrder: 2, sourceZIndex: 2 },
      ],
      creationSourceAnchors: new Map([
        ["studio:a", 0],
        ["studio:b", 0],
        ["studio:c", 0],
      ]),
      entities: [
        entity("studio:a", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:b", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:c", { kind: "unknown", reason: "Studio-created" }),
      ],
      sourceRuntimeIdentity: null,
    });

    expect(projected.map((entry) => (entry.isGroup ? entry.groupId : entry.entity.id))).toEqual([
      "studio:c",
      "tx:group/entity:group",
      "studio:b",
      "studio:a",
    ]);
    const selected = new Set(["studio:a", "studio:b"]);
    expect(selectedStudioLayerGroup(projected, selected)?.groupId).toBe("tx:group/entity:group");
    expect(selectedStudioLayerGroup(projected, selected)).toMatchObject({
      visibilityReadOnlyReason: null,
      visible: true,
    });
    expect(selectionContainsGroupedChild(projected, new Set(["studio:a"]))).toBe(true);
    expect(planStudioLayerGroup(projected, selected)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/nested/i),
    });
    const outsideRoot = projected.find(({ entity: item }) => item.id === "studio:c");
    expect(outsideRoot?.canMove).toEqual({ back: false, backward: false, forward: false, front: false });
    expect(outsideRoot?.orderingReadOnlyReason).toMatch(/logical group as one layer/i);
    expect(planStudioLayerOrder(projected, "studio:c", "back")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/logical group as one layer/i),
    });
    expect(planStudioLayerReorder(projected, "studio:c", 0)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/logical group as one layer/i),
    });
    expect(planStudioLayerGroupOrder(projected, "tx:group/entity:group", "front")).toEqual({
      kind: "planned",
      targets: [
        { entityId: "studio:a", fromSourceZIndex: 0, sourceZIndex: 3 },
        { entityId: "studio:b", fromSourceZIndex: 1, sourceZIndex: 4 },
      ],
    });
    expect(planStudioLayerGroupOrder(projected, "tx:group/entity:group", "back")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/already at the back edge/i),
    });
    expect(planStudioLayerGroupOrder(projected, "tx:group/entity:group", "forward")).toEqual({
      kind: "planned",
      targets: [
        { entityId: "studio:a", fromSourceZIndex: 0, sourceZIndex: 3 },
        { entityId: "studio:b", fromSourceZIndex: 1, sourceZIndex: 4 },
      ],
    });
    expect(planStudioLayerGroupOrder(projected, "tx:group/entity:group", "backward")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/already at the backward edge/i),
    });
  });

  it("moves a logical group across exactly one adjacent paint block", () => {
    const targetGroupId = "tx:target/entity:group";
    const projected = projectStudioLayers({
      canonicalEntities: [
        { id: "back:outer", sceneOrder: 0, sourceZIndex: 0 },
        { id: "back:adjacent", sceneOrder: 1, sourceZIndex: 1 },
        { geometry: { kind: "group" }, id: targetGroupId, sceneOrder: 6, sourceZIndex: 2 },
        { id: "studio:a", parentId: targetGroupId, sceneOrder: 2, sourceZIndex: 2 },
        { id: "studio:b", parentId: targetGroupId, sceneOrder: 3, sourceZIndex: 3 },
        { id: "front:adjacent", sceneOrder: 4, sourceZIndex: 4 },
        { id: "front:outer", sceneOrder: 5, sourceZIndex: 5 },
      ],
      creationSourceAnchors: new Map([
        ["back:outer", 0],
        ["back:adjacent", 0],
        ["studio:a", 0],
        ["studio:b", 0],
        ["front:adjacent", 0],
        ["front:outer", 0],
      ]),
      entities: ["back:outer", "back:adjacent", "studio:a", "studio:b", "front:adjacent", "front:outer"].map((id) =>
        entity(id, { kind: "unknown", reason: "Studio-created" }),
      ),
      sourceRuntimeIdentity: null,
    });

    expect(planStudioLayerGroupOrder(projected, targetGroupId, "backward")).toEqual({
      kind: "planned",
      targets: [
        { entityId: "studio:a", fromSourceZIndex: 2, sourceZIndex: 1 / 3 },
        { entityId: "studio:b", fromSourceZIndex: 3, sourceZIndex: 2 / 3 },
      ],
    });
    expect(planStudioLayerGroupOrder(projected, targetGroupId, "forward")).toEqual({
      kind: "planned",
      targets: [
        { entityId: "studio:a", fromSourceZIndex: 2, sourceZIndex: 13 / 3 },
        { entityId: "studio:b", fromSourceZIndex: 3, sourceZIndex: 14 / 3 },
      ],
    });
    expect(
      planStudioLayerGroupOrder(
        projected.map((entry) => (entry.entity.id === "front:outer" ? { ...entry, sourceZIndex: null } : entry)),
        targetGroupId,
        "forward",
      ),
    ).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/every layer/i) });
  });

  it("crosses an adjacent logical group as one block", () => {
    const targetGroupId = "tx:target/entity:group";
    const adjacentGroupId = "tx:adjacent/entity:group";
    const projected = projectStudioLayers({
      canonicalEntities: [
        { geometry: { kind: "group" }, id: targetGroupId, sceneOrder: 5, sourceZIndex: 0 },
        { id: "target:a", parentId: targetGroupId, sceneOrder: 0, sourceZIndex: 0 },
        { id: "target:b", parentId: targetGroupId, sceneOrder: 1, sourceZIndex: 1 },
        { geometry: { kind: "group" }, id: adjacentGroupId, sceneOrder: 6, sourceZIndex: 2 },
        { id: "adjacent:a", parentId: adjacentGroupId, sceneOrder: 2, sourceZIndex: 2 },
        { id: "adjacent:b", parentId: adjacentGroupId, sceneOrder: 3, sourceZIndex: 3 },
        { id: "outside", sceneOrder: 4, sourceZIndex: 4 },
      ],
      creationSourceAnchors: new Map(
        ["target:a", "target:b", "adjacent:a", "adjacent:b", "outside"].map((id) => [id, 0]),
      ),
      entities: ["target:a", "target:b", "adjacent:a", "adjacent:b", "outside"].map((id) =>
        entity(id, { kind: "unknown", reason: "Studio-created" }),
      ),
      sourceRuntimeIdentity: null,
    });

    expect(planStudioLayerGroupOrder(projected, targetGroupId, "forward")).toEqual({
      kind: "planned",
      targets: [
        { entityId: "target:a", fromSourceZIndex: 0, sourceZIndex: 10 / 3 },
        { entityId: "target:b", fromSourceZIndex: 1, sourceZIndex: 11 / 3 },
      ],
    });
  });

  it("derives group visibility from every canonical child", () => {
    const projected = projectStudioLayers({
      canonicalEntities: [
        { geometry: { kind: "group" }, id: "tx:group/entity:group", sceneOrder: 2, sourceZIndex: 1 },
        { id: "studio:a", parentId: "tx:group/entity:group", sceneOrder: 0, sourceZIndex: 0 },
        {
          id: "studio:b",
          parentId: "tx:group/entity:group",
          sceneOrder: 1,
          sourceZIndex: 1,
          visible: false,
        },
      ],
      creationSourceAnchors: new Map([
        ["studio:a", 0],
        ["studio:b", 0.5],
      ]),
      entities: [
        entity("studio:a", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:b", { kind: "unknown", reason: "Studio-created" }),
      ],
      sourceRuntimeIdentity: null,
    });

    expect(projected.find(({ isGroup }) => isGroup)).toMatchObject({
      visibilityReadOnlyReason: null,
      visible: false,
    });
  });

  it("rejects hidden, rotation-keyframed, and non-contiguous grouping targets", () => {
    const projected = layers();
    expect(planStudioLayerGroup(projected, new Set(["studio:b", "imported"]))).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/round-trip/i),
    });
    const rotationBlocked = projectStudioLayers({
      canonicalEntities: [
        { id: "studio:a", sceneOrder: 0, sourceZIndex: 0 },
        { id: "studio:b", sceneOrder: 1, sourceZIndex: 1 },
        { id: "studio:c", sceneOrder: 2, sourceZIndex: 2 },
      ],
      creationSourceAnchors: new Map([
        ["studio:a", 0],
        ["studio:b", 0],
        ["studio:c", 0],
      ]),
      entities: [
        entity("studio:a", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:b", { kind: "unknown", reason: "Studio-created" }),
        entity("studio:c", { kind: "unknown", reason: "Studio-created" }),
      ],
      rotationKeyframeEntityIds: new Set(["studio:b"]),
      sourceRuntimeIdentity: null,
    });
    expect(planStudioLayerGroup(rotationBlocked, new Set(["studio:a", "studio:b"]))).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/rotation keyframes/i),
    });
    expect(planStudioLayerGroup(rotationBlocked, new Set(["studio:a", "studio:c"]))).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/contiguous/i),
    });
  });
});
