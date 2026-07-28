import { createHash } from "node:crypto";

import { canonicalJsonV1 } from "../../src/engine/fast-manim-snapshot-digest";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  expectedFastManimSnapshotCorrelationV1Schema,
  parseVerifiedFastManimSnapshotResultV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedSourceRuntimeIdentityMapV1,
} from "../fast-manim-snapshot-contract";
import { parseVerifiedSourceRuntimeIdentityMapV1 } from "../fast-manim-source-runtime-identity";
import {
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotPublicationIdentityV1,
  type SnapshotPublicationRepositoryV1,
  type SnapshotPublicationV1,
} from "./snapshot-publication-repository";

export const SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1 = "poietra.studio-snapshot-artifact" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_READ_ATTEMPTS = 3;
const DOCUMENT_FIELDS = [
  "expected",
  "profileDigest",
  "schema",
  "snapshot",
  "sourceRuntimeIdentity",
  "version",
] as const;

export type SnapshotArtifactDocumentV1 = Readonly<{
  expected: ExpectedFastManimSnapshotCorrelationV1;
  profileDigest: string;
  schema: typeof SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1;
  snapshot: VerifiedCompiledFastManimSnapshotResultV1;
  sourceRuntimeIdentity: VerifiedSourceRuntimeIdentityMapV1 | null;
  version: 1;
}>;

export type PublishSnapshotArtifactInputV1 = SnapshotPublicationIdentityV1 &
  Readonly<{
    expected: ExpectedFastManimSnapshotCorrelationV1;
    expectedSourceGeneration: bigint;
    profileDigest: string;
    publicationId: string;
    snapshot: VerifiedCompiledFastManimSnapshotResultV1;
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1 | null;
  }>;

export type SnapshotArtifactReadResultV1 =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      generation: bigint;
      kind: "stale";
      reason: "artifact-corrupt" | "artifact-missing" | "concurrently-superseded" | "source-stale";
    }>
  | Readonly<{
      document: SnapshotArtifactDocumentV1;
      kind: "published";
      publication: SnapshotPublicationV1;
    }>;

function sha256(value: string, name: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && keys.every((key, index) => key === fields[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBytes(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function sameArtifact(left: SnapshotArtifactReceiptV1, right: SnapshotArtifactReceiptV1) {
  return (
    left.byteSize === right.byteSize &&
    left.etag === right.etag &&
    left.objectKey === right.objectKey &&
    left.profileDigest === right.profileDigest &&
    left.resultDigest === right.resultDigest &&
    left.runtimeConfigHash === right.runtimeConfigHash &&
    left.sourceDigest === right.sourceDigest &&
    left.versionId === right.versionId
  );
}

function sameIdentity(left: SnapshotPublicationIdentityV1, right: SnapshotPublicationIdentityV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.sourcePath === right.sourcePath &&
    left.sceneName === right.sceneName
  );
}

function assertExpectedIdentity(
  expected: ExpectedFastManimSnapshotCorrelationV1,
  identity: SnapshotPublicationIdentityV1,
) {
  if (
    expected.projectId !== identity.projectId ||
    expected.sourcePath !== identity.sourcePath ||
    expected.sceneName !== identity.sceneName
  ) {
    throw new TypeError("Snapshot correlation does not belong to the publication identity.");
  }
}

function assertReceipt(
  receipt: SnapshotArtifactReceiptV1,
  input: Readonly<{
    byteSize: number;
    profileDigest: string;
    resultDigest: string;
    runtimeConfigHash: string;
    sourceDigest: string;
  }>,
) {
  if (
    receipt.byteSize !== input.byteSize ||
    receipt.profileDigest !== input.profileDigest ||
    receipt.resultDigest !== input.resultDigest ||
    receipt.runtimeConfigHash !== input.runtimeConfigHash ||
    receipt.sourceDigest !== input.sourceDigest
  ) {
    throw new Error("The snapshot artifact store returned a receipt for different bytes or correlation.");
  }
}

function assertPublication(
  publication: SnapshotPublicationV1,
  input: Readonly<{
    artifact: SnapshotArtifactReceiptV1;
    expectedSourceGeneration: bigint;
    identity: SnapshotPublicationIdentityV1;
    requestId: string;
    snapshotHash: string;
  }>,
) {
  if (
    !sameIdentity(publication, input.identity) ||
    !sameArtifact(publication.artifact, input.artifact) ||
    publication.sourceGeneration !== input.expectedSourceGeneration ||
    publication.requestId !== input.requestId ||
    publication.snapshotHash !== input.snapshotHash
  ) {
    throw new Error("The snapshot repository returned a publication for different content or correlation.");
  }
}

function canonicalBytes(document: SnapshotArtifactDocumentV1) {
  const bytes = Buffer.from(canonicalJsonV1(document), "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
    throw new RangeError("The canonical snapshot artifact exceeds 16 MiB.");
  }
  return bytes;
}

async function verifiedDocument(
  input: Readonly<{
    expected: ExpectedFastManimSnapshotCorrelationV1;
    profileDigest: string;
    snapshot: unknown;
    sourceRuntimeIdentity: unknown;
  }>,
): Promise<SnapshotArtifactDocumentV1> {
  const expected = expectedFastManimSnapshotCorrelationV1Schema.parse(input.expected);
  const profileDigest = sha256(input.profileDigest, "Snapshot profile digest");
  const snapshot = await parseVerifiedFastManimSnapshotResultV1(input.snapshot, expected);
  if (snapshot.kind !== "compiled") throw new TypeError("Only compiled snapshots can be published as artifacts.");
  const sourceRuntimeIdentity =
    input.sourceRuntimeIdentity === null
      ? null
      : parseVerifiedSourceRuntimeIdentityMapV1(input.sourceRuntimeIdentity, snapshot);
  return {
    expected,
    profileDigest,
    schema: SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1,
    snapshot,
    sourceRuntimeIdentity,
    version: 1,
  };
}

async function parseDocument(bytes: Uint8Array, publication: SnapshotPublicationV1) {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
    throw new RangeError("The stored snapshot artifact is outside its 16 MiB bound.");
  }
  if (publication.artifact.byteSize !== bytes.byteLength || publication.artifact.resultDigest !== digest(bytes)) {
    throw new Error("The stored snapshot artifact does not match its published digest.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError("The stored snapshot artifact is not UTF-8.", { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new TypeError("The stored snapshot artifact is not JSON.", { cause });
  }
  if (
    !isRecord(value) ||
    !exactFields(value, DOCUMENT_FIELDS) ||
    value.schema !== SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1 ||
    value.version !== 1
  ) {
    throw new TypeError("The stored snapshot artifact document is not strict v1.");
  }
  const document = await verifiedDocument({
    expected: value.expected as ExpectedFastManimSnapshotCorrelationV1,
    profileDigest: value.profileDigest as string,
    snapshot: value.snapshot,
    sourceRuntimeIdentity: value.sourceRuntimeIdentity,
  });
  if (!exactBytes(bytes, canonicalBytes(document))) {
    throw new TypeError("The stored snapshot artifact is not canonical UTF-8 JSON.");
  }
  assertExpectedIdentity(document.expected, publication);
  if (
    document.expected.requestId !== publication.requestId ||
    document.expected.sourceHash !== publication.artifact.sourceDigest ||
    document.expected.runtimeConfigHash !== publication.artifact.runtimeConfigHash ||
    document.profileDigest !== publication.artifact.profileDigest ||
    document.snapshot.snapshotHash !== publication.snapshotHash
  ) {
    throw new TypeError("The stored snapshot artifact is cross-correlated with its publication metadata.");
  }
  return document;
}

/** Uploads immutable bytes before atomically publishing their version-pinned receipt. */
export class SnapshotArtifactPublisherV1 {
  readonly #artifacts: SnapshotArtifactStoreV1;
  readonly #publications: SnapshotPublicationRepositoryV1;
  #closeRequest: Promise<void> | null = null;

  constructor(
    options: Readonly<{ artifacts: SnapshotArtifactStoreV1; publications: SnapshotPublicationRepositoryV1 }>,
  ) {
    this.#artifacts = options.artifacts;
    this.#publications = options.publications;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [artifactsReady, publicationsReady] = await Promise.all([
      this.#artifacts.ready(signal),
      this.#publications.ready(signal),
    ]);
    signal?.throwIfAborted();
    return artifactsReady && publicationsReady;
  }

  close() {
    this.#closeRequest ??= (async () => {
      const results = await Promise.allSettled([this.#artifacts.close(), this.#publications.close()]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "Could not fully close snapshot artifact storage.");
    })();
    return this.#closeRequest;
  }

  async publish(input: PublishSnapshotArtifactInputV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const identity: SnapshotPublicationIdentityV1 = {
      projectId: input.projectId,
      sceneName: input.sceneName,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
    };
    const document = await verifiedDocument({
      expected: input.expected,
      profileDigest: input.profileDigest,
      snapshot: input.snapshot,
      sourceRuntimeIdentity: input.sourceRuntimeIdentity ?? null,
    });
    assertExpectedIdentity(document.expected, identity);
    const bytes = canonicalBytes(document);
    signal?.throwIfAborted();
    const artifact = await this.#artifacts.put(
      identity.tenantId,
      {
        bytes,
        profileDigest: document.profileDigest,
        runtimeConfigHash: document.expected.runtimeConfigHash,
        sourceDigest: document.expected.sourceHash,
      },
      signal,
    );
    assertReceipt(artifact, {
      byteSize: bytes.byteLength,
      profileDigest: document.profileDigest,
      resultDigest: digest(bytes),
      runtimeConfigHash: document.expected.runtimeConfigHash,
      sourceDigest: document.expected.sourceHash,
    });
    signal?.throwIfAborted();
    const result = await this.#publications.publish(
      {
        ...identity,
        artifact,
        expectedSourceDigest: document.expected.sourceHash,
        expectedSourceGeneration: input.expectedSourceGeneration,
        publicationId: input.publicationId,
        requestId: document.expected.requestId,
        snapshotHash: document.snapshot.snapshotHash,
      },
      signal,
    );
    if (result.kind === "source-stale") return result;
    assertPublication(result.publication, {
      artifact,
      expectedSourceGeneration: input.expectedSourceGeneration,
      identity,
      requestId: document.expected.requestId,
      snapshotHash: document.snapshot.snapshotHash,
    });
    return result;
  }

  async readCurrent(
    identity: SnapshotPublicationIdentityV1,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactReadResultV1> {
    let lastGeneration = 0n;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const current = await this.#publications.readCurrent(identity, signal);
      if (current.kind === "missing") return current;
      if (current.kind === "stale") {
        return { generation: current.generation, kind: "stale", reason: "source-stale" };
      }
      const { publication } = current;
      lastGeneration = publication.generation;
      let bytes: Uint8Array;
      try {
        bytes = await this.#artifacts.read(identity.tenantId, publication.artifact, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof SnapshotArtifactReadErrorV1)) throw error;
        if (await this.#publications.clearHeadIfGeneration(identity, publication.generation, signal)) {
          return {
            generation: publication.generation,
            kind: "stale",
            reason: error.code === "missing" ? "artifact-missing" : "artifact-corrupt",
          };
        }
        continue;
      }
      let document: SnapshotArtifactDocumentV1;
      try {
        document = await parseDocument(bytes, publication);
      } catch {
        signal?.throwIfAborted();
        if (await this.#publications.clearHeadIfGeneration(identity, publication.generation, signal)) {
          return { generation: publication.generation, kind: "stale", reason: "artifact-corrupt" };
        }
        continue;
      }
      if (await this.#publications.confirmCurrent(publication, signal)) {
        return { document, kind: "published", publication };
      }
    }
    return { generation: lastGeneration, kind: "stale", reason: "concurrently-superseded" };
  }
}
