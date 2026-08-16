import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createBrowserEditorDocumentKeyV1 } from "../collaboration/editor-document-authority";
import type { EditorDocumentClientV1 } from "../collaboration/editor-document-client";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
} from "../collaboration/editor-document-http-contract";
import {
  canonicalEditorSessionSnapshotJsonV1,
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
} from "../collaboration/editor-session-contract";
import {
  assertEditorMutationCommitAcknowledgementV1,
  type EditorMutationPendingJournalIdentityV1,
  type EditorMutationPendingJournalStorageAdapterV1,
  EditorMutationPendingJournalV1,
  editorMutationPendingJournalStoragePrefixV1,
  MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1,
  WebStorageEditorMutationPendingJournalAdapterV1,
} from "./editor-mutation-pending-journal";
import type { CanonicalEditProgram } from "./operations";
import { createInitialEditorState, snapshotCloudEditorSessionV1 } from "./use-editor-controller";
import { recoverPendingEditorMutationBeforeOpenV1 } from "./use-editor-document-authority";

const SCOPE = {
  organizationId: "organization-a",
  userId: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8",
} as const;
const EPOCH = "11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_SUBJECT_ID = "33333333-3333-4333-8333-333333333333";

class MemoryAdapter implements EditorMutationPendingJournalStorageAdapterV1 {
  beforeNextWrite: (() => void) | null = null;
  failList = false;
  readonly values = new Map<string, string>();

  list() {
    if (this.failList) throw new Error("unavailable");
    return Array.from(this.values, ([entryId, serialized]) => ({ entryId, serialized }));
  }

  removeExact(entryId: string) {
    this.values.delete(entryId);
  }

  writeExact(entryId: string, serialized: string) {
    const callback = this.beforeNextWrite;
    this.beforeNextWrite = null;
    callback?.();
    this.values.set(entryId, serialized);
  }
}

class MemoryWebStorage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function program(id = "first"): CanonicalEditProgram {
  const operationId = `${id}/wait`;
  return {
    anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: operationId,
        interval: { end: 1, start: 0 },
        kind: "InsertTimelineEvent",
        label: id,
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operationId] },
    transactionId: id,
    version: 1,
  };
}

function identity(index = 1): EditorMutationPendingJournalIdentityV1 {
  return {
    documentKey: index.toString(16).padStart(64, "0"),
    epoch: EPOCH,
    projectId: "project-a",
    sourceHash: "a".repeat(64),
    sourcePath: `scene-${index}.py`,
  };
}

function request(target = identity(), clientMutationId = MUTATION_ID, withSession = false) {
  const value = program();
  const snapshot = snapshotCloudEditorSessionV1({
    ...createInitialEditorState(),
    appliedPrograms: [{ program: value, validation: { issues: [], status: "valid" } }],
  });
  return editorDocumentCommitRequestSchemaV1.parse({
    baseRevision: "0",
    clientMutationId,
    epoch: target.epoch,
    mutation: { kind: "append", program: value },
    ...(withSession
      ? {
          sessionUpdate: {
            documentRevision: "1",
            expectedSessionGeneration: "2",
            snapshot,
            snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
          },
        }
      : {}),
  });
}

function journal(adapter = new MemoryAdapter()) {
  return { adapter, journal: new EditorMutationPendingJournalV1(adapter, SCOPE, () => 1_000) };
}

function committedResult(target: EditorMutationPendingJournalIdentityV1, exactRequest: ReturnType<typeof request>) {
  const snapshot = exactRequest.sessionUpdate?.snapshot;
  const canonicalSnapshot = snapshot ? canonicalEditorSessionSnapshotJsonV1(snapshot) : null;
  return editorDocumentCommitResultViewSchemaV1.parse({
    document: {
      documentKey: target.documentKey,
      epoch: target.epoch,
      openedAt: "2026-08-01T00:00:00.000Z",
      projectId: target.projectId,
      revision: "1",
      sealedAt: null,
      sourceHash: target.sourceHash,
      sourcePath: target.sourcePath,
      tenantId: SCOPE.organizationId,
      updatedAt: "2026-08-01T00:00:01.000Z",
    },
    event: {
      baseRevision: exactRequest.baseRevision,
      byteSize: 100,
      clientMutationId: exactRequest.clientMutationId,
      committedAt: "2026-08-01T00:00:01.000Z",
      digest: "b".repeat(64),
      documentKey: target.documentKey,
      epoch: target.epoch,
      mutation: exactRequest.mutation,
      projectId: target.projectId,
      revision: "1",
      subjectId: SCOPE.userId,
      tenantId: SCOPE.organizationId,
    },
    kind: "committed",
    replayed: true,
    ...(exactRequest.sessionUpdate && canonicalSnapshot
      ? {
          sessionUpdate: {
            documentRevision: "1",
            sessionGeneration: "3",
            snapshotByteSize: Buffer.byteLength(canonicalSnapshot, "utf8"),
            snapshotDigest: createHash("sha256").update(canonicalSnapshot).digest("hex"),
            snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
          },
        }
      : {}),
  });
}

describe("pending cloud Editor mutation journal", () => {
  it("uses disjoint account prefixes and can explicitly clear malformed suffixes", () => {
    const storage = new MemoryWebStorage();
    const first = new EditorMutationPendingJournalV1(
      new WebStorageEditorMutationPendingJournalAdapterV1(storage, SCOPE),
      SCOPE,
    );
    const secondScope = {
      organizationId: "organization-b",
      userId: "35b33044-5387-4c29-aed1-cad82750f4cc",
    } as const;
    const second = new EditorMutationPendingJournalV1(
      new WebStorageEditorMutationPendingJournalAdapterV1(storage, secondScope),
      secondScope,
    );
    const target = identity();
    first.record(target, request(target));

    expect(second.readExact(target)).toBeNull();
    const corruptKey = `${editorMutationPendingJournalStoragePrefixV1(SCOPE)}not-a-uuid`;
    storage.setItem(corruptKey, "not json");
    expect(() => first.readExact(target)).toThrowError(expect.objectContaining({ code: "corrupt" }));
    expect(first.discardAll()).toBe(true);
    expect(second.readExact(target)).toBeNull();
  });

  it("retains one immutable exact request until its acknowledgement is explicit", () => {
    const { adapter, journal: pending } = journal();
    const peer = new EditorMutationPendingJournalV1(adapter, SCOPE, () => 1_001);
    const target = identity();
    const exactRequest = request(target);
    const entry = pending.record(target, exactRequest);

    expect(pending.record(target, exactRequest)).toEqual(entry);
    expect(pending.readExact(target)).toEqual(entry);
    expect(adapter.values).toHaveLength(1);
    expect(peer.acknowledgeExact(entry)).toBe(true);
    expect(pending.acknowledgeExact(entry)).toBe(true);
    expect(pending.readExact(target)).toBeNull();
  });

  it("never acknowledges a reused mutation ID with different retained evidence", () => {
    const { adapter, journal: pending } = journal();
    const target = identity();
    const entry = pending.record(target, request(target));
    const conflicting = JSON.parse(adapter.values.get(MUTATION_ID)!) as {
      identity: { sourcePath: string };
    };
    conflicting.identity.sourcePath = "foreign.py";
    adapter.values.set(MUTATION_ID, JSON.stringify(conflicting));

    expect(pending.acknowledgeExact(entry)).toBe(false);
    expect(adapter.values).toHaveLength(1);
  });

  it("never lets another source lookup consume a retained request", () => {
    const { journal: pending } = journal();
    const target = identity();
    const entry = pending.record(target, request(target));

    expect(pending.readExact({ ...target, sourceHash: "c".repeat(64) })).toBeNull();
    expect(pending.readExact({ ...target, sourcePath: "other.py" })).toBeNull();
    expect(pending.readExact({ ...target, projectId: "project-b" })).toBeNull();
    expect(pending.readExact(target)).toEqual(entry);
  });

  it("retains racing same-Scene requests, reports ambiguity, and clears only that Scene", async () => {
    const adapter = new MemoryAdapter();
    const first = new EditorMutationPendingJournalV1(adapter, SCOPE, () => 1_000);
    const second = new EditorMutationPendingJournalV1(adapter, SCOPE, () => 1_001);
    const authorityIdentity = {
      organizationId: SCOPE.organizationId,
      projectId: "project-a",
      sceneName: "Demo",
      sourceHash: "a".repeat(64),
      sourcePath: "scene-1.py",
    } as const;
    const target = { ...identity(), documentKey: await createBrowserEditorDocumentKeyV1(authorityIdentity) };
    const unrelated = identity(2);
    first.record(unrelated, request(unrelated, "77777777-7777-4777-8777-777777777777"));
    adapter.beforeNextWrite = () => {
      second.record(target, request(target, "44444444-4444-4444-8444-444444444444"));
    };

    expect(() => first.record(target, request(target))).toThrowError(expect.objectContaining({ code: "ambiguous" }));
    expect(adapter.values).toHaveLength(3);
    expect(() => first.readExact(target)).toThrowError(expect.objectContaining({ code: "ambiguous" }));
    expect(() => first.record(target, request(target))).toThrowError(expect.objectContaining({ code: "ambiguous" }));
    const onLookup = vi.fn();
    const commit = vi.fn();
    await expect(
      recoverPendingEditorMutationBeforeOpenV1({
        client: { commit } as unknown as EditorDocumentClientV1,
        identity: authorityIdentity,
        journal: first,
        onLookup,
      }),
    ).rejects.toMatchObject({ code: "ambiguous" });
    expect(onLookup).toHaveBeenCalledWith(expect.objectContaining({ documentKey: target.documentKey }));
    expect(commit).not.toHaveBeenCalled();
    expect(first.discardExact(target)).toBe(true);
    expect(first.readExact(target)).toBeNull();
    expect(first.readExact(unrelated)).not.toBeNull();
  });

  it("fails closed instead of evicting an unacknowledged request at capacity", () => {
    const { adapter, journal: pending } = journal();
    for (let index = 1; index <= MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1; index += 1) {
      const target = identity(index);
      pending.record(target, request(target, `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`));
    }
    const overflow = identity(MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1 + 1);
    expect(() => pending.record(overflow, request(overflow, "55555555-5555-4555-8555-555555555555"))).toThrowError(
      expect.objectContaining({ code: "capacity" }),
    );
    expect(adapter.values).toHaveLength(MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1);
  });

  it("rejects malformed account evidence without deleting it", () => {
    const { adapter, journal: pending } = journal();
    adapter.values.set(MUTATION_ID, "not json");

    expect(() => pending.readExact(identity())).toThrowError(expect.objectContaining({ code: "corrupt" }));
    expect(adapter.values).toHaveLength(1);
    expect(pending.discardAll()).toBe(true);
    expect(adapter.values).toHaveLength(0);
  });

  it("accepts only the exact event and atomic session evidence", async () => {
    const { journal: pending } = journal();
    const target = identity();
    const exactRequest = request(target, MUTATION_ID, true);
    const entry = pending.record(target, exactRequest);
    const result = committedResult(target, exactRequest);
    if (result.kind !== "committed") throw new TypeError("Expected a committed fixture.");
    const resultDocument = result.document;
    if ("origin" in resultDocument) throw new TypeError("Expected an imported document fixture.");

    await expect(assertEditorMutationCommitAcknowledgementV1(entry, result)).resolves.toEqual(result);
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        event: { ...result.event, clientMutationId: "66666666-6666-4666-8666-666666666666" },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        event: { ...result.event, subjectId: FOREIGN_SUBJECT_ID },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        document: { ...result.document, tenantId: "organization-b" },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        document: { ...resultDocument, sourcePath: "foreign.py" },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        document: { ...result.document, epoch: "88888888-8888-4888-8888-888888888888" },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        document: { ...result.document, sealedAt: "2026-08-01T00:00:02.000Z" },
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    await expect(
      assertEditorMutationCommitAcknowledgementV1(entry, {
        ...result,
        sessionUpdate: result.sessionUpdate ? { ...result.sessionUpdate, sessionGeneration: "4" } : undefined,
      }),
    ).rejects.toMatchObject({ code: "mismatch" });
    expect(pending.readExact(target)).toEqual(entry);
  });

  it("retries the retained request before open and consumes only its exact acknowledgement", async () => {
    const { journal: pending } = journal();
    const authorityIdentity = {
      organizationId: SCOPE.organizationId,
      projectId: "project-a",
      sceneName: "Demo",
      sourceHash: "a".repeat(64),
      sourcePath: "scene-1.py",
    } as const;
    const target = { ...identity(), documentKey: await createBrowserEditorDocumentKeyV1(authorityIdentity) };
    const exactRequest = request(target);
    pending.record(target, exactRequest);
    const commit = vi.fn<EditorDocumentClientV1["commit"]>(async (_identity, _documentKey, value) => {
      expect(value).toEqual(exactRequest);
      return committedResult(target, exactRequest);
    });

    await expect(
      recoverPendingEditorMutationBeforeOpenV1({
        client: { commit } as unknown as EditorDocumentClientV1,
        identity: authorityIdentity,
        journal: pending,
      }),
    ).resolves.toMatchObject({ kind: "recovered" });
    expect(commit).toHaveBeenCalledOnce();
    expect(pending.readExact(target)).toBeNull();
  });

  it("keeps a retained request explicit when a concurrent revision won", async () => {
    const { journal: pending } = journal();
    const authorityIdentity = {
      organizationId: SCOPE.organizationId,
      projectId: "project-a",
      sceneName: "Demo",
      sourceHash: "a".repeat(64),
      sourcePath: "scene-1.py",
    } as const;
    const target = { ...identity(), documentKey: await createBrowserEditorDocumentKeyV1(authorityIdentity) };
    const exactRequest = request(target);
    const entry = pending.record(target, exactRequest);
    const client = {
      commit: vi.fn(async () => ({ currentRevision: "1", kind: "conflict", reason: "revision-mismatch" }) as const),
    } as unknown as EditorDocumentClientV1;

    await expect(
      recoverPendingEditorMutationBeforeOpenV1({ client, identity: authorityIdentity, journal: pending }),
    ).rejects.toThrow("revision-mismatch");
    expect(pending.readExact(target)).toEqual(entry);
  });
});
