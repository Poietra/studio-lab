import { z } from "zod";
import { sha256V1Schema } from "../engine/primitives";
import { manimProjectIdSchema, manimSourcePathSchema } from "../render-pipeline/contracts";
import { type EditorEditMutationV1, editorEditMutationV1Schema } from "./editor-edit-mutation";

const MAX_EDITOR_REVISION_V1 = 9_223_372_036_854_775_807n;
const MAX_EDITOR_HTTP_EVENT_TAIL_LIMIT_V1 = 32n;
const MAX_EDITOR_PROGRAM_BYTES_V1 = 256 * 1024;

function isPlainWireObjectV1(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownWireKeyPathsV1(
  input: unknown,
  parsed: unknown,
  path: readonly (number | string)[] = [],
): readonly (readonly (number | string)[])[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((value, index) => unknownWireKeyPathsV1(value, parsed[index], [...path, index]));
  }
  if (!isPlainWireObjectV1(input) || !isPlainWireObjectV1(parsed)) return [];
  return Object.keys(input).flatMap((key) =>
    Object.hasOwn(parsed, key) ? unknownWireKeyPathsV1(input[key], parsed[key], [...path, key]) : [[...path, key]],
  );
}

/** Adds deep unknown-key rejection without changing the shared canonical schemas. */
function deepStrictWireSchemaV1<Output>(schema: z.ZodType<Output>) {
  return z.unknown().transform((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "Wire value is invalid." });
      return z.NEVER;
    }
    const unknownPaths = unknownWireKeyPathsV1(value, parsed.data);
    for (const path of unknownPaths) {
      context.addIssue({ code: "custom", message: "Unknown wire field.", path: [...path] });
    }
    return parsed.data;
  });
}

const deepStrictEditorEditMutationSchemaV1 = deepStrictWireSchemaV1(editorEditMutationV1Schema);

export const editorDocumentKeySchemaV1 = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Editor document key must be a lower-case SHA-256 digest.");

const editorSceneNameSchemaV1 = z
  .string()
  .max(240)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Scene name must be a Python identifier.");
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
    sceneName: editorSceneNameSchemaV1,
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

export const editorDocumentOpenResultViewSchemaV1 = z.discriminatedUnion("kind", [
  z
    .object({
      created: z.boolean(),
      document: editorDocumentViewSchemaV1,
      kind: z.literal("opened"),
    })
    .strict(),
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
  "revision-mismatch",
  "source-changed",
]);

export const editorDocumentCommitConflictViewSchemaV1 = z
  .object({
    currentRevision: editorRevisionStringSchemaV1.optional(),
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
export type EditorDocumentTailQueryV1 = Readonly<z.infer<typeof editorDocumentTailQuerySchemaV1>>;
export type EditorDocumentViewV1 = Readonly<z.infer<typeof editorDocumentViewSchemaV1>>;
export type EditorEditEventViewV1 = Readonly<z.infer<typeof editorEditEventViewSchemaV1>>;
export type EditorDocumentOpenResultViewV1 = Readonly<z.infer<typeof editorDocumentOpenResultViewSchemaV1>>;
export type EditorDocumentCommitResultViewV1 = Readonly<z.infer<typeof editorDocumentCommitResultViewSchemaV1>>;
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

export type EditorDocumentOpenResultSerializationInputV1 =
  | Readonly<{ created: boolean; document: EditorDocumentSerializationInputV1; kind: "opened" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ currentSourceHash: string; kind: "source-conflict" }>;

export type EditorDocumentCommitResultSerializationInputV1 =
  | Readonly<{
      document: EditorDocumentSerializationInputV1;
      event: EditorEditEventSerializationInputV1;
      kind: "committed";
      replayed: boolean;
    }>
  | Readonly<{
      currentRevision?: bigint;
      kind: "conflict";
      reason: z.infer<typeof editorDocumentCommitConflictReasonSchemaV1>;
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

export function serializeEditorDocumentOpenResultV1(
  input: EditorDocumentOpenResultSerializationInputV1,
): EditorDocumentOpenResultViewV1 {
  if (input.kind === "opened") {
    return editorDocumentOpenResultViewSchemaV1.parse({
      created: input.created,
      document: serializeEditorDocumentViewV1(input.document),
      kind: input.kind,
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
    });
  }
  return editorDocumentCommitResultViewSchemaV1.parse({
    ...(input.currentRevision === undefined
      ? undefined
      : { currentRevision: serializeEditorRevisionV1(input.currentRevision) }),
    kind: input.kind,
    reason: input.reason,
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
