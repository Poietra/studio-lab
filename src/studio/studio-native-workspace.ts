import {
  type AssetManifestV1,
  digestAssetManifestV1,
  parseVerifiedSceneIrBundleV1,
  type SceneIrBundleV1,
} from "../engine/contracts";
import type { ManimWorkspaceView } from "../render-pipeline/contracts";
import { importedWorkingState, type ManimWorkspaceScene, workspaceScenes } from "./imported-workspace";
import {
  type EditorContext,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
  type StaticSemanticState,
  type WorkingState,
} from "./model";

export const STUDIO_NATIVE_DEFAULT_SCENE_DURATION = 5;
export const STUDIO_NATIVE_DEFAULT_SCENE_NAME = "Scene";

export type ImportedWorkspaceSceneIdentity = Readonly<{
  origin: "imported-manim";
  sceneName: string;
  sourceHash: string;
  sourcePath: string;
}>;

export type StudioNativeWorkspaceSceneIdentity = Readonly<{
  documentKey: string;
  origin: "studio-native";
}>;

export type WorkspaceSceneIdentity = ImportedWorkspaceSceneIdentity | StudioNativeWorkspaceSceneIdentity;

export type ImportedStudioWorkspaceScene = ManimWorkspaceScene & Readonly<{ identity: ImportedWorkspaceSceneIdentity }>;

export type StudioNativeWorkspaceScene = Readonly<{
  anchors: readonly number[];
  identity: StudioNativeWorkspaceSceneIdentity;
  importOutcomes: readonly never[];
  name: string;
  nextSceneId: null;
  runtimeSceneState: RuntimeSceneState;
  sceneId: string;
  sourceVariables: Readonly<Record<string, never>>;
  staticSemanticState: StaticSemanticState;
}>;

export type StudioWorkspaceScene = ImportedStudioWorkspaceScene | StudioNativeWorkspaceScene;
export type AuthorableWorkspaceScene = ManimWorkspaceScene | StudioNativeWorkspaceScene;

export type StudioWorkspaceProjection =
  | Readonly<{
      kind: "imported-manim";
      scenes: readonly ImportedStudioWorkspaceScene[];
    }>
  | Readonly<{
      documentKey: string;
      kind: "studio-native";
      scenes: readonly [StudioNativeWorkspaceScene];
    }>;

function assertDocumentKey(documentKey: string) {
  if (!/^[0-9a-f]{64}$/u.test(documentKey)) {
    throw new TypeError("A Studio-native workspace requires one lower-hex 32-byte document key.");
  }
}

function nativeSceneId(documentKey: string) {
  return `native:${documentKey}`;
}

export function createStudioNativeBlankScene(documentKey: string): StudioNativeWorkspaceScene {
  assertDocumentKey(documentKey);
  const sceneId = nativeSceneId(documentKey);
  return {
    anchors: [],
    identity: { documentKey, origin: "studio-native" },
    importOutcomes: [],
    name: STUDIO_NATIVE_DEFAULT_SCENE_NAME,
    nextSceneId: null,
    runtimeSceneState: {
      constraintGraph: { constraints: [] },
      duration: STUDIO_NATIVE_DEFAULT_SCENE_DURATION,
      eventTrack: { events: [] },
      objectGraph: { entities: {}, lineage: [] },
      propertyChannels: {},
      provenanceGraph: { records: [] },
      sceneId,
      version: STUDIO_STATE_VERSION,
    },
    sceneId,
    sourceVariables: {},
    staticSemanticState: {
      entities: [],
      unknowns: [],
      version: STUDIO_STATE_VERSION,
    },
  };
}

/**
 * Projects the source-bound and source-free workspace shapes into one closed
 * application union without changing the API response. A native marker and
 * imported sources are mutually exclusive; accepting both would make the
 * editing authority ambiguous.
 */
export function projectStudioWorkspaceScenes(workspace: ManimWorkspaceView): StudioWorkspaceProjection {
  if (workspace.nativeDocument) {
    if (workspace.sources.length > 0) {
      throw new TypeError("A Studio-native workspace cannot also expose imported Manim sources.");
    }
    const scene = createStudioNativeBlankScene(workspace.nativeDocument.documentKey);
    return {
      documentKey: workspace.nativeDocument.documentKey,
      kind: "studio-native",
      scenes: [scene],
    };
  }
  return {
    kind: "imported-manim",
    scenes: workspaceScenes(workspace).map((scene) => ({
      ...scene,
      identity: {
        origin: "imported-manim" as const,
        sceneName: scene.name,
        sourceHash: scene.sourceHash,
        sourcePath: scene.sourcePath,
      },
    })),
  };
}

export function studioNativeWorkingState(
  scene: StudioNativeWorkspaceScene,
  input: Readonly<{
    appliedEdits?: WorkingState["appliedEdits"];
    playhead: number;
    selection: readonly string[];
    stagedEdits?: WorkingState["stagedEdits"];
    viewport?: EditorContext["viewport"];
  }>,
): WorkingState {
  return {
    appliedEdits: input.appliedEdits ?? [],
    documentSnapshot: {
      documentKey: scene.identity.documentKey,
      origin: "studio-native",
      version: STUDIO_STATE_VERSION,
    },
    editorContext: {
      activeSceneId: scene.sceneId,
      playhead: input.playhead,
      selection: input.selection,
      version: STUDIO_STATE_VERSION,
      viewport: input.viewport ?? { height: 360, width: 640 },
    },
    runtimeSceneState: scene.runtimeSceneState,
    stagedEdits: input.stagedEdits ?? [],
    staticSemanticState: scene.staticSemanticState,
    version: STUDIO_STATE_VERSION,
  };
}

export function studioWorkspaceWorkingState(
  scene: AuthorableWorkspaceScene,
  input: Readonly<{
    appliedEdits?: WorkingState["appliedEdits"];
    playhead: number;
    selection: readonly string[];
    stagedEdits?: WorkingState["stagedEdits"];
    viewport?: EditorContext["viewport"];
  }>,
) {
  return isStudioNativeWorkspaceScene(scene)
    ? studioNativeWorkingState(scene, input)
    : importedWorkingState(scene, input);
}

export function isStudioNativeWorkspaceScene(scene: AuthorableWorkspaceScene): scene is StudioNativeWorkspaceScene {
  return "identity" in scene && scene.identity.origin === "studio-native";
}

/**
 * Canonical empty Scene IR used before the first native Edit Program. It is a
 * real `studio-edit-program` Scene accepted by the Rust validator, so both the
 * retained WebGPU renderer and WebCodecs exporter can consume it without an
 * imported-Python snapshot adapter.
 */
export async function createStudioNativeBlankSceneIrBundle(
  scene: StudioNativeWorkspaceScene,
  frame: Readonly<{ height: number; width: number }>,
): Promise<SceneIrBundleV1> {
  const manifestDraft: AssetManifestV1 = {
    assets: [],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest",
    schema: "poietra.asset-manifest",
    version: 1,
  };
  const manifest = { ...manifestDraft, manifestDigest: await digestAssetManifestV1(manifestDraft) };
  const revisionHash = await sha256Hex(
    `poietra.studio-native.blank-scene.v1\0${scene.identity.documentKey}\0${scene.runtimeSceneState.duration}\0${frame.width}\0${frame.height}`,
  );
  return parseVerifiedSceneIrBundleV1({
    assets: manifest,
    scene: {
      animationChannels: [],
      assetManifest: {
        manifestDigest: manifest.manifestDigest,
        manifestId: manifest.manifestId,
      },
      camera: {
        background: { alpha: 1, blue: 0, green: 0, red: 0 },
        view: { center: { x: 0, y: 0 }, frameHeight: frame.height, frameWidth: frame.width },
      },
      compositing: "linear-light",
      coordinateSpace: {
        cpuPrecision: "f64",
        kind: "cartesian-2d",
        origin: "center",
        unit: "scene-unit",
        xAxis: "right",
        yAxis: "up",
      },
      duration: scene.runtimeSceneState.duration,
      entities: [],
      fidelity: { kind: "exact" },
      provenance: [
        {
          evidence: ["Source-free Studio-native Editor Document"],
          id: "studio-native-document",
          origin: "studio-edit-program",
        },
      ],
      requiredCapabilities: [],
      sceneId: scene.sceneId,
      schema: "poietra.scene-ir",
      source: {
        editProgramVersion: 1,
        kind: "studio-edit-program",
        revisionHash,
      },
      stateSampling: { frameRate: null, retainsTerminalState: false },
      version: 1,
    },
  });
}

async function sha256Hex(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
