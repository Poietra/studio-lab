import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentTailQuerySchemaV1,
  editorDocumentViewSchemaV1,
  parseEditorDocumentTailQueryV1,
  serializeEditorDocumentCommitResultV1,
  serializeEditorDocumentOpenResultV1,
  serializeEditorDocumentTailResultV1,
  serializeEditorDocumentViewV1,
  serializeEditorEditEventViewV1,
} from "./editor-document-http-contract";

const DOCUMENT_KEY = "b".repeat(64);
const SOURCE_HASH = "a".repeat(64);
const EVENT_DIGEST = "c".repeat(64);
const EPOCH = "00000000-0000-4000-8000-000000000001";
const MUTATION_ID = "00000000-0000-4000-8000-000000000002";
const SUBJECT_ID = "00000000-0000-4000-8000-000000000003";

function program(transactionId = "motion"): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 1, y: 0 },
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

const document = {
  documentKey: DOCUMENT_KEY,
  epoch: EPOCH,
  openedAt: new Date("2026-08-01T01:02:03.004Z"),
  projectId: "project-a",
  revision: 9_007_199_254_740_993n,
  sealedAt: null,
  sourceHash: SOURCE_HASH,
  sourcePath: "scene.py",
  tenantId: "tenant-a",
  updatedAt: new Date("2026-08-01T02:03:04.005Z"),
} as const;

const event = {
  baseRevision: document.revision,
  byteSize: 128,
  clientMutationId: MUTATION_ID,
  committedAt: new Date("2026-08-01T02:03:04.006Z"),
  digest: EVENT_DIGEST,
  documentKey: DOCUMENT_KEY,
  epoch: EPOCH,
  mutation: { kind: "append" as const, program: program() },
  projectId: "project-a",
  revision: document.revision + 1n,
  subjectId: SUBJECT_ID,
  tenantId: "tenant-a",
} as const;

describe("editor document HTTP requests", () => {
  it("strictly accepts only the browser-owned open fields", () => {
    const request = { sceneName: "ExampleScene", sourceHash: SOURCE_HASH, sourcePath: "scene.py" };
    expect(editorDocumentOpenRequestSchemaV1.parse(request)).toEqual(request);
    expect(editorDocumentOpenRequestSchemaV1.safeParse({ ...request, tenantId: "forged" }).success).toBe(false);
    expect(editorDocumentOpenRequestSchemaV1.safeParse({ ...request, projectId: "forged" }).success).toBe(false);
    expect(
      editorDocumentOpenRequestSchemaV1.safeParse({ ...request, sceneId: `scene:${"d".repeat(64)}` }).success,
    ).toBe(false);
    expect(editorDocumentOpenRequestSchemaV1.safeParse({ ...request, sceneName: "Not.A.Scene" }).success).toBe(false);
    expect(editorDocumentOpenRequestSchemaV1.safeParse({ ...request, sceneName: "S".repeat(241) }).success).toBe(false);
  });

  it.each([
    ["append", { kind: "append", program: program("append") }],
    ["replace", { kind: "replace", program: program("replace"), targetTransactionId: "replace" }],
    ["remove", { kind: "remove", program: program("remove"), targetTransactionId: "remove" }],
  ])("accepts a canonical decimal revision and the %s mutation", (_label, mutation) => {
    const request = {
      baseRevision: "9007199254740993",
      clientMutationId: MUTATION_ID,
      epoch: EPOCH,
      mutation,
    };
    expect(editorDocumentCommitRequestSchemaV1.parse(request)).toEqual(request);
  });

  it.each([0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER])("rejects numeric revision %s", (baseRevision) => {
    expect(
      editorDocumentCommitRequestSchemaV1.safeParse({
        baseRevision,
        clientMutationId: MUTATION_ID,
        epoch: EPOCH,
        mutation: { kind: "append", program: program() },
      }).success,
    ).toBe(false);
  });

  it.each(["", "-1", "+1", "01", "1.0", "1e3", " 1", "9223372036854775808"])(
    "rejects malformed or out-of-range revision %j",
    (baseRevision) => {
      expect(
        editorDocumentCommitRequestSchemaV1.safeParse({
          baseRevision,
          clientMutationId: MUTATION_ID,
          epoch: EPOCH,
          mutation: { kind: "append", program: program() },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown request and nested mutation fields", () => {
    const base = {
      baseRevision: "0",
      clientMutationId: MUTATION_ID,
      epoch: EPOCH,
      mutation: { kind: "append" as const, program: program() },
    };
    expect(editorDocumentCommitRequestSchemaV1.safeParse({ ...base, subjectId: SUBJECT_ID }).success).toBe(false);
    expect(
      editorDocumentCommitRequestSchemaV1.safeParse({
        ...base,
        mutation: { ...base.mutation, tenantId: "forged" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["anchor", (value: CanonicalEditProgram) => ({ ...value, anchor: { ...value.anchor, unknown: true } })],
    [
      "anchor source",
      (value: CanonicalEditProgram) => ({
        ...value,
        anchor: { ...value.anchor, source: { ...value.anchor.source, unknown: true } },
      }),
    ],
    ["schedule", (value: CanonicalEditProgram) => ({ ...value, schedule: { ...value.schedule, unknown: true } })],
    [
      "program provenance",
      (value: CanonicalEditProgram) => ({ ...value, provenance: { ...value.provenance, unknown: true } }),
    ],
    [
      "operation",
      (value: CanonicalEditProgram) => ({
        ...value,
        operations: [{ ...value.operations[0]!, unknown: true }],
      }),
    ],
    [
      "operation provenance",
      (value: CanonicalEditProgram) => ({
        ...value,
        operations: [{ ...value.operations[0]!, provenance: { ...value.operations[0]!.provenance, unknown: true } }],
      }),
    ],
    [
      "operation variant payload",
      (value: CanonicalEditProgram) => {
        const operation = value.operations[0]!;
        if (operation.kind !== "CreateMotion") throw new Error("The fixture must contain CreateMotion.");
        return {
          ...value,
          operations: [{ ...operation, controlOffset: { ...operation.controlOffset, unknown: true } }],
        };
      },
    ],
  ])("rejects an unknown field inside %s", (_label, mutate) => {
    expect(
      editorDocumentCommitRequestSchemaV1.safeParse({
        baseRevision: "0",
        clientMutationId: MUTATION_ID,
        epoch: EPOCH,
        mutation: { kind: "append", program: mutate(program()) },
      }).success,
    ).toBe(false);
  });

  it("parses a strict tail query without collapsing repeated parameters", () => {
    const query = new URLSearchParams({ afterRevision: "9007199254740993", epoch: EPOCH, limit: "32" });
    expect(parseEditorDocumentTailQueryV1(query)).toEqual({
      afterRevision: "9007199254740993",
      epoch: EPOCH,
      limit: "32",
    });

    query.append("limit", "1");
    expect(() => parseEditorDocumentTailQueryV1(query)).toThrow(/exactly once/i);
    expect(editorDocumentTailQuerySchemaV1.safeParse({ afterRevision: "0", epoch: EPOCH, limit: "33" }).success).toBe(
      false,
    );
    expect(
      editorDocumentTailQuerySchemaV1.safeParse({ afterRevision: "0", epoch: EPOCH, extra: "1", limit: "1" }).success,
    ).toBe(false);
    expect(() =>
      parseEditorDocumentTailQueryV1(new URLSearchParams({ afterRevision: "0", epoch: EPOCH, extra: "1", limit: "1" })),
    ).toThrow();
    expect(parseEditorDocumentTailQueryV1(new URLSearchParams({ afterRevision: "0", epoch: EPOCH }))).toEqual({
      afterRevision: "0",
      epoch: EPOCH,
      limit: "32",
    });
  });
});

describe("editor document HTTP views", () => {
  it("losslessly serializes bigint revisions and Date timestamps", () => {
    const documentView = serializeEditorDocumentViewV1(document);
    const eventView = serializeEditorEditEventViewV1(event);

    expect(documentView).toMatchObject({
      openedAt: "2026-08-01T01:02:03.004Z",
      revision: "9007199254740993",
      sealedAt: null,
      updatedAt: "2026-08-01T02:03:04.005Z",
    });
    expect(eventView).toMatchObject({
      baseRevision: "9007199254740993",
      committedAt: "2026-08-01T02:03:04.006Z",
      revision: "9007199254740994",
    });
    expect(() => JSON.stringify({ document: documentView, event: eventView })).not.toThrow();
  });

  it("serializes every open result without leaking extra repository fields", () => {
    expect(serializeEditorDocumentOpenResultV1({ created: true, document, kind: "opened" })).toMatchObject({
      created: true,
      document: { revision: "9007199254740993" },
      kind: "opened",
    });
    expect(serializeEditorDocumentOpenResultV1({ kind: "not-found" })).toEqual({ kind: "not-found" });
    expect(serializeEditorDocumentOpenResultV1({ currentSourceHash: EVENT_DIGEST, kind: "source-conflict" })).toEqual({
      currentSourceHash: EVENT_DIGEST,
      kind: "source-conflict",
    });
  });

  it("serializes committed, conflict, tail, and missing-tail results", () => {
    expect(
      serializeEditorDocumentCommitResultV1({ document, event, kind: "committed", replayed: false }),
    ).toMatchObject({
      document: { revision: "9007199254740993" },
      event: { revision: "9007199254740994" },
      kind: "committed",
      replayed: false,
    });
    expect(
      serializeEditorDocumentCommitResultV1({
        currentRevision: 9_007_199_254_740_993n,
        kind: "conflict",
        reason: "revision-mismatch",
      }),
    ).toEqual({ currentRevision: "9007199254740993", kind: "conflict", reason: "revision-mismatch" });
    expect(serializeEditorDocumentTailResultV1({ document, events: [event] })).toMatchObject({
      document: { revision: "9007199254740993" },
      events: [{ revision: "9007199254740994" }],
    });
    expect(serializeEditorDocumentTailResultV1(null)).toBeNull();
  });

  it.each([
    "document-sealed",
    "forbidden",
    "invalid-mutation",
    "mutation-reused",
    "not-found",
    "revision-mismatch",
    "source-changed",
  ] as const)("preserves the %s conflict reason", (reason) => {
    expect(serializeEditorDocumentCommitResultV1({ kind: "conflict", reason })).toEqual({ kind: "conflict", reason });
  });

  it("fails closed on malformed wire views and invalid serialization inputs", () => {
    const view = serializeEditorDocumentViewV1(document);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, revision: 1 }).success).toBe(false);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, openedAt: "2026-08-01" }).success).toBe(false);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, internal: true }).success).toBe(false);
    expect(
      editorDocumentCommitResultViewSchemaV1.safeParse({
        currentRevision: 1,
        kind: "conflict",
        reason: "revision-mismatch",
      }).success,
    ).toBe(false);
    expect(() => serializeEditorDocumentViewV1({ ...document, revision: 9_223_372_036_854_775_808n })).toThrow();
    expect(() => serializeEditorDocumentViewV1({ ...document, updatedAt: new Date(Number.NaN) })).toThrow();
    expect(() => serializeEditorDocumentTailResultV1({ document, events: Array(33).fill(event) })).toThrow();
  });
});
