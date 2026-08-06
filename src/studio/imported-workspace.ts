import type { ManimWorkspaceSource, ManimWorkspaceView } from "../render-pipeline/contracts";
import { type EditorContext, type Interval, STUDIO_STATE_VERSION, type WorkingState } from "./model";

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

function clipIntervalToDuration(interval: Interval, duration: number): Interval | null {
  const end = Math.min(interval.end, duration);
  return end > interval.start ? { ...interval, end } : null;
}

function projectVerifiedSourcePrefix(scene: ManimWorkspaceScene, verifiedDuration: number): ManimWorkspaceScene {
  return {
    ...scene,
    // Runtime evidence for a shorter Scene is authoritative only inside that
    // prefix. Future static-import anchors must not remain authoring targets.
    anchors: scene.anchors.filter((anchor) => anchor <= verifiedDuration),
    runtimeSceneState: {
      ...scene.runtimeSceneState,
      duration: verifiedDuration,
      eventTrack: {
        events: scene.runtimeSceneState.eventTrack.events.flatMap((event) => {
          if (event.at !== undefined && event.at > verifiedDuration) return [];
          if (!event.interval) return [event];
          const interval = clipIntervalToDuration(event.interval, verifiedDuration);
          return interval ? [{ ...event, interval }] : [];
        }),
      },
      objectGraph: {
        entities: Object.fromEntries(
          Object.entries(scene.runtimeSceneState.objectGraph.entities).map(([id, entity]) => [
            id,
            {
              ...entity,
              lifetime: entity.lifetime.flatMap((interval) => {
                const projected = clipIntervalToDuration(interval, verifiedDuration);
                return projected ? [projected] : [];
              }),
            },
          ]),
        ),
        lineage: scene.runtimeSceneState.objectGraph.lineage.filter(({ at }) => at <= verifiedDuration),
      },
      propertyChannels: Object.fromEntries(
        Object.entries(scene.runtimeSceneState.propertyChannels).map(([id, channel]) => [
          id,
          {
            ...channel,
            samples: channel.samples.flatMap((sample) => {
              const interval = clipIntervalToDuration(sample.interval, verifiedDuration);
              return interval ? [{ ...sample, interval }] : [];
            }),
          },
        ]),
      ),
    },
  };
}

/**
 * Projects a verified runtime duration onto Studio's conservative imported
 * base without rewriting the importer or any explicit Edit Program. A shorter
 * verified runtime is an authoritative prefix: future temporal evidence and
 * authoring anchors are excluded. When the runtime is longer, only lifetimes
 * that ended with the old Scene are terminal and follow the new endpoint;
 * deliberately shorter imported lifetimes remain unchanged.
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
  if (verifiedDuration < importedDuration) return projectVerifiedSourcePrefix(scene, verifiedDuration);
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
