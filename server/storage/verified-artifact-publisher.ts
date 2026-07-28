import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  decodeManimRenderStagingLocatorV1,
  digestManimRenderStagingRootV1,
  manimRenderStagingIdV1,
  MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1,
} from "../manim-render-sandbox-contract";
import { manimTenantIdSchema } from "../manim-request-principal";
import {
  MAX_RENDER_THUMBNAIL_BYTES_V1,
  type RenderArtifactKindV1,
  type RenderArtifactRepositoryV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";
import type { DurableRenderSessionV1 } from "./render-session-repository";

const MAX_EXPIRATION_MS = 30 * 24 * 60 * 60_000;
const MAX_QUEUED_PUBLICATIONS = 64;
const SHA256 = /^[0-9a-f]{64}$/u;

type PublicationWaiter = {
  abort: () => void;
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
};

export type RenderStagingLocatorsV1 = Readonly<{
  thumbnail: string;
  video: string;
}>;

export type VerifiedArtifactPublisherOptionsV1 = Readonly<{
  artifactExpirationMs: number;
  artifacts: RenderArtifactStoreV1;
  brokerUserId: number;
  profileDigest: string;
  publications: RenderArtifactRepositoryV1;
  runtimeDigest: string;
  stagingGroupId: number;
  stagingRoot: string;
  tenantId: string;
}>;

function productionId(value: number, label: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffff_ffff) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function sha256(value: string, label: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function expiration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_EXPIRATION_MS) {
    throw new RangeError("Render artifact expiration must be between one second and 30 days.");
  }
  return value;
}

function stagingPath(root: string, stagingId: string, kind: RenderArtifactKindV1) {
  return join(root, `${stagingId}.${kind === "video" ? "mp4" : "png"}`);
}

/**
 * Trusted Studio-side bridge from broker-owned staging to immutable S3 plus a
 * fenced PostgreSQL publication. Staging bytes are never accepted on metadata
 * alone: the pinned root, stable file descriptor, size, signature and digest
 * are all revalidated immediately before upload.
 */
export class VerifiedArtifactPublisherV1 {
  readonly #artifactExpirationMs: number;
  readonly #artifacts: RenderArtifactStoreV1;
  readonly #brokerUserId: number;
  readonly #profileDigest: string;
  readonly #publications: RenderArtifactRepositoryV1;
  readonly #runtimeDigest: string;
  readonly #stagingGroupId: number;
  readonly #stagingRoot: string;
  readonly #tenantId: string;
  #publicationActive = false;
  readonly #publicationWaiters: PublicationWaiter[] = [];
  #stagingIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

  constructor(options: VerifiedArtifactPublisherOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("Render artifact publisher tenant ID is invalid.");
    const brokerUserId = productionId(options.brokerUserId, "Render broker user ID");
    const stagingGroupId = productionId(options.stagingGroupId, "Render staging group ID", true);
    const studioUserId = process.geteuid?.();
    const studioGroups = new Set([process.getegid?.(), ...(process.getgroups?.() ?? [])]);
    if (
      studioUserId === undefined ||
      studioUserId <= 0 ||
      studioUserId === brokerUserId ||
      !studioGroups.has(stagingGroupId)
    ) {
      throw new TypeError("Studio is not an authorized render staging reader.");
    }
    try {
      digestManimRenderStagingRootV1(options.stagingRoot);
    } catch {
      throw new TypeError("Render staging root must be a canonical absolute path.");
    }
    this.#artifactExpirationMs = expiration(options.artifactExpirationMs);
    this.#artifacts = options.artifacts;
    this.#brokerUserId = brokerUserId;
    this.#profileDigest = sha256(options.profileDigest, "Render profile digest");
    this.#publications = options.publications;
    this.#runtimeDigest = sha256(options.runtimeDigest, "Render runtime digest");
    this.#stagingGroupId = stagingGroupId;
    this.#stagingRoot = options.stagingRoot;
    this.#tenantId = tenant.data;
  }

  async #assertStagingRoot() {
    const [metadata, canonical] = await Promise.all([
      lstat(this.#stagingRoot, { bigint: true }),
      realpath(this.#stagingRoot),
    ]);
    if (
      canonical !== this.#stagingRoot ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== BigInt(this.#brokerUserId) ||
      metadata.gid !== BigInt(this.#stagingGroupId) ||
      (metadata.mode & 0o777n) !== 0o750n
    ) {
      throw new TypeError("The render staging root is not the broker:Studio-group capability directory.");
    }
    let ancestor = dirname(this.#stagingRoot);
    while (true) {
      const status = await lstat(ancestor, { bigint: true });
      const rootOwnedSticky = status.uid === 0n && (status.mode & 0o1000n) !== 0n;
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (status.uid !== 0n && status.uid !== BigInt(this.#brokerUserId)) ||
        ((status.mode & 0o022n) !== 0n && !rootOwnedSticky)
      ) {
        throw new TypeError("A render staging ancestor is mutable by an untrusted principal.");
      }
      if (ancestor === "/") break;
      ancestor = dirname(ancestor);
    }
    const identity = { dev: metadata.dev, ino: metadata.ino };
    if (
      this.#stagingIdentity &&
      (this.#stagingIdentity.dev !== identity.dev || this.#stagingIdentity.ino !== identity.ino)
    ) {
      throw new TypeError("The render staging root was replaced after publisher verification.");
    }
    this.#stagingIdentity ??= identity;
  }

  async #readStaged(locatorValue: string, kind: RenderArtifactKindV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const locator = decodeManimRenderStagingLocatorV1(locatorValue);
    if (
      locator.tenantId !== this.#tenantId ||
      locator.runtimeDigest !== this.#runtimeDigest ||
      locator.profileDigest !== this.#profileDigest ||
      locator.mediaType !== (kind === "video" ? "video/mp4" : "image/png") ||
      (kind === "thumbnail" && locator.artifactSize > MAX_RENDER_THUMBNAIL_BYTES_V1) ||
      locator.stagingId !== manimRenderStagingIdV1(locator.jobId, kind) ||
      locator.deadlineEpochMs <= Date.now()
    ) {
      throw new TypeError("The render staging locator does not match the trusted publication profile.");
    }
    await this.#assertStagingRoot();
    signal?.throwIfAborted();
    const path = stagingPath(this.#stagingRoot, locator.stagingId, kind);
    const pathMetadata = await lstat(path, { bigint: true });
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.nlink !== 1n ||
      pathMetadata.uid !== BigInt(this.#brokerUserId) ||
      pathMetadata.gid !== BigInt(this.#stagingGroupId) ||
      (pathMetadata.mode & 0o777n) !== 0o640n ||
      pathMetadata.size !== BigInt(locator.artifactSize)
    ) {
      throw new TypeError("The staged render artifact is not a stable broker-owned file.");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat({ bigint: true });
      if (
        !metadata.isFile() ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino ||
        metadata.size !== pathMetadata.size ||
        metadata.size <= 0n ||
        metadata.size > BigInt(MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1)
      ) {
        throw new TypeError("The staged render artifact changed before trusted publication.");
      }
      const bytes = Buffer.alloc(Number(metadata.size));
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < bytes.byteLength) {
        signal?.throwIfAborted();
        const result = await file.read(bytes, offset, Math.min(64 * 1024, bytes.byteLength - offset), offset);
        if (result.bytesRead <= 0) throw new TypeError("The staged render artifact was truncated during publication.");
        hash.update(bytes.subarray(offset, offset + result.bytesRead));
        offset += result.bytesRead;
      }
      const signatureValid =
        kind === "thumbnail"
          ? bytes.byteLength >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
            bytes.readUInt32BE(16) === 854 &&
            bytes.readUInt32BE(20) === 480
          : bytes.byteLength >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
      if (!signatureValid || hash.digest("hex") !== locator.artifactDigest) {
        throw new TypeError("The staged render artifact failed trusted media verification.");
      }
      signal?.throwIfAborted();
      await this.#assertStagingRoot();
      return { bytes, locator };
    } finally {
      await file.close();
    }
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.#assertStagingRoot();
    const [artifactsReady, publicationsReady] = await Promise.all([
      this.#artifacts.ready(signal),
      this.#publications.ready(signal),
    ]);
    signal?.throwIfAborted();
    return artifactsReady && publicationsReady;
  }

  #releasePublication() {
    while (this.#publicationWaiters.length > 0) {
      const waiter = this.#publicationWaiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) continue;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#releasePublication();
      });
      return;
    }
    this.#publicationActive = false;
  }

  async #acquirePublication(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#publicationActive) {
      this.#publicationActive = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.#releasePublication();
      };
    }
    if (this.#publicationWaiters.length >= MAX_QUEUED_PUBLICATIONS) {
      throw new Error("The bounded render artifact publication queue is full.");
    }
    return new Promise<() => void>((resolvePermit, reject) => {
      const waiter: PublicationWaiter = {
        abort: () => {
          const index = this.#publicationWaiters.indexOf(waiter);
          if (index >= 0) this.#publicationWaiters.splice(index, 1);
          reject(signal?.reason ?? new DOMException("The publication wait was aborted.", "AbortError"));
        },
        resolve: resolvePermit,
        ...(signal ? { signal } : {}),
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.#publicationWaiters.push(waiter);
    });
  }

  async publish(
    input: Readonly<{
      locators: RenderStagingLocatorsV1;
      logTail: string;
      ownerId: string;
      session: DurableRenderSessionV1;
    }>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const releasePublication = await this.#acquirePublication(signal);
    try {
      const { session } = input;
      if (
        session.tenantId !== this.#tenantId ||
        session.lease?.ownerId !== input.ownerId ||
        session.status !== "rendering"
      ) {
        throw new TypeError("The render artifact publication lease identity is invalid.");
      }
      const publishStaged = async (kind: RenderArtifactKindV1) => {
        const staged = await this.#readStaged(input.locators[kind], kind, signal);
        if (
          staged.locator.sessionId !== session.id ||
          staged.locator.jobId !== `${this.#tenantId}/${session.id}` ||
          staged.locator.fenceToken !== session.fenceToken.toString() ||
          staged.locator.sourceDigest !== session.patched.blob.digest
        ) {
          throw new TypeError("The staged media does not match the fenced render session.");
        }
        const { bytes, locator } = staged;
        return this.#artifacts.put(
          this.#tenantId,
          {
            artifactDigest: locator.artifactDigest,
            byteSize: locator.artifactSize,
            bytes,
            kind,
            mediaType: locator.mediaType,
            profileDigest: locator.profileDigest,
            requestDigest: locator.requestDigest,
            runtimeDigest: locator.runtimeDigest,
            sourceDigest: locator.sourceDigest,
          },
          signal,
        );
      };
      // One artifact may reach the 128 MiB #117 hard cap. Keep at most one
      // verified staging buffer alive per worker by uploading serially.
      const video = await publishStaged("video");
      const thumbnail = await publishStaged("thumbnail");
      if (video.kind !== "video" || thumbnail.kind !== "thumbnail") {
        throw new Error("The immutable artifact store returned media in an invalid order.");
      }
      await this.#publications.publishSessionArtifacts(
        {
          artifacts: {
            thumbnail: { artifactId: randomUUID(), receipt: thumbnail },
            video: { artifactId: randomUUID(), receipt: video },
          },
          expectedVersion: session.version,
          expirationMs: this.#artifactExpirationMs,
          fenceToken: session.fenceToken,
          logTail: input.logTail,
          ownerId: input.ownerId,
          sessionId: session.id,
          tenantId: this.#tenantId,
        },
        signal,
      );
    } finally {
      releasePublication();
    }
  }
}
