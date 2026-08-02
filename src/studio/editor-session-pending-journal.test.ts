import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EditorDocumentSessionPutRequestV1 } from "../collaboration/editor-document-http-contract";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import {
  type EditorSessionPendingJournalBasisV1,
  type EditorSessionPendingJournalLaneIdentityV1,
  type EditorSessionPendingJournalReadErrorV1,
  type EditorSessionPendingJournalStorageAdapterV1,
  EditorSessionPendingJournalV1,
  editorSessionPendingJournalEntryStoragePrefixV1,
  editorSessionPendingJournalStorageKeyV1,
  MAX_EDITOR_SESSION_PENDING_JOURNAL_ENTRIES_V1,
  MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1,
} from "./editor-session-pending-journal";
import { createInitialEditorState, snapshotCloudEditorSessionV1 } from "./use-editor-controller";

const FIRST_USER_ID = "2f2e3ea4-88de-4f37-81f7-1860d8f942f8";
const SECOND_USER_ID = "35b33044-5387-4c29-aed1-cad82750f4cc";
const EPOCH = "11111111-1111-4111-8111-111111111111";
const FIRST_SCOPE = { organizationId: "organization-a", userId: FIRST_USER_ID } as const;

class MemoryEntryAdapter implements EditorSessionPendingJournalStorageAdapterV1 {
  beforeNextWrite: (() => void) | null = null;
  failList = false;
  failRemove = false;
  successfulRemovesBeforeFailure: number | null = null;
  failWrite = false;
  readonly values = new Map<string, string>();

  list() {
    if (this.failList) throw new TypeError("list unavailable");
    return Array.from(this.values, ([entryId, serialized]) => ({ entryId, serialized }));
  }

  removeExact(entryId: string) {
    if (this.failRemove) throw new TypeError("remove unavailable");
    if (this.successfulRemovesBeforeFailure === 0) throw new TypeError("remove interrupted");
    if (this.successfulRemovesBeforeFailure !== null) this.successfulRemovesBeforeFailure -= 1;
    this.values.delete(entryId);
  }

  writeExact(entryId: string, serialized: string) {
    if (this.failWrite) throw new TypeError("write unavailable");
    const beforeWrite = this.beforeNextWrite;
    this.beforeNextWrite = null;
    beforeWrite?.();
    this.values.set(entryId, serialized);
  }
}

function uuidSequence(offset = 0) {
  let value = offset;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
  };
}

function laneIdentity(index = 1): EditorSessionPendingJournalLaneIdentityV1 {
  return {
    documentKey: index.toString(16).padStart(64, "0"),
    epoch: EPOCH,
    projectId: "project-a",
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
  };
}

function basis(index = 1, expectedSessionGeneration = "0", documentRevision = "0"): EditorSessionPendingJournalBasisV1 {
  return {
    documentRevision,
    expectedSessionGeneration,
    identity: laneIdentity(index),
  };
}

function snapshot(currentTime: number, selectedObjectIds: readonly string[] = []) {
  return snapshotCloudEditorSessionV1({
    ...createInitialEditorState(),
    currentTime,
    selectedObjectIds,
  });
}

function journal(adapter = new MemoryEntryAdapter(), offset = 0) {
  return {
    adapter,
    journal: new EditorSessionPendingJournalV1(FIRST_SCOPE, adapter, () => 1_000, uuidSequence(offset)),
  };
}

function journalWithWriter(adapter: MemoryEntryAdapter, offset: number, writerId: string) {
  return new EditorSessionPendingJournalV1(FIRST_SCOPE, adapter, () => 1_000, uuidSequence(offset), writerId);
}

async function attemptAndSeal(pending: EditorSessionPendingJournalV1, entryId: string) {
  const attempted = pending.markAttemptedExact(entryId);
  if (!attempted) throw new TypeError("Expected the journal entry to become attempted.");
  const sealed = await pending.sealExact(entryId);
  if (sealed.kind !== "sealed") throw new TypeError("Expected the journal entry to become sealed.");
  return sealed.entry;
}

function storedKinds(adapter: MemoryEntryAdapter) {
  return Array.from(adapter.values.values(), (serialized) => (JSON.parse(serialized) as { kind: string }).kind);
}

function parsedRecord(adapter: MemoryEntryAdapter, entryId: string) {
  const serialized = adapter.values.get(entryId);
  if (!serialized) throw new TypeError("Expected a persisted pending journal entry.");
  return JSON.parse(serialized) as {
    entry: Record<string, unknown> & { entryId: string; request: EditorDocumentSessionPutRequestV1 };
    identity: EditorSessionPendingJournalLaneIdentityV1;
    scope: typeof FIRST_SCOPE;
    version: number;
  };
}

describe("pending cloud Editor session journal", () => {
  it("uses disjoint account prefixes and one key namespace per entry", () => {
    const first = editorSessionPendingJournalStorageKeyV1(FIRST_SCOPE);
    const second = editorSessionPendingJournalStorageKeyV1({
      organizationId: "organization-b",
      userId: FIRST_USER_ID,
    });
    const third = editorSessionPendingJournalStorageKeyV1({
      organizationId: "organization-a",
      userId: SECOND_USER_ID,
    });

    expect(first).toBe(
      "poietra.studio.editor-sessions.2f2e3ea4-88de-4f37-81f7-1860d8f942f8.organization-a.pending-cloud-v1",
    );
    expect(editorSessionPendingJournalEntryStoragePrefixV1(FIRST_SCOPE)).toBe(`${first}.entry.`);
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
  });

  it("preserves disjoint lanes written by two already-open tab instances", () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;

    expect(first.record(basis(1), snapshot(1))).not.toBeNull();
    expect(second.record(basis(2), snapshot(2))).not.toBeNull();

    expect(first.readLaneExact(laneIdentity(1))?.head.request.snapshot.currentTime).toBe(1);
    expect(first.readLaneExact(laneIdentity(2))?.head.request.snapshot.currentTime).toBe(2);
    expect(second.readLaneExact(laneIdentity(1))?.head.request.snapshot.currentTime).toBe(1);
    expect(adapter.values).toHaveLength(2);
  });

  it("retains concurrent same-lane roots and fails closed until the exact lane is discarded", () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;
    let secondEntryId: string | null = null;
    adapter.beforeNextWrite = () => {
      secondEntryId = second.record(basis(), snapshot(2))?.entryId ?? null;
    };

    const firstEntry = first.record(basis(), snapshot(1));
    expect(firstEntry).not.toBeNull();
    expect(secondEntryId).not.toBeNull();
    expect(adapter.values).toHaveLength(2);
    expect(() => first.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "ambiguous" }),
    );
    expect(first.discardLaneExact(laneIdentity())).toBe(true);
    expect(adapter.values).toHaveLength(0);
  });

  it("retains concurrent conditional successors and reports their ambiguity", () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;
    const head = first.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    expect(first.markAttemptedExact(head.entryId)).not.toBeNull();
    adapter.beforeNextWrite = () => {
      expect(second.record(basis(), snapshot(3))).not.toBeNull();
    };

    expect(first.record(basis(), snapshot(2))).not.toBeNull();
    expect(adapter.values).toHaveLength(4);
    expect(() => first.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "ambiguous" }),
    );
    expect(first.discardLaneExact(laneIdentity())).toBe(true);
  });

  it("replaces only an unattempted same-writer head without deleting its crash evidence", async () => {
    const { adapter, journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    if (!first) throw new TypeError("Expected the first journal entry.");
    const replacement = pending.record(basis(), snapshot(2));
    if (!replacement) throw new TypeError("Expected the replacement journal entry.");

    expect(replacement.entryId).not.toBe(first.entryId);
    expect(pending.readLaneExact(laneIdentity())?.head).toEqual(replacement);
    expect(storedKinds(adapter).filter((kind) => kind === "entry")).toHaveLength(2);
    expect(await pending.acknowledgeExact(first.entryId, first.request)).toBe(false);
    expect(await pending.acknowledgeExact(replacement.entryId, first.request)).toBe(false);
    await attemptAndSeal(pending, replacement.entryId);
    expect(await pending.acknowledgeExact(replacement.entryId, replacement.request)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
  });

  it("keeps an attempted head immutable and coalesces at most one conditional successor", async () => {
    const { journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    if (!first) throw new TypeError("Expected the first journal entry.");
    const attempted = pending.markAttemptedExact(first.entryId);
    if (!attempted) throw new TypeError("Expected the attempted journal head.");

    const second = pending.record(basis(), snapshot(2));
    const third = pending.record(basis(), snapshot(3));
    if (!second || !third) throw new TypeError("Expected conditional successors.");
    const lane = pending.readLaneExact(laneIdentity());
    expect(lane?.head).toEqual(attempted);
    expect(lane?.successor?.entryId).toBe(third.entryId);
    expect(lane?.successor?.entryId).not.toBe(second.entryId);
    expect(lane?.successor?.predecessorEntryId).toBe(first.entryId);
    expect(lane?.successor?.request.expectedSessionGeneration).toBe("1");
    expect(lane?.successor?.request.snapshot.currentTime).toBe(3);

    expect(await pending.acknowledgeExact(second.entryId, second.request)).toBe(false);
    await pending.sealExact(first.entryId);
    expect(await pending.acknowledgeExact(first.entryId, first.request)).toBe(true);
    const promoted = pending.readLaneExact(laneIdentity());
    expect(promoted?.head.entryId).toBe(third.entryId);
    expect(promoted?.head.predecessorEntryId).toBeNull();
    expect(promoted?.head.state).toBe("prepared");
    expect(promoted?.successor).toBeNull();
    expect(await pending.acknowledgeExact(first.entryId, first.request)).toBe(true);
  });

  it("retires the whole supersession ancestry before any acknowledgement cleanup", async () => {
    const { adapter, journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    const replacement = pending.record(basis(), snapshot(2));
    if (!first || !replacement) throw new TypeError("Expected the replacement chain.");
    await attemptAndSeal(pending, replacement.entryId);
    adapter.failRemove = true;

    expect(await pending.acknowledgeExact(replacement.entryId, replacement.request)).toBe(true);
    expect(adapter.values.has(first.entryId)).toBe(true);
    expect(adapter.values.has(replacement.entryId)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
  });

  it("keeps retired payload evidence harmless after partial acknowledgement cleanup", async () => {
    const { adapter, journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    const replacement = pending.record(basis(), snapshot(2));
    if (!first || !replacement) throw new TypeError("Expected the replacement chain.");
    await attemptAndSeal(pending, replacement.entryId);
    adapter.successfulRemovesBeforeFailure = 1;

    expect(await pending.acknowledgeExact(replacement.entryId, replacement.request)).toBe(true);
    expect(adapter.values.has(replacement.entryId)).toBe(true);
    expect(adapter.values.has(`attempt.${replacement.entryId}`)).toBe(false);
    expect(adapter.values.has(`seal.${replacement.entryId}`)).toBe(true);
    expect(adapter.values.has(first.entryId)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
  });

  it("keeps a previous acknowledgement until its interrupted cleanup can finish", async () => {
    const { adapter, journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    if (!first) throw new TypeError("Expected the first exact-CAS entry.");
    await attemptAndSeal(pending, first.entryId);
    adapter.successfulRemovesBeforeFailure = 1;

    expect(await pending.acknowledgeExact(first.entryId, first.request)).toBe(true);
    expect(adapter.values.has(`ack.${first.entryId}`)).toBe(true);
    expect(adapter.values.has(first.entryId)).toBe(true);

    adapter.successfulRemovesBeforeFailure = null;
    const next = pending.record(basis(1, "1"), snapshot(2));
    if (!next) throw new TypeError("Expected the next exact-CAS entry.");
    await attemptAndSeal(pending, next.entryId);
    adapter.failRemove = true;

    expect(await pending.acknowledgeExact(next.entryId, next.request)).toBe(true);
    expect(adapter.values.has(`ack.${first.entryId}`)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();

    adapter.failRemove = false;
    expect(await pending.acknowledgeExact(next.entryId, next.request)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
    expect(storedKinds(adapter)).toEqual(["ack"]);
  });

  it("acknowledges a sealed cloud-exact observation without an attempt fact", async () => {
    const { adapter, journal: pending } = journal();
    const entry = pending.record(basis(), snapshot(1));
    if (!entry) throw new TypeError("Expected the pending entry.");
    expect((await pending.sealExact(entry.entryId)).kind).toBe("sealed");
    adapter.failRemove = true;

    expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    expect(adapter.values.has(`attempt.${entry.entryId}`)).toBe(false);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
  });

  it("makes an exact acknowledgement idempotent after payload compaction", async () => {
    const { journal: pending } = journal();
    const entry = pending.record(basis(), snapshot(1));
    if (!entry) throw new TypeError("Expected the pending entry.");
    await attemptAndSeal(pending, entry.entryId);

    expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    expect(await pending.acknowledgeExact(entry.entryId, { ...entry.request, expectedSessionGeneration: "9" })).toBe(
      false,
    );
    expect(await pending.acknowledgeExact(entry.entryId, { ...entry.request, snapshot: snapshot(9) })).toBe(false);
  });

  it("compacts a large acknowledged snapshot to a small CAS frontier", async () => {
    const { adapter, journal: pending } = journal();
    const large = snapshot(
      1,
      Array.from({ length: 256 }, (_, index) => `entity-${index.toString().padStart(3, "0")}-${"x".repeat(480)}`),
    );
    const entry = pending.record(basis(), large);
    if (!entry) throw new TypeError("Expected the large pending entry.");
    await attemptAndSeal(pending, entry.entryId);
    const bytesBeforeAcknowledgement = Array.from(adapter.values.values()).reduce(
      (sum, serialized) => sum + Buffer.byteLength(serialized),
      0,
    );

    expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    const bytesAfterAcknowledgement = Array.from(adapter.values.values()).reduce(
      (sum, serialized) => sum + Buffer.byteLength(serialized),
      0,
    );
    expect(storedKinds(adapter)).toEqual(["ack"]);
    expect(bytesAfterAcknowledgement * 10).toBeLessThan(bytesBeforeAcknowledgement);
  });

  it("advances one compact acknowledgement frontier across repeated saves", async () => {
    const { adapter, journal: pending } = journal();
    for (let generation = 0; generation < 8; generation += 1) {
      const entry = pending.record(basis(1, generation.toString(10)), snapshot(generation));
      if (!entry) throw new TypeError("Expected the next exact-CAS entry.");
      expect((await pending.sealExact(entry.entryId)).kind).toBe("sealed");
      expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
      expect(pending.readLaneExact(laneIdentity())).toBeNull();
      expect(storedKinds(adapter)).toEqual(["ack"]);
    }
  });

  it("bounds quiescent acknowledgement lanes before admitting another identity", async () => {
    const { adapter, journal: pending } = journal();
    for (let index = 1; index <= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 + 10; index += 1) {
      const entry = pending.record(basis(index), snapshot(index));
      if (!entry) throw new TypeError("Expected a bounded acknowledgement lane.");
      expect((await pending.sealExact(entry.entryId)).kind).toBe("sealed");
      expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    }
    expect(storedKinds(adapter).filter((kind) => kind === "ack")).toHaveLength(
      MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1,
    );
    expect(adapter.values.size).toBe(MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1);
  });

  it("keeps the absolute read ceiling fail-closed while discardAll remains available", () => {
    const { adapter, journal: pending } = journal();
    for (let index = 0; index < 300; index += 1) adapter.values.set(`hostile-${index}`, "{}");
    expect(() => pending.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "capacity" }),
    );
    expect(pending.discardAll()).toBe(true);
  });

  it("fails closed when an attempt races a same-writer supersession", () => {
    const adapter = new MemoryEntryAdapter();
    const writerId = "33333333-3333-4333-8333-333333333333";
    const first = journalWithWriter(adapter, 0, writerId);
    const second = journalWithWriter(adapter, 100, writerId);
    const head = first.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    adapter.beforeNextWrite = () => {
      expect(first.markAttemptedExact(head.entryId)).not.toBeNull();
    };

    expect(second.record(basis(), snapshot(2))).not.toBeNull();
    expect(storedKinds(adapter).filter((kind) => kind === "entry")).toHaveLength(2);
    expect(() => first.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "ambiguous" }),
    );
  });

  it("promotes a successor when it is written before its predecessor acknowledgement", async () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;
    const head = first.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    await attemptAndSeal(first, head.entryId);
    const successor = second.record(basis(), snapshot(2));
    if (!successor) throw new TypeError("Expected the pending successor.");

    expect(await first.acknowledgeExact(head.entryId, head.request)).toBe(true);
    expect(first.readLaneExact(laneIdentity())?.head.entryId).toBe(successor.entryId);
    expect(first.readLaneExact(laneIdentity())?.head.predecessorEntryId).toBeNull();
  });

  it("promotes a stale-tab successor written after its predecessor acknowledgement", async () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;
    const head = first.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    await attemptAndSeal(first, head.entryId);
    const successor = second.record(basis(), snapshot(2));
    if (!successor) throw new TypeError("Expected the late successor.");
    const delayedSuccessor = adapter.values.get(successor.entryId);
    if (!delayedSuccessor) throw new TypeError("Expected the delayed successor payload.");
    adapter.values.delete(successor.entryId);

    expect(await first.acknowledgeExact(head.entryId, head.request)).toBe(true);
    adapter.values.set(successor.entryId, delayedSuccessor);
    expect(first.readLaneExact(laneIdentity())?.head.entryId).toBe(successor.entryId);
  });

  it("ignores a lifecycle fact that resumes after a later acknowledgement frontier", async () => {
    const { adapter, journal: pending } = journal();
    const first = pending.record(basis(), snapshot(1));
    if (!first) throw new TypeError("Expected the first exact-CAS entry.");
    await attemptAndSeal(pending, first.entryId);
    const delayedAttempt = adapter.values.get(`attempt.${first.entryId}`);
    if (!delayedAttempt) throw new TypeError("Expected the delayed attempt fact.");
    expect(await pending.acknowledgeExact(first.entryId, first.request)).toBe(true);

    const next = pending.record(basis(1, "1"), snapshot(2));
    if (!next) throw new TypeError("Expected the next exact-CAS entry.");
    await attemptAndSeal(pending, next.entryId);
    expect(await pending.acknowledgeExact(next.entryId, next.request)).toBe(true);
    for (let index = 2; index <= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 + 1; index += 1) {
      const other = pending.record(basis(index), snapshot(index));
      if (!other) throw new TypeError("Expected a bounded acknowledgement lane.");
      expect((await pending.sealExact(other.entryId)).kind).toBe("sealed");
      expect(await pending.acknowledgeExact(other.entryId, other.request)).toBe(true);
    }
    expect(adapter.values.has(`ack.${next.entryId}`)).toBe(false);

    adapter.values.set(`attempt.${first.entryId}`, delayedAttempt);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
  });

  it("uses the acknowledgement fact after a crash before acknowledged-payload cleanup", async () => {
    const { adapter, journal: pending } = journal();
    const head = pending.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    await attemptAndSeal(pending, head.entryId);
    const successor = pending.record(basis(), snapshot(2));
    if (!successor) throw new TypeError("Expected the pending successor.");
    adapter.failRemove = true;

    expect(await pending.acknowledgeExact(head.entryId, head.request)).toBe(true);
    expect(adapter.values.has(head.entryId)).toBe(true);
    expect(adapter.values.has(`ack.${head.entryId}`)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())?.head.entryId).toBe(successor.entryId);
  });

  it("does not promote a successor that arrives after an explicit discard without an acknowledgement", async () => {
    const adapter = new MemoryEntryAdapter();
    const first = journal(adapter, 0).journal;
    const second = journal(adapter, 100).journal;
    const head = first.record(basis(), snapshot(1));
    if (!head) throw new TypeError("Expected the pending head.");
    await attemptAndSeal(first, head.entryId);
    const orphanAttempt = adapter.values.get(`attempt.${head.entryId}`);
    if (!orphanAttempt) throw new TypeError("Expected the predecessor attempt fact.");
    adapter.beforeNextWrite = () => {
      expect(first.discardLaneExact(laneIdentity())).toBe(true);
    };

    expect(second.record(basis(), snapshot(2))).not.toBeNull();
    adapter.values.set(`attempt.${head.entryId}`, orphanAttempt);
    expect(() => first.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "ambiguous" }),
    );
  });

  it("seals the whole exact request and rejects metadata or digest tampering", async () => {
    const { adapter, journal: pending } = journal();
    const entry = pending.record(basis(), snapshot(4));
    if (!entry) throw new TypeError("Expected a journal entry.");
    const sealed = await pending.sealExact(entry.entryId);
    if (sealed.kind !== "sealed") throw new TypeError("Expected a sealed journal entry.");
    expect(sealed.entry.integrity.kind === "sha256" ? sealed.entry.integrity.digest : null).toBe(
      createHash("sha256").update(canonicalJsonV1(sealed.entry.request)).digest("hex"),
    );

    const stored = parsedRecord(adapter, entry.entryId);
    (stored.entry.request as { expectedSessionGeneration: string }).expectedSessionGeneration = "9";
    adapter.values.set(entry.entryId, JSON.stringify(stored));
    expect(await pending.sealExact(entry.entryId)).toEqual({ kind: "corrupt" });

    (stored.entry.request as { expectedSessionGeneration: string }).expectedSessionGeneration = "0";
    stored.entry.integrity = { digest: "f".repeat(64), kind: "sha256" };
    adapter.values.set(entry.entryId, JSON.stringify(stored));
    await expect(pending.sealExact(entry.entryId)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("fails closed on malformed, foreign, or stale byte evidence and lets explicit discardAll recover", () => {
    const { adapter, journal: pending } = journal();
    const entry = pending.record(basis(), snapshot(1));
    if (!entry) throw new TypeError("Expected a journal entry.");
    const stored = parsedRecord(adapter, entry.entryId);
    stored.entry.snapshotByteSize = 1;
    adapter.values.set(entry.entryId, JSON.stringify(stored));
    expect(() => pending.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "corrupt" }),
    );

    stored.entry.snapshotByteSize = entry.snapshotByteSize;
    stored.scope = { organizationId: "organization-b", userId: SECOND_USER_ID } as unknown as typeof FIRST_SCOPE;
    adapter.values.set(entry.entryId, JSON.stringify(stored));
    expect(() => pending.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "corrupt" }),
    );
    adapter.values.set("not-an-entry-id", "{not-json");
    expect(pending.discardAll()).toBe(true);
    expect(adapter.values).toHaveLength(0);
  });

  it("returns owned values that cannot mutate a persisted exact request", () => {
    const { journal: pending } = journal();
    const entry = pending.record(basis(), snapshot(1));
    if (!entry) throw new TypeError("Expected a journal entry.");
    (entry.request as { expectedSessionGeneration: string }).expectedSessionGeneration = "9";
    const lane = pending.readLaneExact(laneIdentity());
    if (!lane) throw new TypeError("Expected a journal lane.");
    (lane.head.request as { expectedSessionGeneration: string }).expectedSessionGeneration = "8";
    expect(pending.readLaneExact(laneIdentity())?.head.request.expectedSessionGeneration).toBe("0");
  });

  it("enforces the lane and entry limits without evicting unacknowledged entries", () => {
    const { adapter, journal: pending } = journal();
    for (let index = 1; index <= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1; index += 1) {
      const head = pending.record(basis(index), snapshot(index));
      if (!head) throw new TypeError("Expected a bounded journal head.");
      expect(pending.markAttemptedExact(head.entryId)).not.toBeNull();
      expect(pending.record(basis(index), snapshot(index + 100))).not.toBeNull();
    }
    expect(storedKinds(adapter).filter((kind) => kind === "entry")).toHaveLength(
      MAX_EDITOR_SESSION_PENDING_JOURNAL_ENTRIES_V1,
    );
    expect(() => pending.record(basis(MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 + 1), snapshot(21))).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "capacity" }),
    );
    expect(pending.readLaneExact(laneIdentity(1))).not.toBeNull();
    expect(pending.discardAll()).toBe(true);
  });

  it("keeps existing lanes readable, sealable, and acknowledgeable after a cross-tab soft-limit overshoot", async () => {
    const { adapter, journal: pending } = journal();
    let firstLaneHead: ReturnType<EditorSessionPendingJournalV1["record"]> = null;
    let firstLaneOriginal: ReturnType<EditorSessionPendingJournalV1["record"]> = null;
    for (let index = 1; index <= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1; index += 1) {
      const original = pending.record(basis(index), snapshot(index));
      const replacement = pending.record(basis(index), snapshot(index + 100));
      if (!original || !replacement) throw new TypeError("Expected the bounded replacement lanes.");
      if (index === 1) {
        firstLaneOriginal = original;
        firstLaneHead = replacement;
      }
    }
    if (!firstLaneOriginal || !firstLaneHead) throw new TypeError("Expected the first retained lane.");
    const overflowEntryId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const overflow = parsedRecord(adapter, firstLaneOriginal.entryId);
    overflow.entry.entryId = overflowEntryId;
    overflow.entry.predecessorEntryId = null;
    overflow.entry.supersedesEntryId = null;
    overflow.identity = laneIdentity(MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 + 1);
    adapter.values.set(overflowEntryId, JSON.stringify(overflow));

    expect(() => pending.record(basis(MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 + 2), snapshot(999))).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "capacity" }),
    );
    expect(pending.readLaneExact(laneIdentity(1))?.head.entryId).toBe(firstLaneHead.entryId);
    expect((await pending.sealExact(firstLaneHead.entryId)).kind).toBe("sealed");
    expect(await pending.acknowledgeExact(firstLaneHead.entryId, firstLaneHead.request)).toBe(true);
    expect(pending.readLaneExact(laneIdentity(1))).toBeNull();
  });

  it("enforces the total byte bound without evicting retained lanes", () => {
    const { journal: pending } = journal();
    const selectedObjectIds = Array.from(
      { length: 256 },
      (_, index) => `entity-${index.toString().padStart(3, "0")}-${"x".repeat(480)}`,
    );
    const large = snapshot(1, selectedObjectIds);
    let rejectedAt: number | null = null;
    for (let index = 1; index <= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1; index += 1) {
      try {
        pending.record(basis(index), large);
      } catch (error) {
        expect(error).toMatchObject({ code: "capacity" });
        rejectedAt = index;
        break;
      }
    }
    expect(rejectedAt).not.toBeNull();
    expect(pending.readLaneExact(laneIdentity(1))).not.toBeNull();
  });

  it("discards only the exact lane identity, including an ambiguous lane", () => {
    const { journal: pending } = journal();
    expect(pending.record(basis(1), snapshot(1))).not.toBeNull();
    expect(pending.record(basis(2), snapshot(2))).not.toBeNull();
    expect(pending.discardLaneExact({ ...laneIdentity(1), epoch: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    expect(pending.discardLaneExact(laneIdentity(1))).toBe(true);
    expect(pending.readLaneExact(laneIdentity(1))).toBeNull();
    expect(pending.readLaneExact(laneIdentity(2))).not.toBeNull();
  });

  it("fails closed when entry listing or writing fails and treats acknowledgement cleanup as optional", async () => {
    const unreadable = new MemoryEntryAdapter();
    unreadable.failList = true;
    const unreadableJournal = journal(unreadable).journal;
    expect(() => unreadableJournal.record(basis(), snapshot(1))).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "storage" }),
    );
    expect(() => unreadableJournal.readLaneExact(laneIdentity())).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "storage" }),
    );

    const unwritable = new MemoryEntryAdapter();
    unwritable.failWrite = true;
    expect(() => journal(unwritable).journal.record(basis(), snapshot(1))).toThrowError(
      expect.objectContaining<Partial<EditorSessionPendingJournalReadErrorV1>>({ code: "storage" }),
    );

    const uncleared = new MemoryEntryAdapter();
    const pending = journal(uncleared).journal;
    const entry = pending.record(basis(), snapshot(1));
    if (!entry) throw new TypeError("Expected a journal entry.");
    await attemptAndSeal(pending, entry.entryId);
    uncleared.failRemove = true;
    expect(await pending.acknowledgeExact(entry.entryId, entry.request)).toBe(true);
    expect(pending.readLaneExact(laneIdentity())).toBeNull();
    expect(pending.discardAll()).toBe(false);
    uncleared.failRemove = false;
    expect(pending.discardAll()).toBe(true);
  });
});
