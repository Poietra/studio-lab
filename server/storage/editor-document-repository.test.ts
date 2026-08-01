import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../../src/studio/operations";
import { canonicalEditorMutationV1, parseEditorDocumentCommitInputV1 } from "./editor-document-repository";

function program(transactionId = "motion"): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 20, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: `${transactionId}/motion`,
    interval: { end: 2, start: 1 },
    kind: "CreateMotion" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    targetEntityIds: ["equation"],
  };
  return {
    anchor: {
      capturedPlayhead: 1,
      evidence: [],
      resolvedSeconds: 1,
      source: { kind: "absolute", seconds: 1 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function commitValue(mutation: unknown) {
  return {
    baseRevision: 4n,
    clientMutationId: "10000000-0000-4000-8000-000000000001",
    documentKey: "a".repeat(64),
    epoch: "20000000-0000-4000-8000-000000000002",
    mutation,
    projectId: "project-a",
    subjectId: "30000000-0000-4000-8000-000000000003",
    tenantId: "tenant-a",
  };
}

describe("editor document mutation contract", () => {
  it("keeps the immutable evidence seal program-only while retaining mutation semantics", () => {
    const value = program();
    const append = canonicalEditorMutationV1({ kind: "append", program: value });
    const replace = canonicalEditorMutationV1({
      kind: "replace",
      program: value,
      targetTransactionId: value.transactionId,
    });

    expect(replace).toMatchObject({
      byteSize: append.byteSize,
      digest: append.digest,
      json: append.json,
      mutation: { kind: "replace", targetTransactionId: "motion" },
      program: value,
    });
  });

  it("parses a closed commit envelope and rejects legacy or incomplete mutation payloads", () => {
    const mutation = { kind: "remove", program: program(), targetTransactionId: "motion" } as const;
    expect(parseEditorDocumentCommitInputV1(commitValue(mutation))).toEqual({
      ...commitValue(mutation),
      mutation,
    });
    expect(() =>
      parseEditorDocumentCommitInputV1({
        ...commitValue(undefined),
        mutation: undefined,
        program: program(),
      }),
    ).toThrow();
    expect(() => parseEditorDocumentCommitInputV1(commitValue({ kind: "remove", program: program() }))).toThrow();
  });
});
