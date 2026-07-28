import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";

import type { FastManimRuncRootlessIdentityMapV1 } from "./fast-manim-runc-rootless-identity";

const LINUX_ID_SPACE = 0x1_0000_0000;

type ServiceIdentity = Readonly<{ gid: number; uid: number; username: string }>;
type SubordinateIdFiles = Readonly<{ subgid: string; subuid: string }>;
type IdRange = Readonly<{ end: number; start: number }>;

function parseRanges(contents: string, username: string, uid: number, path: string) {
  const owners = new Set([username, String(uid)]);
  const ranges: IdRange[] = [];
  for (const [index, source] of contents.split(/\r?\n/u).entries()) {
    const line = source.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(":");
    if (!owners.has(fields[0] ?? "")) continue;
    const start = Number(fields[1]);
    const size = Number(fields[2]);
    if (
      fields.length !== 3 ||
      !/^\d+$/u.test(fields[1] ?? "") ||
      !/^\d+$/u.test(fields[2] ?? "") ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start < 0 ||
      size < 1 ||
      start + size > LINUX_ID_SPACE
    ) {
      throw new Error(`The service ${path} entry on line ${index + 1} is malformed.`);
    }
    ranges.push({ end: start + size, start });
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  return ranges.reduce<IdRange[]>((merged, range) => {
    const previous = merged.at(-1);
    if (!previous || previous.end < range.start) merged.push(range);
    else if (range.end > previous.end) merged[merged.length - 1] = { end: range.end, start: previous.start };
    return merged;
  }, []);
}

function assertMappingsCovered(
  mappings: readonly Readonly<{ hostID: number; size: number }>[],
  self: number,
  ranges: readonly IdRange[],
  label: string,
  path: string,
) {
  const covered = (start: number, end: number) =>
    start === end || ranges.some((range) => range.start <= start && end <= range.end);
  for (const mapping of mappings) {
    const end = mapping.hostID + mapping.size;
    if (self < mapping.hostID || self >= end) {
      if (!covered(mapping.hostID, end)) throw new Error(`The configured ${label} mappings exceed ${path}.`);
      continue;
    }
    if (!covered(mapping.hostID, self) || !covered(self + 1, end)) {
      throw new Error(`The configured ${label} mappings exceed ${path}.`);
    }
  }
}

export function assertFastManimRuncSubordinateIdCoverageV1(
  identityMap: FastManimRuncRootlessIdentityMapV1,
  identity: ServiceIdentity,
  files: SubordinateIdFiles,
) {
  const mappings = identityMap.ociMappings();
  assertMappingsCovered(
    mappings.uidMappings,
    identity.uid,
    parseRanges(files.subuid, identity.username, identity.uid, "/etc/subuid"),
    "UID",
    "/etc/subuid",
  );
  assertMappingsCovered(
    mappings.gidMappings,
    identity.gid,
    parseRanges(files.subgid, identity.username, identity.uid, "/etc/subgid"),
    "GID",
    "/etc/subgid",
  );
}

export async function assertFastManimRuncSubordinateIdsReadyV1(
  identityMap: FastManimRuncRootlessIdentityMapV1,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const account = userInfo();
  if (uid === undefined || gid === undefined || account.uid !== uid) {
    throw new Error("The service identity cannot be resolved for subordinate-ID verification.");
  }
  const [subuid, subgid] = await Promise.all([
    readFile("/etc/subuid", { encoding: "utf8", signal }),
    readFile("/etc/subgid", { encoding: "utf8", signal }),
  ]);
  signal.throwIfAborted();
  assertFastManimRuncSubordinateIdCoverageV1(identityMap, { gid, uid, username: account.username }, { subgid, subuid });
}
