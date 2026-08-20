import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import { EditorDocumentAuthorityV1 } from "./editor-document-authority";
import type { EditorDocumentClientV1 } from "./editor-document-client";
import {
  editorDocumentOpenResultViewSchemaV1,
  editorDocumentSessionViewSchemaV1,
  editorDocumentViewSchemaV1,
  editorEditEventViewSchemaV1,
  nativeEditorDocumentViewSchemaV1,
} from "./editor-document-http-contract";
import type { EditorEditMutationV1 } from "./editor-edit-mutation";
import {
  canonicalEditorSessionSnapshotJsonV1,
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  type EditorSessionSnapshotV1,
} from "./editor-session-contract";

const ORGANIZATION = "organization-a";
const PROJECT = "project-a";
const SOURCE_HASH = "b".repeat(64);
const EPOCH = "11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "33333333-3333-4333-8333-333333333333";
const identity = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  sceneName: "Demo",
  sourceHash: SOURCE_HASH,
  sourcePath: "scene.py",
} as const;

function keyForScene(sceneName: string) {
  const sceneDigest = createHash("sha256").update(`scene.py\0${sceneName}`, "utf8").digest("hex");
  return createHash("sha256")
    .update(`poietra.editor-document.v1\0scene.py\0scene:${sceneDigest}`, "utf8")
    .digest("hex");
}

const DOCUMENT_KEY = keyForScene(identity.sceneName);

function program(transactionId: string, anchor: number): CanonicalEditProgram {
  const operationId = `${transactionId}/wait`;
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [],
      resolvedSeconds: anchor,
      source: { kind: "absolute", seconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: operationId,
        interval: { end: anchor + 1, start: anchor },
        kind: "InsertTimelineEvent",
        label: transactionId,
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operationId] },
    transactionId,
    version: 1,
  };
}

function document(revision: number, overrides: Record<string, unknown> = {}) {
  return editorDocumentViewSchemaV1.parse({
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    openedAt: "2026-08-01T00:00:00.000Z",
    projectId: PROJECT,
    revision: String(revision),
    sealedAt: null,
    sourceHash: SOURCE_HASH,
    sourcePath: "scene.py",
    tenantId: ORGANIZATION,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function opened(revision: number, programs: readonly CanonicalEditProgram[]) {
  return editorDocumentOpenResultViewSchemaV1.parse({
    created: false,
    document: document(revision),
    kind: "opened",
    projection: { programs, revision: String(revision) },
  });
}

function event(revision: number, mutation: EditorEditMutationV1, overrides: Record<string, unknown> = {}) {
  return editorEditEventViewSchemaV1.parse({
    baseRevision: String(revision - 1),
    byteSize: 100,
    clientMutationId: MUTATION_ID,
    committedAt: "2026-08-01T00:00:01.000Z",
    digest: "c".repeat(64),
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    mutation,
    projectId: PROJECT,
    revision: String(revision),
    subjectId: SUBJECT_ID,
    tenantId: ORGANIZATION,
    ...overrides,
  });
}

function sessionSnapshot(
  programs: readonly CanonicalEditProgram[],
  overrides: Partial<EditorSessionSnapshotV1> = {},
): EditorSessionSnapshotV1 {
  return {
    appliedPrograms: programs.map((value) => ({
      program: value,
      validation: { issues: [], status: "valid" as const },
    })),
    currentTime: 0,
    draftOperation: null,
    draftProgram: null,
    editingAppliedProgram: null,
    insertTool: "select",
    interactionMode: "position",
    lockedEntityIds: [],
    motionDuration: 1,
    programUndoEntries: [],
    redoPrograms: [],
    selectedObjectIds: [],
    verifiedSourceDurationBasis: null,
    ...overrides,
  };
}

function session(revision: number, sessionGeneration: number, snapshot: EditorSessionSnapshotV1) {
  const canonical = canonicalEditorSessionSnapshotJsonV1(snapshot);
  return editorDocumentSessionViewSchemaV1.parse({
    documentKey: DOCUMENT_KEY,
    documentRevision: String(revision),
    epoch: EPOCH,
    projectId: PROJECT,
    sessionGeneration: String(sessionGeneration),
    snapshot,
    snapshotByteSize: Buffer.byteLength(canonical, "utf8"),
    snapshotDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
    tenantId: ORGANIZATION,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
}

function committedSessionEvidence(revision: number, sessionGeneration: number, snapshot: EditorSessionSnapshotV1) {
  const canonical = canonicalEditorSessionSnapshotJsonV1(snapshot);
  return {
    documentRevision: String(revision),
    sessionGeneration: String(sessionGeneration),
    snapshotByteSize: Buffer.byteLength(canonical, "utf8"),
    snapshotDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  } as const;
}

function client(overrides: Partial<EditorDocumentClientV1> = {}): EditorDocumentClientV1 {
  return {
    commit: async () => {
      throw new Error("unused commit");
    },
    open: async () => ({
      created: true,
      document: document(0),
      kind: "opened",
      projection: { programs: [], revision: "0" },
    }),
    putSession: async () => {
      throw new Error("unused putSession");
    },
    readSession: async () => ({ currentSessionGeneration: "0", kind: "unavailable" }),
    tail: async () => ({ document: document(0), events: [] }),
    ...overrides,
  } as EditorDocumentClientV1;
}

describe("Editor document authority", () => {
  it("retries an ambiguous commit with the exact same base revision, payload, and mutation ID", async () => {
    const value = program("first", 1);
    const mutation = { kind: "append", program: value } as const;
    const requests: unknown[] = [];
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("connection reset");
      return {
        document: document(1),
        event: event(1, mutation, { clientMutationId: request.clientMutationId }),
        kind: "committed",
        replayed: true,
      };
    });
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity, () => MUTATION_ID);
    await authority.open();

    const outcome = await authority.commit(mutation);

    expect(outcome).toMatchObject({ kind: "committed", snapshot: { programs: [value], revision: "1" } });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ baseRevision: "0", clientMutationId: MUTATION_ID, mutation });
  });

  it("exposes the exact request synchronously before the first commit attempt", async () => {
    const value = program("first", 1);
    const mutation = { kind: "append", program: value } as const;
    let prepared: unknown = null;
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => {
      expect(prepared).toEqual(request);
      return {
        document: document(1),
        event: event(1, mutation, { clientMutationId: request.clientMutationId }),
        kind: "committed",
        replayed: false,
      };
    });
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity, () => MUTATION_ID);
    await authority.open();

    await authority.commit(mutation, {
      onPrepared: (request) => {
        prepared = request;
      },
    });

    expect(prepared).toMatchObject({ baseRevision: "0", clientMutationId: MUTATION_ID, mutation });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("never sends a mutation when its synchronous durability hook fails", async () => {
    const commit = vi.fn<EditorDocumentClientV1["commit"]>();
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity, () => MUTATION_ID);
    await authority.open();

    await expect(
      authority.commit(
        { kind: "append", program: program("first", 1) },
        {
          onPrepared: () => {
            throw new Error("browser storage unavailable");
          },
        },
      ),
    ).rejects.toThrow("browser storage unavailable");
    expect(commit).not.toHaveBeenCalled();
    expect(authority.recoveryKind).toBeNull();
  });

  it("exposes an ambiguous request for manual replay without changing any request byte", async () => {
    const value = program("first", 1);
    const mutation = { kind: "append", program: value } as const;
    const otherMutation = { kind: "append", program: program("other", 2) } as const;
    const requests: unknown[] = [];
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => {
      requests.push(request);
      if (requests.length <= 2) throw new Error("connection reset");
      return {
        document: document(1),
        event: event(1, mutation, { clientMutationId: request.clientMutationId }),
        kind: "committed",
        replayed: true,
      };
    });
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity, () => MUTATION_ID);
    await authority.open();

    await expect(authority.commit(mutation)).rejects.toThrow("connection reset");
    expect(authority.recoveryKind).toBe("commit");
    await expect(authority.commit(otherMutation)).rejects.toMatchObject({ code: "conflict" });
    await expect(authority.retry()).resolves.toMatchObject({
      kind: "committed",
      snapshot: { programs: [value], revision: "1" },
    });

    expect(commit).toHaveBeenCalledTimes(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toEqual(requests[2]);
    expect(authority.recoveryKind).toBeNull();
  });

  it("recovers an accepted commit through tail only and never resends the mutation", async () => {
    const first = program("first", 1);
    const second = program("second", 2);
    const firstMutation = { kind: "append", program: first } as const;
    const secondMutation = { kind: "append", program: second } as const;
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => ({
      document: document(2),
      event: event(1, firstMutation, { clientMutationId: request.clientMutationId }),
      kind: "committed",
      replayed: false,
    }));
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockRejectedValueOnce(new Error("tail connection reset"))
      .mockResolvedValueOnce({ document: document(2), events: [event(2, secondMutation)] });
    const authority = new EditorDocumentAuthorityV1(client({ commit, tail }), identity, () => MUTATION_ID);
    await authority.open();

    await expect(authority.commit(firstMutation)).rejects.toThrow("tail connection reset");
    expect(authority.recoveryKind).toBe("tail");
    await expect(authority.commit({ kind: "append", program: program("third", 3) })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(authority.retry()).resolves.toMatchObject({
      accepted: true,
      kind: "reconciled",
      snapshot: { programs: [first, second], revision: "2" },
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(tail).toHaveBeenCalledTimes(4);
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "0", "1", "1"]);
    expect(authority.recoveryKind).toBeNull();
  });

  it("rejects a second in-flight mutation without disturbing the active commit", async () => {
    const value = program("first", 1);
    const mutation = { kind: "append", program: value } as const;
    let resolveCommit!: (value: Awaited<ReturnType<EditorDocumentClientV1["commit"]>>) => void;
    const response = new Promise<Awaited<ReturnType<EditorDocumentClientV1["commit"]>>>((resolve) => {
      resolveCommit = resolve;
    });
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async () => response);
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity, () => MUTATION_ID);
    await authority.open();

    const active = authority.commit(mutation);
    await expect(authority.commit(mutation)).rejects.toMatchObject({ code: "busy" });
    resolveCommit({
      document: document(1),
      event: event(1, mutation),
      kind: "committed",
      replayed: false,
    });

    await expect(active).resolves.toMatchObject({ kind: "committed", snapshot: { programs: [value] } });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("folds a replay once, then catches up a newer document head through the bounded tail", async () => {
    const first = program("first", 1);
    const second = program("second", 2);
    const firstMutation = { kind: "append", program: first } as const;
    const secondMutation = { kind: "append", program: second } as const;
    const tail = vi.fn<EditorDocumentClientV1["tail"]>(async (_identity, _key, request) => {
      if (request.afterRevision === "0") return { document: document(0), events: [] };
      expect(request.afterRevision).toBe("1");
      return { document: document(2), events: [event(2, secondMutation)] };
    });
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit: async (_identity, _key, request) => ({
          document: document(2),
          event: event(1, firstMutation, { clientMutationId: request.clientMutationId }),
          kind: "committed",
          replayed: true,
        }),
        tail,
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit(firstMutation)).resolves.toMatchObject({
      accepted: true,
      kind: "reconciled",
      snapshot: { programs: [first, second], revision: "2" },
    });
    expect(tail).toHaveBeenCalledTimes(3);
  });

  it("reconciles a revision conflict without applying the rejected local mutation", async () => {
    const local = program("local", 1);
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit: async () => ({ currentRevision: "1", kind: "conflict", reason: "revision-mismatch" }),
        tail,
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit({ kind: "append", program: local })).resolves.toMatchObject({
      accepted: false,
      kind: "reconciled",
      snapshot: { programs: [remote], revision: "1" },
    });
  });

  it("opens through partial tail pages until the exact authoritative head", async () => {
    const first = program("first", 1);
    const second = program("second", 2);
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({
        document: document(2),
        events: [event(1, { kind: "append", program: first })],
      })
      .mockResolvedValueOnce({
        document: document(2),
        events: [
          event(
            2,
            { kind: "append", program: second },
            {
              clientMutationId: "44444444-4444-4444-8444-444444444444",
            },
          ),
        ],
      })
      .mockResolvedValueOnce({ document: document(2), events: [] });
    const authority = new EditorDocumentAuthorityV1(client({ tail }), identity);
    await expect(authority.open()).resolves.toMatchObject({
      programs: [first, second],
      revision: "2",
    });
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "1", "2"]);
  });

  it("fails closed when a tail claims a newer head without returning the missing event", async () => {
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [] });
    const authority = new EditorDocumentAuthorityV1(client({ tail }), identity);
    await authority.open();

    await expect(authority.reconcile()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("does not report a retried remote-tail recovery as an accepted local commit", async () => {
    const remoteMutation = { kind: "append", program: program("remote", 1) } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockRejectedValueOnce(new Error("tail connection reset"))
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const authority = new EditorDocumentAuthorityV1(client({ tail }), identity);
    await authority.open();

    await expect(authority.reconcile()).rejects.toThrow("tail connection reset");
    await expect(authority.retry()).resolves.toMatchObject({
      accepted: false,
      kind: "reconciled",
      snapshot: { programs: [remoteMutation.program], revision: "1" },
    });
  });

  it("fails closed on a wrong-epoch event instead of advancing the replica", async () => {
    const remoteMutation = { kind: "append", program: program("remote", 1) } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({
        document: document(1),
        events: [event(1, remoteMutation, { epoch: "44444444-4444-4444-8444-444444444444" })],
      });
    const authority = new EditorDocumentAuthorityV1(client({ tail }), identity);
    await authority.open();

    await expect(authority.reconcile()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("rejects an open response for another Scene in the same source file", async () => {
    const authority = new EditorDocumentAuthorityV1(
      client({
        open: async () => ({
          created: false,
          document: document(0, { documentKey: keyForScene("OtherScene") }),
          kind: "opened",
          projection: { programs: [], revision: "0" },
        }),
      }),
      identity,
    );

    await expect(authority.open()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("restores only a private session aligned to the opened epoch, revision, and projection", async () => {
    const first = program("first", 1);
    const snapshot = sessionSnapshot([first], { currentTime: 1.5, selectedObjectIds: ["shape-a"] });
    const readSession = vi.fn<EditorDocumentClientV1["readSession"]>(async () => ({
      kind: "available",
      session: session(1, 7, snapshot),
    }));
    const authority = new EditorDocumentAuthorityV1(
      client({
        open: async () => opened(1, [first]),
        readSession,
        tail: async () => ({ document: document(1), events: [] }),
      }),
      identity,
    );

    await expect(authority.open()).resolves.toMatchObject({
      programs: [first],
      revision: "1",
      session: snapshot,
      sessionGeneration: "7",
    });
    expect(authority.sessionGeneration).toBe("7");
    expect(readSession).toHaveBeenCalledWith(identity, DOCUMENT_KEY, { epoch: EPOCH }, undefined);
  });

  it("fails closed when a returned private session is stale or has a different projection", async () => {
    const first = program("first", 1);
    const baseClient = {
      open: async () => opened(1, [first]),
      tail: async () => ({ document: document(1), events: [] }),
    };
    const stale = new EditorDocumentAuthorityV1(
      client({
        ...baseClient,
        readSession: async () => ({ kind: "available", session: session(0, 4, sessionSnapshot([])) }),
      }),
      identity,
    );
    const divergent = new EditorDocumentAuthorityV1(
      client({
        ...baseClient,
        readSession: async () => ({ kind: "available", session: session(1, 4, sessionSnapshot([])) }),
      }),
      identity,
    );
    const invalidEvidence = new EditorDocumentAuthorityV1(
      client({
        ...baseClient,
        readSession: async () => ({
          kind: "available",
          session: { ...session(1, 4, sessionSnapshot([first])), snapshotDigest: "e".repeat(64) },
        }),
      }),
      identity,
    );

    await expect(stale.open()).rejects.toMatchObject({ code: "corrupt-response" });
    await expect(divergent.open()).rejects.toMatchObject({ code: "corrupt-response" });
    await expect(invalidEvidence.open()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("keeps unavailable-session generation evidence without restoring a stale snapshot", async () => {
    const authority = new EditorDocumentAuthorityV1(
      client({ readSession: async () => ({ currentSessionGeneration: "8", kind: "unavailable" }) }),
      identity,
    );

    await expect(authority.open()).resolves.toMatchObject({
      revision: "0",
      session: null,
      sessionGeneration: "8",
    });
    expect(authority.sessionGeneration).toBe("8");
  });

  it("catches up when an atomic remote commit lands between projection reconciliation and session read", async () => {
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const snapshot = sessionSnapshot([remote]);
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const readSession = vi.fn<EditorDocumentClientV1["readSession"]>(async () => ({
      kind: "available",
      session: session(1, 6, snapshot),
    }));
    const authority = new EditorDocumentAuthorityV1(client({ readSession, tail }), identity);

    await expect(authority.open()).resolves.toMatchObject({
      programs: [remote],
      revision: "1",
      session: snapshot,
      sessionGeneration: "6",
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "0"]);
  });

  it("rechecks the tail after an unavailable session read and loops when a document-only commit landed", async () => {
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] })
      .mockResolvedValueOnce({ document: document(1), events: [] });
    const readSession = vi
      .fn<EditorDocumentClientV1["readSession"]>()
      .mockResolvedValueOnce({ currentSessionGeneration: "0", kind: "unavailable" })
      .mockResolvedValueOnce({ currentSessionGeneration: "0", kind: "unavailable" });
    const authority = new EditorDocumentAuthorityV1(client({ readSession, tail }), identity);

    await expect(authority.open()).resolves.toMatchObject({
      programs: [remote],
      revision: "1",
      session: null,
      sessionGeneration: "0",
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "0", "1"]);
  });

  it("commits the planned post-state session atomically and advances its independent generation", async () => {
    const first = program("first", 1);
    const mutation = { kind: "append", program: first } as const;
    const planned = sessionSnapshot([first], { currentTime: 2 });
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => ({
      document: document(1),
      event: event(1, mutation, { clientMutationId: request.clientMutationId }),
      kind: "committed",
      replayed: false,
      sessionUpdate: committedSessionEvidence(1, 4, planned),
    }));
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit,
        readSession: async () => ({ kind: "available", session: session(0, 3, sessionSnapshot([])) }),
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit(mutation, { sessionSnapshot: planned })).resolves.toMatchObject({
      kind: "committed",
      sessionInvalidated: false,
      snapshot: { programs: [first], revision: "1", sessionGeneration: "4" },
    });
    expect(commit).toHaveBeenCalledWith(
      identity,
      DOCUMENT_KEY,
      expect.objectContaining({
        baseRevision: "0",
        sessionUpdate: {
          documentRevision: "1",
          expectedSessionGeneration: "3",
          snapshot: planned,
          snapshotVersion: 1,
        },
      }),
      undefined,
    );
  });

  it("replays an ambiguous atomic commit with the exact session update and advances its generation", async () => {
    const first = program("first", 1);
    const mutation = { kind: "append", program: first } as const;
    const planned = sessionSnapshot([first], { currentTime: 2 });
    const requests: unknown[] = [];
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _key, request) => {
      requests.push(request);
      if (requests.length <= 2) throw new Error("connection reset");
      return {
        document: document(1),
        event: event(1, mutation, { clientMutationId: request.clientMutationId }),
        kind: "committed",
        replayed: true,
        sessionUpdate: committedSessionEvidence(1, 4, planned),
      };
    });
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit,
        readSession: async () => ({ kind: "available", session: session(0, 3, sessionSnapshot([])) }),
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit(mutation, { sessionSnapshot: planned })).rejects.toThrow("connection reset");
    expect(authority.recoveryKind).toBe("commit");
    await expect(authority.retry()).resolves.toMatchObject({
      kind: "committed",
      sessionInvalidated: false,
      snapshot: { programs: [first], revision: "1", sessionGeneration: "4" },
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toEqual(requests[2]);
    expect(requests[0]).toMatchObject({
      baseRevision: "0",
      clientMutationId: MUTATION_ID,
      sessionUpdate: {
        documentRevision: "1",
        expectedSessionGeneration: "3",
        snapshot: planned,
      },
    });
    expect(authority.sessionGeneration).toBe("4");
    expect(authority.recoveryKind).toBeNull();
  });

  it("fails closed without advancing generation when atomic session evidence is inconsistent", async () => {
    const first = program("first", 1);
    const mutation = { kind: "append", program: first } as const;
    const planned = sessionSnapshot([first]);
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit: async (_identity, _key, request) => ({
          document: document(1),
          event: event(1, mutation, { clientMutationId: request.clientMutationId }),
          kind: "committed",
          replayed: false,
          sessionUpdate: {
            ...committedSessionEvidence(1, 4, planned),
            snapshotDigest: "d".repeat(64),
          },
        }),
        readSession: async () => ({ kind: "available", session: session(0, 3, sessionSnapshot([])) }),
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit(mutation, { sessionSnapshot: planned })).rejects.toMatchObject({
      code: "corrupt-response",
    });
    expect(authority.sessionGeneration).toBe("3");
  });

  it("rejects a planned atomic session that does not describe the post-mutation projection", async () => {
    const commit = vi.fn<EditorDocumentClientV1["commit"]>();
    const authority = new EditorDocumentAuthorityV1(client({ commit }), identity);
    await authority.open();

    await expect(
      authority.commit({ kind: "append", program: program("first", 1) }, { sessionSnapshot: sessionSnapshot([]) }),
    ).rejects.toMatchObject({ code: "session-conflict" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("advances exact generation CAS across successive private session saves", async () => {
    const first = sessionSnapshot([], { currentTime: 1 });
    const second = sessionSnapshot([], { currentTime: 2 });
    const requests: unknown[] = [];
    const putSession = vi.fn<EditorDocumentClientV1["putSession"]>(async (_identity, _key, request) => {
      requests.push(request);
      const nextGeneration = requests.length;
      return {
        kind: "stored",
        replayed: false,
        session: session(0, nextGeneration, request.snapshot),
      };
    });
    const authority = new EditorDocumentAuthorityV1(client({ putSession }), identity);
    await authority.open();

    await expect(authority.saveSession(first)).resolves.toEqual({
      kind: "stored",
      replayed: false,
      sessionGeneration: "1",
    });
    await expect(authority.saveSession(second)).resolves.toMatchObject({ sessionGeneration: "2" });
    expect(requests).toMatchObject([
      { documentRevision: "0", expectedSessionGeneration: "0", snapshot: first },
      { documentRevision: "0", expectedSessionGeneration: "1", snapshot: second },
    ]);
  });

  it("retains one exact ambiguous session PUT for explicit retry and refuses a different save", async () => {
    const first = sessionSnapshot([], { currentTime: 1 });
    const second = sessionSnapshot([], { currentTime: 2 });
    const requests: unknown[] = [];
    const putSession = vi.fn<EditorDocumentClientV1["putSession"]>(async (_identity, _key, request) => {
      requests.push(request);
      if (requests.length <= 2) throw new Error("connection reset");
      return { kind: "stored", replayed: true, session: session(0, 1, request.snapshot) };
    });
    const authority = new EditorDocumentAuthorityV1(client({ putSession }), identity);
    await authority.open();

    await expect(authority.saveSession(first)).rejects.toThrow("connection reset");
    expect(authority.sessionRecoveryPending).toBe(true);
    await expect(authority.saveSession(second)).rejects.toMatchObject({ code: "session-conflict" });
    await expect(authority.retrySession()).resolves.toMatchObject({ replayed: true, sessionGeneration: "1" });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toEqual(requests[2]);
    expect(authority.sessionRecoveryPending).toBe(false);
  });

  it("retains the exact session PUT when an abort can race with server acceptance", async () => {
    const snapshot = sessionSnapshot([], { currentTime: 1 });
    const controller = new AbortController();
    const requests: unknown[] = [];
    const putSession = vi.fn<EditorDocumentClientV1["putSession"]>(async (_identity, _key, request) => {
      requests.push(request);
      if (requests.length === 1) {
        controller.abort();
        throw new DOMException("request aborted", "AbortError");
      }
      return { kind: "stored", replayed: true, session: session(0, 1, request.snapshot) };
    });
    const authority = new EditorDocumentAuthorityV1(client({ putSession }), identity);
    await authority.open();

    await expect(authority.saveSession(snapshot, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(authority.sessionRecoveryPending).toBe(true);
    await expect(authority.retrySession()).resolves.toEqual({
      kind: "stored",
      replayed: true,
      sessionGeneration: "1",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(authority.sessionRecoveryPending).toBe(false);
  });

  it("reports session CAS loss separately and does not trust the conflicting generation", async () => {
    const authority = new EditorDocumentAuthorityV1(
      client({
        putSession: async () => ({
          currentDocumentRevision: "0",
          currentSessionGeneration: "9",
          kind: "conflict",
          reason: "session-generation-mismatch",
        }),
      }),
      identity,
    );
    await authority.open();

    await expect(authority.saveSession(sessionSnapshot([]))).rejects.toMatchObject({ code: "session-conflict" });
    expect(authority.sessionGeneration).toBe("0");
    expect(authority.sessionRecoveryPending).toBe(false);
  });

  it("reconciles the authoritative projection when a standalone session save loses the document revision", async () => {
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const putSession = vi.fn<EditorDocumentClientV1["putSession"]>(async () => ({
      currentDocumentRevision: "1",
      currentSessionGeneration: "0",
      kind: "conflict",
      reason: "revision-mismatch",
    }));
    const authority = new EditorDocumentAuthorityV1(client({ putSession, tail }), identity);
    await authority.open();

    await expect(authority.saveSession(sessionSnapshot([]))).resolves.toEqual({
      kind: "reconciled",
      snapshot: {
        document: document(1),
        programs: [remote],
        revision: "1",
        sessionGeneration: "0",
      },
    });
    expect(putSession).toHaveBeenCalledOnce();
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "0", "0"]);
    expect(authority.sessionRecoveryPending).toBe(false);
  });

  it("retains tail recovery when revision-mismatch reconciliation fails transiently", async () => {
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockRejectedValueOnce(new Error("tail connection reset"))
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const putSession = vi.fn<EditorDocumentClientV1["putSession"]>(async () => ({
      currentDocumentRevision: "1",
      currentSessionGeneration: "1",
      kind: "conflict",
      reason: "revision-mismatch",
    }));
    const authority = new EditorDocumentAuthorityV1(
      client({
        putSession,
        readSession: async () => ({ kind: "available", session: session(0, 1, sessionSnapshot([])) }),
        tail,
      }),
      identity,
    );
    await authority.open();

    await expect(authority.saveSession(sessionSnapshot([]))).rejects.toThrow("tail connection reset");
    expect(authority.recoveryKind).toBe("tail");
    expect(authority.sessionRecoveryPending).toBe(false);
    await expect(authority.retry()).resolves.toMatchObject({
      accepted: false,
      kind: "reconciled",
      sessionInvalidated: true,
      snapshot: { programs: [remote], revision: "1", sessionGeneration: "1" },
    });
    expect(putSession).toHaveBeenCalledOnce();
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "0", "0"]);
    expect(authority.recoveryKind).toBeNull();
  });

  it("invalidates rather than merges private state after a remote projection advances", async () => {
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const tail = vi
      .fn<EditorDocumentClientV1["tail"]>()
      .mockResolvedValueOnce({ document: document(0), events: [] })
      .mockResolvedValueOnce({ document: document(1), events: [event(1, remoteMutation)] });
    const authority = new EditorDocumentAuthorityV1(
      client({
        readSession: async () => ({ kind: "available", session: session(0, 5, sessionSnapshot([])) }),
        tail,
      }),
      identity,
    );
    await authority.open();

    await expect(authority.reconcile()).resolves.toMatchObject({
      changed: true,
      sessionInvalidated: true,
      snapshot: { programs: [remote], revision: "1", sessionGeneration: "5" },
    });
    expect(authority.sessionGeneration).toBe("5");
  });
});

describe("Editor document authority (Studio-native lane)", () => {
  const NATIVE_KEY = "d".repeat(64);
  const nativeIdentity = {
    organizationId: ORGANIZATION,
    origin: "studio-native",
    projectId: PROJECT,
  } as const;

  function nativeDocument(revision: number, overrides: Record<string, unknown> = {}) {
    return nativeEditorDocumentViewSchemaV1.parse({
      documentKey: NATIVE_KEY,
      epoch: EPOCH,
      openedAt: "2026-08-01T00:00:00.000Z",
      origin: "studio-native",
      projectId: PROJECT,
      revision: String(revision),
      sealedAt: null,
      sourceHash: null,
      sourcePath: null,
      tenantId: ORGANIZATION,
      updatedAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    });
  }

  function nativeSession(revision: number, sessionGeneration: number, snapshot: EditorSessionSnapshotV1) {
    const canonical = canonicalEditorSessionSnapshotJsonV1(snapshot);
    return editorDocumentSessionViewSchemaV1.parse({
      documentKey: NATIVE_KEY,
      documentRevision: String(revision),
      epoch: EPOCH,
      projectId: PROJECT,
      sessionGeneration: String(sessionGeneration),
      snapshot,
      snapshotByteSize: Buffer.byteLength(canonical, "utf8"),
      snapshotDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
      snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
      tenantId: ORGANIZATION,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  }

  function nativeOpened(revision: number, programs: readonly CanonicalEditProgram[]) {
    return editorDocumentOpenResultViewSchemaV1.parse({
      created: false,
      document: nativeDocument(revision),
      kind: "opened",
      projection: { programs, revision: String(revision) },
    });
  }

  function nativeClient(overrides: Partial<EditorDocumentClientV1> = {}): EditorDocumentClientV1 {
    return client({
      open: async () => nativeOpened(0, []),
      tail: async () => ({ document: nativeDocument(0), events: [] }),
      ...overrides,
    });
  }

  it("opens by origin alone and accepts the server-issued documentKey without derivation", async () => {
    const openRequests: unknown[] = [];
    const open = vi.fn<EditorDocumentClientV1["open"]>(async (_identity, request) => {
      openRequests.push(request);
      return nativeOpened(0, []);
    });
    const authority = new EditorDocumentAuthorityV1(nativeClient({ open }), nativeIdentity);

    const outcome = await authority.open();

    expect(openRequests).toEqual([{ origin: "studio-native" }]);
    expect(outcome).toMatchObject({
      document: { documentKey: NATIVE_KEY, origin: "studio-native", sourceHash: null, sourcePath: null },
      programs: [],
      revision: "0",
      session: null,
    });
  });

  it("restores the private session of a native document across a reload", async () => {
    const value = program("native-edit", 1);
    const mutation = { kind: "append", program: value } as const;
    const restored = sessionSnapshot([value], { currentTime: 4 });
    const authority = new EditorDocumentAuthorityV1(
      nativeClient({
        commit: async (_identity, _key, request) => ({
          document: nativeDocument(1),
          event: event(1, mutation, { clientMutationId: request.clientMutationId, documentKey: NATIVE_KEY }),
          kind: "committed",
          replayed: false,
        }),
        putSession: async () => ({ kind: "stored", replayed: false, session: nativeSession(1, 1, restored) }),
      }),
      nativeIdentity,
      () => MUTATION_ID,
    );
    await authority.open();
    await authority.commit(mutation);
    await expect(authority.saveSession(restored)).resolves.toMatchObject({ kind: "stored", sessionGeneration: "1" });

    const reloaded = new EditorDocumentAuthorityV1(
      nativeClient({
        open: async () => nativeOpened(1, [value]),
        readSession: async () => ({ kind: "available", session: nativeSession(1, 1, restored) }),
        tail: async () => ({ document: nativeDocument(1), events: [] }),
      }),
      nativeIdentity,
    );

    const outcome = await reloaded.open();

    expect(outcome).toMatchObject({
      document: { documentKey: NATIVE_KEY, origin: "studio-native" },
      programs: [value],
      revision: "1",
      session: { currentTime: 4 },
      sessionGeneration: "1",
    });
  });

  it("fails closed when the server answers a native identity with an imported document", async () => {
    const authority = new EditorDocumentAuthorityV1(
      nativeClient({
        open: async () => ({
          created: false,
          document: document(0),
          kind: "opened",
          projection: { programs: [], revision: "0" },
        }),
      }),
      nativeIdentity,
    );

    await expect(authority.open()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("fails closed when the server reports a source conflict for a source-free native document", async () => {
    const authority = new EditorDocumentAuthorityV1(
      nativeClient({
        open: async () => ({ currentSourceHash: SOURCE_HASH, kind: "source-conflict" }),
      }),
      nativeIdentity,
    );

    await expect(authority.open()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("still fails closed when an imported identity receives a native document", async () => {
    const authority = new EditorDocumentAuthorityV1(
      client({
        open: async () => ({
          created: false,
          document: nativeDocument(0),
          kind: "opened",
          projection: { programs: [], revision: "0" },
        }),
      }),
      identity,
    );

    await expect(authority.open()).rejects.toMatchObject({ code: "corrupt-response" });
  });
});
