import { describe, expect, it } from "vitest";
import {
  collaborationMutationForApplyV1,
  collaborationMutationForRedoV1,
  collaborationMutationForUndoV1,
} from "./editor-collaboration-mutation";
import type { EditorProgramRecord } from "./editor-session-store";

function record(transactionId: string, resolvedSeconds: number): EditorProgramRecord {
  const operationId = `${transactionId}/wait`;
  return {
    program: {
      anchor: {
        capturedPlayhead: resolvedSeconds,
        evidence: [],
        resolvedSeconds,
        source: { kind: "absolute", seconds: resolvedSeconds },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          eventKind: "wait",
          id: operationId,
          interval: { end: resolvedSeconds + 1, start: resolvedSeconds },
          kind: "InsertTimelineEvent",
          label: transactionId,
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operationId] },
      transactionId,
      version: 1,
    },
    validation: { issues: [], status: "valid" },
  };
}

describe("collaborative editor mutation projection", () => {
  it("represents append undo and redo as new immutable events", () => {
    const value = record("created-circle", 2);
    const localMutation = { index: 0, kind: "append", value } as const;

    expect(collaborationMutationForApplyV1(localMutation)).toEqual({ kind: "append", program: value.program });
    expect(collaborationMutationForUndoV1(localMutation)).toEqual({
      kind: "remove",
      program: value.program,
      targetTransactionId: "created-circle",
    });
    expect(collaborationMutationForRedoV1(localMutation)).toEqual({ kind: "append", program: value.program });
  });

  it("preserves transaction identity while projecting replace undo and redo", () => {
    const previous = record("motion", 3);
    const value = record("motion", 5);
    const localMutation = { index: 0, kind: "replace", previous, value } as const;

    expect(collaborationMutationForApplyV1(localMutation)).toEqual({
      kind: "replace",
      program: value.program,
      targetTransactionId: "motion",
    });
    expect(collaborationMutationForUndoV1(localMutation)).toEqual({
      kind: "replace",
      program: previous.program,
      targetTransactionId: "motion",
    });
    expect(collaborationMutationForRedoV1(localMutation)).toEqual({
      kind: "replace",
      program: value.program,
      targetTransactionId: "motion",
    });
  });
});
