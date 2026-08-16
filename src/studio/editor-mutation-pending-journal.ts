import { z } from "zod";

import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import {
  type EditorDocumentCommitRequestV1,
  type EditorDocumentCommitResultViewV1,
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
  editorDocumentKeySchemaV1,
} from "../collaboration/editor-document-http-contract";
import { canonicalEditorSessionSnapshotJsonV1 } from "../collaboration/editor-session-contract";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { sha256V1Schema } from "../engine/primitives";
import { manimProjectIdSchema, manimSourcePathSchema } from "../render-pipeline/manim-identity-contract";
import { type EditorSessionAccountScope, editorSessionStorageKey } from "./editor-session-store";

export const EDITOR_MUTATION_PENDING_JOURNAL_VERSION_V1 = 1 as const;
export const MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1 = 20;
export const MAX_EDITOR_MUTATION_PENDING_JOURNAL_BYTES_V1 = 2 * 1024 * 1024;

const mutationJournalScopeSchemaV1 = z
  .object({ organizationId: accountOrganizationIdSchemaV1, userId: z.uuid() })
  .strict();

// A Studio-native document has no source binding; both fields are null for
// that lane. Historical imported entries keep parsing unchanged.
const mutationJournalIdentitySchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: z.uuid(),
    projectId: manimProjectIdSchema,
    sourceHash: sha256V1Schema.nullable(),
    sourcePath: manimSourcePathSchema.nullable(),
  })
  .strict();

const mutationJournalLookupSchemaV1 = mutationJournalIdentitySchemaV1.omit({ epoch: true });

const mutationJournalEntrySchemaV1 = z
  .object({
    identity: mutationJournalIdentitySchemaV1,
    kind: z.literal("pending-editor-mutation"),
    request: editorDocumentCommitRequestSchemaV1,
    requestByteSize: z.number().int().positive(),
    savedAt: z.number().int().nonnegative(),
    scope: mutationJournalScopeSchemaV1,
    version: z.literal(EDITOR_MUTATION_PENDING_JOURNAL_VERSION_V1),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.request.epoch !== entry.identity.epoch) {
      context.addIssue({ code: "custom", message: "A pending Editor mutation has a foreign epoch." });
    }
    if (serializedBytesV1(canonicalJsonV1(entry.request)) !== entry.requestByteSize) {
      context.addIssue({ code: "custom", message: "Pending Editor mutation byte evidence is inconsistent." });
    }
  });

export type EditorMutationPendingJournalIdentityV1 = z.infer<typeof mutationJournalIdentitySchemaV1>;
export type EditorMutationPendingJournalLookupV1 = z.infer<typeof mutationJournalLookupSchemaV1>;
export type EditorMutationPendingJournalEntryV1 = z.infer<typeof mutationJournalEntrySchemaV1>;

export type EditorMutationPendingJournalStoredValueV1 = Readonly<{
  entryId: string;
  serialized: string;
}>;

export interface EditorMutationPendingJournalStorageAdapterV1 {
  list(): readonly EditorMutationPendingJournalStoredValueV1[];
  removeExact(entryId: string): void;
  writeExact(entryId: string, serialized: string): void;
}

export class EditorMutationPendingJournalErrorV1 extends Error {
  constructor(
    message: string,
    readonly code: "ambiguous" | "capacity" | "corrupt" | "mismatch" | "storage",
  ) {
    super(message);
    this.name = "EditorMutationPendingJournalErrorV1";
  }
}

function serializedBytesV1(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function sameIdentityV1(left: EditorMutationPendingJournalIdentityV1, right: EditorMutationPendingJournalIdentityV1) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function matchesLookupV1(entry: EditorMutationPendingJournalEntryV1, lookup: EditorMutationPendingJournalLookupV1) {
  return (
    entry.identity.documentKey === lookup.documentKey &&
    entry.identity.projectId === lookup.projectId &&
    entry.identity.sourceHash === lookup.sourceHash &&
    entry.identity.sourcePath === lookup.sourcePath
  );
}

function sameEntryV1(left: EditorMutationPendingJournalEntryV1, right: EditorMutationPendingJournalEntryV1) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

export function editorMutationPendingJournalStoragePrefixV1(scope: EditorSessionAccountScope) {
  return `${editorSessionStorageKey(scope)}.pending-mutations-v1.`;
}

export class WebStorageEditorMutationPendingJournalAdapterV1 implements EditorMutationPendingJournalStorageAdapterV1 {
  private readonly prefix: string;

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "key" | "length" | "removeItem" | "setItem">,
    scope: EditorSessionAccountScope,
  ) {
    this.prefix = editorMutationPendingJournalStoragePrefixV1(scope);
  }

  list() {
    const values: EditorMutationPendingJournalStoredValueV1[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      const serialized = this.storage.getItem(key);
      if (serialized !== null) values.push({ entryId: key.slice(this.prefix.length), serialized });
    }
    return values.sort((left, right) => left.entryId.localeCompare(right.entryId));
  }

  removeExact(entryId: string) {
    this.storage.removeItem(`${this.prefix}${entryId}`);
  }

  writeExact(entryId: string, serialized: string) {
    const parsedEntryId = z.uuid().parse(entryId);
    const key = `${this.prefix}${parsedEntryId}`;
    const existing = this.storage.getItem(key);
    if (existing !== null && existing !== serialized) {
      throw new Error("Pending Editor mutation storage contains a reused mutation ID.");
    }
    this.storage.setItem(key, serialized);
    if (this.storage.getItem(key) !== serialized) {
      throw new Error("Pending Editor mutation storage did not retain the exact request.");
    }
  }
}

export class EditorMutationPendingJournalV1 {
  private readonly scope: z.infer<typeof mutationJournalScopeSchemaV1>;

  constructor(
    private readonly adapter: EditorMutationPendingJournalStorageAdapterV1,
    scopeValue: EditorSessionAccountScope,
    private readonly now: () => number = Date.now,
  ) {
    this.scope = mutationJournalScopeSchemaV1.parse(scopeValue);
  }

  record(identityValue: EditorMutationPendingJournalIdentityV1, requestValue: EditorDocumentCommitRequestV1) {
    const identity = mutationJournalIdentitySchemaV1.parse(identityValue);
    const request = editorDocumentCommitRequestSchemaV1.parse(requestValue);
    if (request.epoch !== identity.epoch) {
      throw new EditorMutationPendingJournalErrorV1(
        "The pending Editor mutation does not match its document epoch.",
        "mismatch",
      );
    }
    const records = this.scan();
    const lookup = mutationJournalLookupSchemaV1.parse({
      documentKey: identity.documentKey,
      projectId: identity.projectId,
      sourceHash: identity.sourceHash,
      sourcePath: identity.sourcePath,
    });
    const lane = records.filter((entry) => matchesLookupV1(entry, lookup));
    const sameId = records.find((entry) => entry.request.clientMutationId === request.clientMutationId);
    if (sameId) {
      const exactRequest =
        sameIdentityV1(sameId.identity, identity) && canonicalJsonV1(sameId.request) === canonicalJsonV1(request);
      if (lane.length === 1 && exactRequest) {
        return sameId;
      }
      if (!exactRequest) {
        throw new EditorMutationPendingJournalErrorV1(
          "A pending Editor mutation ID has conflicting immutable evidence.",
          "corrupt",
        );
      }
      throw this.ambiguous("A pending Editor mutation ID has conflicting immutable evidence.");
    }
    if (lane.length > 0) {
      throw this.ambiguous("Another exact Editor mutation is already pending for this Scene.");
    }
    const entry = mutationJournalEntrySchemaV1.parse({
      identity,
      kind: "pending-editor-mutation",
      request,
      requestByteSize: serializedBytesV1(canonicalJsonV1(request)),
      savedAt: Math.max(0, Math.floor(this.now())),
      scope: this.scope,
      version: EDITOR_MUTATION_PENDING_JOURNAL_VERSION_V1,
    });
    const serialized = JSON.stringify(entry);
    if (
      records.length >= MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1 ||
      records.reduce((sum, candidate) => sum + serializedBytesV1(JSON.stringify(candidate)), 0) +
        serializedBytesV1(serialized) >
        MAX_EDITOR_MUTATION_PENDING_JOURNAL_BYTES_V1
    ) {
      throw new EditorMutationPendingJournalErrorV1(
        "Pending Editor mutation storage has reached its retention budget.",
        "capacity",
      );
    }
    try {
      this.adapter.writeExact(request.clientMutationId, serialized);
    } catch {
      throw new EditorMutationPendingJournalErrorV1("Pending Editor mutation storage is unavailable.", "storage");
    }
    const written = this.scan().filter((candidate) => matchesLookupV1(candidate, lookup));
    if (written.length !== 1 || !sameEntryV1(written[0]!, entry)) {
      throw this.ambiguous("Pending Editor mutation storage raced another writer.");
    }
    return written[0]!;
  }

  readExact(lookupValue: EditorMutationPendingJournalLookupV1) {
    const lookup = mutationJournalLookupSchemaV1.parse({
      documentKey: lookupValue.documentKey,
      projectId: lookupValue.projectId,
      sourceHash: lookupValue.sourceHash,
      sourcePath: lookupValue.sourcePath,
    });
    const matches = this.scan().filter((entry) => matchesLookupV1(entry, lookup));
    if (matches.length > 1) throw this.ambiguous("Multiple exact Editor mutations are pending for this Scene.");
    return matches[0] ?? null;
  }

  acknowledgeExact(entryValue: EditorMutationPendingJournalEntryV1) {
    const entry = mutationJournalEntrySchemaV1.parse(entryValue);
    const stored = this.scan().find(
      (candidate) => candidate.request.clientMutationId === entry.request.clientMutationId,
    );
    // A second tab may have already acknowledged or explicitly cleared this
    // exact request after this caller verified the committed response.
    if (!stored) return true;
    if (!sameEntryV1(stored, entry)) return false;
    try {
      this.adapter.removeExact(entry.request.clientMutationId);
    } catch {
      throw new EditorMutationPendingJournalErrorV1("Pending Editor mutation storage is unavailable.", "storage");
    }
    return !this.scan().some((candidate) => candidate.request.clientMutationId === entry.request.clientMutationId);
  }

  /** Explicit user-authorized removal after an unresolved cloud conflict. */
  discardExact(lookupValue: EditorMutationPendingJournalLookupV1) {
    try {
      const lookup = mutationJournalLookupSchemaV1.parse({
        documentKey: lookupValue.documentKey,
        projectId: lookupValue.projectId,
        sourceHash: lookupValue.sourceHash,
        sourcePath: lookupValue.sourcePath,
      });
      const matches = this.scan().filter((entry) => matchesLookupV1(entry, lookup));
      if (matches.length === 0) return true;
      for (const entry of matches) this.adapter.removeExact(entry.request.clientMutationId);
      return !this.scan().some((entry) => matchesLookupV1(entry, lookup));
    } catch {
      return false;
    }
  }

  discardAll() {
    try {
      for (const entry of this.adapter.list()) this.adapter.removeExact(entry.entryId);
      return this.adapter.list().length === 0;
    } catch {
      return false;
    }
  }

  private scan() {
    let stored: readonly EditorMutationPendingJournalStoredValueV1[];
    try {
      stored = this.adapter.list();
    } catch {
      throw new EditorMutationPendingJournalErrorV1("Pending Editor mutation storage is unavailable.", "storage");
    }
    if (stored.length > MAX_EDITOR_MUTATION_PENDING_JOURNAL_ENTRIES_V1) {
      throw new EditorMutationPendingJournalErrorV1(
        "Pending Editor mutation storage exceeds its retention budget.",
        "capacity",
      );
    }
    let totalBytes = 0;
    const ids = new Set<string>();
    const entries: EditorMutationPendingJournalEntryV1[] = [];
    for (const value of stored) {
      totalBytes += serializedBytesV1(value.serialized);
      if (totalBytes > MAX_EDITOR_MUTATION_PENDING_JOURNAL_BYTES_V1) {
        throw new EditorMutationPendingJournalErrorV1(
          "Pending Editor mutation storage exceeds its retention budget.",
          "capacity",
        );
      }
      let valueJson: unknown;
      try {
        valueJson = JSON.parse(value.serialized);
      } catch {
        valueJson = null;
      }
      const parsed = mutationJournalEntrySchemaV1.safeParse(valueJson);
      if (
        !parsed.success ||
        parsed.data.request.clientMutationId !== value.entryId ||
        canonicalJsonV1(parsed.data.scope) !== canonicalJsonV1(this.scope) ||
        ids.has(value.entryId)
      ) {
        throw new EditorMutationPendingJournalErrorV1(
          "Pending Editor mutation storage contains malformed or foreign evidence.",
          "corrupt",
        );
      }
      ids.add(value.entryId);
      entries.push(parsed.data);
    }
    return entries;
  }

  private ambiguous(message: string) {
    return new EditorMutationPendingJournalErrorV1(message, "ambiguous");
  }
}

export function browserEditorMutationPendingJournalV1(scope: EditorSessionAccountScope) {
  if (typeof window === "undefined") return null;
  try {
    const adapter = new WebStorageEditorMutationPendingJournalAdapterV1(window.localStorage, scope);
    adapter.list();
    return new EditorMutationPendingJournalV1(adapter, scope);
  } catch {
    return null;
  }
}

async function sha256HexV1(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verifies that a retained request, and no neighboring request, was accepted. */
export async function assertEditorMutationCommitAcknowledgementV1(
  entryValue: EditorMutationPendingJournalEntryV1,
  resultValue: EditorDocumentCommitResultViewV1,
) {
  const entry = mutationJournalEntrySchemaV1.parse(entryValue);
  const result = editorDocumentCommitResultViewSchemaV1.parse(resultValue);
  if (result.kind !== "committed") {
    throw new EditorMutationPendingJournalErrorV1(
      `The pending Editor mutation conflicts with cloud state (${result.reason}).`,
      "mismatch",
    );
  }
  const { identity, request, scope } = entry;
  if (
    result.document.tenantId !== scope.organizationId ||
    result.document.projectId !== identity.projectId ||
    result.document.documentKey !== identity.documentKey ||
    result.document.epoch !== identity.epoch ||
    result.document.sourceHash !== identity.sourceHash ||
    result.document.sourcePath !== identity.sourcePath ||
    result.document.sealedAt !== null ||
    result.event.tenantId !== scope.organizationId ||
    result.event.projectId !== identity.projectId ||
    result.event.documentKey !== identity.documentKey ||
    result.event.epoch !== identity.epoch ||
    result.event.subjectId !== scope.userId ||
    result.event.clientMutationId !== request.clientMutationId ||
    result.event.baseRevision !== request.baseRevision ||
    BigInt(result.event.revision) !== BigInt(request.baseRevision) + 1n ||
    BigInt(result.document.revision) < BigInt(result.event.revision) ||
    canonicalJsonV1(result.event.mutation) !== canonicalJsonV1(request.mutation)
  ) {
    throw new EditorMutationPendingJournalErrorV1(
      "The Editor service acknowledged a different pending mutation.",
      "mismatch",
    );
  }
  const update = request.sessionUpdate;
  const evidence = result.sessionUpdate;
  if ((update === undefined) !== (evidence === undefined)) {
    throw new EditorMutationPendingJournalErrorV1(
      "The Editor service returned inconsistent pending session evidence.",
      "mismatch",
    );
  }
  if (update && evidence) {
    const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(update.snapshot);
    if (
      evidence.documentRevision !== update.documentRevision ||
      BigInt(evidence.sessionGeneration) !== BigInt(update.expectedSessionGeneration) + 1n ||
      evidence.snapshotVersion !== update.snapshotVersion ||
      evidence.snapshotByteSize !== serializedBytesV1(canonicalSnapshot) ||
      evidence.snapshotDigest !== (await sha256HexV1(canonicalSnapshot))
    ) {
      throw new EditorMutationPendingJournalErrorV1(
        "The Editor service returned invalid pending session evidence.",
        "mismatch",
      );
    }
  }
  return result;
}
