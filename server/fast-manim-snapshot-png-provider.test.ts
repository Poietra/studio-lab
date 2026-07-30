import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FileSystemFastManimSnapshotPngProviderV1,
  readFastManimSnapshotPngV1,
  sameFastManimSnapshotPngReadV1,
} from "./fast-manim-snapshot-png-provider";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("fast-manim snapshot PNG provider", () => {
  it("reads only the fixed regular image.png from a local project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-snapshot-png-provider-"));
    const outside = join(root, "outside.png");
    try {
      await writeFile(join(root, "image.png"), pngBytes);
      const provider = new FileSystemFastManimSnapshotPngProviderV1(root);
      const first = await readFastManimSnapshotPngV1(provider);
      const second = await readFastManimSnapshotPngV1(provider);
      expect(sameFastManimSnapshotPngReadV1(first, second)).toBe(true);

      await rm(join(root, "image.png"));
      await writeFile(outside, pngBytes);
      await symlink(outside, join(root, "image.png"));
      await expect(provider.readVerified()).rejects.toMatchObject({ status: 404 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("owns and validates the exact static PNG generation", async () => {
    const candidate = Uint8Array.from(pngBytes);
    const read = await readFastManimSnapshotPngV1({
      readVerified: async () => ({ bytes: candidate, versionToken: "generation:1" }),
    });
    candidate.fill(0);

    expect(read).toMatchObject({ byteSize: pngBytes.byteLength, height: 1, versionToken: "generation:1", width: 1 });
    expect(read.digest).toMatch(/^[0-9a-f]{64}$/);
    expect([...read.bytes]).toEqual([...pngBytes]);
  });

  it("rejects invalid bytes and unbounded generation tokens", async () => {
    await expect(
      readFastManimSnapshotPngV1({
        readVerified: async () => ({ bytes: Uint8Array.of(1, 2, 3), versionToken: "generation:1" }),
      }),
    ).rejects.toThrow(/PNG/i);
    await expect(
      readFastManimSnapshotPngV1({
        readVerified: async () => ({ bytes: pngBytes, versionToken: "x".repeat(2_049) }),
      }),
    ).rejects.toThrow(/version token/i);
  });

  it("does not call the provider after cancellation", async () => {
    const readVerified = vi.fn(async () => ({ bytes: pngBytes, versionToken: "generation:1" }));
    const controller = new AbortController();
    controller.abort();

    await expect(readFastManimSnapshotPngV1({ readVerified }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readVerified).not.toHaveBeenCalled();
  });

  it("compares both immutable content and generation identity", async () => {
    const first = await readFastManimSnapshotPngV1({
      readVerified: async () => ({ bytes: pngBytes, versionToken: "generation:1" }),
    });
    const same = await readFastManimSnapshotPngV1({
      readVerified: async () => ({ bytes: pngBytes, versionToken: "generation:1" }),
    });
    const later = { ...same, versionToken: "generation:2" };

    expect(sameFastManimSnapshotPngReadV1(first, same)).toBe(true);
    expect(sameFastManimSnapshotPngReadV1(first, later)).toBe(false);
  });
});
