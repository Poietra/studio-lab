import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { HttpError } from "./http/json";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type ManimSourceSnapshot = Readonly<{
  absolutePath: string;
  hash: string;
  source: string;
}>;

class SourceConflict extends Error {}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function privateSiblingPath(path: string, suffix: string) {
  return join(dirname(path), `.${basename(path)}.poietra-${randomUUID()}.${suffix}`);
}

async function removePrivateFile(path: string) {
  await rm(path, { force: true }).catch(() => undefined);
}

function isSameFileVersion(
  first: BigIntStats,
  second: BigIntStats,
) {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.mode === second.mode
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs;
}

async function inspectCurrentSource(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) return null;
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!isSameFileVersion(before, after) || contents.byteLength > MAX_SOURCE_BYTES) {
      return null;
    }
    return {
      hash: sourceHash(contents.toString("utf8")),
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
) {
  const candidatePath = privateSiblingPath(path, "tmp");
  let candidateExists = false;
  try {
    await writeFile(candidatePath, source, { encoding: "utf8", flag: "wx" });
    candidateExists = true;
    const current = await inspectCurrentSource(path).catch((error: unknown) => {
      if (isFileSystemError(error, "ELOOP") || isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (current?.hash !== expectedHash) throw new SourceConflict();

    await chmod(candidatePath, current.mode);
    const finalMetadata = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (
      !finalMetadata?.isFile()
      || finalMetadata.isSymbolicLink()
      || !isSameFileVersion(current.metadata, finalMetadata)
    ) {
      throw new SourceConflict();
    }

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
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  private async resolvePath(relativePath: string) {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
      throw new HttpError("The source path must be a relative Python file path.", 400);
    }
    const absolutePath = resolve(this.projectRoot, relativePath);
    const relativePathFromRoot = relative(this.projectRoot, absolutePath);
    if (
      relativePathFromRoot === ".."
      || relativePathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(relativePathFromRoot)
      || !absolutePath.endsWith(".py")
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
    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(this.projectRoot),
      realpath(absolutePath),
    ]);
    const canonicalRelativePath = relative(canonicalRoot, canonicalSource);
    if (canonicalRelativePath === ".." || canonicalRelativePath.startsWith(`..${sep}`) || isAbsolute(canonicalRelativePath)) {
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
    const source = await readFile(absolutePath, "utf8");
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      throw new HttpError("The selected Python source is too large to import safely.", 413);
    }
    return { absolutePath, hash: sourceHash(source), source };
  }

  async writeIfUnchanged(
    relativePath: string,
    expectedHash: string,
    source: string,
    conflictMessage: string,
  ) {
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      throw new HttpError("The rendered Python source is too large to commit safely.", 413);
    }
    const lockPath = await this.resolvePath(relativePath);
    await this.serializeWrite(lockPath, async () => {
      const currentPath = await this.resolvePath(relativePath);
      if (currentPath !== lockPath) throw new HttpError(conflictMessage, 409);
      await writeWithCompareAndSwap(currentPath, expectedHash, source, conflictMessage);
    });
  }
}

export function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
}
