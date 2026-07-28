import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { z } from "zod";

const MAX_CONFIG_BYTES = 64 * 1024;

async function assertRootOwnedConfigAncestors(path: string) {
  let current = dirname(path);
  while (true) {
    const [directory, canonical] = await Promise.all([open(current, constants.O_RDONLY), realpath(current)]);
    try {
      const metadata = await directory.stat();
      if (canonical !== current || !metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
        throw new TypeError("The production config ancestor is not immutable root-owned material.");
      }
    } finally {
      await directory.close();
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function readRootOwnedProductionConfigV1<T>(path: string, schema: z.ZodType<T>) {
  if (!path.startsWith("/") || resolve(path) !== path || path.includes("\0") || Buffer.byteLength(path) > 4_096) {
    throw new TypeError("The production config path must be canonical and absolute.");
  }
  await assertRootOwnedConfigAncestors(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [metadata, canonical] = await Promise.all([file.stat(), realpath(path)]);
    if (
      canonical !== path ||
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o222) !== 0 ||
      metadata.size <= 0 ||
      metadata.size > MAX_CONFIG_BYTES
    ) {
      throw new TypeError("The production config is not immutable bounded root-owned material.");
    }
    return schema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}
