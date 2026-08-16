import { accountOrganizationIdSchemaV1 } from "./account-session-contract";

export const POIETRA_ORGANIZATION_HEADER_V1 = "X-Poietra-Organization-Id";

// undefined keeps the native/local shells unchanged. null is a fail-closed
// browser-account transition in which Studio must not issue Manim requests.
let activeOrganizationId: string | null | undefined;

export function setManimOrganizationScopeV1(organizationId: string | null | undefined) {
  if (organizationId !== null && organizationId !== undefined) {
    const parsed = accountOrganizationIdSchemaV1.safeParse(organizationId);
    if (!parsed.success) throw new TypeError("The Manim API organization scope is invalid.");
    activeOrganizationId = parsed.data;
    return;
  }
  activeOrganizationId = organizationId;
}

export async function fetchOrganizationScopedManimApiV1(input: RequestInfo | URL, init?: RequestInit) {
  // The tenant API mounts two route families for one handler set (#712): the
  // legacy `/api/manim/` prefix and the neutral aliases of its generic
  // surfaces (`/api/projects`, `/api/project-imports`).
  if (typeof input !== "string" || !/^\/api\/(?:manim|projects|project-imports)(?:\/|$)/.test(input)) {
    throw new TypeError("The Manim API client accepts only same-origin API paths.");
  }
  if (activeOrganizationId === undefined) return fetch(input, init);
  if (activeOrganizationId === null) {
    throw new Error("The account organization is being refreshed.");
  }
  const headers = new Headers(init?.headers);
  const suppliedOrganizationId = headers.get(POIETRA_ORGANIZATION_HEADER_V1);
  if (suppliedOrganizationId !== null && suppliedOrganizationId !== activeOrganizationId) {
    throw new Error("The Manim request organization does not match the active account.");
  }
  headers.set(POIETRA_ORGANIZATION_HEADER_V1, activeOrganizationId);
  return fetch(input, { ...init, headers });
}
