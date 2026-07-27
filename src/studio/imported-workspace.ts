import type { ManimWorkspaceSource, ManimWorkspaceView } from "../render-pipeline/contracts";
import { type EditorContext, STUDIO_STATE_VERSION, type WorkingState } from "./model";

export type ManimWorkspaceScene = ManimWorkspaceSource["scenes"][number] &
  Readonly<{
    sourcePath: string;
  }>;

export function workspaceScenes(workspace: ManimWorkspaceView): readonly ManimWorkspaceScene[] {
  return workspace.sources.flatMap((source) =>
    source.scenes.map((scene) => ({
      ...scene,
      sourcePath: source.path,
    })),
  );
}

/**
 * Projects a verified runtime duration onto Studio's conservative imported
 * base without rewriting the importer or any explicit Edit Program. Only
 * lifetimes that ended with the old Scene are terminal and follow the new
 * endpoint; deliberately shorter imported lifetimes remain unchanged.
 */
export function projectVerifiedSourceDuration(
  scene: ManimWorkspaceScene,
  verifiedDuration: number | null,
): ManimWorkspaceScene {
  const importedDuration = scene.runtimeSceneState.duration;
  if (
    verifiedDuration === null ||
    !Number.isFinite(verifiedDuration) ||
    verifiedDuration < 0.1 ||
    Math.abs(verifiedDuration - importedDuration) < 0.0005
  )
    return scene;
  const terminalEndWouldBeInvalid = Object.values(scene.runtimeSceneState.objectGraph.entities).some((entity) =>
    entity.lifetime.some(
      (interval) => Math.abs(interval.end - importedDuration) < 0.0005 && verifiedDuration <= interval.start,
    ),
  );
  if (terminalEndWouldBeInvalid) return scene;
  return {
    ...scene,
    runtimeSceneState: {
      ...scene.runtimeSceneState,
      duration: verifiedDuration,
      objectGraph: {
        ...scene.runtimeSceneState.objectGraph,
        entities: Object.fromEntries(
          Object.entries(scene.runtimeSceneState.objectGraph.entities).map(([id, entity]) => [
            id,
            {
              ...entity,
              lifetime: entity.lifetime.map((interval) =>
                Math.abs(interval.end - importedDuration) < 0.0005 ? { ...interval, end: verifiedDuration } : interval,
              ),
            },
          ]),
        ),
      },
    },
  };
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
