import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthorizedArtifactReaderV1 } from "./authorized-artifact-reader";
import {
  renderArtifactObjectKeyV1,
  type RenderArtifactReadClaimV1,
  type RenderArtifactRepositoryV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";

const TENANT = "tenant-a";
const BYTES = new Uint8Array([0, 1, 2, 3]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const SOURCE = "a".repeat(64);
const RUNTIME = "b".repeat(64);
const PROFILE = "c".repeat(64);
const REQUEST = "d".repeat(64);

function partial<T>(value: Partial<T>): T {
  return value as T;
}

function claim(): RenderArtifactReadClaimV1 {
  const identity = {
    artifactDigest: DIGEST,
    kind: "video" as const,
    profileDigest: PROFILE,
    requestDigest: REQUEST,
    runtimeDigest: RUNTIME,
    sourceDigest: SOURCE,
  };
  return {
    artifact: {
      artifactId: "00000000-0000-4000-8000-000000000001",
      expiresAt: new Date("2026-07-28T00:00:01.000Z"),
      receipt: {
        ...identity,
        byteSize: BYTES.byteLength,
        etag: '"etag-a"',
        mediaType: "video/mp4",
        objectKey: renderArtifactObjectKeyV1(TENANT, identity),
        versionId: "version-a",
      },
    },
    claimExpiresAt: new Date("2026-07-28T00:00:01.200Z"),
    claimId: "00000000-0000-4000-8000-000000000002",
  };
}

function fixture(
  open: RenderArtifactStoreV1["open"] = async () =>
    (async function* () {
      yield BYTES;
    })(),
) {
  const selected = claim();
  const releaseReadClaim = vi.fn(async () => undefined);
  const renewReadClaim = vi.fn(async () => new Date(Date.now() + 1_200));
  const repository = partial<RenderArtifactRepositoryV1>({
    acquireProjectThumbnail: vi.fn(async () => selected),
    acquireSessionVideo: vi.fn(async () => selected),
    ready: vi.fn(async () => true),
    releaseReadClaim,
    renewReadClaim,
  });
  const store = partial<RenderArtifactStoreV1>({
    head: vi.fn(async () => undefined),
    open: vi.fn(open),
    ready: vi.fn(async () => true),
  });
  return {
    reader: new AuthorizedArtifactReaderV1({ claimDurationMs: 1_200, repository, store, tenantId: TENANT }),
    releaseReadClaim,
    renewReadClaim,
    store,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthorizedArtifactReaderV1", () => {
  it("renews a claim while a slow stream remains open past artifact expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const { reader, releaseReadClaim, renewReadClaim } = fixture(async () =>
      (async function* () {
        yield BYTES.subarray(0, 2);
        await bodyGate;
        yield BYTES.subarray(2);
      })(),
    );

    const asset = await reader.sessionVideo("00000000-0000-4000-8000-000000000003");
    const iterator = (await asset.open(null))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: BYTES.subarray(0, 2) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewReadClaim).toHaveBeenCalledTimes(2);
    releaseBody();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: BYTES.subarray(2) });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await Promise.all([asset.close(), asset.close()]);
    expect(releaseReadClaim).toHaveBeenCalledOnce();
  });

  it("aborts and destroys an active body when claim renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const destroyed = vi.fn();
    const { reader, releaseReadClaim, renewReadClaim } = fixture(async (_tenant, _receipt, _range, signal) =>
      (async function* () {
        try {
          yield BYTES.subarray(0, 1);
          await new Promise<never>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        } finally {
          destroyed();
        }
      })(),
    );
    renewReadClaim.mockRejectedValueOnce(new Error("claim storage unavailable"));

    const asset = await reader.sessionVideo("00000000-0000-4000-8000-000000000003");
    const iterator = (await asset.open(null))[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toThrow("claim storage unavailable");
    await vi.advanceTimersByTimeAsync(400);
    await rejected;
    expect(destroyed).toHaveBeenCalledOnce();
    await asset.close();
    expect(releaseReadClaim).toHaveBeenCalledOnce();
  });

  it("releases the claim if pinned-version HEAD fails", async () => {
    const { reader, releaseReadClaim, store } = fixture();
    vi.mocked(store.head).mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(reader.sessionVideo("00000000-0000-4000-8000-000000000003")).rejects.toThrow("S3 unavailable");
    expect(releaseReadClaim).toHaveBeenCalledOnce();
  });
});
