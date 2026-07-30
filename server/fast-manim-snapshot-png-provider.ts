import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { HttpError } from "./http/json";
import { inspectProjectPngBytesV1, MAX_PROJECT_PNG_BYTES_V1 } from "./storage/project-png-storage";

const MAX_PNG_VERSION_TOKEN_UTF8_BYTES_V1 = 2_048;

async function readBoundedProjectPng(handle: FileHandle) {
  const buffer = Buffer.allocUnsafe(MAX_PROJECT_PNG_BYTES_V1 + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_PROJECT_PNG_BYTES_V1) throw new RangeError("Project image.png exceeds 512 KiB.");
  return buffer.subarray(0, offset);
}

export type FastManimSnapshotPngCandidateV1 = Readonly<{
  bytes: Uint8Array;
  versionToken: string;
}>;

export type FastManimSnapshotPngReadV1 = Readonly<{
  byteSize: number;
  bytes: Uint8Array;
  digest: string;
  height: number;
  versionToken: string;
  width: number;
}>;

export interface FastManimSnapshotPngProviderV1 {
  readVerified(signal?: AbortSignal): Promise<FastManimSnapshotPngCandidateV1>;
}

/** Fixed-path local adapter for the explicitly trusted Vite/Electron project root. */
export class FileSystemFastManimSnapshotPngProviderV1 implements FastManimSnapshotPngProviderV1 {
  readonly #absolutePath: string;

  constructor(projectRoot: string) {
    this.#absolutePath = join(resolve(projectRoot), "image.png");
  }

  async readVerified(signal?: AbortSignal): Promise<FastManimSnapshotPngCandidateV1> {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await open(this.#absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new HttpError("Project image.png not found.", 404);
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_PROJECT_PNG_BYTES_V1)) {
        throw new TypeError("Project image.png is not a bounded regular file.");
      }
      signal?.throwIfAborted();
      const inspected = inspectProjectPngBytesV1(await readBoundedProjectPng(handle));
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new HttpError("Project image.png changed while it was read.", 409);
      }
      return {
        bytes: inspected.bytes,
        versionToken: `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}:${inspected.digest}`,
      };
    } finally {
      await handle.close();
    }
  }
}

/** Revalidates provider bytes locally and owns the exact immutable run input. */
export async function readFastManimSnapshotPngV1(
  provider: FastManimSnapshotPngProviderV1,
  signal?: AbortSignal,
): Promise<FastManimSnapshotPngReadV1> {
  signal?.throwIfAborted();
  const candidate = await provider.readVerified(signal);
  signal?.throwIfAborted();
  if (
    typeof candidate.versionToken !== "string" ||
    candidate.versionToken.length < 1 ||
    Buffer.byteLength(candidate.versionToken, "utf8") > MAX_PNG_VERSION_TOKEN_UTF8_BYTES_V1
  ) {
    throw new TypeError("The verified project image.png version token is invalid.");
  }
  const inspected = inspectProjectPngBytesV1(candidate.bytes);
  return { ...inspected, versionToken: candidate.versionToken };
}

export function sameFastManimSnapshotPngReadV1(left: FastManimSnapshotPngReadV1, right: FastManimSnapshotPngReadV1) {
  return (
    left.versionToken === right.versionToken &&
    left.byteSize === right.byteSize &&
    left.digest === right.digest &&
    left.height === right.height &&
    left.width === right.width
  );
}
