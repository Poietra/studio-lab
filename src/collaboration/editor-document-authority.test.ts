import { describe, expect, it, vi } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import { EditorDocumentAuthorityV1 } from "./editor-document-authority";
import type { EditorDocumentClientV1 } from "./editor-document-client";
import { editorDocumentViewSchemaV1, editorEditEventViewSchemaV1 } from "./editor-document-http-contract";
import type { EditorEditMutationV1 } from "./editor-edit-mutation";

const ORGANIZATION = "organization-a";
const PROJECT = "project-a";
const DOCUMENT_KEY = "a".repeat(64);
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

  it("retains an ambiguous request across calls and refuses to replace it with another mutation", async () => {
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
    await expect(authority.commit(otherMutation)).rejects.toMatchObject({ code: "conflict" });
    await expect(authority.commit(mutation)).resolves.toMatchObject({
      kind: "committed",
      snapshot: { programs: [value], revision: "1" },
    });

    expect(commit).toHaveBeenCalledTimes(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toEqual(requests[2]);
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
      kind: "reconciled",
      snapshot: { programs: [first, second], revision: "2" },
    });
    expect(tail).toHaveBeenCalledOnce();
  });

  it("reconciles a revision conflict without applying the rejected local mutation", async () => {
    const local = program("local", 1);
    const remote = program("remote", 1);
    const remoteMutation = { kind: "append", program: remote } as const;
    const authority = new EditorDocumentAuthorityV1(
      client({
        commit: async () => ({ currentRevision: "1", kind: "conflict", reason: "revision-mismatch" }),
        tail: async () => ({ document: document(1), events: [event(1, remoteMutation)] }),
      }),
      identity,
      () => MUTATION_ID,
    );
    await authority.open();

    await expect(authority.commit({ kind: "append", program: local })).resolves.toMatchObject({
      kind: "reconciled",
      snapshot: { programs: [remote], revision: "1" },
    });
  });

  it("follows partial tail pages until the exact authoritative head", async () => {
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
      });
    const authority = new EditorDocumentAuthorityV1(client({ tail }), identity);
    await authority.open();

    await expect(authority.reconcile()).resolves.toMatchObject({
      changed: true,
      snapshot: { programs: [first, second], revision: "2" },
    });
    expect(tail.mock.calls.map((call) => call[2].afterRevision)).toEqual(["0", "1"]);
  });

  it("fails closed when a tail claims a newer head without returning the missing event", async () => {
    const authority = new EditorDocumentAuthorityV1(
      client({ tail: async () => ({ document: document(1), events: [] }) }),
      identity,
    );
    await authority.open();

    await expect(authority.reconcile()).rejects.toMatchObject({ code: "corrupt-response" });
  });

  it("fails closed on a wrong-epoch event instead of advancing the replica", async () => {
    const remoteMutation = { kind: "append", program: program("remote", 1) } as const;
    const authority = new EditorDocumentAuthorityV1(
      client({
        tail: async () => ({
          document: document(1),
          events: [event(1, remoteMutation, { epoch: "44444444-4444-4444-8444-444444444444" })],
        }),
      }),
      identity,
    );
    await authority.open();

    await expect(authority.reconcile()).rejects.toMatchObject({ code: "corrupt-response" });
  });
});
