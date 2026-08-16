import { z } from "zod";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { sha256V1Schema } from "../engine/primitives";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../render-pipeline/manim-identity-contract";
import { sceneEditSchema as canonicalEditProgramSchemaV1, type SceneEdit } from "../studio/scene-edit-contract";
import { deepStrictWireSchemaV1 } from "./deep-strict-wire-schema";
import {
  type EditorEditMutationV1,
  editorEditMutationV1Schema,
  MAX_APPLIED_EDITOR_PROGRAMS_V1,
  parseAuthoritativeEditorProgramsV1,
} from "./editor-edit-mutation";
import {
  EDITOR_SESSION_SNAPSHOT_VERSION_V1,
  type EditorSessionSnapshotV1,
  editorSessionSnapshotByteSizeV1,
  editorSessionSnapshotSchemaV1,
  MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1,
} from "./editor-session-contract";

const MAX_EDITOR_REVISION_V1 = 9_223_372_036_854_775_807n;
const MAX_EDITOR_HTTP_EVENT_TAIL_LIMIT_V1 = 32n;
const MAX_EDITOR_PROGRAM_BYTES_V1 = 256 * 1024;

const deepStrictEditorEditMutationSchemaV1 = deepStrictWireSchemaV1(editorEditMutationV1Schema);
const deepStrictCanonicalEditProgramSchemaV1 = deepStrictWireSchemaV1(canonicalEditProgramSchemaV1).superRefine(
  (program, context) => {
    const byteSize = new TextEncoder().encode(canonicalJsonV1(program)).byteLength;
    if (byteSize > MAX_EDITOR_PROGRAM_BYTES_V1) {
      context.addIssue({
        code: "custom",
        message: `Canonical Editor Programs accept at most ${MAX_EDITOR_PROGRAM_BYTES_V1} UTF-8 bytes.`,
      });
    }
  },
);
const editorDocumentProjectionProgramsViewSchemaV1 = z
  .array(deepStrictCanonicalEditProgramSchemaV1)
  .max(MAX_APPLIED_EDITOR_PROGRAMS_V1)
  .superRefine((programs, context) => {
    try {
      parseAuthoritativeEditorProgramsV1(programs);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Editor projection Programs must have unique identities and canonical source order.",
      });
    }
  });

export const editorDocumentKeySchemaV1 = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Editor document key must be a lower-case SHA-256 digest.");

const editorUuidSchemaV1 = z.uuid();
const editorTenantIdSchemaV1 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u);

export const editorRevisionStringSchemaV1 = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u, "Editor revisions must be canonical unsigned decimal strings.")
  .refine(
    (value) => !/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) <= MAX_EDITOR_REVISION_V1,
    "Editor revision exceeds the durable storage range.",
  );

const editorSessionBaseGenerationStringSchemaV1 = editorRevisionStringSchemaV1.refine(
  (value) => BigInt(value) < MAX_EDITOR_REVISION_V1,
  "Editor session generation cannot be incremented beyond the durable storage range.",
);

const editorSessionGenerationStringSchemaV1 = editorRevisionStringSchemaV1.refine(
  (value) => BigInt(value) > 0n,
  "Stored Editor session generations must be positive.",
);

const editorTailLimitStringSchemaV1 = z
  .string()
  .regex(/^[1-9][0-9]*$/u, "Editor tail limits must be canonical positive decimal strings.")
  .refine(
    (value) => !/^[1-9][0-9]*$/u.test(value) || BigInt(value) <= MAX_EDITOR_HTTP_EVENT_TAIL_LIMIT_V1,
    `Editor HTTP tails accept at most ${MAX_EDITOR_HTTP_EVENT_TAIL_LIMIT_V1} events.`,
  );

const editorIsoDateStringSchemaV1 = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}, "Editor timestamps must be canonical ISO date strings.");

export const editorDocumentOpenRequestSchemaV1 = z
  .object({
    sceneName: manimSceneNameSchema,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
  })
  .strict();

export const editorDocumentCommitRequestSchemaV1 = z
  .object({
    baseRevision: editorRevisionStringSchemaV1,
    clientMutationId: editorUuidSchemaV1,
    epoch: editorUuidSchemaV1,
    mutation: deepStrictEditorEditMutationSchemaV1,
    sessionUpdate: z
      .object({
        documentRevision: editorRevisionStringSchemaV1,
        expectedSessionGeneration: editorSessionBaseGenerationStringSchemaV1,
        snapshot: editorSessionSnapshotSchemaV1,
        snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.sessionUpdate !== undefined &&
      BigInt(request.sessionUpdate.documentRevision) !== BigInt(request.baseRevision) + 1n
    ) {
      context.addIssue({
        code: "custom",
        message: "An atomic Editor session update must target the post-mutation document revision.",
        path: ["sessionUpdate", "documentRevision"],
      });
    }
  });

export const editorDocumentSessionQuerySchemaV1 = z.object({ epoch: editorUuidSchemaV1 }).strict();

export const editorDocumentSessionPutRequestSchemaV1 = z
  .object({
    documentRevision: editorRevisionStringSchemaV1,
    epoch: editorUuidSchemaV1,
    expectedSessionGeneration: editorSessionBaseGenerationStringSchemaV1,
    snapshot: editorSessionSnapshotSchemaV1,
    snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
  })
  .strict();

export const editorDocumentTailQuerySchemaV1 = z
  .object({
    afterRevision: editorRevisionStringSchemaV1,
    epoch: editorUuidSchemaV1,
    limit: editorTailLimitStringSchemaV1.default("32"),
  })
  .strict();

export const editorDocumentViewSchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorUuidSchemaV1,
    openedAt: editorIsoDateStringSchemaV1,
    projectId: manimProjectIdSchema,
    revision: editorRevisionStringSchemaV1,
    sealedAt: editorIsoDateStringSchemaV1.nullable(),
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    tenantId: editorTenantIdSchemaV1,
    updatedAt: editorIsoDateStringSchemaV1,
  })
  .strict();

export const editorDocumentProjectionViewSchemaV1 = z
  .object({
    programs: editorDocumentProjectionProgramsViewSchemaV1,
    revision: editorRevisionStringSchemaV1,
  })
  .strict()
  .superRefine((projection, context) => {
    if (BigInt(projection.revision) < BigInt(projection.programs.length)) {
      context.addIssue({
        code: "custom",
        message: "Editor projection Program count cannot exceed its revision.",
        path: ["programs"],
      });
    }
  });

export const editorEditEventViewSchemaV1 = z
  .object({
    baseRevision: editorRevisionStringSchemaV1,
    byteSize: z.number().int().min(1).max(MAX_EDITOR_PROGRAM_BYTES_V1),
    clientMutationId: editorUuidSchemaV1,
    committedAt: editorIsoDateStringSchemaV1,
    digest: sha256V1Schema,
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorUuidSchemaV1,
    mutation: deepStrictEditorEditMutationSchemaV1,
    projectId: manimProjectIdSchema,
    revision: editorRevisionStringSchemaV1,
    subjectId: editorUuidSchemaV1,
    tenantId: editorTenantIdSchemaV1,
  })
  .strict();

const editorDocumentOpenedResultViewSchemaV1 = z
  .object({
    created: z.boolean(),
    document: editorDocumentViewSchemaV1,
    kind: z.literal("opened"),
    projection: editorDocumentProjectionViewSchemaV1,
  })
  .strict()
  .superRefine((opened, context) => {
    if (opened.document.revision !== opened.projection.revision) {
      context.addIssue({
        code: "custom",
        message: "Editor document and projection revisions must match.",
        path: ["projection", "revision"],
      });
    }
    if (
      opened.created &&
      (opened.document.revision !== "0" || opened.projection.revision !== "0" || opened.projection.programs.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "A newly opened Editor document must have an empty revision-zero projection.",
        path: ["projection"],
      });
    }
  });

export const editorDocumentOpenResultViewSchemaV1 = z.discriminatedUnion("kind", [
  editorDocumentOpenedResultViewSchemaV1,
  z.object({ kind: z.literal("not-found") }).strict(),
  z
    .object({
      currentSourceHash: sha256V1Schema,
      kind: z.literal("source-conflict"),
    })
    .strict(),
]);

export const editorDocumentCommitConflictReasonSchemaV1 = z.enum([
  "document-sealed",
  "forbidden",
  "invalid-mutation",
  "mutation-reused",
  "not-found",
  "projection-mismatch",
  "revision-mismatch",
  "session-generation-mismatch",
  "source-changed",
]);

export const editorDocumentSessionViewSchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    documentRevision: editorRevisionStringSchemaV1,
    epoch: editorUuidSchemaV1,
    projectId: manimProjectIdSchema,
    sessionGeneration: editorSessionGenerationStringSchemaV1,
    snapshot: editorSessionSnapshotSchemaV1,
    snapshotByteSize: z.number().int().min(1).max(MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1),
    snapshotDigest: sha256V1Schema,
    snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
    tenantId: editorTenantIdSchemaV1,
    updatedAt: editorIsoDateStringSchemaV1,
  })
  .strict()
  .superRefine((session, context) => {
    let snapshotByteSize: number;
    try {
      snapshotByteSize = editorSessionSnapshotByteSizeV1(session.snapshot);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Editor session snapshot is not restorable as applied state.",
        path: ["snapshot"],
      });
      return;
    }
    if (snapshotByteSize !== session.snapshotByteSize) {
      context.addIssue({
        code: "custom",
        message: "Editor session snapshot byte evidence is inconsistent.",
        path: ["snapshotByteSize"],
      });
    }
  });

export const editorDocumentSessionConflictReasonSchemaV1 = z.enum([
  "document-sealed",
  "epoch-mismatch",
  "forbidden",
  "not-found",
  "projection-mismatch",
  "revision-mismatch",
  "session-generation-mismatch",
  "source-changed",
]);

export const editorDocumentSessionPutResultViewSchemaV1 = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stored"),
      replayed: z.boolean(),
      session: editorDocumentSessionViewSchemaV1,
    })
    .strict(),
  z
    .object({
      currentDocumentRevision: editorRevisionStringSchemaV1.optional(),
      currentSessionGeneration: editorRevisionStringSchemaV1.optional(),
      kind: z.literal("conflict"),
      reason: editorDocumentSessionConflictReasonSchemaV1,
    })
    .strict(),
]);

export const editorDocumentSessionReadResultViewSchemaV1 = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      session: editorDocumentSessionViewSchemaV1,
    })
    .strict(),
  z
    .object({
      currentSessionGeneration: editorRevisionStringSchemaV1,
      kind: z.literal("unavailable"),
    })
    .strict(),
]);

export const editorDocumentCommittedSessionUpdateViewSchemaV1 = z
  .object({
    documentRevision: editorRevisionStringSchemaV1,
    sessionGeneration: editorSessionGenerationStringSchemaV1,
    snapshotByteSize: z.number().int().min(1).max(MAX_EDITOR_SESSION_SNAPSHOT_BYTES_V1),
    snapshotDigest: sha256V1Schema,
    snapshotVersion: z.literal(EDITOR_SESSION_SNAPSHOT_VERSION_V1),
  })
  .strict();

export const editorDocumentCommitConflictViewSchemaV1 = z
  .object({
    currentRevision: editorRevisionStringSchemaV1.optional(),
    currentSessionGeneration: editorRevisionStringSchemaV1.optional(),
    kind: z.literal("conflict"),
    reason: editorDocumentCommitConflictReasonSchemaV1,
  })
  .strict();

export const editorDocumentCommitResultViewSchemaV1 = z.discriminatedUnion("kind", [
  z
    .object({
      document: editorDocumentViewSchemaV1,
      event: editorEditEventViewSchemaV1,
      kind: z.literal("committed"),
      replayed: z.boolean(),
      sessionUpdate: editorDocumentCommittedSessionUpdateViewSchemaV1.optional(),
    })
    .strict(),
  editorDocumentCommitConflictViewSchemaV1,
]);

export const editorDocumentTailResultViewSchemaV1 = z
  .object({
    document: editorDocumentViewSchemaV1,
    events: z.array(editorEditEventViewSchemaV1).max(Number(MAX_EDITOR_HTTP_EVENT_TAIL_LIMIT_V1)),
  })
  .strict()
  .nullable();

export type EditorDocumentOpenRequestV1 = Readonly<z.infer<typeof editorDocumentOpenRequestSchemaV1>>;
export type EditorDocumentCommitRequestV1 = Readonly<z.infer<typeof editorDocumentCommitRequestSchemaV1>>;
export type EditorDocumentSessionQueryV1 = Readonly<z.infer<typeof editorDocumentSessionQuerySchemaV1>>;
export type EditorDocumentSessionPutRequestV1 = Readonly<{
  documentRevision: string;
  epoch: string;
  expectedSessionGeneration: string;
  snapshot: EditorSessionSnapshotV1;
  snapshotVersion: typeof EDITOR_SESSION_SNAPSHOT_VERSION_V1;
}>;
export type EditorDocumentTailQueryV1 = Readonly<z.infer<typeof editorDocumentTailQuerySchemaV1>>;
export type EditorDocumentViewV1 = Readonly<z.infer<typeof editorDocumentViewSchemaV1>>;
export type EditorDocumentProjectionViewV1 = Readonly<z.infer<typeof editorDocumentProjectionViewSchemaV1>>;
export type EditorEditEventViewV1 = Readonly<z.infer<typeof editorEditEventViewSchemaV1>>;
export type EditorDocumentOpenResultViewV1 = Readonly<z.infer<typeof editorDocumentOpenResultViewSchemaV1>>;
export type EditorDocumentCommitResultViewV1 = Readonly<z.infer<typeof editorDocumentCommitResultViewSchemaV1>>;
export type EditorDocumentSessionViewV1 = Readonly<z.infer<typeof editorDocumentSessionViewSchemaV1>>;
export type EditorDocumentSessionPutResultViewV1 = Readonly<z.infer<typeof editorDocumentSessionPutResultViewSchemaV1>>;
export type EditorDocumentSessionReadResultViewV1 = Readonly<
  z.infer<typeof editorDocumentSessionReadResultViewSchemaV1>
>;
export type EditorDocumentCommittedSessionUpdateViewV1 = Readonly<
  z.infer<typeof editorDocumentCommittedSessionUpdateViewSchemaV1>
>;
export type EditorDocumentTailResultViewV1 = Readonly<z.infer<typeof editorDocumentTailResultViewSchemaV1>>;

export type EditorDocumentSerializationInputV1 = Readonly<{
  documentKey: string;
  epoch: string;
  openedAt: Date;
  projectId: string;
  revision: bigint;
  sealedAt: Date | null;
  sourceHash: string;
  sourcePath: string;
  tenantId: string;
  updatedAt: Date;
}>;

export type EditorEditEventSerializationInputV1 = Readonly<{
  baseRevision: bigint;
  byteSize: number;
  clientMutationId: string;
  committedAt: Date;
  digest: string;
  documentKey: string;
  epoch: string;
  mutation: EditorEditMutationV1;
  projectId: string;
  revision: bigint;
  subjectId: string;
  tenantId: string;
}>;

export type EditorDocumentProjectionSerializationInputV1 = Readonly<{
  programs: readonly SceneEdit[];
  revision: bigint;
}>;

export type EditorDocumentSessionSerializationInputV1 = Readonly<{
  documentKey: string;
  documentRevision: bigint;
  epoch: string;
  projectId: string;
  sessionGeneration: bigint;
  snapshot: EditorSessionSnapshotV1;
  snapshotByteSize: number;
  snapshotDigest: string;
  snapshotVersion: number;
  tenantId: string;
  updatedAt: Date;
}>;

export type EditorDocumentCommittedSessionUpdateSerializationInputV1 = Readonly<{
  documentRevision: bigint;
  sessionGeneration: bigint;
  snapshotByteSize: number;
  snapshotDigest: string;
  snapshotVersion: number;
}>;

export type EditorDocumentOpenResultSerializationInputV1 =
  | Readonly<{
      created: boolean;
      document: EditorDocumentSerializationInputV1;
      kind: "opened";
      projection: EditorDocumentProjectionSerializationInputV1;
    }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ currentSourceHash: string; kind: "source-conflict" }>;

export type EditorDocumentCommitResultSerializationInputV1 =
  | Readonly<{
      document: EditorDocumentSerializationInputV1;
      event: EditorEditEventSerializationInputV1;
      kind: "committed";
      replayed: boolean;
      sessionUpdate?: EditorDocumentCommittedSessionUpdateSerializationInputV1;
    }>
  | Readonly<{
      currentRevision?: bigint;
      currentSessionGeneration?: bigint;
      kind: "conflict";
      reason: z.infer<typeof editorDocumentCommitConflictReasonSchemaV1>;
    }>;

export type EditorDocumentSessionPutResultSerializationInputV1 =
  | Readonly<{
      kind: "stored";
      replayed: boolean;
      session: EditorDocumentSessionSerializationInputV1;
    }>
  | Readonly<{
      currentDocumentRevision?: bigint;
      currentSessionGeneration?: bigint;
      kind: "conflict";
      reason: z.infer<typeof editorDocumentSessionConflictReasonSchemaV1>;
    }>;

export type EditorDocumentSessionReadResultSerializationInputV1 =
  | Readonly<{
      kind: "available";
      session: EditorDocumentSessionSerializationInputV1;
    }>
  | Readonly<{
      currentSessionGeneration: bigint;
      kind: "unavailable";
    }>;

export type EditorDocumentTailResultSerializationInputV1 = Readonly<{
  document: EditorDocumentSerializationInputV1;
  events: readonly EditorEditEventSerializationInputV1[];
}> | null;

/** Parses a URL query without silently collapsing repeated keys. */
export function parseEditorDocumentTailQueryV1(searchParams: URLSearchParams): EditorDocumentTailQueryV1 {
  const entries = Array.from(searchParams.entries());
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name)) throw new TypeError(`Editor tail query parameter ${name} must occur exactly once.`);
    names.add(name);
  }
  return editorDocumentTailQuerySchemaV1.parse(Object.fromEntries(entries));
}

/** Parses a session query without silently accepting repeated or unknown keys. */
export function parseEditorDocumentSessionQueryV1(searchParams: URLSearchParams): EditorDocumentSessionQueryV1 {
  const entries = Array.from(searchParams.entries());
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name)) throw new TypeError(`Editor session query parameter ${name} must occur exactly once.`);
    names.add(name);
  }
  return editorDocumentSessionQuerySchemaV1.parse(Object.fromEntries(entries));
}

function serializeEditorRevisionV1(value: bigint) {
  if (typeof value !== "bigint") throw new TypeError("Editor revisions must be bigint values before serialization.");
  return editorRevisionStringSchemaV1.parse(value.toString(10));
}

function serializeEditorDateV1(value: Date) {
  if (!(value instanceof Date)) throw new TypeError("Editor timestamps must be Date values before serialization.");
  return editorIsoDateStringSchemaV1.parse(value.toISOString());
}

export function serializeEditorDocumentViewV1(input: EditorDocumentSerializationInputV1): EditorDocumentViewV1 {
  return editorDocumentViewSchemaV1.parse({
    documentKey: input.documentKey,
    epoch: input.epoch,
    openedAt: serializeEditorDateV1(input.openedAt),
    projectId: input.projectId,
    revision: serializeEditorRevisionV1(input.revision),
    sealedAt: input.sealedAt === null ? null : serializeEditorDateV1(input.sealedAt),
    sourceHash: input.sourceHash,
    sourcePath: input.sourcePath,
    tenantId: input.tenantId,
    updatedAt: serializeEditorDateV1(input.updatedAt),
  });
}

export function serializeEditorEditEventViewV1(input: EditorEditEventSerializationInputV1): EditorEditEventViewV1 {
  return editorEditEventViewSchemaV1.parse({
    baseRevision: serializeEditorRevisionV1(input.baseRevision),
    byteSize: input.byteSize,
    clientMutationId: input.clientMutationId,
    committedAt: serializeEditorDateV1(input.committedAt),
    digest: input.digest,
    documentKey: input.documentKey,
    epoch: input.epoch,
    mutation: input.mutation,
    projectId: input.projectId,
    revision: serializeEditorRevisionV1(input.revision),
    subjectId: input.subjectId,
    tenantId: input.tenantId,
  });
}

export function serializeEditorDocumentProjectionViewV1(
  input: EditorDocumentProjectionSerializationInputV1,
): EditorDocumentProjectionViewV1 {
  return editorDocumentProjectionViewSchemaV1.parse({
    programs: input.programs,
    revision: serializeEditorRevisionV1(input.revision),
  });
}

export function serializeEditorDocumentSessionViewV1(
  input: EditorDocumentSessionSerializationInputV1,
): EditorDocumentSessionViewV1 {
  return editorDocumentSessionViewSchemaV1.parse({
    documentKey: input.documentKey,
    documentRevision: serializeEditorRevisionV1(input.documentRevision),
    epoch: input.epoch,
    projectId: input.projectId,
    sessionGeneration: serializeEditorRevisionV1(input.sessionGeneration),
    snapshot: input.snapshot,
    snapshotByteSize: input.snapshotByteSize,
    snapshotDigest: input.snapshotDigest,
    snapshotVersion: input.snapshotVersion,
    tenantId: input.tenantId,
    updatedAt: serializeEditorDateV1(input.updatedAt),
  });
}

export function serializeEditorDocumentCommittedSessionUpdateV1(
  input: EditorDocumentCommittedSessionUpdateSerializationInputV1,
): EditorDocumentCommittedSessionUpdateViewV1 {
  return editorDocumentCommittedSessionUpdateViewSchemaV1.parse({
    documentRevision: serializeEditorRevisionV1(input.documentRevision),
    sessionGeneration: serializeEditorRevisionV1(input.sessionGeneration),
    snapshotByteSize: input.snapshotByteSize,
    snapshotDigest: input.snapshotDigest,
    snapshotVersion: input.snapshotVersion,
  });
}

export function serializeEditorDocumentOpenResultV1(
  input: EditorDocumentOpenResultSerializationInputV1,
): EditorDocumentOpenResultViewV1 {
  if (input.kind === "opened") {
    return editorDocumentOpenResultViewSchemaV1.parse({
      created: input.created,
      document: serializeEditorDocumentViewV1(input.document),
      kind: input.kind,
      projection: serializeEditorDocumentProjectionViewV1(input.projection),
    });
  }
  if (input.kind === "source-conflict") {
    return editorDocumentOpenResultViewSchemaV1.parse({
      currentSourceHash: input.currentSourceHash,
      kind: input.kind,
    });
  }
  return editorDocumentOpenResultViewSchemaV1.parse({ kind: input.kind });
}

export function serializeEditorDocumentCommitResultV1(
  input: EditorDocumentCommitResultSerializationInputV1,
): EditorDocumentCommitResultViewV1 {
  if (input.kind === "committed") {
    return editorDocumentCommitResultViewSchemaV1.parse({
      document: serializeEditorDocumentViewV1(input.document),
      event: serializeEditorEditEventViewV1(input.event),
      kind: input.kind,
      replayed: input.replayed,
      ...(input.sessionUpdate === undefined
        ? {}
        : { sessionUpdate: serializeEditorDocumentCommittedSessionUpdateV1(input.sessionUpdate) }),
    });
  }
  return editorDocumentCommitResultViewSchemaV1.parse({
    ...(input.currentRevision === undefined
      ? undefined
      : { currentRevision: serializeEditorRevisionV1(input.currentRevision) }),
    ...(input.currentSessionGeneration === undefined
      ? {}
      : { currentSessionGeneration: serializeEditorRevisionV1(input.currentSessionGeneration) }),
    kind: input.kind,
    reason: input.reason,
  });
}

export function serializeEditorDocumentSessionPutResultV1(
  input: EditorDocumentSessionPutResultSerializationInputV1,
): EditorDocumentSessionPutResultViewV1 {
  if (input.kind === "stored") {
    return editorDocumentSessionPutResultViewSchemaV1.parse({
      kind: input.kind,
      replayed: input.replayed,
      session: serializeEditorDocumentSessionViewV1(input.session),
    });
  }
  return editorDocumentSessionPutResultViewSchemaV1.parse({
    ...(input.currentDocumentRevision === undefined
      ? {}
      : { currentDocumentRevision: serializeEditorRevisionV1(input.currentDocumentRevision) }),
    ...(input.currentSessionGeneration === undefined
      ? {}
      : { currentSessionGeneration: serializeEditorRevisionV1(input.currentSessionGeneration) }),
    kind: input.kind,
    reason: input.reason,
  });
}

export function serializeEditorDocumentSessionReadResultV1(
  input: EditorDocumentSessionReadResultSerializationInputV1,
): EditorDocumentSessionReadResultViewV1 {
  if (input.kind === "available") {
    return editorDocumentSessionReadResultViewSchemaV1.parse({
      kind: input.kind,
      session: serializeEditorDocumentSessionViewV1(input.session),
    });
  }
  return editorDocumentSessionReadResultViewSchemaV1.parse({
    currentSessionGeneration: serializeEditorRevisionV1(input.currentSessionGeneration),
    kind: input.kind,
  });
}

export function serializeEditorDocumentTailResultV1(
  input: EditorDocumentTailResultSerializationInputV1,
): EditorDocumentTailResultViewV1 {
  if (input === null) return null;
  return editorDocumentTailResultViewSchemaV1.parse({
    document: serializeEditorDocumentViewV1(input.document),
    events: input.events.map(serializeEditorEditEventViewV1),
  });
}
