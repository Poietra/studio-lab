import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EngineContractIntegrityError, parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import { sceneIrSourceRevisionHash } from "./scene-ir";
import { MAX_CANVAS_SCENE_DELTA_ACK_JSON_BYTES } from "./canvas-worker-protocol";
import {
  applySceneIrDeltaV1,
  MAX_SCENE_DELTA_JSON_BYTES,
  MAX_SCENE_DELTA_OPERATIONS,
  parseSceneIrDeltaV1,
  SceneIrDeltaError,
  type SceneIrDeltaV1,
} from "./scene-delta";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const REVISION_C = "c".repeat(64);
const REVISION_D = "d".repeat(64);

async function fixtureBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

async function sharedDeltaFixture() {
  const url = new URL("../../fixtures/engine-v1/shared-single-entity-delta.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Readonly<{
    delta: SceneIrDeltaV1;
    expected: Readonly<{ entityId: string; revision: string; tx: number }>;
    limits: Readonly<{ deltaJsonBytes: number; dirtyAckJsonBytes: number; operations: number }>;
    rejectCases: readonly Readonly<{
      expectedCode: SceneIrDeltaError["code"];
      id: string;
      overrides?: Readonly<Record<string, unknown>>;
      oversizedBytes?: number;
    }>[];
  }>;
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

function expectDeltaError(error: unknown, code: SceneIrDeltaError["code"]) {
  expect(error).toBeInstanceOf(SceneIrDeltaError);
  expect(error).toMatchObject({ code, fallback: "full-snapshot", requiresFullSnapshotFallback: true });
}

describe("Scene IR delta v1", () => {
  it("matches the shared Rust success and rejection corpus without mutating rejected bases", async () => {
    const shared = await sharedDeltaFixture();
    expect(shared.limits).toEqual({
      deltaJsonBytes: MAX_SCENE_DELTA_JSON_BYTES,
      dirtyAckJsonBytes: MAX_CANVAS_SCENE_DELTA_ACK_JSON_BYTES,
      operations: MAX_SCENE_DELTA_OPERATIONS,
    });
    const current = await fixtureBundle();
    const deltaBytes = new TextEncoder().encode(JSON.stringify(shared.delta)).byteLength;
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(current)).byteLength;
    expect(deltaBytes * 2).toBeLessThan(snapshotBytes);

    const result = await applySceneIrDeltaV1(current, shared.delta);
    expect(result.scene.source.kind).toBe("studio-edit-program");
    expect(sceneIrSourceRevisionHash(result.scene)).toBe(shared.expected.revision);
    expect(result.scene.entities.find(({ id }) => id === shared.expected.entityId)?.transform.tx).toBe(
      shared.expected.tx,
    );

    for (const rejection of shared.rejectCases) {
      const pristine = await fixtureBundle();
      const before = structuredClone(pristine);
      const candidate = rejection.oversizedBytes
        ? { ...shared.delta, padding: "x".repeat(rejection.oversizedBytes) }
        : { ...shared.delta, ...rejection.overrides };
      try {
        await applySceneIrDeltaV1(pristine, candidate);
        throw new Error(`expected shared rejection ${rejection.id}`);
      } catch (error) {
        expectDeltaError(error, rejection.expectedCode);
      }
      expect(pristine).toEqual(before);
    }
  });

  it("applies multiple dependent operations atomically and advances the source revision", async () => {
    const current = await fixtureBundle();
    const before = structuredClone(current);
    const earlier = current.scene.entities.find(({ id }) => id === "earlier");
    const later = current.scene.entities.find(({ id }) => id === "later");
    if (!earlier || !later || later.geometry.kind !== "circle") throw new Error("fixture entities are missing");

    const result = await applySceneIrDeltaV1(
      current,
      delta([
        {
          entity: { ...earlier, transform: { ...earlier.transform, tx: -2 } },
          expected: "present",
          kind: "put-entity",
        },
        {
          entity: {
            ...later,
            geometry: { center: { x: 0, y: 0 }, cornerRadius: 0, height: 1, kind: "rectangle", width: 2 },
            id: "replacement-shape",
            sceneOrder: 2,
          },
          expected: "absent",
          kind: "put-entity",
        },
        { entityId: "stroke", kind: "remove-entity" },
      ]),
    );

    expect(result.scene.entities.map(({ id }) => id)).toEqual(["later", "earlier", "replacement-shape"]);
    expect(result.scene.entities.find(({ id }) => id === "earlier")?.transform.tx).toBe(-2);
    expect(result.scene.source).toEqual({
      editProgramVersion: 1,
      kind: "studio-edit-program",
      revisionHash: REVISION_B,
    });
    expect(current).toEqual(before);
  });

  it("leaves the installed snapshot unchanged when an operation or final invariant fails", async () => {
    const current = await fixtureBundle();
    const before = structuredClone(current);

    await expect(
      applySceneIrDeltaV1(current, delta([{ entityId: "missing", kind: "remove-entity" }])),
    ).rejects.toSatisfy((error: unknown) => {
      expectDeltaError(error, "operation-conflict");
      return true;
    });
    expect(current).toEqual(before);

    await expect(
      applySceneIrDeltaV1(current, delta([{ entityId: "earlier", kind: "remove-entity" }])),
    ).rejects.toSatisfy((error: unknown) => {
      expectDeltaError(error, "result-invalid");
      return true;
    });
    expect(current).toEqual(before);
  });

  it("updates animation channels and Scene metadata in one verified candidate", async () => {
    const current = await fixtureBundle();
    const channel = current.scene.animationChannels[0];
    if (!channel || channel.kind === "camera") throw new Error("fixture animation channel is missing");

    const result = await applySceneIrDeltaV1(
      current,
      delta([
        { channelId: channel.id, kind: "remove-animation-channel" },
        {
          channel: { ...channel, entityId: "later", id: "opacity:later" },
          expected: "absent",
          kind: "put-animation-channel",
        },
        { duration: 3, kind: "update-scene" },
      ]),
    );

    expect(result.scene.duration).toBe(3);
    expect(result.scene.animationChannels).toEqual([{ ...channel, entityId: "later", id: "opacity:later" }]);
  });

  it.each([
    ["scene-mismatch", { sceneId: "another-scene" }],
    ["stale-base-revision", { baseRevision: REVISION_C }],
    ["next-revision-mismatch", { nextRevision: REVISION_C }],
    [
      "source-unsupported",
      {
        nextSource: {
          kind: "imported-manim-server-snapshot",
          runtimeConfigHash: REVISION_C,
          snapshotHash: REVISION_B,
          snapshotVersion: 1,
          sourceHash: REVISION_D,
        },
      },
    ],
  ] as const)("rejects %s correlation failures before applying", async (code, overrides) => {
    const current = await fixtureBundle();
    const before = structuredClone(current);
    const request = delta([{ entityId: "stroke", kind: "remove-entity" }], overrides);

    try {
      await applySceneIrDeltaV1(current, request);
      throw new Error("expected the delta to be rejected");
    } catch (error) {
      expectDeltaError(error, code);
    }
    expect(current).toEqual(before);
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

  it("runs final asset-manifest digest verification after applying metadata", async () => {
    const current = await fixtureBundle();
    const invalidAssets = { ...current.assets, manifestDigest: REVISION_D };

    try {
      await applySceneIrDeltaV1(current, delta([{ assets: invalidAssets, kind: "update-scene" }]));
      throw new Error("expected the delta to be rejected");
    } catch (error) {
      expectDeltaError(error, "result-invalid");
      expect((error as SceneIrDeltaError).cause).toBeInstanceOf(EngineContractIntegrityError);
    }
  });

  it("requires server-verified full snapshots for imported Manim source revisions", async () => {
    const current = await fixtureBundle();
    const importedCurrent = {
      ...current,
      scene: {
        ...current.scene,
        source: {
          kind: "imported-manim-server-snapshot" as const,
          runtimeConfigHash: REVISION_C,
          snapshotHash: REVISION_A,
          snapshotVersion: 1 as const,
          sourceHash: REVISION_D,
        },
      },
    };
    const importedNext = {
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash: REVISION_C,
      snapshotHash: REVISION_B,
      snapshotVersion: 1,
      sourceHash: REVISION_D,
    };

    try {
      await applySceneIrDeltaV1(
        importedCurrent,
        delta([{ entityId: "stroke", kind: "remove-entity" }], { nextSource: importedNext }),
      );
      throw new Error("expected the delta to be rejected");
    } catch (error) {
      expectDeltaError(error, "source-unsupported");
    }
  });
});
