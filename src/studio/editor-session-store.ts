import { z } from "zod";

import {
  type AppliedProgramMutation,
  type EditorSessionSnapshotV1,
  editorSessionSnapshotSchemaV1,
  MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1,
  parseEditorSessionSnapshotV1,
  type RedoProgramEntry,
} from "../collaboration/editor-session-contract";
import {
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  type ProjectFragmentMaterialStateV1,
  projectFragmentMaterialStateV1Schema,
} from "./fragment-material-authoring";
import type { SceneEditOperation } from "./scene-edit-contract";

export type {
  AcceptedProgramRecord,
  AppliedProgramEdit,
  AppliedProgramMetadata,
  AppliedProgramMutation,
  DraftEditorProgramRecord,
  DraftProgramRecord,
  EditorProgramRecord,
  RedoProgramEntry,
} from "../collaboration/editor-session-contract";

export const EDITOR_SESSION_STORAGE_KEY = "poietra.studio.editor-sessions";
export const EDITOR_SESSION_STORAGE_VERSION = 1 as const;
export const EDITOR_SESSION_STALE_SOURCE_MESSAGE =
  "The previous editor session was not restored because this Scene's Python source changed.";

export const MAX_STORED_EDITOR_SESSIONS = 20;
export const MAX_STORED_EDITOR_SESSION_BYTES = MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1;
export const MAX_EDITOR_SESSION_STORAGE_BYTES = 2 * 1024 * 1024;

export type EditorSessionSnapshot = Omit<EditorSessionSnapshotV1, "lockedEntityIds"> &
  Readonly<{
    durationError: string | null;
    draftError: string | null;
    insertValue: string;
    instruction: string;
    lockedEntityIds: readonly string[];
  }>;

export type ImportedEditorSessionIdentity = Readonly<{
  /** Kept undiscriminated so the persisted v1 imported-session wire is byte-compatible. */
  origin?: never;
  projectId: string;
  sceneId: string;
  sourceHash: string;
}>;

export type NativeEditorSessionIdentity = Readonly<{
  documentKey: string;
  origin: "studio-native";
  projectId: string;
  sceneId: string;
}>;

export type EditorSessionIdentity = ImportedEditorSessionIdentity | NativeEditorSessionIdentity;

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

export type EditorSessionAccountScope = Readonly<{
  organizationId: string;
  userId: string;
}>;

export function editorSessionStorageKey(scope?: EditorSessionAccountScope) {
  if (scope === undefined) return EDITOR_SESSION_STORAGE_KEY;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(scope.organizationId) || !z.uuid().safeParse(scope.userId).success) {
    throw new TypeError("The editor session account scope is invalid.");
  }
  return `${EDITOR_SESSION_STORAGE_KEY}.${scope.userId}.${scope.organizationId}`;
}

export function browserEditorSessionStorageAdapter(
  scope?: EditorSessionAccountScope,
): EditorSessionStorageAdapter | null {
  if (typeof window === "undefined") return null;
  try {
    return new WebStorageEditorSessionAdapter(window.localStorage, editorSessionStorageKey(scope));
  } catch {
    return null;
  }
}

const boundedText = z.string().max(2_000);
const transientEditorSessionSnapshotSchema = z
  .object({
    durationError: boundedText.nullable(),
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
const nativeIdentitySchema = z
  .object({
    documentKey: z.string().regex(/^[0-9a-f]{64}$/),
    origin: z.literal("studio-native"),
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    sceneId: z.string().min(1).max(1_000),
  })
  .strict();
const projectIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
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
    snapshot: editorSessionSnapshotSchemaV1,
  })
  .strict();
const storedNativeIdentitySchema = z
  .object({
    documentKey: z.string().regex(/^[0-9a-f]{64}$/),
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  })
  .strict();
const storedNativeEntrySchema = z
  .object({
    identity: storedNativeIdentitySchema,
    savedAt: z.number().int().nonnegative(),
    snapshot: editorSessionSnapshotSchemaV1,
  })
  .strict();
const storedProjectFragmentMaterialSchema = z
  .object({
    sourceLanguage: z.literal("wgsl"),
    state: projectFragmentMaterialStateV1Schema,
  })
  .strict();
const storedEnvelopeSchema = z
  .object({
    entries: z.array(storedEntrySchema).max(100),
    fragmentMaterials: z.record(projectIdSchema, storedProjectFragmentMaterialSchema).optional(),
    nativeEntries: z.array(storedNativeEntrySchema).max(100).optional(),
    version: z.literal(EDITOR_SESSION_STORAGE_VERSION),
  })
  .strict();

type StoredIdentity = z.infer<typeof storedIdentitySchema>;
type StoredNativeIdentity = z.infer<typeof storedNativeIdentitySchema>;
type StoredEntry = Readonly<{
  identity: StoredIdentity;
  savedAt: number;
  snapshot: EditorSessionSnapshotV1;
}>;
type StoredNativeEntry = Readonly<{
  identity: StoredNativeIdentity;
  savedAt: number;
  snapshot: EditorSessionSnapshotV1;
}>;

function opaqueSceneKey(sceneId: string) {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < sceneId.length; index += 1) {
    hash ^= BigInt(sceneId.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return `scene-${sceneId.length.toString(36)}-${hash.toString(16).padStart(16, "0")}`;
}

function storedIdentity(identity: ImportedEditorSessionIdentity): StoredIdentity {
  return {
    projectId: identity.projectId,
    sceneKey: opaqueSceneKey(identity.sceneId),
    sourceHash: identity.sourceHash,
  };
}

function sessionKey(identity: StoredIdentity) {
  return JSON.stringify([identity.projectId, identity.sceneKey, identity.sourceHash]);
}

function storedNativeIdentity(identity: NativeEditorSessionIdentity): StoredNativeIdentity {
  return { documentKey: identity.documentKey, projectId: identity.projectId };
}

function nativeSessionKey(identity: StoredNativeIdentity) {
  return JSON.stringify([identity.projectId, "studio-native", identity.documentKey]);
}

function parsedNativeIdentity(identity: EditorSessionIdentity) {
  if (identity.origin !== "studio-native") return null;
  const parsed = nativeIdentitySchema.safeParse(identity);
  return parsed.success ? parsed.data : null;
}

/**
 * Opaque, storage-safe identity for state that must be ignored during the
 * render between an active Scene switch and its `openSession` effect.
 */
export function editorSessionIdentityKey(identity: EditorSessionIdentity) {
  const native = parsedNativeIdentity(identity);
  if (native) return nativeSessionKey(storedNativeIdentity(native));
  const parsed = identitySchema.safeParse(identity);
  return parsed.success ? sessionKey(storedIdentity(parsed.data)) : null;
}

function sameScene(left: StoredIdentity, right: StoredIdentity) {
  return left.projectId === right.projectId && left.sceneKey === right.sceneKey;
}

function parseLocalEditorSessionSnapshot(value: unknown): EditorSessionSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { durationError, draftError, insertValue, instruction, ...durableValue } = value as Record<string, unknown>;
  const transient = transientEditorSessionSnapshotSchema.safeParse({
    durationError,
    draftError,
    insertValue,
    instruction,
  });
  if (!transient.success) return null;
  try {
    const parsed = parseEditorSessionSnapshotV1(durableValue);
    return { ...parsed, ...transient.data, lockedEntityIds: parsed.lockedEntityIds ?? [] };
  } catch {
    return null;
  }
}

/**
 * Closes the local editor payload over the subject-private cloud contract.
 * Text inputs and transient errors never cross the account storage boundary.
 */
export function durableEditorSessionSnapshotV1(snapshot: EditorSessionSnapshot): EditorSessionSnapshotV1 {
  return parseEditorSessionSnapshotV1({
    appliedPrograms: snapshot.appliedPrograms,
    currentTime: snapshot.currentTime,
    draftOperation: snapshot.draftOperation,
    draftProgram: snapshot.draftProgram,
    editingAppliedProgram: snapshot.editingAppliedProgram,
    insertTool: snapshot.insertTool,
    interactionMode: snapshot.interactionMode,
    lockedEntityIds: snapshot.lockedEntityIds,
    motionDuration: snapshot.motionDuration,
    programUndoEntries: snapshot.programUndoEntries,
    redoPrograms: snapshot.redoPrograms,
    selectedObjectIds: snapshot.selectedObjectIds,
    verifiedSourceDurationBasis: snapshot.verifiedSourceDurationBasis,
  });
}

function restoredDurableSnapshot(snapshot: EditorSessionSnapshotV1): EditorSessionSnapshot {
  return {
    ...snapshot,
    durationError: null,
    draftError: null,
    insertValue: "",
    instruction: "",
    lockedEntityIds: snapshot.lockedEntityIds ?? [],
  };
}

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

type EditorProgramWithOperations = Readonly<{ operations: readonly SceneEditOperation[] }>;

function mutationPrograms(mutation: AppliedProgramMutation): readonly EditorProgramWithOperations[] {
  return mutation.kind === "append" ? [mutation.value.program] : [mutation.previous.program, mutation.value.program];
}

function redoPrograms(entry: RedoProgramEntry): readonly EditorProgramWithOperations[] {
  if (entry.kind === "mutation") return mutationPrograms(entry.mutation);
  return entry.edit ? [entry.value.program, entry.edit.original.program] : [entry.value.program];
}

function editorSessionHasMaterialParameterTrack(snapshot: EditorSessionSnapshotV1, shaderId: string) {
  const programs: readonly EditorProgramWithOperations[] = [
    ...snapshot.appliedPrograms.map(({ program }) => program),
    ...(snapshot.draftProgram ? [snapshot.draftProgram.program] : []),
    ...(snapshot.editingAppliedProgram ? [snapshot.editingAppliedProgram.original.program] : []),
    ...snapshot.programUndoEntries.flatMap(mutationPrograms),
    ...snapshot.redoPrograms.flatMap(redoPrograms),
  ];
  return programs.some((program) =>
    program.operations.some(
      (operation) =>
        operation.kind === "AnimateProperty" && operation.materialParameter?.material.shaderId === shaderId,
    ),
  );
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
  if (!parsed.success) return null;
  try {
    return {
      ...parsed.data,
      entries: parsed.data.entries.map((entry) => ({
        ...entry,
        snapshot: parseEditorSessionSnapshotV1(entry.snapshot),
      })),
      fragmentMaterials: parsed.data.fragmentMaterials ?? {},
      nativeEntries: (parsed.data.nativeEntries ?? []).map((entry) => ({
        ...entry,
        snapshot: parseEditorSessionSnapshotV1(entry.snapshot),
      })),
    };
  } catch {
    return null;
  }
}

export class EditorSessionStore {
  private readonly cloudManagedSessions = new Set<string>();
  private readonly memorySessions = new Map<string, EditorSessionSnapshot>();
  private readonly persistedNativeSessions = new Map<string, StoredNativeEntry>();
  private readonly persistedSessions = new Map<string, StoredEntry>();
  private readonly projectFragmentMaterials = new Map<string, ProjectFragmentMaterialStateV1>();

  constructor(
    private readonly adapter: EditorSessionStorageAdapter | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.loadPersistedSessions();
  }

  clear(identity: EditorSessionIdentity) {
    const native = parsedNativeIdentity(identity);
    if (native) {
      const key = nativeSessionKey(storedNativeIdentity(native));
      this.memorySessions.delete(key);
      if (this.persistedNativeSessions.delete(key)) this.flush();
      return;
    }
    const parsedIdentity = identitySchema.safeParse(identity);
    if (!parsedIdentity.success) return;
    const key = sessionKey(storedIdentity(parsedIdentity.data));
    this.memorySessions.delete(key);
    if (this.persistedSessions.delete(key)) this.flush();
  }

  clearProject(projectId: string) {
    let changed = this.projectFragmentMaterials.delete(projectId);
    for (const [key, entry] of this.persistedNativeSessions) {
      if (entry.identity.projectId === projectId) {
        this.persistedNativeSessions.delete(key);
        changed = true;
      }
    }
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
    for (const key of this.cloudManagedSessions) {
      const [candidateProjectId] = JSON.parse(key) as readonly string[];
      if (candidateProjectId === projectId) this.cloudManagedSessions.delete(key);
    }
    if (changed) this.flush();
  }

  clearMigrated(identity: EditorSessionIdentity) {
    if (!this.markCloudManaged(identity)) return false;
    this.clear(identity);
    return true;
  }

  isCloudManaged(identity: EditorSessionIdentity) {
    const key = editorSessionIdentityKey(identity);
    return key !== null && this.cloudManagedSessions.has(key);
  }

  markCloudManaged(identity: EditorSessionIdentity) {
    const key = editorSessionIdentityKey(identity);
    if (key === null) return false;
    this.cloudManagedSessions.add(key);
    return true;
  }

  pruneProjects(projectIds: ReadonlySet<string>) {
    let changed = false;
    for (const projectId of this.projectFragmentMaterials.keys()) {
      if (!projectIds.has(projectId)) {
        this.projectFragmentMaterials.delete(projectId);
        changed = true;
      }
    }
    for (const [key, entry] of this.persistedSessions) {
      if (!projectIds.has(entry.identity.projectId)) {
        this.persistedSessions.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of this.persistedNativeSessions) {
      if (!projectIds.has(entry.identity.projectId)) {
        this.persistedNativeSessions.delete(key);
        changed = true;
      }
    }
    for (const [key] of this.memorySessions) {
      const parsedKey = JSON.parse(key) as readonly string[];
      const projectId = parsedKey[0];
      if (projectId && !projectIds.has(projectId)) this.memorySessions.delete(key);
    }
    for (const key of this.cloudManagedSessions) {
      const [projectId] = JSON.parse(key) as readonly string[];
      if (projectId && !projectIds.has(projectId)) this.cloudManagedSessions.delete(key);
    }
    if (changed) this.flush();
  }

  restore(identity: EditorSessionIdentity): EditorSessionRestoreResult {
    const native = parsedNativeIdentity(identity);
    if (native) {
      const key = nativeSessionKey(storedNativeIdentity(native));
      const snapshot = this.memorySessions.get(key);
      if (snapshot) return { kind: "restored", snapshot };
      const persisted = this.persistedNativeSessions.get(key);
      if (!persisted) return { kind: "empty" };
      const restored = restoredDurableSnapshot(persisted.snapshot);
      this.memorySessions.set(key, restored);
      return { kind: "restored", snapshot: restored };
    }
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

  restoreProjectFragmentMaterials(projectId: string): ProjectFragmentMaterialStateV1 {
    if (!projectIdSchema.safeParse(projectId).success) return EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1;
    return this.projectFragmentMaterials.get(projectId) ?? EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1;
  }

  projectHasMaterialParameterTrack(
    projectId: string,
    shaderId: string,
    active?: Readonly<{ identity: EditorSessionIdentity; snapshot: EditorSessionSnapshot }>,
  ) {
    const snapshots = new Map<string, EditorSessionSnapshotV1>();
    for (const [key, entry] of this.persistedSessions) {
      if (entry.identity.projectId === projectId) snapshots.set(key, entry.snapshot);
    }
    for (const [key, entry] of this.persistedNativeSessions) {
      if (entry.identity.projectId === projectId) snapshots.set(key, entry.snapshot);
    }
    for (const [key, snapshot] of this.memorySessions) {
      const [candidateProjectId] = JSON.parse(key) as readonly string[];
      if (candidateProjectId === projectId) snapshots.set(key, durableEditorSessionSnapshotV1(snapshot));
    }
    if (active?.identity.projectId === projectId) {
      const key = editorSessionIdentityKey(active.identity);
      if (key === null) return true;
      snapshots.set(key, durableEditorSessionSnapshotV1(active.snapshot));
    }
    return [...snapshots.values()].some((snapshot) => editorSessionHasMaterialParameterTrack(snapshot, shaderId));
  }

  saveProjectFragmentMaterials(projectId: string, state: ProjectFragmentMaterialStateV1) {
    const parsedProjectId = projectIdSchema.safeParse(projectId);
    const parsedState = projectFragmentMaterialStateV1Schema.safeParse(state);
    if (!parsedProjectId.success || !parsedState.success) return false;

    const empty =
      parsedState.data.registry.materials.length === 0 && Object.keys(parsedState.data.assignmentsByScene).length === 0;
    const previous = this.projectFragmentMaterials.get(parsedProjectId.data);
    if (empty) this.projectFragmentMaterials.delete(parsedProjectId.data);
    else this.projectFragmentMaterials.set(parsedProjectId.data, parsedState.data);

    const materialEnvelope = JSON.stringify({
      entries: [],
      fragmentMaterials: this.serializedProjectFragmentMaterials(),
      version: EDITOR_SESSION_STORAGE_VERSION,
    });
    if (serializedBytes(materialEnvelope) > MAX_EDITOR_SESSION_STORAGE_BYTES) {
      if (previous) this.projectFragmentMaterials.set(parsedProjectId.data, previous);
      else this.projectFragmentMaterials.delete(parsedProjectId.data);
      return false;
    }
    if (this.flush()) return true;
    if (previous) this.projectFragmentMaterials.set(parsedProjectId.data, previous);
    else this.projectFragmentMaterials.delete(parsedProjectId.data);
    return false;
  }

  save(identity: EditorSessionIdentity, snapshot: EditorSessionSnapshot) {
    const parsedSnapshot = parseLocalEditorSessionSnapshot(snapshot);
    if (!parsedSnapshot) return false;
    const native = parsedNativeIdentity(identity);
    if (native) {
      const persistedIdentity = storedNativeIdentity(native);
      const key = nativeSessionKey(persistedIdentity);
      this.memorySessions.set(key, parsedSnapshot);
      const entry: StoredNativeEntry = {
        identity: persistedIdentity,
        savedAt: Math.max(0, Math.floor(this.now())),
        snapshot: durableEditorSessionSnapshotV1(parsedSnapshot),
      };
      if (serializedBytes(JSON.stringify(entry)) > MAX_STORED_EDITOR_SESSION_BYTES) {
        this.persistedNativeSessions.delete(key);
        this.flush();
        return false;
      }
      this.persistedNativeSessions.set(key, entry);
      this.flush();
      return true;
    }
    const parsedIdentity = identitySchema.safeParse(identity);
    if (!parsedIdentity.success) return false;
    const persistedIdentity = storedIdentity(parsedIdentity.data);
    const key = sessionKey(persistedIdentity);
    if (this.cloudManagedSessions.has(key)) return false;
    this.memorySessions.set(key, parsedSnapshot);
    const entry: StoredEntry = {
      identity: persistedIdentity,
      savedAt: Math.max(0, Math.floor(this.now())),
      snapshot: durableEditorSessionSnapshotV1(parsedSnapshot),
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
    const retained = [
      ...[...this.persistedSessions.values()].map((entry) => ({ entry, kind: "imported" as const })),
      ...[...this.persistedNativeSessions.values()].map((entry) => ({ entry, kind: "native" as const })),
    ]
      .sort((left, right) => right.entry.savedAt - left.entry.savedAt)
      .filter(({ entry }) => serializedBytes(JSON.stringify(entry)) <= MAX_STORED_EDITOR_SESSION_BYTES)
      .slice(0, MAX_STORED_EDITOR_SESSIONS);
    const fragmentMaterials = this.serializedProjectFragmentMaterials();
    let envelope = {
      entries: retained.flatMap(({ entry, kind }) => (kind === "imported" ? [entry] : [])),
      fragmentMaterials,
      nativeEntries: retained.flatMap(({ entry, kind }) => (kind === "native" ? [entry] : [])),
      version: EDITOR_SESSION_STORAGE_VERSION,
    };
    while (
      envelope.entries.length + envelope.nativeEntries.length > 0 &&
      serializedBytes(JSON.stringify(envelope)) > MAX_EDITOR_SESSION_STORAGE_BYTES
    ) {
      const oldestImported = envelope.entries.at(-1)?.savedAt ?? Number.POSITIVE_INFINITY;
      const oldestNative = envelope.nativeEntries.at(-1)?.savedAt ?? Number.POSITIVE_INFINITY;
      envelope =
        oldestImported <= oldestNative
          ? { ...envelope, entries: envelope.entries.slice(0, -1) }
          : { ...envelope, nativeEntries: envelope.nativeEntries.slice(0, -1) };
    }
    this.persistedSessions.clear();
    for (const entry of envelope.entries) {
      this.persistedSessions.set(sessionKey(entry.identity), entry);
    }
    this.persistedNativeSessions.clear();
    for (const entry of envelope.nativeEntries) {
      this.persistedNativeSessions.set(nativeSessionKey(entry.identity), entry);
    }
    if (!this.adapter) return true;
    try {
      if (
        envelope.entries.length === 0 &&
        envelope.nativeEntries.length === 0 &&
        Object.keys(envelope.fragmentMaterials).length === 0
      )
        this.adapter.clear();
      else this.adapter.write(JSON.stringify(envelope));
      return true;
    } catch {
      // Storage can be unavailable or over quota. The in-memory session remains usable.
      return false;
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
    for (const entry of envelope.nativeEntries) {
      const key = nativeSessionKey(entry.identity);
      const previous = this.persistedNativeSessions.get(key);
      if (!previous || previous.savedAt <= entry.savedAt) this.persistedNativeSessions.set(key, entry);
    }
    for (const [projectId, material] of Object.entries(envelope.fragmentMaterials)) {
      this.projectFragmentMaterials.set(projectId, material.state);
    }
    this.flush();
  }

  private serializedProjectFragmentMaterials() {
    return Object.fromEntries(
      [...this.projectFragmentMaterials.entries()].map(([projectId, state]) => [
        projectId,
        { sourceLanguage: "wgsl" as const, state },
      ]),
    );
  }

  private clearUnreadableStorage() {
    try {
      this.adapter?.clear();
    } catch {
      // An inaccessible storage implementation is treated as memory-only.
    }
  }
}
