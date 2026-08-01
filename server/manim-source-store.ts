import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, open, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { HttpError } from "./http/json";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const VERIFIED_READ_CHUNK_BYTES = 64 * 1024;

export type ManimSourceSnapshot = Readonly<{
  absolutePath: string;
  hash: string;
  source: string;
}>;

/** Test seam: deterministically interleave with the validate/open/read steps. */
export type ManimSourceReadHooks = Readonly<{
  afterChunk?: (absolutePath: string, chunkIndex: number) => Promise<void> | void;
  afterOpen?: (absolutePath: string) => Promise<void> | void;
  beforeOpen?: (absolutePath: string) => Promise<void> | void;
  beforeWriteCommit?: (absolutePath: string) => Promise<void> | void;
}>;

class SourceConflict extends Error {}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Exact UTF-8 decode. Buffer.toString("utf8") silently replaces invalid bytes
 * with U+FFFD, so distinct byte sequences could collapse to the same
 * sourceHash and a raw file near the byte cap could expand past it once
 * re-encoded (each replacement is three bytes), later throwing an uncaught
 * producer-request validation error. A fatal decode rejects invalid input up
 * front as a sanitized 400 instead. Non-UTF-8 / PEP 263 alternate-encoding
 * source is deliberately outside the v1 snapshot profile.
 */
function decodeExactUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HttpError("The selected Python source must be valid UTF-8 text.", 400);
  }
}

function privateSiblingPath(path: string, suffix: string) {
  return join(dirname(path), `.${basename(path)}.poietra-${randomUUID()}.${suffix}`);
}

async function removePrivateFile(path: string) {
  await rm(path, { force: true }).catch(() => undefined);
}

function isSameFileVersion(first: BigIntStats, second: BigIntStats) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function inspectCurrentSource(path: string) {
  // O_NONBLOCK: a FIFO swapped in place of the source must fail the type
  // check below instead of blocking the CAS write path until a writer appears.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) return null;
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!isSameFileVersion(before, after) || contents.byteLength > MAX_SOURCE_BYTES) {
      return null;
    }
    return {
      hash: sourceHash(decodeExactUtf8(contents)),
      metadata: after,
      mode: Number(after.mode),
    };
  } finally {
    await handle.close();
  }
}

async function writeWithCompareAndSwap(
  path: string,
  expectedHash: string,
  source: string,
  conflictMessage: string,
  signal?: AbortSignal,
  beforeCommit?: (absolutePath: string) => Promise<void> | void,
) {
  const candidatePath = privateSiblingPath(path, "tmp");
  let candidateExists = false;
  try {
    signal?.throwIfAborted();
    await writeFile(candidatePath, source, { encoding: "utf8", flag: "wx" });
    candidateExists = true;
    signal?.throwIfAborted();
    const current = await inspectCurrentSource(path).catch((error: unknown) => {
      if (isFileSystemError(error, "ELOOP") || isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (current?.hash !== expectedHash) throw new SourceConflict();

    signal?.throwIfAborted();
    await chmod(candidatePath, current.mode);
    await beforeCommit?.(path);
    signal?.throwIfAborted();
    const finalMetadata = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (
      !finalMetadata?.isFile() ||
      finalMetadata.isSymbolicLink() ||
      !isSameFileVersion(current.metadata, finalMetadata)
    ) {
      throw new SourceConflict();
    }

    signal?.throwIfAborted();
    await rename(candidatePath, path);
    candidateExists = false;
  } catch (error) {
    if (error instanceof SourceConflict) throw new HttpError(conflictMessage, 409);
    throw error;
  } finally {
    if (candidateExists) await removePrivateFile(candidatePath);
  }
}

export class ManimSourceStore {
  readonly projectRoot: string;
  private readonly hooks: ManimSourceReadHooks;
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(projectRoot: string, hooks: ManimSourceReadHooks = {}) {
    this.hooks = hooks;
    this.projectRoot = resolve(projectRoot);
  }

  /**
   * Verified reads require an OS surface that can prove which inode an opened
   * descriptor refers to (procfs on Linux). Platforms without it must fail
   * closed on paths that execute workspace Python from the read bytes.
   */
  static get supportsVerifiedRead() {
    return process.platform === "linux";
  }

  private async resolvePath(relativePath: string) {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
      throw new HttpError("The source path must be a relative Python file path.", 400);
    }
    const absolutePath = resolve(this.projectRoot, relativePath);
    const relativePathFromRoot = relative(this.projectRoot, absolutePath);
    if (
      relativePathFromRoot === ".." ||
      relativePathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativePathFromRoot) ||
      !absolutePath.endsWith(".py")
    ) {
      throw new HttpError("The source file must be a Python file inside the configured Manim project root.", 400);
    }
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      throw new HttpError("The selected Python source does not exist.", 404);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new HttpError("The selected Python source must be a regular file, not a symbolic link.", 400);
    }
    if (metadata.size > MAX_SOURCE_BYTES) {
      throw new HttpError("The selected Python source is too large to import safely.", 413);
    }
    const [canonicalRoot, canonicalSource] = await Promise.all([realpath(this.projectRoot), realpath(absolutePath)]);
    const canonicalRelativePath = relative(canonicalRoot, canonicalSource);
    if (
      canonicalRelativePath === ".." ||
      canonicalRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelativePath)
    ) {
      throw new HttpError("The selected Python source resolves outside the configured Manim project root.", 400);
    }
    return canonicalSource;
  }

  private async serializeWrite<T>(path: string, write: () => Promise<T>) {
    const previous = this.pendingWrites.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveWrite) => {
      release = resolveWrite;
    });
    const pending = previous.catch(() => undefined).then(() => current);
    this.pendingWrites.set(path, pending);
    await previous.catch(() => undefined);
    try {
      return await write();
    } finally {
      release();
      if (this.pendingWrites.get(path) === pending) this.pendingWrites.delete(path);
    }
  }

  async read(relativePath: string): Promise<ManimSourceSnapshot> {
    const absolutePath = await this.resolvePath(relativePath);
    // Read raw bytes and cap them before any decode: the byte budget is the
    // authority, and the bytes are then decoded exactly (fatal UTF-8).
    const contents = await readFile(absolutePath);
    if (contents.byteLength > MAX_SOURCE_BYTES) {
      throw new HttpError("The selected Python source is too large to import safely.", 413);
    }
    const source = decodeExactUtf8(contents);
    return { absolutePath, hash: sourceHash(source), source };
  }

  /**
   * TOCTOU-hardened read for callers that execute the returned bytes (the
   * fast-manim snapshot producer). The opened descriptor is the single
   * authority: the path is opened with O_NOFOLLOW and O_NONBLOCK (so a FIFO
   * swap cannot block the open), the type and size come
   * from fstat on that handle, the bytes are read incrementally from the same
   * handle under a hard cap that does not trust the advertised size, and the
   * descriptor's canonical target (via /proc/self/fd) must still resolve
   * inside the canonical project root before the bytes become sourceText.
   * A pathname swapped to a symlink, an outside file, or an oversized file
   * between validation and open — or renamed away after open — is rejected.
   */
  async readVerified(relativePath: string): Promise<ManimSourceSnapshot> {
    if (!ManimSourceStore.supportsVerifiedRead) {
      throw new HttpError("Verified Python source reads are not supported on this platform.", 501);
    }
    const validatedPath = await this.resolvePath(relativePath);
    await this.hooks.beforeOpen?.(validatedPath);
    let handle;
    try {
      // O_NONBLOCK is a no-op for regular files but makes opening a FIFO
      // return immediately instead of blocking until a writer appears: a
      // pathname swapped to a FIFO between validation and open must reach the
      // fstat type check below (which rejects non-regular files) rather than
      // hang the request past every admission and timeout control.
      handle = await open(
        validatedPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (isFileSystemError(error, "ELOOP")) {
        throw new HttpError("The selected Python source must be a regular file, not a symbolic link.", 400);
      }
      if (isFileSystemError(error, "ENOENT")) {
        throw new HttpError("The selected Python source does not exist.", 404);
      }
      throw error;
    }
    try {
      await this.hooks.afterOpen?.(validatedPath);
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) {
        throw new HttpError("The selected Python source must be a regular file, not a symbolic link.", 400);
      }
      if (metadata.size > BigInt(MAX_SOURCE_BYTES)) {
        throw new HttpError("The selected Python source is too large to import safely.", 413);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let chunkIndex = 0;
      const chunk = Buffer.alloc(VERIFIED_READ_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_SOURCE_BYTES) {
          throw new HttpError("The selected Python source is too large to import safely.", 413);
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        await this.hooks.afterChunk?.(validatedPath, chunkIndex);
        chunkIndex += 1;
      }
      // Detect in-place rewrites and torn reads across the multi-chunk read:
      // the file version (dev/ino/mode/size/mtimeNs/ctimeNs) observed by the
      // handle must be identical before and after reading, even when the
      // rewrite preserved the byte length. A mismatch fails as a conflict
      // before the bytes can ever reach Python.
      const readConflict = () => new HttpError("The selected Python source changed while it was being read.", 409);
      const finalMetadata = await handle.stat({ bigint: true });
      if (!isSameFileVersion(metadata, finalMetadata)) throw readConflict();
      // Timestamp granularity alone cannot prove a same-length rewrite did
      // not tear the first pass, so the same descriptor is read a second time
      // with positioned reads and every byte must match the first assembly.
      const contents = Buffer.concat(chunks, total);
      let verifiedOffset = 0;
      while (verifiedOffset < total) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, verifiedOffset);
        if (bytesRead === 0) throw readConflict();
        if (!chunk.subarray(0, bytesRead).equals(contents.subarray(verifiedOffset, verifiedOffset + bytesRead))) {
          throw readConflict();
        }
        verifiedOffset += bytesRead;
      }
      const { bytesRead: trailingBytes } = await handle.read(chunk, 0, 1, total);
      if (trailingBytes !== 0) throw readConflict();
      // Exact fatal UTF-8 decode of the proven-stable bytes: invalid input is
      // a sanitized 400 before it can ever collide a sourceHash or expand a
      // near-cap file past the producer request budget. Done before the
      // containment resolution below so the bytes never reach Python either.
      const source = decodeExactUtf8(contents);
      const outsideRoot = () =>
        new HttpError("The selected Python source resolves outside the configured Manim project root.", 400);
      // The raw /proc link target is checked first: the kernel appends
      // " (deleted)" for unlinked inodes, and an attacker could pre-create a
      // decoy file of exactly that name inside the root so a naive realpath
      // would still resolve. Non-path targets (pipes, anonymous inodes) and
      // deleted targets fail closed before any resolution happens.
      const descriptorLink = `/proc/self/fd/${handle.fd}`;
      const linkTarget = await readlink(descriptorLink).catch(() => null);
      if (linkTarget === null || !linkTarget.startsWith("/") || linkTarget.endsWith(" (deleted)")) {
        throw outsideRoot();
      }
      const canonicalRoot = await realpath(this.projectRoot);
      const descriptorTarget = await realpath(descriptorLink).catch(() => null);
      if (descriptorTarget === null) throw outsideRoot();
      const relativeTarget = relative(canonicalRoot, descriptorTarget);
      if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        throw outsideRoot();
      }
      // The resolved path must be the very inode this handle reads from — a
      // decoy at the resolved name must not vouch for orphaned bytes.
      const targetMetadata = await stat(descriptorTarget, { bigint: true }).catch(() => null);
      if (
        targetMetadata === null ||
        targetMetadata.dev !== finalMetadata.dev ||
        targetMetadata.ino !== finalMetadata.ino
      ) {
        throw outsideRoot();
      }
      return { absolutePath: descriptorTarget, hash: sourceHash(source), source };
    } finally {
      await handle.close();
    }
  }

  async writeIfUnchanged(
    relativePath: string,
    expectedHash: string,
    source: string,
    conflictMessage: string,
    signal?: AbortSignal,
  ) {
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      throw new HttpError("The rendered Python source is too large to commit safely.", 413);
    }
    signal?.throwIfAborted();
    const lockPath = await this.resolvePath(relativePath);
    await this.serializeWrite(lockPath, async () => {
      signal?.throwIfAborted();
      const currentPath = await this.resolvePath(relativePath);
      if (currentPath !== lockPath) throw new HttpError(conflictMessage, 409);
      await writeWithCompareAndSwap(
        currentPath,
        expectedHash,
        source,
        conflictMessage,
        signal,
        this.hooks.beforeWriteCommit,
      );
    });
  }
}

export function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
}
