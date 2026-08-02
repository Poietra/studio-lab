import { z } from "zod";

import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import {
  type EditorDocumentSessionPutRequestV1,
  editorDocumentKeySchemaV1,
  editorDocumentSessionPutRequestSchemaV1,
  editorRevisionStringSchemaV1,
} from "../collaboration/editor-document-http-contract";
import {
  canonicalEditorSessionSnapshotJsonV1,
  type EditorSessionSnapshotV1,
} from "../collaboration/editor-session-contract";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { sha256V1Schema } from "../engine/primitives";
import { manimProjectIdSchema, manimSourcePathSchema } from "../render-pipeline/manim-identity-contract";
import { type EditorSessionAccountScope, editorSessionStorageKey } from "./editor-session-store";

export const EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1 = 1 as const;
export const MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 = 20;
export const MAX_EDITOR_SESSION_PENDING_JOURNAL_ENTRIES_V1 = MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1 * 2;
export const MAX_EDITOR_SESSION_PENDING_JOURNAL_BYTES_V1 = 2 * 1024 * 1024;

// Facts are deliberately admitted beyond the soft payload budget so an already
// retained request can still be sealed or acknowledged. This absolute ceiling
// only bounds hostile/corrupt reads; it is not an eviction policy.
const MAX_EDITOR_SESSION_PENDING_JOURNAL_RECORDS_HARD_V1 = 256;
const MAX_EDITOR_SESSION_PENDING_JOURNAL_BYTES_HARD_V1 = 8 * 1024 * 1024;

const pendingJournalIntegritySchemaV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unsealed") }).strict(),
  z.object({ digest: sha256V1Schema, kind: z.literal("sha256") }).strict(),
]);

const pendingJournalScopeSchemaV1 = z
  .object({ organizationId: accountOrganizationIdSchemaV1, userId: z.uuid() })
  .strict();

const pendingJournalLaneIdentitySchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: z.uuid(),
    projectId: manimProjectIdSchema,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
  })
  .strict();

const pendingJournalEntryCoreSchemaV1 = z
  .object({
    entryId: z.uuid(),
    predecessorEntryId: z.uuid().nullable(),
    request: editorDocumentSessionPutRequestSchemaV1,
    savedAt: z.number().int().nonnegative(),
    snapshotByteSize: z.number().int().positive(),
    supersedesEntryId: z.uuid().nullable(),
    writerId: z.uuid(),
  })
  .strict()
  .superRefine((entry, context) => {
    const canonical = canonicalEditorSessionSnapshotJsonV1(entry.request.snapshot);
    if (new TextEncoder().encode(canonical).byteLength !== entry.snapshotByteSize) {
      context.addIssue({ code: "custom", message: "Pending Editor session byte evidence is inconsistent." });
    }
    if (
      entry.entryId === entry.predecessorEntryId ||
      entry.entryId === entry.supersedesEntryId ||
      (entry.predecessorEntryId !== null && entry.predecessorEntryId === entry.supersedesEntryId)
    ) {
      context.addIssue({ code: "custom", message: "Pending Editor session ancestry is self-referential." });
    }
  });

const pendingJournalEntrySchemaV1 = pendingJournalEntryCoreSchemaV1
  .extend({
    integrity: pendingJournalIntegritySchemaV1,
    state: z.enum(["attempted", "prepared"]),
  })
  .strict();

const pendingJournalStoredEntrySchemaV1 = z
  .object({
    entry: pendingJournalEntryCoreSchemaV1,
    identity: pendingJournalLaneIdentitySchemaV1,
    kind: z.literal("entry"),
    scope: pendingJournalScopeSchemaV1,
    version: z.literal(EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1),
  })
  .strict()
  .superRefine((stored, context) => {
    if (stored.entry.request.epoch !== stored.identity.epoch) {
      context.addIssue({ code: "custom", message: "A pending Editor session entry has a foreign epoch." });
    }
  });

const pendingJournalStoredAttemptSchemaV1 = z
  .object({
    documentRevision: editorRevisionStringSchemaV1,
    entryId: z.uuid(),
    expectedSessionGeneration: editorRevisionStringSchemaV1,
    identity: pendingJournalLaneIdentitySchemaV1,
    kind: z.literal("attempt"),
    scope: pendingJournalScopeSchemaV1,
    version: z.literal(EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1),
  })
  .strict();

const pendingJournalStoredSealSchemaV1 = z
  .object({
    digest: sha256V1Schema,
    documentRevision: editorRevisionStringSchemaV1,
    entryId: z.uuid(),
    expectedSessionGeneration: editorRevisionStringSchemaV1,
    identity: pendingJournalLaneIdentitySchemaV1,
    kind: z.literal("seal"),
    scope: pendingJournalScopeSchemaV1,
    version: z.literal(EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1),
  })
  .strict();

const pendingJournalStoredAcknowledgementSchemaV1 = z
  .object({
    acknowledgedAt: z.number().int().nonnegative(),
    documentRevision: editorRevisionStringSchemaV1,
    entryId: z.uuid(),
    epoch: z.uuid(),
    expectedSessionGeneration: editorRevisionStringSchemaV1,
    identity: pendingJournalLaneIdentitySchemaV1,
    kind: z.literal("ack"),
    predecessorEntryId: z.uuid().nullable(),
    requestDigest: sha256V1Schema,
    retiredEntryIds: z.array(z.uuid()).min(1).max(MAX_EDITOR_SESSION_PENDING_JOURNAL_ENTRIES_V1),
    scope: pendingJournalScopeSchemaV1,
    storedSessionGeneration: editorRevisionStringSchemaV1,
    version: z.literal(EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1),
    writerId: z.uuid(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (
      acknowledgement.epoch !== acknowledgement.identity.epoch ||
      acknowledgement.retiredEntryIds[0] !== acknowledgement.entryId ||
      new Set(acknowledgement.retiredEntryIds).size !== acknowledgement.retiredEntryIds.length ||
      (acknowledgement.predecessorEntryId !== null &&
        acknowledgement.retiredEntryIds.includes(acknowledgement.predecessorEntryId)) ||
      BigInt(acknowledgement.storedSessionGeneration) !== BigInt(acknowledgement.expectedSessionGeneration) + 1n
    ) {
      context.addIssue({ code: "custom", message: "Pending Editor session acknowledgement evidence is invalid." });
    }
  });

const pendingJournalStoredRecordSchemaV1 = z.discriminatedUnion("kind", [
  pendingJournalStoredEntrySchemaV1,
  pendingJournalStoredAttemptSchemaV1,
  pendingJournalStoredSealSchemaV1,
  pendingJournalStoredAcknowledgementSchemaV1,
]);

const pendingJournalLaneSchemaV1 = z
  .object({
    head: pendingJournalEntrySchemaV1,
    identity: pendingJournalLaneIdentitySchemaV1,
    successor: pendingJournalEntrySchemaV1.nullable(),
  })
  .strict()
  .superRefine((lane, context) => {
    if (lane.head.request.epoch !== lane.identity.epoch || lane.head.predecessorEntryId !== null) {
      context.addIssue({ code: "custom", message: "A pending Editor session head has invalid ancestry." });
    }
    if (!lane.successor) return;
    if (
      lane.head.state !== "attempted" ||
      lane.successor.state !== "prepared" ||
      lane.successor.predecessorEntryId !== lane.head.entryId ||
      lane.successor.request.epoch !== lane.head.request.epoch ||
      lane.successor.request.documentRevision !== lane.head.request.documentRevision ||
      BigInt(lane.successor.request.expectedSessionGeneration) !==
        BigInt(lane.head.request.expectedSessionGeneration) + 1n
    ) {
      context.addIssue({ code: "custom", message: "A pending Editor session successor has invalid CAS evidence." });
    }
  });

export type EditorSessionPendingJournalLaneIdentityV1 = z.infer<typeof pendingJournalLaneIdentitySchemaV1>;
export type EditorSessionPendingJournalEntryV1 = z.infer<typeof pendingJournalEntrySchemaV1>;
export type EditorSessionPendingJournalLaneV1 = z.infer<typeof pendingJournalLaneSchemaV1>;

export type EditorSessionPendingJournalBasisV1 = Readonly<{
  documentRevision: string;
  expectedSessionGeneration: string;
  identity: EditorSessionPendingJournalLaneIdentityV1;
}>;

export type EditorSessionPendingJournalSealOutcomeV1 =
  | Readonly<{ entry: EditorSessionPendingJournalEntryV1; kind: "sealed" }>
  | Readonly<{ kind: "corrupt" | "missing" }>;

export type EditorSessionPendingJournalStoredValueV1 = Readonly<{
  entryId: string;
  serialized: string;
}>;

/** Account-scoped records. `entryId` is the opaque storage-key suffix. */
export interface EditorSessionPendingJournalStorageAdapterV1 {
  list(): readonly EditorSessionPendingJournalStoredValueV1[];
  removeExact(entryId: string): void;
  writeExact(entryId: string, serialized: string): void;
}

export class EditorSessionPendingJournalReadErrorV1 extends Error {
  constructor(
    message: string,
    readonly code: "ambiguous" | "capacity" | "corrupt" | "storage",
  ) {
    super(message);
    this.name = "EditorSessionPendingJournalReadErrorV1";
  }
}

type PendingJournalStoredRecordV1 = z.infer<typeof pendingJournalStoredRecordSchemaV1>;
type PendingJournalStoredEntryV1 = z.infer<typeof pendingJournalStoredEntrySchemaV1>;
type PendingJournalStoredAcknowledgementV1 = z.infer<typeof pendingJournalStoredAcknowledgementSchemaV1>;

type ParsedStoredRecordV1 = Readonly<{
  record: PendingJournalStoredRecordV1;
  serialized: string;
  storageId: string;
}>;

type ResolvedEntryV1 = Readonly<{
  core: z.infer<typeof pendingJournalEntryCoreSchemaV1>;
  view: EditorSessionPendingJournalEntryV1;
}>;

type ResolvedLaneV1 = Readonly<{
  head: ResolvedEntryV1;
  successor: ResolvedEntryV1 | null;
}>;

function serializedBytesV1(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function sameScopeV1(left: EditorSessionAccountScope, right: EditorSessionAccountScope) {
  return left.organizationId === right.organizationId && left.userId === right.userId;
}

function laneIdentityKeyV1(identity: EditorSessionPendingJournalLaneIdentityV1) {
  return canonicalJsonV1(identity);
}

function sameRequestV1(left: EditorDocumentSessionPutRequestV1, right: EditorDocumentSessionPutRequestV1) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function sameCasSlotV1(
  left: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
  right: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
) {
  return (
    left.predecessorEntryId === right.predecessorEntryId &&
    left.request.documentRevision === right.request.documentRevision &&
    left.request.epoch === right.request.epoch &&
    left.request.expectedSessionGeneration === right.request.expectedSessionGeneration
  );
}

function ownedEntryV1(entry: EditorSessionPendingJournalEntryV1) {
  return pendingJournalEntrySchemaV1.parse(JSON.parse(JSON.stringify(entry)) as unknown);
}

function ownedLaneV1(lane: EditorSessionPendingJournalLaneV1) {
  return pendingJournalLaneSchemaV1.parse(JSON.parse(JSON.stringify(lane)) as unknown);
}

async function sha256HexV1(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pendingJournalEntryCoreV1(
  request: EditorDocumentSessionPutRequestV1,
  input: Readonly<{
    entryId: string;
    now: number;
    predecessorEntryId: string | null;
    supersedesEntryId: string | null;
    writerId: string;
  }>,
) {
  const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(request.snapshot);
  return pendingJournalEntryCoreSchemaV1.parse({
    entryId: input.entryId,
    predecessorEntryId: input.predecessorEntryId,
    request,
    savedAt: Math.max(0, Math.floor(input.now)),
    snapshotByteSize: serializedBytesV1(canonicalSnapshot),
    supersedesEntryId: input.supersedesEntryId,
    writerId: input.writerId,
  });
}

function storageIdForRecordV1(record: PendingJournalStoredRecordV1) {
  return record.kind === "entry" ? record.entry.entryId : `${record.kind}.${record.entryId}`;
}

export function editorSessionPendingJournalStorageKeyV1(scope: EditorSessionAccountScope) {
  return `${editorSessionStorageKey(scope)}.pending-cloud-v1`;
}

export function editorSessionPendingJournalEntryStoragePrefixV1(scope: EditorSessionAccountScope) {
  return `${editorSessionPendingJournalStorageKeyV1(scope)}.entry.`;
}

class WebStorageEditorSessionPendingJournalAdapterV1 implements EditorSessionPendingJournalStorageAdapterV1 {
  constructor(
    private readonly storage: Storage,
    private readonly prefix: string,
  ) {}

  list() {
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.prefix)) keys.push(key);
    }
    keys.sort();
    return keys.flatMap((key) => {
      const serialized = this.storage.getItem(key);
      return serialized === null ? [] : [{ entryId: key.slice(this.prefix.length), serialized }];
    });
  }

  removeExact(entryId: string) {
    this.storage.removeItem(`${this.prefix}${entryId}`);
  }

  writeExact(entryId: string, serialized: string) {
    this.storage.setItem(`${this.prefix}${entryId}`, serialized);
  }
}

export function browserEditorSessionPendingJournalV1(
  scope: EditorSessionAccountScope,
): EditorSessionPendingJournalV1 | null {
  if (typeof window === "undefined") return null;
  try {
    const adapter = new WebStorageEditorSessionPendingJournalAdapterV1(
      window.localStorage,
      editorSessionPendingJournalEntryStoragePrefixV1(scope),
    );
    // Access can throw even when `window.localStorage` itself was returned.
    adapter.list();
    return new EditorSessionPendingJournalV1(scope, adapter);
  } catch {
    return null;
  }
}

/**
 * Account-scoped, bounded write-ahead journal for private cloud sessions.
 * Payloads never change in place. Attempt/seal/ack facts are monotonic and
 * independently durable, so no cross-tab transition depends on write+remove.
 */
export class EditorSessionPendingJournalV1 {
  private readonly scope: z.infer<typeof pendingJournalScopeSchemaV1>;
  private readonly writerId: string;

  constructor(
    scope: EditorSessionAccountScope,
    private readonly adapter: EditorSessionPendingJournalStorageAdapterV1,
    private readonly now: () => number = Date.now,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    writerId?: string,
  ) {
    this.scope = pendingJournalScopeSchemaV1.parse(scope);
    this.writerId = z.uuid().parse(writerId ?? this.randomUuid());
  }

  record(
    basisValue: EditorSessionPendingJournalBasisV1,
    snapshotValue: EditorSessionSnapshotV1,
  ): EditorSessionPendingJournalEntryV1 | null {
    try {
      const identity = pendingJournalLaneIdentitySchemaV1.parse(basisValue.identity);
      const documentRevision = editorRevisionStringSchemaV1.parse(basisValue.documentRevision);
      const expectedSessionGeneration = editorRevisionStringSchemaV1.parse(basisValue.expectedSessionGeneration);
      const request = editorDocumentSessionPutRequestSchemaV1.parse({
        documentRevision,
        epoch: identity.epoch,
        expectedSessionGeneration,
        snapshot: snapshotValue,
        snapshotVersion: 1,
      });
      let records = this.scan();
      records = this.compactAcknowledgementLanesForAdmission(records, identity);
      const identityRecords = this.recordsForIdentity(records, identity);
      const lane = this.resolveLane(identity, identityRecords);
      let predecessorEntryId: string | null = null;
      let supersedesEntryId: string | null = null;
      let nextRequest = request;

      if (lane) {
        if (
          lane.head.core.request.documentRevision !== documentRevision ||
          lane.head.core.request.epoch !== identity.epoch
        ) {
          return null;
        }
        if (sameRequestV1(lane.head.core.request, request)) return ownedEntryV1(lane.head.view);
        if (lane.successor && sameRequestV1(lane.successor.core.request, request)) {
          return ownedEntryV1(lane.successor.view);
        }
        if (lane.head.view.state === "prepared") {
          if (lane.head.core.request.expectedSessionGeneration !== expectedSessionGeneration) return null;
          if (lane.head.core.writerId === this.writerId) {
            predecessorEntryId = lane.head.core.predecessorEntryId;
            supersedesEntryId = lane.head.core.entryId;
          }
        } else {
          predecessorEntryId = lane.head.core.entryId;
          nextRequest = editorDocumentSessionPutRequestSchemaV1.parse({
            ...request,
            expectedSessionGeneration: (BigInt(lane.head.core.request.expectedSessionGeneration) + 1n).toString(10),
          });
          if (lane.successor) {
            if (lane.successor.core.writerId === this.writerId) supersedesEntryId = lane.successor.core.entryId;
          }
        }
      } else {
        const frontiers = identityRecords.flatMap((record) =>
          record.record.kind === "ack" &&
          record.record.epoch === request.epoch &&
          record.record.documentRevision === request.documentRevision &&
          record.record.storedSessionGeneration === request.expectedSessionGeneration
            ? [record.record]
            : [],
        );
        if (frontiers.length > 1) return null;
        predecessorEntryId = frontiers[0]?.entryId ?? null;
      }

      const core = pendingJournalEntryCoreV1(nextRequest, {
        entryId: this.randomUuid(),
        now: this.now(),
        predecessorEntryId,
        supersedesEntryId,
        writerId: this.writerId,
      });
      const record = pendingJournalStoredEntrySchemaV1.parse({
        entry: core,
        identity,
        kind: "entry",
        scope: this.scope,
        version: EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1,
      });
      if (!this.writeRecord(record, records, true)) return null;
      return this.entryView(core, identityRecords, predecessorEntryId !== null);
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      return null;
    }
  }

  readLaneExact(identityValue: EditorSessionPendingJournalLaneIdentityV1) {
    const identity = pendingJournalLaneIdentitySchemaV1.parse(identityValue);
    const lane = this.resolveLane(identity, this.recordsForIdentity(this.scan(), identity));
    if (!lane) return null;
    return ownedLaneV1({ head: lane.head.view, identity, successor: lane.successor?.view ?? null });
  }

  markAttemptedExact(entryId: string) {
    try {
      const parsedEntryId = z.uuid().parse(entryId);
      let records = this.scan();
      const stored = this.findEntry(records, parsedEntryId);
      if (!stored) return null;
      const identityRecords = this.recordsForIdentity(records, stored.identity);
      const lane = this.resolveLane(stored.identity, identityRecords);
      if (!lane || lane.head.core.entryId !== parsedEntryId) return null;
      if (!this.hasFact(identityRecords, "attempt", parsedEntryId)) {
        const fact = pendingJournalStoredAttemptSchemaV1.parse({
          documentRevision: stored.entry.request.documentRevision,
          entryId: parsedEntryId,
          expectedSessionGeneration: stored.entry.request.expectedSessionGeneration,
          identity: stored.identity,
          kind: "attempt",
          scope: this.scope,
          version: EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1,
        });
        if (!this.writeRecord(fact, records, false)) return null;
        records = this.scan();
      }
      const latestLane = this.resolveLane(stored.identity, this.recordsForIdentity(records, stored.identity));
      return latestLane?.head.core.entryId === parsedEntryId ? ownedEntryV1(latestLane.head.view) : null;
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      return null;
    }
  }

  async sealExact(entryId: string): Promise<EditorSessionPendingJournalSealOutcomeV1> {
    const parsedEntryId = z.uuid().parse(entryId);
    let current: PendingJournalStoredEntryV1 | null;
    try {
      current = this.findEntry(this.scan(), parsedEntryId);
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      return { kind: "corrupt" };
    }
    if (!current) return { kind: "missing" };
    const digest = await sha256HexV1(canonicalJsonV1(current.entry.request));
    let records: readonly ParsedStoredRecordV1[];
    try {
      records = this.scan();
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      return { kind: "corrupt" };
    }
    const latest = this.findEntry(records, parsedEntryId);
    if (!latest || !sameRequestV1(latest.entry.request, current.entry.request)) return { kind: "missing" };
    const identityRecords = this.recordsForIdentity(records, latest.identity);
    const existingSeal = this.findFact(identityRecords, "seal", parsedEntryId);
    if (existingSeal && existingSeal.digest !== digest) return { kind: "corrupt" };
    if (!existingSeal) {
      const fact = pendingJournalStoredSealSchemaV1.parse({
        digest,
        documentRevision: latest.entry.request.documentRevision,
        entryId: parsedEntryId,
        expectedSessionGeneration: latest.entry.request.expectedSessionGeneration,
        identity: latest.identity,
        kind: "seal",
        scope: this.scope,
        version: EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1,
      });
      if (!this.writeRecord(fact, records, false)) return { kind: "missing" };
      records = this.scan();
    }
    const finalEntry = this.findEntry(records, parsedEntryId);
    if (!finalEntry) return { kind: "missing" };
    return {
      entry: ownedEntryV1(this.entryView(finalEntry.entry, this.recordsForIdentity(records, finalEntry.identity))),
      kind: "sealed",
    };
  }

  async acknowledgeExact(entryId: string, requestValue: EditorDocumentSessionPutRequestV1) {
    try {
      const parsedEntryId = z.uuid().parse(entryId);
      const request = editorDocumentSessionPutRequestSchemaV1.parse(requestValue);
      const requestDigest = await sha256HexV1(canonicalJsonV1(request));
      let records = this.scan();
      const existingAcknowledgement = this.findFact(records, "ack", parsedEntryId);
      if (existingAcknowledgement) {
        if (
          !this.requestMatchesAcknowledgement(request, existingAcknowledgement) ||
          existingAcknowledgement.requestDigest !== requestDigest
        )
          return false;
        this.compactRetiredEntries(existingAcknowledgement);
        try {
          this.compactPreviousAcknowledgement(existingAcknowledgement, this.scan());
        } catch {
          // The exact ACK remains authoritative even when cleanup cannot resume.
        }
        return true;
      }
      const stored = this.findEntry(records, parsedEntryId);
      if (!stored || !sameRequestV1(stored.entry.request, request)) return false;
      const identityRecords = this.recordsForIdentity(records, stored.identity);
      const seal = this.findFact(identityRecords, "seal", parsedEntryId);
      if (!seal || seal.digest !== requestDigest) return false;
      const retiredEntryIds = this.supersessionAncestry(stored.entry, identityRecords);
      if (!retiredEntryIds) return false;
      const acknowledgement = pendingJournalStoredAcknowledgementSchemaV1.parse({
        acknowledgedAt: Math.max(0, Math.floor(this.now())),
        documentRevision: request.documentRevision,
        entryId: parsedEntryId,
        epoch: request.epoch,
        expectedSessionGeneration: request.expectedSessionGeneration,
        identity: stored.identity,
        kind: "ack",
        predecessorEntryId: stored.entry.predecessorEntryId,
        requestDigest,
        retiredEntryIds,
        scope: this.scope,
        storedSessionGeneration: (BigInt(request.expectedSessionGeneration) + 1n).toString(10),
        version: EDITOR_SESSION_PENDING_JOURNAL_VERSION_V1,
        writerId: stored.entry.writerId,
      });
      if (!this.writeRecord(acknowledgement, records, false)) return false;

      // The acknowledgement is the durable promotion proof. Everything below
      // is optional compression and may stop at any crash point.
      try {
        this.compactRetiredEntries(acknowledgement);
        records = this.scan();
        this.compactPreviousAcknowledgement(acknowledgement, records);
      } catch {
        // The ACK fact is already durable; cleanup must not negate it.
      }
      return true;
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      return false;
    }
  }

  discardLaneExact(identityValue: EditorSessionPendingJournalLaneIdentityV1) {
    try {
      const identity = pendingJournalLaneIdentitySchemaV1.parse(identityValue);
      const records = this.recordsForIdentity(this.scan(), identity);
      if (records.length === 0) return false;
      let removed = true;
      for (const record of records) removed = this.removeRecord(record.storageId) && removed;
      return removed;
    } catch {
      return false;
    }
  }

  /** Explicit user-authorized recovery when malformed or excessive records prevent exact lane resolution. */
  discardAll() {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stored = this.adapter.list();
        if (stored.length === 0) return true;
        for (const value of stored) this.adapter.removeExact(value.entryId);
      }
      return this.adapter.list().length === 0;
    } catch {
      return false;
    }
  }

  private resolveLane(
    identity: EditorSessionPendingJournalLaneIdentityV1,
    records: readonly ParsedStoredRecordV1[],
  ): ResolvedLaneV1 | null {
    const entryRecords = records.filter(
      (record): record is ParsedStoredRecordV1 & { record: PendingJournalStoredEntryV1 } =>
        record.record.kind === "entry",
    );
    const entries = new Map(entryRecords.map((record) => [record.record.entry.entryId, record.record.entry]));
    const attemptFacts = new Map(
      records.flatMap((record) =>
        record.record.kind === "attempt" ? [[record.record.entryId, record.record] as const] : [],
      ),
    );
    const attempts = new Set(attemptFacts.keys());
    const seals = new Map(
      records.flatMap((record) =>
        record.record.kind === "seal" ? [[record.record.entryId, record.record] as const] : [],
      ),
    );
    const acknowledgements = new Map(
      records.flatMap((record) =>
        record.record.kind === "ack" ? [[record.record.entryId, record.record] as const] : [],
      ),
    );
    const retired = new Set(
      Array.from(acknowledgements.values()).flatMap((acknowledgement) => acknowledgement.retiredEntryIds),
    );

    for (const fact of [...attemptFacts.values(), ...seals.values()]) {
      const entry = entries.get(fact.entryId);
      if (
        entry &&
        (entry.request.documentRevision !== fact.documentRevision ||
          entry.request.expectedSessionGeneration !== fact.expectedSessionGeneration)
      ) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session lifecycle evidence does not match its payload.",
          "corrupt",
        );
      }
      // An orphan lifecycle fact contains no request payload and cannot be
      // replayed or promoted. A surviving successor is validated separately
      // against its predecessor/ACK evidence below.
    }
    for (const [entryId, acknowledgement] of acknowledgements) {
      const entry = entries.get(entryId);
      const retiredWriterId = acknowledgement.writerId;
      const seal = seals.get(entryId);
      if (seal && acknowledgement.requestDigest !== seal.digest) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session acknowledgement does not match its exact request.",
          "corrupt",
        );
      }
      if (
        entry &&
        (!this.requestMatchesAcknowledgement(entry.request, acknowledgement) ||
          entry.writerId !== acknowledgement.writerId ||
          entry.predecessorEntryId !== acknowledgement.predecessorEntryId)
      ) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session acknowledgement does not match its exact request.",
          "corrupt",
        );
      }
      for (let index = 0; index < acknowledgement.retiredEntryIds.length; index += 1) {
        const retiredEntry = entries.get(acknowledgement.retiredEntryIds[index]!);
        if (!retiredEntry) continue;
        const expectedAncestor = acknowledgement.retiredEntryIds[index + 1] ?? null;
        if (retiredEntry.writerId !== retiredWriterId || retiredEntry.supersedesEntryId !== expectedAncestor) {
          throw new EditorSessionPendingJournalReadErrorV1(
            "Pending Editor session acknowledgement has invalid retired ancestry.",
            "corrupt",
          );
        }
      }
    }

    const superseded = new Set<string>();
    const supersedingChildren = new Map<string, string[]>();
    for (const entry of entries.values()) {
      if (retired.has(entry.entryId)) continue;
      if (entry.supersedesEntryId === null) continue;
      const target = entries.get(entry.supersedesEntryId);
      if (
        !target ||
        retired.has(target.entryId) ||
        target.writerId !== entry.writerId ||
        !sameCasSlotV1(target, entry) ||
        attempts.has(target.entryId) ||
        acknowledgements.has(target.entryId)
      ) {
        throw this.ambiguous("Pending Editor session supersession raced an attempt or has missing evidence.");
      }
      const children = supersedingChildren.get(target.entryId) ?? [];
      children.push(entry.entryId);
      supersedingChildren.set(target.entryId, children);
      superseded.add(target.entryId);
    }
    if (Array.from(supersedingChildren.values()).some((children) => children.length !== 1)) {
      throw this.ambiguous("Pending Editor session evidence has competing supersessions.");
    }
    for (const entry of entries.values()) {
      const visited = new Set<string>();
      let cursor: typeof entry | undefined = entry;
      while (cursor?.supersedesEntryId) {
        if (visited.has(cursor.entryId)) throw this.ambiguous("Pending Editor session supersession is cyclic.");
        visited.add(cursor.entryId);
        cursor = entries.get(cursor.supersedesEntryId);
      }
    }

    const active = Array.from(entries.values()).filter(
      (entry) => !superseded.has(entry.entryId) && !retired.has(entry.entryId),
    );
    if (active.length === 0) return null;

    const roots: typeof active = [];
    for (const entry of active) {
      if (entry.predecessorEntryId === null) {
        roots.push(entry);
        continue;
      }
      const acknowledgement = acknowledgements.get(entry.predecessorEntryId);
      if (acknowledgement) {
        if (!this.acknowledgementPromotesEntry(acknowledgement, entry)) {
          throw this.ambiguous("Pending Editor session acknowledgement cannot promote its child.");
        }
        roots.push(entry);
        continue;
      }
      const predecessor = entries.get(entry.predecessorEntryId);
      if (!predecessor || superseded.has(predecessor.entryId) || acknowledgements.has(predecessor.entryId)) {
        throw this.ambiguous("Pending Editor session successor lacks an acknowledged predecessor.");
      }
      if (!attempts.has(predecessor.entryId) || !this.predecessorMatchesSuccessor(predecessor, entry)) {
        throw this.ambiguous("Pending Editor session successor has invalid exact-CAS evidence.");
      }
    }
    if (roots.length !== 1) throw this.ambiguous("Pending Editor session evidence has multiple or missing heads.");
    const headCore = roots[0]!;
    const successors = active.filter((entry) => entry.predecessorEntryId === headCore.entryId);
    if (successors.length > 1 || active.length !== 1 + successors.length) {
      throw this.ambiguous("Pending Editor session evidence has an ambiguous successor graph.");
    }
    const head = this.entryView(headCore, records, true);
    const successorCore = successors[0] ?? null;
    const successor = successorCore ? this.entryView(successorCore, records) : null;
    const lane = pendingJournalLaneSchemaV1.safeParse({ head, identity, successor });
    if (!lane.success) {
      throw new EditorSessionPendingJournalReadErrorV1(
        "Pending Editor session evidence violates its exact CAS lane contract.",
        "corrupt",
      );
    }
    return {
      head: { core: headCore, view: lane.data.head },
      successor: successorCore && lane.data.successor ? { core: successorCore, view: lane.data.successor } : null,
    };
  }

  private acknowledgementPromotesEntry(
    acknowledgement: PendingJournalStoredAcknowledgementV1,
    entry: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
  ) {
    return (
      entry.request.epoch === acknowledgement.epoch &&
      entry.request.documentRevision === acknowledgement.documentRevision &&
      entry.request.expectedSessionGeneration === acknowledgement.storedSessionGeneration
    );
  }

  private requestMatchesAcknowledgement(
    request: EditorDocumentSessionPutRequestV1,
    acknowledgement: PendingJournalStoredAcknowledgementV1,
  ) {
    return (
      request.epoch === acknowledgement.epoch &&
      request.documentRevision === acknowledgement.documentRevision &&
      request.expectedSessionGeneration === acknowledgement.expectedSessionGeneration
    );
  }

  private predecessorMatchesSuccessor(
    predecessor: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
    successor: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
  ) {
    return (
      successor.request.epoch === predecessor.request.epoch &&
      successor.request.documentRevision === predecessor.request.documentRevision &&
      BigInt(successor.request.expectedSessionGeneration) === BigInt(predecessor.request.expectedSessionGeneration) + 1n
    );
  }

  private entryView(
    entry: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
    records: readonly ParsedStoredRecordV1[],
    normalizePredecessor = false,
  ) {
    const seal = this.findFact(records, "seal", entry.entryId);
    return pendingJournalEntrySchemaV1.parse({
      ...entry,
      integrity: seal ? { digest: seal.digest, kind: "sha256" } : { kind: "unsealed" },
      predecessorEntryId: normalizePredecessor ? null : entry.predecessorEntryId,
      state: this.hasFact(records, "attempt", entry.entryId) ? "attempted" : "prepared",
    });
  }

  private recordsForIdentity(
    records: readonly ParsedStoredRecordV1[],
    identity: EditorSessionPendingJournalLaneIdentityV1,
  ) {
    const key = laneIdentityKeyV1(identity);
    return records.filter((record) => laneIdentityKeyV1(record.record.identity) === key);
  }

  private findEntry(records: readonly ParsedStoredRecordV1[], entryId: string) {
    const match = records.find(
      (record): record is ParsedStoredRecordV1 & { record: PendingJournalStoredEntryV1 } =>
        record.record.kind === "entry" && record.record.entry.entryId === entryId,
    );
    return match?.record ?? null;
  }

  private findFact<K extends "ack" | "attempt" | "seal">(
    records: readonly ParsedStoredRecordV1[],
    kind: K,
    entryId: string,
  ): Extract<PendingJournalStoredRecordV1, { kind: K }> | null {
    const match = records.find((record) => record.record.kind === kind && record.record.entryId === entryId);
    return (match?.record as Extract<PendingJournalStoredRecordV1, { kind: K }> | undefined) ?? null;
  }

  private hasFact(records: readonly ParsedStoredRecordV1[], kind: "ack" | "attempt" | "seal", entryId: string) {
    return this.findFact(records, kind, entryId) !== null;
  }

  private scan(): readonly ParsedStoredRecordV1[] {
    let stored: readonly EditorSessionPendingJournalStoredValueV1[];
    try {
      stored = this.adapter.list();
    } catch {
      throw new EditorSessionPendingJournalReadErrorV1("Pending Editor session storage is unavailable.", "storage");
    }
    if (stored.length > MAX_EDITOR_SESSION_PENDING_JOURNAL_RECORDS_HARD_V1) {
      throw new EditorSessionPendingJournalReadErrorV1(
        "Pending Editor session storage exceeds its absolute recovery budget.",
        "capacity",
      );
    }
    const seen = new Set<string>();
    const records: ParsedStoredRecordV1[] = [];
    let totalBytes = 0;
    for (const value of stored) {
      totalBytes += serializedBytesV1(value.serialized);
      if (totalBytes > MAX_EDITOR_SESSION_PENDING_JOURNAL_BYTES_HARD_V1) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session storage exceeds its absolute recovery budget.",
          "capacity",
        );
      }
      const parsed = pendingJournalStoredRecordSchemaV1.safeParse(
        (() => {
          try {
            return JSON.parse(value.serialized) as unknown;
          } catch {
            return null;
          }
        })(),
      );
      if (
        !parsed.success ||
        storageIdForRecordV1(parsed.data) !== value.entryId ||
        !sameScopeV1(parsed.data.scope, this.scope) ||
        seen.has(value.entryId)
      ) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session storage contains malformed or foreign evidence.",
          "corrupt",
        );
      }
      seen.add(value.entryId);
      records.push({ record: parsed.data, serialized: value.serialized, storageId: value.entryId });
    }
    return records;
  }

  private writeRecord(
    record: PendingJournalStoredRecordV1,
    records: readonly ParsedStoredRecordV1[],
    enforcePayloadAdmission: boolean,
  ) {
    const storageId = storageIdForRecordV1(record);
    const serialized = JSON.stringify(record);
    const existing = records.find((candidate) => candidate.storageId === storageId);
    if (existing && existing.serialized !== serialized) {
      throw new EditorSessionPendingJournalReadErrorV1(
        "Pending Editor session storage contains conflicting immutable evidence.",
        "corrupt",
      );
    }
    if (
      !existing &&
      (records.length >= MAX_EDITOR_SESSION_PENDING_JOURNAL_RECORDS_HARD_V1 ||
        records.reduce((sum, candidate) => sum + serializedBytesV1(candidate.serialized), 0) +
          serializedBytesV1(serialized) >
          MAX_EDITOR_SESSION_PENDING_JOURNAL_BYTES_HARD_V1)
    ) {
      throw new EditorSessionPendingJournalReadErrorV1(
        "Pending Editor session storage exceeds its absolute recovery budget.",
        "capacity",
      );
    }
    if (enforcePayloadAdmission && record.kind === "entry" && !existing) {
      const entryRecords = records.filter((candidate) => candidate.record.kind === "entry");
      const laneRecords = records.filter(
        (candidate) => candidate.record.kind === "entry" || candidate.record.kind === "ack",
      );
      const laneCount = new Set(laneRecords.map((candidate) => laneIdentityKeyV1(candidate.record.identity))).size;
      const identityAlreadyPresent = laneRecords.some(
        (candidate) => laneIdentityKeyV1(candidate.record.identity) === laneIdentityKeyV1(record.identity),
      );
      const currentBytes = records.reduce((sum, candidate) => sum + serializedBytesV1(candidate.serialized), 0);
      if (
        entryRecords.length >= MAX_EDITOR_SESSION_PENDING_JOURNAL_ENTRIES_V1 ||
        (!identityAlreadyPresent && laneCount >= MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1) ||
        currentBytes + serializedBytesV1(serialized) > MAX_EDITOR_SESSION_PENDING_JOURNAL_BYTES_V1
      ) {
        throw new EditorSessionPendingJournalReadErrorV1(
          "Pending Editor session storage has reached its retention budget.",
          "capacity",
        );
      }
    }
    try {
      this.adapter.writeExact(storageId, serialized);
      return true;
    } catch (error) {
      if (error instanceof EditorSessionPendingJournalReadErrorV1) throw error;
      throw new EditorSessionPendingJournalReadErrorV1("Pending Editor session storage is unavailable.", "storage");
    }
  }

  private compactAcknowledgementLanesForAdmission(
    initialRecords: readonly ParsedStoredRecordV1[],
    identity: EditorSessionPendingJournalLaneIdentityV1,
  ) {
    let records = initialRecords;
    const requestedKey = laneIdentityKeyV1(identity);
    while (true) {
      const laneRecords = records.filter((record) => record.record.kind === "entry" || record.record.kind === "ack");
      const laneKeys = new Set(laneRecords.map((record) => laneIdentityKeyV1(record.record.identity)));
      if (laneKeys.has(requestedKey) || laneKeys.size < MAX_EDITOR_SESSION_PENDING_JOURNAL_LANES_V1) return records;

      const entryLaneKeys = new Set(
        records.flatMap((record) =>
          record.record.kind === "entry" ? [laneIdentityKeyV1(record.record.identity)] : [],
        ),
      );
      const acknowledgementsByLane = new Map<string, PendingJournalStoredAcknowledgementV1[]>();
      for (const record of records) {
        if (record.record.kind !== "ack") continue;
        const key = laneIdentityKeyV1(record.record.identity);
        const acknowledgements = acknowledgementsByLane.get(key) ?? [];
        acknowledgements.push(record.record);
        acknowledgementsByLane.set(key, acknowledgements);
      }
      const candidate = Array.from(acknowledgementsByLane)
        .filter(([key, acknowledgements]) => !entryLaneKeys.has(key) && acknowledgements.length === 1)
        .map(([, acknowledgements]) => acknowledgements[0]!)
        .sort(
          (left, right) => left.acknowledgedAt - right.acknowledgedAt || left.entryId.localeCompare(right.entryId),
        )[0];
      if (!candidate || !this.compactRetiredEntries(candidate)) return records;

      let cleanupComplete = true;
      for (const record of records) {
        if (
          (record.record.kind !== "attempt" && record.record.kind !== "seal") ||
          laneIdentityKeyV1(record.record.identity) !== laneIdentityKeyV1(candidate.identity) ||
          record.record.documentRevision !== candidate.documentRevision ||
          BigInt(record.record.expectedSessionGeneration) >= BigInt(candidate.storedSessionGeneration)
        ) {
          continue;
        }
        cleanupComplete = this.removeRecord(record.storageId) && cleanupComplete;
      }
      if (!cleanupComplete) return records;
      const refreshed = this.scan();
      if (
        refreshed.some(
          (record) =>
            record.record.kind !== "ack" &&
            laneIdentityKeyV1(record.record.identity) === laneIdentityKeyV1(candidate.identity),
        )
      ) {
        return refreshed;
      }
      if (!this.removeRecord(`ack.${candidate.entryId}`)) return refreshed;
      records = this.scan();
    }
  }

  private supersessionAncestry(
    entry: z.infer<typeof pendingJournalEntryCoreSchemaV1>,
    records: readonly ParsedStoredRecordV1[],
  ) {
    const entries = new Map(
      records.flatMap((record) =>
        record.record.kind === "entry" ? [[record.record.entry.entryId, record.record.entry] as const] : [],
      ),
    );
    const ancestry = [entry.entryId];
    let child = entry;
    let ancestorId = entry.supersedesEntryId;
    while (ancestorId) {
      const ancestor = entries.get(ancestorId);
      if (
        !ancestor ||
        ancestor.writerId !== entry.writerId ||
        !sameCasSlotV1(ancestor, child) ||
        ancestry.includes(ancestorId)
      )
        return null;
      ancestry.push(ancestorId);
      child = ancestor;
      ancestorId = ancestor.supersedesEntryId;
    }
    return ancestry;
  }

  private compactRetiredEntries(acknowledgement: PendingJournalStoredAcknowledgementV1) {
    for (const retiredEntryId of acknowledgement.retiredEntryIds) {
      // Keep the payload until its lifecycle facts are gone. A surviving
      // payload remains self-describing if cleanup is interrupted.
      if (!this.removeRecord(`attempt.${retiredEntryId}`)) return false;
      if (!this.removeRecord(`seal.${retiredEntryId}`)) return false;
      if (!this.removeRecord(retiredEntryId)) return false;
    }
    return true;
  }

  private compactPreviousAcknowledgement(
    acknowledgement: PendingJournalStoredAcknowledgementV1,
    records: readonly ParsedStoredRecordV1[],
  ) {
    const predecessorId = acknowledgement.predecessorEntryId;
    if (!predecessorId) return;
    const previousAcknowledgement = this.findFact(records, "ack", predecessorId);
    if (!previousAcknowledgement || !this.compactRetiredEntries(previousAcknowledgement)) return;
    const refreshed = this.scan();
    const previousEvidenceRemains = refreshed.some((record) => {
      if (record.record.kind === "ack") return false;
      const entryId = record.record.kind === "entry" ? record.record.entry.entryId : record.record.entryId;
      return previousAcknowledgement.retiredEntryIds.includes(entryId);
    });
    if (previousEvidenceRemains) return;
    const hasOtherChild = refreshed.some(
      (record) =>
        record.record.kind === "entry" &&
        !acknowledgement.retiredEntryIds.includes(record.record.entry.entryId) &&
        record.record.entry.predecessorEntryId === predecessorId,
    );
    if (!hasOtherChild) this.removeRecord(`ack.${predecessorId}`);
  }

  private removeRecord(storageId: string) {
    try {
      this.adapter.removeExact(storageId);
      return true;
    } catch {
      return false;
    }
  }

  private ambiguous(message: string) {
    return new EditorSessionPendingJournalReadErrorV1(message, "ambiguous");
  }
}
