import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { digestAssetManifestV1 } from "./asset-manifest";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import {
  createSceneIrDeltaV1,
  MAX_SCENE_DELTA_JSON_BYTES,
  MAX_SCENE_DELTA_OPERATIONS,
  parseSceneIrDeltaV1,
  type SceneIrDeltaV1,
} from "./scene-delta";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

async function fixtureBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

function delta(operations: SceneIrDeltaV1["operations"], overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    baseRevision: REVISION_A,
    nextRevision: REVISION_B,
    nextSource: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: REVISION_B },
    operations,
    sceneId: "shared:circle-opacity",
    schema: "poietra.scene-delta",
    version: 1,
    ...overrides,
  };
}

describe("Scene IR delta v1", () => {
  it("deterministically produces only changed records", async () => {
    const base = await fixtureBundle();
    const earlier = base.scene.entities.find(({ id }) => id === "earlier");
    const later = base.scene.entities.find(({ id }) => id === "later");
    const channel = base.scene.animationChannels[0];
    if (!earlier || !later || !channel || channel.kind !== "opacity") throw new Error("fixture is incomplete");
    const added = {
      ...later,
      id: "added",
      sceneOrder: 3,
      sourceZIndex: 0,
      transform: { ...later.transform, tx: 4 },
    };
    const replacementChannel = { ...channel, entityId: "later", id: "opacity:later" };
    const next: SceneIrBundleV1 = {
      ...base,
      scene: {
        ...base.scene,
        animationChannels: [replacementChannel],
        duration: 3,
        entities: [later, { ...earlier, transform: { ...earlier.transform, tx: -2 } }, added],
        source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: REVISION_B },
      },
    };

    const produced = await createSceneIrDeltaV1(base, next);
    expect(produced?.operations.map((operation) => operation.kind)).toEqual([
      "remove-animation-channel",
      "remove-entity",
      "put-entity",
      "put-entity",
      "put-animation-channel",
      "update-scene",
    ]);
    expect(produced?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: expect.objectContaining({ id: "added" }), expected: "absent" }),
        expect.objectContaining({ entity: expect.objectContaining({ id: "earlier" }), expected: "present" }),
        expect.objectContaining({ duration: 3, kind: "update-scene" }),
      ]),
    );
    expect(await createSceneIrDeltaV1(base, next)).toEqual(produced);
  });

  it("keeps the TypeScript producer synchronized with the native core fixture", async () => {
    const base = await fixtureBundle();
    const shared = JSON.parse(
      await readFile(new URL("../../fixtures/engine-v1/shared-single-entity-delta.json", import.meta.url), "utf8"),
    ) as Readonly<{
      delta: SceneIrDeltaV1;
      expected: Readonly<{ entityId: string; revision: string; tx: number }>;
    }>;
    const next: SceneIrBundleV1 = {
      ...base,
      scene: {
        ...base.scene,
        entities: base.scene.entities.map((entity) =>
          entity.id === shared.expected.entityId
            ? { ...entity, transform: { ...entity.transform, tx: shared.expected.tx } }
            : entity,
        ),
        source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: shared.expected.revision },
      },
    };

    await expect(createSceneIrDeltaV1(base, next)).resolves.toEqual(shared.delta);
  });

  it("selects full replacement when delta operations cannot preserve array order", async () => {
    const base = await fixtureBundle();
    const entity = base.scene.entities[0];
    const channel = base.scene.animationChannels[0];
    if (!entity || !channel || channel.kind !== "opacity") throw new Error("fixture is incomplete");
    const addedA = { ...entity, id: "a-added", sceneOrder: base.scene.entities.length };
    const addedZ = { ...entity, id: "z-added", sceneOrder: base.scene.entities.length + 1 };
    const nextSource = {
      editProgramVersion: 1 as const,
      kind: "studio-edit-program" as const,
      revisionHash: REVISION_B,
    };

    await expect(
      createSceneIrDeltaV1(base, {
        ...base,
        scene: { ...base.scene, entities: [...base.scene.entities, addedZ, addedA], source: nextSource },
      }),
    ).resolves.toBeNull();

    await expect(
      createSceneIrDeltaV1(base, {
        ...base,
        scene: {
          ...base.scene,
          animationChannels: [
            ...base.scene.animationChannels,
            { ...channel, entityId: addedZ.id, id: "opacity:z-added" },
            { ...channel, entityId: addedA.id, id: "opacity:a-added" },
          ],
          entities: [...base.scene.entities, addedA, addedZ],
          source: nextSource,
        },
      }),
    ).resolves.toBeNull();
  });

  it("selects full replacement for source-only, operation-overflow, and byte-overflow revisions", async () => {
    const base = await fixtureBundle();
    const sourceOnly = {
      ...base,
      scene: {
        ...base.scene,
        source: { editProgramVersion: 1 as const, kind: "studio-edit-program" as const, revisionHash: REVISION_B },
      },
    };
    await expect(createSceneIrDeltaV1(base, sourceOnly)).resolves.toBeNull();

    const template = base.scene.entities[0];
    if (!template) throw new Error("fixture entity is missing");
    const operationOverflow = {
      ...sourceOnly,
      scene: {
        ...sourceOnly.scene,
        entities: [
          ...base.scene.entities,
          ...Array.from({ length: MAX_SCENE_DELTA_OPERATIONS + 1 }, (_, index) => ({
            ...template,
            id: `added-${index.toString().padStart(3, "0")}`,
            sceneOrder: base.scene.entities.length + index,
          })),
        ],
      },
    };
    await expect(createSceneIrDeltaV1(base, operationOverflow)).resolves.toBeNull();

    const byteOverflow = {
      ...sourceOnly,
      scene: {
        ...sourceOnly.scene,
        entities: [
          ...base.scene.entities,
          ...Array.from({ length: 250 }, (_, index) => ({
            ...template,
            id: `byte-added-${index.toString().padStart(3, "0")}`,
            sceneOrder: base.scene.entities.length + index,
          })),
        ],
        provenance: [
          ...base.scene.provenance,
          ...Array.from({ length: 10 }, (_, index) => ({
            evidence: Array.from({ length: 64 }, () => "x".repeat(500)),
            id: `large-provenance-${index}`,
            origin: "studio-edit-program" as const,
          })),
        ],
      },
    };
    await expect(createSceneIrDeltaV1(base, byteOverflow)).resolves.toBeNull();

    const assetDraft = {
      ...base.assets,
      manifestDigest: "0".repeat(64),
      manifestId: "manifest:replacement",
    };
    const assets = { ...assetDraft, manifestDigest: await digestAssetManifestV1(assetDraft) };
    const assetChange = {
      assets,
      scene: {
        ...base.scene,
        assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
        source: { editProgramVersion: 1 as const, kind: "studio-edit-program" as const, revisionHash: REVISION_B },
      },
    };
    await expect(createSceneIrDeltaV1(base, assetChange)).resolves.toBeNull();
  });

  it("fails closed on unknown fields, operations, versions, no-op revisions, and count overflow", () => {
    const valid = delta([{ entityId: "stroke", kind: "remove-entity" }]);
    expect(parseSceneIrDeltaV1(valid)).toMatchObject({ baseRevision: REVISION_A, nextRevision: REVISION_B });

    const invalidValues = [
      { ...(valid as object), debug: true },
      { ...(valid as object), version: 2 },
      { ...(valid as object), baseRevision: REVISION_B },
      delta([{ entityId: "stroke", kind: "remove-entity", reason: "caller-owned" } as never]),
      delta([{ entityId: "stroke", kind: "erase-entity" } as never]),
      delta([
        { entityId: "stroke", kind: "remove-entity" },
        { entityId: "stroke", kind: "remove-entity" },
      ]),
      delta([
        { duration: 3, kind: "update-scene" },
        { duration: 4, kind: "update-scene" },
      ]),
      delta(
        Array.from({ length: MAX_SCENE_DELTA_OPERATIONS + 1 }, (_, index) => ({
          entityId: `entity-${index}`,
          kind: "remove-entity" as const,
        })),
      ),
    ];

    for (const value of invalidValues) {
      expect(() => parseSceneIrDeltaV1(value)).toThrowError(
        expect.objectContaining({ code: "invalid-delta", fallback: "full-snapshot" }),
      );
    }
  });

  it("bounds encoded payloads before accepting their structure", () => {
    const oversized = {
      ...(delta([{ entityId: "stroke", kind: "remove-entity" }]) as object),
      padding: "x".repeat(MAX_SCENE_DELTA_JSON_BYTES),
    };
    expect(() => parseSceneIrDeltaV1(oversized)).toThrowError(
      expect.objectContaining({ code: "delta-too-large", fallback: "full-snapshot" }),
    );
  });

  it("validates the exact JSON representation whose bytes were bounded", () => {
    const wireValue = delta([{ entityId: "stroke", kind: "remove-entity" }]);
    const oversizedObject = delta([
      {
        kind: "update-scene",
        provenance: Array.from({ length: 600 }, (_, index) => ({
          evidence: ["x".repeat(500)],
          id: `hidden-${index}`,
          origin: "fixture" as const,
        })),
      },
    ]) as object;
    Object.defineProperty(oversizedObject, "toJSON", { enumerable: false, value: () => wireValue });

    expect(parseSceneIrDeltaV1(oversizedObject)).toEqual(parseSceneIrDeltaV1(wireValue));
  });
});
