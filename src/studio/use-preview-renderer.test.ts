import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { applySceneIrDeltaV1, createSceneIrDeltaV1 } from "../engine/scene-delta";
import { createStudioEntitiesProgram } from "./authoring-commands";
import { evaluateWorkingState, programRecord } from "./evaluator";
import {
  STUDIO_STATE_VERSION,
  type ProgramRecord,
  type ProposedState,
  type RuntimeSceneState,
  type WorkingState,
} from "./model";
import { EDIT_OPERATION_VERSION } from "./operations";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import {
  claimStudioPreviewCanvasV1,
  compileStudioPreviewSceneV1,
  createStudioPreviewDeltaOrReplacementV1,
  digestStudioPreviewSceneRevisionV1,
  type StudioPreviewSnapshotMetadataStateV1,
  studioPreviewSnapshotMetadataForWorkspaceV1,
} from "./use-preview-renderer";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

async function compilablePreviewInput() {
  const fixtureUrl = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  const base = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const runtimeEntity = base.scene.entities.find(({ id }) => id === "earlier");
  if (!runtimeEntity) throw new Error("preview fixture entity is missing");
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [],
      entities: [runtimeEntity],
      requiredCapabilities: ["shape-primitives"],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: HASH_B,
        snapshotHash: HASH_C,
        snapshotVersion: 1,
        sourceHash: HASH_A,
      },
    },
  });
  const evaluatedScene: RuntimeSceneState = {
    constraintGraph: { constraints: [] },
    duration: 2,
    eventTrack: { events: [] },
    objectGraph: {
      entities: {
        "source:circle": {
          geometry: {
            dimensions: { kind: "known", value: { radius: 1 } },
            position: { kind: "known", value: { x: 320, y: 180 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: {} },
          },
          id: "source:circle",
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "circle" },
          type: "Circle",
        },
      },
      lineage: [],
    },
    propertyChannels: {},
    provenanceGraph: { records: [] },
    sceneId: "studio:circle-scene",
    version: 1,
  };
  const workingState: WorkingState = {
    appliedPrograms: [],
    editorContext: {
      activeSceneId: evaluatedScene.sceneId,
      playhead: 0.5,
      selection: ["source:circle"],
      version: STUDIO_STATE_VERSION,
      viewport: { height: 360, width: 640 },
    },
    runtimeSceneState: evaluatedScene,
    sourceSnapshot: {
      configId: "test",
      hash: `sha256:${HASH_A}`,
      sourceId: "scene.py",
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: [],
    staticSemanticState: {
      entities: [
        {
          runtimeIdentities: { kind: "known", value: ["source:circle"] },
          sourceIdentity: "circle",
          type: { kind: "known", value: "Circle" },
        },
      ],
      unknowns: [],
      version: STUDIO_STATE_VERSION,
    },
    version: STUDIO_STATE_VERSION,
  };
  const proposedState = evaluateWorkingState(workingState);
  const context = {
    projectId: "project-a",
    sceneName: "CircleScene",
    sourceDuration: 2,
    sourceHash: HASH_A,
    sourcePath: "scene.py",
    workingRevision: "pristine",
  } as const;
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    correlation: {
      assetsManifestDigest: snapshotBundle.assets.manifestDigest,
      context,
      engineRevisionHash: HASH_C,
      sceneDuration: 2,
      sceneId: snapshotBundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 2,
    sceneId: snapshotBundle.scene.sceneId,
    snapshot: snapshotBundle,
    sourceLabel: "verified test snapshot",
    sourceRuntimeIdentity: new Map([
      ["circle", { bindingId: "binding:circle", entityId: "earlier", sourceName: "circle" }],
    ]),
  };
  return { context, proposedState, snapshot };
}

function withAppliedRectangle(proposedState: ProposedState, x = 400): ProposedState {
  const entityId = "tx:create-rectangle/entity:rectangle";
  const operation = {
    dependsOn: [],
    entity: {
      dimensions: { height: 2, width: 3 },
      id: entityId,
      lifetime: { end: null, start: 0 },
      type: "Rectangle",
    },
    id: "tx:create-rectangle/operation:create",
    interval: { end: 0, start: 0 },
    kind: "CreateEntity",
    provenance: { evidence: ["test applied creation"], origin: "fixture" },
  } as const;
  const positionOperation = {
    dependsOn: [operation.id],
    entityId,
    id: "tx:create-rectangle/operation:position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["test applied placement"], origin: "fixture" },
    value: { x, y: 180 },
  } as const;
  const record: ProgramRecord = {
    program: {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["captured-playhead:0.000"],
        resolvedSeconds: 0,
        source: { kind: "playhead", referenceSeconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "illustrative",
      operations: [operation, positionOperation],
      provenance: { evidence: ["test applied creation"], origin: "fixture" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id, positionOperation.id] },
      transactionId: "create-rectangle",
      version: EDIT_OPERATION_VERSION,
    },
    validation: { issues: [], status: "valid" },
  };
  return {
    ...proposedState,
    evaluatedScene: {
      ...proposedState.evaluatedScene,
      objectGraph: {
        ...proposedState.evaluatedScene.objectGraph,
        entities: {
          ...proposedState.evaluatedScene.objectGraph.entities,
          [entityId]: {
            geometry: {
              dimensions: { kind: "known", value: { height: 2, width: 3 } },
              position: { kind: "known", value: { x, y: 180 } },
              scale: { kind: "known", value: 1 },
              style: { kind: "known", value: {} },
            },
            id: entityId,
            lifetime: [{ end: 2, start: 0 }],
            provisional: false,
            sourceIdentity: { evidence: [operation.id], kind: "unknown", reason: "Studio-created" },
            transactionId: "create-rectangle",
            type: "Rectangle",
          },
        },
      },
    },
    programs: [record],
  };
}

async function linePreviewInput() {
  const base = await compilablePreviewInput();
  const circle = base.snapshot.snapshot.scene.entities[0];
  if (!circle) throw new Error("preview fixture entity is missing");
  const unsigned = await parseVerifiedSceneIrBundleV1({
    assets: base.snapshot.snapshot.assets,
    scene: {
      ...base.snapshot.snapshot.scene,
      entities: [
        {
          ...circle,
          appearance: {
            fill: null,
            kind: "vector",
            opacity: 1,
            stroke: {
              cap: "butt",
              color: { alpha: 1, blue: 1, green: 1, red: 1 },
              join: "miter",
              miterLimit: 10,
              widthWorld: 0.04,
            },
          },
          geometry: { end: { x: 2, y: 0 }, kind: "line", start: { x: -2, y: 0 } },
          id: "runtime-line",
        },
      ],
      source: { ...base.snapshot.snapshot.scene.source, snapshotHash: "0".repeat(64) },
    },
  });
  const revision = await digestFastManimSnapshotBundleInBrowserV1(unsigned);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...unsigned,
    scene: { ...unsigned.scene, source: { ...unsigned.scene.source, snapshotHash: revision } },
  });
  const imported = base.proposedState.evaluatedScene.objectGraph.entities["source:circle"];
  if (!imported) throw new Error("Studio fixture entity is missing");
  return {
    ...base,
    proposedState: {
      ...base.proposedState,
      evaluatedScene: {
        ...base.proposedState.evaluatedScene,
        objectGraph: {
          ...base.proposedState.evaluatedScene.objectGraph,
          entities: {
            "source:line": {
              ...imported,
              id: "source:line",
              sourceIdentity: { kind: "known" as const, value: "line" },
              type: "Line",
            },
          },
        },
      },
    },
    snapshot: {
      ...base.snapshot,
      correlation: { ...base.snapshot.correlation, engineRevisionHash: revision },
      snapshot: snapshotBundle,
      sourceRuntimeIdentity: new Map([
        ["line", { bindingId: "binding:line", entityId: "runtime-line", sourceName: "line" }],
      ]),
    },
  };
}

describe("claimStudioPreviewCanvasV1", () => {
  it("claims a canvas exactly once so StrictMode remounts must mint a fresh element", () => {
    const canvas = {};
    expect(claimStudioPreviewCanvasV1(canvas)).toBe(true);
    // The StrictMode double-invoked effect (and any workspace switch that
    // re-runs the install effect on a kept-alive element) sees the claim fail
    // and requests a new canvas epoch instead of re-transferring the element.
    expect(claimStudioPreviewCanvasV1(canvas)).toBe(false);
    expect(claimStudioPreviewCanvasV1({})).toBe(true);
  });
});

describe("compileStudioPreviewSceneV1", () => {
  it("passes a pristine verified Line snapshot through without invoking the narrower Studio adapter", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/scene.py/LineScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(result.scene.engineRevisionHash).toBe(snapshot.correlation.engineRevisionHash);
    expect(result.scene.bundle.scene.entities[0]?.geometry.kind).toBe("line");
    expect(result.scene.interactionEntityIds).toEqual(["runtime-line"]);
  });

  it("restores the exact verified snapshot after undo returns to zero applied Programs", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      // The redo stack remains editor authority after Undo, so the revision is
      // intentionally not pristine even though no Program affects the Scene.
      workingRevision: "studio-working-v1:undo-with-redo-history",
      workspaceKey: "project-a/scene.py/LineScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(result.scene.workingRevision).toBe("studio-working-v1:undo-with-redo-history");
    expect(result.scene.bundle.scene.entities[0]?.geometry.kind).toBe("line");
    expect(result.scene.bundle.scene.animationChannels).toBe(snapshot.snapshot.scene.animationChannels);
  });

  it("replaces the pristine source on the first applied edit, then emits exact bounded deltas", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const pristine = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    const edited = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState),
      snapshot,
      workingRevision: "studio-working-v1:create-rectangle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    if (pristine.kind !== "compiled") throw new Error(pristine.error);
    if (edited.kind !== "compiled") throw new Error(edited.error);
    expect(pristine.scene.bundle.scene.source.kind).toBe("imported-manim-server-snapshot");
    expect(edited.scene.bundle.scene.source.kind).toBe("studio-edit-program");
    // The first ownership handoff is deliberately a full replacement: the v1
    // delta contract accepts Studio-owned bases only. The retained host keeps
    // the same worker/canvas while performing that replacement.
    expect(await createSceneIrDeltaV1(pristine.scene.bundle, edited.scene.bundle)).toBeNull();
    const editedAgain = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState, 480),
      snapshot,
      workingRevision: "studio-working-v1:move-rectangle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    if (editedAgain.kind !== "compiled") throw new Error(editedAgain.error);
    const delta = await createSceneIrDeltaV1(edited.scene.bundle, editedAgain.scene.bundle);
    expect(delta).not.toBeNull();
    if (!delta) throw new Error("second Studio revision did not fit the bounded delta contract");
    expect(await applySceneIrDeltaV1(edited.scene.bundle, delta)).toEqual(editedAgain.scene.bundle);
  });

  it("compiles the real authoring create path after its fade extends the evaluated duration", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { height: 2, width: 4 }, position: { x: 400, y: 180 }, type: "Rectangle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "real-create",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });

    expect(edited.base.runtimeSceneState.duration).toBe(2);
    expect(edited.evaluatedScene.duration).toBeCloseTo(2.4, 9);
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:real-create",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle.scene.duration).toBeCloseTo(2.4, 9);
    expect(result.scene.bundle.scene.entities.map(({ id }) => id)).toContain(creation.entityIds[0]);
  });

  it("fails closed instead of dropping verified base animation channels on edit", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const animatedSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          animationChannels: [
            {
              entityId: "earlier",
              id: "opacity:earlier",
              keyframes: [
                { at: 0, easingToNext: { kind: "smooth" }, value: 0 },
                { at: 2, easingToNext: null, value: 1 },
              ],
              kind: "opacity",
              provenanceId: "verified-source-fade",
            },
          ],
        },
      },
    };
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState),
      snapshot: animatedSnapshot,
      workingRevision: "studio-working-v1:edit-animated-source",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toEqual({
      error: "Editing a verified Scene with imported animation channels requires temporal rebasing support.",
      kind: "unsupported",
    });
  });

  it("downgrades an unexpected delta producer rejection to the correlated full snapshot path", async () => {
    const { snapshot } = await compilablePreviewInput();
    const result = await createStudioPreviewDeltaOrReplacementV1(snapshot.snapshot, snapshot.snapshot, async () => {
      throw new Error("synthetic delta producer failure");
    });
    expect(result).toBeNull();
  });

  it("correlates the canonical Studio state to verified imported runtime evidence", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const edited = withAppliedRectangle(proposedState);
    const first = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(first.kind).toBe("compiled");
    if (first.kind !== "compiled") throw new Error(first.error);
    expect(first.scene.bundle.scene).toMatchObject({
      duration: 2,
      fidelity: { kind: "approximate" },
      sceneId: "studio:circle-scene",
      source: { kind: "studio-edit-program", revisionHash: first.scene.engineRevisionHash },
    });
    expect(first.scene.bundle.scene.entities.find(({ id }) => id === "earlier")?.appearance).toEqual(
      snapshot.snapshot.scene.entities[0]?.appearance,
    );
    expect(first.scene.interactionEntityIds).toEqual(["earlier", "tx:create-rectangle/entity:rectangle"]);
    const repeated = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(repeated.kind === "compiled" ? repeated.scene.engineRevisionHash : null).toBe(
      first.scene.engineRevisionHash,
    );
  });

  it("changes the compiled revision across every snapshot, asset, and frame authority axis", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const basis = {
      frame: { height: 9, width: 16 },
      snapshot,
      studioScene: proposedState.evaluatedScene,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    } as const;
    const digests = await Promise.all([
      digestStudioPreviewSceneRevisionV1(basis),
      digestStudioPreviewSceneRevisionV1({
        ...basis,
        snapshot: {
          ...snapshot,
          correlation: { ...snapshot.correlation, engineRevisionHash: HASH_B },
        },
      }),
      digestStudioPreviewSceneRevisionV1({
        ...basis,
        snapshot: {
          ...snapshot,
          correlation: { ...snapshot.correlation, assetsManifestDigest: HASH_B },
        },
      }),
      digestStudioPreviewSceneRevisionV1({ ...basis, frame: { height: 9, width: 15 } }),
    ]);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("refuses a Studio base that has not adopted the verified source duration", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: {
        ...proposedState,
        base: {
          ...proposedState.base,
          runtimeSceneState: { ...proposedState.base.runtimeSceneState, duration: 3 },
        },
      },
      snapshot,
      workingRevision: "studio-working-v1:stale-time",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toMatchObject({ kind: "unsupported" });
  });
});

describe("studioPreviewSnapshotMetadataForWorkspaceV1", () => {
  const provider: StudioPreviewSnapshotProviderV1 = {
    id: "delayed-provider",
    loadVerifiedSnapshot: async () => {
      throw new Error("not called by the pure lifecycle resolver");
    },
  };
  const snapshot = {} as StudioVerifiedPreviewSnapshotV1;

  it("reports loading synchronously instead of exposing a previous workspace result", () => {
    const previous: StudioPreviewSnapshotMetadataStateV1 = {
      phase: "ready",
      provider,
      snapshot,
      workspaceKey: "workspace-a",
    };
    expect(studioPreviewSnapshotMetadataForWorkspaceV1(previous, { provider, workspaceKey: "workspace-b" })).toEqual({
      phase: "loading",
      provider,
      snapshot: null,
      workspaceKey: "workspace-b",
    });
  });

  it.each([
    ["workspace/project", { projectId: "project-b" }],
    ["Scene", { sceneName: "OtherScene" }],
    ["source path", { sourcePath: "other.py" }],
    ["source revision", { sourceHash: "b".repeat(64) }],
  ])("drops a retained snapshot and identity map synchronously on a %s switch", (_axis, change) => {
    const context = {
      projectId: "project-a",
      sceneName: "ExampleScene",
      sourceDuration: 1,
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      workingRevision: "pristine",
    };
    const previousSnapshot = {
      ...snapshot,
      sourceRuntimeIdentity: new Map([
        ["circle", { bindingId: "binding:old", entityId: "runtime:old", sourceName: "circle" }],
      ]),
    } as StudioVerifiedPreviewSnapshotV1;
    const nextContext = { ...context, ...change };
    const next = studioPreviewSnapshotMetadataForWorkspaceV1(
      {
        phase: "ready",
        provider,
        snapshot: previousSnapshot,
        workspaceKey: studioPreviewWorkspaceKeyV1(context),
      },
      { provider, workspaceKey: studioPreviewWorkspaceKeyV1(nextContext) },
    );
    expect(next.phase).toBe("loading");
    expect(next.snapshot).toBeNull();
  });

  it("retains only the exact provider/workspace lifecycle state while a delayed load settles", () => {
    const loading: StudioPreviewSnapshotMetadataStateV1 = {
      phase: "loading",
      provider,
      snapshot: null,
      workspaceKey: "workspace-a",
    };
    expect(studioPreviewSnapshotMetadataForWorkspaceV1(loading, { provider, workspaceKey: "workspace-a" })).toBe(
      loading,
    );
    expect(
      studioPreviewSnapshotMetadataForWorkspaceV1(
        { phase: "ready", provider, snapshot, workspaceKey: "workspace-a" },
        { provider, workspaceKey: "workspace-a" },
      ).phase,
    ).toBe("ready");
    expect(
      studioPreviewSnapshotMetadataForWorkspaceV1(loading, { provider: { ...provider }, workspaceKey: "workspace-a" })
        .phase,
    ).toBe("loading");
  });
});
