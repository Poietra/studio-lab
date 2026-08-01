import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import type { CanonicalEditProgram } from "../studio/operations";
import {
  type EditorDocumentClientIdentityV1,
  type EditorDocumentClientV1,
  editorCommitOutcomeMayBeUnknownV1,
} from "./editor-document-client";
import type {
  EditorDocumentCommitRequestV1,
  EditorDocumentViewV1,
  EditorEditEventViewV1,
} from "./editor-document-http-contract";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentOpenRequestSchemaV1,
} from "./editor-document-http-contract";
import {
  applyEditorEditMutationV1,
  type EditorEditMutationV1,
  parseAuthoritativeEditorProgramsV1,
  parseEditorEditMutationV1,
} from "./editor-edit-mutation";

const MAX_RECONCILED_EDITOR_EVENTS_V1 = 512;

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
}>;

export type EditorDocumentAuthorityCommitOutcomeV1 =
  | Readonly<{ kind: "committed"; snapshot: EditorDocumentAuthoritySnapshotV1 }>
  | Readonly<{ kind: "reconciled"; snapshot: EditorDocumentAuthoritySnapshotV1 }>;

export type EditorDocumentAuthorityRecoveryKindV1 = "commit" | "tail";

export class EditorDocumentAuthorityErrorV1 extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "conflict" | "corrupt-response" | "not-open" | "source-conflict" | "unavailable",
  ) {
    super(message);
    this.name = "EditorDocumentAuthorityErrorV1";
  }
}

type PendingMutationV1 = Readonly<{
  baseRevision: string;
  canonicalMutation: string;
  request: EditorDocumentCommitRequestV1;
}>;

function revisionV1(value: string) {
  return BigInt(value);
}

async function sha256HexV1(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
): EditorDocumentAuthoritySnapshotV1 {
  if (revisionV1(document.revision) !== revision) {
    authorityErrorV1("The Editor document and local replica revisions do not match.", "corrupt-response");
  }
  return Object.freeze({ document, programs: Object.freeze([...programs]), revision: revision.toString(10) });
}

export class EditorDocumentAuthorityV1 {
  #document: EditorDocumentViewV1 | null = null;
  #inFlight = false;
  #pending: PendingMutationV1 | null = null;
  #programs: readonly CanonicalEditProgram[] = [];
  #recovery: "tail" | null = null;
  #revision = 0n;

  constructor(
    private readonly client: EditorDocumentClientV1,
    private readonly identity: EditorDocumentAuthorityIdentityV1,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
  ) {}

  get recoveryKind(): EditorDocumentAuthorityRecoveryKindV1 | null {
    if (this.#pending) return "commit";
    return this.#recovery;
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
      this.#recovery = "tail";
      return (await this.#recoverTailV1(signal)).snapshot;
    } finally {
      this.#inFlight = false;
    }
  }

  async commit(
    mutationValue: EditorEditMutationV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentAuthorityCommitOutcomeV1> {
    const document = this.#document;
    if (!document) authorityErrorV1("Open the Editor document before committing.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    if (this.#recovery === "tail") {
      authorityErrorV1("Finish reconciling the accepted Editor mutation before committing another edit.", "conflict");
    }
    const mutation = parseEditorEditMutationV1(mutationValue);
    const canonicalMutation = canonicalJsonV1(mutation);
    const baseRevision = this.#revision.toString(10);
    if (
      this.#pending &&
      (this.#pending.baseRevision !== baseRevision || this.#pending.canonicalMutation !== canonicalMutation)
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
        request: editorDocumentCommitRequestSchemaV1.parse({
          baseRevision,
          clientMutationId: this.randomUuid(),
          epoch: document.epoch,
          mutation,
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
      const reconciled = await this.#recoverTailV1(signal);
      return { kind: "reconciled", snapshot: reconciled.snapshot };
    } finally {
      this.#inFlight = false;
    }
  }

  async reconcile(signal?: AbortSignal) {
    if (!this.#document) authorityErrorV1("Open the Editor document before reconciling.", "not-open");
    if (this.#inFlight) authorityErrorV1("An Editor authority request is already active.", "busy");
    this.#inFlight = true;
    this.#recovery = "tail";
    try {
      return await this.#recoverTailV1(signal);
    } finally {
      this.#inFlight = false;
    }
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
      if (result.reason !== "revision-mismatch") {
        authorityErrorV1(`The Editor mutation was rejected (${result.reason}).`, "conflict");
      }
      this.#recovery = "tail";
      const reconciled = await this.#recoverTailV1(signal);
      return { kind: "reconciled", snapshot: reconciled.snapshot };
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
      const applied = applyEventV1(this.#programs, this.#revision, result.event);
      this.#programs = applied.programs;
      this.#revision = applied.revision;
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
      const reconciled = await this.#recoverTailV1(signal);
      return { kind: "reconciled", snapshot: reconciled.snapshot };
    }
    this.#recovery = null;
    return { kind: "committed", snapshot: snapshotV1(this.#document, this.#revision, this.#programs) };
  }

  async #recoverTailV1(signal?: AbortSignal) {
    try {
      const reconciled = await this.#reconcileV1(signal);
      this.#recovery = null;
      return reconciled;
    } catch (error) {
      if (error instanceof EditorDocumentAuthorityErrorV1 || !editorCommitOutcomeMayBeUnknownV1(error)) {
        this.#recovery = null;
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
      snapshot: snapshotV1(document, this.#revision, this.#programs),
    } as const;
  }
}
