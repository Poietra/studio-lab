import type {
  ManimApiError,
  ManimWorkspaceView,
  ProgramRenderRequest,
  RenderSessionView,
} from "./contracts";

async function readJson<T extends object>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new Error(`Request failed with ${response.status}: the server returned malformed JSON.`);
  }
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? (body as ManimApiError).error
      : null;
    throw new Error(typeof error === "string" ? error : `Request failed with ${response.status}.`);
  }
  if (typeof body !== "object" || body === null) throw new Error("The server returned an invalid JSON response.");
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
