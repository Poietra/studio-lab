import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { digestAssetManifestV1, sceneIrBundleV1Schema } from "../../src/engine/contracts";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "../fast-manim-snapshot-contract";
import { SnapshotArtifactPublisherV1 } from "./snapshot-artifact-publisher";
import type {
  SnapshotArtifactReceiptV1,
  SnapshotArtifactStoreV1,
  SnapshotPublicationIdentityV1,
  SnapshotPublicationReadV1,
  SnapshotPublicationRepositoryV1,
  SnapshotPublicationV1,
} from "./snapshot-publication-repository";
import { SnapshotArtifactReadErrorV1 } from "./snapshot-publication-repository";

const PROFILE = "c".repeat(64);
const TENANT = "tenant-a";
const PUBLICATION_ID = "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a1";
const identity = {
  projectId: "workspace-a",
  sceneName: "ExampleScene",
  sourcePath: "examples/scene.py",
  tenantId: TENANT,
} satisfies SnapshotPublicationIdentityV1;
const expected = {
  frame: { height: 8, width: 14.222222222222221 },
  projectId: identity.projectId,
  requestId: "snapshot-request-a",
  runtimeConfigHash: "b".repeat(64),
  snapshotVersion: 1,
  sceneId: fastManimSnapshotSceneIdV1(identity.sourcePath, identity.sceneName),
  sceneName: identity.sceneName,
  sourceHash: "a".repeat(64),
  sourcePath: identity.sourcePath,
} satisfies ExpectedFastManimSnapshotCorrelationV1;

type FixtureEntity = Record<string, unknown> & { id: string };

async function sealedSnapshot(expectedValue = expected) {
  const fixtureUrl = new URL("../test-fixtures/fast-manim-static-bundle.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    scene: Record<string, unknown> & { entities: FixtureEntity[] };
  };
  const namespace = (suffix: string) => `${expectedValue.sceneId}/${suffix}`;
  const manifestId = namespace("manifest");
  const manifestDigest = await digestAssetManifestV1({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  const bundle = sceneIrBundleV1Schema.parse({
    assets: { assets: [], manifestDigest, manifestId, schema: "poietra.asset-manifest", version: 1 },
    scene: {
      ...fixture.scene,
      animationChannels: [],
      assetManifest: { manifestDigest, manifestId },
      entities: fixture.scene.entities.map((entity, index) => ({
        ...entity,
        id: namespace(`entity:${index}`),
        parentId: null,
        provenanceId: namespace(`provenance:entity:${index}`),
      })),
      provenance: [
        {
          evidence: ["fast-manim static snapshot"],
          id: namespace("provenance:scene"),
          origin: "fast-manim-server-snapshot",
        },
        ...fixture.scene.entities.map((_, index) => ({
          evidence: ["fast-manim static snapshot"],
          id: namespace(`provenance:entity:${index}`),
          origin: "fast-manim-server-snapshot",
        })),
      ],
      sceneId: expectedValue.sceneId,
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: expectedValue.runtimeConfigHash,
        snapshotHash: ZERO_SHA256,
        snapshotVersion: 1,
        sourceHash: expectedValue.sourceHash,
      },
    },
  });
  const { frame: _frame, snapshotVersion: _snapshotVersion, ...wire } = expectedValue;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(
    JSON.stringify({
      ...wire,
      bundle,
      kind: "compiled",
      schema: "poietra.fast-manim-snapshot-result",
      snapshotHash: ZERO_SHA256,
      version: 1,
    }),
    expectedValue,
  );
  if (sealed.kind !== "compiled") throw new Error("Expected a compiled test snapshot.");
  return sealed;
}

class MemoryArtifactStore implements SnapshotArtifactStoreV1 {
  readonly bytes = new Map<string, Uint8Array>();
  readonly events: string[];
  readFailure: unknown = null;
  #version = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  async put(
    tenantId: string,
    input: Readonly<{ bytes: Uint8Array; profileDigest: string; runtimeConfigHash: string; sourceDigest: string }>,
  ) {
    this.events.push("put");
    const resultDigest = createHash("sha256").update(input.bytes).digest("hex");
    const versionId = `version-${++this.#version}`;
    const receipt = {
      byteSize: input.bytes.byteLength,
      etag: `etag-${this.#version}`,
      objectKey: `tenants/${tenantId}/snapshots/${input.sourceDigest}/${input.runtimeConfigHash}/${input.profileDigest}/${resultDigest}`,
      profileDigest: input.profileDigest,
      resultDigest,
      runtimeConfigHash: input.runtimeConfigHash,
      sourceDigest: input.sourceDigest,
      versionId,
    } satisfies SnapshotArtifactReceiptV1;
    this.bytes.set(versionId, Uint8Array.from(input.bytes));
    return receipt;
  }

  async read(_tenantId: string, artifact: SnapshotArtifactReceiptV1) {
    if (this.readFailure) throw this.readFailure;
    const bytes = this.bytes.get(artifact.versionId);
    if (!bytes) throw new SnapshotArtifactReadErrorV1("missing");
    return Uint8Array.from(bytes);
  }

  async close() {}
  async deleteVersion() {}
  async listVersions() {
    return { nextCursor: null, versions: [] };
  }
  async ready() {
    return true;
  }
}

class MemoryPublicationRepository implements SnapshotPublicationRepositoryV1 {
  readonly clearHeadIfGeneration = vi.fn(async (value: SnapshotPublicationIdentityV1, generation: bigint) => {
    if (
      this.head.kind !== "published" ||
      this.head.publication.generation !== generation ||
      this.head.publication.tenantId !== value.tenantId
    ) {
      return false;
    }
    this.head = { generation, kind: "stale" };
    return true;
  });
  readonly confirmCurrent = vi.fn(async (publication: SnapshotPublicationV1) => {
    return this.head.kind === "published" && this.head.publication.publicationId === publication.publicationId;
  });
  readonly events: string[];
  head: SnapshotPublicationReadV1 = { kind: "missing" };
  readQueue: SnapshotPublicationReadV1[] = [];
  sourceStale = false;
  #generation = 0n;

  constructor(events: string[]) {
    this.events = events;
  }

  async publish(input: Parameters<SnapshotPublicationRepositoryV1["publish"]>[0]) {
    this.events.push("publish");
    if (this.sourceStale) return { kind: "source-stale" as const };
    const publication: SnapshotPublicationV1 = {
      artifact: input.artifact,
      generation: ++this.#generation,
      projectId: input.projectId,
      publicationId: input.publicationId,
      publishedAt: new Date("2026-07-28T00:00:00.000Z"),
      requestId: input.requestId,
      sceneName: input.sceneName,
      snapshotHash: input.snapshotHash,
      sourceGeneration: input.expectedSourceGeneration,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
    };
    this.head = { kind: "published", publication };
    return this.head;
  }

  async readCurrent() {
    return this.readQueue.shift() ?? this.head;
  }

  async acknowledgeArtifactDeletion() {}
  async close() {}
  async isArtifactPublished() {
    return false;
  }
  async pendingArtifactDeletions() {
    return [];
  }
  async queueArtifactDeletion() {
    return null;
  }
  async ready() {
    return true;
  }
  async softDeleteProject() {}
}

describe("SnapshotArtifactPublisherV1", () => {
  let snapshot: VerifiedCompiledFastManimSnapshotResultV1;
  let events: string[];
  let artifacts: MemoryArtifactStore;
  let publications: MemoryPublicationRepository;
  let publisher: SnapshotArtifactPublisherV1;

  beforeAll(async () => {
    snapshot = await sealedSnapshot();
  });

  beforeEach(() => {
    events = [];
    artifacts = new MemoryArtifactStore(events);
    publications = new MemoryPublicationRepository(events);
    publisher = new SnapshotArtifactPublisherV1({ artifacts, publications });
  });

  async function publish(overrides: Partial<Parameters<SnapshotArtifactPublisherV1["publish"]>[0]> = {}) {
    return publisher.publish({
      ...identity,
      expected,
      expectedSourceGeneration: 4n,
      profileDigest: PROFILE,
      publicationId: PUBLICATION_ID,
      snapshot,
      ...overrides,
    });
  }

  it("probes and closes both durable stores exactly once", async () => {
    const artifactReady = vi.spyOn(artifacts, "ready");
    const publicationReady = vi.spyOn(publications, "ready");
    const artifactClose = vi.spyOn(artifacts, "close");
    const publicationClose = vi.spyOn(publications, "close");

    await expect(publisher.ready()).resolves.toBe(true);
    await Promise.all([publisher.close(), publisher.close()]);

    expect(artifactReady).toHaveBeenCalledOnce();
    expect(publicationReady).toHaveBeenCalledOnce();
    expect(artifactClose).toHaveBeenCalledOnce();
    expect(publicationClose).toHaveBeenCalledOnce();
  });

  it("delegates atomic project deletion without touching the artifact store", async () => {
    const deletion = vi.spyOn(publications, "softDeleteProject");
    const artifactDelete = vi.spyOn(artifacts, "deleteVersion");

    await expect(publisher.softDeleteProject(TENANT, identity.projectId)).resolves.toBeUndefined();

    expect(deletion).toHaveBeenCalledWith(TENANT, identity.projectId, undefined);
    expect(artifactDelete).not.toHaveBeenCalled();
  });

  it("uploads canonical bytes before publishing metadata", async () => {
    const result = await publish();

    expect(result.kind).toBe("published");
    expect(events).toEqual(["put", "publish"]);
    if (result.kind === "published") {
      const bytes = artifacts.bytes.get(result.publication.artifact.versionId)!;
      expect(Buffer.from(bytes).toString("utf8")).toContain('"schema":"poietra.studio-snapshot-artifact"');
    }
  });

  it("keeps a stale-source upload orphan invisible to the caller", async () => {
    publications.sourceStale = true;

    const result = await publish();

    expect(result).toEqual({ kind: "source-stale" });
    expect(Object.keys(result)).toEqual(["kind"]);
    expect(events).toEqual(["put", "publish"]);
    expect(artifacts.bytes.size).toBe(1);
    expect(publications.head).toEqual({ kind: "missing" });
  });

  it("conditionally unpublishes bytes tampered after publication", async () => {
    const result = await publish();
    if (result.kind !== "published") throw new Error("Expected publication.");
    const stored = artifacts.bytes.get(result.publication.artifact.versionId)!;
    stored[stored.byteLength - 1] ^= 1;

    await expect(publisher.readCurrent(identity)).resolves.toEqual({
      generation: result.publication.generation,
      kind: "stale",
      reason: "artifact-corrupt",
    });
    expect(publications.clearHeadIfGeneration).toHaveBeenCalledWith(identity, result.publication.generation, undefined);
  });

  it("marks an expired exact version stale", async () => {
    const result = await publish();
    if (result.kind !== "published") throw new Error("Expected publication.");
    artifacts.bytes.delete(result.publication.artifact.versionId);

    await expect(publisher.readCurrent(identity)).resolves.toEqual({
      generation: result.publication.generation,
      kind: "stale",
      reason: "artifact-missing",
    });
  });

  it("conditionally unpublishes an integrity failure reported by the store", async () => {
    const result = await publish();
    if (result.kind !== "published") throw new Error("Expected publication.");
    artifacts.readFailure = new SnapshotArtifactReadErrorV1("corrupt");

    await expect(publisher.readCurrent(identity)).resolves.toEqual({
      generation: result.publication.generation,
      kind: "stale",
      reason: "artifact-corrupt",
    });
  });

  it("preserves the current head when artifact storage has a transient failure", async () => {
    const result = await publish();
    if (result.kind !== "published") throw new Error("Expected publication.");
    const failure = new Error("temporary network failure");
    artifacts.readFailure = failure;

    await expect(publisher.readCurrent(identity)).rejects.toBe(failure);
    expect(publications.clearHeadIfGeneration).not.toHaveBeenCalled();
    expect(publications.head).toEqual(result);
  });

  it("retries a version-pinned read when a concurrent publication supersedes it", async () => {
    const first = await publish();
    if (first.kind !== "published") throw new Error("Expected publication.");
    const secondExpected = { ...expected, requestId: "snapshot-request-b" };
    const secondSnapshot = await sealedSnapshot(secondExpected);
    const second = await publish({
      expected: secondExpected,
      publicationId: "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a2",
      snapshot: secondSnapshot,
    });
    if (second.kind !== "published") throw new Error("Expected publication.");
    publications.readQueue = [first, second];
    publications.confirmCurrent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const read = await publisher.readCurrent(identity);

    expect(read.kind).toBe("published");
    if (read.kind === "published") expect(read.publication.publicationId).toBe(second.publication.publicationId);
    expect(publications.confirmCurrent).toHaveBeenCalledTimes(2);
  });

  it("cannot clear a newer generation after finding an older artifact corrupt", async () => {
    const first = await publish();
    if (first.kind !== "published") throw new Error("Expected publication.");
    const firstBytes = artifacts.bytes.get(first.publication.artifact.versionId)!;
    firstBytes[firstBytes.byteLength - 1] ^= 1;
    const secondExpected = { ...expected, requestId: "snapshot-request-newer" };
    const second = await publish({
      expected: secondExpected,
      publicationId: "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a4",
      snapshot: await sealedSnapshot(secondExpected),
    });
    if (second.kind !== "published") throw new Error("Expected publication.");
    publications.readQueue = [first];

    const read = await publisher.readCurrent(identity);

    expect(read.kind).toBe("published");
    if (read.kind === "published") expect(read.publication.generation).toBe(second.publication.generation);
    expect(publications.clearHeadIfGeneration).toHaveBeenCalledWith(identity, first.publication.generation, undefined);
    expect(publications.head).toEqual(second);
  });

  it("rejects an exact artifact version cross-correlated to another publication", async () => {
    const first = await publish();
    if (first.kind !== "published") throw new Error("Expected publication.");
    const foreignIdentity = { ...identity, projectId: "workspace-b" };
    const foreignExpected = {
      ...expected,
      projectId: foreignIdentity.projectId,
      requestId: "snapshot-request-foreign",
    };
    const foreignSnapshot = await sealedSnapshot(foreignExpected);
    const foreign = await publish({
      ...foreignIdentity,
      expected: foreignExpected,
      publicationId: "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a3",
      snapshot: foreignSnapshot,
    });
    if (foreign.kind !== "published") throw new Error("Expected publication.");
    publications.head = {
      kind: "published",
      publication: { ...first.publication, artifact: foreign.publication.artifact },
    };

    await expect(publisher.readCurrent(identity)).resolves.toMatchObject({
      generation: first.publication.generation,
      kind: "stale",
      reason: "artifact-corrupt",
    });
  });
});
