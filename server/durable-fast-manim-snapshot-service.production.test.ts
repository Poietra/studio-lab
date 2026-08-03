import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
  FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import { LocalProcessFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import { FastManimProductionSnapshotRunnerFactoryV1 } from "./fast-manim-production-snapshot-runner-factory";
import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import { startFastManimSandboxBrokerServerV1 } from "./fast-manim-sandbox-broker-server";
import { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import {
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotPublicationRepositoryV1,
  type SnapshotPublicationV1,
  snapshotArtifactObjectKeyV1,
} from "./storage/snapshot-publication-repository";
import type {
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";
import { productionSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";
import {
  producerCommand,
  sceneSource,
  TEST_PRODUCER_PROCESS_TIMINGS,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const TENANT = "tenant-a";
const PROJECT = "workspace-a";
const SOURCE_PATH = "scene.py";
const SCENE_NAME = "ExampleScene";
const PUBLICATION_ID = "018f57e2-4c8b-4d31-a91e-4ae5e5c6c8a1";
const PUBLISHED_AT = new Date("2026-07-28T01:02:03.000Z");
const SOURCE_DIGEST = createHash("sha256").update(sceneSource, "utf8").digest("hex");
const canRunProductionUdsFixture =
  process.platform === "linux" &&
  typeof process.geteuid === "function" &&
  process.geteuid() > 0 &&
  typeof process.getegid === "function";

const roots: string[] = [];
const closeables: Array<Readonly<{ close: () => Promise<void> }>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const resource of closeables.splice(0).reverse()) {
    await resource.close().catch((error: unknown) => errors.push(error));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  if (errors.length > 0) throw new AggregateError(errors, "The production snapshot fixture did not close safely.");
});

function productionRelease() {
  const keys = generateKeyPairSync("ed25519");
  const issuedAt = Date.now() - 1_000;
  const material = {
    dockerServerVersion: "28.3.3",
    imageDigest: `sha256:${"a".repeat(64)}`,
    profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
    seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  };
  const payload = {
    ...material,
    expiresAt: issuedAt + 10 * 60_000,
    issuedAt,
    keyId: "snapshot-integration-key",
    runtimeDigest: digestFastManimGatedOciRuntimeV1(material),
    schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
    version: 1 as const,
  };
  const signedRelease = {
    payload,
    signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
  };
  const publicKeys = [
    { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
  ];
  return { publicKeys, signedRelease, verified: verifyFastManimGatedOciReleaseV1(signedRelease, publicKeys) };
}

function durableStorage() {
  const blob = {
    byteSize: Buffer.byteLength(sceneSource, "utf8"),
    digest: SOURCE_DIGEST,
    etag: "source-etag",
    objectKey: `tenants/${TENANT}/sources/${SOURCE_DIGEST}`,
    versionId: "source-version-1",
  } as const;
  const sourceHead = {
    blob,
    generation: 7n,
    projectId: PROJECT,
    sourcePath: SOURCE_PATH,
    tenantId: TENANT,
  } satisfies WorkspaceSourceHeadV1;
  const readSourceHead = vi.fn<WorkspaceSourceRepositoryV1["readSourceHead"]>(async () => sourceHead);
  const readSource = vi.fn<SourceContentBlobStoreV1["readSource"]>(async () => sceneSource);
  const sourceRepository = { readSourceHead } as unknown as WorkspaceSourceRepositoryV1;
  const blobs = { readSource } as unknown as SourceContentBlobStoreV1;

  let artifactBytes: Uint8Array | undefined;
  const put = vi.fn<SnapshotArtifactStoreV1["put"]>(async (tenantId, input) => {
    artifactBytes = Uint8Array.from(input.bytes);
    const resultDigest = createHash("sha256").update(input.bytes).digest("hex");
    const identity = {
      profileDigest: input.profileDigest,
      resultDigest,
      runtimeConfigHash: input.runtimeConfigHash,
      runtimeDigest: input.runtimeDigest,
      sourceDigest: input.sourceDigest,
    };
    return {
      byteSize: input.bytes.byteLength,
      etag: "snapshot-etag",
      objectKey: snapshotArtifactObjectKeyV1(tenantId, identity),
      ...identity,
      versionId: "snapshot-version-1",
    } satisfies SnapshotArtifactReceiptV1;
  });
  const artifacts = {
    close: vi.fn(async () => undefined),
    put,
  } as unknown as SnapshotArtifactStoreV1;
  const publish = vi.fn<SnapshotPublicationRepositoryV1["publish"]>(async (input) => {
    const publication = {
      artifact: input.artifact,
      generation: 1n,
      projectId: input.projectId,
      publicationId: input.publicationId,
      publishedAt: PUBLISHED_AT,
      requestId: input.requestId,
      runtimeConfigHash: input.runtimeConfigHash,
      runtimeDigest: input.runtimeDigest,
      sceneName: input.sceneName,
      snapshotHash: input.snapshotHash,
      sourceGeneration: input.expectedSourceGeneration,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
    } satisfies SnapshotPublicationV1;
    return { kind: "published", publication };
  });
  const publications = {
    close: vi.fn(async () => undefined),
    publish,
  } as unknown as SnapshotPublicationRepositoryV1;
  return {
    artifacts,
    artifactBytes: () => artifactBytes,
    blobs,
    publications,
    publish,
    publisher: new SnapshotArtifactPublisherV1({ artifacts, publications }),
    readSource,
    readSourceHead,
    sourceRepository,
  };
}

describe.skipIf(!canRunProductionUdsFixture)("durable production snapshot path", () => {
  it("publishes a verified snapshot through the production factory and UDS broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-durable-snapshot-"));
    roots.push(root);
    await chmod(root, 0o750);
    const socketPath = join(root, "broker.sock");
    const brokerUserId = process.geteuid!();
    const socketGroupId = process.getegid!();
    const release = productionRelease();
    // The rootless OCI backend has its own opt-in real-host lane. This fixture
    // keeps the broker, client, request execution, and result bytes real while
    // substituting only the verified production status needed by that host boundary.
    const processBackend = new LocalProcessFastManimSandboxBackendV1({
      command: producerCommand(),
      producerProcessTimings: TEST_PRODUCER_PROCESS_TIMINGS,
      projectRoot: root,
    });
    const start = vi.fn<FastManimSandboxBackendV1["start"]>((request, context) =>
      processBackend.start(request, context),
    );
    const status = vi.fn<FastManimSandboxBackendV1["status"]>(async (context) => {
      context.signal.throwIfAborted();
      return {
        ...productionSandboxReadyStatus(FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1),
        attestation: release.verified.statusAttestation(),
        backendId: FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
      };
    });
    const broker = await startFastManimSandboxBrokerServerV1({
      backend: { close: () => processBackend.close(), start, status },
      socketGroupId,
      socketPath,
    });
    closeables.push(broker);

    vi.spyOn(process, "geteuid").mockReturnValue(brokerUserId + 1);
    const factory = new FastManimProductionSnapshotRunnerFactoryV1({
      client: {
        brokerUserId,
        publicKeys: release.publicKeys,
        signedRelease: release.signedRelease,
        socketGroupId,
        socketPath,
      },
      frame: { height: 8, width: 14.222222222222221 },
      tenantId: TENANT,
      timeoutMs: 10_000,
    });
    const storage = durableStorage();
    const service = new DurableFastManimSnapshotServiceV1({
      blobs: storage.blobs,
      factory,
      publicationIdFactory: () => PUBLICATION_ID,
      publisher: storage.publisher,
      sourceRepository: storage.sourceRepository,
      tenantId: TENANT,
    });
    closeables.push(service);

    const published = await service.run({
      projectId: PROJECT,
      requestId: "snapshot-request-1",
      sceneName: SCENE_NAME,
      sourcePath: SOURCE_PATH,
    });

    expect(published).toMatchObject({
      publishedAt: PUBLISHED_AT.toISOString(),
      revision: 1,
      status: "verified",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalled();
    expect(storage.readSource).toHaveBeenCalled();
    expect(storage.readSourceHead).toHaveBeenCalled();
    expect(storage.artifacts.put).toHaveBeenCalledOnce();
    expect(storage.publications.publish).toHaveBeenCalledOnce();
    expect(storage.publish.mock.calls[0]?.[0]).toMatchObject({
      expectedSourceDigest: SOURCE_DIGEST,
      expectedSourceGeneration: 7n,
      projectId: PROJECT,
      publicationId: PUBLICATION_ID,
      tenantId: TENANT,
    });
    const artifactDocument = JSON.parse(Buffer.from(storage.artifactBytes()!).toString("utf8")) as {
      expected: { projectId: string; requestId: string; sourceHash: string };
      profileDigest: string;
      runtimeDigest: string;
    };
    expect(artifactDocument).toMatchObject({
      expected: { projectId: PROJECT, requestId: "snapshot-request-1", sourceHash: SOURCE_DIGEST },
      profileDigest: FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
      runtimeDigest: release.signedRelease.payload.runtimeDigest,
    });
  }, 30_000);
});
