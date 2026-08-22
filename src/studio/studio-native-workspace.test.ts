import { describe, expect, it } from "vitest";

import type { StudioCreationProjectionV1 } from "../engine/scene-authoring";
import type { ManimWorkspaceView } from "../render-pipeline/contracts";
import { importManimScene } from "../render-pipeline/source-import";
import { programRecord } from "./evaluator";
import { workspaceScenes } from "./imported-workspace";
import { buildLifetimeEditControls, lifetimeControlKey } from "./lifetime-editing";
import type { CanonicalEditProgram } from "./operations";
import {
  createStudioNativeBlankSceneIrBundle,
  projectStudioWorkspaceScenes,
  studioNativeWorkingState,
} from "./studio-native-workspace";
import { projectStudioWorkspace } from "./workspace-projection";

const DOCUMENT_KEY = "ab".repeat(32);

function workspace(overrides: Partial<ManimWorkspaceView> = {}): ManimWorkspaceView {
  return {
    commandAvailable: false,
    frame: { height: 8, width: 14.222222222222221 },
    nativeDocument: { documentKey: DOCUMENT_KEY },
    projectId: "project-native",
    projectName: "Native demo",
    renderCapability: {
      available: false,
      kind: "durable-sandbox",
      unavailableReason: "native-render-frozen",
    },
    sources: [],
    ...overrides,
  };
}

function createCircleProgram(): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
    intentCount: 1,
    loweringStatus: "unsupported",
    operations: [
      {
        dependsOn: [],
        entity: {
          dimensions: { radius: 1 },
          id: "native-circle",
          lifetime: { end: null, start: 0 },
          type: "Circle",
        },
        id: "create-native-circle",
        interval: { end: 0, start: 0 },
        kind: "CreateEntity",
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: ["create-native-circle"] },
    transactionId: "create-native-circle",
    version: 1,
  };
}

describe("Studio-native workspace projection", () => {
  it("projects one editable blank Scene without fabricating Python source identity", () => {
    const projection = projectStudioWorkspaceScenes(workspace());

    expect(projection.kind).toBe("studio-native");
    if (projection.kind !== "studio-native") throw new Error("Expected a native workspace projection.");
    expect(projection.documentKey).toBe(DOCUMENT_KEY);
    expect(projection.scenes).toHaveLength(1);
    const scene = projection.scenes[0];
    expect(scene.identity).toEqual({ documentKey: DOCUMENT_KEY, origin: "studio-native" });
    expect(scene.sceneId).toBe(`native:${DOCUMENT_KEY}`);
    expect(scene.runtimeSceneState).toMatchObject({ duration: 5, sceneId: scene.sceneId });
    expect(scene.anchors).toHaveLength(51);
    expect(scene.anchors.slice(0, 3)).toEqual([0, 0.1, 0.2]);
    expect(scene.anchors.at(-1)).toBe(5);
    expect(scene.runtimeSceneState.objectGraph.entities).toEqual({});
    expect(scene).not.toHaveProperty("sourceHash");
    expect(scene).not.toHaveProperty("sourcePath");
    expect(workspaceScenes(workspace())).toEqual([]);
  });

  it("keeps imported and native authority mutually exclusive", () => {
    expect(() =>
      projectStudioWorkspaceScenes(
        workspace({
          sources: [
            {
              path: "scene.py",
              scenes: [],
            },
          ],
        }),
      ),
    ).toThrow(/cannot also expose imported Manim sources/);
  });

  it("projects imported identity explicitly without changing the legacy Scene fields", () => {
    const source = "from manim import *\nclass Demo(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const imported = importManimScene(source, "scene.py", "Demo");
    if (!imported) throw new Error("Expected the imported fixture Scene.");
    const sourceScene = {
      anchors: imported.anchors,
      importOutcomes: imported.importOutcomes,
      name: imported.name,
      nextSceneId: null,
      runtimeSceneState: imported.runtimeSceneState,
      sceneId: imported.sceneId,
      sourceHash: imported.sourceHash,
      sourceVariables: imported.sourceVariables,
      staticSemanticState: imported.staticSemanticState,
    };
    const importedWorkspace = workspace({
      nativeDocument: undefined,
      sources: [{ path: "scene.py", scenes: [sourceScene] }],
    });
    const legacyScene = workspaceScenes(importedWorkspace)[0];
    const projection = projectStudioWorkspaceScenes(importedWorkspace);

    expect(projection.kind).toBe("imported-manim");
    if (projection.kind !== "imported-manim") throw new Error("Expected an imported workspace projection.");
    expect(projection.scenes[0]).toEqual({
      ...legacyScene,
      identity: {
        origin: "imported-manim",
        sceneName: "Demo",
        sourceHash: imported.sourceHash,
        sourcePath: "scene.py",
      },
    });
    expect(legacyScene).not.toHaveProperty("identity");
  });

  it("uses a document basis and no source snapshot in native WorkingState", () => {
    const projection = projectStudioWorkspaceScenes(workspace());
    if (projection.kind !== "studio-native") throw new Error("Expected a native workspace projection.");
    const state = studioNativeWorkingState(projection.scenes[0], { playhead: 0, selection: [] });

    expect(state.documentSnapshot).toEqual({
      documentKey: DOCUMENT_KEY,
      origin: "studio-native",
      version: 1,
    });
    expect(state).not.toHaveProperty("sourceSnapshot");
  });

  it("builds a Rust-validated blank Scene IR for retained preview and WebCodecs", async () => {
    const projection = projectStudioWorkspaceScenes(workspace());
    if (projection.kind !== "studio-native") throw new Error("Expected a native workspace projection.");

    const bundle = await createStudioNativeBlankSceneIrBundle(projection.scenes[0], workspace().frame);

    expect(bundle.scene).toMatchObject({
      duration: 5,
      entities: [],
      sceneId: `native:${DOCUMENT_KEY}`,
      source: {
        editProgramVersion: 1,
        kind: "studio-edit-program",
        revisionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    if (bundle.scene.source.kind !== "studio-edit-program") throw new Error("Expected native Edit Program lineage.");
    expect(bundle.scene.source.revisionHash).not.toBe(DOCUMENT_KEY);
    expect(bundle.assets.assets).toEqual([]);
  });

  it("feeds the blank Scene through the existing Rust-authorized creation projection", () => {
    const workspaceProjection = projectStudioWorkspaceScenes(workspace());
    if (workspaceProjection.kind !== "studio-native") throw new Error("Expected a native workspace projection.");
    const scene = workspaceProjection.scenes[0];
    const program = createCircleProgram();
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: scene.runtimeSceneState.duration, start: 0 },
          entityId: "native-circle",
          initialDimensions: { radius: 1 },
          initialRotation: 0,
          initialScale: 1,
          kind: "circle",
          operationId: "create-native-circle",
          transactionId: "create-native-circle",
        },
      ],
      insertions: [],
      motions: [],
      mutations: [],
      projectedDuration: scene.runtimeSceneState.duration,
      removals: [],
    };

    const result = projectStudioWorkspace({
      activeScene: scene,
      appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      creationProjection: projection,
      currentTime: 0,
      draftEdit: null,
      editAuthority: "rust-authorized-batch",
      nextScene: null,
      selectedObjectIds: [],
    });

    expect(result.proposedState.base.documentSnapshot?.documentKey).toBe(DOCUMENT_KEY);
    expect(result.proposedState.evaluatedScene.objectGraph.entities["native-circle"]).toMatchObject({
      id: "native-circle",
      type: "Circle",
    });
    const controls = buildLifetimeEditControls({
      anchors: scene.anchors,
      baseScene: scene.runtimeSceneState,
      programs: [programRecord(program, { issues: [], kind: "valid" })],
      sourceDuration: scene.runtimeSceneState.duration,
      tracks: result.projection.timeline.objectTracks,
    })[lifetimeControlKey("native-circle", 0)]!;
    expect(controls.startTargets.length).toBeGreaterThan(0);
    expect(controls.endTargets.length).toBeGreaterThan(0);
  });
});
