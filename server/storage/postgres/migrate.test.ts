import type { Pool } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM,
  ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE,
  ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM,
  ACCOUNT_SESSION_MIGRATION_V12_SOURCE,
  applyAccountOrganizationMigrationV11,
  applyAccountSessionMigrationV12,
  applyBundledDurableStorageMigrations,
  applyBundledDurableStorageMigrationsThrough,
  type applyBundledDurableStorageMigrationsV2,
  type applyBundledWorkspaceSourceMigrationV1,
  applyEditorDocumentMigrationV17,
  applyEditorMutationMigrationV18,
  applyOidcLoginMigrationV13,
  applyProjectPngMigrationV5,
  applyRenderArtifactMigrationV4,
  applyRenderCancellationMigrationV7,
  applyRenderSessionCpuFailureMigrationV9,
  applyRenderSessionFailureMigrationV8,
  applyRenderSessionMigrationV2,
  applyRenderSessionRetentionMigrationV6,
  applySnapshotPublicationMigrationV3,
  applySnapshotRuntimeDigestMigrationV10,
  applyWorkspaceSourceMigrationV1,
  BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM,
  BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE,
  durableStorageMigrationChecksum,
  EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM,
  EDITOR_DOCUMENT_MIGRATION_V17_SOURCE,
  EDITOR_MUTATION_MIGRATION_V18_CHECKSUM,
  EDITOR_MUTATION_MIGRATION_V18_SOURCE,
  OIDC_LOGIN_MIGRATION_V13_CHECKSUM,
  OIDC_LOGIN_MIGRATION_V13_SOURCE,
  PROJECT_PNG_MIGRATION_V5_SOURCE,
  RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  RENDER_SESSION_MIGRATION_V2_SOURCE,
  RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM,
  RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE,
  STRIPE_BILLING_MIGRATION_V16_CHECKSUM,
  STRIPE_BILLING_MIGRATION_V16_SOURCE,
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
} from "./migrate";

function database(initial: ReadonlyMap<number, string> = new Map()) {
  const installed = new Map(initial);
  let migrationTableExists = installed.size > 0;
  const queries: Array<Readonly<{ parameters?: readonly unknown[]; text: string }>> = [];
  const query = vi.fn(async (text: string, parameters?: readonly unknown[]) => {
    queries.push({ ...(parameters ? { parameters } : {}), text });
    if (text.includes("to_regclass")) {
      return { rowCount: 1, rows: [{ relation: migrationTableExists ? "poietra_schema_migrations" : null }] };
    }
    if (text.startsWith("SELECT version, checksum")) {
      const maximum = parameters?.[0] as number;
      return {
        rowCount: installed.size,
        rows: [...installed]
          .filter(([version]) => version <= maximum)
          .map(([version, checksum]) => ({ checksum, version })),
      };
    }
    if (text === WORKSPACE_SOURCE_MIGRATION_V1_SOURCE) migrationTableExists = true;
    if (text.startsWith("INSERT INTO public.poietra_schema_migrations")) {
      installed.set(parameters?.[0] as number, parameters?.[1] as string);
    }
    return { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { connect, installed, pool: { connect } as unknown as Pool, queries, release };
}

describe("durable storage migrations", () => {
  it("preserves the public literal versions of compatibility helpers", () => {
    expectTypeOf<Awaited<ReturnType<typeof applyBundledWorkspaceSourceMigrationV1>>>().toEqualTypeOf<
      Readonly<{ applied: false; version: 1 }> | Readonly<{ applied: true; version: 1 }>
    >();
    expectTypeOf<Awaited<ReturnType<typeof applyBundledDurableStorageMigrationsV2>>>().toEqualTypeOf<
      Readonly<{ applied: false; version: 2 }> | Readonly<{ applied: true; version: 2 }>
    >();
  });

  it("applies the ordered catalog and then verifies it idempotently", async () => {
    const db = database();
    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: true, version: 18 });
    expect([...db.installed.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: false, version: 18 });
    expect(db.queries.filter(({ text }) => text === WORKSPACE_SOURCE_MIGRATION_V1_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_MIGRATION_V2_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_ARTIFACT_MIGRATION_V4_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === PROJECT_PNG_MIGRATION_V5_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_CANCELLATION_MIGRATION_V7_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === ACCOUNT_SESSION_MIGRATION_V12_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === OIDC_LOGIN_MIGRATION_V13_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === STRIPE_BILLING_MIGRATION_V16_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === EDITOR_DOCUMENT_MIGRATION_V17_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === EDITOR_MUTATION_MIGRATION_V18_SOURCE)).toHaveLength(1);
    expect(db.release).toHaveBeenCalledTimes(36);
  });

  it("applies an exact bundled prefix before a later cutover", async () => {
    const db = database();
    await expect(applyBundledDurableStorageMigrationsThrough(db.pool, 17)).resolves.toEqual({
      applied: true,
      version: 17,
    });
    expect([...db.installed.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(db.queries.some(({ text }) => text === EDITOR_MUTATION_MIGRATION_V18_SOURCE)).toBe(false);

    await expect(applyBundledDurableStorageMigrationsThrough(db.pool, 17)).resolves.toEqual({
      applied: false,
      version: 17,
    });
    await expect(applyBundledDurableStorageMigrationsThrough(db.pool, 18)).resolves.toEqual({
      applied: true,
      version: 18,
    });
    expect([...db.installed.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("rejects an unknown bundled target before acquiring a connection", async () => {
    const db = database();
    await expect(applyBundledDurableStorageMigrationsThrough(db.pool, 19)).rejects.toThrow(
      /migration v19 is not bundled/i,
    );
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects a missing prerequisite under the same advisory lock", async () => {
    const db = database();
    await expect(applyRenderSessionMigrationV2(db.pool, RENDER_SESSION_MIGRATION_V2_SOURCE)).rejects.toThrow(
      /requires workspace\/source migration v1/i,
    );
    expect(db.queries.some(({ text }) => text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects modified migration source before acquiring a connection", async () => {
    const db = database();
    await expect(applyWorkspaceSourceMigrationV1(db.pool, `${WORKSPACE_SOURCE_MIGRATION_V1_SOURCE}\n`)).rejects.toThrow(
      /checksum is invalid/i,
    );
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("requires both durable-storage prerequisites before applying snapshot publication v3", async () => {
    const db = database();
    await expect(
      applySnapshotPublicationMigrationV3(db.pool, SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 and v2/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all three durable-storage prerequisites before applying render artifacts v4", async () => {
    const db = database();
    await expect(applyRenderArtifactMigrationV4(db.pool, RENDER_ARTIFACT_MIGRATION_V4_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v3/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all four durable-storage prerequisites before applying project image.png v5", async () => {
    const db = database();
    await expect(applyProjectPngMigrationV5(db.pool, PROJECT_PNG_MIGRATION_V5_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v4/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all five durable-storage prerequisites before applying render-session retention v6", async () => {
    const db = database();
    await expect(
      applyRenderSessionRetentionMigrationV6(db.pool, RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v5/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all six durable-storage prerequisites before applying render cancellation v7", async () => {
    const db = database();
    await expect(applyRenderCancellationMigrationV7(db.pool, RENDER_CANCELLATION_MIGRATION_V7_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v6/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all seven durable-storage prerequisites before applying render-session failures v8", async () => {
    const db = database();
    await expect(
      applyRenderSessionFailureMigrationV8(db.pool, RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v7/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all eight durable-storage prerequisites before applying render-session CPU failures v9", async () => {
    const db = database();
    await expect(
      applyRenderSessionCpuFailureMigrationV9(db.pool, RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v8/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all nine durable-storage prerequisites before applying snapshot runtime digests v10", async () => {
    const db = database();
    await expect(
      applySnapshotRuntimeDigestMigrationV10(db.pool, SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v9/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all ten durable-storage prerequisites before applying accounts and organizations v11", async () => {
    const db = database();
    await expect(
      applyAccountOrganizationMigrationV11(db.pool, ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v10/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("pins the account and organization migration checksum", () => {
    expect(durableStorageMigrationChecksum(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE)).toBe(
      ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM,
    );
  });

  it("requires all eleven durable-storage prerequisites before applying account sessions v12", async () => {
    const db = database();
    await expect(applyAccountSessionMigrationV12(db.pool, ACCOUNT_SESSION_MIGRATION_V12_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v11/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("pins a hashed opaque-session schema to active organization membership", () => {
    expect(durableStorageMigrationChecksum(ACCOUNT_SESSION_MIGRATION_V12_SOURCE)).toBe(
      ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM,
    );
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).toContain("session_token_hash bytea PRIMARY KEY");
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).toContain("octet_length(session_token_hash) = 32");
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).toContain(
      "REFERENCES public.organization_memberships (tenant_id, user_id)",
    );
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).toContain("ON DELETE CASCADE");
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).toContain("advance_account_record_version_v11()");
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).not.toContain("access_token");
    expect(ACCOUNT_SESSION_MIGRATION_V12_SOURCE).not.toContain("refresh_token");
  });

  it("requires all twelve durable-storage prerequisites before applying OIDC login v13", async () => {
    const db = database();
    await expect(applyOidcLoginMigrationV13(db.pool, OIDC_LOGIN_MIGRATION_V13_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v12/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("pins one-time OIDC attempts and bounds opaque browser sessions in v13", () => {
    expect(durableStorageMigrationChecksum(OIDC_LOGIN_MIGRATION_V13_SOURCE)).toBe(OIDC_LOGIN_MIGRATION_V13_CHECKSUM);
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("state_hash bytea PRIMARY KEY");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("browser_binding_hash bytea NOT NULL");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("octet_length(state_hash) = 32");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("expires_at <= created_at + interval '10 minutes'");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("account_sessions_bounded_lifetime_v13");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).toContain("expires_at <= created_at + interval '30 days'");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).not.toContain("access_token");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).not.toContain("refresh_token");
    expect(OIDC_LOGIN_MIGRATION_V13_SOURCE).not.toContain("return_path");
  });

  it("pins bounded append-only entitlement and usage ledgers in v14", () => {
    expect(durableStorageMigrationChecksum(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE)).toBe(
      BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM,
    );
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("CREATE TABLE public.billing_accounts");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("CREATE TABLE public.entitlement_snapshots");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("render_job_limit BETWEEN 0 AND 1000000");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("render_enabled = (render_job_limit > 0)");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("access_state IN ('active', 'grace', 'blocked')");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("period_start < access_until");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain(
      "Overlapping entitlement periods must share one usage period key.",
    );
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("CREATE TABLE public.usage_reservations");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("interval '1 second'");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("interval '30 minutes'");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("A terminal usage reservation is immutable.");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("Usage reservations cannot be deleted.");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain(
      "CREATE CONSTRAINT TRIGGER usage_reservations_require_terminal_event_v14",
    );
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain(
      "A terminal usage reservation requires exactly one matching usage event.",
    );
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("CREATE TABLE public.usage_events");
    expect(BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE).toContain("Usage events are append-only.");
  });

  it("fails closed when legacy binaries omit render usage lifecycle writes in v15", () => {
    expect(durableStorageMigrationChecksum(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE)).toBe(
      RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM,
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "CREATE CONSTRAINT TRIGGER render_sessions_require_usage_state_v15",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "AFTER INSERT OR UPDATE OF status ON public.render_sessions",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain("operation_kind = 'render'");
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "A new render session requires its render usage reservation.",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "current_status IN ('preparing', 'rendering') AND reservation_state <> 'reserved'",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "current_status IN ('ready', 'committed', 'undone') AND reservation_state <> 'committed'",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "current_status IN ('cancelled', 'failed') AND reservation_state <> 'released'",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain(
      "current_status = 'discarded' AND reservation_state NOT IN ('committed', 'released')",
    );
    expect(RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE).toContain("IF TG_OP = 'UPDATE' THEN");
  });

  it("pins tenant-bound Stripe correlation and atomic reconciliation storage in v16", () => {
    expect(durableStorageMigrationChecksum(STRIPE_BILLING_MIGRATION_V16_SOURCE)).toBe(
      STRIPE_BILLING_MIGRATION_V16_CHECKSUM,
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("ALTER TABLE public.billing_accounts");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("stripe_observation_generation bigint NOT NULL");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("stripe_reconcile_generation bigint NOT NULL");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("A Stripe customer binding is immutable.");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("A Stripe observation generation must advance exactly once.");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "CREATE UNIQUE INDEX billing_accounts_stripe_customer_unique_v16",
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("WHERE stripe_customer_id IS NOT NULL");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("CREATE TABLE public.billing_checkout_attempts");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("stripe_customer_id text CHECK");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("stripe_price_id text NOT NULL CHECK");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("UNIQUE (attempt_id)");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("UNIQUE (stripe_checkout_session_id)");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("expires_at <= created_at + interval '25 hours'");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "CREATE UNIQUE INDEX billing_checkout_attempts_active_tenant_v16",
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("WHERE state IN ('reserved', 'open')");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("CREATE TABLE public.stripe_event_inbox");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("PRIMARY KEY (stripe_livemode, stripe_event_id)");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "UNIQUE (tenant_id, stripe_customer_id, stripe_livemode, stripe_event_id)",
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("octet_length(payload_digest) = 32");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).not.toContain("payload_bytes bytea");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("checkout_attempt_id uuid");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("stripe_subscription_id text NOT NULL CHECK");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("A Stripe event inbox identity and payload are immutable.");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain("CREATE TABLE public.billing_subscriptions");
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "REFERENCES public.stripe_event_inbox (tenant_id, stripe_customer_id, stripe_livemode, stripe_event_id)",
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation)",
    );
    expect(STRIPE_BILLING_MIGRATION_V16_SOURCE).toContain(
      "A billing subscription reconciliation must advance monotonically.",
    );
  });

  it("requires all sixteen durable-storage prerequisites before applying editor documents v17", async () => {
    const db = database();
    await expect(applyEditorDocumentMigrationV17(db.pool, EDITOR_DOCUMENT_MIGRATION_V17_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v16/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("pins source-bound editor epochs to an immutable exact-revision event ledger in v17", () => {
    expect(durableStorageMigrationChecksum(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE)).toBe(
      EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM,
    );
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("CREATE TABLE public.editor_documents");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("octet_length(document_key) = 32");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("octet_length(source_hash) = 32");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("CREATE UNIQUE INDEX editor_documents_open_identity_v17");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("WHERE sealed_at IS NULL");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain(
      "A new editor document must start as an open revision-zero epoch.",
    );
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("CREATE TABLE public.editor_edit_events");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("jsonb_typeof(canonical_program) = 'object'");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("canonical_byte_size BETWEEN 2 AND 262144");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("revision = base_revision + 1");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain(
      "UNIQUE (tenant_id, project_id, subject_id, client_mutation_id)",
    );
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("Editor edit events are append-only.");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain(
      "An editor document revision requires its matching edit event.",
    );
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain(
      "CREATE CONSTRAINT TRIGGER editor_edit_events_require_document_revision_v17",
    );
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("document.revision >= NEW.revision");
  });

  it("requires all seventeen durable-storage prerequisites before applying editor mutation semantics v18", async () => {
    const db = database();
    await expect(applyEditorMutationMigrationV18(db.pool, EDITOR_MUTATION_MIGRATION_V18_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v17/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("cuts compatible v17 ledgers over to strict append, replace, and remove semantics", () => {
    expect(durableStorageMigrationChecksum(EDITOR_MUTATION_MIGRATION_V18_SOURCE)).toBe(
      EDITOR_MUTATION_MIGRATION_V18_CHECKSUM,
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("ADD COLUMN mutation_kind text NOT NULL DEFAULT 'append'");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("ADD COLUMN target_transaction_id text DEFAULT NULL");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("ALTER COLUMN canonical_program SET NOT NULL");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("mutation_kind IN ('append', 'replace', 'remove')");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain(
      "mutation_kind = 'append' AND target_transaction_id IS NULL",
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("mutation_kind IN ('replace', 'remove')");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("char_length(target_transaction_id) BETWEEN 1 AND 160");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain(
      "jsonb_typeof(event.canonical_program -> 'transactionId') IS DISTINCT FROM 'string'",
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain(
      "jsonb_typeof(event.canonical_program #> '{anchor,resolvedSeconds}') IS DISTINCT FROM 'number'",
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("HAVING count(*) > 32");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("event.canonical_program ->> 'transactionId'");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("ORDER BY event.revision");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("::double precision AS resolved_seconds");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain(
      "ordered.resolved_seconds < ordered.previous_resolved_seconds - 0.0005::double precision",
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("ALTER COLUMN mutation_kind DROP DEFAULT");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("CREATE TABLE public.editor_document_projections");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("PRIMARY KEY (tenant_id, project_id, document_key, epoch)");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain(
      "REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch)",
    );
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("jsonb_typeof(canonical_programs) = 'array'");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("jsonb_array_length(canonical_programs) <= 32");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).toContain("octet_length(canonical_programs::text) <= 9437184");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).not.toContain("INSERT INTO public.editor_document_projections");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).not.toContain("UPDATE public.editor_edit_events");
    expect(EDITOR_MUTATION_MIGRATION_V18_SOURCE).not.toContain("DROP TRIGGER");
    expect(EDITOR_DOCUMENT_MIGRATION_V17_SOURCE).toContain("Editor edit events are append-only.");
  });

  it("defines bounded identities, memberships, and a deferred last-owner invariant in v11", () => {
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("CREATE TABLE public.users");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("UNIQUE (oidc_issuer, oidc_subject)");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("A user OIDC identity is immutable.");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("CREATE TABLE public.organizations");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain(
      "REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT",
    );
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("CREATE TABLE public.organization_memberships");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("role IN ('owner', 'admin', 'member', 'billing')");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("status IN ('active', 'suspended')");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).not.toContain("organization_invitations");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain(
      "Organizations require an explicit tenant purge workflow.",
    );
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("FOR UPDATE");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("membership.role = 'owner'");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain("membership.status = 'active'");
    expect(ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE).toContain(
      "Organization creation must insert its first active owner in the same",
    );
  });

  it("invalidates legacy heads while retaining legacy artifacts for GC in migration v10", () => {
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("DELETE FROM public.workspace_project_references");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("DELETE FROM public.snapshot_scene_heads");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("DELETE FROM public.snapshot_publications");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).not.toContain("DELETE FROM public.snapshot_artifact_objects");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("SET runtime_digest = repeat('0', 64)");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("snapshot_artifact_objects_runtime_object_key");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("DROP CONSTRAINT snapshot_artifact_objects_pkey");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("(tenant_id, runtime_digest, result_digest)");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("snapshot_scene_heads_runtime_publication_fkey");
    expect(SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE).toContain("snapshot_publications_runtime_artifact_fkey");
  });

  it("backfills CPU failures and extends the closed catalog without a second normalization trigger in v9", () => {
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).toContain("SET failure_code = 'cpu-limit'");
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).toContain(
      "ADD CONSTRAINT render_sessions_failure_code_closed",
    );
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).not.toContain("CREATE FUNCTION");
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).not.toContain("CREATE TRIGGER");
  });

  it("adds a rolling-compatible closed render-session failure code in migration v8", () => {
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("ADD COLUMN failure_code text");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("failure_code IS NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).not.toContain("failure_code text NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status IN ('failed', 'discarded')");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status = 'discarded' AND error IS NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "CREATE FUNCTION public.normalize_render_session_failure_code_v8()",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "CREATE TRIGGER render_sessions_failure_code_normalization",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "BEFORE INSERT OR UPDATE OF status, error, failure_code",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "failure_code IS NULL AND status NOT IN ('cancelled', 'failed')",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status = 'failed' AND failure_code IS NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).not.toContain("'cleanup-failed'");
    for (const code of [
      "cancelled",
      "deadline-exceeded",
      "interrupted",
      "memory-limit",
      "pids-limit",
      "render-failed",
    ]) {
      expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(`'${code}'`);
    }
  });

  it("pins shard ownership and bounded durable cancellation state in migration v7", () => {
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_rendering_broker_shard");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_broker_shard_immutable");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_cancellation_authority");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_intents");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("expires_at = reject_until + interval '30 seconds'");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("ON DELETE CASCADE");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_delivery_queue");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_expiry_queue");
  });

  it("keeps reference release separate from terminal-session purge", () => {
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("ALTER COLUMN original_digest DROP NOT NULL");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("ALTER COLUMN patched_digest DROP NOT NULL");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("references_released_at timestamptz");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("source_blob_objects_orphan_queue");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("project_png_generations_orphan_queue");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain(
      "status IN ('cancelled', 'discarded', 'failed', 'ready', 'undone')",
    );
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).not.toContain("delete_after");
  });
});
