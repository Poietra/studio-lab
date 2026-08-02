import { randomUUID } from "node:crypto";

import {
  applyEditorEditMutationV1,
  canonicalEditorProgramV1,
  canonicalEditorSessionSnapshotV1,
  createEditorDocumentKeyV1,
  type EditorDocumentRepositoryV1,
  type EditorDocumentV1,
  type EditorEditEventV1,
  type EditorSessionSnapshotPutInputV1,
  type EditorSessionSnapshotRecordV1,
  parseEditorDocumentCommitInputV1,
  parseEditorDocumentOpenInputV1,
  parseEditorDocumentTailInputV1,
  parseEditorSessionSnapshotPutInputV1,
  parseEditorSessionSnapshotReadInputV1,
} from "../server/storage/editor-document-repository";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { CanonicalEditProgram } from "../src/studio/operations";

type AccountEditorDocumentMemoryRepositoryOptionsV1 = Readonly<{
  projectId: string;
  sourceHash: string;
  sourcePath: string;
  subjectId: string;
  tenantId: string;
}>;

function snapshotMatchesProgramsV1(
  snapshot: EditorSessionSnapshotPutInputV1["snapshot"],
  programs: readonly CanonicalEditProgram[],
) {
  return (
    snapshot.appliedPrograms.length === programs.length &&
    snapshot.appliedPrograms.every(
      (record, index) => canonicalJsonV1(record.program) === canonicalJsonV1(programs[index]!),
    )
  );
}

/** Session-focused authority for the production browser harness. */
export class AccountEditorDocumentMemoryRepositoryV1 implements EditorDocumentRepositoryV1 {
  #document: EditorDocumentV1 | null = null;
  #events: EditorEditEventV1[] = [];
  #programs: readonly CanonicalEditProgram[] = [];
  #session: EditorSessionSnapshotRecordV1 | null = null;

  constructor(private readonly options: AccountEditorDocumentMemoryRepositoryOptionsV1) {}

  close() {
    return Promise.resolve();
  }

  ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve(true);
  }

  reset() {
    this.#document = null;
    this.#events = [];
    this.#programs = [];
    this.#session = null;
  }

  openDocument(inputValue: Parameters<EditorDocumentRepositoryV1["openDocument"]>[0], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = parseEditorDocumentOpenInputV1(inputValue);
    if (
      input.tenantId !== this.options.tenantId ||
      input.projectId !== this.options.projectId ||
      input.sourcePath !== this.options.sourcePath
    ) {
      return Promise.resolve({ kind: "not-found" } as const);
    }
    if (input.sourceHash !== this.options.sourceHash) {
      return Promise.resolve({ currentSourceHash: this.options.sourceHash, kind: "source-conflict" } as const);
    }

    const documentKey = createEditorDocumentKeyV1(input.sourcePath, input.sceneId);
    if (this.#document) {
      if (this.#document.documentKey !== documentKey) return Promise.resolve({ kind: "not-found" } as const);
      return Promise.resolve({
        created: false,
        document: this.#document,
        kind: "opened",
        projection: { programs: this.#programs, revision: this.#document.revision },
      } as const);
    }

    const now = new Date();
    this.#document = {
      documentKey,
      epoch: randomUUID(),
      openedAt: now,
      projectId: input.projectId,
      revision: 0n,
      sealedAt: null,
      sourceHash: input.sourceHash,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
      updatedAt: now,
    };
    return Promise.resolve({
      created: true,
      document: this.#document,
      kind: "opened",
      projection: { programs: this.#programs, revision: this.#document.revision },
    } as const);
  }

  readSessionSnapshot(
    inputValue: Parameters<EditorDocumentRepositoryV1["readSessionSnapshot"]>[0],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const input = parseEditorSessionSnapshotReadInputV1(inputValue);
    const session = this.#session;
    if (!this.sameSubject(input) || !session || session.epoch !== input.epoch) {
      return Promise.resolve({ currentSessionGeneration: 0n, kind: "unavailable" } as const);
    }
    if (
      !this.#document ||
      this.#document.epoch !== input.epoch ||
      session.documentRevision !== this.#document.revision ||
      !snapshotMatchesProgramsV1(session.snapshot, this.#programs)
    ) {
      return Promise.resolve({ currentSessionGeneration: session.sessionGeneration, kind: "unavailable" } as const);
    }
    return Promise.resolve({ kind: "available", session } as const);
  }

  putSessionSnapshot(
    inputValue: Parameters<EditorDocumentRepositoryV1["putSessionSnapshot"]>[0],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const input = parseEditorSessionSnapshotPutInputV1(inputValue);
    if (!this.sameSubject(input)) return Promise.resolve({ kind: "conflict", reason: "forbidden" } as const);
    if (!this.#document || this.#document.documentKey !== input.documentKey) {
      return Promise.resolve({ kind: "conflict", reason: "not-found" } as const);
    }
    if (this.#document.epoch !== input.epoch) {
      return Promise.resolve({ kind: "conflict", reason: "epoch-mismatch" } as const);
    }
    if (this.#document.revision !== input.documentRevision) {
      return Promise.resolve({
        currentDocumentRevision: this.#document.revision,
        kind: "conflict",
        reason: "revision-mismatch",
      } as const);
    }
    if (!snapshotMatchesProgramsV1(input.snapshot, this.#programs)) {
      return Promise.resolve({
        currentDocumentRevision: this.#document.revision,
        kind: "conflict",
        reason: "projection-mismatch",
      } as const);
    }

    const prepared = this.prepareSession(input);
    if (prepared.kind === "conflict") return Promise.resolve(prepared);
    this.#session = prepared.session;
    return Promise.resolve({ kind: "stored", replayed: prepared.replayed, session: prepared.session } as const);
  }

  commitMutation(inputValue: Parameters<EditorDocumentRepositoryV1["commitMutation"]>[0], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = parseEditorDocumentCommitInputV1(inputValue);
    if (!this.sameSubject(input)) return Promise.resolve({ kind: "conflict", reason: "forbidden" } as const);
    if (!this.#document || this.#document.documentKey !== input.documentKey || this.#document.epoch !== input.epoch) {
      return Promise.resolve({ kind: "conflict", reason: "not-found" } as const);
    }
    if (this.#document.revision !== input.baseRevision) {
      return Promise.resolve({
        currentRevision: this.#document.revision,
        kind: "conflict",
        reason: "revision-mismatch",
      } as const);
    }
    const applied = applyEditorEditMutationV1(this.#programs, input.mutation);
    if (applied.kind !== "applied") {
      return Promise.resolve({
        currentRevision: this.#document.revision,
        kind: "conflict",
        reason: "invalid-mutation",
      } as const);
    }
    if (input.sessionUpdate && !snapshotMatchesProgramsV1(input.sessionUpdate.snapshot, applied.programs)) {
      return Promise.resolve({
        currentRevision: this.#document.revision,
        kind: "conflict",
        reason: "projection-mismatch",
      } as const);
    }
    const preparedSession = input.sessionUpdate
      ? this.prepareSession({
          ...input.sessionUpdate,
          documentKey: input.documentKey,
          epoch: input.epoch,
          projectId: input.projectId,
          subjectId: input.subjectId,
          tenantId: input.tenantId,
        })
      : null;
    if (preparedSession?.kind === "conflict") {
      return Promise.resolve({
        currentRevision: this.#document.revision,
        currentSessionGeneration: preparedSession.currentSessionGeneration,
        kind: "conflict",
        reason: preparedSession.reason,
      } as const);
    }

    const canonical = canonicalEditorProgramV1(input.mutation.program);
    const committedAt = new Date();
    const revision = input.baseRevision + 1n;
    const event: EditorEditEventV1 = {
      baseRevision: input.baseRevision,
      byteSize: canonical.byteSize,
      clientMutationId: input.clientMutationId,
      committedAt,
      digest: canonical.digest,
      documentKey: input.documentKey,
      epoch: input.epoch,
      mutation: input.mutation,
      projectId: input.projectId,
      revision,
      subjectId: input.subjectId,
      tenantId: input.tenantId,
    };
    this.#document = { ...this.#document, revision, updatedAt: committedAt };
    this.#events.push(event);
    this.#programs = applied.programs;
    if (preparedSession?.kind === "stored") this.#session = preparedSession.session;
    const sessionUpdate =
      preparedSession?.kind === "stored"
        ? {
            documentRevision: preparedSession.session.documentRevision,
            sessionGeneration: preparedSession.session.sessionGeneration,
            snapshotByteSize: preparedSession.session.snapshotByteSize,
            snapshotDigest: preparedSession.session.snapshotDigest,
            snapshotVersion: preparedSession.session.snapshotVersion,
          }
        : undefined;
    return Promise.resolve({
      document: this.#document,
      event,
      kind: "committed",
      replayed: false,
      ...(sessionUpdate ? { sessionUpdate } : {}),
    } as const);
  }

  readEventTail(inputValue: Parameters<EditorDocumentRepositoryV1["readEventTail"]>[0], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = parseEditorDocumentTailInputV1(inputValue);
    if (!this.#document || this.#document.documentKey !== input.documentKey || this.#document.epoch !== input.epoch) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      document: this.#document,
      events: this.#events.filter((event) => event.revision > input.afterRevision).slice(0, input.limit),
    });
  }

  private prepareSession(input: EditorSessionSnapshotPutInputV1) {
    const canonical = canonicalEditorSessionSnapshotV1(input.snapshot);
    if (
      this.#session &&
      this.#session.epoch === input.epoch &&
      this.#session.documentRevision === input.documentRevision &&
      this.#session.sessionGeneration === input.expectedSessionGeneration + 1n &&
      this.#session.snapshotVersion === input.snapshotVersion &&
      this.#session.snapshotDigest === canonical.digest &&
      this.#session.snapshotByteSize === canonical.byteSize &&
      canonicalEditorSessionSnapshotV1(this.#session.snapshot).json === canonical.json
    ) {
      return { kind: "stored", replayed: true, session: this.#session } as const;
    }
    const currentSessionGeneration = this.#session?.sessionGeneration ?? 0n;
    if (input.expectedSessionGeneration !== currentSessionGeneration) {
      return { currentSessionGeneration, kind: "conflict", reason: "session-generation-mismatch" } as const;
    }
    return {
      kind: "stored",
      replayed: false,
      session: {
        documentKey: input.documentKey,
        documentRevision: input.documentRevision,
        epoch: input.epoch,
        projectId: input.projectId,
        sessionGeneration: currentSessionGeneration + 1n,
        snapshot: canonical.snapshot,
        snapshotByteSize: canonical.byteSize,
        snapshotDigest: canonical.digest,
        snapshotVersion: input.snapshotVersion,
        subjectId: input.subjectId,
        tenantId: input.tenantId,
        updatedAt: new Date(),
      } satisfies EditorSessionSnapshotRecordV1,
    } as const;
  }

  private sameSubject(
    input: Readonly<{ documentKey: string; projectId: string; subjectId: string; tenantId: string }>,
  ) {
    return (
      input.tenantId === this.options.tenantId &&
      input.projectId === this.options.projectId &&
      input.subjectId === this.options.subjectId &&
      input.documentKey === this.#document?.documentKey
    );
  }
}
