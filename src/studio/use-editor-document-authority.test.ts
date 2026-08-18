import { describe, expect, it, vi } from "vitest";

import {
  EditorDocumentAuthorityErrorV1,
  type EditorDocumentAuthoritySnapshotV1,
} from "../collaboration/editor-document-authority";
import {
  editorDocumentAuthorityStateAfterJournalStorageFailureV1,
  editorDocumentExportLineageV1,
  editorDocumentSessionFlushAllowsTransitionV1,
  editorMutationJournalConflictIsDefinitiveV1,
  installEditorAuthorityBasisAfterJournalSettlementV1,
} from "./use-editor-document-authority";

describe("Editor Document export lineage", () => {
  it("captures immutable document, source, and durable working revision facts", () => {
    const snapshot = {
      document: {
        documentKey: "a".repeat(64),
        epoch: "00000000-0000-4000-8000-000000000001",
        openedAt: "2026-08-18T00:00:00.000Z",
        projectId: "project-a",
        revision: "0",
        sealedAt: null,
        sourceHash: "b".repeat(64),
        sourcePath: "scene.py",
        tenantId: "organization-a",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
      programs: [],
      revision: "0",
      sessionGeneration: "1",
    } satisfies EditorDocumentAuthoritySnapshotV1;

    expect(editorDocumentExportLineageV1(snapshot)).toEqual({
      documentEpoch: snapshot.document.epoch,
      documentKey: snapshot.document.documentKey,
      documentRevision: "0",
      projectId: "project-a",
      sourceHash: "b".repeat(64),
      sourcePath: "scene.py",
      workingRevision: "pristine",
    });
    expect(Object.isFrozen(editorDocumentExportLineageV1(snapshot))).toBe(true);
  });

  it("refuses a split document and projection revision", () => {
    const snapshot = {
      document: { revision: "1" },
      programs: [],
      revision: "2",
    } as unknown as EditorDocumentAuthoritySnapshotV1;
    expect(() => editorDocumentExportLineageV1(snapshot)).toThrow(/revision is inconsistent/i);
  });
});

describe("Editor document navigation flush policy", () => {
  it("allows durable document transitions but never treats an in-flight commit as flushed", () => {
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "stored" })).toBe(true);
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "journaled" })).toBe(true);
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "failed" })).toBe(false);
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "busy" })).toBe(false);
  });

  it("does not wedge account exit on a local persistence failure", () => {
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "failed" }, "account")).toBe(true);
    expect(editorDocumentSessionFlushAllowsTransitionV1({ kind: "busy" }, "account")).toBe(false);
  });

  it("keeps a storage failure visible without leaving the ready phase", () => {
    expect(
      editorDocumentAuthorityStateAfterJournalStorageFailureV1(
        {
          journalConflict: true,
          journalConflictAccountWide: true,
          journalConflictKind: "session",
          message: null,
          phase: "ready",
          retryable: false,
        },
        "Browser storage is unavailable.",
      ),
    ).toEqual({
      journalConflict: false,
      journalConflictAccountWide: false,
      journalConflictKind: null,
      message: "Browser storage is unavailable.",
      phase: "ready",
      retryable: false,
    });
  });
});

describe("Editor pending-session journal basis advance", () => {
  it("installs the newer authoritative basis only after the old lane is settled", () => {
    const install = vi.fn();
    const installed = installEditorAuthorityBasisAfterJournalSettlementV1({
      currentDocumentRevision: "4",
      install,
      nextDocumentRevision: "5",
      pendingLaneDocumentRevision: null,
    });

    expect(installed).toBe(true);
    expect(install).toHaveBeenCalledOnce();
  });

  it("preserves a stale lane and refuses to install a new basis", () => {
    const install = vi.fn();
    const installed = installEditorAuthorityBasisAfterJournalSettlementV1({
      currentDocumentRevision: "4",
      install,
      nextDocumentRevision: "5",
      pendingLaneDocumentRevision: "4",
    });

    expect(installed).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("accepts a lane already aligned to the next basis", () => {
    const alignedInstall = vi.fn();
    expect(
      installEditorAuthorityBasisAfterJournalSettlementV1({
        currentDocumentRevision: "4",
        install: alignedInstall,
        nextDocumentRevision: "5",
        pendingLaneDocumentRevision: "5",
      }),
    ).toBe(true);
    expect(alignedInstall).toHaveBeenCalledOnce();
  });
});

describe("Editor pending-mutation conflict policy", () => {
  it("exposes only definitive authority rejection while exact evidence is retained", () => {
    const conflict = new EditorDocumentAuthorityErrorV1("conflict", "conflict");
    const sessionConflict = new EditorDocumentAuthorityErrorV1("session conflict", "session-conflict");
    const corrupt = new EditorDocumentAuthorityErrorV1("corrupt", "corrupt-response");

    expect(editorMutationJournalConflictIsDefinitiveV1(conflict, true, null)).toBe(true);
    expect(editorMutationJournalConflictIsDefinitiveV1(sessionConflict, true, null)).toBe(true);
    expect(editorMutationJournalConflictIsDefinitiveV1(conflict, true, "commit")).toBe(false);
    expect(editorMutationJournalConflictIsDefinitiveV1(conflict, false, null)).toBe(false);
    expect(editorMutationJournalConflictIsDefinitiveV1(corrupt, true, null)).toBe(false);
  });
});
