import type {
  ManimApiError,
  ManimWorkspaceView,
  ProgramRenderRequest,
  RenderSessionView,
} from "./contracts";

async function readJson<T extends object>(response: Response): Promise<T> {
  const body = await response.json() as T | ManimApiError;
  if (!response.ok) {
    throw new Error("error" in body ? body.error : `Request failed with ${response.status}.`);
  }
  return body as T;
}

export async function loadManimWorkspace(signal?: AbortSignal) {
  return readJson<ManimWorkspaceView>(await fetch("/api/manim/workspace", { signal }));
}

export async function startManimRender(request: ProgramRenderRequest) {
  return readJson<RenderSessionView>(await fetch("/api/manim/renders", {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
}

export async function loadManimRender(id: string, signal?: AbortSignal) {
  return readJson<RenderSessionView>(await fetch(`/api/manim/renders/${id}`, { signal }));
}

export async function runManimRenderAction(
  id: string,
  action: "cancel" | "commit" | "discard" | "undo",
) {
  return readJson<RenderSessionView>(await fetch(`/api/manim/renders/${id}/${action}`, {
    method: "POST",
  }));
}
