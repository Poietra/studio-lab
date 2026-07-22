import type { ManimWorkspaceSource, ManimWorkspaceView } from "../render-pipeline/contracts";
import { STUDIO_STATE_VERSION, type EditorContext, type WorkingState } from "./model";

export type ManimWorkspaceScene = ManimWorkspaceSource["scenes"][number] & Readonly<{
  sourcePath: string;
}>;

export function workspaceScenes(workspace: ManimWorkspaceView): readonly ManimWorkspaceScene[] {
  return workspace.sources.flatMap((source) => source.scenes.map((scene) => ({
    ...scene,
    sourcePath: source.path,
  })));
}

export function importedWorkingState(
  scene: ManimWorkspaceScene,
  input: Readonly<{
    appliedPrograms?: WorkingState["appliedPrograms"];
    playhead: number;
    selection: readonly string[];
    stagedPrograms?: WorkingState["stagedPrograms"];
    viewport?: EditorContext["viewport"];
  }>,
): WorkingState {
  return {
    appliedPrograms: input.appliedPrograms ?? [],
    editorContext: {
      activeSceneId: scene.sceneId,
      playhead: input.playhead,
      selection: input.selection,
      version: STUDIO_STATE_VERSION,
      viewport: input.viewport ?? { height: 360, width: 640 },
    },
    runtimeSceneState: scene.runtimeSceneState,
    sourceSnapshot: {
      configId: "manim-workspace",
      hash: `sha256:${scene.sourceHash}`,
      sourceId: scene.sourcePath,
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: input.stagedPrograms ?? [],
    staticSemanticState: scene.staticSemanticState,
    version: STUDIO_STATE_VERSION,
  };
}
