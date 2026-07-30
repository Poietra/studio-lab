import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DurableFastManimSnapshotPngProviderV1 } from "./fast-manim-snapshot-durable-png-provider";
import { readFastManimSnapshotPngV1, sameFastManimSnapshotPngReadV1 } from "./fast-manim-snapshot-png-provider";
import {
  inspectProjectPngBytesV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngHeadV1,
  projectPngObjectKeyV1,
} from "./storage/project-png-storage";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const INSPECTED = inspectProjectPngBytesV1(PNG_BYTES);

function receipt(overrides: Partial<ProjectPngBlobReceiptV1> = {}): ProjectPngBlobReceiptV1 {
  const digest = overrides.digest ?? INSPECTED.digest;
  return {
    byteSize: overrides.byteSize ?? INSPECTED.byteSize,
    digest,
    etag: overrides.etag ?? '"png"',
    objectKey: overrides.objectKey ?? projectPngObjectKeyV1(TENANT, PROJECT, digest),
    versionId: overrides.versionId ?? "png-version",
  };
}

function head(generation = 4n, overrides: Partial<ProjectPngHeadV1> = {}): ProjectPngHeadV1 {
  return {
    generation,
    projectId: PROJECT,
    receipt: receipt(),
    tenantId: TENANT,
    ...overrides,
  };
}

function provider(
  readHead: (tenantId: string, projectId: string, signal?: AbortSignal) => Promise<ProjectPngHeadV1 | null>,
  read: (
    tenantId: string,
    projectId: string,
    value: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ) => Promise<Uint8Array> = async () => Uint8Array.from(PNG_BYTES),
) {
  return new DurableFastManimSnapshotPngProviderV1({
    blobs: { read },
    projectId: PROJECT,
    repository: { readHead },
    tenantId: TENANT,
  });
}

describe("durable fast-manim snapshot PNG provider", () => {
  it("reads the fixed tenant/project head and independently verifies its pinned bytes", async () => {
    const candidate = Uint8Array.from(PNG_BYTES);
    const readHead = vi.fn(async () => head());
    const read = vi.fn(async () => candidate);

    const result = await readFastManimSnapshotPngV1(provider(readHead, read));
    candidate.fill(0);

    expect(result.versionToken).toBe(`4:${INSPECTED.digest}`);
    expect(result).toMatchObject({ byteSize: PNG_BYTES.byteLength, height: 1, width: 1 });
    expect([...result.bytes]).toEqual([...PNG_BYTES]);
    expect(readHead).toHaveBeenCalledWith(TENANT, PROJECT, undefined);
    expect(read).toHaveBeenCalledWith(TENANT, PROJECT, receipt(), undefined);
  });

  it("reports a missing project image without consulting blob storage", async () => {
    const read = vi.fn(async () => Uint8Array.from(PNG_BYTES));
    await expect(provider(async () => null, read).readVerified()).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", head(4n, { tenantId: "tenant-b" })],
    ["project", head(4n, { projectId: "project-b" })],
    ["generation", head(0n)],
    ["receipt", head(4n, { receipt: receipt({ objectKey: "tenants/tenant-b/image.png" }) })],
  ])("rejects a cross-boundary or malformed %s head before reading bytes", async (_label, value) => {
    const read = vi.fn(async () => Uint8Array.from(PNG_BYTES));
    await expect(provider(async () => value, read).readVerified()).rejects.toThrow(/head|receipt/i);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not trust the blob store's PNG, size, or digest claims", async () => {
    const invalidBytes = Uint8Array.of(1, 2, 3);
    const invalidDigest = createHash("sha256").update(invalidBytes).digest("hex");
    const invalidReceipt = receipt({
      byteSize: invalidBytes.byteLength,
      digest: invalidDigest,
      objectKey: projectPngObjectKeyV1(TENANT, PROJECT, invalidDigest),
    });
    await expect(
      provider(
        async () => head(4n, { receipt: invalidReceipt }),
        async () => invalidBytes,
      ).readVerified(),
    ).rejects.toThrow(/PNG/i);

    await expect(
      provider(async () => head(4n, { receipt: receipt({ byteSize: INSPECTED.byteSize + 1 }) })).readVerified(),
    ).rejects.toThrow(/pinned receipt/i);
    const wrongDigest = "f".repeat(64);
    await expect(
      provider(async () =>
        head(4n, {
          receipt: receipt({
            digest: wrongDigest,
            objectKey: projectPngObjectKeyV1(TENANT, PROJECT, wrongDigest),
          }),
        }),
      ).readVerified(),
    ).rejects.toThrow(/pinned receipt/i);
  });

  it("changes the bounded token across an ABA generation even when bytes and digest are unchanged", async () => {
    let active = head(4n);
    const readHead = vi.fn(async () => active);
    const read = vi.fn(async () => {
      active = head(5n);
      return Uint8Array.from(PNG_BYTES);
    });
    const durable = provider(readHead, read);

    const before = await readFastManimSnapshotPngV1(durable);
    const after = await readFastManimSnapshotPngV1(durable);

    expect(before.versionToken).toBe(`4:${INSPECTED.digest}`);
    expect(after.versionToken).toBe(`5:${INSPECTED.digest}`);
    expect(Buffer.byteLength(after.versionToken, "utf8")).toBeLessThanOrEqual(128);
    expect(sameFastManimSnapshotPngReadV1(before, after)).toBe(false);
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation before head and blob reads", async () => {
    const readHead = vi.fn(async () => head());
    const read = vi.fn(async () => Uint8Array.from(PNG_BYTES));
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(provider(readHead, read).readVerified(cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(readHead).not.toHaveBeenCalled();

    const between = new AbortController();
    const abortingHead = vi.fn(async () => {
      between.abort();
      return head();
    });
    await expect(provider(abortingHead, read).readVerified(between.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects invalid durable identity at construction", () => {
    const readHead = vi.fn(async () => head());
    expect(
      () =>
        new DurableFastManimSnapshotPngProviderV1({
          blobs: { read: async () => Uint8Array.from(PNG_BYTES) },
          projectId: "../project",
          repository: { readHead },
          tenantId: TENANT,
        }),
    ).toThrow(/identity/i);
  });
});
