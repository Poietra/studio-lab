import { describe, expect, it } from "vitest";
import { type AssetManifestV1, assetManifestV1Schema, digestAssetManifestV1 } from "../engine/asset-manifest";
import { sceneIrV1Schema } from "../engine/scene-ir";
import {
  type ProgramRecord,
  type PropertyChannelSample,
  type PropertyValue,
  type ProposedState,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
} from "./model";
import { EDIT_OPERATION_VERSION } from "./operations";
import {
  buildStudioSceneIrAdapterEvidenceV1,
  compileStudioSceneIrV1,
  type StudioSceneIrAdapterInputV1,
  studioPointToScenePointV1,
} from "./scene-ir-adapter";

const ZERO_HASH = "0".repeat(64);
const REVISION_HASH = "a".repeat(64);
const CIRCLE_ID = "source:scene.py#Scene:circle";
const RECTANGLE_ID = "rectangle";
const CREATED_RECTANGLE_ID = "tx:create-shape/entity:rectangle";
const IMAGE_ID = "source:image_scene.py#ImageScene:image";
const IMAGE_RUNTIME_ID = "runtime:image";
const IMAGE_ASSET_ID = "asset:image.png";
const IMAGE_SHA256 = "b".repeat(64);
const MATHTEX_ID = "source:mathtex_scene.py#MathTexScene:equation";
const MATHTEX_RUNTIME_ID = "runtime:mathtex";
const IDENTITY_TRANSFORM = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
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

async function imageManifest(): Promise<AssetManifestV1> {
  const draft = assetManifestV1Schema.parse({
    assets: [
      {
        alphaMode: "straight",
        byteLength: 128,
        colorSpace: "srgb",
        id: IMAGE_ASSET_ID,
        kind: "png-image",
        mediaType: "image/png",
        pixelHeight: 180,
        pixelWidth: 320,
        sha256: IMAGE_SHA256,
      },
    ],
    manifestDigest: ZERO_HASH,
    manifestId: "studio-image",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

function exactSample(
  provenanceId: string,
  value: PropertyValue,
  options: Readonly<Partial<Pick<PropertyChannelSample, "interval" | "knowledge" | "operationId">>> = {},
): PropertyChannelSample {
  return { interval: { end: 2, start: 0 }, kind: "exact", provenanceId, value, ...options };
}

function imageScene(): RuntimeSceneState {
  const dimensions = { evidence: ["runtime snapshot"], kind: "unknown" as const, reason: "Runtime-owned." };
  const base = scene();
  return {
    ...base,
    objectGraph: {
      entities: {
        [IMAGE_ID]: {
          content: { displayLines: ["image"], label: "image" },
          geometry: {
            dimensions,
            position: { kind: "known", value: { x: 320, y: 180 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: {} },
          },
          id: IMAGE_ID,
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "image" },
          type: "ImageMobject",
        },
      },
      lineage: [],
    },
    propertyChannels: {
      [`${IMAGE_ID}/content`]: {
        entityId: IMAGE_ID,
        key: "content",
        samples: [exactSample("import:image:content", { displayLines: ["image"], label: "image" })],
      },
      [`${IMAGE_ID}/dimensions`]: {
        entityId: IMAGE_ID,
        key: "dimensions",
        samples: [
          exactSample(
            "import:image:dimensions",
            {},
            {
              interval: { end: 0.1, start: 0 },
              knowledge: dimensions,
            },
          ),
        ],
      },
      [`${IMAGE_ID}/position`]: {
        entityId: IMAGE_ID,
        key: "position",
        samples: [exactSample("import:image:position", { x: 320, y: 180 })],
      },
      [`${IMAGE_ID}/scale`]: {
        entityId: IMAGE_ID,
        key: "scale",
        samples: [exactSample("import:image:scale", 1)],
      },
    },
    sceneId: "image_scene.py#ImageScene",
  };
}

async function imageAdapterFixture() {
  const assets = await imageManifest();
  const proposedState = { evaluatedScene: imageScene(), programs: [] };
  const base = await input();
  const compiled = await compileStudioSceneIrV1(base);
  if (compiled.kind !== "compiled") throw new Error("vector adapter fixture did not compile");
  const snapshot = {
    assets,
    scene: sceneIrV1Schema.parse({
      ...compiled.scene,
      assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
      entities: [
        {
          ...compiled.scene.entities[0],
          appearance: { kind: "image", opacity: 0.8 },
          geometry: {
            asset: { assetId: IMAGE_ASSET_ID, sha256: IMAGE_SHA256 },
            kind: "image",
            localRect: { bottom: -1.125, left: -2, right: 2, top: 1.125 },
            sampler: "nearest",
          },
          id: IMAGE_RUNTIME_ID,
          sourceZIndex: -3,
          transform: IDENTITY_TRANSFORM,
        },
      ],
      requiredCapabilities: ["png-image"],
      sceneId: "image_scene.py#ImageScene",
    }),
  };
  const evidence = buildStudioSceneIrAdapterEvidenceV1({
    proposedState,
    snapshot,
    sourceRuntimeIdentity: new Map([
      ["image", { bindingId: "binding:image", entityId: IMAGE_RUNTIME_ID, sourceName: "image" }],
    ]),
  });
  if (evidence.kind !== "resolved") throw new Error(evidence.issues.map(({ message }) => message).join("\n"));
  return { assets, evidence: evidence.evidence, proposedState, snapshot };
}

function mathTexScene(): RuntimeSceneState {
  const base = scene();
  const content = {
    displayLines: [String.raw`\frac{a}{b}`],
    label: String.raw`\frac{a}{b}`,
    texParts: [String.raw`\frac{a}{b}`],
  };
  return {
    ...base,
    objectGraph: {
      entities: {
        [MATHTEX_ID]: {
          content,
          geometry: {
            dimensions: { kind: "unknown", reason: "MathTex dimensions are owned by verified snapshot geometry." },
            position: { kind: "known", value: { x: 400, y: 220 } },
            scale: { kind: "known", value: 1.5 },
            style: { kind: "known", value: {} },
          },
          id: MATHTEX_ID,
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "equation" },
          type: "MathTex",
        },
      },
      lineage: [],
    },
    propertyChannels: {
      [`${MATHTEX_ID}/content`]: {
        entityId: MATHTEX_ID,
        key: "content",
        samples: [exactSample("import:mathtex:content", content)],
      },
      [`${MATHTEX_ID}/position`]: {
        entityId: MATHTEX_ID,
        key: "position",
        samples: [exactSample("import:mathtex:position", { x: 400, y: 220 })],
      },
      [`${MATHTEX_ID}/scale`]: {
        entityId: MATHTEX_ID,
        key: "scale",
        samples: [exactSample("import:mathtex:scale", 1.5)],
      },
    },
    sceneId: "mathtex_scene.py#MathTexScene",
  };
}

async function mathTexAdapterFixture() {
  const assets = await emptyManifest();
  const proposedState = { evaluatedScene: mathTexScene(), programs: [] };
  const base = await input();
  const compiled = await compileStudioSceneIrV1(base);
  if (compiled.kind !== "compiled") throw new Error("vector adapter fixture did not compile");
  const geometry = {
    kind: "cubic-path" as const,
    path: {
      subpaths: [
        {
          closed: true,
          segments: [
            { control1: { x: 2 / 3, y: -0.5 }, control2: { x: 4 / 3, y: -0.5 }, end: { x: 2, y: -0.5 } },
            { control1: { x: 2, y: 1 / 6 }, control2: { x: 2, y: 5 / 6 }, end: { x: 2, y: 1.5 } },
            { control1: { x: 4 / 3, y: 1.5 }, control2: { x: 2 / 3, y: 1.5 }, end: { x: 0, y: 1.5 } },
            { control1: { x: 0, y: 5 / 6 }, control2: { x: 0, y: 1 / 6 }, end: { x: 0, y: -0.5 } },
          ],
          start: { x: 0, y: -0.5 },
        },
      ],
    },
  };
  const transform = { m11: 1.5, m12: 0, m21: 0, m22: 1.5, tx: 0.5, ty: -1.75 } as const;
  const snapshot = {
    assets,
    scene: sceneIrV1Schema.parse({
      ...compiled.scene,
      entities: [
        {
          ...compiled.scene.entities[0],
          appearance: {
            fill: { color: white, rule: "nonzero" },
            kind: "vector",
            opacity: 1,
            stroke: null,
          },
          geometry,
          id: MATHTEX_RUNTIME_ID,
          sourceZIndex: -2,
          transform,
        },
      ],
      requiredCapabilities: ["cubic-path-geometry"],
      sceneId: "mathtex_scene.py#MathTexScene",
    }),
  };
  const evidence = buildStudioSceneIrAdapterEvidenceV1({
    proposedState,
    snapshot,
    sourceRuntimeIdentity: new Map([
      ["equation", { bindingId: "binding:equation", entityId: MATHTEX_RUNTIME_ID, sourceName: "equation" }],
    ]),
  });
  if (evidence.kind !== "resolved") throw new Error(evidence.issues.map(({ message }) => message).join("\n"));
  return { assets, evidence: evidence.evidence, geometry, proposedState, snapshot, transform };
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

function createdRectangleProgram(): ProgramRecord {
  const operation = {
    dependsOn: [],
    entity: {
      dimensions: { height: 2, width: 4 },
      id: CREATED_RECTANGLE_ID,
      lifetime: { end: null, start: 0.5 },
      type: "Rectangle",
    },
    id: "tx:create-shape/operation:create",
    interval: { end: 0.5, start: 0.5 },
    kind: "CreateEntity",
    provenance: { evidence: ["test CreateEntity authority"], origin: "fixture" },
  } as const;
  return {
    program: {
      anchor: {
        capturedPlayhead: 0.5,
        evidence: ["captured-playhead:0.500"],
        resolvedSeconds: 0.5,
        source: { kind: "playhead", referenceSeconds: 0.5 },
      },
      intentCount: 1,
      loweringStatus: "illustrative",
      operations: [operation],
      provenance: { evidence: ["test CreateEntity authority"], origin: "fixture" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "create-shape",
      version: EDIT_OPERATION_VERSION,
    },
    validation: { issues: [], status: "valid" },
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
  it("compiles static Circle and Rectangle evidence into validated Scene IR", async () => {
    const adapterInput = await input();
    const result = await compileStudioSceneIrV1(adapterInput);
    if (result.kind !== "compiled") throw new Error(result.issues.map(({ message }) => message).join("\n"));
    expect(result.kind).toBe("compiled");

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
  });

  it("uses camera-relative top-left Studio coordinate conversion", () => {
    expect(studioPointToScenePointV1({ x: 400, y: 140 }, { height: 9, width: 16 }, { x: 10, y: -2 })).toEqual({
      x: 12,
      y: -1,
    });
  });

  it("accepts the legacy rounded 14.222-wide runtime frame", async () => {
    const adapterInput = await input();
    const frame = { height: 8, width: 14.222 } as const;
    const result = await compileStudioSceneIrV1({
      ...adapterInput,
      evidence: {
        ...adapterInput.evidence,
        camera: {
          ...adapterInput.evidence.camera,
          view: { ...adapterInput.evidence.camera.view, frameHeight: 8, frameWidth: 14.222 },
        },
      },
      frame,
    });
    expect(result.kind).toBe("compiled");
  });

  it("rejects camera aspects that the fixed 16:9 Studio canvas would stretch", async () => {
    const adapterInput = await input();
    const result = await compileStudioSceneIrV1({
      ...adapterInput,
      evidence: {
        ...adapterInput.evidence,
        camera: {
          ...adapterInput.evidence.camera,
          view: { ...adapterInput.evidence.camera.view, frameHeight: 9, frameWidth: 12 },
        },
      },
      frame: { height: 9, width: 12 },
    });
    expectIssue(result, "camera-evidence-invalid");
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

  it("preserves verified image evidence and applies Studio move/scale exactly once", async () => {
    const fixture = await imageAdapterFixture();
    expect(fixture.evidence).toMatchObject({
      appearances: { [IMAGE_ID]: { kind: "image", opacity: 0.8 } },
      entityIds: { [IMAGE_ID]: IMAGE_RUNTIME_ID },
      images: {
        [IMAGE_ID]: {
          geometry: {
            asset: { assetId: IMAGE_ASSET_ID, sha256: IMAGE_SHA256 },
            kind: "image",
            localRect: { bottom: -1.125, left: -2, right: 2, top: 1.125 },
            sampler: "nearest",
          },
        },
      },
      paintOrder: [{ entityId: IMAGE_ID, sourceZIndex: -3 }],
    });

    const pristine = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState: fixture.proposedState,
      sourceRevisionHash: REVISION_HASH,
    });
    if (pristine.kind !== "compiled") throw new Error(pristine.issues.map(({ message }) => message).join("\n"));
    expect(pristine.scene.entities).toEqual([
      expect.objectContaining({
        appearance: { kind: "image", opacity: 0.8 },
        geometry: fixture.snapshot.scene.entities[0]?.geometry,
        id: IMAGE_RUNTIME_ID,
        sceneOrder: 0,
        sourceZIndex: -3,
        transform: fixture.snapshot.scene.entities[0]?.transform,
      }),
    ]);
    expect(pristine.scene.requiredCapabilities).toEqual(["png-image"]);

    const moveId = "tx:edit-image/operation:position";
    const scaleId = "tx:edit-image/operation:scale";
    const editedScene = fixture.proposedState.evaluatedScene;
    const proposedState = {
      evaluatedScene: {
        ...editedScene,
        propertyChannels: {
          ...editedScene.propertyChannels,
          [`${IMAGE_ID}/position`]: {
            ...editedScene.propertyChannels[`${IMAGE_ID}/position`],
            samples: [
              ...editedScene.propertyChannels[`${IMAGE_ID}/position`].samples,
              exactSample("edit:image:position", { x: 400, y: 140 }, { operationId: moveId }),
            ],
          },
          [`${IMAGE_ID}/scale`]: {
            ...editedScene.propertyChannels[`${IMAGE_ID}/scale`],
            samples: [
              ...editedScene.propertyChannels[`${IMAGE_ID}/scale`].samples,
              {
                easing: "smooth",
                from: 1,
                interval: { end: 0, start: 0 },
                kind: "animated",
                operationId: scaleId,
                provenanceId: "edit:image:scale",
                value: 1.5,
              } as const,
            ],
          },
        },
      },
      programs: [
        {
          program: { operations: [{ id: moveId }, { id: scaleId }] },
          validation: { issues: [], status: "valid" },
        },
      ] as unknown as ProposedState["programs"],
    };
    const result = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState,
      sourceRevisionHash: REVISION_HASH,
    });
    if (result.kind !== "compiled") throw new Error(result.issues.map(({ message }) => message).join("\n"));
    expect(result.scene.entities[0]).toMatchObject({
      geometry: fixture.snapshot.scene.entities[0]?.geometry,
      transform: { m11: 1.5, m12: 0, m21: 0, m22: 1.5, tx: 2, ty: 1 },
    });
  });

  it("fails closed when verified image asset evidence is not in the manifest", async () => {
    const fixture = await imageAdapterFixture();
    const image = fixture.evidence.images?.[IMAGE_ID];
    if (!image) throw new Error("image evidence fixture is incomplete");
    expectIssue(
      await compileStudioSceneIrV1({
        assets: fixture.assets,
        evidence: {
          ...fixture.evidence,
          images: {
            [IMAGE_ID]: {
              ...image,
              geometry: { ...image.geometry, asset: { ...image.geometry.asset, sha256: "c".repeat(64) } },
            },
          },
        },
        frame: { height: 9, width: 16 },
        proposedState: fixture.proposedState,
        sourceRevisionHash: REVISION_HASH,
      }),
      "asset-evidence-invalid",
    );
  });

  it("preserves imported MathTex geometry and applies Studio move/scale exactly once", async () => {
    const fixture = await mathTexAdapterFixture();
    expect(fixture.evidence).toMatchObject({
      appearances: { [MATHTEX_ID]: { kind: "vector", opacity: 1, stroke: null } },
      entityIds: { [MATHTEX_ID]: MATHTEX_RUNTIME_ID },
      mathTexSnapshots: {
        [MATHTEX_ID]: { geometry: fixture.geometry, transform: fixture.transform },
      },
      paintOrder: [{ entityId: MATHTEX_ID, sourceZIndex: -2 }],
    });
    expect(fixture.evidence.mathTexOutlines).toBeUndefined();

    const pristine = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState: fixture.proposedState,
      sourceRevisionHash: REVISION_HASH,
    });
    if (pristine.kind !== "compiled") throw new Error(pristine.issues.map(({ message }) => message).join("\n"));
    expect(pristine.scene.entities).toEqual([
      expect.objectContaining({
        geometry: fixture.geometry,
        id: MATHTEX_RUNTIME_ID,
        transform: fixture.transform,
      }),
    ]);

    const moveId = "tx:edit-mathtex/operation:position";
    const scaleId = "tx:edit-mathtex/operation:scale";
    const editedScene = fixture.proposedState.evaluatedScene;
    const proposedState = {
      evaluatedScene: {
        ...editedScene,
        propertyChannels: {
          ...editedScene.propertyChannels,
          [`${MATHTEX_ID}/position`]: {
            ...editedScene.propertyChannels[`${MATHTEX_ID}/position`],
            samples: [
              ...editedScene.propertyChannels[`${MATHTEX_ID}/position`].samples,
              exactSample("edit:mathtex:position", { x: 480, y: 140 }, { operationId: moveId }),
            ],
          },
          [`${MATHTEX_ID}/scale`]: {
            ...editedScene.propertyChannels[`${MATHTEX_ID}/scale`],
            samples: [
              ...editedScene.propertyChannels[`${MATHTEX_ID}/scale`].samples,
              {
                easing: "smooth",
                from: 1.5,
                interval: { end: 0, start: 0 },
                kind: "animated",
                operationId: scaleId,
                provenanceId: "edit:mathtex:scale",
                value: 3,
              } as const,
            ],
          },
        },
      },
      programs: [
        {
          program: { operations: [{ id: moveId }, { id: scaleId }] },
          validation: { issues: [], status: "valid" },
        },
      ] as unknown as ProposedState["programs"],
    };
    const result = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState,
      sourceRevisionHash: REVISION_HASH,
    });
    if (result.kind !== "compiled") throw new Error(result.issues.map(({ message }) => message).join("\n"));
    expect(result.scene.entities[0]).toMatchObject({
      geometry: fixture.geometry,
      transform: { m11: 3, m12: 0, m21: 0, m22: 3, tx: 1, ty: -0.5 },
    });
  });

  it("fails closed for imported MathTex content edits and mismatched semantic baselines", async () => {
    const fixture = await mathTexAdapterFixture();
    const contentId = "tx:edit-mathtex/operation:content";
    const contentScene = fixture.proposedState.evaluatedScene;
    const contentResult = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState: {
        evaluatedScene: {
          ...contentScene,
          propertyChannels: {
            ...contentScene.propertyChannels,
            [`${MATHTEX_ID}/content`]: {
              ...contentScene.propertyChannels[`${MATHTEX_ID}/content`],
              samples: [
                ...contentScene.propertyChannels[`${MATHTEX_ID}/content`].samples,
                exactSample(
                  "edit:mathtex:content",
                  { displayLines: ["E = mc^2"], texParts: ["E = mc^2"] },
                  { operationId: contentId },
                ),
              ],
            },
          },
        },
        programs: [
          {
            program: { operations: [{ id: contentId }] },
            validation: { issues: [], status: "valid" },
          },
        ] as unknown as ProposedState["programs"],
      },
      sourceRevisionHash: REVISION_HASH,
    });
    expectIssue(contentResult, "property-unsupported");

    const entity = fixture.proposedState.evaluatedScene.objectGraph.entities[MATHTEX_ID];
    if (!entity?.geometry) throw new Error("MathTex fixture semantic geometry is missing");
    const baselineResult = await compileStudioSceneIrV1({
      assets: fixture.assets,
      evidence: fixture.evidence,
      frame: { height: 9, width: 16 },
      proposedState: {
        ...fixture.proposedState,
        evaluatedScene: {
          ...fixture.proposedState.evaluatedScene,
          objectGraph: {
            ...fixture.proposedState.evaluatedScene.objectGraph,
            entities: {
              [MATHTEX_ID]: {
                ...entity,
                geometry: { ...entity.geometry, scale: { kind: "known", value: 1.25 } },
              },
            },
          },
        },
      },
      sourceRevisionHash: REVISION_HASH,
    });
    expectIssue(baselineResult, "unknown-evidence");
  });

  it.each([
    ["staged", true],
    ["applied", false],
  ] as const)(
    "compiles a known %s Studio-created shape and its single opacity transition",
    async (_phase, provisional) => {
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
        id: CREATED_RECTANGLE_ID,
        lifetime: [{ end: 2, start: 0.5 }],
        provisional,
        sourceIdentity: { evidence: ["create"], kind: "unknown" as const, reason: "Studio-created" },
        transactionId: "create-shape",
      };
      const proposedState = {
        ...adapterInput.proposedState,
        evaluatedScene: {
          ...createdScene,
          objectGraph: {
            ...createdScene.objectGraph,
            entities: {
              [CIRCLE_ID]: createdScene.objectGraph.entities[CIRCLE_ID],
              [CREATED_RECTANGLE_ID]: createdRectangle,
            },
          },
          propertyChannels: {
            ...createdScene.propertyChannels,
            [`${CREATED_RECTANGLE_ID}/appearance`]: {
              entityId: CREATED_RECTANGLE_ID,
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
        programs: [createdRectangleProgram()],
      };
      const unowned = buildStudioSceneIrAdapterEvidenceV1({
        proposedState: { ...proposedState, programs: [] },
        snapshot: { assets: adapterInput.assets, scene: importedOnly.scene },
        sourceRuntimeIdentity: new Map([
          ["circle", { bindingId: "binding:circle", entityId: CIRCLE_ID, sourceName: "circle" }],
        ]),
      });
      expect(unowned.kind).toBe("unsupported");
      if (unowned.kind === "unsupported") {
        expect(unowned.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "unknown-evidence", entityId: CREATED_RECTANGLE_ID }),
          ]),
        );
      }
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
      expect(result.scene.entities.find(({ id }) => id === CREATED_RECTANGLE_ID)?.appearance).toEqual(
        expect.objectContaining({
          fill: null,
          opacity: 1,
          stroke: expect.objectContaining({ cap: "butt", miterLimit: 10, widthWorld: 0.04 }),
        }),
      );
      expect(result.scene.animationChannels).toEqual([
        expect.objectContaining({
          entityId: CREATED_RECTANGLE_ID,
          keyframes: [
            { at: 0.5, easingToNext: { kind: "smooth" }, value: 0 },
            { at: 0.9, easingToNext: null, value: 1 },
          ],
          kind: "opacity",
        }),
      ]);
      expect(result.scene.requiredCapabilities).toEqual(["opacity-animation", "shape-primitives"]);
    },
  );

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
