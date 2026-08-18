import { Pool, type PoolClient } from "pg";
import { describe, expect, it, type Mock, vi } from "vitest";

import type { ManimApi } from "../manim-api";
import { authenticateManimPrincipal } from "../manim-request-principal";
import {
  BoundedProductionManimRuntimeCellResolverV1,
  type ProductionManimRuntimeAdapterV1,
  type ProductionManimRuntimeCellLeaseV1,
  type ProductionManimRuntimeCellResolverV1,
  type ProductionRuntimeCellAssignmentV1,
} from "../production-runtime-cell";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresRuntimeCellAssignmentRepositoryV1 } from "./postgres/postgres-runtime-cell-assignment-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;

function runtime(assignment: ProductionRuntimeCellAssignmentV1, close: () => Promise<void>) {
  return {
    api: {
      storageBoundary: { kind: "shared-durable", namespace: "runtime-cell-real-test" },
      tenantId: assignment.tenantId,
    } as ManimApi,
    close,
    ready: async () => ({
      executionBoundary: "adapter-attests-external-sandbox",
      ready: true,
      storageBoundary: "shared-durable",
      tenantBoundary: "server-owned-tenant-key",
    }),
    renderReady: async () => true,
    workspaceReady: async () => true,
  } satisfies ProductionManimRuntimeAdapterV1;
}

async function principal(tenantId: string) {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId: `user-${tenantId}`, tenantId }) },
    null,
    new AbortController().signal,
  );
}

async function waitForPostgresLockWaiter(pool: Pool, applicationName: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'`,
      [applicationName],
    );
    if (Number(result.rows[0]?.waiting) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a runtime-cell assignment lock waiter.");
}

async function waitForConnectionsToClose(pool: Pool, applicationNames: readonly string[]) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ connections: string }>(
      `SELECT count(*)::text AS connections
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = ANY($1::text[])`,
      [applicationNames],
    );
    if (Number(result.rows[0]?.connections) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Runtime-cell assignment repositories did not release their PostgreSQL connections.");
}

describe.skipIf(!DATABASE_URL)("PostgreSQL production runtime-cell composition", () => {
  it("routes two Organizations through replay-safe durable assignments and drains rotated cells", {
    timeout: 30_000,
  }, async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const suffix = String(process.pid);
    const ownerUserId = `00000000-0000-4000-8000-${process.pid.toString(16).padStart(12, "0")}`;
    const tenantA = `runtime-organization-a-${suffix}`;
    const tenantB = `runtime-organization-b-${suffix}`;
    const missingTenant = `runtime-organization-missing-${suffix}`;
    const cellA1 = `cell-a-${suffix}-v1`;
    const cellA2 = `cell-a-${suffix}-v2`;
    const cellA3 = `cell-a-${suffix}-v3`;
    const cellB1 = `cell-b-${suffix}-v1`;
    const cellB2 = `cell-b-${suffix}-v2`;
    const controlApplication = `poietra-runtime-cell-control-${suffix}`;
    const resolverApplication = `poietra-runtime-cell-resolver-${suffix}`;
    const restartedApplication = `poietra-runtime-cell-restarted-${suffix}`;
    const repositoryOptions = (applicationName: string) => ({
      poolConfig: { application_name: applicationName, connectionString: DATABASE_URL, max: 2 },
      statementTimeoutMs: 5_000,
    });
    let control: PostgresRuntimeCellAssignmentRepositoryV1 | null = null;
    let resolver: ProductionManimRuntimeCellResolverV1 | null = null;
    let restartedResolver: ProductionManimRuntimeCellResolverV1 | null = null;
    let blocker: PoolClient | null = null;
    let blockerTransactionOpen = false;
    const openLeases = new Set<ProductionManimRuntimeCellLeaseV1>();
    const runtimeCloses: Array<{
      assignment: ProductionRuntimeCellAssignmentV1;
      close: Mock<() => Promise<void>>;
      run: number;
    }> = [];
    const provisionerCloses: Array<Mock<() => Promise<void>>> = [];
    const makeResolver = (applicationName: string, run: number) => {
      const assignments = new PostgresRuntimeCellAssignmentRepositoryV1(repositoryOptions(applicationName));
      const provisionerClose = vi.fn(async () => undefined);
      provisionerCloses.push(provisionerClose);
      return new BoundedProductionManimRuntimeCellResolverV1({
        assignments,
        maxCells: 3,
        provisioner: {
          close: provisionerClose,
          provision: async (assignment, signal) => {
            signal.throwIfAborted();
            const close = vi.fn(async () => undefined);
            runtimeCloses.push({ assignment, close, run });
            return runtime(assignment, close);
          },
        },
      });
    };
    const acquire = async (target: ProductionManimRuntimeCellResolverV1, tenantId: string) => {
      const lease = await target.acquire(await principal(tenantId), new AbortController().signal);
      openLeases.add(lease);
      return lease;
    };
    const release = (lease: ProductionManimRuntimeCellLeaseV1) => {
      lease.release();
      openLeases.delete(lease);
    };
    const closeFor = (run: number, tenantId: string, generation: number) => {
      const record = runtimeCloses.find(
        (candidate) =>
          candidate.run === run &&
          candidate.assignment.tenantId === tenantId &&
          candidate.assignment.generation === generation,
      );
      if (!record) throw new Error(`Missing runtime ${run}:${tenantId}:${generation}.`);
      return record.close;
    };

    try {
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toMatchObject({
        applied: true,
        version: 34,
      });
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          `INSERT INTO public.workspace_tenants (tenant_id)
             VALUES ($1), ($2)`,
          [tenantA, tenantB],
        );
        await setup.query(
          `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name, status)
             VALUES ($1::uuid, 'https://runtime-cell.test/', $2, 'Runtime owner', 'active')`,
          [ownerUserId, `runtime-owner-${suffix}`],
        );
        await setup.query(
          `INSERT INTO public.organizations (tenant_id, display_name, status)
             VALUES ($1, 'Runtime Organization A', 'active'),
                    ($2, 'Runtime Organization B', 'active')`,
          [tenantA, tenantB],
        );
        await setup.query(
          `INSERT INTO public.organization_memberships (tenant_id, user_id, role, status)
             VALUES ($1, $3::uuid, 'owner', 'active'),
                    ($2, $3::uuid, 'owner', 'active')`,
          [tenantA, tenantB, ownerUserId],
        );
        await setup.query("COMMIT");
      } catch (error) {
        await setup.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        setup.release();
      }

      control = new PostgresRuntimeCellAssignmentRepositoryV1(repositoryOptions(controlApplication));
      await expect(control.ready()).resolves.toBe(true);
      const createA = {
        cellId: cellA1,
        expectedGeneration: 0 as const,
        mutationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        tenantId: tenantA,
      };
      await expect(control.createAssignment(createA)).resolves.toEqual({
        assignment: { cellId: cellA1, generation: 1, state: "active", tenantId: tenantA },
        kind: "applied",
        replayed: false,
      });
      await expect(control.createAssignment(createA)).resolves.toMatchObject({ kind: "applied", replayed: true });
      await expect(
        control.createAssignment({
          ...createA,
          cellId: cellA2,
        }),
      ).resolves.toEqual({ kind: "conflict" });
      await expect(
        control.createAssignment({
          cellId: cellB1,
          expectedGeneration: 0,
          mutationId: "00000000-0000-4000-8000-000000000542",
          tenantId: missingTenant,
        }),
      ).resolves.toEqual({ kind: "organization-unavailable" });
      await expect(
        control.createAssignment({
          cellId: cellA1,
          expectedGeneration: 0,
          mutationId: "00000000-0000-4000-8000-000000000543",
          tenantId: tenantB,
        }),
      ).resolves.toEqual({ kind: "conflict" });
      await expect(
        control.createAssignment({
          cellId: cellB1,
          expectedGeneration: 0,
          mutationId: "00000000-0000-4000-8000-000000000544",
          tenantId: tenantB,
        }),
      ).resolves.toMatchObject({ kind: "applied", replayed: false });
      await expect(
        control.createAssignment({
          cellId: cellB2,
          expectedGeneration: 0,
          mutationId: "00000000-0000-4000-8000-000000000545",
          tenantId: tenantB,
        }),
      ).resolves.toEqual({ kind: "conflict" });

      await control.close();
      control = new PostgresRuntimeCellAssignmentRepositoryV1(repositoryOptions(controlApplication));
      await expect(control.createAssignment(createA)).resolves.toMatchObject({ kind: "applied", replayed: true });

      resolver = makeResolver(resolverApplication, 1);
      await expect(resolver.ready(new AbortController().signal)).resolves.toBe(true);
      const [leaseA1, leaseB1] = await Promise.all([acquire(resolver, tenantA), acquire(resolver, tenantB)]);
      const cachedA1 = await acquire(resolver, tenantA);
      expect(leaseA1.runtime.api.tenantId).toBe(tenantA);
      expect(leaseB1.runtime.api.tenantId).toBe(tenantB);
      expect(cachedA1.runtime).toBe(leaseA1.runtime);
      expect(leaseA1.runtime).not.toBe(leaseB1.runtime);
      release(cachedA1);
      await expect(acquire(resolver, missingTenant)).rejects.toMatchObject({ status: 503 });

      await expect(
        control.rotateAssignment({
          cellId: cellA2,
          expectedGeneration: 1,
          mutationId: "00000000-0000-4000-8000-000000000546",
          tenantId: tenantA,
        }),
      ).resolves.toEqual({
        assignment: { cellId: cellA2, generation: 2, state: "active", tenantId: tenantA },
        kind: "applied",
        replayed: false,
      });
      const leaseA2 = await acquire(resolver, tenantA);
      expect(leaseA2.runtime).not.toBe(leaseA1.runtime);
      expect(closeFor(1, tenantA, 1)).not.toHaveBeenCalled();
      release(leaseA1);
      await vi.waitFor(() => expect(closeFor(1, tenantA, 1)).toHaveBeenCalledOnce());

      await expect(
        control.disableAssignment({
          expectedGeneration: 1,
          mutationId: "00000000-0000-4000-8000-000000000547",
          tenantId: tenantB,
        }),
      ).resolves.toEqual({
        assignment: { cellId: cellB1, generation: 2, state: "disabled", tenantId: tenantB },
        kind: "applied",
        replayed: false,
      });
      await expect(acquire(resolver, tenantB)).rejects.toMatchObject({ status: 503 });
      expect(closeFor(1, tenantB, 1)).not.toHaveBeenCalled();
      release(leaseB1);
      await vi.waitFor(() => expect(closeFor(1, tenantB, 1)).toHaveBeenCalledOnce());

      const integrity = await pool.connect();
      try {
        await integrity.query("BEGIN");
        await integrity.query(
          `INSERT INTO public.runtime_cell_assignment_mutations
               (tenant_id, mutation_id, kind, request_cell_id, expected_generation,
                result_cell_id, result_generation, result_state)
             VALUES ($1, '00000000-0000-4000-8000-000000000549'::uuid,
                     'rotate', $2, 2, $2, 3, 'active')`,
          [tenantA, cellA3],
        );
        const unappliedMutationFailure = await integrity.query("COMMIT").catch((error: unknown) => error);
        expect(unappliedMutationFailure).toMatchObject({ code: "23514" });
        await integrity.query("ROLLBACK").catch(() => undefined);

        await integrity.query("BEGIN");
        const disabledReactivationFailure = await integrity
          .query(
            `UPDATE public.runtime_cell_assignments
                  SET cell_id = $2, generation = 3, state = 'active'
                WHERE tenant_id = $1`,
            [tenantB, cellB2],
          )
          .catch((error: unknown) => error);
        expect(disabledReactivationFailure).toMatchObject({ code: "23514" });
        await integrity.query("ROLLBACK");
      } finally {
        await integrity.query("ROLLBACK").catch(() => undefined);
        integrity.release();
      }
      release(leaseA2);

      await resolver.close();
      resolver = null;
      expect(provisionerCloses[0]).toHaveBeenCalledOnce();

      restartedResolver = makeResolver(restartedApplication, 2);
      const restartedA = await acquire(restartedResolver, tenantA);
      expect(restartedA.runtime.api.tenantId).toBe(tenantA);
      expect(runtimeCloses.at(-1)?.assignment).toEqual({
        cellId: cellA2,
        generation: 2,
        state: "active",
        tenantId: tenantA,
      });
      await expect(acquire(restartedResolver, tenantB)).rejects.toMatchObject({ status: 503 });

      blocker = await pool.connect();
      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query("SELECT 1 FROM public.runtime_cell_assignments WHERE tenant_id = $1 FOR UPDATE", [tenantA]);
      const abort = new AbortController();
      const abortReason = new Error("runtime-cell mutation cancelled");
      const interruptedRotation = control.rotateAssignment(
        {
          cellId: cellA3,
          expectedGeneration: 2,
          mutationId: "00000000-0000-4000-8000-000000000548",
          tenantId: tenantA,
        },
        abort.signal,
      );
      void interruptedRotation.catch(() => undefined);
      await waitForPostgresLockWaiter(pool, controlApplication);
      abort.abort(abortReason);
      await blocker.query("ROLLBACK");
      blockerTransactionOpen = false;
      await expect(interruptedRotation).rejects.toBe(abortReason);
      await expect(control.resolve(tenantA)).resolves.toEqual({
        cellId: cellA2,
        generation: 2,
        state: "active",
        tenantId: tenantA,
      });

      const persisted = await pool.query<{ mutation_count: string }>(
        `SELECT count(*)::text AS mutation_count
             FROM public.runtime_cell_assignment_mutations
            WHERE tenant_id = ANY($1::text[])`,
        [[tenantA, tenantB]],
      );
      expect(persisted.rows).toEqual([{ mutation_count: "4" }]);

      release(restartedA);
      await restartedResolver.close();
      restartedResolver = null;
      await control.close();
      control = null;
      expect(provisionerCloses[1]).toHaveBeenCalledOnce();
      await waitForConnectionsToClose(pool, [controlApplication, resolverApplication, restartedApplication]);
    } finally {
      for (const lease of openLeases) lease.release();
      if (blockerTransactionOpen) await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await Promise.allSettled([resolver?.close(), restartedResolver?.close(), control?.close()]);
      await pool.end();
    }
  });
});
