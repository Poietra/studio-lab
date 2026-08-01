import { describe, expect, it, vi } from "vitest";

import {
  type CloudflareEditorCollaborationEnvironmentV1,
  createCloudflareEditorCollaborationWorkerV1,
  type EditorCollaborationAuthorizeV1,
} from "./cloudflare-editor-collaboration-worker";
import { EDITOR_LIVE_INTERNAL_HEADERS_V1, EDITOR_LIVE_INTERNAL_ROUTE_V1 } from "./editor-project-room-durable-object";

const origin = "https://studio.example";
const documentKey = "a".repeat(64);
const epoch = "11111111-1111-4111-8111-111111111111";
const subjectId = "22222222-2222-4222-8222-222222222222";

function request(overrides: Readonly<{ path?: string; origin?: string; search?: string }> = {}) {
  const path = overrides.path ?? `/api/collaboration/projects/project-a/documents/${documentKey}`;
  return new Request(`${origin}${path}${overrides.search ?? `?epoch=${epoch}&protocolVersion=1`}`, {
    headers: {
      cookie: `__Host-poietra_session=${"A".repeat(43)}`,
      "cf-connecting-ip": "203.0.113.10",
      origin: overrides.origin ?? origin,
      "sec-fetch-site": "same-origin",
      upgrade: "websocket",
      "x-poietra-internal-subject-id": "attacker-controlled",
    },
  });
}

function harness() {
  const forwarded = vi.fn<(request: Request) => Promise<Response>>(async () => new Response(null, { status: 204 }));
  const idFromName = vi.fn((name: string) => `room:${name}`);
  const get = vi.fn(() => ({ fetch: forwarded }));
  const limit = vi.fn(async () => ({ success: true }));
  const environment = {
    EDITOR_CONNECT_RATE_LIMITER: { limit },
    EDITOR_HEAD_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    EDITOR_ROOMS: { get, idFromName },
    HYPERDRIVE: { connectionString: "postgresql://user:password@database.example:5432/poietra" },
    POIETRA_PUBLIC_ORIGIN: origin,
  } satisfies CloudflareEditorCollaborationEnvironmentV1;
  const authorize = vi.fn<EditorCollaborationAuthorizeV1>(async () => ({
    canWrite: true,
    kind: "authorized" as const,
    organizationId: "organization-a",
    subjectId,
  }));
  return {
    authorize,
    environment,
    forwarded,
    get,
    idFromName,
    limit,
    worker: createCloudflareEditorCollaborationWorkerV1({ authorize }),
  };
}

describe("Cloudflare Editor collaboration Worker", () => {
  it("authenticates and routes an exact document epoch without forwarding untrusted headers", async () => {
    const value = harness();
    const response = await value.worker.fetch(request(), value.environment);

    expect(response.status).toBe(204);
    expect(value.authorize).toHaveBeenCalledWith(
      expect.any(Request),
      { documentKey, epoch, projectId: "project-a" },
      value.environment,
    );
    expect(value.idFromName).toHaveBeenCalledWith(`organization-a\0project-a\0${documentKey}\0${epoch}`);
    expect(value.get).toHaveBeenCalledWith(`room:organization-a\0project-a\0${documentKey}\0${epoch}`);
    expect(value.limit).toHaveBeenNthCalledWith(1, { key: "editor-connect:ip:203.0.113.10" });
    expect(value.limit).toHaveBeenNthCalledWith(2, {
      key: `editor-connect:subject:organization-a:${subjectId}`,
    });
    const internal = value.forwarded.mock.calls[0]![0];
    const headers = EDITOR_LIVE_INTERNAL_HEADERS_V1;
    expect(new URL(internal.url).pathname).toBe(EDITOR_LIVE_INTERNAL_ROUTE_V1);
    expect(internal.headers.get(headers.organizationId)).toBe("organization-a");
    expect(internal.headers.get(headers.projectId)).toBe("project-a");
    expect(internal.headers.get(headers.documentKey)).toBe(documentKey);
    expect(internal.headers.get(headers.epoch)).toBe(epoch);
    expect(internal.headers.get(headers.subjectId)).toBe(subjectId);
    expect(internal.headers.get(headers.canWrite)).toBe("1");
    expect(internal.headers.get("cookie")).toBeNull();
  });

  it.each([
    ["wrong origin", request({ origin: "https://attacker.example" }), 403],
    ["wrong path", request({ path: "/api/collaboration/wrong" }), 404],
    ["missing epoch", request({ search: "?protocolVersion=1" }), 400],
    ["duplicate epoch", request({ search: `?epoch=${epoch}&epoch=${epoch}&protocolVersion=1` }), 400],
    ["future protocol", request({ search: `?epoch=${epoch}&protocolVersion=2` }), 400],
  ])("rejects %s before authorization", async (_label, input, status) => {
    const value = harness();
    const response = await value.worker.fetch(input, value.environment);

    expect(response.status).toBe(status);
    expect(value.authorize).not.toHaveBeenCalled();
    expect(value.limit).not.toHaveBeenCalled();
    expect(value.forwarded).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503] as const)("does not create a room after a %s admission denial", async (status) => {
    const value = harness();
    value.authorize.mockResolvedValueOnce({ kind: "denied", status });

    const response = await value.worker.fetch(request(), value.environment);

    expect(response.status).toBe(status);
    expect(value.idFromName).not.toHaveBeenCalled();
    expect(value.forwarded).not.toHaveBeenCalled();
  });

  it("fails closed when authorization returns a malformed internal identity", async () => {
    const value = harness();
    value.authorize.mockResolvedValueOnce({
      canWrite: true,
      kind: "authorized",
      organizationId: "INVALID ORGANIZATION",
      subjectId,
    });

    const response = await value.worker.fetch(request(), value.environment);

    expect(response.status).toBe(503);
    expect(value.forwarded).not.toHaveBeenCalled();
  });

  it("requires the Durable Object binding before authorization", async () => {
    const value = harness();
    const environment = { ...value.environment, EDITOR_ROOMS: undefined } as unknown as typeof value.environment;

    const response = await value.worker.fetch(request(), environment);

    expect(response.status).toBe(503);
    expect(value.authorize).not.toHaveBeenCalled();
  });

  it("fails closed before authorization when the connect limiter denies or is malformed", async () => {
    const denied = harness();
    denied.limit.mockResolvedValueOnce({ success: false });
    const deniedResponse = await denied.worker.fetch(request(), denied.environment);
    expect(deniedResponse.status).toBe(429);
    expect(deniedResponse.headers.get("retry-after")).toBe("60");
    expect(denied.authorize).not.toHaveBeenCalled();

    const malformed = harness();
    malformed.limit.mockResolvedValueOnce({ allowed: true } as never);
    const malformedResponse = await malformed.worker.fetch(request(), malformed.environment);
    expect(malformedResponse.status).toBe(503);
    expect(malformed.authorize).not.toHaveBeenCalled();
  });

  it("rate-limits the authenticated member before creating a room", async () => {
    const value = harness();
    value.limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });

    const response = await value.worker.fetch(request(), value.environment);

    expect(response.status).toBe(429);
    expect(value.authorize).toHaveBeenCalledOnce();
    expect(value.idFromName).not.toHaveBeenCalled();
  });
});
