import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
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

export type ManimSourceSnapshot = Readonly<{
  absolutePath: string;
  hash: string;
  source: string;
}>;

async function writeAtomically(path: string, source: string) {
  const metadata = await stat(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.poietra-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, source, "utf8");
    await chmod(temporaryPath, metadata.mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export class ManimSourceStore {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  private async resolvePath(relativePath: string) {
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
    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(this.projectRoot),
      realpath(absolutePath),
    ]);
    const canonicalRelativePath = relative(canonicalRoot, canonicalSource);
    if (canonicalRelativePath === ".." || canonicalRelativePath.startsWith(`..${sep}`) || isAbsolute(canonicalRelativePath)) {
      throw new HttpError("The selected Python source resolves outside the configured Manim project root.", 400);
    }
    return absolutePath;
  }

  async read(relativePath: string): Promise<ManimSourceSnapshot> {
    const absolutePath = await this.resolvePath(relativePath);
    const source = await readFile(absolutePath, "utf8");
    return { absolutePath, hash: sourceHash(source), source };
  }

  async writeIfUnchanged(
    relativePath: string,
    expectedHash: string,
    source: string,
    conflictMessage: string,
  ) {
    const current = await this.read(relativePath);
    if (current.hash !== expectedHash) throw new HttpError(conflictMessage, 409);
    await writeAtomically(current.absolutePath, source);
  }
}

export function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
}
