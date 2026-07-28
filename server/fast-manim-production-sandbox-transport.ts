import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const FAST_MANIM_PRODUCTION_BROKER_CLOSE_TIMEOUT_MS_V1 = 30_000;
const MAX_PRODUCTION_BROKER_SOCKET_PATH_BYTES = 96;

function productionUserId(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new TypeError(`${label} must be a positive unsigned 32-bit integer.`);
  }
  return value;
}

function productionGroupId(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError("The Studio group ID must be an unsigned 32-bit integer.");
  }
  return value;
}

function canonicalProductionBrokerSocketPath(socketPath: string) {
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath, "utf8") > MAX_PRODUCTION_BROKER_SOCKET_PATH_BYTES
  ) {
    throw new TypeError("The production broker socket path must be bounded, canonical, and absolute.");
  }
  return socketPath;
}

async function assertProductionBrokerSocketAncestors(path: string, brokerUserId: number) {
  let current = path;
  while (true) {
    const [metadata, canonical] = await Promise.all([lstat(current), realpath(current)]);
    const rootOwnedSticky = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
    if (
      canonical !== current ||
      !metadata.isDirectory() ||
      (metadata.uid !== 0 && metadata.uid !== brokerUserId) ||
      ((metadata.mode & 0o022) !== 0 && !rootOwnedSticky)
    ) {
      throw new TypeError("A production broker socket ancestor is mutable or ambiguously owned.");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** The direct UDS directory is the broker:Studio-group capability boundary. */
export async function assertFastManimProductionBrokerSocketDirectoryV1(
  socketPathValue: string,
  brokerUserIdValue: number,
  socketGroupIdValue: number,
) {
  const socketPath = canonicalProductionBrokerSocketPath(socketPathValue);
  const brokerUserId = productionUserId(brokerUserIdValue, "Broker user ID");
  const socketGroupId = productionGroupId(socketGroupIdValue);
  const parent = dirname(socketPath);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  if (
    canonical !== parent ||
    !metadata.isDirectory() ||
    metadata.uid !== brokerUserId ||
    metadata.gid !== socketGroupId ||
    (metadata.mode & 0o7777) !== 0o750
  ) {
    throw new TypeError("The production broker socket directory must be canonical broker:Studio-group mode 0750.");
  }
  await assertProductionBrokerSocketAncestors(dirname(parent), brokerUserId);
}

/** Studio calls this before constructing a transport to the broker. */
export async function assertFastManimProductionBrokerSocketV1(
  socketPath: string,
  brokerUserId: number,
  socketGroupId: number,
) {
  await assertFastManimProductionBrokerSocketDirectoryV1(socketPath, brokerUserId, socketGroupId);
  const [metadata, canonical] = await Promise.all([lstat(socketPath), realpath(socketPath)]);
  if (
    canonical !== socketPath ||
    !metadata.isSocket() ||
    metadata.uid !== brokerUserId ||
    metadata.gid !== socketGroupId ||
    (metadata.mode & 0o7777) !== 0o660
  ) {
    throw new TypeError("The production broker socket is not the expected broker:Studio-group mode 0660 endpoint.");
  }
}
