import type { z } from "zod";
import { fetchOrganizationScopedManimApiV1 } from "../accounts/organization-scoped-manim-fetch";
import { desktopBridge } from "../shell/desktop-bridge";
import type {
  BrowserManimProjectImportRequestV1,
  ManimApiError,
  ManimProjectCreateRequest,
  ManimSourceExport,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
  RenderCommitRequest,
  RenderSourceActionCancellationView,
  RenderSourceActionRequest,
  StudioNativeManimSourceExportRequest,
} from "./contracts";
import {
  browserManimProjectImportRequestV1Schema,
  createManimProjectRequestSchema,
  MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1,
  MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
  MAX_BROWSER_MANIM_SOURCE_BYTES_V1,
  manimProjectIdSchema,
  manimProjectListViewSchema,
  manimProjectMutationViewSchema,
  manimProjectNameSchema,
  manimThumbnailGenerateRequestSchema,
  manimThumbnailStatusSchema,
  manimWorkspaceViewSchema,
  originalManimSourceExportRequestSchema,
  programRenderRequestSchema,
  RENDER_SESSION_CONTRACT_VERSION_HEADER,
  RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
  renameManimProjectRequestSchema,
  renderAbandonRequestSchema,
  renderAbandonViewSchema,
  renderCommitRequestSchema,
  renderSessionViewSchema,
  renderSourceActionCancellationRequestSchema,
  renderSourceActionCancellationViewSchema,
  renderSourceActionRequestSchema,
  studioNativeManimSourceExportRequestSchema,
} from "./contracts";

export type BrowserManimProjectImportFileV1 = Readonly<{
  arrayBuffer: () => Promise<ArrayBuffer>;
  name: string;
  size: number;
}>;

export type ManimProjectCreationInput =
  | ManimProjectCreateRequest
  | Readonly<{
      file: BrowserManimProjectImportFileV1;
      imageFile?: BrowserManimProjectImportFileV1 | null;
      kind: "browser-import";
      name: string;
    }>
  | Readonly<{ kind: "native-existing"; name: string }>;

const BASE64_CHUNK_BYTES = 12 * 1024;

function encodeCanonicalBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))));
  }
  return chunks.join("");
}

const renderSessionHeaders = {
  [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
};

const renderSessionJsonHeaders = {
  "content-type": "application/json",
  ...renderSessionHeaders,
};

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
  return readJson(await fetchOrganizationScopedManimApiV1("/api/projects", { signal }), manimProjectListViewSchema);
}

export async function createManimProject(input: ManimProjectCreationInput, signal?: AbortSignal) {
  if (input.kind === "browser-import") {
    signal?.throwIfAborted();
    const imageFile = input.imageFile ?? null;
    if (
      !Number.isSafeInteger(input.file.size) ||
      input.file.size < 1 ||
      input.file.size > MAX_BROWSER_MANIM_SOURCE_BYTES_V1
    ) {
      throw new Error(`Select a non-empty Python file up to ${MAX_BROWSER_MANIM_SOURCE_BYTES_V1} bytes.`);
    }
    if (imageFile && imageFile.name !== "image.png") {
      throw new Error("The optional project image must use the exact filename image.png.");
    }
    if (
      imageFile &&
      (!Number.isSafeInteger(imageFile.size) ||
        imageFile.size < 1 ||
        imageFile.size > MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1)
    ) {
      throw new Error(`Select a non-empty image.png file up to ${MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1} bytes.`);
    }
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength !== input.file.size || bytes.byteLength > MAX_BROWSER_MANIM_SOURCE_BYTES_V1) {
      throw new Error("The selected Python file changed while Studio was reading it.");
    }
    let source: string;
    try {
      // Preserve a valid UTF-8 BOM so the immutable bytes reconstructed by the
      // server are byte-for-byte identical to the browser-selected file.
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("The selected Python file must use valid UTF-8 encoding.");
    }
    let imagePngBase64: string | null = null;
    if (imageFile) {
      const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
      signal?.throwIfAborted();
      if (
        imageBytes.byteLength !== imageFile.size ||
        imageBytes.byteLength < 1 ||
        imageBytes.byteLength > MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1
      ) {
        throw new Error("The selected image.png file changed while Studio was reading it.");
      }
      imagePngBase64 = encodeCanonicalBase64(imageBytes);
    }
    const request: BrowserManimProjectImportRequestV1 = {
      imagePngBase64,
      name: input.name,
      source,
      sourceName: input.file.name,
    };
    const parsed = browserManimProjectImportRequestV1Schema.safeParse(request);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The Python project import is invalid.");
    const body = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(body).byteLength > MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1) {
      throw new Error("The selected browser project exceeds the import request byte limit.");
    }
    const imported = await readJson(
      await fetchOrganizationScopedManimApiV1("/api/manim/project-imports", {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      }),
      manimProjectMutationViewSchema,
    );
    if (!imported.project || imported.project.kind !== "managed") {
      throw new Error("The server returned an imported workspace with the wrong ownership kind.");
    }
    return imported;
  }
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
    await fetchOrganizationScopedManimApiV1("/api/projects", {
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    manimProjectMutationViewSchema,
  );
  // A Studio-native project stays a server-owned managed catalog entry; the
  // native distinction lives on its Editor Document origin, not the catalog.
  const expectedCatalogKind = parsed.data.kind === "studio-native" ? "managed" : parsed.data.kind;
  if (!created.project || created.project.kind !== expectedCatalogKind) {
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
    await fetchOrganizationScopedManimApiV1(`/api/projects/${encodeURIComponent(projectId)}`, {
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
    await fetchOrganizationScopedManimApiV1(`/api/projects/${encodeURIComponent(projectId)}`, {
      headers: { "content-type": "application/json" },
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
    await fetchOrganizationScopedManimApiV1(`/api/projects/${encodeURIComponent(projectId)}/thumbnail/status`, {
      signal,
    }),
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
    await fetchOrganizationScopedManimApiV1(`/api/projects/${encodeURIComponent(projectId)}/thumbnail/generate`, {
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
  // The project-less bootstrap read has no neutral alias yet; only the
  // per-project workspace read moved to the neutral family (#712).
  const path = projectId ? `/api/projects/${encodeURIComponent(projectId)}/workspace` : "/api/manim/workspace";
  const workspace = await readJson(
    await fetchOrganizationScopedManimApiV1(path, { signal: requestSignal }),
    manimWorkspaceViewSchema,
  );
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
    await fetchOrganizationScopedManimApiV1(
      `/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/renders`,
      {
        body: JSON.stringify(parsedRequest.data),
        headers: renderSessionJsonHeaders,
        method: "POST",
        signal,
      },
    ),
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  let source: string;
  try {
    // Fetch Response.text() strips a leading UTF-8 BOM. Decode the owned bytes
    // explicitly so a browser import can round-trip the exact Python source.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("The server returned an export that is not valid UTF-8.");
  }
  return {
    fileName: attachmentFileName(response),
    projectId,
    source,
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
  const response = await fetchOrganizationScopedManimApiV1(
    `/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/export`,
    {
      body: JSON.stringify(parsedRequest.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    },
  );
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
  const response = await fetchOrganizationScopedManimApiV1(
    `/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/export`,
    {
      body: JSON.stringify(parsedRequest.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    },
  );
  return readPythonExport(response, parsedRequest.data.projectId);
}

export async function exportStudioNativeManimSource(
  request: StudioNativeManimSourceExportRequest,
  signal?: AbortSignal,
): Promise<ManimSourceExport> {
  const parsedRequest = studioNativeManimSourceExportRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("The Studio-native source export request does not match the API contract.");
  }
  const response = await fetchOrganizationScopedManimApiV1(
    `/api/manim/projects/${encodeURIComponent(parsedRequest.data.projectId)}/export`,
    {
      body: JSON.stringify(parsedRequest.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    },
  );
  return readPythonExport(response, parsedRequest.data.projectId);
}

export async function loadManimRender(id: string, signal?: AbortSignal) {
  return readJson(
    await fetchOrganizationScopedManimApiV1(`/api/manim/renders/${encodeURIComponent(id)}`, {
      headers: renderSessionHeaders,
      signal,
    }),
    renderSessionViewSchema,
  );
}

export async function abandonManimRender(id: string, renderRequestId: string, signal?: AbortSignal) {
  const body = renderAbandonRequestSchema.safeParse({ renderRequestId });
  if (!body.success) throw new Error("The abandoned render identity does not match the API contract.");
  return readJson(
    await fetchOrganizationScopedManimApiV1(`/api/manim/renders/${encodeURIComponent(id)}/abandon`, {
      body: JSON.stringify(body.data),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    renderAbandonViewSchema,
  );
}

export async function runManimRenderAction(
  id: string,
  action: "cancel" | "commit" | "discard" | "undo",
  signal?: AbortSignal,
  sourceActionRequest?: RenderCommitRequest | RenderSourceActionRequest,
) {
  let body: RenderCommitRequest | RenderSourceActionRequest | Readonly<Record<string, never>> = {};
  let expectedSourceAction: Readonly<{ actionId: string; kind: "commit" | "undo" }> | null = null;
  if (action === "commit") {
    const parsed = renderCommitRequestSchema.safeParse(sourceActionRequest);
    if (!parsed.success) throw new Error("The render commit no longer matches the active Studio candidate.");
    body = parsed.data;
    expectedSourceAction = { actionId: parsed.data.actionId, kind: "commit" };
  } else if (action === "undo") {
    const parsed = renderSourceActionRequestSchema.safeParse(sourceActionRequest);
    if (!parsed.success) throw new Error("The Undo action ID does not match the API contract.");
    body = parsed.data;
    expectedSourceAction = { actionId: parsed.data.actionId, kind: "undo" };
  }
  const session = await readJson(
    await fetchOrganizationScopedManimApiV1(`/api/manim/renders/${encodeURIComponent(id)}/${action}`, {
      body: JSON.stringify(body),
      headers: renderSessionJsonHeaders,
      method: "POST",
      signal,
    }),
    renderSessionViewSchema,
  );
  if (expectedSourceAction) {
    const expectedOutcome = expectedSourceAction.kind === "commit" ? "committed" : "undone";
    if (
      !session.sourceAction ||
      session.sourceAction.id !== expectedSourceAction.actionId ||
      session.sourceAction.kind !== expectedSourceAction.kind ||
      session.sourceAction.state !== "succeeded" ||
      session.sourceAction.outcome !== expectedOutcome
    ) {
      throw new Error("The server did not confirm the exact source action.");
    }
  }
  return session;
}

export async function cancelManimRenderSourceAction(
  id: string,
  actionId: string,
  kind: "commit" | "undo",
  signal?: AbortSignal,
): Promise<RenderSourceActionCancellationView> {
  const body = renderSourceActionCancellationRequestSchema.safeParse({ actionId, kind });
  if (!body.success) throw new Error("The source-action cancellation does not match the API contract.");
  return readJson(
    await fetchOrganizationScopedManimApiV1(`/api/manim/renders/${encodeURIComponent(id)}/cancel-source-action`, {
      body: JSON.stringify(body.data),
      headers: renderSessionJsonHeaders,
      method: "POST",
      signal,
    }),
    renderSourceActionCancellationViewSchema,
  );
}
