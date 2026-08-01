import { describe, expect, it, vi } from "vitest";

import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { FetchEditorDocumentClientV1 } from "./editor-document-client";

const ORGANIZATION = "organization-a";
const PROJECT = "project-a";
const DOCUMENT_KEY = "a".repeat(64);
const EPOCH = "11111111-1111-4111-8111-111111111111";
const SOURCE_HASH = "b".repeat(64);

function document(revision = "0") {
  return {
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    openedAt: "2026-08-01T00:00:00.000Z",
    projectId: PROJECT,
    revision,
    sealedAt: null,
    sourceHash: SOURCE_HASH,
    sourcePath: "scene.py",
    tenantId: ORGANIZATION,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("Editor document HTTP client", () => {
  it("opens only the same-origin organization-scoped endpoint and strictly parses its projection", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            created: true,
            document: document(),
            kind: "opened",
            projection: { programs: [], revision: "0" },
          }),
          { headers: { "content-type": "application/json" }, status: 201 },
        ),
    );
    const client = new FetchEditorDocumentClientV1(fetchImpl);

    await expect(
      client.open(
        { organizationId: ORGANIZATION, projectId: PROJECT },
        { sceneName: "Demo", sourceHash: SOURCE_HASH, sourcePath: "scene.py" },
      ),
    ).resolves.toMatchObject({ created: true, kind: "opened" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/editor/projects/project-a/documents/open");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", method: "POST" });
    expect(new Headers(init?.headers).get(POIETRA_ORGANIZATION_HEADER_V1)).toBe(ORGANIZATION);
    expect(JSON.parse(String(init?.body))).toEqual({
      sceneName: "Demo",
      sourceHash: SOURCE_HASH,
      sourcePath: "scene.py",
    });
  });

  it("accepts typed commit conflicts but rejects status/body mismatches", async () => {
    const conflict = vi.fn(
      async () =>
        new Response(JSON.stringify({ currentRevision: "4", kind: "conflict", reason: "revision-mismatch" }), {
          headers: { "content-type": "application/json" },
          status: 409,
        }),
    );
    const request = {
      baseRevision: "3",
      clientMutationId: "22222222-2222-4222-8222-222222222222",
      epoch: EPOCH,
      mutation: {
        kind: "append" as const,
        program: {
          anchor: {
            capturedPlayhead: 1,
            evidence: [],
            resolvedSeconds: 1,
            source: { kind: "absolute" as const, seconds: 1 },
          },
          intentCount: 1,
          loweringStatus: "supported" as const,
          operations: [
            {
              dependsOn: [],
              eventKind: "wait" as const,
              id: "wait/event",
              interval: { end: 2, start: 1 },
              kind: "InsertTimelineEvent" as const,
              label: "wait",
              provenance: { evidence: [], origin: "studio-default" as const },
            },
          ],
          provenance: { evidence: [], origin: "studio-default" as const },
          requestedExecution: "sequence" as const,
          schedule: { edges: [], mode: "sequence" as const, order: ["wait/event"] },
          transactionId: "wait",
          version: 1 as const,
        },
      },
    };
    const client = new FetchEditorDocumentClientV1(conflict);
    await expect(
      client.commit({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).resolves.toEqual({
      currentRevision: "4",
      kind: "conflict",
      reason: "revision-mismatch",
    });

    const mismatched = new FetchEditorDocumentClientV1(
      async () =>
        new Response(JSON.stringify({ currentRevision: "4", kind: "conflict", reason: "revision-mismatch" }), {
          status: 200,
        }),
    );
    await expect(
      mismatched.commit({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });
  });
});
