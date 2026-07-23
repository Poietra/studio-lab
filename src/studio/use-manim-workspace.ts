import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ManimApiRequestError,
  createManimProject,
  generateManimThumbnail,
  isNativeWorkspacePickerCancelled,
  loadManimProjects,
  loadManimThumbnailStatus,
  loadManimWorkspace,
  renameManimProject,
  unregisterManimProject,
  type ManimProjectCreationInput,
} from "../render-pipeline/client";
import type {
  ManimProjectSummary,
  ManimWorkspaceView,
} from "../render-pipeline/contracts";
import { type ManimWorkspaceScene, workspaceScenes } from "./imported-workspace";

type WorkspaceStatus = "error" | "loading" | "ready";
export type WorkspaceMutation =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "rename"; workspaceId: string }>
  | Readonly<{ kind: "unregister"; workspaceId: string }>
  | null;

function sceneAtId(scenes: readonly ManimWorkspaceScene[], id: string | null) {
  return scenes.find((scene) => scene.sceneId === id) ?? null;
}

function mutationOutcomeMayBeUnknown(error: unknown) {
  return !(error instanceof ManimApiRequestError) || error.status >= 500;
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

export async function refreshThumbnailAfterOpen(
  projectId: string,
  loadStatus = loadManimThumbnailStatus,
  generate = generateManimThumbnail,
) {
  const status = await loadStatus(projectId);
  if (status.state === "current" || status.state === "generating") return status;
  return generate(projectId);
}

export function useManimWorkspace() {
  const [workspace, setWorkspace] = useState<ManimWorkspaceView | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly ManimProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneIdState] = useState<string | null>(null);
  const [mutation, setMutation] = useState<WorkspaceMutation>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const workspaceRef = useRef<ManimWorkspaceView | null>(null);
  const sceneByProject = useRef(new Map<string, string>());

  const loadProjectList = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    setIsRefreshing(true);
    setError(null);
    try {
      const projectList = await loadManimProjects(controller.signal);
      if (request.current !== controller) return;
      const registeredProjectIds = new Set(projectList.projects.map((project) => project.id));
      for (const projectId of sceneByProject.current.keys()) {
        if (!registeredProjectIds.has(projectId)) sceneByProject.current.delete(projectId);
      }
      setProjects(projectList.projects);
      setStatus("ready");
    } catch (nextError) {
      if (controller.signal.aborted || request.current !== controller) return;
      setStatus("error");
      setError(nextError instanceof Error ? nextError.message : "Could not list the registered Manim workspaces.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setIsRefreshing(false);
      }
    }
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!workspaceRef.current) setStatus("loading");
    setIsRefreshing(true);
    setError(null);
    try {
      const nextWorkspace = await loadManimWorkspace(projectId, controller.signal);
      if (request.current !== controller) return;
      const scenes = workspaceScenes(nextWorkspace);
      activeProjectIdRef.current = projectId;
      setActiveProjectIdState(projectId);
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
      if (nextWorkspace.commandAvailable) {
        void refreshThumbnailAfterOpen(projectId).catch(() => undefined);
      }
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

  const refresh = useCallback(() => {
    const projectId = activeProjectIdRef.current;
    return projectId ? loadProject(projectId) : loadProjectList();
  }, [loadProject, loadProjectList]);

  const setActiveProjectId = useCallback((projectId: string) => {
    if (projectId === activeProjectIdRef.current) return;
    activeProjectIdRef.current = projectId;
    workspaceRef.current = null;
    setWorkspace(null);
    setActiveProjectIdState(projectId);
    setActiveSceneIdState(null);
    setStatus("loading");
    void loadProject(projectId);
  }, [loadProject]);

  const leaveWorkspace = useCallback(() => {
    const controller = request.current;
    request.current = null;
    controller?.abort();
    activeProjectIdRef.current = null;
    workspaceRef.current = null;
    setActiveProjectIdState(null);
    setActiveSceneIdState(null);
    setWorkspace(null);
    setError(null);
    setIsRefreshing(false);
    setStatus("ready");
  }, []);

  const createWorkspace = useCallback(async (input: ManimProjectCreationInput) => {
    mutationRequest.current?.abort();
    const controller = new AbortController();
    mutationRequest.current = controller;
    setMutation({ kind: "create" });
    setMutationError(null);
    try {
      const result = await createManimProject(input, controller.signal);
      if (mutationRequest.current !== controller) return false;
      if (!result.project) throw new Error("The server did not identify the registered workspace.");
      setProjects(result.catalog.projects);
      sceneByProject.current.delete(result.project.id);
      setActiveProjectId(result.project.id);
      return true;
    } catch (nextError) {
      if (controller.signal.aborted || mutationRequest.current !== controller) return false;
      if (isNativeWorkspacePickerCancelled(nextError)) return false;
      setMutationError(nextError instanceof Error ? nextError.message : "Could not add the workspace.");
      if (mutationOutcomeMayBeUnknown(nextError)) void loadProjectList();
      return false;
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setMutation(null);
      }
    }
  }, [loadProjectList, setActiveProjectId]);

  const renameWorkspace = useCallback(async (workspaceId: string, name: string) => {
    mutationRequest.current?.abort();
    const controller = new AbortController();
    mutationRequest.current = controller;
    setMutation({ kind: "rename", workspaceId });
    setMutationError(null);
    try {
      const result = await renameManimProject(workspaceId, name, controller.signal);
      if (mutationRequest.current !== controller) return false;
      if (!result.project || result.project.id !== workspaceId) {
        throw new Error("The server did not identify the renamed workspace.");
      }
      setProjects(result.catalog.projects);
      if (workspaceRef.current?.projectId === workspaceId) {
        const renamedWorkspace = { ...workspaceRef.current, projectName: result.project.name };
        workspaceRef.current = renamedWorkspace;
        setWorkspace(renamedWorkspace);
      }
      return true;
    } catch (nextError) {
      if (controller.signal.aborted || mutationRequest.current !== controller) return false;
      setMutationError(nextError instanceof Error ? nextError.message : "Could not rename the workspace.");
      if (mutationOutcomeMayBeUnknown(nextError)) void loadProjectList();
      return false;
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setMutation(null);
      }
    }
  }, [loadProjectList]);

  const unregisterWorkspace = useCallback(async (workspaceId: string) => {
    mutationRequest.current?.abort();
    const controller = new AbortController();
    mutationRequest.current = controller;
    setMutation({ kind: "unregister", workspaceId });
    setMutationError(null);
    try {
      const result = await unregisterManimProject(workspaceId, controller.signal);
      if (mutationRequest.current !== controller) return false;
      setProjects(result.catalog.projects);
      sceneByProject.current.delete(workspaceId);
      return true;
    } catch (nextError) {
      if (controller.signal.aborted || mutationRequest.current !== controller) return false;
      setMutationError(nextError instanceof Error ? nextError.message : "Could not remove the workspace.");
      if (mutationOutcomeMayBeUnknown(nextError)) void loadProjectList();
      return false;
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setMutation(null);
      }
    }
  }, [loadProjectList]);

  const clearMutationError = useCallback(() => setMutationError(null), []);

  const cancelMutation = useCallback(() => {
    const controller = mutationRequest.current;
    if (!controller) {
      setMutation(null);
      setMutationError(null);
      return;
    }
    mutationRequest.current = null;
    controller.abort();
    setMutation(null);
    setMutationError(null);
    void loadProjectList();
  }, [loadProjectList]);

  const setActiveSceneId = useCallback((sceneId: string) => {
    const projectId = activeProjectIdRef.current;
    if (projectId) sceneByProject.current.set(projectId, sceneId);
    setActiveSceneIdState(sceneId);
  }, []);

  useEffect(() => {
    // StrictMode reconnects effects once in development. Deferring the initial
    // request lets the discarded setup cancel before it reaches the network.
    const cancelScheduledRefresh = scheduleWorkspaceRefresh(loadProjectList);
    return () => {
      cancelScheduledRefresh();
      const controller = request.current;
      request.current = null;
      controller?.abort();
      const mutationController = mutationRequest.current;
      mutationRequest.current = null;
      mutationController?.abort();
    };
  }, [loadProjectList]);

  const scenes = useMemo(() => workspace ? workspaceScenes(workspace) : [], [workspace]);
  const activeScene = sceneAtId(scenes, activeSceneId);
  const nextScene = sceneAtId(scenes, activeScene?.nextSceneId ?? null);
  return {
    activeScene,
    activeSceneId,
    activeProjectId,
    cancelMutation,
    clearMutationError,
    createWorkspace,
    error,
    isRefreshing,
    leaveWorkspace,
    mutation,
    mutationError,
    nextScene,
    projects,
    refresh,
    renameWorkspace,
    scenes,
    setActiveProjectId,
    setActiveSceneId,
    status,
    unregisterWorkspace,
    workspace,
  } as const;
}
