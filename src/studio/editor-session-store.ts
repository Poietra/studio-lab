import { z } from "zod";

import { editProgramSuggestionSchema, editSuggestionLeafOperationSchema } from "../ai/edit-suggestion-schema";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { ProgramRecord } from "./model";
import { canonicalOperationSchema, programExecutionCapabilities } from "./operation-registry";
import type { InteractionMode } from "./studio-viewport";
import type { StudioTool } from "./studio-toolbar";

export const EDITOR_SESSION_STORAGE_KEY = "poietra.studio.editor-sessions";
export const EDITOR_SESSION_STORAGE_VERSION = 1 as const;
export const EDITOR_SESSION_STALE_SOURCE_MESSAGE =
  "The previous editor session was not restored because this Scene's Python source changed.";

export const MAX_STORED_EDITOR_SESSIONS = 20;
export const MAX_STORED_EDITOR_SESSION_BYTES = 384 * 1024;
export const MAX_EDITOR_SESSION_STORAGE_BYTES = 2 * 1024 * 1024;

export type AppliedProgramMetadata = Readonly<{
  operation: EditSuggestionOperation | null;
  selection: readonly string[];
}>;

export type EditorProgramRecord = ProgramRecord &
  Readonly<{
    editorMetadata?: AppliedProgramMetadata;
  }>;

export type AppliedProgramMutation =
  | Readonly<{
      index: number;
      kind: "append";
      value: EditorProgramRecord;
    }>
  | Readonly<{
      index: number;
      kind: "replace";
      previous: EditorProgramRecord;
      value: EditorProgramRecord;
    }>;

export type AppliedProgramEdit = Readonly<{
  index: number;
  original: EditorProgramRecord;
}>;

export type RedoProgramEntry =
  | Readonly<{
      edit: AppliedProgramEdit | null;
      kind: "draft";
      value: EditorProgramRecord;
    }>
  | Readonly<{
      kind: "mutation";
      mutation: AppliedProgramMutation;
    }>;

export type EditorSessionSnapshot = Readonly<{
  appliedPrograms: readonly EditorProgramRecord[];
  currentTime: number;
  draftError: string | null;
  draftOperation: EditSuggestionOperation | null;
  draftProgram: ProgramRecord | null;
  editingAppliedProgram: AppliedProgramEdit | null;
  insertTool: StudioTool;
  insertValue: string;
  instruction: string;
  interactionMode: InteractionMode;
  motionDuration: number;
  programUndoEntries: readonly AppliedProgramMutation[];
  redoPrograms: readonly RedoProgramEntry[];
  selectedObjectIds: readonly string[];
}>;

export type EditorSessionIdentity = Readonly<{
  projectId: string;
  sceneId: string;
  sourceHash: string;
}>;

export type EditorSessionRestoreResult =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "restored"; snapshot: EditorSessionSnapshot }>
  | Readonly<{ kind: "stale-source" }>;

export interface EditorSessionStorageAdapter {
  clear(): void;
  read(): string | null;
  write(serialized: string): void;
}

export class WebStorageEditorSessionAdapter implements EditorSessionStorageAdapter {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
    private readonly storageKey = EDITOR_SESSION_STORAGE_KEY,
  ) {}

  clear() {
    this.storage.removeItem(this.storageKey);
  }

  read() {
    return this.storage.getItem(this.storageKey);
  }

  write(serialized: string) {
    this.storage.setItem(this.storageKey, serialized);
  }
}

export function browserEditorSessionStorageAdapter(): EditorSessionStorageAdapter | null {
  if (typeof window === "undefined") return null;
  try {
    return new WebStorageEditorSessionAdapter(window.localStorage);
  } catch {
    return null;
  }
}

const finiteNumber = z.number().finite();
const boundedId = z.string().min(1).max(512);
const boundedText = z.string().max(2_000);
const evidenceSchema = z.array(z.string().max(500)).max(64);
const timeAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), seconds: finiteNumber }).strict(),
  z.object({ kind: z.literal("playhead"), referenceSeconds: finiteNumber }).strict(),
  z
    .object({
      kind: z.literal("playhead-offset"),
      offsetSeconds: finiteNumber,
      referenceSeconds: finiteNumber,
    })
    .strict(),
  z
    .object({
      boundary: z.enum(["play-end", "play-start", "scene-end", "scene-start"]),
      eventId: boundedId,
      kind: z.literal("structural"),
      offsetSeconds: finiteNumber.optional(),
    })
    .strict(),
]);
const programSchema = z
  .object({
    anchor: z
      .object({
        capturedPlayhead: finiteNumber,
        evidence: evidenceSchema,
        resolvedSeconds: finiteNumber.nonnegative(),
        source: timeAnchorSchema,
      })
      .strict(),
    intentCount: z.number().int().min(0).max(16),
    loweringStatus: z.enum(["illustrative", "supported", "unsupported"]),
    operations: z.array(canonicalOperationSchema).max(64),
    provenance: z
      .object({
        evidence: evidenceSchema,
        origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
      })
      .strict(),
    requestedExecution: z.enum(["parallel", "sequence"]),
    schedule: z
      .object({
        edges: z
          .array(
            z
              .object({
                from: boundedId,
                reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
                to: boundedId,
              })
              .strict(),
          )
          .max(256),
        mode: z.enum(["dependency-dag", "parallel", "sequence"]),
        order: z.array(boundedId).max(64),
      })
      .strict(),
    transactionId: z.string().min(1).max(160),
    version: z.literal(1),
  })
  .strict();
const validationIssueSchema = z
  .object({
    code: z.enum([
      "anchor-invalid",
      "cycle",
      "identity-unknown",
      "interval-invalid",
      "lifetime-unknown",
      "lowering-unsupported",
      "operation-count",
      "parallel-conflict",
      "provisional-id-invalid",
      "schema-invalid",
      "target-missing",
    ]),
    field: z.string().max(256),
    message: z.string().max(2_000),
    operationId: boundedId.optional(),
    severity: z.enum(["error", "warning"]),
  })
  .strict();
const programRecordSchema = z
  .object({
    program: programSchema,
    validation: z
      .object({
        issues: z.array(validationIssueSchema).max(256),
        status: z.enum(["invalid", "valid"]),
      })
      .strict(),
  })
  .strict();
const editSuggestionOperationSchema = z.union([editSuggestionLeafOperationSchema, editProgramSuggestionSchema]);
const selectionSchema = z.array(boundedId).max(256);
const appliedProgramMetadataSchema = z
  .object({
    operation: editSuggestionOperationSchema.nullable(),
    selection: selectionSchema,
  })
  .strict();
const editorProgramRecordSchema = programRecordSchema
  .safeExtend({
    editorMetadata: appliedProgramMetadataSchema.optional(),
  })
  .strict();
const mutationIndexSchema = z.number().int().min(0).max(31);
const appliedProgramMutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      index: mutationIndexSchema,
      kind: z.literal("append"),
      value: editorProgramRecordSchema,
    })
    .strict(),
  z
    .object({
      index: mutationIndexSchema,
      kind: z.literal("replace"),
      previous: editorProgramRecordSchema,
      value: editorProgramRecordSchema,
    })
    .strict(),
]);
const appliedProgramEditSchema = z
  .object({
    index: mutationIndexSchema,
    original: editorProgramRecordSchema,
  })
  .strict();
const redoProgramEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      edit: appliedProgramEditSchema.nullable(),
      kind: z.literal("draft"),
      value: editorProgramRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("mutation"),
      mutation: appliedProgramMutationSchema,
    })
    .strict(),
]);
const durableEditorSessionSnapshotSchema = z
  .object({
    appliedPrograms: z.array(editorProgramRecordSchema).max(32),
    currentTime: finiteNumber.nonnegative().max(86_400),
    draftOperation: editSuggestionOperationSchema.nullable(),
    draftProgram: editorProgramRecordSchema.nullable(),
    editingAppliedProgram: appliedProgramEditSchema.nullable(),
    insertTool: z.enum(["select", "Text", "MathTex", "Rectangle", "Circle", "Line", "Arrow"]),
    interactionMode: z.enum(["animate", "position"]),
    motionDuration: finiteNumber.min(0.1).max(600),
    programUndoEntries: z.array(appliedProgramMutationSchema).max(32),
    redoPrograms: z.array(redoProgramEntrySchema).max(32),
    selectedObjectIds: selectionSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.draftOperation && !snapshot.draftProgram) {
      context.addIssue({
        code: "custom",
        message: "A persisted draft operation requires a persisted draft program.",
        path: ["draftOperation"],
      });
    }
    if (snapshot.editingAppliedProgram && !snapshot.draftProgram) {
      context.addIssue({
        code: "custom",
        message: "A persisted Applied Program edit requires a persisted draft program.",
        path: ["editingAppliedProgram"],
      });
    }
    const transactionIds = new Set<string>();
    snapshot.appliedPrograms.forEach((record, index) => {
      const transactionId = record.program.transactionId;
      if (transactionIds.has(transactionId)) {
        context.addIssue({
          code: "custom",
          message: "Applied Program transaction identities must be unique.",
          path: ["appliedPrograms", index, "program", "transactionId"],
        });
      }
      transactionIds.add(transactionId);
      if (record.validation.status !== "valid" || programExecutionCapabilities(record.program).apply !== "supported") {
        context.addIssue({
          code: "custom",
          message: "Only valid, truthfully applicable Programs may be restored as applied.",
          path: ["appliedPrograms", index],
        });
      }
    });
    const edit = snapshot.editingAppliedProgram;
    if (edit) {
      const applied = snapshot.appliedPrograms[edit.index];
      if (
        !applied ||
        applied.program.transactionId !== edit.original.program.transactionId ||
        snapshot.draftProgram?.program.transactionId !== edit.original.program.transactionId
      ) {
        context.addIssue({
          code: "custom",
          message: "The persisted Applied Program edit no longer matches its transaction.",
          path: ["editingAppliedProgram"],
        });
      }
    }
  });
const editorSessionSnapshotSchema = durableEditorSessionSnapshotSchema
  .safeExtend({
    draftError: boundedText.nullable(),
    insertValue: boundedText,
    instruction: boundedText,
  })
  .strict();
const identitySchema = z
  .object({
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    sceneId: z.string().min(1).max(1_000),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const storedIdentitySchema = z
  .object({
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    sceneKey: z.string().regex(/^scene-[0-9a-z]+-[0-9a-f]{16}$/),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const storedEntrySchema = z
  .object({
    identity: storedIdentitySchema,
    savedAt: z.number().int().nonnegative(),
    snapshot: durableEditorSessionSnapshotSchema,
  })
  .strict();
const storedEnvelopeSchema = z
  .object({
    entries: z.array(storedEntrySchema).max(100),
    version: z.literal(EDITOR_SESSION_STORAGE_VERSION),
  })
  .strict();

type StoredEntry = z.infer<typeof storedEntrySchema>;
type StoredIdentity = z.infer<typeof storedIdentitySchema>;

function opaqueSceneKey(sceneId: string) {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < sceneId.length; index += 1) {
    hash ^= BigInt(sceneId.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return `scene-${sceneId.length.toString(36)}-${hash.toString(16).padStart(16, "0")}`;
}

function storedIdentity(identity: EditorSessionIdentity): StoredIdentity {
  return {
    projectId: identity.projectId,
    sceneKey: opaqueSceneKey(identity.sceneId),
    sourceHash: identity.sourceHash,
  };
}

function sessionKey(identity: StoredIdentity) {
  return JSON.stringify([identity.projectId, identity.sceneKey, identity.sourceHash]);
}

function sameScene(left: StoredIdentity, right: StoredIdentity) {
  return left.projectId === right.projectId && left.sceneKey === right.sceneKey;
}

function durableSnapshot(snapshot: EditorSessionSnapshot) {
  return durableEditorSessionSnapshotSchema.parse({
    appliedPrograms: snapshot.appliedPrograms,
    currentTime: snapshot.currentTime,
    draftOperation: snapshot.draftOperation,
    draftProgram: snapshot.draftProgram,
    editingAppliedProgram: snapshot.editingAppliedProgram,
    insertTool: snapshot.insertTool,
    interactionMode: snapshot.interactionMode,
    motionDuration: snapshot.motionDuration,
    programUndoEntries: snapshot.programUndoEntries,
    redoPrograms: snapshot.redoPrograms,
    selectedObjectIds: snapshot.selectedObjectIds,
  });
}

function restoredDurableSnapshot(snapshot: z.infer<typeof durableEditorSessionSnapshotSchema>): EditorSessionSnapshot {
  return {
    ...snapshot,
    draftError: null,
    insertValue: "",
    instruction: "",
  };
}

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Version policy: v1 is read directly. Unknown older, newer, or malformed
 * payloads are discarded instead of guessed at. A future schema version must
 * add an explicit migration branch before changing EDITOR_SESSION_STORAGE_VERSION.
 */
function migrateStoredEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || !("version" in value)) return null;
  if (value.version !== EDITOR_SESSION_STORAGE_VERSION) return null;
  const parsed = storedEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class EditorSessionStore {
  private readonly memorySessions = new Map<string, EditorSessionSnapshot>();
  private readonly persistedSessions = new Map<string, StoredEntry>();

  constructor(
    private readonly adapter: EditorSessionStorageAdapter | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.loadPersistedSessions();
  }

  clear(identity: EditorSessionIdentity) {
    const parsedIdentity = identitySchema.safeParse(identity);
    if (!parsedIdentity.success) return;
    const key = sessionKey(storedIdentity(parsedIdentity.data));
    this.memorySessions.delete(key);
    if (this.persistedSessions.delete(key)) this.flush();
  }

  clearProject(projectId: string) {
    let changed = false;
    for (const [key, entry] of this.persistedSessions) {
      if (entry.identity.projectId === projectId) {
        this.persistedSessions.delete(key);
        changed = true;
      }
    }
    for (const [key] of this.memorySessions) {
      const parsedKey = JSON.parse(key) as readonly string[];
      if (parsedKey[0] === projectId) this.memorySessions.delete(key);
    }
    if (changed) this.flush();
  }

  pruneProjects(projectIds: ReadonlySet<string>) {
    let changed = false;
    for (const [key, entry] of this.persistedSessions) {
      if (!projectIds.has(entry.identity.projectId)) {
        this.persistedSessions.delete(key);
        changed = true;
      }
    }
    for (const [key] of this.memorySessions) {
      const parsedKey = JSON.parse(key) as readonly string[];
      const projectId = parsedKey[0];
      if (projectId && !projectIds.has(projectId)) this.memorySessions.delete(key);
    }
    if (changed) this.flush();
  }

  restore(identity: EditorSessionIdentity): EditorSessionRestoreResult {
    const parsedIdentity = identitySchema.safeParse(identity);
    if (!parsedIdentity.success) return { kind: "empty" };
    const persistedIdentity = storedIdentity(parsedIdentity.data);
    const key = sessionKey(persistedIdentity);
    const memorySnapshot = this.memorySessions.get(key);
    if (memorySnapshot) return { kind: "restored", snapshot: memorySnapshot };
    const persisted = this.persistedSessions.get(key);
    if (persisted) {
      const snapshot = restoredDurableSnapshot(persisted.snapshot);
      this.memorySessions.set(key, snapshot);
      return { kind: "restored", snapshot };
    }

    let staleSource = false;
    for (const [candidateKey, candidate] of this.persistedSessions) {
      if (sameScene(candidate.identity, persistedIdentity)) {
        this.persistedSessions.delete(candidateKey);
        staleSource = true;
      }
    }
    for (const [candidateKey] of this.memorySessions) {
      const [projectId, sceneKey] = JSON.parse(candidateKey) as readonly string[];
      if (projectId === persistedIdentity.projectId && sceneKey === persistedIdentity.sceneKey) {
        this.memorySessions.delete(candidateKey);
        staleSource = true;
      }
    }
    if (staleSource) {
      this.flush();
      return { kind: "stale-source" };
    }
    return { kind: "empty" };
  }

  save(identity: EditorSessionIdentity, snapshot: EditorSessionSnapshot) {
    const parsedIdentity = identitySchema.safeParse(identity);
    const parsedSnapshot = editorSessionSnapshotSchema.safeParse(snapshot);
    if (!parsedIdentity.success || !parsedSnapshot.success) return false;
    const persistedIdentity = storedIdentity(parsedIdentity.data);
    const key = sessionKey(persistedIdentity);
    this.memorySessions.set(key, parsedSnapshot.data);
    const entry: StoredEntry = {
      identity: persistedIdentity,
      savedAt: Math.max(0, Math.floor(this.now())),
      snapshot: durableSnapshot(parsedSnapshot.data),
    };
    const serializedEntry = JSON.stringify(entry);
    if (serializedBytes(serializedEntry) > MAX_STORED_EDITOR_SESSION_BYTES) {
      this.persistedSessions.delete(key);
      this.flush();
      return false;
    }
    this.persistedSessions.set(key, entry);
    this.flush();
    return true;
  }

  private flush() {
    const retained = [...this.persistedSessions.values()]
      .sort((left, right) => right.savedAt - left.savedAt)
      .filter((entry) => serializedBytes(JSON.stringify(entry)) <= MAX_STORED_EDITOR_SESSION_BYTES)
      .slice(0, MAX_STORED_EDITOR_SESSIONS);
    let envelope = { entries: retained, version: EDITOR_SESSION_STORAGE_VERSION } as const;
    while (
      envelope.entries.length > 0 &&
      serializedBytes(JSON.stringify(envelope)) > MAX_EDITOR_SESSION_STORAGE_BYTES
    ) {
      envelope = { ...envelope, entries: envelope.entries.slice(0, -1) };
    }
    this.persistedSessions.clear();
    for (const entry of envelope.entries) {
      this.persistedSessions.set(sessionKey(entry.identity), entry);
    }
    if (!this.adapter) return;
    try {
      if (envelope.entries.length === 0) this.adapter.clear();
      else this.adapter.write(JSON.stringify(envelope));
    } catch {
      // Storage can be unavailable or over quota. The in-memory session remains usable.
    }
  }

  private loadPersistedSessions() {
    if (!this.adapter) return;
    let serialized: string | null = null;
    try {
      serialized = this.adapter.read();
    } catch {
      return;
    }
    if (!serialized) return;
    if (serializedBytes(serialized) > MAX_EDITOR_SESSION_STORAGE_BYTES) {
      this.clearUnreadableStorage();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      this.clearUnreadableStorage();
      return;
    }
    const envelope = migrateStoredEnvelope(value);
    if (!envelope) {
      this.clearUnreadableStorage();
      return;
    }
    for (const entry of envelope.entries) {
      const key = sessionKey(entry.identity);
      const previous = this.persistedSessions.get(key);
      if (!previous || previous.savedAt <= entry.savedAt) this.persistedSessions.set(key, entry);
    }
    this.flush();
  }

  private clearUnreadableStorage() {
    try {
      this.adapter?.clear();
    } catch {
      // An inaccessible storage implementation is treated as memory-only.
    }
  }
}
