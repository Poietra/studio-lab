import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadManimProjects, loadManimWorkspace } from "../render-pipeline/client";
import type { ManimProjectSummary, ManimWorkspaceView } from "../render-pipeline/contracts";
import { type ManimWorkspaceScene, workspaceScenes } from "./imported-workspace";

type WorkspaceStatus = "error" | "loading" | "ready";

function sceneAtId(scenes: readonly ManimWorkspaceScene[], id: string | null) {
  return scenes.find((scene) => scene.sceneId === id) ?? null;
}

export function scheduleWorkspaceRefresh(refresh: () => void | Promise<void>) {
  let active = true;
  queueMicrotask(() => {
    if (active) void refresh();
  });
  return () => {
    active = false;
  };
}

export function useManimWorkspace() {
  const [workspace, setWorkspace] = useState<ManimWorkspaceView | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly ManimProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneIdState] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const workspaceRef = useRef<ManimWorkspaceView | null>(null);
  const sceneByProject = useRef(new Map<string, string>());

  const loadProject = useCallback(async (requestedProjectId: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!workspaceRef.current) setStatus("loading");
    setIsRefreshing(true);
    setError(null);
    try {
      let projectId = requestedProjectId;
      if (!projectId) {
        const projectList = await loadManimProjects(controller.signal);
        if (request.current !== controller) return;
        setProjects(projectList.projects);
        projectId = projectList.defaultProjectId;
        if (!projectId) {
          activeProjectIdRef.current = null;
          workspaceRef.current = null;
          setActiveProjectIdState(null);
          setActiveSceneIdState(null);
          setWorkspace(null);
          setStatus("ready");
          return;
        }
      }
      const nextWorkspace = await loadManimWorkspace(projectId, controller.signal);
      if (request.current !== controller) return;
      const scenes = workspaceScenes(nextWorkspace);
      activeProjectIdRef.current = projectId;
      setActiveProjectIdState(projectId);
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
      setActiveSceneIdState((current) => {
        const remembered = sceneByProject.current.get(projectId);
        const nextSceneId = scenes.some((scene) => scene.sceneId === remembered)
          ? remembered!
          : scenes.some((scene) => scene.sceneId === current)
            ? current
            : scenes[0]?.sceneId ?? null;
        if (nextSceneId) sceneByProject.current.set(projectId, nextSceneId);
        return nextSceneId;
      });
      setStatus("ready");
    } catch (nextError) {
      if (controller.signal.aborted || request.current !== controller) return;
      setStatus(workspaceRef.current ? "ready" : "error");
      setError(nextError instanceof Error ? nextError.message : "Could not import the Manim workspace.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setIsRefreshing(false);
      }
    }
  }, []);

  const refresh = useCallback(() => loadProject(activeProjectIdRef.current), [loadProject]);

  const setActiveProjectId = useCallback((projectId: string) => {
    if (projectId === activeProjectIdRef.current) return;
    activeProjectIdRef.current = projectId;
    workspaceRef.current = null;
    setWorkspace(null);
    setActiveSceneIdState(null);
    setStatus("loading");
    void loadProject(projectId);
  }, [loadProject]);

  const setActiveSceneId = useCallback((sceneId: string) => {
    const projectId = activeProjectIdRef.current;
    if (projectId) sceneByProject.current.set(projectId, sceneId);
    setActiveSceneIdState(sceneId);
  }, []);

  useEffect(() => {
    // StrictMode reconnects effects once in development. Deferring the initial
    // request lets the discarded setup cancel before it reaches the network.
    const cancelScheduledRefresh = scheduleWorkspaceRefresh(() => loadProject(null));
    return () => {
      cancelScheduledRefresh();
      const controller = request.current;
      request.current = null;
      controller?.abort();
    };
  }, [loadProject]);

  const scenes = useMemo(() => workspace ? workspaceScenes(workspace) : [], [workspace]);
  const activeScene = sceneAtId(scenes, activeSceneId);
  const nextScene = sceneAtId(scenes, activeScene?.nextSceneId ?? null);
  return {
    activeScene,
    activeSceneId,
    activeProjectId,
    error,
    isRefreshing,
    nextScene,
    projects,
    refresh,
    scenes,
    setActiveProjectId,
    setActiveSceneId,
    status,
    workspace,
  } as const;
}
