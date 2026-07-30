import { describe, expect, it, vi } from "vitest";

import {
  createRunner,
  expectFailure,
  installFastManimSnapshotRunnerFixture,
  producerCommand,
  runRequest,
  supportsVerifiedRead,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot } = installFastManimSnapshotRunnerFixture();

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot runner PNG pinning", () => {
  it("returns a structured fallback before spawning when profile V4 has no valid PNG generation", async () => {
    const root = await projectRoot();
    const missing = createRunner(root, producerCommand(), { snapshotVersion: 4 });
    expectFailure(await missing.run(runRequest()), "asset-unavailable");
    await missing.close();

    const invalid = createRunner(root, producerCommand(), {
      pngProvider: { readVerified: async () => ({ bytes: Uint8Array.of(1, 2, 3), versionToken: "generation:1" }) },
      snapshotVersion: 4,
    });
    expectFailure(await invalid.run(runRequest({ requestId: "snapshot-request-invalid-png" })), "asset-unavailable");
    await invalid.close();
  });

  it("does not read a configured PNG provider for legacy snapshot profiles", async () => {
    const readVerified = vi.fn(async () => {
      throw new Error("Legacy snapshots must not read image.png.");
    });
    const runner = createRunner(await projectRoot(), producerCommand(), { pngProvider: { readVerified } });

    await expect(runner.run(runRequest())).resolves.toMatchObject({ status: "verified" });
    expect(readVerified).not.toHaveBeenCalled();
    await runner.close();
  });
});
