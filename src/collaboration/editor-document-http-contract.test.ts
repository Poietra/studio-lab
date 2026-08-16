import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentOpenRequestUnionSchemaV1,
  editorDocumentOpenResultViewSchemaV1,
  editorDocumentViewUnionSchemaV1,
  editorDocumentProjectionViewSchemaV1,
  editorDocumentSessionPutRequestSchemaV1,
  editorDocumentSessionPutResultViewSchemaV1,
  editorDocumentSessionViewSchemaV1,
  editorDocumentTailQuerySchemaV1,
  editorDocumentViewSchemaV1,
  parseEditorDocumentSessionQueryV1,
  parseEditorDocumentTailQueryV1,
  serializeEditorDocumentCommitResultV1,
  serializeEditorDocumentOpenResultV1,
  serializeEditorDocumentProjectionViewV1,
  serializeEditorDocumentSessionPutResultV1,
  serializeEditorDocumentSessionReadResultV1,
  serializeEditorDocumentSessionViewV1,
  serializeEditorDocumentTailResultV1,
  serializeEditorDocumentViewV1,
  serializeEditorEditEventViewV1,
} from "./editor-document-http-contract";
import { editorSessionSnapshotByteSizeV1 } from "./editor-session-contract";

const DOCUMENT_KEY = "b".repeat(64);
const SOURCE_HASH = "a".repeat(64);
const EVENT_DIGEST = "c".repeat(64);
const EPOCH = "00000000-0000-4000-8000-000000000001";
const MUTATION_ID = "00000000-0000-4000-8000-000000000002";
const SUBJECT_ID = "00000000-0000-4000-8000-000000000003";

const sessionSnapshot = {
  appliedPrograms: [],
  currentTime: 0,
  draftOperation: null,
  draftProgram: null,
  editingAppliedProgram: null,
  insertTool: "select",
  interactionMode: "position",
  motionDuration: 1,
  programUndoEntries: [],
  redoPrograms: [],
  selectedObjectIds: [],
  verifiedSourceDurationBasis: null,
} as const;

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

const projection = {
  programs: [program()],
  revision: document.revision,
} as const;

const session = {
  documentKey: DOCUMENT_KEY,
  documentRevision: document.revision,
  epoch: EPOCH,
  projectId: document.projectId,
  sessionGeneration: 2n,
  snapshot: sessionSnapshot,
  snapshotByteSize: editorSessionSnapshotByteSizeV1(sessionSnapshot),
  snapshotDigest: EVENT_DIGEST,
  snapshotVersion: 1,
  subjectId: SUBJECT_ID,
  tenantId: document.tenantId,
  updatedAt: new Date("2026-08-01T02:03:04.007Z"),
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

  it("strictly validates standalone and atomic session updates", () => {
    const put = {
      documentRevision: "9007199254740993",
      epoch: EPOCH,
      expectedSessionGeneration: "1",
      snapshot: sessionSnapshot,
      snapshotVersion: 1,
    } as const;
    expect(editorDocumentSessionPutRequestSchemaV1.parse(put)).toEqual(put);
    expect(editorDocumentSessionPutRequestSchemaV1.safeParse({ ...put, subjectId: SUBJECT_ID }).success).toBe(false);
    expect(
      editorDocumentSessionPutRequestSchemaV1.safeParse({
        ...put,
        expectedSessionGeneration: "9223372036854775807",
      }).success,
    ).toBe(false);
    expect(
      editorDocumentSessionPutRequestSchemaV1.safeParse({
        ...put,
        snapshot: { ...sessionSnapshot, internal: true },
      }).success,
    ).toBe(false);

    const atomic = {
      baseRevision: "0",
      clientMutationId: MUTATION_ID,
      epoch: EPOCH,
      mutation: { kind: "append" as const, program: program() },
      sessionUpdate: {
        documentRevision: "1",
        expectedSessionGeneration: "1",
        snapshot: sessionSnapshot,
        snapshotVersion: 1 as const,
      },
    };
    expect(editorDocumentCommitRequestSchemaV1.parse(atomic)).toEqual(atomic);
    expect(
      editorDocumentCommitRequestSchemaV1.safeParse({
        ...atomic,
        sessionUpdate: { ...atomic.sessionUpdate, documentRevision: "2" },
      }).success,
    ).toBe(false);
    expect(
      editorDocumentCommitRequestSchemaV1.safeParse({
        ...atomic,
        sessionUpdate: { ...atomic.sessionUpdate, epoch: EPOCH },
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

  it("parses an exact session epoch query without collapsing repeated parameters", () => {
    expect(parseEditorDocumentSessionQueryV1(new URLSearchParams({ epoch: EPOCH }))).toEqual({ epoch: EPOCH });
    expect(() => parseEditorDocumentSessionQueryV1(new URLSearchParams(`epoch=${EPOCH}&epoch=${EPOCH}`))).toThrow(
      /exactly once/i,
    );
    expect(() => parseEditorDocumentSessionQueryV1(new URLSearchParams({ epoch: EPOCH, extra: "1" }))).toThrow();
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
    expect(serializeEditorDocumentOpenResultV1({ created: false, document, kind: "opened", projection })).toMatchObject(
      {
        created: false,
        document: { revision: "9007199254740993" },
        kind: "opened",
        projection: { programs: [{ transactionId: "motion" }], revision: "9007199254740993" },
      },
    );
    expect(
      serializeEditorDocumentOpenResultV1({
        created: true,
        document: { ...document, revision: 0n },
        kind: "opened",
        projection: { programs: [], revision: 0n },
      }),
    ).toMatchObject({ created: true, projection: { programs: [], revision: "0" } });
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
    expect(
      serializeEditorDocumentCommitResultV1({
        document,
        event,
        kind: "committed",
        replayed: false,
        sessionUpdate: {
          documentRevision: event.revision,
          sessionGeneration: 2n,
          snapshotByteSize: session.snapshotByteSize,
          snapshotDigest: session.snapshotDigest,
          snapshotVersion: 1,
        },
      }),
    ).toMatchObject({
      sessionUpdate: { documentRevision: "9007199254740994", sessionGeneration: "2" },
    });
  });

  it("serializes session generations and strict store outcomes", () => {
    expect(serializeEditorDocumentSessionViewV1(session)).toMatchObject({
      documentRevision: "9007199254740993",
      sessionGeneration: "2",
      snapshot: sessionSnapshot,
      updatedAt: "2026-08-01T02:03:04.007Z",
    });
    expect(serializeEditorDocumentSessionPutResultV1({ kind: "stored", replayed: false, session })).toMatchObject({
      kind: "stored",
      replayed: false,
      session: { sessionGeneration: "2" },
    });
    expect(serializeEditorDocumentSessionReadResultV1({ kind: "available", session })).toMatchObject({
      kind: "available",
      session: { sessionGeneration: "2" },
    });
    expect(serializeEditorDocumentSessionReadResultV1({ currentSessionGeneration: 2n, kind: "unavailable" })).toEqual({
      currentSessionGeneration: "2",
      kind: "unavailable",
    });
    expect(
      serializeEditorDocumentSessionPutResultV1({
        currentDocumentRevision: document.revision,
        currentSessionGeneration: 2n,
        kind: "conflict",
        reason: "session-generation-mismatch",
      }),
    ).toEqual({
      currentDocumentRevision: "9007199254740993",
      currentSessionGeneration: "2",
      kind: "conflict",
      reason: "session-generation-mismatch",
    });
  });

  it.each([
    "document-sealed",
    "forbidden",
    "invalid-mutation",
    "mutation-reused",
    "not-found",
    "projection-mismatch",
    "revision-mismatch",
    "session-generation-mismatch",
    "source-changed",
  ] as const)("preserves the %s conflict reason", (reason) => {
    expect(serializeEditorDocumentCommitResultV1({ kind: "conflict", reason })).toEqual({ kind: "conflict", reason });
  });

  it("fails closed on malformed wire views and invalid serialization inputs", () => {
    const view = serializeEditorDocumentViewV1(document);
    const projectionView = serializeEditorDocumentProjectionViewV1(projection);
    const openedView = serializeEditorDocumentOpenResultV1({
      created: false,
      document,
      kind: "opened",
      projection,
    });
    if (openedView.kind !== "opened") throw new Error("The opened-result fixture was not serialized.");
    const sessionView = serializeEditorDocumentSessionViewV1(session);
    expect(editorDocumentSessionViewSchemaV1.safeParse({ ...sessionView, subjectId: "forged" }).success).toBe(false);
    expect(editorDocumentSessionViewSchemaV1.safeParse({ ...sessionView, internal: true }).success).toBe(false);
    const previewOnlyProgram = { ...program("preview-only"), loweringStatus: "illustrative" as const };
    expect(
      editorDocumentSessionViewSchemaV1.safeParse({
        ...sessionView,
        snapshot: {
          ...sessionSnapshot,
          appliedPrograms: [{ program: previewOnlyProgram, validation: { issues: [], status: "valid" } }],
        },
      }).success,
    ).toBe(false);
    expect(
      editorDocumentSessionPutResultViewSchemaV1.safeParse({
        kind: "stored",
        replayed: false,
        session: { ...sessionView, snapshot: { ...sessionSnapshot, internal: true } },
      }).success,
    ).toBe(false);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, revision: 1 }).success).toBe(false);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, openedAt: "2026-08-01" }).success).toBe(false);
    expect(editorDocumentViewSchemaV1.safeParse({ ...view, internal: true }).success).toBe(false);
    expect(editorDocumentProjectionViewSchemaV1.safeParse({ ...projectionView, revision: 1 }).success).toBe(false);
    expect(
      editorDocumentOpenResultViewSchemaV1.safeParse({
        ...openedView,
        projection: { ...openedView.projection, revision: (document.revision - 1n).toString() },
      }).success,
    ).toBe(false);
    expect(editorDocumentOpenResultViewSchemaV1.safeParse({ ...openedView, created: true }).success).toBe(false);
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({
        ...projectionView,
        programs: Array.from({ length: 33 }, (_, index) => program(`program-${index}`)),
      }).success,
    ).toBe(false);
    const laterProgram = {
      ...program("later"),
      anchor: { ...program("later").anchor, resolvedSeconds: 2 },
    };
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({
        programs: [program("duplicate"), program("duplicate")],
        revision: "2",
      }).success,
    ).toBe(false);
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({
        programs: [laterProgram, program("earlier")],
        revision: "2",
      }).success,
    ).toBe(false);
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({ programs: [program("impossible")], revision: "0" }).success,
    ).toBe(false);
    const oversizedProgram = program("oversized");
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({
        ...projectionView,
        programs: [
          {
            ...oversizedProgram,
            operations: [
              {
                ...oversizedProgram.operations[0]!,
                provenance: {
                  ...oversizedProgram.operations[0]!.provenance,
                  evidence: ["x".repeat(256 * 1024)],
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      editorDocumentProjectionViewSchemaV1.safeParse({
        ...projectionView,
        programs: [
          {
            ...program(),
            operations: [{ ...program().operations[0]!, internal: true }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      editorDocumentCommitResultViewSchemaV1.safeParse({
        currentRevision: 1,
        kind: "conflict",
        reason: "revision-mismatch",
      }).success,
    ).toBe(false);
    expect(() => serializeEditorDocumentViewV1({ ...document, revision: 9_223_372_036_854_775_808n })).toThrow();
    expect(() =>
      serializeEditorDocumentProjectionViewV1({
        programs: projection.programs,
        revision: 9_223_372_036_854_775_808n,
      }),
    ).toThrow();
    expect(() =>
      serializeEditorDocumentOpenResultV1({
        created: false,
        document,
        kind: "opened",
        projection: { ...projection, revision: document.revision - 1n },
      }),
    ).toThrow();
    expect(() =>
      serializeEditorDocumentOpenResultV1({ created: true, document, kind: "opened", projection }),
    ).toThrow();
    expect(() => serializeEditorDocumentViewV1({ ...document, updatedAt: new Date(Number.NaN) })).toThrow();
    expect(() => serializeEditorDocumentTailResultV1({ document, events: Array(33).fill(event) })).toThrow();
  });
});

describe("editor document HTTP native origin", () => {
  const nativeDocument = {
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH,
    openedAt: new Date("2026-08-01T01:02:03.004Z"),
    origin: "studio-native",
    projectId: "project-a",
    revision: 0n,
    sealedAt: null,
    sourceHash: null,
    sourcePath: null,
    tenantId: "tenant-a",
    updatedAt: new Date("2026-08-01T02:03:04.005Z"),
  } as const;

  it("keeps the imported document view byte-identical without an origin field", () => {
    const view = serializeEditorDocumentViewV1(document);
    expect("origin" in view).toBe(false);
    expect(Object.keys(view).toSorted()).toEqual([
      "documentKey",
      "epoch",
      "openedAt",
      "projectId",
      "revision",
      "sealedAt",
      "sourceHash",
      "sourcePath",
      "tenantId",
      "updatedAt",
    ]);
    expect(editorDocumentViewUnionSchemaV1.parse(view)).toEqual(view);
  });

  it("serializes a native document with its explicit origin and null source binding", () => {
    const view = serializeEditorDocumentViewV1(nativeDocument);
    expect(view).toMatchObject({
      documentKey: DOCUMENT_KEY,
      origin: "studio-native",
      revision: "0",
      sourceHash: null,
      sourcePath: null,
    });
    expect(editorDocumentViewUnionSchemaV1.parse(view)).toEqual(view);
    expect(
      serializeEditorDocumentOpenResultV1({
        created: false,
        document: nativeDocument,
        kind: "opened",
        projection: { programs: [], revision: 0n },
      }),
    ).toMatchObject({ document: { origin: "studio-native", sourceHash: null }, kind: "opened" });
    expect(serializeEditorDocumentTailResultV1({ document: nativeDocument, events: [] })).toMatchObject({
      document: { origin: "studio-native" },
      events: [],
    });
  });

  it("rejects cross-lane document views that mix an origin with a source binding", () => {
    const importedView = serializeEditorDocumentViewV1(document);
    expect(editorDocumentViewUnionSchemaV1.safeParse({ ...importedView, origin: "studio-native" }).success).toBe(false);
    const nativeView = serializeEditorDocumentViewV1(nativeDocument);
    expect(editorDocumentViewUnionSchemaV1.safeParse({ ...nativeView, sourcePath: "scene.py" }).success).toBe(false);
    expect(editorDocumentViewUnionSchemaV1.safeParse({ ...nativeView, origin: "imported-manim" }).success).toBe(false);
    const { origin: _origin, ...withoutOrigin } = nativeView as Record<string, unknown>;
    expect(editorDocumentViewUnionSchemaV1.safeParse(withoutOrigin).success).toBe(false);
  });

  it("accepts the native open request beside the unchanged imported request", () => {
    expect(editorDocumentOpenRequestUnionSchemaV1.parse({ origin: "studio-native" })).toEqual({
      origin: "studio-native",
    });
    expect(
      editorDocumentOpenRequestUnionSchemaV1.parse({
        sceneName: "Demo",
        sourceHash: SOURCE_HASH,
        sourcePath: "scene.py",
      }),
    ).toEqual({ sceneName: "Demo", sourceHash: SOURCE_HASH, sourcePath: "scene.py" });
    expect(editorDocumentOpenRequestUnionSchemaV1.safeParse({ origin: "imported-manim" }).success).toBe(false);
    expect(
      editorDocumentOpenRequestUnionSchemaV1.safeParse({ origin: "studio-native", sourcePath: "scene.py" }).success,
    ).toBe(false);
    expect(
      editorDocumentOpenRequestUnionSchemaV1.safeParse({ origin: "studio-native", sceneName: "Demo" }).success,
    ).toBe(false);
  });
});
