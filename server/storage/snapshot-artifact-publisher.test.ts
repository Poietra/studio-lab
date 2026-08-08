import { createHash } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../../src/engine/fast-manim-snapshot-digest";
import {
  STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1,
  type VerifiedSourceRuntimeIdentityMapV1,
} from "../../src/engine/source-runtime-identity";
import {
  deriveHermeticPngV4TransformPlan,
  type ExpectedFastManimSnapshotCorrelationV1,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "../fast-manim-snapshot-contract";
import {
  mixedDynamic2dSnapshotBundleFixtureV7,
  pngSnapshotBundleFixture,
  staticSnapshotBundleFixture,
} from "../test-fixtures/fast-manim-snapshot-bundle-fixture";
import {
  immutableSnapshotArtifactObjectKeyV1,
  parseImmutableSnapshotArtifactReceiptV1,
} from "./immutable-snapshot-artifact-store";
import { SnapshotArtifactPublisherV1 } from "./snapshot-artifact-publisher";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  parseSnapshotArtifactReceiptV1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotPublicationIdentityV1,
  type SnapshotPublicationReadV1,
  type SnapshotPublicationRepositoryV1,
  type SnapshotPublicationV1,
  snapshotArtifactLocatorV1,
} from "./snapshot-publication-repository";

const PROFILE = "c".repeat(64);
const RUNTIME_CONFIG_HASH = "b".repeat(64);
const RUNTIME_DIGEST = "5".repeat(64);
const TENANT = "tenant-a";
const PUBLICATION_ID = "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a1";
const identity = {
  projectId: "workspace-a",
  runtimeConfigHash: RUNTIME_CONFIG_HASH,
  runtimeDigest: RUNTIME_DIGEST,
  sceneName: "ExampleScene",
  sourcePath: "examples/scene.py",
  tenantId: TENANT,
} satisfies SnapshotPublicationIdentityV1;

function versionId(artifact: SnapshotArtifactReceiptV1) {
  const locator = snapshotArtifactLocatorV1(artifact);
  if (locator.kind !== "versioned") throw new Error("Expected a versioned test artifact.");
  return locator.versionId;
}

const expected = {
  frame: { height: 8, width: 14.222222222222221 },
  projectId: identity.projectId,
  requestId: "snapshot-request-a",
  runtimeConfigHash: RUNTIME_CONFIG_HASH,
  snapshotVersion: 1,
  sceneId: fastManimSnapshotSceneIdV1(identity.sourcePath, identity.sceneName),
  sceneName: identity.sceneName,
  sourceHash: "a".repeat(64),
  sourcePath: identity.sourcePath,
} satisfies ExpectedFastManimSnapshotCorrelationV1;

const expectedV7 = {
  ...expected,
  requestId: "snapshot-request-v7",
  snapshotVersion: 7,
} as const satisfies ExpectedFastManimSnapshotCorrelationV1;

const TRANSFORMED_PNG_SOURCE = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ExampleScene(Scene):
    def construct(self):
        image = ImageMobject(
            "image.png",
            resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"],
        )
        self.add(image)
        image.scale(1.5)
        image.move_to((1, -2, 0))
        self.wait(2)
`;

async function sealedSnapshot(expectedValue: ExpectedFastManimSnapshotCorrelationV1 = expected) {
  const bundle = await staticSnapshotBundleFixture(expectedValue);
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

async function sealedMixedDynamicSnapshotV7() {
  const bundle = await mixedDynamic2dSnapshotBundleFixtureV7(expectedV7);
  const { frame: _frame, snapshotVersion: _snapshotVersion, ...wire } = expectedV7;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(
    JSON.stringify({
      ...wire,
      bundle,
      kind: "compiled",
      schema: "poietra.fast-manim-snapshot-result",
      snapshotHash: ZERO_SHA256,
      version: 1,
    }),
    expectedV7,
  );
  if (sealed.kind !== "compiled") throw new Error("Expected a compiled V7 mixed dynamic snapshot.");
  return sealed;
}

function completeV7Identity(snapshot: VerifiedCompiledFastManimSnapshotResultV1) {
  const names = ["equation", "ring", "particle"] as const;
  return {
    mappings: snapshot.bundle.scene.entities.map((entity, index) => {
      const name = names[index];
      if (!name) throw new Error("Expected exactly three V7 fixture entities.");
      return {
        binding: {
          id: `source-binding:${String(index + 1).repeat(64)}`,
          name,
          ordinal: index + 1,
          span: { endColumn: name.length, endLine: index + 1, startColumn: 0, startLine: index + 1 },
        },
        entityId: entity.id,
        familyPath: [],
        provenanceId: entity.provenanceId,
      };
    }),
    runtimeConfigHash: snapshot.runtimeConfigHash,
    sceneId: snapshot.sceneId,
    schema: STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1,
    snapshotDigest: createHash("sha256").update(canonicalJsonV1(snapshot), "utf8").digest("hex"),
    snapshotHash: snapshot.snapshotHash,
    sourceHash: snapshot.sourceHash,
    version: 1,
  } satisfies VerifiedSourceRuntimeIdentityMapV1;
}

async function sealedTransformedPngSnapshot(expectedValue: ExpectedFastManimSnapshotCorrelationV1) {
  const plan = expectedValue.hermeticPngV4Plan;
  if (expectedValue.snapshotVersion !== 4 || !plan) throw new Error("Expected one V4 transform plan.");
  const bundle = await pngSnapshotBundleFixture(expectedValue, { plan });
  const {
    frame: _frame,
    hermeticPngV4Plan: _hermeticPngV4Plan,
    snapshotVersion: _snapshotVersion,
    ...wire
  } = expectedValue;
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
    TRANSFORMED_PNG_SOURCE,
  );
  if (sealed.kind !== "compiled") throw new Error("Expected a compiled V4 PNG snapshot.");
  return sealed;
}

class MemoryArtifactStore implements SnapshotArtifactStoreV1 {
  readonly bytes = new Map<string, Uint8Array>();
  readonly events: string[];
  readFailure: unknown = null;
  #version = 0;

  constructor(
    events: string[],
    readonly mode: "immutable" | "versioned" = "versioned",
  ) {
    this.events = events;
  }

  async put(
    tenantId: string,
    input: Readonly<{
      bytes: Uint8Array;
      profileDigest: string;
      runtimeConfigHash: string;
      runtimeDigest: string;
      sourceDigest: string;
    }>,
  ) {
    this.events.push("put");
    const resultDigest = createHash("sha256").update(input.bytes).digest("hex");
    const versionId = `version-${++this.#version}`;
    const shared = {
      byteSize: input.bytes.byteLength,
      etag: `etag-${this.#version}`,
    };
    const contentKey = `tenants/${tenantId}/snapshots/${input.sourceDigest}/${input.runtimeConfigHash}/${input.profileDigest}/${input.runtimeDigest}/${resultDigest}`;
    const objectGeneration = `00000000-0000-4000-8000-${String(this.#version).padStart(12, "0")}`;
    const receipt: SnapshotArtifactReceiptV1 =
      this.mode === "versioned"
        ? {
            ...shared,
            objectKey: contentKey,
            profileDigest: input.profileDigest,
            resultDigest,
            runtimeConfigHash: input.runtimeConfigHash,
            runtimeDigest: input.runtimeDigest,
            sourceDigest: input.sourceDigest,
            versionId,
          }
        : {
            ...shared,
            identity: {
              kind: "runtime-digest",
              profileDigest: input.profileDigest,
              resultDigest,
              runtimeConfigHash: input.runtimeConfigHash,
              runtimeDigest: input.runtimeDigest,
              sourceDigest: input.sourceDigest,
            },
            objectGeneration,
            objectKey: `${contentKey}/g/${objectGeneration}`,
            schema: "poietra.immutable-snapshot-artifact-receipt",
            version: 1,
          };
    this.bytes.set(this.mode === "versioned" ? versionId : objectGeneration, Uint8Array.from(input.bytes));
    return receipt;
  }

  async read(_tenantId: string, artifact: SnapshotArtifactReceiptV1) {
    if (this.readFailure) throw this.readFailure;
    const locator = snapshotArtifactLocatorV1(artifact);
    const bytes = this.bytes.get(locator.kind === "versioned" ? locator.versionId : locator.objectGeneration);
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
    const key = this.#key(value);
    const head = this.#heads.get(key) ?? { kind: "missing" as const };
    if (head.kind !== "published" || head.publication.generation !== generation) {
      return false;
    }
    this.#heads.set(key, { generation, kind: "stale" });
    return true;
  });
  readonly confirmCurrent = vi.fn(async (publication: SnapshotPublicationV1) => {
    const head = this.#heads.get(this.#key(publication));
    return (
      head?.kind === "published" &&
      head.publication.generation === publication.generation &&
      head.publication.publicationId === publication.publicationId
    );
  });
  readonly events: string[];
  readQueue: SnapshotPublicationReadV1[] = [];
  sourceStale = false;
  readonly #generations = new Map<string, bigint>();
  readonly #heads = new Map<string, SnapshotPublicationReadV1>();

  constructor(events: string[]) {
    this.events = events;
  }

  #key(value: SnapshotPublicationIdentityV1) {
    return [
      value.tenantId,
      value.projectId,
      value.sourcePath,
      value.sceneName,
      value.runtimeDigest,
      value.runtimeConfigHash,
    ].join("\0");
  }

  get head() {
    return this.#heads.get(this.#key(identity)) ?? ({ kind: "missing" } as const);
  }

  set head(value: SnapshotPublicationReadV1) {
    this.#heads.set(this.#key(identity), value);
  }

  async publish(input: Parameters<SnapshotPublicationRepositoryV1["publish"]>[0]) {
    this.events.push("publish");
    if (this.sourceStale) return { kind: "source-stale" as const };
    const key = this.#key(input);
    const generation = (this.#generations.get(key) ?? 0n) + 1n;
    this.#generations.set(key, generation);
    const publication: SnapshotPublicationV1 = {
      artifact: input.artifact,
      generation,
      projectId: input.projectId,
      publicationId: input.publicationId,
      publishedAt: new Date("2026-07-28T00:00:00.000Z"),
      requestId: input.requestId,
      runtimeConfigHash: input.runtimeConfigHash,
      runtimeDigest: input.runtimeDigest,
      sceneName: input.sceneName,
      snapshotHash: input.snapshotHash,
      sourceGeneration: input.expectedSourceGeneration,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
    };
    const result = { kind: "published" as const, publication };
    this.#heads.set(key, result);
    return result;
  }

  async readCurrent(value: SnapshotPublicationIdentityV1) {
    return this.readQueue.shift() ?? this.#heads.get(this.#key(value)) ?? { kind: "missing" as const };
  }

  async acknowledgeArtifactDeletion() {}
  async compactPublicationTombstones() {
    return 0;
  }
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
  let snapshotV7: VerifiedCompiledFastManimSnapshotResultV1;
  let sourceRuntimeIdentityV7: VerifiedSourceRuntimeIdentityMapV1;
  let events: string[];
  let artifacts: MemoryArtifactStore;
  let publications: MemoryPublicationRepository;
  let publisher: SnapshotArtifactPublisherV1;

  beforeAll(async () => {
    [snapshot, snapshotV7] = await Promise.all([sealedSnapshot(), sealedMixedDynamicSnapshotV7()]);
    sourceRuntimeIdentityV7 = completeV7Identity(snapshotV7);
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
      const bytes = artifacts.bytes.get(versionId(result.publication.artifact))!;
      const wire = JSON.parse(Buffer.from(bytes).toString("utf8")) as { expected: Record<string, unknown> };
      expect(wire).toMatchObject({
        runtimeDigest: RUNTIME_DIGEST,
        schema: "poietra.studio-snapshot-artifact",
        version: 2,
      });
      expect(wire.expected).not.toHaveProperty("snapshotVersion");
      const read = await publisher.readCurrent(identity);
      expect(read.kind).toBe("published");
      if (read.kind === "published") expect(read.document.expected.snapshotVersion).toBe(1);
    }
  });

  it("isolates publication heads by exact runtime configuration under one attested runtime", async () => {
    const otherRuntimeConfigHash = "d".repeat(64);
    const otherIdentity = { ...identity, runtimeConfigHash: otherRuntimeConfigHash };
    const otherExpected = {
      ...expected,
      requestId: "snapshot-request-other-config",
      runtimeConfigHash: otherRuntimeConfigHash,
      snapshotVersion: 2,
    } as const satisfies ExpectedFastManimSnapshotCorrelationV1;

    const first = await publish();
    const second = await publish({
      ...otherIdentity,
      expected: otherExpected,
      publicationId: "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a2",
      snapshot: await sealedSnapshot(otherExpected),
    });

    expect(first).toMatchObject({ kind: "published", publication: { generation: 1n } });
    expect(second).toMatchObject({ kind: "published", publication: { generation: 1n } });
    await expect(publisher.readCurrent(identity)).resolves.toMatchObject({
      document: { expected: { requestId: expected.requestId, runtimeConfigHash: RUNTIME_CONFIG_HASH } },
      kind: "published",
    });
    await expect(publisher.readCurrent(otherIdentity)).resolves.toMatchObject({
      document: { expected: { requestId: otherExpected.requestId, runtimeConfigHash: otherRuntimeConfigHash } },
      kind: "published",
    });
    await expect(publisher.readCurrent({ ...identity, runtimeConfigHash: "e".repeat(64) })).resolves.toEqual({
      kind: "missing",
    });
  });

  it("rejects a publication identity that disagrees with the verified runtime configuration", async () => {
    await expect(publish({ runtimeConfigHash: "d".repeat(64) })).rejects.toThrow(/publication identity/i);
    expect(events).toEqual([]);
  });

  it("publishes and reads the immutable receipt shape without flattening its locator", async () => {
    artifacts = new MemoryArtifactStore(events, "immutable");
    publisher = new SnapshotArtifactPublisherV1({ artifacts, publications });

    const result = await publish();

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.publication.artifact).toMatchObject({
      identity: { kind: "runtime-digest", runtimeDigest: RUNTIME_DIGEST },
      objectGeneration: expect.any(String),
      schema: "poietra.immutable-snapshot-artifact-receipt",
    });
    await expect(publisher.readCurrent(identity)).resolves.toMatchObject({ kind: "published" });
  });

  it("rejects the reserved legacy runtime identity before uploading", async () => {
    await expect(publish({ runtimeDigest: LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 })).rejects.toThrow(/legacy/i);
    expect(events).toEqual([]);
  });

  it("rejects a V7 snapshot without complete identity before uploading any artifact bytes", async () => {
    await expect(
      publish({ expected: expectedV7, snapshot: snapshotV7, sourceRuntimeIdentity: null }),
    ).rejects.toMatchObject({ code: "identity-evidence-invalid" });

    expect(events).toEqual([]);
    expect(artifacts.bytes.size).toBe(0);
    expect(publications.head).toEqual({ kind: "missing" });
  });

  it("marks a V7 artifact corrupt when its identity is removed despite a matching digest and receipt", async () => {
    artifacts = new MemoryArtifactStore(events, "immutable");
    publisher = new SnapshotArtifactPublisherV1({ artifacts, publications });
    const result = await publish({
      expected: expectedV7,
      snapshot: snapshotV7,
      sourceRuntimeIdentity: sourceRuntimeIdentityV7,
    });
    if (result.kind !== "published") throw new Error("Expected a V7 publication.");
    const artifact = result.publication.artifact;
    if (!("identity" in artifact)) throw new Error("Expected an immutable V7 artifact.");
    const stored = artifacts.bytes.get(artifact.objectGeneration);
    if (!stored) throw new Error("Expected stored V7 artifact bytes.");
    const wire = JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, unknown>;
    wire.sourceRuntimeIdentity = null;
    const tampered = Buffer.from(canonicalJsonV1(wire), "utf8");
    const tamperedIdentity = {
      ...artifact.identity,
      resultDigest: createHash("sha256").update(tampered).digest("hex"),
    };
    const tamperedArtifact = parseSnapshotArtifactReceiptV1(TENANT, {
      ...artifact,
      byteSize: tampered.byteLength,
      identity: tamperedIdentity,
      objectKey: immutableSnapshotArtifactObjectKeyV1(TENANT, tamperedIdentity, artifact.objectGeneration),
    });
    artifacts.bytes.set(artifact.objectGeneration, tampered);
    publications.head = {
      kind: "published",
      publication: { ...result.publication, artifact: tamperedArtifact },
    };

    expect(tamperedIdentity.resultDigest).toBe(createHash("sha256").update(tampered).digest("hex"));
    await expect(publisher.readCurrent(identity)).resolves.toEqual({
      generation: result.publication.generation,
      kind: "stale",
      reason: "artifact-corrupt",
    });
    expect(publications.clearHeadIfGeneration).toHaveBeenCalledWith(identity, result.publication.generation, undefined);
  });

  it("stores and revalidates an explicit V2 profile expectation", async () => {
    const expectedV2 = { ...expected, requestId: "snapshot-request-v2", snapshotVersion: 2 } as const;
    const result = await publish({ expected: expectedV2, snapshot: await sealedSnapshot(expectedV2) });
    if (result.kind !== "published") throw new Error("Expected V2 publication.");
    const bytes = artifacts.bytes.get(versionId(result.publication.artifact))!;
    const wire = JSON.parse(Buffer.from(bytes).toString("utf8")) as { expected: Record<string, unknown> };
    expect(wire.expected.snapshotVersion).toBe(2);
    const read = await publisher.readCurrent(identity);
    expect(read.kind).toBe("published");
    if (read.kind === "published") expect(read.document.expected.snapshotVersion).toBe(2);
  });

  it("round-trips a non-empty V4 transform plan and rejects canonical plan tampering during sealed read", async () => {
    const hermeticPngV4Plan = deriveHermeticPngV4TransformPlan(TRANSFORMED_PNG_SOURCE, expected.sceneName);
    const expectedV4 = {
      ...expected,
      hermeticPngV4Plan,
      requestId: "snapshot-request-v4",
      snapshotVersion: 4,
      sourceHash: createHash("sha256").update(TRANSFORMED_PNG_SOURCE, "utf8").digest("hex"),
    } as const;
    expect(hermeticPngV4Plan.transforms.length).toBeGreaterThan(0);
    artifacts = new MemoryArtifactStore(events, "immutable");
    publisher = new SnapshotArtifactPublisherV1({ artifacts, publications });
    const result = await publish({ expected: expectedV4, snapshot: await sealedTransformedPngSnapshot(expectedV4) });
    if (result.kind !== "published") throw new Error("Expected V4 publication.");
    const artifact = result.publication.artifact;
    if (!("identity" in artifact)) throw new Error("Expected an immutable V4 artifact.");
    const stored = artifacts.bytes.get(artifact.objectGeneration)!;
    const wire = JSON.parse(Buffer.from(stored).toString("utf8")) as {
      expected: {
        hermeticPngV4Plan: {
          terminalWait: number | null;
          transforms: Array<{ factor: number; kind: "scale" } | { kind: "move-to"; x: number; y: number }>;
        };
      };
    } & Record<string, unknown>;

    expect(wire.expected.hermeticPngV4Plan).toEqual(hermeticPngV4Plan);
    expect(Buffer.from(canonicalJsonV1(wire), "utf8").equals(Buffer.from(stored))).toBe(true);
    await expect(publisher.readCurrent(identity)).resolves.toMatchObject({
      document: { expected: { hermeticPngV4Plan } },
      kind: "published",
    });

    wire.expected.hermeticPngV4Plan.transforms[0] = { factor: 2, kind: "scale" };
    const tampered = Buffer.from(canonicalJsonV1(wire), "utf8");
    artifacts.bytes.set(artifact.objectGeneration, tampered);
    const tamperedIdentity = {
      ...artifact.identity,
      resultDigest: createHash("sha256").update(tampered).digest("hex"),
    };
    const tamperedArtifact = parseImmutableSnapshotArtifactReceiptV1(TENANT, {
      ...artifact,
      byteSize: tampered.byteLength,
      identity: tamperedIdentity,
      objectKey: immutableSnapshotArtifactObjectKeyV1(TENANT, tamperedIdentity, artifact.objectGeneration),
    });
    publications.head = {
      kind: "published",
      publication: { ...result.publication, artifact: tamperedArtifact },
    };

    await expect(
      parseVerifiedFastManimSnapshotResultV1(wire.snapshot, wire.expected as ExpectedFastManimSnapshotCorrelationV1),
    ).rejects.toMatchObject({ code: "profile-violation" });
    await expect(publisher.readCurrent(identity)).resolves.toEqual({
      generation: result.publication.generation,
      kind: "stale",
      reason: "artifact-corrupt",
    });
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
    const stored = artifacts.bytes.get(versionId(result.publication.artifact))!;
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
    artifacts.bytes.delete(versionId(result.publication.artifact));

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
    const firstBytes = artifacts.bytes.get(versionId(first.publication.artifact))!;
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

  it("rejects a repository response from another runtime before reading bytes", async () => {
    const result = await publish();
    if (result.kind !== "published") throw new Error("Expected publication.");
    publications.head = {
      kind: "published",
      publication: { ...result.publication, runtimeDigest: "6".repeat(64) },
    };

    await expect(publisher.readCurrent(identity)).rejects.toThrow(/another runtime/i);
    expect(events.at(-1)).toBe("publish");
  });
});
