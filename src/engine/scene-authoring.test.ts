import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseVerifiedSceneIrBundleV1 } from "./contracts";
import {
  type CreateSceneEntitiesWireCommandV1,
  createCreateSceneEntitiesCompiler,
  createRotateSceneEntityCompiler,
  createSetSubtreeVectorPaintAlphaCompiler,
  createTransformSceneEntityCompiler,
  type RotateSceneEntityWireCommandV1,
  type SetSubtreeVectorPaintAlphaWireCommandV1,
  type TransformSceneEntityWireCommandV1,
} from "./scene-authoring";

const createEntitiesCommand: CreateSceneEntitiesWireCommandV1 = {
  entities: [
    {
      fadeIn: { end: 0.9 },
      geometry: { height: 2, kind: "rectangle", width: 4 },
      id: "tx:create/entity:rectangle",
      instantTransform: { at: 1.25, position: { x: 3, y: 1 }, scaleX: 1.5, scaleY: 0.75 },
      lifetime: { end: 2.4, start: 0.5 },
      position: { x: 2, y: 0 },
      scale: 1,
    },
  ],
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "d".repeat(64),
  provenance: {
    evidence: ["Studio entity creation"],
    id: "studio-edit:create-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.create-scene-entities",
  timelineInsertions: [
    { at: 0.5, duration: 0.2 },
    { at: 0.7, duration: 0.2 },
  ],
  version: 1,
};

const command: RotateSceneEntityWireCommandV1 = {
  angleRadians: Math.PI / 6,
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "b".repeat(64),
  pivot: { x: 1.25, y: -0.5 },
  provenance: {
    evidence: ["Studio inspector rotation"],
    id: "studio-edit:rotation-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.rotate-scene-entity",
  version: 1,
};

const transformCommand: TransformSceneEntityWireCommandV1 = {
  delta: { x: 2.5, y: -1.5 },
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "f".repeat(64),
  provenance: {
    evidence: ["Studio atomic transform"],
    id: "studio-edit:transform-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.transform-scene-entity",
  uniformScale: { factor: 1.5, pivot: { x: 1.25, y: -0.5 } },
  version: 1,
};

const setSubtreeVectorPaintAlphaCommand: SetSubtreeVectorPaintAlphaWireCommandV1 = {
  alpha: 0.25,
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "e".repeat(64),
  provenance: {
    evidence: ["Studio subtree vector paint alpha"],
    id: "studio-edit:subtree-vector-paint-alpha-1",
    origin: "studio-edit-program",
  },
  rootEntityId: "root",
  schema: "poietra.set-subtree-vector-paint-alpha",
  version: 1,
};

async function fixtureBundle() {
  const fixture = JSON.parse(
    await readFile(new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url), "utf8"),
  ) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

describe("Scene authoring WASM adapter", () => {
  it("forwards one exact entity-creation command and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createCreateSceneEntitiesCompiler(async () => ({
      createSceneEntitiesV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, createEntitiesCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(createEntitiesCommand);
  });

  it("forwards one profile-free command and accepts only a verified complete bundle", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createRotateSceneEntityCompiler(async () => ({
      rotateSceneEntityV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, command);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(command);
  });

  it("forwards one exact atomic root transform and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createTransformSceneEntityCompiler(async () => ({
      transformSceneEntityV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, transformCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(transformCommand);
  });

  it("forwards the exact subtree vector-paint command and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createSetSubtreeVectorPaintAlphaCompiler(async () => ({
      setSubtreeVectorPaintAlphaV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, setSubtreeVectorPaintAlphaCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(setSubtreeVectorPaintAlphaCommand);
  });

  it("rejects malformed or incomplete Rust responses", async () => {
    const bundle = await fixtureBundle();
    const compileCreation = createCreateSceneEntitiesCompiler(async () => ({
      createSceneEntitiesV1: () => new TextEncoder().encode("null"),
    }));
    const compileRotation = createRotateSceneEntityCompiler(async () => ({
      rotateSceneEntityV1: () => new TextEncoder().encode('{"scene":{}}'),
    }));
    const compileSetPaintAlpha = createSetSubtreeVectorPaintAlphaCompiler(async () => ({
      setSubtreeVectorPaintAlphaV1: () => new TextEncoder().encode("[]"),
    }));
    const compileTransform = createTransformSceneEntityCompiler(async () => ({
      transformSceneEntityV1: () => new TextEncoder().encode("{}"),
    }));

    await expect(compileCreation(bundle, createEntitiesCommand)).rejects.toThrow();
    await expect(compileRotation(bundle, command)).rejects.toThrow();
    await expect(compileSetPaintAlpha(bundle, setSubtreeVectorPaintAlphaCommand)).rejects.toThrow();
    await expect(compileTransform(bundle, transformCommand)).rejects.toThrow();
  });
});
