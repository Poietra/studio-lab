import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { HttpError } from "../http/json";
import {
  type ClientExportArtifactStoreV1,
  type ClientExportPublicationV1,
  type ClientExportRepositoryV1,
  clientExportObjectKeyV1,
} from "./client-export-contract";
import type { ClientExportPublicationMeteringV1 } from "./client-export-metering";
import { type ClientExportMp4VerificationV1, ClientExportPublisherV1 } from "./client-export-publisher";

const TENANT = "tenant-a";
const PUBLICATION_ID = "00000000-0000-4000-8000-000000000010";
const SUBJECT_ID = "00000000-0000-4000-8000-000000000020";
const OBJECT_LOCATOR_TOKEN = "00000000-0000-4000-8000-0000000000aa";
const VIDEO = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
const CONTENT_DIGEST = createHash("sha256").update(VIDEO).digest("hex");

const EXPORT_PROFILE = {
  codec: "h264-mp4",
  colorContractVersion: 1,
  frameRate: 30,
  maxDurationSeconds: 900,
  maxOutputBytes: 134_217_728,
  resolution: "854x480",
  schema: "poietra.export-profile",
  version: 1,
} as const;

// canonical alphabetical camelCase JSON of EXPORT_PROFILE, sha-256 lower hex.
const EXPORT_PROFILE_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      codec: EXPORT_PROFILE.codec,
      colorContractVersion: EXPORT_PROFILE.colorContractVersion,
      frameRate: EXPORT_PROFILE.frameRate,
      maxDurationSeconds: EXPORT_PROFILE.maxDurationSeconds,
      maxOutputBytes: EXPORT_PROFILE.maxOutputBytes,
      resolution: EXPORT_PROFILE.resolution,
      schema: EXPORT_PROFILE.schema,
      version: EXPORT_PROFILE.version,
    }),
    "utf8",
  )
  .digest("hex");

const SCENE_REVISION_HASH = "b".repeat(64);

function verification(): ClientExportMp4VerificationV1 {
  return {
    kind: "verified",
    provenance: {
      engineAbiVersion: 27,
      exportProfileHash: EXPORT_PROFILE_HASH,
      sceneId: "scene-1",
      sceneRevisionHash: SCENE_REVISION_HASH,
    },
    structure: {
      color: { fullRange: false, matrix: 1, primaries: 1, transfer: 1 },
      durationTicks: 100_000,
      frameRate: 30,
      heightPx: 480,
      sampleCount: 3,
      syncSampleCount: 1,
      timescale: 1_000_000,
      widthPx: 854,
    },
  };
}

function receipt(objectLocatorToken = OBJECT_LOCATOR_TOKEN) {
  return {
    byteSize: VIDEO.byteLength,
    contentDigest: CONTENT_DIGEST,
    etag: "etag-1",
    mediaType: "video/mp4" as const,
    objectKey: clientExportObjectKeyV1(TENANT, CONTENT_DIGEST, objectLocatorToken),
    objectLocatorToken,
  };
}

function publication(storedReceipt = receipt()): ClientExportPublicationV1 {
  return {
    artifact: { artifactId: "00000000-0000-4000-8000-000000000030", receipt: storedReceipt },
    createdBySubjectId: SUBJECT_ID,
    expiresAt: new Date(Date.now() + 60_000),
    lineage: {
      documentEpoch: "00000000-0000-4000-8000-000000000040",
      documentKey: "c".repeat(64),
      documentRevision: 0n,
      encoderEvidence: { codec: "h264-mp4" },
      encoderEvidenceVersion: 1,
      exportProfileHash: EXPORT_PROFILE_HASH,
      producerKind: "browser-webcodecs",
      sceneContractVersion: 1,
      sceneRevisionHash: SCENE_REVISION_HASH,
    },
    projectId: "project-1",
    publicationId: PUBLICATION_ID,
    publishedAt: new Date(),
    tenantId: TENANT,
  };
}

function input() {
  return {
    bytes: VIDEO,
    contentDigest: CONTENT_DIGEST,
    createdBySubjectId: SUBJECT_ID,
    documentEpoch: "00000000-0000-4000-8000-000000000040",
    documentKey: "c".repeat(64),
    documentRevision: 0n,
    encoderEvidence: { codec: "h264-mp4" },
    exportProfile: EXPORT_PROFILE,
    projectId: "project-1",
    publicationId: PUBLICATION_ID,
    sceneRevisionHash: SCENE_REVISION_HASH,
    tenantId: TENANT,
  };
}

type Overrides = Readonly<{
  accept?: unknown;
  put?: Error;
  read?: ClientExportPublicationV1 | null;
  reserve?: unknown;
  settle?: unknown;
  verify?: ClientExportMp4VerificationV1;
  verifyReady?: boolean;
}>;

function harness(overrides: Overrides = {}) {
  const artifacts = {
    deleteObject: vi.fn(async () => undefined),
    put: vi.fn(async () => {
      if (overrides.put) throw overrides.put;
      return receipt();
    }),
    ready: vi.fn(async () => true),
  } as unknown as ClientExportArtifactStoreV1;
  const publications = {
    acceptPublication: vi.fn(async () => {
      if (overrides.accept instanceof Error) throw overrides.accept;
      return "accept" in overrides
        ? overrides.accept
        : { kind: "accepted", publication: publication(), replayed: false };
    }),
    readPublication: vi.fn(async () => overrides.read ?? null),
    ready: vi.fn(async () => true),
  } as unknown as ClientExportRepositoryV1;
  const metering: ClientExportPublicationMeteringV1 = {
    releasePublication: vi.fn(async () => undefined),
    reservePublication: vi.fn(async () =>
      "reserve" in overrides ? (overrides.reserve as never) : ({ kind: "reserved", replayed: false } as const),
    ),
    settlePublicationWithClient: vi.fn(async () =>
      "settle" in overrides ? (overrides.settle as never) : ({ kind: "settled", replayed: false } as const),
    ),
  };
  const verifyMp4 = vi.fn(async () => overrides.verify ?? verification());
  const publisher = new ClientExportPublisherV1({
    artifactExpirationMs: 60_000,
    artifacts,
    metering,
    publications,
    tenantId: TENANT,
    verifyMp4,
    verifyMp4Ready: vi.fn(async () => overrides.verifyReady ?? true),
  });
  return { artifacts, metering, publications, publisher, verifyMp4 };
}

describe("ClientExportPublisherV1", () => {
  it("keeps readiness false when the packaged MP4 verifier is unavailable", async () => {
    const { publisher } = harness({ verifyReady: false });
    await expect(publisher.ready()).resolves.toBe(false);
  });

  it("verifies, reserves, stages, and accepts a fresh publication in order", async () => {
    const { artifacts, metering, publications, publisher, verifyMp4 } = harness();
    const result = await publisher.publish(input());
    expect(result.replayed).toBe(false);
    expect(result.publication.publicationId).toBe(PUBLICATION_ID);
    expect(verifyMp4).toHaveBeenCalledTimes(1);
    expect(metering.reservePublication).toHaveBeenCalledWith(
      { lifetimeMs: 5 * 60_000, operationId: PUBLICATION_ID, tenantId: TENANT },
      undefined,
    );
    expect(artifacts.put).toHaveBeenCalledWith(
      TENANT,
      { byteSize: VIDEO.byteLength, bytes: VIDEO, contentDigest: CONTENT_DIGEST },
      undefined,
    );
    expect(publications.acceptPublication).toHaveBeenCalledTimes(1);
    expect(artifacts.deleteObject).not.toHaveBeenCalled();
    expect(metering.releasePublication).not.toHaveBeenCalled();
  });

  it("returns the stored success for a byte-identical replay without reserving or re-staging", async () => {
    const { artifacts, metering, publisher } = harness({ read: publication() });
    const result = await publisher.publish(input());
    expect(result.replayed).toBe(true);
    expect(metering.reservePublication).not.toHaveBeenCalled();
    expect(metering.settlePublicationWithClient).not.toHaveBeenCalled();
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("treats reordered encoder-evidence keys as the same replay payload", async () => {
    const stored = publication();
    const { artifacts, metering, publisher } = harness({
      read: {
        ...stored,
        lineage: { ...stored.lineage, encoderEvidence: { codec: "h264-mp4", hardwareAcceleration: "prefer-software" } },
      },
    });
    const result = await publisher.publish({
      ...input(),
      encoderEvidence: { hardwareAcceleration: "prefer-software", codec: "h264-mp4" },
    });
    expect(result.replayed).toBe(true);
    expect(metering.reservePublication).not.toHaveBeenCalled();
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("refuses the same publication ID bound to a different payload with 409", async () => {
    const stored = publication();
    const { publisher } = harness({
      read: { ...stored, lineage: { ...stored.lineage, documentRevision: 7n } },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export publication ID is already bound to a different payload.",
      status: 409,
    });
  });

  it("refuses a content digest that does not match the uploaded bytes", async () => {
    const { publisher, verifyMp4 } = harness();
    await expect(publisher.publish({ ...input(), contentDigest: "f".repeat(64) })).rejects.toMatchObject({
      message: "The client export content digest does not match the uploaded bytes.",
      status: 400,
    });
    expect(verifyMp4).not.toHaveBeenCalled();
  });

  it("maps a structural MP4 refusal to a named 400", async () => {
    const { publisher } = harness({
      verify: { code: "keyframe-first-missing", kind: "refused", message: "The first sample is not a keyframe." },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export MP4 failed structural verification (keyframe-first-missing).",
      status: 400,
    });
  });

  it("refuses provenance that disagrees with the claimed lineage", async () => {
    const base = verification();
    if (base.kind !== "verified") throw new Error("unreachable");
    const { publisher } = harness({
      verify: { ...base, provenance: { ...base.provenance, sceneRevisionHash: "d".repeat(64) } },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export provenance does not match the claimed lineage.",
      status: 400,
    });
  });

  it("refuses MP4 dimensions outside the claimed export profile", async () => {
    const base = verification();
    if (base.kind !== "verified") throw new Error("unreachable");
    const { publisher } = harness({
      verify: { ...base, structure: { ...base.structure, heightPx: 720, widthPx: 1280 } },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export MP4 dimensions do not match the export profile.",
      status: 400,
    });
  });

  it("refuses an MP4 timestamp grid outside the claimed frame rate", async () => {
    const base = verification();
    if (base.kind !== "verified") throw new Error("unreachable");
    const { publisher } = harness({
      verify: { ...base, structure: { ...base.structure, frameRate: 60 } },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export MP4 frame rate does not match the export profile.",
      status: 400,
    });
  });

  it("refuses a duration beyond the export profile bound", async () => {
    const base = verification();
    if (base.kind !== "verified") throw new Error("unreachable");
    const { publisher } = harness({
      verify: { ...base, structure: { ...base.structure, durationTicks: 901 * 1_000_000 } },
    });
    await expect(publisher.publish(input())).rejects.toMatchObject({
      message: "The client export MP4 duration exceeds the export profile bound.",
      status: 400,
    });
  });

  it("maps metering denials to their named statuses", async () => {
    for (const [reason, status] of [
      ["quota-exhausted", 429],
      ["operation-settled", 409],
      ["unconfigured", 402],
    ] as const) {
      const { artifacts, publisher } = harness({ reserve: { kind: "denied", reason } });
      await expect(publisher.publish(input())).rejects.toMatchObject({ status });
      expect(artifacts.put).not.toHaveBeenCalled();
    }
  });

  it("discards the fresh upload and reservation when acceptance races into a replay", async () => {
    const { artifacts, metering, publisher } = harness({
      accept: { kind: "accepted", publication: publication(), replayed: true },
    });
    const result = await publisher.publish(input());
    expect(result.replayed).toBe(true);
    expect(artifacts.deleteObject).toHaveBeenCalledTimes(1);
    expect(metering.releasePublication).toHaveBeenCalledWith(TENANT, PUBLICATION_ID);
  });

  it("turns concurrent first-use finalizations into one acceptance and one replay", async () => {
    const fixture = harness();
    const receipts = [receipt("00000000-0000-4000-8000-0000000000aa"), receipt("00000000-0000-4000-8000-0000000000ab")];
    vi.mocked(fixture.artifacts.put).mockImplementation(async () => receipts.shift()!);
    let waiting = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let stored: ClientExportPublicationV1 | null = null;
    vi.mocked(fixture.publications.acceptPublication).mockImplementation(async (candidate) => {
      waiting += 1;
      if (waiting === 2) releaseBarrier();
      await barrier;
      if (stored) return { kind: "accepted", publication: stored, replayed: true } as const;
      stored = {
        ...publication(candidate.receipt),
        artifact: { artifactId: candidate.artifactId, receipt: candidate.receipt },
        createdBySubjectId: candidate.createdBySubjectId,
        lineage: candidate.lineage,
        projectId: candidate.projectId,
        publicationId: candidate.publicationId,
      };
      return { kind: "accepted", publication: stored, replayed: false } as const;
    });

    const results = await Promise.all([fixture.publisher.publish(input()), fixture.publisher.publish(input())]);

    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(fixture.publications.acceptPublication).toHaveBeenCalledTimes(2);
    expect(fixture.artifacts.deleteObject).toHaveBeenCalledTimes(1);
    expect(fixture.metering.releasePublication).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation when object staging fails without a receipt", async () => {
    const failure = new Error("object put failed");
    const { artifacts, metering, publications, publisher } = harness({ put: failure });
    await expect(publisher.publish(input())).rejects.toBe(failure);
    expect(artifacts.deleteObject).not.toHaveBeenCalled();
    expect(metering.releasePublication).toHaveBeenCalledWith(TENANT, PUBLICATION_ID);
    expect(publications.acceptPublication).not.toHaveBeenCalled();
  });

  it("preserves the staged object and reservation when database acceptance has an ambiguous outcome", async () => {
    const failure = new Error("connection lost after commit may have succeeded");
    const { artifacts, metering, publisher } = harness({ accept: failure });

    await expect(publisher.publish(input())).rejects.toBe(failure);
    expect(artifacts.deleteObject).not.toHaveBeenCalled();
    expect(metering.releasePublication).not.toHaveBeenCalled();
  });

  it("maps acceptance refusals to named statuses and discards the staged upload", async () => {
    for (const [reason, status, message] of [
      ["artifact-deleting", 409, "The staged client export is no longer available; retry the publication."],
      ["document-not-found", 404, "The export lineage document was not found."],
      ["revision-ahead", 409, "The export lineage revision is ahead of the document."],
      ["quota-exhausted", 429, "The client export publication quota is exhausted."],
    ] as const) {
      const { artifacts, publisher } = harness({ accept: { kind: "refused", reason } });
      await expect(publisher.publish(input())).rejects.toMatchObject({ message, status });
      expect(artifacts.deleteObject).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses an upload above the 128 MiB bound before verification", async () => {
    const { publisher, verifyMp4 } = harness();
    const oversize = new Uint8Array(134_217_728 + 1);
    await expect(
      publisher.publish({ ...input(), bytes: oversize, contentDigest: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 413 });
    expect(verifyMp4).not.toHaveBeenCalled();
  });

  it("throws the HttpError class for every named refusal", async () => {
    const { publisher } = harness({
      verify: { code: "malformed-container", kind: "refused", message: "not ISO BMFF" },
    });
    await expect(publisher.publish(input())).rejects.toBeInstanceOf(HttpError);
  });
});
