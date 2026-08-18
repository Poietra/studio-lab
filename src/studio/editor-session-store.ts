import { z } from "zod";

import {
  type EditorSessionSnapshotV1,
  editorSessionSnapshotSchemaV1,
  MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1,
  parseEditorSessionSnapshotV1,
} from "../collaboration/editor-session-contract";
import {
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  type ProjectFragmentMaterialStateV1,
  projectFragmentMaterialStateV1Schema,
} from "./fragment-material-authoring";

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

export type EditorSessionSnapshot = EditorSessionSnapshotV1 &
  Readonly<{
    durationError: string | null;
    draftError: string | null;
    insertValue: string;
    instruction: string;
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
    version: z.literal(EDITOR_SESSION_STORAGE_VERSION),
  })
  .strict();

type StoredIdentity = z.infer<typeof storedIdentitySchema>;
type StoredEntry = Readonly<{
  identity: StoredIdentity;
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

/**
 * Opaque, storage-safe identity for state that must be ignored during the
 * render between an active Scene switch and its `openSession` effect.
 */
export function editorSessionIdentityKey(identity: EditorSessionIdentity) {
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
    return { ...parseEditorSessionSnapshotV1(durableValue), ...transient.data };
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
  if (!parsed.success) return null;
  try {
    return {
      ...parsed.data,
      entries: parsed.data.entries.map((entry) => ({
        ...entry,
        snapshot: parseEditorSessionSnapshotV1(entry.snapshot),
      })),
      fragmentMaterials: parsed.data.fragmentMaterials ?? {},
    };
  } catch {
    return null;
  }
}

export class EditorSessionStore {
  private readonly cloudManagedSessions = new Set<string>();
  private readonly memorySessions = new Map<string, EditorSessionSnapshot>();
  private readonly persistedSessions = new Map<string, StoredEntry>();
  private readonly projectFragmentMaterials = new Map<string, ProjectFragmentMaterialStateV1>();

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
    let changed = this.projectFragmentMaterials.delete(projectId);
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
    this.flush();
    return true;
  }

  save(identity: EditorSessionIdentity, snapshot: EditorSessionSnapshot) {
    const parsedIdentity = identitySchema.safeParse(identity);
    const parsedSnapshot = parseLocalEditorSessionSnapshot(snapshot);
    if (!parsedIdentity.success || !parsedSnapshot) return false;
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
    const retained = [...this.persistedSessions.values()]
      .sort((left, right) => right.savedAt - left.savedAt)
      .filter((entry) => serializedBytes(JSON.stringify(entry)) <= MAX_STORED_EDITOR_SESSION_BYTES)
      .slice(0, MAX_STORED_EDITOR_SESSIONS);
    const fragmentMaterials = this.serializedProjectFragmentMaterials();
    let envelope = { entries: retained, fragmentMaterials, version: EDITOR_SESSION_STORAGE_VERSION } as const;
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
      if (envelope.entries.length === 0 && Object.keys(envelope.fragmentMaterials).length === 0) this.adapter.clear();
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
