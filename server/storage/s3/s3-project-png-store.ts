import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  assertVersionedProjectPngReceiptV1,
  inspectProjectPngBytesV1,
  MAX_PROJECT_PNG_BYTES_V1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngVersionCursorV1,
  type ProjectPngVersionV1,
  projectPngObjectKeyV1,
  type VersionedProjectPngBlobReceiptV1,
} from "../project-png-storage";
import {
  acquirePrivateVersionedS3BucketTransportV1,
  type PrivateVersionedS3BucketConsumerOptionsV1,
  type PrivateVersionedS3BucketOperationV1,
  type PrivateVersionedS3BucketTransportLeaseV1,
} from "./s3-private-versioned-bucket-transport";

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

function projectId(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Project ID is invalid.");
  return parsed.data;
}

function normalizeEtag(value: string | undefined) {
  if (!value || value.length > 512) throw new Error("S3 did not return a bounded image.png ETag.");
  return value;
}

function isPreconditionFailed(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "PreconditionFailed" ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 412))
  );
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

async function boundedBody(body: unknown, signal: AbortSignal) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    throw new Error("S3 returned an unreadable image.png body.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      signal.throwIfAborted();
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) throw new Error("S3 returned an invalid image.png chunk.");
      size += chunk.byteLength;
      if (size > MAX_PROJECT_PNG_BYTES_V1) throw new RangeError("The S3 image.png object exceeds 512 KiB.");
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error) {
    destroyBody(body);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cursor(
  value: ProjectPngVersionCursorV1 | null | undefined,
  prefix: string,
): Readonly<{ keyMarker?: string; versionIdMarker?: string }> {
  if (value === null || value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("The project image.png version cursor is invalid.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    !parsed[0].startsWith(prefix) ||
    parsed[0].length > 1_024 ||
    typeof parsed[1] !== "string" ||
    parsed[1].length < 1 ||
    parsed[1].length > 1_024
  ) {
    throw new TypeError("The project image.png version cursor is invalid.");
  }
  return { keyMarker: parsed[0], versionIdMarker: parsed[1] };
}

function encodeCursor(key: string, version: string, prefix: string) {
  const encoded = Buffer.from(JSON.stringify([key, version]), "utf8").toString("base64url");
  cursor(encoded, prefix);
  return encoded;
}

function listedIdentity(tenant: string, key: string) {
  const prefix = `tenants/${tenant}/projects/`;
  if (!key.startsWith(prefix)) throw new Error("S3 returned an image.png object outside the tenant prefix.");
  const parts = key.slice(prefix.length).split("/");
  if (parts.length !== 4 || parts[1] !== "assets" || parts[2] !== "image.png") {
    throw new Error("S3 returned an invalid project image.png object key.");
  }
  const project = projectId(parts[0]!);
  const digest = parts[3]!;
  if (!/^[0-9a-f]{64}$/.test(digest) || key !== projectPngObjectKeyV1(tenant, project, digest)) {
    throw new Error("S3 returned an invalid project image.png digest key.");
  }
  return { digest, project };
}

export type S3ProjectPngStoreOptionsV1 = PrivateVersionedS3BucketConsumerOptionsV1;

/** Private, version-pinned storage for the single bounded image.png asset of each project. */
export class S3ProjectPngStoreV1 implements ProjectPngBlobStoreV1 {
  readonly #transport: PrivateVersionedS3BucketTransportLeaseV1;

  constructor(options: S3ProjectPngStoreOptionsV1) {
    this.#transport = acquirePrivateVersionedS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #readBytes(
    tenant: string,
    project: string,
    value: ProjectPngBlobReceiptV1,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const receipt = assertVersionedProjectPngReceiptV1(tenant, project, value);
    const response = await operation.getObject({ Key: receipt.objectKey, VersionId: receipt.versionId });
    try {
      if (
        response.VersionId !== receipt.versionId ||
        response.ContentLength !== receipt.byteSize ||
        normalizeEtag(response.ETag) !== receipt.etag
      ) {
        throw new Error("The versioned S3 image.png metadata does not match its receipt.");
      }
    } catch (error) {
      destroyBody(response.Body);
      throw error;
    }
    const inspected = inspectProjectPngBytesV1(await boundedBody(response.Body, operation.signal));
    if (inspected.byteSize !== receipt.byteSize || inspected.digest !== receipt.digest) {
      throw new Error("The versioned S3 image.png bytes do not match their receipt.");
    }
    return inspected.bytes;
  }

  async #currentReceipt(
    tenant: string,
    project: string,
    inspected: ReturnType<typeof inspectProjectPngBytesV1>,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const objectKey = projectPngObjectKeyV1(tenant, project, inspected.digest);
    const response = await operation.getObject({ Key: objectKey });
    let receipt: VersionedProjectPngBlobReceiptV1;
    try {
      receipt = assertVersionedProjectPngReceiptV1(tenant, project, {
        byteSize: inspected.byteSize,
        digest: inspected.digest,
        etag: normalizeEtag(response.ETag),
        objectKey,
        versionId: response.VersionId ?? "",
      });
      if (response.ContentLength !== inspected.byteSize) {
        throw new Error("The current S3 image.png size is invalid.");
      }
    } catch (error) {
      destroyBody(response.Body);
      throw error;
    }
    const current = inspectProjectPngBytesV1(await boundedBody(response.Body, operation.signal));
    if (current.digest !== inspected.digest) throw new Error("The current S3 image.png digest is invalid.");
    return receipt;
  }

  async put(tenantValue: string, projectValue: string, bytes: Uint8Array, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const inspected = inspectProjectPngBytesV1(bytes);
    const objectKey = projectPngObjectKeyV1(tenant, project, inspected.digest);
    const operation = this.#transport.operation(signal);
    let response;
    try {
      response = await operation.putObject({
        Body: inspected.bytes,
        ChecksumSHA256: Buffer.from(inspected.digest, "hex").toString("base64"),
        ContentLength: inspected.byteSize,
        ContentType: "image/png",
        IfNoneMatch: "*",
        Key: objectKey,
      });
    } catch (error) {
      if (isPreconditionFailed(error)) return this.#currentReceipt(tenant, project, inspected, operation);
      throw error;
    }
    const receipt = assertVersionedProjectPngReceiptV1(tenant, project, {
      byteSize: inspected.byteSize,
      digest: inspected.digest,
      etag: normalizeEtag(response.ETag),
      objectKey,
      versionId: response.VersionId ?? "",
    });
    await this.#readBytes(tenant, project, receipt, operation);
    return receipt;
  }

  async read(tenantValue: string, projectValue: string, receipt: ProjectPngBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    return this.#readBytes(tenant, project, receipt, this.#transport.operation(signal));
  }

  async listVersions(
    tenantValue: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: ProjectPngVersionCursorV1 | null,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new RangeError("maximum must be an integer between 1 and 256.");
    }
    const prefix = `tenants/${tenant}/projects/`;
    const parsed = cursor(cursorValue, prefix);
    const operation = this.#transport.operation(signal);
    const page = await operation.listObjectVersionsPage({
      KeyMarker: parsed.keyMarker,
      MaxKeys: maximum,
      Prefix: prefix,
      VersionIdMarker: parsed.versionIdMarker,
    });
    const versions: ProjectPngVersionV1[] = [];
    for (const version of page.Versions ?? []) {
      const key = version.Key ?? "";
      const identity = listedIdentity(tenant, key);
      if (
        !version.VersionId ||
        !version.ETag ||
        !Number.isSafeInteger(version.Size) ||
        version.Size! < 1 ||
        version.Size! > MAX_PROJECT_PNG_BYTES_V1 ||
        !(version.LastModified instanceof Date)
      ) {
        throw new Error("S3 returned invalid image.png version metadata.");
      }
      if (version.LastModified >= cutoff) continue;
      versions.push({
        lastModified: version.LastModified,
        projectId: identity.project,
        receipt: assertVersionedProjectPngReceiptV1(tenant, identity.project, {
          byteSize: version.Size!,
          digest: identity.digest,
          etag: version.ETag,
          objectKey: key,
          versionId: version.VersionId,
        }),
      });
    }
    return {
      nextCursor: page.IsTruncated ? encodeCursor(page.NextKeyMarker!, page.NextVersionIdMarker!, prefix) : null,
      versions,
    };
  }

  async deleteVersion(tenantValue: string, projectValue: string, value: ProjectPngBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const receipt = assertVersionedProjectPngReceiptV1(tenant, project, value);
    const operation = this.#transport.operation(signal);
    await operation.deleteObjectVersion({ Key: receipt.objectKey, VersionId: receipt.versionId });
    operation.signal.throwIfAborted();
  }

  close() {
    return this.#transport.close();
  }
}
