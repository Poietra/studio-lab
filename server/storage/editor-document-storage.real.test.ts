import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { EditorSessionSnapshotV1 } from "../../src/collaboration/editor-session-contract";
import type { CanonicalEditProgram } from "../../src/studio/operations";
import { canonicalEditorProgramV1, createEditorDocumentKeyV1 } from "./editor-document-repository";
import { applyBundledDurableStorageMigrations, applyBundledDurableStorageMigrationsThrough } from "./postgres/migrate";
import { PostgresEditorDocumentRepositoryV1 } from "./postgres/postgres-editor-document-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT_A = "editor-tenant-a";
const TENANT_B = "editor-tenant-b";
const PROJECT = "editor-project";
const SOURCE_PATH = "scene.py";
const LEGACY_SOURCE_PATH = "legacy.py";
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const SCENE = `scene:${"c".repeat(64)}`;
const LEGACY_SCENE = `scene:${"d".repeat(64)}`;
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const EPOCH_A = "30000000-0000-4000-8000-000000000003";
const EPOCH_A2 = "40000000-0000-4000-8000-000000000004";
const EPOCH_B = "50000000-0000-4000-8000-000000000005";
const LEGACY_EPOCH = "51000000-0000-4000-8000-000000000005";
const NATIVE_TENANT = "editor-native-tenant";
const NATIVE_PROJECT_A = "editor-native-project-a";
const NATIVE_PROJECT_B = "editor-native-project-b";
const NATIVE_EPOCH_A = "60000000-0000-4000-8000-000000000006";
const NATIVE_EPOCH_B = "61000000-0000-4000-8000-000000000006";

function program(deltaX: number, transactionId: string): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: deltaX, y: 0 },
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
      source: { kind: "playhead", referenceSeconds: 1 },
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

function appendMutation(programValue: CanonicalEditProgram) {
  return { kind: "append", program: programValue } as const;
}

function sessionSnapshot(programs: readonly CanonicalEditProgram[], currentTime = 0): EditorSessionSnapshotV1 {
  return {
    appliedPrograms: programs.map((programValue) => ({
      program: programValue,
      validation: { issues: [], status: "valid" as const },
    })),
    currentTime,
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
  };
}

async function seedEditorFixture(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1), ($2)", [TENANT_A, TENANT_B]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.example/', 'editor-a', 'Editor A'),
              ($2::uuid, 'https://identity.example/', 'editor-b', 'Editor B')`,
      [USER_A, USER_B],
    );
    await client.query(
      `INSERT INTO public.organizations (tenant_id, display_name)
       VALUES ($1, 'Editor tenant A'), ($2, 'Editor tenant B')`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'owner')`,
      [TENANT_A, USER_A, TENANT_B, USER_B],
    );
    await client.query(
      `INSERT INTO public.workspace_projects (tenant_id, project_id, display_name)
       VALUES ($1, $3, 'Editor project A'), ($2, $3, 'Editor project B')`,
      [TENANT_A, TENANT_B, PROJECT],
    );
    await client.query(
      `INSERT INTO public.source_blob_objects
         (tenant_id, digest, object_key, version_id, etag, byte_size)
       VALUES ($1, $3, 'tenants/' || $1 || '/sources/' || $3, 'version-a', 'etag-a', 1),
              ($1, $4, 'tenants/' || $1 || '/sources/' || $4, 'version-b', 'etag-b', 1),
              ($2, $3, 'tenants/' || $2 || '/sources/' || $3, 'version-a', 'etag-a', 1)`,
      [TENANT_A, TENANT_B, SOURCE_A, SOURCE_B],
    );
    await client.query(
      `INSERT INTO public.workspace_source_heads (tenant_id, project_id, source_path, generation, digest)
       VALUES ($1, $3, $4, 1, $5), ($2, $3, $4, 1, $5), ($1, $3, $6, 1, $5)`,
      [TENANT_A, TENANT_B, PROJECT, SOURCE_PATH, SOURCE_A, LEGACY_SOURCE_PATH],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedCompatibleLegacyEditorV17(pool: Pool) {
  const documentKey = createEditorDocumentKeyV1(LEGACY_SOURCE_PATH, LEGACY_SCENE);
  const legacyProgram = program(16, "legacy-edit");
  const canonical = canonicalEditorProgramV1(legacyProgram);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, $5, decode($6, 'hex'), 0)`,
      [TENANT_A, PROJECT, documentKey, LEGACY_EPOCH, LEGACY_SOURCE_PATH, SOURCE_A],
    );
    await client.query(
      `INSERT INTO public.editor_edit_events
         (tenant_id, project_id, document_key, epoch, base_revision, revision, subject_id,
          client_mutation_id, canonical_program, canonical_digest, canonical_byte_size)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 0, 1, $5::uuid, $6::uuid,
               $7::jsonb, decode($8, 'hex'), $9)`,
      [
        TENANT_A,
        PROJECT,
        documentKey,
        LEGACY_EPOCH,
        USER_A,
        "52000000-0000-4000-8000-000000000005",
        canonical.json,
        canonical.digest,
        canonical.byteSize,
      ],
    );
    await client.query(
      `UPDATE public.editor_documents SET revision = 1
        WHERE tenant_id = $1 AND project_id = $2
          AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
      [TENANT_A, PROJECT, documentKey, LEGACY_EPOCH],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { documentKey, legacyProgram } as const;
}

async function expectCompatibleLegacyEditorUpgradedV18(
  pool: Pool,
  legacy: Awaited<ReturnType<typeof seedCompatibleLegacyEditorV17>>,
) {
  const upgraded = await pool.query<{ mutation_kind: string; target_transaction_id: string | null }>(
    `SELECT mutation_kind, target_transaction_id
       FROM public.editor_edit_events
      WHERE tenant_id = $1 AND project_id = $2
        AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
    [TENANT_A, PROJECT, legacy.documentKey, LEGACY_EPOCH],
  );
  expect(upgraded.rows).toEqual([{ mutation_kind: "append", target_transaction_id: null }]);
  const mutationKindColumn = await pool.query<{ column_default: string | null }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'editor_edit_events'
        AND column_name = 'mutation_kind'`,
  );
  expect(mutationKindColumn.rows).toEqual([{ column_default: null }]);

  const repository = new PostgresEditorDocumentRepositoryV1({
    poolConfig: { connectionString: DATABASE_URL, max: 2 },
  });
  try {
    await expect(repository.ready()).resolves.toBe(true);
    await expect(
      repository.commitMutation({
        baseRevision: 1n,
        clientMutationId: "53000000-0000-4000-8000-000000000005",
        documentKey: legacy.documentKey,
        epoch: LEGACY_EPOCH,
        mutation: appendMutation(program(24, "post-upgrade-edit")),
        projectId: PROJECT,
        subjectId: USER_A,
        tenantId: TENANT_A,
      }),
    ).resolves.toMatchObject({ document: { revision: 2n }, kind: "committed", replayed: false });
  } finally {
    await repository.close();
  }

  const projection = await pool.query<{ canonical_programs: CanonicalEditProgram[]; revision: string }>(
    `SELECT revision::text AS revision, canonical_programs
       FROM public.editor_document_projections
      WHERE tenant_id = $1 AND project_id = $2
        AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
    [TENANT_A, PROJECT, legacy.documentKey, LEGACY_EPOCH],
  );
  expect(projection.rows).toMatchObject([
    {
      canonical_programs: [
        { transactionId: legacy.legacyProgram.transactionId },
        { transactionId: "post-upgrade-edit" },
      ],
      revision: "2",
    },
  ]);
}

async function expectImportedOriginBackfilledV30(pool: Pool) {
  const backfilled = await pool.query<{ documents: string; misfiled: string }>(
    `SELECT count(*)::text AS documents,
            count(*) FILTER (WHERE origin IS DISTINCT FROM 'imported-manim')::text AS misfiled
       FROM public.editor_documents
      WHERE tenant_id IN ($1, $2)`,
    [TENANT_A, TENANT_B],
  );
  expect(backfilled.rows).toEqual([{ documents: "1", misfiled: "0" }]);
  const originColumn = await pool.query<{ column_default: string | null; is_nullable: string }>(
    `SELECT column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'editor_documents' AND column_name = 'origin'`,
  );
  expect(originColumn.rows).toEqual([{ column_default: null, is_nullable: "NO" }]);
  const sourceColumns = await pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'editor_documents'
        AND column_name IN ('source_hash', 'source_path')
      ORDER BY column_name`,
  );
  expect(sourceColumns.rows).toEqual([
    { column_name: "source_hash", is_nullable: "YES" },
    { column_name: "source_path", is_nullable: "YES" },
  ]);
}

async function expectOriginSourceBindingEnforced(pool: Pool) {
  // A native row must not carry any source binding.
  await expect(
    pool.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'studio-native', $5, decode($6, 'hex'), 0)`,
      [TENANT_A, PROJECT, "e".repeat(64), "62000000-0000-4000-8000-000000000006", SOURCE_PATH, SOURCE_A],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  // An imported row must carry its full source binding.
  await expect(
    pool.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'imported-manim', NULL, NULL, 0)`,
      [TENANT_A, PROJECT, "e".repeat(64), "62000000-0000-4000-8000-000000000006"],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  // The origin union is closed and, after the cutover, mandatory.
  await expect(
    pool.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'derived-later', $5, decode($6, 'hex'), 0)`,
      [TENANT_A, PROJECT, "e".repeat(64), "62000000-0000-4000-8000-000000000006", SOURCE_PATH, SOURCE_A],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    pool.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, $5, decode($6, 'hex'), 0)`,
      [TENANT_A, PROJECT, "e".repeat(64), "62000000-0000-4000-8000-000000000006", SOURCE_PATH, SOURCE_A],
    ),
  ).rejects.toMatchObject({ code: "23502" });
}

async function expectUnpairedEventRejected(pool: Pool, documentKey: string, epoch: string) {
  const canonical = canonicalEditorProgramV1(program(32, "unpaired-event"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.editor_edit_events
         (tenant_id, project_id, document_key, epoch, base_revision, revision, subject_id,
          client_mutation_id, mutation_kind, canonical_program, canonical_digest, canonical_byte_size)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 0, 1, $5::uuid, $6::uuid, 'append',
               $7::jsonb, decode($8, 'hex'), $9)`,
      [
        TENANT_A,
        PROJECT,
        documentKey,
        epoch,
        USER_A,
        "c0000000-0000-4000-8000-00000000000c",
        canonical.json,
        canonical.digest,
        canonical.byteSize,
      ],
    );
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe.skipIf(!DATABASE_URL)("PostgreSQL collaborative editor document authority", () => {
  it("serializes edits, replays mutations, rotates source epochs, and isolates tenants", async () => {
    const setup = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const epochSequence = [EPOCH_A, EPOCH_A2];
    const editorA = new PostgresEditorDocumentRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
      randomUuid: () => epochSequence.shift() ?? EPOCH_A2,
    });
    const peerA = new PostgresEditorDocumentRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const editorB = new PostgresEditorDocumentRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
      randomUuid: () => EPOCH_B,
    });
    try {
      expect(await applyBundledDurableStorageMigrationsThrough(setup, 17)).toEqual({ applied: true, version: 17 });
      await seedEditorFixture(setup);
      const legacy = await seedCompatibleLegacyEditorV17(setup);
      expect(await applyBundledDurableStorageMigrations(setup)).toEqual({ applied: true, version: 30 });
      expect(await applyBundledDurableStorageMigrations(setup)).toEqual({ applied: false, version: 30 });
      await expectImportedOriginBackfilledV30(setup);
      await expectOriginSourceBindingEnforced(setup);
      await expectCompatibleLegacyEditorUpgradedV18(setup, legacy);
      await expect(editorA.ready()).resolves.toBe(true);

      const openInput = {
        projectId: PROJECT,
        sceneId: SCENE,
        sourceHash: SOURCE_A,
        sourcePath: SOURCE_PATH,
        tenantId: TENANT_A,
      } as const;
      const opened = await editorA.openDocument(openInput);
      if (opened.kind !== "opened") throw new Error("The editor document did not open.");
      expect(opened).toMatchObject({ created: true, document: { epoch: EPOCH_A, revision: 0n } });
      await expect(editorA.openDocument(openInput)).resolves.toMatchObject({
        created: false,
        document: { epoch: EPOCH_A, revision: 0n },
        kind: "opened",
      });

      const emptySession = sessionSnapshot([]);
      const sessionIdentity = {
        documentKey: opened.document.documentKey,
        epoch: opened.document.epoch,
        projectId: PROJECT,
        subjectId: USER_A,
        tenantId: TENANT_A,
      } as const;
      await expect(
        editorA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 0n,
          expectedSessionGeneration: 0n,
          snapshot: emptySession,
          snapshotVersion: 1,
        }),
      ).resolves.toMatchObject({ kind: "stored", replayed: false, session: { sessionGeneration: 1n } });
      const sessionRace = await Promise.all([
        editorA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 0n,
          expectedSessionGeneration: 1n,
          snapshot: sessionSnapshot([], 1),
          snapshotVersion: 1,
        }),
        peerA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 0n,
          expectedSessionGeneration: 1n,
          snapshot: sessionSnapshot([], 2),
          snapshotVersion: 1,
        }),
      ]);
      expect(sessionRace.filter((result) => result.kind === "stored")).toHaveLength(1);
      expect(sessionRace.filter((result) => result.kind === "conflict")).toEqual([
        {
          currentSessionGeneration: 2n,
          kind: "conflict",
          reason: "session-generation-mismatch",
        },
      ]);
      await expect(peerA.readSessionSnapshot(sessionIdentity)).resolves.toMatchObject({
        kind: "available",
        session: { sessionGeneration: 2n },
      });

      const openedB = await editorB.openDocument({ ...openInput, tenantId: TENANT_B });
      if (openedB.kind !== "opened") throw new Error("The isolated editor document did not open.");
      expect(openedB.document).toMatchObject({ epoch: EPOCH_B, revision: 0n, tenantId: TENANT_B });
      await expect(
        editorB.readSessionSnapshot({ ...sessionIdentity, subjectId: USER_B, tenantId: TENANT_B }),
      ).resolves.toEqual({ currentSessionGeneration: 0n, kind: "unavailable" });
      await expectUnpairedEventRejected(setup, opened.document.documentKey, opened.document.epoch);

      const firstProgram = program(64, "first-edit");
      const contenders = [
        {
          baseRevision: 0n,
          clientMutationId: "60000000-0000-4000-8000-000000000006",
          documentKey: opened.document.documentKey,
          epoch: opened.document.epoch,
          mutation: appendMutation(firstProgram),
          projectId: PROJECT,
          subjectId: USER_A,
          tenantId: TENANT_A,
        },
        {
          baseRevision: 0n,
          clientMutationId: "70000000-0000-4000-8000-000000000007",
          documentKey: opened.document.documentKey,
          epoch: opened.document.epoch,
          mutation: appendMutation(firstProgram),
          projectId: PROJECT,
          subjectId: USER_A,
          tenantId: TENANT_A,
        },
      ] as const;
      const race = await Promise.all([editorA.commitMutation(contenders[0]), peerA.commitMutation(contenders[1])]);
      expect(race.filter((result) => result.kind === "committed")).toHaveLength(1);
      expect(race.filter((result) => result.kind === "conflict")).toEqual([
        { currentRevision: 1n, kind: "conflict", reason: "revision-mismatch" },
      ]);
      const winnerIndex = race.findIndex((result) => result.kind === "committed");
      const winner = race[winnerIndex];
      if (winner?.kind !== "committed") throw new Error("The edit race produced no winner.");
      const winnerInput = contenders[winnerIndex]!;
      await expect(editorA.commitMutation(winnerInput)).resolves.toMatchObject({
        event: { digest: winner.event.digest, revision: 1n },
        kind: "committed",
        replayed: true,
      });
      await expect(
        editorA.commitMutation({ ...winnerInput, mutation: appendMutation(program(65, "changed-reuse")) }),
      ).resolves.toEqual({ kind: "conflict", reason: "mutation-reused" });

      const rejectedAtomicMutationId = "7f000000-0000-4000-8000-000000000007";
      await expect(
        editorA.commitMutation({
          ...winnerInput,
          baseRevision: 1n,
          clientMutationId: rejectedAtomicMutationId,
          mutation: appendMutation(program(80, "rejected-atomic-edit")),
          sessionUpdate: {
            documentRevision: 2n,
            expectedSessionGeneration: 1n,
            snapshot: sessionSnapshot([firstProgram, program(80, "rejected-atomic-edit")]),
            snapshotVersion: 1,
          },
        }),
      ).resolves.toEqual({
        currentRevision: 1n,
        currentSessionGeneration: 2n,
        kind: "conflict",
        reason: "session-generation-mismatch",
      });
      const rejectedAtomicEvidence = await setup.query<{ event_count: string; revision: string }>(
        `SELECT document.revision::text AS revision,
                count(event.client_mutation_id)::text AS event_count
           FROM public.editor_documents document
           LEFT JOIN public.editor_edit_events event
             ON event.tenant_id = document.tenant_id AND event.project_id = document.project_id
            AND event.document_key = document.document_key AND event.epoch = document.epoch
            AND event.client_mutation_id = $1::uuid
          WHERE document.tenant_id = $2 AND document.project_id = $3
            AND document.document_key = decode($4, 'hex') AND document.epoch = $5::uuid
          GROUP BY document.revision`,
        [rejectedAtomicMutationId, TENANT_A, PROJECT, opened.document.documentKey, EPOCH_A],
      );
      expect(rejectedAtomicEvidence.rows).toEqual([{ event_count: "0", revision: "1" }]);

      const secondProgram = program(96, "second-edit");
      const secondInput = {
        ...winnerInput,
        baseRevision: 1n,
        clientMutationId: "80000000-0000-4000-8000-000000000008",
        mutation: appendMutation(secondProgram),
        sessionUpdate: {
          documentRevision: 2n,
          expectedSessionGeneration: 2n,
          snapshot: sessionSnapshot([firstProgram, secondProgram]),
          snapshotVersion: 1,
        },
      } as const;
      const second = await editorA.commitMutation(secondInput);
      expect(second).toMatchObject({
        document: { revision: 2n },
        event: { revision: 2n },
        kind: "committed",
        sessionUpdate: { documentRevision: 2n, sessionGeneration: 3n },
      });
      await expect(
        peerA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 2n,
          expectedSessionGeneration: 3n,
          snapshot: sessionSnapshot([firstProgram, secondProgram], 3),
          snapshotVersion: 1,
        }),
      ).resolves.toMatchObject({ kind: "stored", session: { sessionGeneration: 4n } });
      await expect(editorA.commitMutation(secondInput)).resolves.toMatchObject({
        kind: "committed",
        replayed: true,
        sessionUpdate: { documentRevision: 2n, sessionGeneration: 3n },
      });
      await expect(peerA.readSessionSnapshot(sessionIdentity)).resolves.toMatchObject({
        kind: "available",
        session: {
          documentRevision: 2n,
          sessionGeneration: 4n,
          snapshot: { currentTime: 3 },
        },
      });
      const replacementProgram = program(72, "first-edit");
      await expect(
        editorA.commitMutation({
          ...winnerInput,
          baseRevision: 2n,
          clientMutationId: "81000000-0000-4000-8000-000000000008",
          mutation: { kind: "replace", program: replacementProgram, targetTransactionId: "first-edit" },
        }),
      ).resolves.toMatchObject({ document: { revision: 3n }, event: { mutation: { kind: "replace" }, revision: 3n } });
      await expect(peerA.readSessionSnapshot(sessionIdentity)).resolves.toEqual({
        currentSessionGeneration: 4n,
        kind: "unavailable",
      });
      await expect(
        peerA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 3n,
          expectedSessionGeneration: 4n,
          snapshot: sessionSnapshot([replacementProgram, secondProgram], 4),
          snapshotVersion: 1,
        }),
      ).resolves.toMatchObject({ kind: "stored", session: { sessionGeneration: 5n } });
      for (const [clientMutationId, mutation] of [
        [
          "82000000-0000-4000-8000-000000000008",
          { kind: "replace", program: program(12, "missing"), targetTransactionId: "missing" },
        ],
        [
          "83000000-0000-4000-8000-000000000008",
          { kind: "remove", program: firstProgram, targetTransactionId: "first-edit" },
        ],
      ] as const) {
        await expect(
          editorA.commitMutation({ ...winnerInput, baseRevision: 3n, clientMutationId, mutation }),
        ).resolves.toEqual({ currentRevision: 3n, kind: "conflict", reason: "invalid-mutation" });
      }
      await expect(
        editorA.commitMutation({
          ...winnerInput,
          baseRevision: 3n,
          clientMutationId: "84000000-0000-4000-8000-000000000008",
          mutation: { kind: "remove", program: replacementProgram, targetTransactionId: "first-edit" },
        }),
      ).resolves.toMatchObject({ document: { revision: 4n }, event: { mutation: { kind: "remove" }, revision: 4n } });
      const projection = await setup.query<{ canonical_programs: CanonicalEditProgram[]; revision: string }>(
        `SELECT revision::text AS revision, canonical_programs
           FROM public.editor_document_projections
          WHERE tenant_id = $1 AND project_id = $2
            AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
        [TENANT_A, PROJECT, opened.document.documentKey, EPOCH_A],
      );
      expect(projection.rows).toMatchObject([
        { canonical_programs: [{ transactionId: "second-edit" }], revision: "4" },
      ]);
      await expect(editorA.openDocument(openInput)).resolves.toMatchObject({
        created: false,
        document: { epoch: EPOCH_A, revision: 4n },
        kind: "opened",
        projection: { programs: [{ transactionId: "second-edit" }], revision: 4n },
      });
      await expect(
        editorA.readEventTail({
          afterRevision: 0n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 1,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ document: { revision: 4n }, events: [{ revision: 1n }] });
      await expect(
        editorA.readEventTail({
          afterRevision: 1n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 10,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ events: [{ revision: 2n }, { revision: 3n }, { revision: 4n }] });

      await expect(
        editorB.readEventTail({
          afterRevision: 0n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 10,
          projectId: PROJECT,
          tenantId: TENANT_B,
        }),
      ).resolves.toBeNull();
      await setup.query(
        `UPDATE public.workspace_projects SET deleted_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2`,
        [TENANT_B, PROJECT],
      );
      await expect(
        editorB.readEventTail({
          afterRevision: 0n,
          documentKey: openedB.document.documentKey,
          epoch: openedB.document.epoch,
          limit: 10,
          projectId: PROJECT,
          tenantId: TENANT_B,
        }),
      ).resolves.toBeNull();
      await expect(
        editorB.commitMutation({
          baseRevision: 0n,
          clientMutationId: "90000000-0000-4000-8000-000000000009",
          documentKey: openedB.document.documentKey,
          epoch: openedB.document.epoch,
          mutation: appendMutation(program(112, "deleted-project-edit")),
          projectId: PROJECT,
          subjectId: USER_B,
          tenantId: TENANT_B,
        }),
      ).resolves.toEqual({ kind: "conflict", reason: "not-found" });

      await expect(
        setup.query(
          `UPDATE public.editor_documents SET source_hash = decode($1, 'hex')
            WHERE tenant_id = $2 AND project_id = $3 AND document_key = decode($4, 'hex') AND epoch = $5::uuid`,
          [SOURCE_B, TENANT_A, PROJECT, opened.document.documentKey, EPOCH_A],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await setup.query(
        `UPDATE public.workspace_source_heads SET digest = $1, generation = generation + 1
          WHERE tenant_id = $2 AND project_id = $3 AND source_path = $4`,
        [SOURCE_B, TENANT_A, PROJECT, SOURCE_PATH],
      );
      await expect(
        editorA.commitMutation({
          ...winnerInput,
          baseRevision: 4n,
          clientMutationId: "a0000000-0000-4000-8000-00000000000a",
          mutation: appendMutation(program(128, "stale-source")),
        }),
      ).resolves.toEqual({ currentRevision: 4n, kind: "conflict", reason: "source-changed" });
      await expect(
        editorA.readEventTail({
          afterRevision: 4n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 1,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ document: { revision: 4n, sealedAt: expect.any(Date) }, events: [] });
      await expect(editorA.commitMutation(winnerInput)).resolves.toMatchObject({ kind: "committed", replayed: true });
      const reopened = await editorA.openDocument({ ...openInput, sourceHash: SOURCE_B });
      expect(reopened).toMatchObject({ created: true, document: { epoch: EPOCH_A2, revision: 0n }, kind: "opened" });
      if (reopened.kind !== "opened") throw new Error("The replacement editor epoch did not open.");
      await expect(
        editorA.putSessionSnapshot({
          ...sessionIdentity,
          documentRevision: 0n,
          epoch: reopened.document.epoch,
          expectedSessionGeneration: 0n,
          snapshot: emptySession,
          snapshotVersion: 1,
        }),
      ).resolves.toMatchObject({
        kind: "stored",
        replayed: false,
        session: { epoch: EPOCH_A2, sessionGeneration: 1n },
      });

      await expect(
        setup.query(
          `UPDATE public.editor_edit_events SET canonical_byte_size = canonical_byte_size + 1
            WHERE tenant_id = $1 AND project_id = $2 AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
          [TENANT_A, PROJECT, opened.document.documentKey, EPOCH_A],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        setup.query(
          `INSERT INTO public.editor_documents
             (tenant_id, project_id, document_key, epoch, source_path, source_hash, revision, sealed_at)
           VALUES ($1, $2, decode($3, 'hex'), $4::uuid, $5, decode($6, 'hex'), 1, clock_timestamp())`,
          [
            TENANT_A,
            PROJECT,
            opened.document.documentKey,
            "b0000000-0000-4000-8000-00000000000b",
            SOURCE_PATH,
            SOURCE_B,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await Promise.allSettled([editorA.close(), peerA.close(), editorB.close()]);
      await setup.end();
    }
  });

  it("creates source-free native documents atomically beside the deterministic imported lane", async () => {
    const setup = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const epochs = [NATIVE_EPOCH_A, NATIVE_EPOCH_B, NATIVE_EPOCH_B];
    const repository = new PostgresEditorDocumentRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
      randomUuid: () => epochs.shift() ?? NATIVE_EPOCH_B,
    });
    try {
      await applyBundledDurableStorageMigrations(setup);
      await expect(repository.ready()).resolves.toBe(true);

      const created = await repository.createNativeDocument({
        name: "Native Studio project",
        projectId: NATIVE_PROJECT_A,
        tenantId: NATIVE_TENANT,
      });
      expect(created).toMatchObject({
        document: {
          epoch: NATIVE_EPOCH_A,
          origin: "studio-native",
          projectId: NATIVE_PROJECT_A,
          revision: 0n,
          sealedAt: null,
          sourceHash: null,
          sourcePath: null,
          tenantId: NATIVE_TENANT,
        },
        kind: "created",
        project: { name: "Native Studio project", projectId: NATIVE_PROJECT_A, tenantId: NATIVE_TENANT },
        projection: { programs: [], revision: 0n },
      });
      expect(created.document.documentKey).toMatch(/^[0-9a-f]{64}$/u);

      const second = await repository.createNativeDocument({
        name: "Second native project",
        projectId: NATIVE_PROJECT_B,
        tenantId: NATIVE_TENANT,
      });
      expect(second.document.documentKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(second.document.documentKey).not.toBe(created.document.documentKey);

      // The native lane persists no starter source artifact of any kind.
      const sourceArtifacts = await setup.query<{ blobs: string; heads: string }>(
        `SELECT (SELECT count(*) FROM public.workspace_source_heads WHERE tenant_id = $1)::text AS heads,
                (SELECT count(*) FROM public.source_blob_objects WHERE tenant_id = $1)::text AS blobs`,
        [NATIVE_TENANT],
      );
      expect(sourceArtifacts.rows).toEqual([{ blobs: "0", heads: "0" }]);
      const persisted = await setup.query<{ origin: string; projection_revision: string; revision: string }>(
        `SELECT document.origin, document.revision::text AS revision,
                projection.revision::text AS projection_revision
           FROM public.editor_documents document
           JOIN public.editor_document_projections projection
             ON projection.tenant_id = document.tenant_id AND projection.project_id = document.project_id
            AND projection.document_key = document.document_key AND projection.epoch = document.epoch
          WHERE document.tenant_id = $1
          ORDER BY document.project_id`,
        [NATIVE_TENANT],
      );
      expect(persisted.rows).toEqual([
        { origin: "studio-native", projection_revision: "0", revision: "0" },
        { origin: "studio-native", projection_revision: "0", revision: "0" },
      ]);

      // A duplicate project is one atomic conflict: no project, document, or
      // projection row survives the rolled-back create.
      await expect(
        repository.createNativeDocument({
          name: "Duplicate native project",
          projectId: NATIVE_PROJECT_A,
          tenantId: NATIVE_TENANT,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const counts = await setup.query<{ documents: string; projections: string; projects: string }>(
        `SELECT (SELECT count(*) FROM public.workspace_projects WHERE tenant_id = $1 AND deleted_at IS NULL)::text
                  AS projects,
                (SELECT count(*) FROM public.editor_documents WHERE tenant_id = $1)::text AS documents,
                (SELECT count(*) FROM public.editor_document_projections WHERE tenant_id = $1)::text AS projections`,
        [NATIVE_TENANT],
      );
      expect(counts.rows).toEqual([{ documents: "2", projections: "2", projects: "2" }]);
    } finally {
      await repository.close();
      await setup.end();
    }
  });
});
