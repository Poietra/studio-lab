import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import type { CanonicalEditProgram } from "../studio/operations";
import {
  type EditorDocumentClientIdentityV1,
  type EditorDocumentClientV1,
  editorCommitOutcomeMayBeUnknownV1,
} from "./editor-document-client";
import type {
  EditorDocumentCommitRequestV1,
  EditorDocumentCommittedSessionUpdateViewV1,
  EditorDocumentSessionPutRequestV1,
  EditorDocumentSessionViewV1,
  EditorDocumentViewV1,
  EditorEditEventViewV1,
} from "./editor-document-http-contract";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentSessionPutRequestSchemaV1,
} from "./editor-document-http-contract";
import {
  applyEditorEditMutationV1,
  type EditorEditMutationV1,
  parseAuthoritativeEditorProgramsV1,
  parseEditorEditMutationV1,
} from "./editor-edit-mutation";
import {
  canonicalEditorSessionSnapshotJsonV1,
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  type EditorSessionSnapshotV1,
  parseEditorSessionSnapshotV1,
} from "./editor-session-contract";

const MAX_RECONCILED_EDITOR_EVENTS_V1 = 512;
const MAX_OPEN_SESSION_RECONCILIATIONS_V1 = 4;

export type EditorDocumentAuthorityIdentityV1 = EditorDocumentClientIdentityV1 &
  Readonly<{
    sceneName: string;
    sourceHash: string;
    sourcePath: string;
  }>;

export type EditorDocumentAuthoritySnapshotV1 = Readonly<{
  document: EditorDocumentViewV1;
  programs: readonly CanonicalEditProgram[];
  revision: string;
  sessionGeneration: string;
}>;

export type EditorDocumentAuthorityOpenOutcomeV1 = EditorDocumentAuthoritySnapshotV1 &
  Readonly<{ session: EditorSessionSnapshotV1 | null }>;

export type EditorDocumentAuthorityCommitOutcomeV1 =
  | Readonly<{
      kind: "committed";
      sessionInvalidated: boolean;
      snapshot: EditorDocumentAuthoritySnapshotV1;
    }>
  | Readonly<{
      accepted: boolean;
      kind: "reconciled";
      sessionInvalidated: boolean;
      snapshot: EditorDocumentAuthoritySnapshotV1;
    }>;

export type EditorDocumentAuthoritySessionSaveOutcomeV1 =
  | Readonly<{
      kind: "stored";
      replayed: boolean;
      sessionGeneration: string;
    }>
  | Readonly<{
      kind: "reconciled";
      snapshot: EditorDocumentAuthoritySnapshotV1;
    }>;

export type EditorDocumentAuthorityCommitOptionsV1 = Readonly<{
  sessionSnapshot: EditorSessionSnapshotV1;
  signal?: AbortSignal;
}>;

export type EditorDocumentAuthorityRecoveryKindV1 = "commit" | "tail";

export class EditorDocumentAuthorityErrorV1 extends Error {
  constructor(
    message: string,
    readonly code:
      | "busy"
      | "conflict"
      | "corrupt-response"
      | "not-open"
      | "session-conflict"
      | "source-conflict"
      | "unavailable",
  ) {
    super(message);
    this.name = "EditorDocumentAuthorityErrorV1";
  }
}

type PendingMutationV1 = Readonly<{
  baseRevision: string;
  canonicalMutation: string;
  canonicalSessionSnapshot: string | null;
  request: EditorDocumentCommitRequestV1;
}>;

type PendingSessionSaveV1 = Readonly<{
  canonicalSnapshot: string;
  request: EditorDocumentSessionPutRequestV1;
}>;

function revisionV1(value: string) {
  return BigInt(value);
}

async function sha256HexV1(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortSignalV1(value: AbortSignal | EditorDocumentAuthorityCommitOptionsV1 | undefined) {
  return value !== undefined && "aborted" in value && "addEventListener" in value;
}

function snapshotProgramsCanonicalJsonV1(snapshot: EditorSessionSnapshotV1) {
  return canonicalJsonV1(snapshot.appliedPrograms.map((record) => record.program));
}

function assertSessionProjectionV1(
  snapshot: EditorSessionSnapshotV1,
  programs: readonly CanonicalEditProgram[],
  message: string,
) {
  if (snapshotProgramsCanonicalJsonV1(snapshot) !== canonicalJsonV1(programs)) {
    authorityErrorV1(message, "session-conflict");
  }
}

function assertSessionIdentityV1(
  session: EditorDocumentSessionViewV1,
  identity: EditorDocumentAuthorityIdentityV1,
  document: EditorDocumentViewV1,
) {
  if (
    session.tenantId !== identity.organizationId ||
    session.projectId !== identity.projectId ||
    session.documentKey !== document.documentKey ||
    session.epoch !== document.epoch
  ) {
    authorityErrorV1(
      "The Editor service returned a private session for a different document identity.",
      "corrupt-response",
    );
  }
}

async function parseVerifiedSessionSnapshotV1(session: EditorDocumentSessionViewV1) {
  const snapshot = parseEditorSessionSnapshotV1(session.snapshot);
  const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(snapshot);
  if (
    new TextEncoder().encode(canonicalSnapshot).byteLength !== session.snapshotByteSize ||
    (await sha256HexV1(canonicalSnapshot)) !== session.snapshotDigest
  ) {
    authorityErrorV1("The Editor service returned invalid private session evidence.", "corrupt-response");
  }
  return snapshot;
}

async function assertCommittedSessionEvidenceV1(
  evidence: EditorDocumentCommittedSessionUpdateViewV1 | undefined,
  request: EditorDocumentCommitRequestV1,
) {
  const update = request.sessionUpdate;
  if ((update === undefined) !== (evidence === undefined)) {
    authorityErrorV1("The Editor service returned inconsistent atomic session evidence.", "corrupt-response");
  }
  if (!update || !evidence) return;
  const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(update.snapshot);
  const snapshotBytes = new TextEncoder().encode(canonicalSnapshot);
  if (
    evidence.documentRevision !== update.documentRevision ||
    BigInt(evidence.sessionGeneration) !== BigInt(update.expectedSessionGeneration) + 1n ||
    evidence.snapshotVersion !== update.snapshotVersion ||
    evidence.snapshotByteSize !== snapshotBytes.byteLength ||
    evidence.snapshotDigest !== (await sha256HexV1(canonicalSnapshot))
  ) {
    authorityErrorV1("The Editor service returned invalid atomic session evidence.", "corrupt-response");
  }
}

/** Browser equivalent of the server's Scene ID + Editor document-key derivation. */
export async function createBrowserEditorDocumentKeyV1(identity: EditorDocumentAuthorityIdentityV1) {
  const request = editorDocumentOpenRequestSchemaV1.parse({
    sceneName: identity.sceneName,
    sourceHash: identity.sourceHash,
    sourcePath: identity.sourcePath,
  });
  const sceneDigest = await sha256HexV1(`${request.sourcePath}\0${request.sceneName}`);
  return sha256HexV1(`poietra.editor-document.v1\0${request.sourcePath}\0scene:${sceneDigest}`);
}

function authorityErrorV1(message: string, code: EditorDocumentAuthorityErrorV1["code"]): never {
  throw new EditorDocumentAuthorityErrorV1(message, code);
}

function assertDocumentIdentityV1(
  document: EditorDocumentViewV1,
  identity: EditorDocumentAuthorityIdentityV1,
  expected: Readonly<{ documentKey?: string; epoch?: string }> = {},
) {
  if (
    document.tenantId !== identity.organizationId ||
    document.projectId !== identity.projectId ||
    document.sourceHash !== identity.sourceHash ||
    document.sourcePath !== identity.sourcePath ||
    document.sealedAt !== null ||
    (expected.documentKey !== undefined && document.documentKey !== expected.documentKey) ||
    (expected.epoch !== undefined && document.epoch !== expected.epoch)
  ) {
    authorityErrorV1("The Editor service returned a document for a different Scene identity.", "corrupt-response");
  }
}

function assertEventIdentityV1(
  event: EditorEditEventViewV1,
  identity: EditorDocumentAuthorityIdentityV1,
  document: EditorDocumentViewV1,
) {
  if (
    event.tenantId !== identity.organizationId ||
    event.projectId !== identity.projectId ||
    event.documentKey !== document.documentKey ||
    event.epoch !== document.epoch
  ) {
    authorityErrorV1("The Editor service returned an event for a different document identity.", "corrupt-response");
  }
}

function applyEventV1(programs: readonly CanonicalEditProgram[], revision: bigint, event: EditorEditEventViewV1) {
  if (revisionV1(event.baseRevision) !== revision || revisionV1(event.revision) !== revision + 1n) {
    authorityErrorV1("The Editor service returned a non-contiguous event tail.", "corrupt-response");
  }
  const applied = applyEditorEditMutationV1(programs, event.mutation);
  if (applied.kind !== "applied") {
    authorityErrorV1("The Editor service returned an event that cannot extend its projection.", "corrupt-response");
  }
  return { programs: applied.programs, revision: revision + 1n } as const;
}

function snapshotV1(
  document: EditorDocumentViewV1,
  revision: bigint,
  programs: readonly CanonicalEditProgram[],
  sessionGeneration: bigint,
): EditorDocumentAuthoritySnapshotV1 {
  if (revisionV1(document.revision) !== revision) {
    authorityErrorV1("The Editor document and local replica revisions do not match.", "corrupt-response");
  }
  return Object.freeze({
    document,
    programs: Object.freeze([...programs]),
    revision: revision.toString(10),
    sessionGeneration: sessionGeneration.toString(10),
  });
}

export class EditorDocumentAuthorityV1 {
  #document: EditorDocumentViewV1 | null = null;
  #inFlight = false;
  #pending: PendingMutationV1 | null = null;
  #pendingSession: PendingSessionSaveV1 | null = null;
  #programs: readonly CanonicalEditProgram[] = [];
  #recovery: "tail" | null = null;
  #revision = 0n;
  #sessionGeneration = 0n;
  #tailRecoveryAccepted = false;

  constructor(
    private readonly client: EditorDocumentClientV1,
    private readonly identity: EditorDocumentAuthorityIdentityV1,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
  ) {}

  get recoveryKind(): EditorDocumentAuthorityRecoveryKindV1 | null {
    if (this.#pending) return "commit";
    return this.#recovery;
  }

  get sessionGeneration(): string {
    return this.#sessionGeneration.toString(10);
  }

  get sessionRecoveryPending(): boolean {
    return this.#pendingSession !== null;
  }

  async open(signal?: AbortSignal) {
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    this.#inFlight = true;
    try {
      const [result, expectedDocumentKey] = await Promise.all([
        this.client.open(
          this.identity,
          {
            sceneName: this.identity.sceneName,
            sourceHash: this.identity.sourceHash,
            sourcePath: this.identity.sourcePath,
          },
          signal,
        ),
        createBrowserEditorDocumentKeyV1(this.identity),
      ]);
      if (result.kind === "not-found") {
        authorityErrorV1("The selected Editor document is unavailable.", "unavailable");
      }
      if (result.kind === "source-conflict") {
        authorityErrorV1("The selected Scene source changed before its Editor document could open.", "source-conflict");
      }
      assertDocumentIdentityV1(result.document, this.identity, { documentKey: expectedDocumentKey });
      if (result.document.revision !== result.projection.revision) {
        authorityErrorV1("The Editor open projection is not aligned to its document.", "corrupt-response");
      }
      this.#document = result.document;
      this.#revision = revisionV1(result.projection.revision);
      this.#programs = parseAuthoritativeEditorProgramsV1(result.projection.programs);
      this.#pending = null;
      this.#pendingSession = null;
      this.#sessionGeneration = 0n;
      this.#recovery = "tail";
      this.#tailRecoveryAccepted = false;
      await this.#recoverTailV1(signal);
      return await this.#openSessionAtHeadV1(signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async commit(
    mutationValue: EditorEditMutationV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentAuthorityCommitOutcomeV1>;
  async commit(
    mutationValue: EditorEditMutationV1,
    options: EditorDocumentAuthorityCommitOptionsV1,
  ): Promise<EditorDocumentAuthorityCommitOutcomeV1>;
  async commit(
    mutationValue: EditorEditMutationV1,
    optionsOrSignal?: AbortSignal | EditorDocumentAuthorityCommitOptionsV1,
  ): Promise<EditorDocumentAuthorityCommitOutcomeV1> {
    const options = abortSignalV1(optionsOrSignal)
      ? { sessionSnapshot: undefined, signal: optionsOrSignal }
      : { sessionSnapshot: optionsOrSignal?.sessionSnapshot, signal: optionsOrSignal?.signal };
    const signal = options.signal;
    const document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before committing.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    if (this.#recovery === "tail") {
      authorityErrorV1("Finish reconciling the accepted Editor mutation before committing another edit.", "conflict");
    }
    if (this.#pendingSession) {
      authorityErrorV1("Resolve the private Editor session save before committing another edit.", "session-conflict");
    }
    const mutation = parseEditorEditMutationV1(mutationValue);
    const canonicalMutation = canonicalJsonV1(mutation);
    const baseRevision = this.#revision.toString(10);
    let sessionSnapshot: EditorSessionSnapshotV1 | undefined;
    let canonicalSessionSnapshot: string | null = null;
    if (options.sessionSnapshot !== undefined) {
      sessionSnapshot = parseEditorSessionSnapshotV1(options.sessionSnapshot);
      const applied = applyEditorEditMutationV1(this.#programs, mutation);
      if (applied.kind !== "applied") {
        authorityErrorV1("The planned private session cannot accompany an invalid Editor mutation.", "conflict");
      }
      assertSessionProjectionV1(
        sessionSnapshot,
        applied.programs,
        "The planned private session does not match the post-mutation projection.",
      );
      canonicalSessionSnapshot = canonicalEditorSessionSnapshotJsonV1(sessionSnapshot);
    }
    if (
      this.#pending &&
      (this.#pending.baseRevision !== baseRevision ||
        this.#pending.canonicalMutation !== canonicalMutation ||
        this.#pending.canonicalSessionSnapshot !== canonicalSessionSnapshot)
    ) {
      authorityErrorV1(
        "The previous Editor mutation has an unknown outcome; only the exact same mutation may be retried.",
        "conflict",
      );
    }
    const pending =
      this.#pending ??
      Object.freeze({
        baseRevision,
        canonicalMutation,
        canonicalSessionSnapshot,
        request: editorDocumentCommitRequestSchemaV1.parse({
          baseRevision,
          clientMutationId: this.randomUuid(),
          epoch: document.epoch,
          mutation,
          ...(sessionSnapshot
            ? {
                sessionUpdate: {
                  documentRevision: (this.#revision + 1n).toString(10),
                  expectedSessionGeneration: this.#sessionGeneration.toString(10),
                  snapshot: sessionSnapshot,
                  snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
                },
              }
            : {}),
        }),
      });
    this.#pending = pending;
    this.#inFlight = true;
    try {
      return await this.#submitPendingV1(pending, signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async saveSession(
    snapshotValue: EditorSessionSnapshotV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentAuthoritySessionSaveOutcomeV1> {
    const document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before saving its private session.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    if (this.#pending || this.#recovery === "tail") {
      authorityErrorV1("Finish recovering the Editor document before saving its private session.", "conflict");
    }
    const snapshot = parseEditorSessionSnapshotV1(snapshotValue);
    assertSessionProjectionV1(
      snapshot,
      this.#programs,
      "The private Editor session does not match the authoritative projection.",
    );
    const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(snapshot);
    if (this.#pendingSession && this.#pendingSession.canonicalSnapshot !== canonicalSnapshot) {
      authorityErrorV1(
        "The previous private Editor session save has an unknown outcome; only the exact same snapshot may be retried.",
        "session-conflict",
      );
    }
    const pending =
      this.#pendingSession ??
      Object.freeze({
        canonicalSnapshot,
        request: editorDocumentSessionPutRequestSchemaV1.parse({
          documentRevision: this.#revision.toString(10),
          epoch: document.epoch,
          expectedSessionGeneration: this.#sessionGeneration.toString(10),
          snapshot,
          snapshotVersion: EDITOR_SESSION_SNAPSHOT_VERSION_V1,
        }),
      });
    this.#pendingSession = pending;
    this.#inFlight = true;
    try {
      return await this.#submitPendingSessionV1(pending, signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async retrySession(signal?: AbortSignal): Promise<EditorDocumentAuthoritySessionSaveOutcomeV1> {
    if (!this.#document) authorityErrorV1("Open the Editor document before retrying its private session.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    const pending = this.#pendingSession;
    if (!pending) authorityErrorV1("The Editor authority has no recoverable private session save.", "session-conflict");
    this.#inFlight = true;
    try {
      return await this.#submitPendingSessionV1(pending, signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async retry(signal?: AbortSignal): Promise<EditorDocumentAuthorityCommitOutcomeV1> {
    if (!this.#document) authorityErrorV1("Open the Editor document before retrying.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    const pending = this.#pending;
    if (!pending && this.#recovery !== "tail") {
      authorityErrorV1("The Editor authority has no recoverable request.", "conflict");
    }
    this.#inFlight = true;
    try {
      if (pending) return await this.#submitPendingV1(pending, signal);
      const accepted = this.#tailRecoveryAccepted;
      const reconciled = await this.#recoverTailV1(signal);
      return {
        accepted,
        kind: "reconciled",
        sessionInvalidated: reconciled.sessionInvalidated,
        snapshot: reconciled.snapshot,
      };
    } finally {
      this.#inFlight = false;
    }
  }

  async reconcile(signal?: AbortSignal) {
    if (!this.#document) authorityErrorV1("Open the Editor document before reconciling.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    if (this.#pendingSession) {
      authorityErrorV1("Resolve the private Editor session save before reconciling remote edits.", "session-conflict");
    }
    this.#inFlight = true;
    this.#recovery = "tail";
    this.#tailRecoveryAccepted = false;
    try {
      return await this.#recoverTailV1(signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async #openSessionAtHeadV1(signal?: AbortSignal): Promise<EditorDocumentAuthorityOpenOutcomeV1> {
    for (let attempt = 0; attempt < MAX_OPEN_SESSION_RECONCILIATIONS_V1; attempt += 1) {
      const document = this.#document;
      if (!document) authorityErrorV1("Open the Editor document before reading its private session.", "not-open");
      const sessionResult = await this.client.readSession(
        this.identity,
        document.documentKey,
        { epoch: document.epoch },
        signal,
      );
      let session: EditorSessionSnapshotV1 | null = null;
      let sessionGeneration: bigint;
      if (sessionResult.kind === "available") {
        const stored = sessionResult.session;
        assertSessionIdentityV1(stored, this.identity, document);
        const sessionRevision = revisionV1(stored.documentRevision);
        if (sessionRevision < this.#revision) {
          authorityErrorV1(
            "The Editor service returned a private session for a stale document revision.",
            "corrupt-response",
          );
        }
        if (sessionRevision > this.#revision) {
          this.#recovery = "tail";
          await this.#recoverTailV1(signal);
          continue;
        }
        session = await parseVerifiedSessionSnapshotV1(stored);
        try {
          assertSessionProjectionV1(
            session,
            this.#programs,
            "The Editor service returned a private session outside its authoritative projection.",
          );
        } catch (error) {
          if (error instanceof EditorDocumentAuthorityErrorV1 && error.code === "session-conflict") {
            authorityErrorV1(error.message, "corrupt-response");
          }
          throw error;
        }
        sessionGeneration = revisionV1(stored.sessionGeneration);
      } else {
        sessionGeneration = revisionV1(sessionResult.currentSessionGeneration);
        const revisionBeforeVerification = this.#revision;
        this.#recovery = "tail";
        await this.#recoverTailV1(signal);
        if (this.#revision !== revisionBeforeVerification) continue;
      }

      this.#sessionGeneration = sessionGeneration;
      return Object.freeze({
        ...snapshotV1(document, this.#revision, this.#programs, this.#sessionGeneration),
        session,
      });
    }
    authorityErrorV1("The Editor document kept changing while its private session opened.", "conflict");
  }

  async #submitPendingSessionV1(
    pending: PendingSessionSaveV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentAuthoritySessionSaveOutcomeV1> {
    const document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before saving its private session.", "not-open");
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.client.putSession(this.identity, document.documentKey, pending.request, signal);
        break;
      } catch (error) {
        const outcomeUnknown = editorCommitOutcomeMayBeUnknownV1(error);
        if (attempt === 0 && !signal?.aborted && outcomeUnknown) continue;
        if (!outcomeUnknown) this.#pendingSession = null;
        throw error;
      }
    }
    if (result.kind === "conflict") {
      this.#pendingSession = null;
      if (result.reason === "session-generation-mismatch") {
        authorityErrorV1(
          "The private Editor session changed in another request; reopen before saving again.",
          "session-conflict",
        );
      }
      if (result.reason === "revision-mismatch") {
        this.#recovery = "tail";
        this.#tailRecoveryAccepted = false;
        const reconciled = await this.#recoverTailV1(signal);
        return { kind: "reconciled", snapshot: reconciled.snapshot } as const;
      }
      authorityErrorV1(`The private Editor session was rejected (${result.reason}).`, "conflict");
    }

    try {
      assertSessionIdentityV1(result.session, this.identity, document);
      const responseSnapshot = await parseVerifiedSessionSnapshotV1(result.session);
      if (
        result.session.documentRevision !== pending.request.documentRevision ||
        BigInt(result.session.sessionGeneration) !== BigInt(pending.request.expectedSessionGeneration) + 1n ||
        result.session.snapshotVersion !== pending.request.snapshotVersion ||
        canonicalEditorSessionSnapshotJsonV1(responseSnapshot) !== pending.canonicalSnapshot
      ) {
        authorityErrorV1("The Editor service acknowledged a different private session save.", "corrupt-response");
      }
      this.#sessionGeneration = revisionV1(result.session.sessionGeneration);
    } catch (error) {
      this.#pendingSession = null;
      throw error;
    }
    this.#pendingSession = null;
    return {
      kind: "stored",
      replayed: result.replayed,
      sessionGeneration: this.#sessionGeneration.toString(10),
    };
  }

  async #submitPendingV1(
    pending: PendingMutationV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentAuthorityCommitOutcomeV1> {
    const document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before committing.", "not-open");
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.client.commit(this.identity, document.documentKey, pending.request, signal);
        break;
      } catch (error) {
        const outcomeUnknown = editorCommitOutcomeMayBeUnknownV1(error);
        if (attempt === 0 && !signal?.aborted && outcomeUnknown) continue;
        if (!outcomeUnknown) this.#pending = null;
        throw error;
      }
    }
    if (result.kind === "conflict") {
      this.#pending = null;
      if (result.reason === "session-generation-mismatch") {
        authorityErrorV1(
          "The private Editor session changed in another request; reopen before committing again.",
          "session-conflict",
        );
      }
      if (result.reason !== "revision-mismatch") {
        authorityErrorV1(`The Editor mutation was rejected (${result.reason}).`, "conflict");
      }
      this.#recovery = "tail";
      this.#tailRecoveryAccepted = false;
      const reconciled = await this.#recoverTailV1(signal);
      return {
        accepted: false,
        kind: "reconciled",
        sessionInvalidated: reconciled.sessionInvalidated,
        snapshot: reconciled.snapshot,
      };
    }

    try {
      assertDocumentIdentityV1(result.document, this.identity, {
        documentKey: document.documentKey,
        epoch: document.epoch,
      });
      assertEventIdentityV1(result.event, this.identity, document);
      if (
        result.event.clientMutationId !== pending.request.clientMutationId ||
        result.event.baseRevision !== pending.request.baseRevision ||
        canonicalJsonV1(result.event.mutation) !== pending.canonicalMutation
      ) {
        authorityErrorV1("The Editor service acknowledged a different mutation request.", "corrupt-response");
      }
      await assertCommittedSessionEvidenceV1(result.sessionUpdate, pending.request);
      const applied = applyEventV1(this.#programs, this.#revision, result.event);
      this.#programs = applied.programs;
      this.#revision = applied.revision;
      if (result.sessionUpdate) this.#sessionGeneration = revisionV1(result.sessionUpdate.sessionGeneration);
      this.#document = result.document;
      if (revisionV1(result.document.revision) < this.#revision) {
        authorityErrorV1("The Editor commit response regressed its document revision.", "corrupt-response");
      }
    } catch (error) {
      this.#pending = null;
      throw error;
    }
    this.#pending = null;
    if (revisionV1(result.document.revision) > this.#revision) {
      this.#recovery = "tail";
      this.#tailRecoveryAccepted = true;
      const reconciled = await this.#recoverTailV1(signal);
      return {
        accepted: true,
        kind: "reconciled",
        sessionInvalidated: true,
        snapshot: reconciled.snapshot,
      };
    }
    this.#recovery = null;
    this.#tailRecoveryAccepted = false;
    return {
      kind: "committed",
      sessionInvalidated: result.sessionUpdate === undefined,
      snapshot: snapshotV1(this.#document, this.#revision, this.#programs, this.#sessionGeneration),
    };
  }

  async #recoverTailV1(signal?: AbortSignal) {
    try {
      const reconciled = await this.#reconcileV1(signal);
      this.#recovery = null;
      this.#tailRecoveryAccepted = false;
      return reconciled;
    } catch (error) {
      if (error instanceof EditorDocumentAuthorityErrorV1 || !editorCommitOutcomeMayBeUnknownV1(error)) {
        this.#recovery = null;
        this.#tailRecoveryAccepted = false;
      }
      throw error;
    }
  }

  async #reconcileV1(signal?: AbortSignal) {
    let document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before reconciling.", "not-open");
    const startingRevision = this.#revision;
    let reconciledEvents = 0;
    while (true) {
      const result = await this.client.tail(
        this.identity,
        document.documentKey,
        { afterRevision: this.#revision.toString(10), epoch: document.epoch, limit: "32" },
        signal,
      );
      if (result === null) authorityErrorV1("The Editor document disappeared during reconciliation.", "conflict");
      assertDocumentIdentityV1(result.document, this.identity, {
        documentKey: document.documentKey,
        epoch: document.epoch,
      });
      if (revisionV1(result.document.revision) < this.#revision) {
        authorityErrorV1("The Editor event tail regressed its document revision.", "corrupt-response");
      }
      for (const event of result.events) {
        assertEventIdentityV1(event, this.identity, document);
        const applied = applyEventV1(this.#programs, this.#revision, event);
        this.#programs = applied.programs;
        this.#revision = applied.revision;
        reconciledEvents += 1;
        if (reconciledEvents > MAX_RECONCILED_EDITOR_EVENTS_V1) {
          authorityErrorV1("The Editor event tail exceeded the bounded reconciliation budget.", "conflict");
        }
      }
      document = result.document;
      this.#document = document;
      if (this.#revision === revisionV1(document.revision)) break;
      if (result.events.length === 0) {
        authorityErrorV1("The Editor service returned an incomplete event tail.", "corrupt-response");
      }
    }
    return {
      changed: this.#revision !== startingRevision,
      sessionInvalidated: this.#revision !== startingRevision,
      snapshot: snapshotV1(document, this.#revision, this.#programs, this.#sessionGeneration),
    } as const;
  }
}
