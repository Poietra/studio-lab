import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { immutableObjectKeyV1 } from "./immutable-object-contract";
import {
  type ApplicationImmutableObjectLocatorV1,
  isApplicationImmutableLocatorV1,
  type ProviderVersionedObjectLocatorV1,
  sameStorageObjectLocatorV1,
  storageObjectLocatorIdentityV1,
  storageObjectLocatorV1,
} from "./storage-object-locator";

export const PROJECT_PNG_LOGICAL_PATH_V1 = "image.png";
export const MAX_PROJECT_PNG_BYTES_V1 = 512 * 1024;
export const MAX_PROJECT_PNG_DIMENSION_V1 = 2_048;
export const MAX_PROJECT_PNG_PIXELS_V1 = 4_194_304;

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

type ProjectPngBlobReceiptFieldsV1 = Readonly<{
  byteSize: number;
  digest: string;
  etag: string;
  objectKey: string;
}>;

export type VersionedProjectPngBlobReceiptV1 = ProjectPngBlobReceiptFieldsV1 & ProviderVersionedObjectLocatorV1;
export type ImmutableProjectPngBlobReceiptLikeV1 = ProjectPngBlobReceiptFieldsV1 & ApplicationImmutableObjectLocatorV1;
export type ProjectPngBlobReceiptV1 = VersionedProjectPngBlobReceiptV1 | ImmutableProjectPngBlobReceiptLikeV1;

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
    graceMs: number,
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

export function assertProjectPngReceiptV1(
  tenantId: string,
  projectId: string,
  value: ProjectPngBlobReceiptV1,
): ProjectPngBlobReceiptV1 {
  let locator;
  try {
    locator = storageObjectLocatorV1(value);
  } catch {
    throw new TypeError("Project image.png receipt is invalid.");
  }
  const contentAddressedKey = projectPngObjectKeyV1(tenantId, projectId, value.digest);
  const expectedKey = isApplicationImmutableLocatorV1(locator)
    ? immutableObjectKeyV1({
        contentAddressedKey,
        contentDigest: value.digest,
        objectGeneration: locator.objectGeneration,
        tenantId,
      })
    : contentAddressedKey;
  if (
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    value.objectKey !== expectedKey ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_PROJECT_PNG_BYTES_V1 ||
    typeof value.etag !== "string" ||
    value.etag.length < 1 ||
    Buffer.byteLength(value.etag, "utf8") > 512
  ) {
    throw new TypeError("Project image.png receipt is invalid.");
  }
  const fields = {
    byteSize: value.byteSize,
    digest: value.digest,
    etag: value.etag,
    objectKey: expectedKey,
  };
  return isApplicationImmutableLocatorV1(locator)
    ? { ...fields, objectGeneration: locator.objectGeneration }
    : { ...fields, versionId: locator.versionId };
}

export function assertVersionedProjectPngReceiptV1(
  tenantId: string,
  projectId: string,
  value: ProjectPngBlobReceiptV1,
): VersionedProjectPngBlobReceiptV1 {
  const receipt = assertProjectPngReceiptV1(tenantId, projectId, value);
  if ("objectGeneration" in receipt) throw new TypeError("A provider-versioned project image.png receipt is required.");
  return receipt;
}

export function sameProjectPngReceiptV1(left: ProjectPngBlobReceiptV1, right: ProjectPngBlobReceiptV1) {
  return (
    left.byteSize === right.byteSize &&
    left.digest === right.digest &&
    left.etag === right.etag &&
    left.objectKey === right.objectKey &&
    sameStorageObjectLocatorV1(left, right)
  );
}

export function projectPngLocatorIdentityV1(value: ProjectPngBlobReceiptV1) {
  return storageObjectLocatorIdentityV1(value);
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

function pngBitsPerPixel(bitDepth: number, colorType: number) {
  const channels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const value = channels[colorType];
  if (!value) throw new TypeError("Project image.png has an unsupported color type.");
  return bitDepth * value;
}

function passExtent(size: number, start: number, step: number) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

type PngScanlineLayout = Readonly<{ rowBytes: number; rows: number }>;

function pngScanlineLayouts(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): readonly PngScanlineLayout[] {
  if (interlace === 0) return [{ rowBytes: Math.ceil((width * bitsPerPixel) / 8), rows: height }];
  const adam7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  return adam7.flatMap(([startX, startY, stepX, stepY]) => {
    const passWidth = passExtent(width, startX, stepX);
    const rows = passExtent(height, startY, stepY);
    return passWidth === 0 || rows === 0 ? [] : [{ rowBytes: Math.ceil((passWidth * bitsPerPixel) / 8), rows }];
  });
}

function validatePngScanlines(
  chunks: readonly Uint8Array[],
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
) {
  const layouts = pngScanlineLayouts(width, height, pngBitsPerPixel(bitDepth, colorType), interlace);
  const expectedBytes = layouts.reduce((total, layout) => total + layout.rows * (layout.rowBytes + 1), 0);
  const compressed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let inflated: Uint8Array;
  try {
    const result = inflateSync(compressed, { info: true, maxOutputLength: expectedBytes + 1 }) as unknown as Readonly<{
      buffer: Uint8Array;
      engine: Readonly<{ bytesWritten: number }>;
    }>;
    if (result.engine.bytesWritten !== compressed.byteLength) {
      throw new Error("The zlib stream has trailing compressed bytes.");
    }
    inflated = result.buffer;
  } catch (error) {
    throw new TypeError("Project image.png has invalid or overlong compressed pixel data.", { cause: error });
  }
  if (inflated.byteLength !== expectedBytes) {
    throw new TypeError("Project image.png has an invalid decompressed scanline length.");
  }
  let offset = 0;
  for (const layout of layouts) {
    for (let row = 0; row < layout.rows; row += 1) {
      if (inflated[offset]! > 4) throw new TypeError("Project image.png has an invalid scanline filter.");
      offset += layout.rowBytes + 1;
    }
  }
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
  let sawPlte = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];
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
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      interlace = bytes[dataStart + 12]!;
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
        (interlace !== 0 && interlace !== 1)
      ) {
        throw new TypeError("Project image.png has an unsupported IHDR encoding.");
      }
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new TypeError("Animated PNG is not supported for project image.png.");
    } else if (type === "PLTE") {
      const entries = length / 3;
      const maximumEntries = colorType === 3 ? 2 ** bitDepth : 256;
      if (
        sawPlte ||
        sawIdat ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        entries > maximumEntries
      ) {
        throw new TypeError("Project image.png has an invalid PLTE chunk.");
      }
      sawPlte = true;
    } else if (type === "IDAT") {
      if (endedIdat) throw new TypeError("Project image.png has non-consecutive IDAT chunks.");
      if (colorType === 3 && !sawPlte) throw new TypeError("Indexed project image.png requires PLTE before IDAT.");
      sawIdat = true;
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat || crcOffset + 4 !== bytes.byteLength) {
        throw new TypeError("Project image.png has an invalid IEND boundary.");
      }
      sawIend = true;
    } else {
      if ((typeBytes[0]! & 0x20) === 0) throw new TypeError(`Project image.png has an unknown critical ${type} chunk.`);
      if (sawIdat) endedIdat = true;
    }
    offset = crcOffset + 4;
    chunkIndex += 1;
  }
  if (!sawIend) throw new TypeError("Project image.png is missing IEND.");
  validatePngScanlines(idatChunks, width, height, bitDepth, colorType, interlace);
  return {
    byteSize: bytes.byteLength,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    height,
    width,
  } as const;
}
