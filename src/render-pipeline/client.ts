import type { z } from "zod";

import type {
  ManimApiError,
  ProgramRenderRequest,
} from "./contracts";
import { manimWorkspaceViewSchema, renderSessionViewSchema } from "./contracts";

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("The server returned a response that does not match the API contract.");
  return parsed.data;
}

export async function loadManimWorkspace(signal?: AbortSignal) {
  return readJson(await fetch("/api/manim/workspace", { signal }), manimWorkspaceViewSchema);
}

export async function startManimRender(request: ProgramRenderRequest) {
  return readJson(await fetch("/api/manim/renders", {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), renderSessionViewSchema);
}

export async function loadManimRender(id: string, signal?: AbortSignal) {
  return readJson(await fetch(`/api/manim/renders/${id}`, { signal }), renderSessionViewSchema);
}

export async function runManimRenderAction(
  id: string,
  action: "cancel" | "commit" | "discard" | "undo",
) {
  return readJson(await fetch(`/api/manim/renders/${id}/${action}`, {
    method: "POST",
  }), renderSessionViewSchema);
}
