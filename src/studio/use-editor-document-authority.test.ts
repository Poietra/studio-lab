import { describe, expect, it, vi } from "vitest";

import {
  editorDocumentAuthorityStateAfterJournalStorageFailureV1,
  editorDocumentSessionFlushAllowsTransitionV1,
  installEditorAuthorityBasisAfterJournalSettlementV1,
} from "./use-editor-document-authority";

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
