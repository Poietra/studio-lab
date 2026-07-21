import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadManimWorkspace } from "../render-pipeline/client";
import type { ManimWorkspaceView } from "../render-pipeline/contracts";
import { type ManimWorkspaceScene, workspaceScenes } from "./imported-workspace";

type WorkspaceStatus = "error" | "loading" | "ready";

function sceneAtId(scenes: readonly ManimWorkspaceScene[], id: string | null) {
  return scenes.find((scene) => scene.sceneId === id) ?? null;
}

export function useManimWorkspace() {
  const [workspace, setWorkspace] = useState<ManimWorkspaceView | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    setError(null);
    try {
      const nextWorkspace = await loadManimWorkspace(controller.signal);
      if (request.current !== controller) return;
      const scenes = workspaceScenes(nextWorkspace);
      setWorkspace(nextWorkspace);
      setActiveSceneId((current) => scenes.some((scene) => scene.sceneId === current)
        ? current
        : scenes[0]?.sceneId ?? null);
      setStatus("ready");
    } catch (nextError) {
      if (controller.signal.aborted || request.current !== controller) return;
      setStatus("error");
      setError(nextError instanceof Error ? nextError.message : "Could not import the Manim workspace.");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  const scenes = useMemo(() => workspace ? workspaceScenes(workspace) : [], [workspace]);
  const activeScene = sceneAtId(scenes, activeSceneId);
  const nextScene = sceneAtId(scenes, activeScene?.nextSceneId ?? null);
  return {
    activeScene,
    activeSceneId,
    error,
    nextScene,
    refresh,
    scenes,
    setActiveSceneId,
    status,
    workspace,
  } as const;
}
