import { createHash } from "node:crypto";

export const PROJECT_PNG_LOGICAL_PATH_V1 = "image.png";
export const MAX_PROJECT_PNG_BYTES_V1 = 512 * 1024;
export const MAX_PROJECT_PNG_DIMENSION_V1 = 2_048;
export const MAX_PROJECT_PNG_PIXELS_V1 = 4_194_304;

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export type ProjectPngBlobReceiptV1 = Readonly<{
  byteSize: number;
  digest: string;
  etag: string;
  objectKey: string;
  versionId: string;
}>;

export type ProjectPngHeadV1 = Readonly<{
  generation: bigint;
  projectId: string;
  receipt: ProjectPngBlobReceiptV1;
  tenantId: string;
}>;

export type ProjectPngVersionV1 = Readonly<{
  lastModified: Date;
  projectId: string;
  receipt: ProjectPngBlobReceiptV1;
}>;

export type ProjectPngDeletionV1 = Readonly<{
  deletionId: string;
  projectId: string;
  receipt: ProjectPngBlobReceiptV1;
  tenantId: string;
}>;

export type ProjectPngVersionCursorV1 = string;

export type ProjectPngVersionPageV1 = Readonly<{
  nextCursor: ProjectPngVersionCursorV1 | null;
  versions: readonly ProjectPngVersionV1[];
}>;

export interface ProjectPngRepositoryV1 {
  acknowledgeDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  compareAndSwapHead(
    input: Readonly<{
      candidate: ProjectPngBlobReceiptV1;
      expected: Readonly<{ digest: string; generation: bigint }> | null;
      projectId: string;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<ProjectPngHeadV1>;
  isVersionRetained(
    tenantId: string,
    projectId: string,
    receipt: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ): Promise<boolean>;
  pendingDeletions(tenantId: string, maximum: number, signal?: AbortSignal): Promise<readonly ProjectPngDeletionV1[]>;
  queueDeletion(
    tenantId: string,
    projectId: string,
    receipt: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ): Promise<ProjectPngDeletionV1 | null>;
  readHead(tenantId: string, projectId: string, signal?: AbortSignal): Promise<ProjectPngHeadV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export interface ProjectPngBlobStoreV1 {
  close(): Promise<void>;
  deleteVersion(
    tenantId: string,
    projectId: string,
    receipt: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ): Promise<void>;
  listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: ProjectPngVersionCursorV1 | null,
    signal?: AbortSignal,
  ): Promise<ProjectPngVersionPageV1>;
  put(tenantId: string, projectId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ProjectPngBlobReceiptV1>;
  read(
    tenantId: string,
    projectId: string,
    receipt: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export function projectPngObjectKeyV1(tenantId: string, projectId: string, digest: string) {
  return `tenants/${tenantId}/projects/${projectId}/assets/${PROJECT_PNG_LOGICAL_PATH_V1}/${digest}`;
}

export function assertProjectPngReceiptV1(tenantId: string, projectId: string, value: ProjectPngBlobReceiptV1) {
  if (
    !/^[0-9a-f]{64}$/.test(value.digest) ||
    value.objectKey !== projectPngObjectKeyV1(tenantId, projectId, value.digest) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_PROJECT_PNG_BYTES_V1 ||
    typeof value.versionId !== "string" ||
    value.versionId.length < 1 ||
    value.versionId.length > 1_024 ||
    typeof value.etag !== "string" ||
    value.etag.length < 1 ||
    value.etag.length > 512
  ) {
    throw new TypeError("Project image.png receipt is invalid.");
  }
  return value;
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! * 0x1_00_00_00 + bytes[offset + 1]! * 0x1_00_00 + bytes[offset + 2]! * 0x1_00 + bytes[offset + 3]!
  );
}

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function validPngColorType(bitDepth: number, colorType: number) {
  const depths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return depths[colorType]?.includes(bitDepth) === true;
}

/** Strictly validates the bounded static PNG accepted as a project's fixed image.png asset. */
export function inspectProjectPngBytesV1(value: Uint8Array) {
  const bytes = Uint8Array.from(value);
  if (bytes.byteLength > MAX_PROJECT_PNG_BYTES_V1) throw new RangeError("Project image.png exceeds 512 KiB.");
  if (bytes.byteLength < PNG_SIGNATURE.byteLength + 12) throw new TypeError("Project image.png is truncated.");
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError("Project image.png has an invalid PNG signature.");
  }

  let offset = PNG_SIGNATURE.byteLength;
  let chunkIndex = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  let width = 0;
  let height = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) throw new TypeError("Project image.png has a truncated chunk.");
    const length = readUint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (dataEnd < dataStart || crcOffset + 4 > bytes.byteLength) {
      throw new TypeError("Project image.png has an invalid chunk boundary.");
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2]! & 0x20) !== 0) {
      throw new TypeError("Project image.png has an invalid chunk type.");
    }
    if (readUint32(bytes, crcOffset) !== crc32(bytes, offset + 4, dataEnd)) {
      throw new TypeError(`Project image.png has an invalid ${type} CRC.`);
    }
    if (chunkIndex === 0 && type !== "IHDR") throw new TypeError("Project image.png must begin with IHDR.");
    if (type === "IHDR") {
      if (chunkIndex !== 0 || length !== 13) throw new TypeError("Project image.png has an invalid IHDR chunk.");
      width = readUint32(bytes, dataStart);
      height = readUint32(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_PROJECT_PNG_DIMENSION_V1 ||
        height > MAX_PROJECT_PNG_DIMENSION_V1 ||
        width * height > MAX_PROJECT_PNG_PIXELS_V1
      ) {
        throw new RangeError("Project image.png dimensions exceed 2048x2048 or 4,194,304 pixels.");
      }
      if (
        !validPngColorType(bitDepth, colorType) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
      ) {
        throw new TypeError("Project image.png has an unsupported IHDR encoding.");
      }
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new TypeError("Animated PNG is not supported for project image.png.");
    } else if (type === "IDAT") {
      if (endedIdat) throw new TypeError("Project image.png has non-consecutive IDAT chunks.");
      sawIdat = true;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || crcOffset + 4 !== bytes.byteLength) {
        throw new TypeError("Project image.png has an invalid IEND boundary.");
      }
      sawIend = true;
    }
    offset = crcOffset + 4;
    chunkIndex += 1;
  }
  if (!sawIend) throw new TypeError("Project image.png is missing IEND.");
  return {
    byteSize: bytes.byteLength,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    height,
    width,
  } as const;
}
