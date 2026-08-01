import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../../src/studio/operations";
import { canonicalEditorProgramV1 } from "./editor-document-repository";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresEditorDocumentRepositoryV1 } from "./postgres/postgres-editor-document-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT_A = "editor-tenant-a";
const TENANT_B = "editor-tenant-b";
const PROJECT = "editor-project";
const SOURCE_PATH = "scene.py";
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const SCENE = `scene:${"c".repeat(64)}`;
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const EPOCH_A = "30000000-0000-4000-8000-000000000003";
const EPOCH_A2 = "40000000-0000-4000-8000-000000000004";
const EPOCH_B = "50000000-0000-4000-8000-000000000005";

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
       VALUES ($1, $3, $4, 1, $5), ($2, $3, $4, 1, $5)`,
      [TENANT_A, TENANT_B, PROJECT, SOURCE_PATH, SOURCE_A],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectUnpairedEventRejected(pool: Pool, documentKey: string, epoch: string) {
  const canonical = canonicalEditorProgramV1(program(32, "unpaired-event"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
      expect(await applyBundledDurableStorageMigrations(setup)).toEqual({ applied: true, version: 17 });
      await seedEditorFixture(setup);
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

      const openedB = await editorB.openDocument({ ...openInput, tenantId: TENANT_B });
      if (openedB.kind !== "opened") throw new Error("The isolated editor document did not open.");
      expect(openedB.document).toMatchObject({ epoch: EPOCH_B, revision: 0n, tenantId: TENANT_B });
      await expectUnpairedEventRejected(setup, opened.document.documentKey, opened.document.epoch);

      const firstProgram = program(64, "first-edit");
      const contenders = [
        {
          baseRevision: 0n,
          clientMutationId: "60000000-0000-4000-8000-000000000006",
          documentKey: opened.document.documentKey,
          epoch: opened.document.epoch,
          program: firstProgram,
          projectId: PROJECT,
          subjectId: USER_A,
          tenantId: TENANT_A,
        },
        {
          baseRevision: 0n,
          clientMutationId: "70000000-0000-4000-8000-000000000007",
          documentKey: opened.document.documentKey,
          epoch: opened.document.epoch,
          program: firstProgram,
          projectId: PROJECT,
          subjectId: USER_A,
          tenantId: TENANT_A,
        },
      ] as const;
      const race = await Promise.all([editorA.commitProgram(contenders[0]), peerA.commitProgram(contenders[1])]);
      expect(race.filter((result) => result.kind === "committed")).toHaveLength(1);
      expect(race.filter((result) => result.kind === "conflict")).toEqual([
        { currentRevision: 1n, kind: "conflict", reason: "revision-mismatch" },
      ]);
      const winnerIndex = race.findIndex((result) => result.kind === "committed");
      const winner = race[winnerIndex];
      if (winner?.kind !== "committed") throw new Error("The edit race produced no winner.");
      const winnerInput = contenders[winnerIndex]!;
      await expect(editorA.commitProgram(winnerInput)).resolves.toMatchObject({
        event: { digest: winner.event.digest, revision: 1n },
        kind: "committed",
        replayed: true,
      });
      await expect(editorA.commitProgram({ ...winnerInput, program: program(65, "changed-reuse") })).resolves.toEqual({
        kind: "conflict",
        reason: "mutation-reused",
      });

      const second = await editorA.commitProgram({
        ...winnerInput,
        baseRevision: 1n,
        clientMutationId: "80000000-0000-4000-8000-000000000008",
        program: program(96, "second-edit"),
      });
      expect(second).toMatchObject({ document: { revision: 2n }, event: { revision: 2n }, kind: "committed" });
      await expect(
        editorA.readEventTail({
          afterRevision: 0n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 1,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ document: { revision: 2n }, events: [{ revision: 1n }] });
      await expect(
        editorA.readEventTail({
          afterRevision: 1n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 10,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ events: [{ revision: 2n }] });

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
      await expect(
        editorB.commitProgram({
          ...winnerInput,
          clientMutationId: "90000000-0000-4000-8000-000000000009",
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
        editorA.commitProgram({
          ...winnerInput,
          baseRevision: 2n,
          clientMutationId: "a0000000-0000-4000-8000-00000000000a",
          program: program(128, "stale-source"),
        }),
      ).resolves.toEqual({ currentRevision: 2n, kind: "conflict", reason: "source-changed" });
      await expect(
        editorA.readEventTail({
          afterRevision: 2n,
          documentKey: opened.document.documentKey,
          epoch: EPOCH_A,
          limit: 1,
          projectId: PROJECT,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ document: { revision: 2n, sealedAt: expect.any(Date) }, events: [] });
      await expect(editorA.commitProgram(winnerInput)).resolves.toMatchObject({ kind: "committed", replayed: true });
      const reopened = await editorA.openDocument({ ...openInput, sourceHash: SOURCE_B });
      expect(reopened).toMatchObject({ created: true, document: { epoch: EPOCH_A2, revision: 0n }, kind: "opened" });

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
});
