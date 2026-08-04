import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { EditorCollaborationAuthorizationLeaseV1 } from "../../editor-collaboration-authorization";
import { PostgresEditorCollaborationAuthorizationRepositoryV1 } from "./postgres-editor-collaboration-authorization-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

const room = {
  documentKey: "a".repeat(64),
  epoch: "11111111-1111-4111-8111-111111111111",
  organizationId: "organization-a",
  projectId: "project-a",
} as const;
const requestedRoom = {
  documentKey: room.documentKey,
  epoch: room.epoch,
  projectId: room.projectId,
} as const;
const authorizationId = "22222222-2222-4222-8222-222222222222";
const secondAuthorizationId = "33333333-3333-4333-8333-333333333333";
const subjectId = "44444444-4444-4444-8444-444444444444";

function authorizationRow(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: authorizationId,
    document_authorized: true,
    membership_version: "3",
    organization_id: room.organizationId,
    role: "member",
    session_expires_at_ms: "2000000120000",
    session_version: "2",
    subject_id: subjectId,
    ...overrides,
  };
}

function lease(overrides: Partial<EditorCollaborationAuthorizationLeaseV1> = {}) {
  return {
    ...room,
    authorizationId,
    canWrite: true,
    leaseExpiresAtMs: 2_000_000_060_000,
    membershipVersion: 3,
    sessionVersion: 2,
    subjectId,
    ...overrides,
  } satisfies EditorCollaborationAuthorizationLeaseV1;
}

function fakePool(handle: (text: string, values: readonly unknown[]) => readonly unknown[]) {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    const rows = handle(text, values);
    return { rowCount: rows.length, rows };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
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
  return { pool, query };
}

describe("PostgresEditorCollaborationAuthorizationRepositoryV1", () => {
  it("authorizes one active session and derives its active organization without exposing the token hash", async () => {
    const hash = Buffer.alloc(32, 7);
    const fixture = fakePool((text, values) => {
      expect(text).toContain("WITH selected_session AS MATERIALIZED");
      expect(text).toContain("session.session_token_hash = $1");
      expect(text).toContain("session.revoked_at IS NULL");
      expect(text).toContain("session.expires_at > clock_timestamp()");
      expect(text).toContain("account.status = 'active'");
      expect(text).toContain("membership.status = 'active'");
      expect(text).toContain("organization.status = 'active'");
      expect(text).toContain("project.deleted_at IS NULL");
      expect(text).toContain("document.sealed_at IS NULL");
      expect(values).toHaveLength(4);
      expect(Buffer.compare(values[0] as Buffer, hash)).toBe(0);
      expect(values.slice(1)).toEqual([room.projectId, Buffer.from(room.documentKey, "hex"), room.epoch]);
      return [authorizationRow()];
    });
    const repository = new PostgresEditorCollaborationAuthorizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.authorizeSession(hash, requestedRoom)).resolves.toEqual({
      grant: {
        ...room,
        authorizationId,
        canWrite: true,
        membershipVersion: 3,
        sessionExpiresAtMs: 2_000_000_120_000,
        sessionVersion: 2,
        subjectId,
      },
      kind: "authorized",
    });
  });

  it("distinguishes an invalid session from denied room or membership authority", async () => {
    const invalid = new PostgresEditorCollaborationAuthorizationRepositoryV1({
      pool: fakePool(() => []).pool,
    });
    await expect(invalid.authorizeSession(Buffer.alloc(32), requestedRoom)).resolves.toEqual({
      kind: "invalid-session",
    });

    for (const row of [
      authorizationRow({ document_authorized: false }),
      authorizationRow({ membership_version: null, role: null }),
      authorizationRow({ role: "billing" }),
    ]) {
      const denied = new PostgresEditorCollaborationAuthorizationRepositoryV1({
        pool: fakePool(() => [row]).pool,
      });
      await expect(denied.authorizeSession(Buffer.alloc(32), requestedRoom)).resolves.toEqual({ kind: "denied" });
    }
  });

  it("revalidates duplicate tabs in one bounded room query and preserves input order", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("session.authorization_id = ANY($1::uuid[])");
      expect(text).toContain("session.active_tenant_id = $2");
      expect(values).toEqual([
        [authorizationId, secondAuthorizationId],
        room.organizationId,
        room.projectId,
        Buffer.from(room.documentKey, "hex"),
        room.epoch,
      ]);
      return [authorizationRow(), authorizationRow({ authorization_id: secondAuthorizationId, role: "admin" })];
    });
    const repository = new PostgresEditorCollaborationAuthorizationRepositoryV1({ pool: fixture.pool });
    const second = lease({ authorizationId: secondAuthorizationId });

    const result = await repository.revalidateAuthorizations([lease(), second, lease()]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ authorizationId, canWrite: true });
    expect(result[1]).toMatchObject({ authorizationId: secondAuthorizationId, canWrite: true });
    expect(result[2]).toEqual(result[0]);
    expect(fixture.query).toHaveBeenCalledOnce();
  });

  it("maps missing authorization rows to revocation and rejects foreign or malformed rows", async () => {
    const revoked = new PostgresEditorCollaborationAuthorizationRepositoryV1({
      pool: fakePool(() => []).pool,
    });
    await expect(revoked.revalidateAuthorizations([lease()])).resolves.toEqual([null]);

    const downgraded = new PostgresEditorCollaborationAuthorizationRepositoryV1({
      pool: fakePool(() => [authorizationRow({ role: "billing" })]).pool,
    });
    await expect(downgraded.revalidateAuthorizations([lease()])).resolves.toEqual([null]);

    for (const row of [
      authorizationRow({ authorization_id: secondAuthorizationId }),
      authorizationRow({ membership_version: "0" }),
      authorizationRow({ organization_id: "organization-b" }),
    ]) {
      const malformed = new PostgresEditorCollaborationAuthorizationRepositoryV1({
        pool: fakePool(() => [row]).pool,
      });
      await expect(malformed.revalidateAuthorizations([lease()])).rejects.toThrow();
    }
  });

  it("rejects hashes, cross-room batches, and oversized batches before PostgreSQL", async () => {
    const fixture = fakePool(() => []);
    const repository = new PostgresEditorCollaborationAuthorizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.authorizeSession(new Uint8Array(31), requestedRoom)).rejects.toThrow(/32 bytes/u);
    await expect(repository.revalidateAuthorizations([lease(), lease({ projectId: "project-b" })])).rejects.toThrow(
      /crosses rooms/u,
    );
    await expect(repository.revalidateAuthorizations(Array.from({ length: 65 }, () => lease()))).rejects.toThrow(
      /batch is invalid/u,
    );
    expect(fixture.query).not.toHaveBeenCalled();
  });
});
