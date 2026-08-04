import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { ManimRenderManager } from "./manim-render-manager";
import {
  CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
  CANDIDATE_PREFLIGHT_PROFILES_V1,
  CANDIDATE_PREFLIGHT_REJECTION_CASES_V1,
  CANDIDATE_PREFLIGHT_SOURCE_PATH_V1,
  type CandidatePreflightProfileFixtureV1,
} from "./test-fixtures/manim-render-candidate-preflight-fixture";

const managers: ManimRenderManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function managerFixture(profile: CandidatePreflightProfileFixtureV1) {
  const projectRoot = await mkdtemp(join(tmpdir(), `poietra-candidate-v${profile.snapshotVersion}-manager-`));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, "example_scenes"), { recursive: true });
  await writeFile(
    join(projectRoot, CANDIDATE_PREFLIGHT_SOURCE_PATH_V1),
    CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
    "utf8",
  );
  const manager = new ManimRenderManager({
    command: [process.execPath],
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    projectRoot,
    snapshotVersion: profile.snapshotVersion,
    tenantId: "test-tenant",
  });
  managers.push(manager);
  const runner = (manager as unknown as { snapshotRunner: FastManimSnapshotRunner }).snapshotRunner;
  return { manager, projectRoot, runner };
}

describe.each(CANDIDATE_PREFLIGHT_PROFILES_V1)("ManimRenderManager $label Apply preflight", (profile) => {
  it("verifies candidate bytes before creating a render session without writing project source", async () => {
    const { manager, projectRoot, runner } = await managerFixture(profile);
    const preflight = vi
      .spyOn(runner, "runCandidateUnpublished")
      .mockImplementation(async (candidateSource, runRequest) =>
        profile.verifiedCandidate(candidateSource, runRequest),
      );

    const started = await manager.start(profile.request());

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight.mock.calls[0]?.[0]).toContain(profile.candidateSnippet);
    expect(await readFile(join(projectRoot, CANDIDATE_PREFLIGHT_SOURCE_PATH_V1), "utf8")).toBe(
      CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
    );
    await manager.abandonStart(started.id);
  });

  it.each(CANDIDATE_PREFLIGHT_REJECTION_CASES_V1)(
    "fails closed before session creation for $label",
    async ({ mutate }) => {
      const { manager, projectRoot, runner } = await managerFixture(profile);
      vi.spyOn(runner, "runCandidateUnpublished").mockImplementation(async (candidateSource, runRequest) =>
        mutate(profile.verifiedCandidate(candidateSource, runRequest)),
      );

      await expect(manager.start(profile.request())).rejects.toMatchObject({ status: 409 });

      expect(manager.canUnregister()).toBe(true);
      expect(await readFile(join(projectRoot, CANDIDATE_PREFLIGHT_SOURCE_PATH_V1), "utf8")).toBe(
        CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1,
      );
    },
  );
});
