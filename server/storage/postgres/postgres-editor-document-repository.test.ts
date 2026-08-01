import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalEditProgram } from "../../../src/studio/operations";
import {
  canonicalEditorProgramV1,
  createEditorDocumentKeyV1,
  type EditorDocumentCommitInputV1,
  type EditorEditMutationV1,
} from "../editor-document-repository";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { EDITOR_MUTATION_MIGRATION_V18_CHECKSUM } from "./editor-mutation-schema";
import { PostgresEditorDocumentRepositoryV1 } from "./postgres-editor-document-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const PROJECT = "project-a";
const SOURCE_PATH = "scenes/main.py";
const SCENE_ID = `scene:${"1".repeat(64)}`;
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const DOCUMENT_KEY = createEditorDocumentKeyV1(SOURCE_PATH, SCENE_ID);
const EPOCH_A = "00000000-0000-4000-8000-000000000001";
const EPOCH_B = "00000000-0000-4000-8000-000000000002";
const SUBJECT = "00000000-0000-4000-8000-000000000101";
const MUTATION_A = "00000000-0000-4000-8000-000000000201";
const OPENED_AT = new Date("2026-08-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-08-01T00:00:01.000Z");
const SEALED_AT = new Date("2026-08-01T00:00:02.000Z");
const COMMITTED_AT = new Date("2026-08-01T00:00:01.000Z");

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
    return handle(text, values);
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { pool, query, release };
}

function program(label: string): CanonicalEditProgram {
  const operationId = `tx:${label}/operation:wait`;
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: [],
      resolvedSeconds: 0,
      source: { kind: "playhead", referenceSeconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: operationId,
        interval: { end: 1, start: 0 },
        kind: "InsertTimelineEvent",
        label,
        provenance: { evidence: [], origin: "fixture" },
      },
    ],
    provenance: { evidence: [], origin: "fixture" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operationId] },
    transactionId: label,
    version: 1,
  };
}

const PROGRAM_A = program("editor-a");
const PROGRAM_B = program("editor-b");
const PROGRAM_C = program("editor-c");
const PROGRAM_A_REPLACED = {
  ...program("editor-a"),
  operations: program("editor-a-replaced").operations,
  schedule: program("editor-a-replaced").schedule,
} satisfies CanonicalEditProgram;

function documentRow(
  options: Readonly<{
    epoch?: string;
    revision?: string;
    sealedAt?: Date | null;
    sourceHash?: string;
    tenantId?: string;
  }> = {},
) {
  return {
    document_key: Buffer.from(DOCUMENT_KEY, "hex"),
    epoch: options.epoch ?? EPOCH_A,
    opened_at: OPENED_AT,
    project_id: PROJECT,
    revision: options.revision ?? "0",
    sealed_at: options.sealedAt ?? null,
    source_hash: Buffer.from(options.sourceHash ?? SOURCE_A, "hex"),
    source_path: SOURCE_PATH,
    tenant_id: options.tenantId ?? TENANT_A,
    updated_at: options.sealedAt ?? UPDATED_AT,
  };
}

function eventRow(
  options: Readonly<{
    baseRevision?: string;
    clientMutationId?: string;
    epoch?: string;
    mutation?: EditorEditMutationV1;
    revision?: string;
    tenantId?: string;
  }> = {},
) {
  const mutation = options.mutation ?? ({ kind: "append", program: PROGRAM_A } as const);
  const canonical = canonicalEditorProgramV1(mutation.program);
  return {
    base_revision: options.baseRevision ?? "0",
    canonical_byte_size: canonical.byteSize,
    canonical_digest: Buffer.from(canonical.digest, "hex"),
    canonical_program: canonical.program,
    client_mutation_id: options.clientMutationId ?? MUTATION_A,
    committed_at: COMMITTED_AT,
    document_key: Buffer.from(DOCUMENT_KEY, "hex"),
    epoch: options.epoch ?? EPOCH_A,
    mutation_kind: mutation.kind,
    project_id: PROJECT,
    revision: options.revision ?? "1",
    subject_id: SUBJECT,
    target_transaction_id: mutation.kind === "append" ? null : mutation.targetTransactionId,
    tenant_id: options.tenantId ?? TENANT_A,
  };
}

function commitInput(
  mutation: EditorEditMutationV1,
  overrides: Partial<EditorDocumentCommitInputV1> = {},
): EditorDocumentCommitInputV1 {
  return {
    baseRevision: 0n,
    clientMutationId: MUTATION_A,
    documentKey: DOCUMENT_KEY,
    epoch: EPOCH_A,
    mutation,
    projectId: PROJECT,
    subjectId: SUBJECT,
    tenantId: TENANT_A,
    ...overrides,
  };
}

function append(programValue: CanonicalEditProgram): EditorEditMutationV1 {
  return { kind: "append", program: programValue };
}

function queryTexts(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.map(([text]) => text as string);
}

describe("PostgresEditorDocumentRepositoryV1", () => {
  it("opens one source idempotently and rotates the epoch only after a verified source change", async () => {
    const sourceHashes = [SOURCE_A, SOURCE_A, SOURCE_B, SOURCE_B];
    let currentReads = 0;
    let documentInserts = 0;
    let projectionInserts = 0;
    const sealValues: (readonly unknown[])[] = [];
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.poietra_schema_migrations")) {
        expect(text).toContain("version IN (17, 18) ORDER BY version");
        return {
          rowCount: 2,
          rows: [
            { checksum: EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM, version: 17 },
            { checksum: EDITOR_MUTATION_MIGRATION_V18_CHECKSUM, version: 18 },
          ],
        };
      }
      if (text.includes("FROM public.workspace_projects project")) {
        expect(text).toContain("FOR SHARE OF project");
        expect(values).toEqual([TENANT_A, PROJECT]);
        return { rowCount: 1, rows: [{ project_id: PROJECT }] };
      }
      if (text.includes("FROM public.workspace_source_heads source")) {
        const sourceHash = sourceHashes.shift();
        if (!sourceHash) throw new Error("No source response remains.");
        expect(text).toContain("FOR UPDATE OF source");
        expect(values).toEqual([TENANT_A, PROJECT, SOURCE_PATH]);
        return { rowCount: 1, rows: [{ source_hash: Buffer.from(sourceHash, "hex") }] };
      }
      if (text.startsWith("UPDATE public.editor_documents") && text.includes("source_path = $3")) {
        sealValues.push(values);
        return { rowCount: sealValues.length === 3 ? 1 : 0, rows: [] };
      }
      if (text.includes("FROM public.editor_documents document") && text.includes("sealed_at IS NULL")) {
        currentReads += 1;
        expect(text).toContain("FOR UPDATE OF document");
        return currentReads === 2 ? { rowCount: 1, rows: [documentRow()] } : { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.editor_documents")) {
        documentInserts += 1;
        return {
          rowCount: 1,
          rows: [
            documentRow(
              documentInserts === 1
                ? { epoch: EPOCH_A, sourceHash: SOURCE_A }
                : { epoch: EPOCH_B, sourceHash: SOURCE_B },
            ),
          ],
        };
      }
      if (text.startsWith("INSERT INTO public.editor_document_projections")) {
        projectionInserts += 1;
        expect(values).toHaveLength(4);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const epochs = [EPOCH_A, EPOCH_B];
    const repository = new PostgresEditorDocumentRepositoryV1({
      pool: fixture.pool,
      randomUuid: () => {
        const epoch = epochs.shift();
        if (!epoch) throw new Error("No editor epoch remains.");
        return epoch;
      },
    });
    const openA = {
      projectId: PROJECT,
      sceneId: SCENE_ID,
      sourceHash: SOURCE_A,
      sourcePath: SOURCE_PATH,
      tenantId: TENANT_A,
    } as const;

    await expect(repository.ready()).resolves.toBe(true);
    const first = await repository.openDocument(openA);
    const same = await repository.openDocument(openA);
    const beforeStale = fixture.query.mock.calls.length;
    await expect(repository.openDocument(openA)).resolves.toEqual({
      currentSourceHash: SOURCE_B,
      kind: "source-conflict",
    });
    const staleTexts = queryTexts(fixture.query).slice(beforeStale);
    const changedStart = fixture.query.mock.calls.length;
    const changed = await repository.openDocument({ ...openA, sourceHash: SOURCE_B });

    expect(first).toMatchObject({
      created: true,
      document: { documentKey: DOCUMENT_KEY, epoch: EPOCH_A, revision: 0n, sourceHash: SOURCE_A },
      kind: "opened",
    });
    expect(same).toEqual({ ...(first as Extract<typeof first, { kind: "opened" }>), created: false });
    expect(changed).toMatchObject({
      created: true,
      document: { documentKey: DOCUMENT_KEY, epoch: EPOCH_B, revision: 0n, sourceHash: SOURCE_B },
      kind: "opened",
    });
    expect(staleTexts.some((text) => text.startsWith("UPDATE public.editor_documents"))).toBe(false);
    expect(staleTexts.some((text) => text.startsWith("INSERT INTO public.editor_documents"))).toBe(false);
    expect(sealValues).toEqual([
      [TENANT_A, PROJECT, SOURCE_PATH, Buffer.from(SOURCE_A, "hex")],
      [TENANT_A, PROJECT, SOURCE_PATH, Buffer.from(SOURCE_A, "hex")],
      [TENANT_A, PROJECT, SOURCE_PATH, Buffer.from(SOURCE_B, "hex")],
    ]);
    expect(documentInserts).toBe(2);
    expect(projectionInserts).toBe(2);

    const changedTexts = queryTexts(fixture.query).slice(changedStart);
    const projectLock = changedTexts.findIndex((text) => text.includes("FROM public.workspace_projects project"));
    const sourceLock = changedTexts.findIndex((text) => text.includes("FROM public.workspace_source_heads source"));
    const seal = changedTexts.findIndex((text) => text.startsWith("UPDATE public.editor_documents"));
    const current = changedTexts.findIndex((text) => text.includes("FROM public.editor_documents document"));
    const insert = changedTexts.findIndex((text) => text.startsWith("INSERT INTO public.editor_documents"));
    const ordered = [projectLock, sourceLock, seal, current, insert];
    expect(ordered).toEqual(ordered.toSorted((a, b) => a - b));
    expect(projectLock).toBeGreaterThanOrEqual(0);
  });

  it("appends once, replays the exact mutation before CAS, and rejects mutation-key payload reuse", async () => {
    let existingReads = 0;
    let historyReads = 0;
    const canonicalA = canonicalEditorProgramV1(PROGRAM_A);
    const fixture = fakePool((text, values) => {
      if (text.includes("AS actor_can_edit")) {
        expect(values).toEqual([TENANT_A, SUBJECT]);
        return { rowCount: 1, rows: [{ actor_can_edit: true }] };
      }
      if (text.includes("FROM public.editor_edit_events event") && text.includes("event.subject_id = $3::uuid")) {
        existingReads += 1;
        expect(values).toEqual([TENANT_A, PROJECT, SUBJECT, MUTATION_A]);
        return existingReads === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [eventRow()] };
      }
      if (text.startsWith("SELECT document.source_path")) {
        return { rowCount: 1, rows: [{ source_path: SOURCE_PATH }] };
      }
      if (text.startsWith("SELECT project.project_id")) {
        expect(text).toContain("FOR SHARE OF project");
        expect(values).toEqual([TENANT_A, PROJECT]);
        return { rowCount: 1, rows: [{ project_id: PROJECT }] };
      }
      if (text.includes("FROM public.workspace_source_heads source")) {
        expect(text).toContain("FOR SHARE OF source");
        expect(values).toEqual([TENANT_A, PROJECT, SOURCE_PATH]);
        return { rowCount: 1, rows: [{ current_source_hash: Buffer.from(SOURCE_A, "hex") }] };
      }
      if (text.includes("FROM public.editor_documents document") && text.includes("FOR UPDATE OF document")) {
        return {
          rowCount: 1,
          rows: [documentRow()],
        };
      }
      if (text.includes("FROM public.editor_document_projections projection")) {
        return { rowCount: 1, rows: [{ canonical_programs: [], revision: "0" }] };
      }
      if (
        text.includes("FROM public.editor_edit_events event") &&
        text.includes("event.revision <=") &&
        text.includes("ORDER BY event.revision")
      ) {
        historyReads += 1;
        expect(values).toEqual([TENANT_A, PROJECT, Buffer.from(DOCUMENT_KEY, "hex"), EPOCH_A, "0"]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.editor_edit_events")) {
        expect(values.slice(4, 8)).toEqual(["0", "1", SUBJECT, MUTATION_A]);
        expect(values.slice(8, 10)).toEqual(["append", null]);
        expect(values[10]).toBe(canonicalA.json);
        expect(values[11]).toEqual(Buffer.from(canonicalA.digest, "hex"));
        expect(values[12]).toBe(canonicalA.byteSize);
        return { rowCount: 1, rows: [eventRow()] };
      }
      if (text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision")) {
        expect(values.slice(4)).toEqual(["1", "0"]);
        return { rowCount: 1, rows: [documentRow({ revision: "1" })] };
      }
      if (text.startsWith("UPDATE public.editor_document_projections projection")) {
        expect(values[4]).toBe("1");
        expect(JSON.parse(String(values[5]))).toEqual([PROGRAM_A]);
        expect(values[6]).toBe("0");
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM public.editor_documents document") && !text.includes("FOR UPDATE OF document")) {
        return { rowCount: 1, rows: [documentRow({ revision: "1" })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresEditorDocumentRepositoryV1({ pool: fixture.pool });
    const input = commitInput(append(PROGRAM_A));

    const first = await repository.commitMutation(input);
    const replay = await repository.commitMutation(input);
    const reused = await repository.commitMutation(commitInput(append(PROGRAM_B)));
    const reusedKindAndTarget = await repository.commitMutation(
      commitInput({ kind: "replace", program: PROGRAM_A, targetTransactionId: "editor-a" }),
    );

    expect(first).toMatchObject({
      document: { revision: 1n },
      event: {
        baseRevision: 0n,
        byteSize: canonicalA.byteSize,
        digest: canonicalA.digest,
        mutation: { kind: "append", program: PROGRAM_A },
        revision: 1n,
      },
      kind: "committed",
      replayed: false,
    });
    expect(replay).toMatchObject({ kind: "committed", replayed: true });
    if (first.kind !== "committed" || replay.kind !== "committed") {
      throw new Error("The fake PostgreSQL commit did not return committed events.");
    }
    expect(replay.event).toEqual(first.event);
    expect(reused).toEqual({ kind: "conflict", reason: "mutation-reused" });
    expect(reusedKindAndTarget).toEqual({ kind: "conflict", reason: "mutation-reused" });
    expect(historyReads).toBe(0);

    const texts = queryTexts(fixture.query);
    expect(texts.filter((text) => text.startsWith("INSERT INTO public.editor_edit_events"))).toHaveLength(1);
    expect(
      texts.filter(
        (text) => text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision"),
      ),
    ).toHaveLength(1);
    const existing = texts.findIndex(
      (text) => text.includes("FROM public.editor_edit_events event") && text.includes("client_mutation_id"),
    );
    const candidate = texts.findIndex((text) => text.startsWith("SELECT document.source_path"));
    const project = texts.findIndex((text) => text.startsWith("SELECT project.project_id"));
    const source = texts.findIndex((text) => text.includes("FROM public.workspace_source_heads source"));
    const selected = texts.findIndex(
      (text) => text.includes("FROM public.editor_documents document") && text.includes("FOR UPDATE OF document"),
    );
    const inserted = texts.findIndex((text) => text.startsWith("INSERT INTO public.editor_edit_events"));
    const advanced = texts.findIndex(
      (text) => text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision"),
    );
    const ordered = [existing, candidate, project, source, selected, inserted, advanced];
    expect(ordered).toEqual(ordered.toSorted((a, b) => a - b));
  });

  it("folds authoritative history before replace/remove and rejects invalid mutation semantics", async () => {
    const scenarios = [
      {
        expected: "committed",
        history: [eventRow()],
        mutation: { kind: "replace", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" } as const,
      },
      {
        expected: "committed",
        history: [
          eventRow(),
          eventRow({
            baseRevision: "1",
            clientMutationId: "00000000-0000-4000-8000-000000000211",
            mutation: { kind: "replace", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" },
            revision: "2",
          }),
        ],
        mutation: { kind: "remove", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" } as const,
      },
      {
        expected: "invalid-mutation",
        history: [eventRow()],
        mutation: append(PROGRAM_A),
      },
      {
        expected: "invalid-mutation",
        history: [eventRow()],
        mutation: { kind: "replace", program: PROGRAM_B, targetTransactionId: "missing" } as const,
      },
      {
        expected: "invalid-mutation",
        history: [eventRow()],
        mutation: { kind: "remove", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" } as const,
      },
      {
        expected: "corrupt-history",
        history: [
          eventRow(),
          eventRow({
            baseRevision: "1",
            clientMutationId: "00000000-0000-4000-8000-000000000212",
            revision: "2",
          }),
        ],
        mutation: append(PROGRAM_B),
      },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const baseRevision = BigInt(scenario.history.length);
      const mutationId = `00000000-0000-4000-8000-${(300 + index).toString().padStart(12, "0")}`;
      const canonical = canonicalEditorProgramV1(scenario.mutation.program);
      let historyReads = 0;
      const fixture = fakePool((text, values) => {
        if (text.includes("AS actor_can_edit")) return { rowCount: 1, rows: [{ actor_can_edit: true }] };
        if (text.includes("event.subject_id = $3::uuid") && text.includes("event.client_mutation_id = $4::uuid")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.startsWith("SELECT document.source_path")) {
          return { rowCount: 1, rows: [{ source_path: SOURCE_PATH }] };
        }
        if (text.startsWith("SELECT project.project_id")) {
          return { rowCount: 1, rows: [{ project_id: PROJECT }] };
        }
        if (text.includes("FROM public.workspace_source_heads source")) {
          return { rowCount: 1, rows: [{ current_source_hash: Buffer.from(SOURCE_A, "hex") }] };
        }
        if (text.includes("FROM public.editor_documents document") && text.includes("FOR UPDATE OF document")) {
          return { rowCount: 1, rows: [documentRow({ revision: baseRevision.toString() })] };
        }
        if (text.includes("FROM public.editor_document_projections projection")) {
          const canonicalPrograms =
            scenario.expected === "corrupt-history"
              ? [PROGRAM_A]
              : scenario.history.length === 2
                ? [PROGRAM_A_REPLACED]
                : [PROGRAM_A];
          return {
            rowCount: 1,
            rows: [
              {
                canonical_programs: canonicalPrograms,
                revision: (scenario.expected === "corrupt-history" ? baseRevision + 1n : baseRevision).toString(),
              },
            ],
          };
        }
        if (text.includes("event.revision <=") && text.includes("ORDER BY event.revision")) {
          historyReads += 1;
          return { rowCount: scenario.history.length, rows: scenario.history };
        }
        if (text.startsWith("INSERT INTO public.editor_edit_events")) {
          expect(values.slice(8, 10)).toEqual([
            scenario.mutation.kind,
            scenario.mutation.kind === "append" ? null : scenario.mutation.targetTransactionId,
          ]);
          expect(values.slice(10)).toEqual([canonical.json, Buffer.from(canonical.digest, "hex"), canonical.byteSize]);
          return {
            rowCount: 1,
            rows: [
              eventRow({
                baseRevision: baseRevision.toString(),
                clientMutationId: mutationId,
                mutation: scenario.mutation,
                revision: (baseRevision + 1n).toString(),
              }),
            ],
          };
        }
        if (text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision")) {
          return { rowCount: 1, rows: [documentRow({ revision: (baseRevision + 1n).toString() })] };
        }
        if (text.startsWith("UPDATE public.editor_document_projections projection")) {
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const repository = new PostgresEditorDocumentRepositoryV1({ pool: fixture.pool });
      const request = commitInput(scenario.mutation, { baseRevision, clientMutationId: mutationId });
      if (scenario.expected === "corrupt-history") {
        await expect(repository.commitMutation(request)).rejects.toThrow(/projection ahead/i);
        expect(queryTexts(fixture.query).at(-1)).toBe("ROLLBACK");
        continue;
      }
      const result = await repository.commitMutation(request);

      if (scenario.expected === "committed") {
        expect(result).toMatchObject({ event: { mutation: scenario.mutation }, kind: "committed", replayed: false });
      } else {
        expect(result).toEqual({ currentRevision: baseRevision, kind: "conflict", reason: "invalid-mutation" });
      }
      expect(
        queryTexts(fixture.query).filter((text) => text.startsWith("INSERT INTO public.editor_edit_events")),
      ).toHaveLength(scenario.expected === "committed" ? 1 : 0);
      expect(historyReads).toBe(0);
    }
  });

  it("catches up missing or behind projections and preserves catch-up on an invalid candidate", async () => {
    const cases = [
      {
        expected: "invalid-mutation",
        history: [eventRow()],
        mutation: append(PROGRAM_A),
        projection: null,
      },
      {
        expected: "committed",
        history: [
          eventRow({
            baseRevision: "1",
            clientMutationId: "00000000-0000-4000-8000-000000000501",
            mutation: { kind: "replace", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" },
            revision: "2",
          }),
        ],
        mutation: { kind: "remove", program: PROGRAM_A_REPLACED, targetTransactionId: "editor-a" } as const,
        projection: { canonical_programs: [PROGRAM_A], revision: "1" },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const documentRevision = testCase.projection === null ? 1n : 2n;
      const mutationId = `00000000-0000-4000-8000-${(510 + index).toString().padStart(12, "0")}`;
      const projectionWrites: Readonly<{ text: string; values: readonly unknown[] }>[] = [];
      const fixture = fakePool((text, values) => {
        if (text.includes("AS actor_can_edit")) return { rowCount: 1, rows: [{ actor_can_edit: true }] };
        if (text.includes("event.subject_id = $3::uuid")) return { rowCount: 0, rows: [] };
        if (text.startsWith("SELECT document.source_path")) {
          return { rowCount: 1, rows: [{ source_path: SOURCE_PATH }] };
        }
        if (text.startsWith("SELECT project.project_id")) return { rowCount: 1, rows: [{ project_id: PROJECT }] };
        if (text.includes("FROM public.workspace_source_heads source")) {
          return { rowCount: 1, rows: [{ current_source_hash: Buffer.from(SOURCE_A, "hex") }] };
        }
        if (text.includes("FROM public.editor_documents document") && text.includes("FOR UPDATE OF document")) {
          return { rowCount: 1, rows: [documentRow({ revision: documentRevision.toString() })] };
        }
        if (text.includes("FROM public.editor_document_projections projection")) {
          return testCase.projection === null
            ? { rowCount: 0, rows: [] }
            : { rowCount: 1, rows: [testCase.projection] };
        }
        if (text.includes("event.revision > $5::bigint")) {
          expect(text).toContain("LIMIT 33");
          expect(values.slice(-2)).toEqual([testCase.projection?.revision ?? "0", documentRevision.toString()]);
          return { rowCount: testCase.history.length, rows: testCase.history };
        }
        if (
          text.startsWith("INSERT INTO public.editor_document_projections") ||
          text.startsWith("UPDATE public.editor_document_projections projection")
        ) {
          projectionWrites.push({ text, values });
          return { rowCount: 1, rows: [] };
        }
        if (text.startsWith("INSERT INTO public.editor_edit_events")) {
          return {
            rowCount: 1,
            rows: [
              eventRow({
                baseRevision: documentRevision.toString(),
                clientMutationId: mutationId,
                mutation: testCase.mutation,
                revision: (documentRevision + 1n).toString(),
              }),
            ],
          };
        }
        if (text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision")) {
          return { rowCount: 1, rows: [documentRow({ revision: (documentRevision + 1n).toString() })] };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const repository = new PostgresEditorDocumentRepositoryV1({ pool: fixture.pool });
      const result = await repository.commitMutation(
        commitInput(testCase.mutation, { baseRevision: documentRevision, clientMutationId: mutationId }),
      );

      if (testCase.expected === "invalid-mutation") {
        expect(result).toEqual({ currentRevision: 1n, kind: "conflict", reason: "invalid-mutation" });
        expect(projectionWrites).toHaveLength(1);
        expect(projectionWrites[0]?.text).toContain("INSERT INTO public.editor_document_projections");
        expect(projectionWrites[0]?.values[4]).toBe("1");
        expect(JSON.parse(String(projectionWrites[0]?.values[5]))).toEqual([PROGRAM_A]);
        expect(queryTexts(fixture.query).at(-1)).toBe("COMMIT");
      } else {
        expect(result).toMatchObject({ document: { revision: 3n }, event: { mutation: { kind: "remove" } } });
        expect(projectionWrites).toHaveLength(2);
        expect(projectionWrites[0]?.values[4]).toBe("2");
        expect(JSON.parse(String(projectionWrites[0]?.values[5]))).toEqual([PROGRAM_A_REPLACED]);
        expect(projectionWrites[0]?.values[6]).toBe("1");
        expect(projectionWrites[1]?.values.slice(4)).toEqual(["3", "[]", "2"]);
      }
    }
  });

  it("classifies non-appending conflicts and reads one bounded tenant-scoped event tail", async () => {
    const conflictCases = [
      {
        actorCanEdit: false,
        expected: { kind: "conflict", reason: "forbidden" },
        mutationId: "00000000-0000-4000-8000-000000000301",
        selected: null,
      },
      {
        actorCanEdit: true,
        expected: { kind: "conflict", reason: "not-found" },
        mutationId: "00000000-0000-4000-8000-000000000302",
        selected: null,
      },
      {
        actorCanEdit: true,
        expected: { currentRevision: 3n, kind: "conflict", reason: "document-sealed" },
        mutationId: "00000000-0000-4000-8000-000000000303",
        selected: {
          ...documentRow({ revision: "3", sealedAt: SEALED_AT }),
          current_source_hash: Buffer.from(SOURCE_A, "hex"),
        },
      },
      {
        actorCanEdit: true,
        expected: { currentRevision: 2n, kind: "conflict", reason: "source-changed" },
        mutationId: "00000000-0000-4000-8000-000000000304",
        selected: { ...documentRow({ revision: "2" }), current_source_hash: Buffer.from(SOURCE_B, "hex") },
      },
      {
        actorCanEdit: true,
        expected: { currentRevision: 3n, kind: "conflict", reason: "revision-mismatch" },
        mutationId: "00000000-0000-4000-8000-000000000305",
        selected: { ...documentRow({ revision: "3" }), current_source_hash: Buffer.from(SOURCE_A, "hex") },
      },
    ] as const;

    for (const testCase of conflictCases) {
      const fixture = fakePool((text, values) => {
        if (text.includes("AS actor_can_edit")) {
          return { rowCount: 1, rows: [{ actor_can_edit: testCase.actorCanEdit }] };
        }
        if (text.includes("FROM public.editor_edit_events event") && text.includes("client_mutation_id")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.startsWith("SELECT document.source_path")) {
          return testCase.selected ? { rowCount: 1, rows: [{ source_path: SOURCE_PATH }] } : { rowCount: 0, rows: [] };
        }
        if (text.startsWith("SELECT project.project_id")) {
          expect(text).toContain("FOR SHARE OF project");
          expect(values).toEqual([TENANT_A, PROJECT]);
          return { rowCount: 1, rows: [{ project_id: PROJECT }] };
        }
        if (text.includes("FROM public.workspace_source_heads source")) {
          expect(text).toContain("FOR SHARE OF source");
          expect(values).toEqual([TENANT_A, PROJECT, SOURCE_PATH]);
          return {
            rowCount: 1,
            rows: [{ current_source_hash: testCase.selected?.current_source_hash }],
          };
        }
        if (text.includes("FROM public.editor_documents document") && text.includes("FOR UPDATE OF document")) {
          return testCase.selected ? { rowCount: 1, rows: [testCase.selected] } : { rowCount: 0, rows: [] };
        }
        if (text.startsWith("UPDATE public.editor_documents") && text.includes("sealed_at")) {
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const repository = new PostgresEditorDocumentRepositoryV1({ pool: fixture.pool });

      await expect(
        repository.commitMutation(
          commitInput(append(PROGRAM_A), { baseRevision: 2n, clientMutationId: testCase.mutationId }),
        ),
      ).resolves.toEqual(testCase.expected);

      const texts = queryTexts(fixture.query);
      expect(texts.filter((text) => text.startsWith("INSERT INTO public.editor_edit_events"))).toHaveLength(0);
      expect(
        texts.filter(
          (text) => text.startsWith("UPDATE public.editor_documents document") && text.includes("SET revision"),
        ),
      ).toHaveLength(0);
      expect(texts.at(-1)).toBe("COMMIT");
      expect(
        texts.filter((text) => text.startsWith("UPDATE public.editor_documents") && text.includes("sealed_at")),
      ).toHaveLength(testCase.expected.reason === "source-changed" ? 1 : 0);
      if (!testCase.actorCanEdit) {
        expect(texts.some((text) => text.includes("FROM public.editor_edit_events event"))).toBe(false);
      }
    }

    let eventTailReads = 0;
    const tailFixture = fakePool((text, values) => {
      if (text.includes("FROM public.editor_documents document") && text.includes("FOR SHARE OF document")) {
        expect(text).toContain("JOIN public.workspace_projects project");
        expect(text).toContain("project.deleted_at IS NULL");
        expect(text).toContain("FOR SHARE OF document, project");
        expect(values.slice(1)).toEqual([PROJECT, Buffer.from(DOCUMENT_KEY, "hex"), EPOCH_A]);
        return values[0] === TENANT_A
          ? { rowCount: 1, rows: [documentRow({ revision: "3" })] }
          : { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.editor_edit_events event") && text.includes("event.revision >")) {
        eventTailReads += 1;
        expect(text).toContain("event.revision <= $6::bigint");
        expect(text).toContain("ORDER BY event.revision");
        expect(text).toContain("LIMIT $7");
        expect(values).toEqual([TENANT_A, PROJECT, Buffer.from(DOCUMENT_KEY, "hex"), EPOCH_A, "1", "3", 2]);
        return {
          rowCount: 2,
          rows: [
            eventRow({
              baseRevision: "1",
              clientMutationId: "00000000-0000-4000-8000-000000000401",
              mutation: append(PROGRAM_B),
              revision: "2",
            }),
            eventRow({
              baseRevision: "2",
              clientMutationId: "00000000-0000-4000-8000-000000000402",
              mutation: append(PROGRAM_C),
              revision: "3",
            }),
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const tailRepository = new PostgresEditorDocumentRepositoryV1({ pool: tailFixture.pool });
    const tailInput = {
      afterRevision: 1n,
      documentKey: DOCUMENT_KEY,
      epoch: EPOCH_A,
      limit: 2,
      projectId: PROJECT,
      tenantId: TENANT_A,
    } as const;

    const tail = await tailRepository.readEventTail(tailInput);
    expect(tail).toMatchObject({ document: { revision: 3n } });
    expect(tail?.events.map((event) => event.revision)).toEqual([2n, 3n]);
    await expect(tailRepository.readEventTail({ ...tailInput, tenantId: TENANT_B })).resolves.toBeNull();
    expect(eventTailReads).toBe(1);
  });
});
