import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import type { FastManimSnapshotPngProviderV1 } from "./fast-manim-snapshot-png-provider";
import { HttpError } from "./http/json";
import { manimTenantIdSchema } from "./manim-request-principal";
import {
  assertProjectPngReceiptV1,
  inspectProjectPngBytesV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
} from "./storage/project-png-storage";

const MAX_PROJECT_PNG_GENERATION_V1 = 9_223_372_036_854_775_807n;
const MAX_DURABLE_PNG_VERSION_TOKEN_UTF8_BYTES_V1 = 128;

type DurableProjectPngHeadV1 = Readonly<{
  generation: bigint;
  receipt: ProjectPngBlobReceiptV1;
}>;

function pinProjectPngHeadV1(value: ProjectPngHeadV1, tenantId: string, projectId: string): DurableProjectPngHeadV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    value.tenantId !== tenantId ||
    value.projectId !== projectId ||
    typeof value.generation !== "bigint" ||
    value.generation < 1n ||
    value.generation > MAX_PROJECT_PNG_GENERATION_V1
  ) {
    throw new TypeError("The durable project image.png head is invalid.");
  }
  return {
    generation: value.generation,
    receipt: { ...assertProjectPngReceiptV1(tenantId, projectId, value.receipt) },
  };
}

function projectPngVersionTokenV1(generation: bigint, digest: string) {
  const token = `${generation}:${digest}`;
  if (Buffer.byteLength(token, "utf8") > MAX_DURABLE_PNG_VERSION_TOKEN_UTF8_BYTES_V1) {
    throw new TypeError("The durable project image.png version token is invalid.");
  }
  return token;
}

export type DurableFastManimSnapshotPngProviderOptionsV1 = Readonly<{
  blobs: Pick<ProjectPngBlobStoreV1, "read">;
  projectId: string;
  repository: Pick<ProjectPngRepositoryV1, "readHead">;
  tenantId: string;
}>;

/** Reads and independently verifies one exact durable image.png generation. */
export class DurableFastManimSnapshotPngProviderV1 implements FastManimSnapshotPngProviderV1 {
  readonly #blobs: Pick<ProjectPngBlobStoreV1, "read">;
  readonly #projectId: string;
  readonly #repository: Pick<ProjectPngRepositoryV1, "readHead">;
  readonly #tenantId: string;

  constructor(options: DurableFastManimSnapshotPngProviderOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    const project = manimProjectIdSchema.safeParse(options.projectId);
    if (!tenant.success || !project.success) throw new TypeError("Durable snapshot PNG identity is invalid.");
    this.#blobs = options.blobs;
    this.#projectId = project.data;
    this.#repository = options.repository;
    this.#tenantId = tenant.data;
  }

  async readVerified(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const value = await this.#repository.readHead(this.#tenantId, this.#projectId, signal);
    signal?.throwIfAborted();
    if (value === null) throw new HttpError("Project image.png not found.", 404);
    const head = pinProjectPngHeadV1(value, this.#tenantId, this.#projectId);
    const expectedByteSize = head.receipt.byteSize;
    const expectedDigest = head.receipt.digest;
    const versionToken = projectPngVersionTokenV1(head.generation, expectedDigest);
    const bytes = await this.#blobs.read(this.#tenantId, this.#projectId, head.receipt, signal);
    signal?.throwIfAborted();
    const inspected = inspectProjectPngBytesV1(bytes);
    signal?.throwIfAborted();
    if (inspected.byteSize !== expectedByteSize || inspected.digest !== expectedDigest) {
      throw new Error("The durable project image.png bytes do not match their pinned receipt.");
    }
    return { bytes: inspected.bytes, versionToken };
  }
}
