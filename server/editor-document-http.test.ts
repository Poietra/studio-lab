import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEditProgram } from "../src/studio/operations";
import { handleEditorDocumentRequest, isEditorDocumentRequest } from "./editor-document-http";
import { fastManimSnapshotSceneIdV1 } from "./fast-manim-snapshot-contract";
import { authenticateManimPrincipal } from "./manim-request-principal";
import {
  canonicalEditorProgramV1,
  canonicalEditorSessionSnapshotV1,
  createEditorDocumentKeyV1,
  type EditorDocumentRepositoryV1,
  type EditorDocumentV1,
  type EditorEditEventV1,
  MAX_EDITOR_PROGRAM_BYTES_V1,
} from "./storage/editor-document-repository";

const TENANT = "tenant-a";
const SUBJECT = "10000000-0000-4000-8000-000000000001";
const PROJECT = "project-a";
const SOURCE_PATH = "scene.py";
const SOURCE_HASH = "a".repeat(64);
const SCENE_NAME = "MainScene";
const SCENE_ID = fastManimSnapshotSceneIdV1(SOURCE_PATH, SCENE_NAME);
const DOCUMENT_KEY = createEditorDocumentKeyV1(SOURCE_PATH, SCENE_ID);
const EPOCH = "20000000-0000-4000-8000-000000000002";
const MUTATION_ID = "30000000-0000-4000-8000-000000000003";
const ORIGIN = "https://studio.example";
const servers: ReturnType<typeof createServer>[] = [];

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
} as const;

function program(transactionId = "motion", evidence: readonly string[] = []): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 20, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: `${transactionId}/move`,
    interval: { end: 2, start: 1 },
    kind: "CreateMotion" as const,
    provenance: { evidence, origin: "direct-manipulation" as const },
    targetEntityIds: ["equation"],
  };
  return {
    anchor: {
      capturedPlayhead: 1,
      evidence,
      resolvedSeconds: 1,
      source: { kind: "absolute", seconds: 1 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence, origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

const mutation = { kind: "append", program: program() } as const;

function projection(revision = 0n, programs: readonly CanonicalEditProgram[] = revision === 0n ? [] : [program()]) {
  return { programs, revision } as const;
}

function document(revision = 0n): EditorDocumentV1 {
  return {
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    openedAt: new Date("2026-08-01T00:00:00.000Z"),
    projectId: PROJECT,
    revision,
    sealedAt: null,
    sourceHash: SOURCE_HASH,
    sourcePath: SOURCE_PATH,
    tenantId: TENANT,
    updatedAt: new Date(`2026-08-01T00:00:0${revision}.000Z`),
  };
}

function event(): EditorEditEventV1 {
  const canonical = canonicalEditorProgramV1(mutation.program);
  return {
    baseRevision: 0n,
    byteSize: canonical.byteSize,
    clientMutationId: MUTATION_ID,
    committedAt: new Date("2026-08-01T00:00:01.000Z"),
    digest: canonical.digest,
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    mutation,
    projectId: PROJECT,
    revision: 1n,
    subjectId: SUBJECT,
    tenantId: TENANT,
  };
}

function session(documentRevision = 0n, sessionGeneration = 1n) {
  const canonical = canonicalEditorSessionSnapshotV1(sessionSnapshot);
  return {
    documentKey: DOCUMENT_KEY,
    documentRevision,
    epoch: EPOCH,
    projectId: PROJECT,
    sessionGeneration,
    snapshot: sessionSnapshot,
    snapshotByteSize: canonical.byteSize,
    snapshotDigest: canonical.digest,
    snapshotVersion: 1 as const,
    subjectId: SUBJECT,
    tenantId: TENANT,
    updatedAt: new Date("2026-08-01T00:00:02.000Z"),
  };
}

function availableSession(value = session()) {
  return { kind: "available", session: value } as const;
}

function repository(overrides: Partial<EditorDocumentRepositoryV1> = {}): EditorDocumentRepositoryV1 {
  return {
    close: async () => undefined,
    commitMutation: async () => ({ document: document(1n), event: event(), kind: "committed", replayed: false }),
    openDocument: async () => ({ created: true, document: document(), kind: "opened", projection: projection() }),
    putSessionSnapshot: async () => ({ kind: "stored", replayed: false, session: session() }),
    readEventTail: async () => ({ document: document(1n), events: [event()] }),
    readSessionSnapshot: async () => availableSession(),
    ready: async () => true,
    ...overrides,
  };
}

async function principal(subjectId = SUBJECT) {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId, tenantId: TENANT }) },
    null,
    new AbortController().signal,
  );
}

async function listen(
  storage: EditorDocumentRepositoryV1,
  options: Parameters<typeof handleEditorDocumentRequest>[4] = {},
  principalValue?: Awaited<ReturnType<typeof principal>>,
) {
  const authenticated = principalValue ?? (await principal());
  const server = createServer((request, response) => {
    void handleEditorDocumentRequest(storage, authenticated, request, response, options).catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end('{"error":"failed"}');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function send(
  port: number,
  path: string,
  options: Readonly<{ body?: unknown; headers?: Record<string, string>; method?: string }> = {},
) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
    headers: options.headers,
    method: options.method ?? "GET",
  });
  const body = (await response.json()) as unknown;
  return { allow: response.headers.get("allow"), body, status: response.status };
}

function mutationHeaders(contentType = "application/json") {
  return { "content-type": contentType, origin: ORIGIN, "sec-fetch-site": "same-origin" };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
  );
});

describe("authenticated Editor document HTTP handler", () => {
  it("derives Scene identity server-side and opens in the principal tenant", async () => {
    const openDocument = vi.fn(
      async () =>
        ({
          created: true,
          document: document(),
          kind: "opened",
          projection: projection(),
        }) as const,
    );
    const port = await listen(repository({ openDocument }), { expectedMutationOrigin: ORIGIN });

    const result = await send(port, `/api/editor/projects/${PROJECT}/documents/open`, {
      body: { sceneName: SCENE_NAME, sourceHash: SOURCE_HASH, sourcePath: SOURCE_PATH },
      headers: mutationHeaders(),
      method: "POST",
    });

    expect(result).toMatchObject({
      body: {
        created: true,
        document: { documentKey: DOCUMENT_KEY, revision: "0" },
        kind: "opened",
        projection: { programs: [], revision: "0" },
      },
      status: 201,
    });
    expect(openDocument).toHaveBeenCalledWith(
      { projectId: PROJECT, sceneId: SCENE_ID, sourceHash: SOURCE_HASH, sourcePath: SOURCE_PATH, tenantId: TENANT },
      undefined,
    );
    expect(isEditorDocumentRequest(`/api/editor/projects/${PROJECT}/documents/open`)).toBe(true);
  });

  it("fails closed when an opened projection disagrees with its document or exceeds the wire bound", async () => {
    const path = `/api/editor/projects/${PROJECT}/documents/open`;
    const request = (port: number) =>
      send(port, path, {
        body: { sceneName: SCENE_NAME, sourceHash: SOURCE_HASH, sourcePath: SOURCE_PATH },
        headers: mutationHeaders(),
        method: "POST",
      });
    const mismatchedPort = await listen(
      repository({
        openDocument: async () => ({
          created: false,
          document: document(1n),
          kind: "opened",
          projection: projection(0n),
        }),
      }),
      { expectedMutationOrigin: ORIGIN },
    );
    expect(await request(mismatchedPort)).toMatchObject({ status: 500 });

    const baseProgram = program();
    const oversizedProgram: CanonicalEditProgram = {
      ...baseProgram,
      operations: [
        {
          ...baseProgram.operations[0]!,
          provenance: {
            ...baseProgram.operations[0]!.provenance,
            evidence: ["x".repeat(MAX_EDITOR_PROGRAM_BYTES_V1)],
          },
        },
      ],
    };
    const oversizedPort = await listen(
      repository({
        openDocument: async () => ({
          created: false,
          document: document(1n),
          kind: "opened",
          projection: projection(1n, [oversizedProgram]),
        }),
      }),
      { expectedMutationOrigin: ORIGIN },
    );
    expect(await request(oversizedPort)).toMatchObject({ status: 500 });
  });

  it("commits with server-owned identity and reads a bounded decimal-revision tail", async () => {
    const commitMutation = vi.fn(repository().commitMutation);
    const readEventTail = vi.fn(repository().readEventTail);
    const signal = new AbortController().signal;
    const port = await listen(repository({ commitMutation, readEventTail }), {
      expectedMutationOrigin: ORIGIN,
      requestSignal: signal,
    });
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;

    const committed = await send(port, path, {
      body: { baseRevision: "0", clientMutationId: MUTATION_ID, epoch: EPOCH, mutation },
      headers: mutationHeaders(),
      method: "POST",
    });
    const tail = await send(port, `${path}?epoch=${EPOCH}&afterRevision=0`);

    expect(committed).toMatchObject({ body: { event: { baseRevision: "0", revision: "1" } }, status: 201 });
    expect(tail).toMatchObject({ body: { document: { revision: "1" }, events: [{ revision: "1" }] }, status: 200 });
    expect(commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: SUBJECT, tenantId: TENANT }),
      signal,
    );
    expect(readEventTail).toHaveBeenCalledWith(
      expect.objectContaining({ afterRevision: 0n, limit: 32, tenantId: TENANT }),
      signal,
    );
  });

  it("reads and updates only the principal subject's epoch-scoped session", async () => {
    const readSessionSnapshot = vi.fn(repository().readSessionSnapshot);
    const putSessionSnapshot = vi.fn(repository().putSessionSnapshot);
    const signal = new AbortController().signal;
    const port = await listen(repository({ putSessionSnapshot, readSessionSnapshot }), {
      expectedMutationOrigin: ORIGIN,
      requestSignal: signal,
    });
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${EPOCH}`;

    expect(await send(port, path)).toMatchObject({
      body: {
        kind: "available",
        session: { documentRevision: "0", sessionGeneration: "1", tenantId: TENANT },
      },
      status: 200,
    });
    expect(
      await send(port, path, {
        body: {
          documentRevision: "0",
          epoch: EPOCH,
          expectedSessionGeneration: "0",
          snapshot: sessionSnapshot,
          snapshotVersion: 1,
        },
        headers: mutationHeaders(),
        method: "PUT",
      }),
    ).toMatchObject({ body: { kind: "stored", replayed: false }, status: 200 });
    const identity = {
      documentKey: DOCUMENT_KEY,
      epoch: EPOCH,
      projectId: PROJECT,
      subjectId: SUBJECT,
      tenantId: TENANT,
    };
    expect(readSessionSnapshot).toHaveBeenCalledWith(identity, signal);
    expect(putSessionSnapshot).toHaveBeenCalledWith(
      {
        ...identity,
        documentRevision: 0n,
        expectedSessionGeneration: 0n,
        snapshot: sessionSnapshot,
        snapshotVersion: 1,
      },
      signal,
    );
    expect(isEditorDocumentRequest(path.split("?", 1)[0]!)).toBe(true);
  });

  it("returns a stale session generation without disclosing its snapshot", async () => {
    const port = await listen(
      repository({
        readSessionSnapshot: async () => ({ currentSessionGeneration: 7n, kind: "unavailable" }),
      }),
    );
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${EPOCH}`;

    expect(await send(port, path)).toMatchObject({
      body: { currentSessionGeneration: "7", kind: "unavailable" },
      status: 404,
    });
  });

  it("atomically forwards a post-event session update and returns immutable evidence", async () => {
    const canonical = canonicalEditorSessionSnapshotV1(sessionSnapshot);
    const commitMutation = vi.fn<EditorDocumentRepositoryV1["commitMutation"]>(async (input) => ({
      document: document(1n),
      event: event(),
      kind: "committed",
      replayed: false,
      sessionUpdate: input.sessionUpdate
        ? {
            documentRevision: input.sessionUpdate.documentRevision,
            sessionGeneration: input.sessionUpdate.expectedSessionGeneration + 1n,
            snapshotByteSize: canonical.byteSize,
            snapshotDigest: canonical.digest,
            snapshotVersion: input.sessionUpdate.snapshotVersion,
          }
        : undefined,
    }));
    const port = await listen(repository({ commitMutation }), { expectedMutationOrigin: ORIGIN });
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;
    const sessionUpdate = {
      documentRevision: "1",
      expectedSessionGeneration: "0",
      snapshot: sessionSnapshot,
      snapshotVersion: 1,
    } as const;

    expect(
      await send(port, path, {
        body: { baseRevision: "0", clientMutationId: MUTATION_ID, epoch: EPOCH, mutation, sessionUpdate },
        headers: mutationHeaders(),
        method: "POST",
      }),
    ).toMatchObject({
      body: {
        event: { revision: "1" },
        sessionUpdate: {
          documentRevision: "1",
          sessionGeneration: "1",
          snapshotByteSize: canonical.byteSize,
          snapshotDigest: canonical.digest,
        },
      },
      status: 201,
    });
    expect(commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdate: {
          documentRevision: 1n,
          expectedSessionGeneration: 0n,
          snapshot: sessionSnapshot,
          snapshotVersion: 1,
        },
        subjectId: SUBJECT,
        tenantId: TENANT,
      }),
      undefined,
    );
  });

  it("admits a valid session snapshot above the legacy event-only route limit", async () => {
    const evidence = Array.from({ length: 64 }, (_, index) => `${index.toString().padStart(2, "0")}${"x".repeat(498)}`);
    const record = {
      program: program("large-session", evidence),
      validation: { issues: [], status: "valid" as const },
    };
    const largeSnapshot = {
      ...sessionSnapshot,
      redoPrograms: Array.from({ length: 3 }, () => ({ edit: null, kind: "draft" as const, value: record })),
      selectedObjectIds: Array.from(
        { length: 8 },
        (_, index) => `${index.toString().padStart(2, "0")}${"s".repeat(498)}`,
      ),
    };
    const canonical = canonicalEditorSessionSnapshotV1(largeSnapshot);
    expect(canonical.byteSize).toBeGreaterThan(288 * 1024);
    const commitMutation = vi.fn<EditorDocumentRepositoryV1["commitMutation"]>(async () => ({
      kind: "conflict",
      reason: "projection-mismatch",
    }));
    const port = await listen(repository({ commitMutation }), { expectedMutationOrigin: ORIGIN });

    expect(
      await send(port, `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`, {
        body: {
          baseRevision: "0",
          clientMutationId: MUTATION_ID,
          epoch: EPOCH,
          mutation,
          sessionUpdate: {
            documentRevision: "1",
            expectedSessionGeneration: "0",
            snapshot: largeSnapshot,
            snapshotVersion: 1,
          },
        },
        headers: mutationHeaders(),
        method: "POST",
      }),
    ).toMatchObject({ body: { kind: "conflict", reason: "projection-mismatch" }, status: 409 });
    expect(commitMutation).toHaveBeenCalledOnce();
  });

  it("maps session replay and conflicts to stable statuses", async () => {
    const putSessionSnapshot = vi
      .fn<EditorDocumentRepositoryV1["putSessionSnapshot"]>()
      .mockResolvedValueOnce({ kind: "stored", replayed: true, session: session() })
      .mockResolvedValueOnce({ kind: "conflict", reason: "forbidden" })
      .mockResolvedValueOnce({ kind: "conflict", reason: "not-found" })
      .mockResolvedValueOnce({ kind: "conflict", reason: "epoch-mismatch" })
      .mockResolvedValueOnce({
        currentDocumentRevision: 2n,
        currentSessionGeneration: 3n,
        kind: "conflict",
        reason: "session-generation-mismatch",
      });
    const port = await listen(repository({ putSessionSnapshot }), { expectedMutationOrigin: ORIGIN });
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${EPOCH}`;
    const request = () =>
      send(port, path, {
        body: {
          documentRevision: "0",
          epoch: EPOCH,
          expectedSessionGeneration: "0",
          snapshot: sessionSnapshot,
          snapshotVersion: 1,
        },
        headers: mutationHeaders(),
        method: "PUT",
      });

    expect(await request()).toMatchObject({ body: { kind: "stored", replayed: true }, status: 200 });
    expect(await request()).toEqual({ allow: null, body: { kind: "conflict", reason: "forbidden" }, status: 403 });
    expect(await request()).toEqual({ allow: null, body: { kind: "conflict", reason: "not-found" }, status: 404 });
    expect(await request()).toEqual({
      allow: null,
      body: { kind: "conflict", reason: "epoch-mismatch" },
      status: 409,
    });
    expect(await request()).toEqual({
      allow: null,
      body: {
        currentDocumentRevision: "2",
        currentSessionGeneration: "3",
        kind: "conflict",
        reason: "session-generation-mismatch",
      },
      status: 409,
    });
  });

  it("maps replay and structured repository outcomes to stable statuses", async () => {
    const commitMutation = vi
      .fn<EditorDocumentRepositoryV1["commitMutation"]>()
      .mockResolvedValueOnce({ document: document(4n), event: event(), kind: "committed", replayed: true })
      .mockResolvedValueOnce({ document: document(2n), event: event(), kind: "committed", replayed: false })
      .mockResolvedValueOnce({ kind: "conflict", reason: "forbidden" })
      .mockResolvedValueOnce({ kind: "conflict", reason: "not-found" })
      .mockResolvedValueOnce({ currentRevision: 2n, kind: "conflict", reason: "revision-mismatch" });
    const port = await listen(repository({ commitMutation }), { expectedMutationOrigin: ORIGIN });
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;
    const request = () =>
      send(port, path, {
        body: { baseRevision: "0", clientMutationId: MUTATION_ID, epoch: EPOCH, mutation },
        headers: mutationHeaders(),
        method: "POST",
      });

    expect(await request()).toMatchObject({
      body: { document: { revision: "4" }, event: { revision: "1" }, kind: "committed", replayed: true },
      status: 200,
    });
    expect(await request()).toMatchObject({ status: 500 });
    expect(await request()).toEqual({ allow: null, body: { kind: "conflict", reason: "forbidden" }, status: 403 });
    expect(await request()).toEqual({ allow: null, body: { kind: "conflict", reason: "not-found" }, status: 404 });
    expect(await request()).toEqual({
      allow: null,
      body: { currentRevision: "2", kind: "conflict", reason: "revision-mismatch" },
      status: 409,
    });
  });

  it("rejects unsafe mutations and non-canonical tail queries before storage", async () => {
    const openDocument = vi.fn(repository().openDocument);
    const readEventTail = vi.fn(repository().readEventTail);
    const port = await listen(repository({ openDocument, readEventTail }), {
      expectedMutationOrigin: ORIGIN,
      maxJsonBodyBytes: 128,
    });
    const openPath = `/api/editor/projects/${PROJECT}/documents/open`;
    const eventPath = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;
    const openBody = { sceneName: SCENE_NAME, sourceHash: SOURCE_HASH, sourcePath: SOURCE_PATH };

    expect(
      await send(port, openPath, { body: openBody, headers: { "content-type": "application/json" }, method: "POST" }),
    ).toMatchObject({ status: 403 });
    expect(
      await send(port, openPath, { body: openBody, headers: mutationHeaders("text/plain"), method: "POST" }),
    ).toMatchObject({ status: 415 });
    expect(
      await send(port, openPath, {
        body: { ...openBody, unexpected: "x".repeat(512) },
        headers: mutationHeaders(),
        method: "POST",
      }),
    ).toMatchObject({ status: 413 });
    expect(await send(port, `${eventPath}?epoch=${EPOCH}&afterRevision=0&afterRevision=1`)).toMatchObject({
      status: 400,
    });
    expect(await send(port, `${eventPath}?epoch=${EPOCH}&afterRevision=0&limit=33`)).toMatchObject({ status: 400 });
    expect(await send(port, `${eventPath}?epoch=${EPOCH}&afterRevision=01`)).toMatchObject({ status: 400 });
    expect(await send(port, eventPath, { method: "DELETE" })).toMatchObject({ allow: "GET, POST", status: 405 });
    expect(openDocument).not.toHaveBeenCalled();
    expect(readEventTail).not.toHaveBeenCalled();
  });

  it("rejects forged, cross-origin, and non-canonical session requests before storage", async () => {
    const putSessionSnapshot = vi.fn(repository().putSessionSnapshot);
    const readSessionSnapshot = vi.fn(repository().readSessionSnapshot);
    const port = await listen(repository({ putSessionSnapshot, readSessionSnapshot }), {
      expectedMutationOrigin: ORIGIN,
    });
    const basePath = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session`;
    const path = `${basePath}?epoch=${EPOCH}`;
    const body = {
      documentRevision: "0",
      epoch: EPOCH,
      expectedSessionGeneration: "0",
      snapshot: sessionSnapshot,
      snapshotVersion: 1,
    };

    expect(await send(port, `${path}&epoch=${EPOCH}`)).toMatchObject({ status: 400 });
    expect(await send(port, `${path}&extra=1`)).toMatchObject({ status: 400 });
    expect(
      await send(port, path, { body, headers: { "content-type": "application/json" }, method: "PUT" }),
    ).toMatchObject({ status: 403 });
    expect(await send(port, path, { body, headers: mutationHeaders("text/plain"), method: "PUT" })).toMatchObject({
      status: 415,
    });
    expect(
      await send(port, path, {
        body: { ...body, subjectId: SUBJECT },
        headers: mutationHeaders(),
        method: "PUT",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await send(port, path, {
        body: { ...body, snapshot: { ...sessionSnapshot, tenantId: TENANT } },
        headers: mutationHeaders(),
        method: "PUT",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await send(port, path, {
        body: { ...body, epoch: "20000000-0000-4000-8000-000000000099" },
        headers: mutationHeaders(),
        method: "PUT",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await send(port, path, {
        body: `{"oversized":"${"x".repeat(416 * 1024)}"}`,
        headers: mutationHeaders(),
        method: "PUT",
      }),
    ).toMatchObject({ status: 413 });
    expect(await send(port, path, { method: "POST" })).toMatchObject({ allow: "GET, PUT", status: 405 });
    expect(putSessionSnapshot).not.toHaveBeenCalled();
    expect(readSessionSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when storage returns another subject or corrupt session evidence", async () => {
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${EPOCH}`;
    const wrongSubjectPort = await listen(
      repository({ readSessionSnapshot: async () => availableSession({ ...session(), subjectId: MUTATION_ID }) }),
    );
    expect(await send(wrongSubjectPort, path)).toMatchObject({ status: 500 });

    const corruptEvidencePort = await listen(
      repository({
        readSessionSnapshot: async () => availableSession({ ...session(), snapshotDigest: "d".repeat(64) }),
      }),
    );
    expect(await send(corruptEvidencePort, path)).toMatchObject({ status: 500 });
  });

  it("rejects a canonical Program over the durable byte bound before storage", async () => {
    const commitMutation = vi.fn(repository().commitMutation);
    const port = await listen(repository({ commitMutation }), { expectedMutationOrigin: ORIGIN });
    const baseProgram = program();
    const operation = baseProgram.operations[0]!;
    const oversizedProgram: CanonicalEditProgram = {
      ...baseProgram,
      operations: [
        {
          ...operation,
          provenance: { ...operation.provenance, evidence: ["x".repeat(MAX_EDITOR_PROGRAM_BYTES_V1)] },
        },
      ],
    };

    expect(
      await send(port, `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`, {
        body: {
          baseRevision: "0",
          clientMutationId: MUTATION_ID,
          epoch: EPOCH,
          mutation: { kind: "append", program: oversizedProgram },
        },
        headers: mutationHeaders(),
        method: "POST",
      }),
    ).toMatchObject({ status: 400 });
    expect(commitMutation).not.toHaveBeenCalled();
  });

  it("rejects a verified non-account actor before committing or reading private sessions", async () => {
    const commitMutation = vi.fn(repository().commitMutation);
    const readSessionSnapshot = vi.fn(repository().readSessionSnapshot);
    const port = await listen(
      repository({ commitMutation, readSessionSnapshot }),
      { expectedMutationOrigin: ORIGIN },
      await principal("development-local-user"),
    );

    expect(
      await send(port, `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`, {
        body: { baseRevision: "0", clientMutationId: MUTATION_ID, epoch: EPOCH, mutation },
        headers: mutationHeaders(),
        method: "POST",
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await send(port, `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/session?epoch=${EPOCH}`),
    ).toMatchObject({ status: 403 });
    expect(commitMutation).not.toHaveBeenCalled();
    expect(readSessionSnapshot).not.toHaveBeenCalled();
  });

  it("rejects unverified claims before entering storage", async () => {
    const readEventTail = vi.fn(repository().readEventTail);
    const port = await listen(repository({ readEventTail }), {}, { subjectId: SUBJECT, tenantId: TENANT } as never);
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;

    expect(await send(port, `${path}?epoch=${EPOCH}&afterRevision=0`)).toMatchObject({ status: 401 });
    expect(readEventTail).not.toHaveBeenCalled();
  });

  it("returns a user conflict for an ahead tail revision and fails closed on a missing committed tail", async () => {
    const readEventTail = vi
      .fn<EditorDocumentRepositoryV1["readEventTail"]>()
      .mockResolvedValue({ document: document(1n), events: [] });
    const port = await listen(repository({ readEventTail }));
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;

    expect(await send(port, `${path}?epoch=${EPOCH}&afterRevision=2`)).toMatchObject({ status: 409 });
    expect(await send(port, `${path}?epoch=${EPOCH}&afterRevision=0`)).toMatchObject({ status: 500 });
  });

  it("fails closed when storage exceeds the requested event-tail limit", async () => {
    const secondEvent: EditorEditEventV1 = {
      ...event(),
      baseRevision: 1n,
      clientMutationId: "30000000-0000-4000-8000-000000000004",
      committedAt: new Date("2026-08-01T00:00:02.000Z"),
      revision: 2n,
    };
    const readEventTail = vi
      .fn<EditorDocumentRepositoryV1["readEventTail"]>()
      .mockResolvedValue({ document: document(2n), events: [event(), secondEvent] });
    const port = await listen(repository({ readEventTail }));
    const path = `/api/editor/projects/${PROJECT}/documents/${DOCUMENT_KEY}/events`;

    expect(await send(port, `${path}?epoch=${EPOCH}&afterRevision=0&limit=1`)).toMatchObject({ status: 500 });
    expect(readEventTail).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }), undefined);
  });
});
