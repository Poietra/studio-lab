import { createHash } from "node:crypto";

import { canonicalJsonV1 } from "../../src/engine/fast-manim-snapshot-digest";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  expectedFastManimSnapshotCorrelationV1Schema,
  parseVerifiedFastManimSnapshotResultV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedSourceRuntimeIdentityMapV1,
} from "../fast-manim-snapshot-contract";
import {
  assertFastManimSnapshotIdentityAuthorityV1,
  parseVerifiedSourceRuntimeIdentityMapV1,
} from "../fast-manim-source-runtime-identity";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  parseSnapshotArtifactReceiptV1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotPublicationIdentityV1,
  type SnapshotPublicationRepositoryV1,
  type SnapshotPublicationV1,
  sameSnapshotArtifactContentV1,
  snapshotArtifactIdentityV1,
} from "./snapshot-publication-repository";

export const SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1 = "poietra.studio-snapshot-artifact" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_READ_ATTEMPTS = 3;
const DOCUMENT_FIELDS = [
  "expected",
  "profileDigest",
  "runtimeDigest",
  "schema",
  "snapshot",
  "sourceRuntimeIdentity",
  "version",
] as const;

export type SnapshotArtifactDocumentV2 = Readonly<{
  expected: ExpectedFastManimSnapshotCorrelationV1;
  profileDigest: string;
  runtimeDigest: string;
  schema: typeof SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1;
  snapshot: VerifiedCompiledFastManimSnapshotResultV1;
  sourceRuntimeIdentity: VerifiedSourceRuntimeIdentityMapV1 | null;
  version: 2;
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
      document: SnapshotArtifactDocumentV2;
      kind: "published";
      publication: SnapshotPublicationV1;
    }>;

function sha256(value: string, name: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function activeRuntimeDigest(value: string) {
  const runtimeDigest = sha256(value, "Snapshot runtime digest");
  if (runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
    throw new TypeError("The reserved legacy snapshot runtime digest is not active.");
  }
  return runtimeDigest;
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

function sameIdentity(left: SnapshotPublicationIdentityV1, right: SnapshotPublicationIdentityV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.runtimeConfigHash === right.runtimeConfigHash &&
    left.runtimeDigest === right.runtimeDigest &&
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
    expected.runtimeConfigHash !== identity.runtimeConfigHash ||
    expected.sourcePath !== identity.sourcePath ||
    expected.sceneName !== identity.sceneName
  ) {
    throw new TypeError("Snapshot correlation does not belong to the publication identity.");
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
    !sameSnapshotArtifactContentV1(publication.artifact, input.artifact) ||
    publication.sourceGeneration !== input.expectedSourceGeneration ||
    publication.requestId !== input.requestId ||
    publication.snapshotHash !== input.snapshotHash
  ) {
    throw new Error("The snapshot repository returned a publication for different content or correlation.");
  }
}

function canonicalBytes(document: SnapshotArtifactDocumentV2) {
  // Preserve the snapshot-contract V1 canonical form inside the V2 artifact:
  // snapshotVersion=1 was historically absent from the expected correlation.
  const { snapshotVersion, ...legacyExpected } = document.expected;
  const wireDocument = {
    ...document,
    expected: snapshotVersion === 1 ? legacyExpected : document.expected,
  };
  const bytes = Buffer.from(canonicalJsonV1(wireDocument), "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
    throw new RangeError("The canonical snapshot artifact exceeds 16 MiB.");
  }
  return bytes;
}

async function verifiedDocument(
  input: Readonly<{
    expected: ExpectedFastManimSnapshotCorrelationV1;
    profileDigest: string;
    runtimeDigest: string;
    snapshot: unknown;
    sourceRuntimeIdentity: unknown;
  }>,
): Promise<SnapshotArtifactDocumentV2> {
  const expected = expectedFastManimSnapshotCorrelationV1Schema.parse(input.expected);
  const profileDigest = sha256(input.profileDigest, "Snapshot profile digest");
  const runtimeDigest = activeRuntimeDigest(input.runtimeDigest);
  const snapshot = await parseVerifiedFastManimSnapshotResultV1(input.snapshot, expected);
  if (snapshot.kind !== "compiled") throw new TypeError("Only compiled snapshots can be published as artifacts.");
  const sourceRuntimeIdentity =
    input.sourceRuntimeIdentity === null
      ? null
      : parseVerifiedSourceRuntimeIdentityMapV1(input.sourceRuntimeIdentity, snapshot);
  assertFastManimSnapshotIdentityAuthorityV1(snapshot, sourceRuntimeIdentity);
  return {
    expected,
    profileDigest,
    runtimeDigest,
    schema: SNAPSHOT_ARTIFACT_DOCUMENT_SCHEMA_V1,
    snapshot,
    sourceRuntimeIdentity,
    version: 2,
  };
}

async function parseDocument(bytes: Uint8Array, publication: SnapshotPublicationV1) {
  const artifactIdentity = snapshotArtifactIdentityV1(publication.artifact);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
    throw new RangeError("The stored snapshot artifact is outside its 16 MiB bound.");
  }
  if (publication.artifact.byteSize !== bytes.byteLength || artifactIdentity.resultDigest !== digest(bytes)) {
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
    value.version !== 2
  ) {
    throw new TypeError("The stored snapshot artifact document is not strict v2.");
  }
  const document = await verifiedDocument({
    expected: value.expected as ExpectedFastManimSnapshotCorrelationV1,
    profileDigest: value.profileDigest as string,
    runtimeDigest: value.runtimeDigest as string,
    snapshot: value.snapshot,
    sourceRuntimeIdentity: value.sourceRuntimeIdentity,
  });
  if (!exactBytes(bytes, canonicalBytes(document))) {
    throw new TypeError("The stored snapshot artifact is not canonical UTF-8 JSON.");
  }
  assertExpectedIdentity(document.expected, publication);
  if (
    document.expected.requestId !== publication.requestId ||
    document.expected.sourceHash !== artifactIdentity.sourceDigest ||
    document.expected.runtimeConfigHash !== artifactIdentity.runtimeConfigHash ||
    document.profileDigest !== artifactIdentity.profileDigest ||
    document.runtimeDigest !== publication.runtimeDigest ||
    document.runtimeDigest !== artifactIdentity.runtimeDigest ||
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

  async softDeleteProject(tenantId: string, projectId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.#publications.softDeleteProject(tenantId, projectId, signal);
  }

  async publish(input: PublishSnapshotArtifactInputV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const identity: SnapshotPublicationIdentityV1 = {
      projectId: input.projectId,
      runtimeConfigHash: input.runtimeConfigHash,
      runtimeDigest: input.runtimeDigest,
      sceneName: input.sceneName,
      sourcePath: input.sourcePath,
      tenantId: input.tenantId,
    };
    const document = await verifiedDocument({
      expected: input.expected,
      profileDigest: input.profileDigest,
      runtimeDigest: input.runtimeDigest,
      snapshot: input.snapshot,
      sourceRuntimeIdentity: input.sourceRuntimeIdentity ?? null,
    });
    assertExpectedIdentity(document.expected, identity);
    const bytes = canonicalBytes(document);
    signal?.throwIfAborted();
    const artifact = parseSnapshotArtifactReceiptV1(
      identity.tenantId,
      await this.#artifacts.put(
        identity.tenantId,
        {
          bytes,
          profileDigest: document.profileDigest,
          runtimeConfigHash: document.expected.runtimeConfigHash,
          runtimeDigest: document.runtimeDigest,
          sourceDigest: document.expected.sourceHash,
        },
        signal,
      ),
    );
    const artifactIdentity = snapshotArtifactIdentityV1(artifact);
    if (
      artifact.byteSize !== bytes.byteLength ||
      artifactIdentity.profileDigest !== document.profileDigest ||
      artifactIdentity.resultDigest !== digest(bytes) ||
      artifactIdentity.runtimeConfigHash !== document.expected.runtimeConfigHash ||
      artifactIdentity.runtimeDigest !== document.runtimeDigest ||
      artifactIdentity.sourceDigest !== document.expected.sourceHash
    ) {
      throw new Error("The snapshot artifact store returned a receipt for different bytes or correlation.");
    }
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
    const expectedIdentity = {
      ...identity,
      runtimeConfigHash: sha256(identity.runtimeConfigHash, "Snapshot runtime-config hash"),
      runtimeDigest: activeRuntimeDigest(identity.runtimeDigest),
    };
    let lastGeneration = 0n;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const current = await this.#publications.readCurrent(expectedIdentity, signal);
      if (current.kind === "missing") return current;
      if (current.kind === "stale") {
        return { generation: current.generation, kind: "stale", reason: "source-stale" };
      }
      const { publication } = current;
      const artifactIdentity = snapshotArtifactIdentityV1(publication.artifact);
      if (
        !sameIdentity(publication, expectedIdentity) ||
        artifactIdentity.runtimeConfigHash !== expectedIdentity.runtimeConfigHash ||
        artifactIdentity.runtimeDigest !== expectedIdentity.runtimeDigest
      ) {
        throw new Error("The snapshot repository returned a publication for another runtime configuration or Scene.");
      }
      lastGeneration = publication.generation;
      let bytes: Uint8Array;
      try {
        bytes = await this.#artifacts.read(expectedIdentity.tenantId, publication.artifact, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof SnapshotArtifactReadErrorV1)) throw error;
        if (await this.#publications.clearHeadIfGeneration(expectedIdentity, publication.generation, signal)) {
          return {
            generation: publication.generation,
            kind: "stale",
            reason: error.code === "missing" ? "artifact-missing" : "artifact-corrupt",
          };
        }
        continue;
      }
      let document: SnapshotArtifactDocumentV2;
      try {
        document = await parseDocument(bytes, publication);
      } catch {
        signal?.throwIfAborted();
        if (await this.#publications.clearHeadIfGeneration(expectedIdentity, publication.generation, signal)) {
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
