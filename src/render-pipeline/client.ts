import type { z } from "zod";

import type {
  ManimApiError,
  ManimProjectCreateRequest,
  ManimSourceExport,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
} from "./contracts";
import {
  createManimProjectRequestSchema,
  manimProjectIdSchema,
  manimProjectNameSchema,
  manimProjectListViewSchema,
  manimProjectMutationViewSchema,
  manimThumbnailGenerateRequestSchema,
  manimThumbnailStatusSchema,
  manimWorkspaceViewSchema,
  originalManimSourceExportRequestSchema,
  programRenderRequestSchema,
  renameManimProjectRequestSchema,
  renderSessionViewSchema,
} from "./contracts";
import { desktopBridge } from "../shell/desktop-bridge";

export type ManimProjectCreationInput = ManimProjectCreateRequest | Readonly<{ kind: "native-existing"; name: string }>;

async function responseBody(response: Response) {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new Error(`Request failed with ${response.status}: the server returned malformed JSON.`);
  }
}

export class ManimApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ManimApiRequestError";
    this.status = status;
  }
}

export class NativeWorkspacePickerCancelledError extends Error {
  constructor() {
    super("Workspace folder selection was cancelled.");
    this.name = "NativeWorkspacePickerCancelledError";
  }
}

export function isNativeWorkspacePickerCancelled(error: unknown) {
  return error instanceof NativeWorkspacePickerCancelledError;
}

export function isMissingManimSession(error: unknown) {
  return error instanceof ManimApiRequestError && error.status === 404;
}

function apiError(response: Response, body: unknown) {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as ManimApiError).error : null;
  return new ManimApiRequestError(
    typeof error === "string" ? error : `Request failed with ${response.status}.`,
    response.status,
  );
}

function nativeApiError(status: number, body: unknown) {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as ManimApiError).error : null;
  return new ManimApiRequestError(
    typeof error === "string" ? error : `Native workspace registration failed with ${status}.`,
    status,
  );
}

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await responseBody(response);
  if (!response.ok) throw apiError(response, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("The server returned a response that does not match the API contract.");
  return parsed.data;
}

export async function loadManimProjects(signal?: AbortSignal) {
  return readJson(await fetch("/api/manim/projects", { signal }), manimProjectListViewSchema);
}

export async function createManimProject(input: ManimProjectCreationInput, signal?: AbortSignal) {
  if (input.kind === "native-existing") {
    const name = manimProjectNameSchema.safeParse(input.name);
    if (!name.success) throw new Error(name.error.issues[0]?.message ?? "The workspace name is invalid.");
    const bridge = desktopBridge();
    if (!bridge) throw new Error("The native workspace picker is unavailable in this shell.");
    signal?.throwIfAborted();
    const result = await bridge.registerExistingWorkspace(name.data);
    signal?.throwIfAborted();
    if (typeof result !== "object" || result === null || typeof result.cancelled !== "boolean") {
      throw new Error("The desktop shell returned an invalid workspace registration result.");
    }
    if (result.cancelled) throw new NativeWorkspacePickerCancelledError();
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || !("body" in result)) {
      throw new Error("The desktop shell returned an invalid workspace registration result.");
    }
    if (result.status < 200 || result.status >= 300) throw nativeApiError(result.status, result.body);
    const created = manimProjectMutationViewSchema.safeParse(result.body);
    if (!created.success)
      throw new Error("The desktop shell returned a response that does not match the API contract.");
    if (!created.data.project || created.data.project.kind !== "existing") {
      throw new Error("The desktop shell returned a workspace with the wrong ownership kind.");
    }
    return created.data;
  }
  const parsed = createManimProjectRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The workspace registration is invalid.");
  const created = await readJson(
    await fetch("/api/manim/projects", {
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    manimProjectMutationViewSchema,
  );
  if (!created.project || created.project.kind !== parsed.data.kind) {
    throw new Error("The server returned a workspace with the wrong ownership kind.");
  }
  return created;
}

export async function renameManimProject(projectId: string, name: string, signal?: AbortSignal) {
  if (!manimProjectIdSchema.safeParse(projectId).success) {
    throw new Error("The project ID does not match the API contract.");
  }
  const parsed = renameManimProjectRequestSchema.safeParse({ name });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The workspace name is invalid.");
  return readJson(
    await fetch(`/api/manim/projects/${encodeURIComponent(projectId)}`, {
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
      method: "PATCH",
      signal,
    }),
    manimProjectMutationViewSchema,
  );
}

export async function unregisterManimProject(projectId: string, signal?: AbortSignal) {
  if (!manimProjectIdSchema.safeParse(projectId).success) {
    throw new Error("The project ID does not match the API contract.");
  }
  return readJson(
    await fetch(`/api/manim/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      signal,
    }),
    manimProjectMutationViewSchema,
  );
}

export async function loadManimThumbnailStatus(projectId: string, signal?: AbortSignal) {
  if (!manimProjectIdSchema.safeParse(projectId).success) {
    throw new Error("The project ID does not match the API contract.");
  }
  const status = await readJson(
    await fetch(`/api/manim/projects/${encodeURIComponent(projectId)}/thumbnail/status`, { signal }),
    manimThumbnailStatusSchema,
  );
  if (status.projectId !== projectId) {
    throw new Error("The server returned a thumbnail status for a different project.");
  }
  return status;
}

export async function generateManimThumbnail(projectId: string, signal?: AbortSignal) {
  if (!manimProjectIdSchema.safeParse(projectId).success) {
    throw new Error("The project ID does not match the API contract.");
  }
  const status = await readJson(
    await fetch(`/api/manim/projects/${encodeURIComponent(projectId)}/thumbnail/generate`, {
      body: JSON.stringify(manimThumbnailGenerateRequestSchema.parse({})),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    manimThumbnailStatusSchema,
  );
  if (status.projectId !== projectId) {
    throw new Error("The server returned a thumbnail status for a different project.");
  }
  return status;
}

export async function loadManimWorkspace(projectIdOrSignal?: string | AbortSignal, signal?: AbortSignal) {
  const projectId = typeof projectIdOrSignal === "string" ? projectIdOrSignal : null;
  const requestSignal = typeof projectIdOrSignal === "string" ? signal : projectIdOrSignal;
  if (projectId && !manimProjectIdSchema.safeParse(projectId).success) {
    throw new Error("The project ID does not match the API contract.");
  }
  const path = projectId ? `/api/manim/projects/${encodeURIComponent(projectId)}/workspace` : "/api/manim/workspace";
  const workspace = await readJson(await fetch(path, { signal: requestSignal }), manimWorkspaceViewSchema);
  if (projectId && workspace.projectId !== projectId) {
    throw new Error("The server returned a workspace for a different project.");
  }
  return workspace;
}

export async function startManimRender(request: ProgramRenderRequest, signal?: AbortSignal) {
  const parsedRequest = programRenderRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("The render request does not match the API contract.");
  }
  const session = await readJson(
    await fetch(`/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/renders`, {
      body: JSON.stringify(parsedRequest.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    renderSessionViewSchema,
  );
  if (session.projectId !== parsedRequest.data.projectId) {
    throw new Error("The server returned a render session for a different project.");
  }
  return session;
}

function attachmentFileName(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/(?:^|;)\s*filename="([^"]+)"/i);
  return match?.[1] ?? "manim-scene.py";
}

async function readPythonExport(response: Response, projectId: string): Promise<ManimSourceExport> {
  if (!response.ok) {
    throw apiError(response, await responseBody(response));
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/x-python") {
    throw new Error("The server returned an export that does not match the API contract.");
  }
  if (response.headers.get("x-poietra-project-id") !== projectId) {
    throw new Error("The server returned an export for a different project.");
  }
  return {
    fileName: attachmentFileName(response),
    projectId,
    source: await response.text(),
  };
}

export async function exportManimSource(
  request: ProgramRenderRequest,
  signal?: AbortSignal,
): Promise<ManimSourceExport> {
  const parsedRequest = programRenderRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("The export request does not match the API contract.");
  }
  const response = await fetch(`/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/export`, {
    body: JSON.stringify(parsedRequest.data),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  return readPythonExport(response, parsedRequest.data.projectId);
}

export async function exportOriginalManimSource(
  request: OriginalManimSourceExportRequest,
  signal?: AbortSignal,
): Promise<ManimSourceExport> {
  const parsedRequest = originalManimSourceExportRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("The original source export request does not match the API contract.");
  }
  const response = await fetch(`/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/export`, {
    body: JSON.stringify(parsedRequest.data),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  return readPythonExport(response, parsedRequest.data.projectId);
}

export async function loadManimRender(id: string, signal?: AbortSignal) {
  return readJson(await fetch(`/api/manim/renders/${encodeURIComponent(id)}`, { signal }), renderSessionViewSchema);
}

export async function runManimRenderAction(
  id: string,
  action: "cancel" | "commit" | "discard" | "undo",
  signal?: AbortSignal,
) {
  return readJson(
    await fetch(`/api/manim/renders/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      signal,
    }),
    renderSessionViewSchema,
  );
}
