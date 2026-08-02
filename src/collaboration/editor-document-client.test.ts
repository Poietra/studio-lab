import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { FetchEditorDocumentClientV1 } from "./editor-document-client";
import {
  canonicalEditorSessionSnapshotJsonV1,
  type EditorSessionSnapshotV1,
  editorSessionSnapshotByteSizeV1,
} from "./editor-session-contract";

const ORGANIZATION = "organization-a";
const PROJECT = "project-a";
const DOCUMENT_KEY = "a".repeat(64);
const EPOCH = "11111111-1111-4111-8111-111111111111";
const SOURCE_HASH = "b".repeat(64);
const SUBJECT = "22222222-2222-4222-8222-222222222222";

const sessionSnapshot = {
  appliedPrograms: [],
  currentTime: 0,
  draftOperation: null,
  draftProgram: null,
  editingAppliedProgram: null,
  insertTool: "select",
  interactionMode: "position",
  motionDuration: 1,
  programUndoEntries: [],
  redoPrograms: [],
  selectedObjectIds: [],
  verifiedSourceDurationBasis: null,
} satisfies EditorSessionSnapshotV1;
const sessionSnapshotDigest = createHash("sha256")
  .update(canonicalEditorSessionSnapshotJsonV1(sessionSnapshot), "utf8")
  .digest("hex");

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

function session(sessionGeneration = "1") {
  return {
    documentKey: DOCUMENT_KEY,
    documentRevision: "0",
    epoch: EPOCH,
    projectId: PROJECT,
    sessionGeneration,
    snapshot: sessionSnapshot,
    snapshotByteSize: editorSessionSnapshotByteSizeV1(sessionSnapshot),
    snapshotDigest: sessionSnapshotDigest,
    snapshotVersion: 1,
    tenantId: ORGANIZATION,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function availableSession(value = session()) {
  return { kind: "available", session: value } as const;
}

function commitRequest(baseRevision = "0") {
  return {
    baseRevision,
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
}

describe("Editor document HTTP client", () => {
  it("calls the browser fetch default with its required global receiver", async () => {
    const originalFetch = globalThis.fetch;
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
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
    });
    globalThis.fetch = browserFetch;
    try {
      const client = new FetchEditorDocumentClientV1();
      await expect(
        client.open(
          { organizationId: ORGANIZATION, projectId: PROJECT },
          { sceneName: "Demo", sourceHash: SOURCE_HASH, sourcePath: "scene.py" },
        ),
      ).resolves.toMatchObject({ created: true, kind: "opened" });
      expect(browserFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
    const request = commitRequest("3");
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

  it("requires exact immutable session evidence for an atomic commit", async () => {
    const request = {
      ...commitRequest(),
      sessionUpdate: {
        documentRevision: "1",
        expectedSessionGeneration: "0",
        snapshot: sessionSnapshot,
        snapshotVersion: 1 as const,
      },
    };
    const committed = {
      document: document("1"),
      event: {
        baseRevision: "0",
        byteSize: 100,
        clientMutationId: request.clientMutationId,
        committedAt: "2026-08-01T00:00:01.000Z",
        digest: "d".repeat(64),
        documentKey: DOCUMENT_KEY,
        epoch: EPOCH,
        mutation: request.mutation,
        projectId: PROJECT,
        revision: "1",
        subjectId: SUBJECT,
        tenantId: ORGANIZATION,
      },
      kind: "committed",
      replayed: false,
      sessionUpdate: {
        documentRevision: "1",
        sessionGeneration: "1",
        snapshotByteSize: editorSessionSnapshotByteSizeV1(sessionSnapshot),
        snapshotDigest: sessionSnapshotDigest,
        snapshotVersion: 1,
      },
    } as const;
    const accepted = new FetchEditorDocumentClientV1(
      async () => new Response(JSON.stringify(committed), { status: 201 }),
    );
    await expect(
      accepted.commit({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).resolves.toMatchObject({ kind: "committed", sessionUpdate: { sessionGeneration: "1" } });

    const missingEvidence = new FetchEditorDocumentClientV1(async () => {
      const { sessionUpdate: _sessionUpdate, ...withoutEvidence } = committed;
      return new Response(JSON.stringify(withoutEvidence), { status: 201 });
    });
    await expect(
      missingEvidence.commit({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 201 });

    const corruptEvidence = new FetchEditorDocumentClientV1(
      async () =>
        new Response(
          JSON.stringify({
            ...committed,
            sessionUpdate: { ...committed.sessionUpdate, snapshotDigest: "e".repeat(64) },
          }),
          { status: 200 },
        ),
    );
    await expect(
      corruptEvidence.commit({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });
  });

  it("reads a private session through the exact epoch-scoped same-origin endpoint", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      Promise.resolve(new Response(JSON.stringify(availableSession()), { status: 200 })),
    );
    const client = new FetchEditorDocumentClientV1(fetchImpl);

    await expect(
      client.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).resolves.toMatchObject({
      kind: "available",
      session: { sessionGeneration: "1", tenantId: ORGANIZATION },
    });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe(
      `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${encodeURIComponent(EPOCH)}`,
    );
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(new Headers(init?.headers).get(POIETRA_ORGANIZATION_HEADER_V1)).toBe(ORGANIZATION);
  });

  it("retains the CAS generation when a stale private snapshot is unavailable", async () => {
    const client = new FetchEditorDocumentClientV1(
      async () => new Response(JSON.stringify({ currentSessionGeneration: "7", kind: "unavailable" }), { status: 404 }),
    );

    await expect(
      client.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).resolves.toEqual({ currentSessionGeneration: "7", kind: "unavailable" });
  });

  it("puts a bounded session and accepts only matching replay/conflict statuses", async () => {
    const fetchImpl = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: "stored", replayed: false, session: session() }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentDocumentRevision: "0",
            currentSessionGeneration: "1",
            kind: "conflict",
            reason: "session-generation-mismatch",
          }),
          { status: 409 },
        ),
      );
    const client = new FetchEditorDocumentClientV1(fetchImpl);
    const request = {
      documentRevision: "0",
      epoch: EPOCH,
      expectedSessionGeneration: "0",
      snapshot: sessionSnapshot,
      snapshotVersion: 1 as const,
    };

    await expect(
      client.putSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).resolves.toMatchObject({ kind: "stored", replayed: false });
    await expect(
      client.putSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, request),
    ).resolves.toMatchObject({ kind: "conflict", reason: "session-generation-mismatch" });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe(
      `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${encodeURIComponent(EPOCH)}`,
    );
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", method: "PUT" });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("fails closed on unknown session response fields and a body/status mismatch", async () => {
    const unknown = new FetchEditorDocumentClientV1(
      async () => new Response(JSON.stringify({ ...availableSession(), internal: true }), { status: 200 }),
    );
    await expect(
      unknown.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });

    const wrongIdentity = new FetchEditorDocumentClientV1(
      async () =>
        new Response(JSON.stringify(availableSession({ ...session(), projectId: "project-b" })), { status: 200 }),
    );
    await expect(
      wrongIdentity.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });

    const corruptDigest = new FetchEditorDocumentClientV1(
      async () =>
        new Response(JSON.stringify(availableSession({ ...session(), snapshotDigest: "e".repeat(64) })), {
          status: 200,
        }),
    );
    await expect(
      corruptDigest.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });

    const corruptByteSize = new FetchEditorDocumentClientV1(
      async () =>
        new Response(JSON.stringify(availableSession({ ...session(), snapshotByteSize: 1 })), { status: 200 }),
    );
    await expect(
      corruptByteSize.readSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, { epoch: EPOCH }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 200 });

    const mismatch = new FetchEditorDocumentClientV1(
      async () =>
        new Response(JSON.stringify({ kind: "stored", replayed: false, session: session() }), { status: 201 }),
    );
    await expect(
      mismatch.putSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, {
        documentRevision: "0",
        epoch: EPOCH,
        expectedSessionGeneration: "0",
        snapshot: sessionSnapshot,
        snapshotVersion: 1,
      }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 201 });

    const corruptPutDigest = new FetchEditorDocumentClientV1(
      async () =>
        new Response(
          JSON.stringify({
            kind: "stored",
            replayed: false,
            session: { ...session(), snapshotDigest: "e".repeat(64) },
          }),
          { status: 201 },
        ),
    );
    await expect(
      corruptPutDigest.putSession({ organizationId: ORGANIZATION, projectId: PROJECT }, DOCUMENT_KEY, {
        documentRevision: "0",
        epoch: EPOCH,
        expectedSessionGeneration: "0",
        snapshot: sessionSnapshot,
        snapshotVersion: 1,
      }),
    ).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: 201 });
  });
});
