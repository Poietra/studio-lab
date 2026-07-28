import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { renderSessionTransitionSources } from "../../manim-render-session-policy";
import { PostgresRenderSessionRepositoryV1 } from "./postgres-render-session-repository";
import { WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1 } from "./postgres-workspace-source-repository";

describe("Postgres render-session transitions", () => {
  it("rejects a zero-row transition, rolls back, and keeps SQL statuses closed", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("SELECT project_id, render_request_id, status")) {
        return {
          rowCount: 1,
          rows: [{ project_id: "project-a", render_request_id: "request-a", status: "ready" }],
        };
      }
      if (text.includes("UPDATE public.render_sessions")) return { rowCount: 0, rows: [] };
      return { rowCount: null, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });
    const exposedSources = renderSessionTransitionSources("abandon") as unknown as string[];
    exposedSources.splice(0, exposedSources.length, "ready'); DROP TABLE render_sessions; --");

    const abandoned = repository.abandonSession("tenant-a", "00000000-0000-4000-8000-000000000001", "request-a");
    await expect(abandoned).rejects.toMatchObject({
      message: "The render session transition was rejected.",
      status: 409,
    });

    const update = statements.find((statement) => statement.includes("UPDATE public.render_sessions"));
    expect(update).toContain("status IN ('cancelled', 'failed', 'preparing', 'ready', 'rendering')");
    expect(update).not.toContain("DROP TABLE");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((statement) => statement.includes("DELETE FROM"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
