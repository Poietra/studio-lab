import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeEntity, RuntimeSceneState } from "./model";
import {
  exactEntityScaleAt,
  magicEditCapabilities,
} from "./magic-edit-capabilities";

function withEntity(
  entity: RuntimeEntity,
  propertyChannels: RuntimeSceneState["propertyChannels"] = STUDIO_FIXTURE_SCENE.propertyChannels,
): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: { [entity.id]: entity },
    },
    propertyChannels,
  };
}

describe("Magic Edit object capabilities", () => {
  it("advertises an exact sampled scale and a known source identity", () => {
    const entity = STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1;
    const scene = {
      ...STUDIO_FIXTURE_SCENE,
      propertyChannels: {
        ...STUDIO_FIXTURE_SCENE.propertyChannels,
        "equation_1/scale": {
          entityId: "equation_1",
          key: "scale",
          samples: [{
            interval: { end: 12, start: 0 },
            kind: "exact",
            provenanceId: "source:scale",
            value: 1.25,
          }],
        },
      },
    } satisfies RuntimeSceneState;

    expect(magicEditCapabilities(scene, entity, 5)).toEqual({
      delete: { kind: "supported" },
      scale: { current: 1.25, kind: "supported" },
    });
  });

  it("fails closed when scale or source identity knowledge is unknown", () => {
    const entity: RuntimeEntity = {
      geometry: {
        dimensions: { kind: "known", value: {} },
        position: { kind: "known", value: { x: 0, y: 0 } },
        scale: { kind: "unknown", reason: "Scale comes from a runtime function." },
        style: { kind: "known", value: {} },
      },
      id: "runtime-object",
      lifetime: [{ end: 12, start: 0 }],
      provisional: false,
      sourceIdentity: { kind: "unknown", reason: "Runtime identity is unresolved." },
      type: "VGroup",
    };
    const scene = withEntity(entity, {});

    expect(exactEntityScaleAt(scene, entity, 5)).toEqual(entity.geometry?.scale);
    expect(magicEditCapabilities(scene, entity, 5)).toEqual({
      delete: { kind: "blocked", reason: "Runtime identity is unresolved." },
      scale: { kind: "blocked", reason: "Scale comes from a runtime function." },
    });
    const missingGeometry = { ...entity, geometry: undefined };
    expect(magicEditCapabilities(withEntity(missingGeometry, {}), missingGeometry, 5)).toEqual({
      delete: { kind: "blocked", reason: "Runtime identity is unresolved." },
      scale: { kind: "blocked", reason: "No exact source scale is available at this time." },
    });
    const forgedTransaction = { ...missingGeometry, transactionId: "unrelated" };
    expect(magicEditCapabilities(withEntity(forgedTransaction, {}), forgedTransaction, 5).delete)
      .toEqual({ kind: "blocked", reason: "Runtime identity is unresolved." });
  });

  it("allows a Studio-generated object that can be rebound during batch export", () => {
    const entity: RuntimeEntity = {
      id: "tx:create/entity:circle",
      lifetime: [{ end: 12, start: 5 }],
      provisional: false,
      sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
      transactionId: "create",
      type: "Circle",
    };
    const scene = withEntity(entity, {});

    expect(magicEditCapabilities(scene, entity, 6)).toEqual({
      delete: { kind: "supported" },
      scale: { current: 1, kind: "supported" },
    });
  });
});
