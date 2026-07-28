import { describe, expect, it } from "vitest";
import { type ProposedState, type RuntimeSceneState, STUDIO_STATE_VERSION } from "../studio/model";
import { type AssetManifestV1, assetManifestV1Schema, digestAssetManifestV1 } from "./asset-manifest";
import { compileEngineFrameV1 } from "./reference-evaluator";
import {
  buildStudioSceneIrAdapterEvidenceV1,
  compileStudioSceneIrV1,
  type StudioSceneIrAdapterInputV1,
  studioPointToScenePointV1,
} from "./studio-scene-adapter";

const ZERO_HASH = "0".repeat(64);
const REVISION_HASH = "a".repeat(64);
const CIRCLE_ID = "source:scene.py#Scene:circle";
const RECTANGLE_ID = "rectangle";
const white = { alpha: 1, blue: 1, green: 1, red: 1 };

async function emptyManifest(): Promise<AssetManifestV1> {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_HASH,
    manifestId: "studio-empty",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

function scene(): RuntimeSceneState {
  return {
    constraintGraph: { constraints: [] },
    duration: 2,
    eventTrack: { events: [] },
    objectGraph: {
      entities: {
        [CIRCLE_ID]: {
          geometry: {
            dimensions: { kind: "known", value: { radius: 1 } },
            position: { kind: "unknown", reason: "Position is supplied by an exact Studio channel." },
            scale: { kind: "known", value: 2 },
            style: { kind: "known", value: {} },
          },
          id: CIRCLE_ID,
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "circle" },
          type: "Circle",
        },
        [RECTANGLE_ID]: {
          geometry: {
            dimensions: { kind: "known", value: { height: 2, width: 4 } },
            position: { kind: "known", value: { x: 400, y: 140 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: {} },
          },
          id: RECTANGLE_ID,
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "rectangle" },
          type: "Rectangle",
        },
      },
      lineage: [],
    },
    propertyChannels: {
      [`${CIRCLE_ID}/position`]: {
        entityId: CIRCLE_ID,
        key: "position",
        samples: [
          {
            interval: { end: 2, start: 0 },
            kind: "exact",
            provenanceId: "studio:circle-position",
            value: { x: 320, y: 180 },
          },
        ],
      },
      [`${CIRCLE_ID}/presence`]: {
        entityId: CIRCLE_ID,
        key: "presence",
        samples: [{ interval: { end: 2, start: 0 }, kind: "exact", provenanceId: "studio:circle-create", value: true }],
      },
    },
    provenanceGraph: { records: [] },
    sceneId: "scene.py#Scene",
    version: STUDIO_STATE_VERSION,
  };
}

async function input(): Promise<StudioSceneIrAdapterInputV1> {
  return {
    assets: await emptyManifest(),
    evidence: {
      appearances: {
        [CIRCLE_ID]: {
          fill: { color: white, rule: "nonzero" },
          kind: "vector",
          opacity: 1,
          stroke: null,
        },
        [RECTANGLE_ID]: {
          fill: null,
          kind: "vector",
          opacity: 0.75,
          stroke: { cap: "round", color: white, join: "round", miterLimit: 4, widthWorld: 0.05 },
        },
      },
      camera: {
        background: { alpha: 1, blue: 0, green: 0, red: 0 },
        view: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
      },
      paintOrder: [
        { entityId: RECTANGLE_ID, sourceZIndex: -1 },
        { entityId: CIRCLE_ID, sourceZIndex: 0 },
      ],
      provenance: ["resolved Studio-native static render evidence"],
    },
    frame: { height: 9, width: 16 },
    proposedState: { evaluatedScene: scene(), programs: [] },
    sourceRevisionHash: REVISION_HASH,
  };
}

function expectIssue(result: Awaited<ReturnType<typeof compileStudioSceneIrV1>>, code: string) {
  expect(result.kind).toBe("unsupported");
  if (result.kind === "unsupported") {
    expect("scene" in result).toBe(false);
    expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  }
}

describe("Studio to SceneIrV1 truthful adapter", () => {
  it("compiles static Circle and Rectangle evidence and feeds the reference evaluator", async () => {
    const adapterInput = await input();
    const result = await compileStudioSceneIrV1(adapterInput);
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.issues.map(({ message }) => message).join("\n"));

    expect(result.scene.sceneId).toBe("scene.py#Scene");
    expect(result.scene.entities.map(({ id }) => id)).toEqual([RECTANGLE_ID, CIRCLE_ID]);
    expect(result.scene.entities[0]).toMatchObject({
      geometry: { height: 2, kind: "rectangle", width: 4 },
      sceneOrder: 0,
      sourceZIndex: -1,
      transform: { m11: 1, m22: 1, tx: 2, ty: 1 },
    });
    expect(result.scene.entities[1]).toMatchObject({
      geometry: { kind: "circle", radius: 1 },
      transform: { m11: 2, m22: 2, tx: 0, ty: 0 },
    });

    const frame = await compileEngineFrameV1({
      assets: adapterInput.assets,
      packetId: "studio-adapter-frame",
      sampleTime: 1,
      scene: result.scene,
      viewport: { heightPx: 1_080, widthPx: 1_920 },
    });
    expect(frame.kind).toBe("ready");
  });

  it("uses camera-relative top-left Studio coordinate conversion", () => {
    expect(studioPointToScenePointV1({ x: 400, y: 140 }, { height: 9, width: 16 }, { x: 10, y: -2 })).toEqual({
      x: 12,
      y: -1,
    });
  });

  it("derives imported paint only through the verified runtime identity map", async () => {
    const adapterInput = await input();
    const compiled = await compileStudioSceneIrV1(adapterInput);
    if (compiled.kind !== "compiled") throw new Error("fixture adapter did not compile");
    const resolved = buildStudioSceneIrAdapterEvidenceV1({
      proposedState: adapterInput.proposedState,
      snapshot: { assets: adapterInput.assets, scene: compiled.scene },
      sourceRuntimeIdentity: new Map([
        ["circle", { bindingId: "binding:circle", entityId: CIRCLE_ID, sourceName: "circle" }],
        ["rectangle", { bindingId: "binding:rectangle", entityId: RECTANGLE_ID, sourceName: "rectangle" }],
      ]),
    });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error("runtime evidence did not resolve");
    expect(resolved.evidence).toMatchObject({
      appearances: {
        [CIRCLE_ID]: adapterInput.evidence.appearances[CIRCLE_ID],
        [RECTANGLE_ID]: adapterInput.evidence.appearances[RECTANGLE_ID],
      },
      entityIds: { [CIRCLE_ID]: CIRCLE_ID, [RECTANGLE_ID]: RECTANGLE_ID },
      fidelity: { kind: "approximate" },
    });

    const missing = buildStudioSceneIrAdapterEvidenceV1({
      proposedState: adapterInput.proposedState,
      snapshot: { assets: adapterInput.assets, scene: compiled.scene },
      sourceRuntimeIdentity: new Map(),
    });
    expect(missing.kind).toBe("unsupported");
  });

  it("compiles a known Studio-created Circle/Rectangle default and its single opacity transition", async () => {
    const adapterInput = await input();
    const importedOnly = await compileStudioSceneIrV1({
      ...adapterInput,
      evidence: {
        ...adapterInput.evidence,
        appearances: { [CIRCLE_ID]: adapterInput.evidence.appearances[CIRCLE_ID] },
        paintOrder: [{ entityId: CIRCLE_ID, sourceZIndex: 0 }],
      },
      proposedState: {
        ...adapterInput.proposedState,
        evaluatedScene: {
          ...adapterInput.proposedState.evaluatedScene,
          objectGraph: {
            ...adapterInput.proposedState.evaluatedScene.objectGraph,
            entities: { [CIRCLE_ID]: adapterInput.proposedState.evaluatedScene.objectGraph.entities[CIRCLE_ID] },
          },
          propertyChannels: Object.fromEntries(
            Object.entries(adapterInput.proposedState.evaluatedScene.propertyChannels).filter(
              ([, channel]) => channel.entityId === CIRCLE_ID,
            ),
          ),
        },
      },
    });
    if (importedOnly.kind !== "compiled") throw new Error("imported fixture did not compile");
    const createdScene = scene();
    const createdRectangle = {
      ...createdScene.objectGraph.entities[RECTANGLE_ID],
      lifetime: [{ end: 2, start: 0.5 }],
      provisional: true,
      sourceIdentity: { evidence: ["create"], kind: "unknown" as const, reason: "Studio-created" },
      transactionId: "create-shape",
    };
    const proposedState = {
      ...adapterInput.proposedState,
      evaluatedScene: {
        ...createdScene,
        objectGraph: {
          ...createdScene.objectGraph,
          entities: { ...createdScene.objectGraph.entities, [RECTANGLE_ID]: createdRectangle },
        },
        propertyChannels: {
          ...createdScene.propertyChannels,
          [`${RECTANGLE_ID}/appearance`]: {
            entityId: RECTANGLE_ID,
            key: "appearance" as const,
            samples: [
              {
                easing: "smooth" as const,
                from: 0,
                interval: { end: 0.9, start: 0.5 },
                kind: "animated" as const,
                provenanceId: "studio:create-fade",
                value: 1,
              },
              {
                interval: { end: 2, start: 0.9 },
                kind: "exact" as const,
                provenanceId: "studio:create-fade",
                value: 1,
              },
            ],
          },
        },
      },
    };
    const evidence = buildStudioSceneIrAdapterEvidenceV1({
      proposedState,
      snapshot: { assets: adapterInput.assets, scene: importedOnly.scene },
      sourceRuntimeIdentity: new Map([
        ["circle", { bindingId: "binding:circle", entityId: CIRCLE_ID, sourceName: "circle" }],
      ]),
    });
    expect(evidence.kind).toBe("resolved");
    if (evidence.kind !== "resolved") throw new Error("created shape evidence did not resolve");
    const result = await compileStudioSceneIrV1({
      ...adapterInput,
      evidence: evidence.evidence,
      proposedState,
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.issues.map(({ message }) => message).join("\n"));
    expect(result.scene.entities.find(({ id }) => id === RECTANGLE_ID)?.appearance).toEqual(
      expect.objectContaining({
        fill: null,
        opacity: 1,
        stroke: expect.objectContaining({ cap: "butt", miterLimit: 10, widthWorld: 0.04 }),
      }),
    );
    expect(result.scene.animationChannels).toEqual([
      expect.objectContaining({
        entityId: RECTANGLE_ID,
        keyframes: [
          { at: 0.5, easingToNext: { kind: "smooth" }, value: 0 },
          { at: 0.9, easingToNext: null, value: 1 },
        ],
        kind: "opacity",
      }),
    ]);
    expect(result.scene.requiredCapabilities).toEqual(["opacity-animation", "shape-primitives"]);
  });

  it("rejects unknown, animated, and discontinuous properties instead of inventing preview defaults", async () => {
    const unknownInput = await input();
    const unknownScene = scene();
    const { [`${CIRCLE_ID}/position`]: _position, ...remainingChannels } = unknownScene.propertyChannels;
    expectIssue(
      await compileStudioSceneIrV1({
        ...unknownInput,
        proposedState: {
          ...unknownInput.proposedState,
          evaluatedScene: { ...unknownScene, propertyChannels: remainingChannels },
        },
      }),
      "unknown-evidence",
    );

    const animatedInput = await input();
    const animatedScene = scene();
    expectIssue(
      await compileStudioSceneIrV1({
        ...animatedInput,
        proposedState: {
          ...animatedInput.proposedState,
          evaluatedScene: {
            ...animatedScene,
            propertyChannels: {
              ...animatedScene.propertyChannels,
              [`${CIRCLE_ID}/position`]: {
                entityId: CIRCLE_ID,
                key: "position",
                samples: [
                  {
                    easing: "smooth",
                    from: { x: 320, y: 180 },
                    interval: { end: 1, start: 0 },
                    kind: "animated",
                    provenanceId: "studio:motion",
                    value: { x: 400, y: 180 },
                  },
                ],
              },
            },
          },
        },
      }),
      "property-animation-unsupported",
    );

    const discontinuousInput = await input();
    const discontinuousScene = scene();
    expectIssue(
      await compileStudioSceneIrV1({
        ...discontinuousInput,
        proposedState: {
          ...discontinuousInput.proposedState,
          evaluatedScene: {
            ...discontinuousScene,
            propertyChannels: {
              ...discontinuousScene.propertyChannels,
              [`${CIRCLE_ID}/position`]: {
                entityId: CIRCLE_ID,
                key: "position",
                samples: [
                  {
                    interval: { end: 2, start: 0 },
                    kind: "exact",
                    provenanceId: "studio:position-a",
                    value: { x: 320, y: 180 },
                  },
                  {
                    interval: { end: 2, start: 1 },
                    kind: "exact",
                    provenanceId: "studio:position-b",
                    value: { x: 400, y: 180 },
                  },
                ],
              },
            },
          },
        },
      }),
      "property-discontinuity-unsupported",
    );
  });

  it("rejects incomplete order/style evidence and unsupported mixed geometry as a whole", async () => {
    const missingEvidence = await input();
    expectIssue(
      await compileStudioSceneIrV1({
        ...missingEvidence,
        evidence: {
          ...missingEvidence.evidence,
          appearances: { [RECTANGLE_ID]: missingEvidence.evidence.appearances[RECTANGLE_ID] },
          paintOrder: [{ entityId: RECTANGLE_ID, sourceZIndex: 0 }],
        },
      }),
      "ordering-evidence-invalid",
    );

    const unsupportedInput = await input();
    expectIssue(
      await compileStudioSceneIrV1({
        ...unsupportedInput,
        proposedState: {
          ...unsupportedInput.proposedState,
          evaluatedScene: {
            ...unsupportedInput.proposedState.evaluatedScene,
            objectGraph: {
              ...unsupportedInput.proposedState.evaluatedScene.objectGraph,
              entities: {
                ...unsupportedInput.proposedState.evaluatedScene.objectGraph.entities,
                [RECTANGLE_ID]: {
                  ...unsupportedInput.proposedState.evaluatedScene.objectGraph.entities[RECTANGLE_ID],
                  type: "Path",
                },
              },
            },
          },
        },
      }),
      "geometry-unsupported",
    );
  });

  it("rejects stale manifests, invalid programs, and orphan operation evidence", async () => {
    const stale = await input();
    expectIssue(
      await compileStudioSceneIrV1({ ...stale, assets: { ...stale.assets, manifestDigest: "f".repeat(64) } }),
      "asset-evidence-invalid",
    );

    const invalid = await input();
    const invalidPrograms = [
      { program: { operations: [] }, validation: { issues: [], status: "invalid" } },
    ] as unknown as ProposedState["programs"];
    expectIssue(
      await compileStudioSceneIrV1({
        ...invalid,
        proposedState: { ...invalid.proposedState, programs: invalidPrograms },
      }),
      "invalid-program",
    );

    const orphan = await input();
    const orphanScene = orphan.proposedState.evaluatedScene;
    expectIssue(
      await compileStudioSceneIrV1({
        ...orphan,
        proposedState: {
          ...orphan.proposedState,
          evaluatedScene: {
            ...orphanScene,
            propertyChannels: {
              ...orphanScene.propertyChannels,
              [`${CIRCLE_ID}/position`]: {
                ...orphanScene.propertyChannels[`${CIRCLE_ID}/position`],
                samples: orphanScene.propertyChannels[`${CIRCLE_ID}/position`].samples.map((sample) => ({
                  ...sample,
                  operationId: "missing-operation",
                })),
              },
            },
          },
        },
      }),
      "program-state-mismatch",
    );
  });
});
