import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseVerifiedSceneIrBundleV1 } from "./contracts";
import {
  type ApplyStaticRootTransformEditWireCommandV1,
  type ApplyStudioCreationEditWireCommandV1,
  type CreateSceneMotionWireCommandV1,
  createApplyStaticRootTransformEditCompiler,
  createApplyStudioCreationEditCompiler,
  createCreateSceneMotionCompiler,
  createEditSceneTimelineCompiler,
  createRotateSceneEntityCompiler,
  createSetSubtreeVectorPaintAlphaCompiler,
  createTransformSceneEntityAtTimeCompiler,
  createTransformSceneEntityCompiler,
  type EditSceneTimelineWireCommandV1,
  type RotateSceneEntityWireCommandV1,
  type SetSubtreeVectorPaintAlphaWireCommandV1,
  type TransformSceneEntityAtTimeWireCommandV1,
  type TransformSceneEntityWireCommandV1,
} from "./scene-authoring";

const staticRootTransformEditCommand: ApplyStaticRootTransformEditWireCommandV1 = {
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  nextRevision: "7".repeat(64),
  operations: [
    {
      anchorSeconds: 0,
      entityId: "source:circle",
      id: "move-circle",
      interval: { end: 0, start: 0 },
      kind: "position",
      loweringSupported: true,
      origin: "direct-manipulation",
      position: { x: 400, y: 180 },
      programOrigin: "direct-manipulation",
      validationValid: true,
    },
  ],
  schema: "poietra.apply-static-root-transform-edit",
  sourceRuntimeBindings: [{ runtimeEntityId: "later", sourceIdentityKey: "circle", sourceName: "circle" }],
  studioEntities: [
    {
      dimensions: { radius: 0.5 },
      id: "source:circle",
      kind: "circle",
      objectGraphKey: "source:circle",
      position: { x: 360, y: 180 },
      provisional: false,
      scale: 1,
      sourceIdentity: "circle",
    },
  ],
  version: 1,
  viewport: { height: 360, width: 640 },
};

const creationEditCommand: ApplyStudioCreationEditWireCommandV1 = {
  evaluatedDuration: 2.4,
  evaluatedEntities: [
    {
      contentSampleTexParts: [],
      contentTexParts: null,
      id: "tx:create/entity:rectangle",
      kind: "rectangle",
      lifetimes: [{ end: 2.4, start: 0.5 }],
      objectGraphKey: "tx:create/entity:rectangle",
      sourceIdentity: null,
      transactionId: "create",
    },
  ],
  evaluatedEvents: [
    { interval: { end: 0.5, start: 0.5 }, operationId: "create-rectangle" },
    { interval: { end: 0.5, start: 0.5 }, operationId: "position-rectangle" },
    { interval: { end: 0.9, start: 0.5 }, operationId: "fade-rectangle" },
  ],
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  mathTexOutlines: [],
  nextRevision: "d".repeat(64),
  programs: [
    {
      anchorSeconds: 0.5,
      loweringSupported: true,
      operations: [
        {
          entity: {
            dimensions: { height: 2, width: 4 },
            id: "tx:create/entity:rectangle",
            kind: "rectangle",
            lifetimeStart: 0.5,
            texParts: null,
          },
          id: "create-rectangle",
          interval: { end: 0.5, start: 0.5 },
          kind: "create",
        },
        {
          entityId: "tx:create/entity:rectangle",
          id: "position-rectangle",
          interval: { end: 0.5, start: 0.5 },
          kind: "position",
          position: { x: 320, y: 180 },
        },
        {
          entityId: "tx:create/entity:rectangle",
          id: "fade-rectangle",
          interval: { end: 0.9, start: 0.5 },
          kind: "fade-in",
          persistent: true,
        },
      ],
      scheduleOrder: ["create-rectangle", "position-rectangle", "fade-rectangle"],
      transactionId: "create",
      validationValid: true,
    },
  ],
  schema: "poietra.apply-studio-creation-edit",
  version: 1,
  viewport: { height: 360, width: 640 },
};

const createMotionCommand: CreateSceneMotionWireCommandV1 = {
  controlOffset: { x: 0.5, y: 1 },
  delta: { x: 3, y: -2 },
  easing: "smooth",
  expectedBaseRevision: "a".repeat(64),
  interval: { end: 2, start: 0.5 },
  nextRevision: "9".repeat(64),
  provenance: {
    evidence: ["Studio pointer motion"],
    id: "studio-edit:motion-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.create-scene-motion",
  targetEntityIds: ["later"],
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
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  intent: {
    delta: { x: 2.5, y: -1.5 },
    kind: "relative",
    scale: { pivot: { x: 1.25, y: -0.5 }, xFactor: 1.5, yFactor: 1.5 },
  },
  nextRevision: "f".repeat(64),
  provenance: {
    evidence: ["Studio atomic transform"],
    id: "studio-edit:transform-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.transform-scene-entity",
  version: 1,
};

const verifiedTransformCommand: TransformSceneEntityWireCommandV1 = {
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  intent: {
    baseline: { height: 1, kind: "world-size", width: 1, worldCenter: { x: 1, y: 0 } },
    kind: "from-baseline",
    scale: { xFactor: 1.5, yFactor: 0.75 },
    targetCenter: { x: 2.25, y: -0.5 },
  },
  nextRevision: "8".repeat(64),
  provenance: {
    evidence: ["Studio geometry-verified transform"],
    id: "studio-edit:verified-transform-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.transform-scene-entity",
  version: 1,
};

const timedTransformCommand: TransformSceneEntityAtTimeWireCommandV1 = {
  at: 1.5,
  delta: { x: 2.5, y: -1.5 },
  entityId: transformCommand.entityId,
  expectedBaseRevision: transformCommand.expectedBaseRevision,
  nextRevision: transformCommand.nextRevision,
  provenance: transformCommand.provenance,
  scale: { pivot: { x: 1.25, y: -0.5 }, xFactor: 1.5, yFactor: 1.5 },
  schema: "poietra.transform-scene-entity-at-time",
  version: 1,
};

const editTimelineCommand: EditSceneTimelineWireCommandV1 = {
  edits: [
    { at: 2, duration: 1.5, kind: "insert-wait" },
    { at: 3.5, kind: "trim-scene-duration", removedDuration: 0.5, targetDuration: 3 },
  ],
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "c".repeat(64),
  provenance: {
    evidence: ["Studio Scene duration control"],
    id: "studio-edit:timeline-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.edit-scene-timeline",
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
  it("forwards one complete static imported-root edit command without reconstructing it", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createApplyStaticRootTransformEditCompiler(async () => ({
      applyStaticRootTransformEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, staticRootTransformEditCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(staticRootTransformEditCommand);
  });

  it("forwards one complete normalized Studio creation edit and base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createApplyStudioCreationEditCompiler(async () => ({
      applyStudioCreationEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, creationEditCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(creationEditCommand);
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

  it("forwards one geometry-verified root transform and complete base snapshot", async () => {
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

    const result = await compile(bundle, verifiedTransformCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(verifiedTransformCommand);
  });

  it("forwards one exact motion command and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createCreateSceneMotionCompiler(async () => ({
      createSceneMotionV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, createMotionCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(createMotionCommand);
  });

  it("forwards one exact timed root transform and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createTransformSceneEntityAtTimeCompiler(async () => ({
      transformSceneEntityAtTimeV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, timedTransformCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(timedTransformCommand);
  });

  it("forwards one ordered atomic Scene timeline command and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createEditSceneTimelineCompiler(async () => ({
      editSceneTimelineV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, editTimelineCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(editTimelineCommand);
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
    const compileCreation = createApplyStudioCreationEditCompiler(async () => ({
      applyStudioCreationEditV1: () => new TextEncoder().encode("null"),
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
    const compileTimeline = createEditSceneTimelineCompiler(async () => ({
      editSceneTimelineV1: () => new TextEncoder().encode("false"),
    }));

    await expect(compileCreation(bundle, creationEditCommand)).rejects.toThrow();
    await expect(compileRotation(bundle, command)).rejects.toThrow();
    await expect(compileSetPaintAlpha(bundle, setSubtreeVectorPaintAlphaCommand)).rejects.toThrow();
    await expect(compileTransform(bundle, transformCommand)).rejects.toThrow();
    await expect(compileTimeline(bundle, editTimelineCommand)).rejects.toThrow();
  });
});
