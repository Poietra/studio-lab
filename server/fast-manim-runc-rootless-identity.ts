const MAX_LINUX_ID = 0xffff_ffff;
const REQUIRED_CONTAINER_ID_END = 65_533;
const MAX_MAPPING_ENTRIES = 32;

export type FastManimRuncLinuxIdMappingV1 = Readonly<{
  containerID: number;
  hostID: number;
  size: number;
}>;

export type FastManimRuncAllowedHostIdRangeV1 = Readonly<{
  size: number;
  start: number;
}>;

export type FastManimRuncRootlessIdentityMapOptionsV1 = Readonly<{
  allowedGidRanges: readonly FastManimRuncAllowedHostIdRangeV1[];
  allowedUidRanges: readonly FastManimRuncAllowedHostIdRangeV1[];
  gidMappings: readonly FastManimRuncLinuxIdMappingV1[];
  uidMappings: readonly FastManimRuncLinuxIdMappingV1[];
}>;

function boundedId(value: unknown, label: string, allowZero: boolean) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > MAX_LINUX_ID) {
    throw new TypeError(`${label} must be a canonical Linux ID integer.`);
  }
  return value as number;
}

function checkedEnd(start: number, size: number, label: string) {
  const end = start + size;
  if (!Number.isSafeInteger(end) || end > MAX_LINUX_ID + 1) {
    throw new TypeError(`${label} exceeds the Linux ID address space.`);
  }
  return end;
}

function parseAllowedRanges(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MAPPING_ENTRIES) {
    throw new TypeError(`${label} must contain a bounded host subordinate-ID allowlist.`);
  }
  const parsed = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Object.keys(entry).sort().join(",") !== "size,start") {
      throw new TypeError(`${label}[${index}] is malformed.`);
    }
    const start = boundedId((entry as { start?: unknown }).start, `${label}[${index}].start`, true);
    const size = boundedId((entry as { size?: unknown }).size, `${label}[${index}].size`, false);
    return Object.freeze({ end: checkedEnd(start, size, label), size, start });
  });
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1]!.end >= parsed[index]!.start) {
      throw new TypeError(`${label} must be sorted, non-overlapping, and merge adjacent ranges.`);
    }
  }
  return Object.freeze(parsed);
}

function parseMappings(value: unknown, allowedValue: unknown, label: string) {
  const allowed = parseAllowedRanges(allowedValue, `allowed${label}Ranges`);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MAPPING_ENTRIES) {
    throw new TypeError(`${label}Mappings must contain a bounded mapping set.`);
  }
  const parsed = value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).sort().join(",") !== "containerID,hostID,size"
    ) {
      throw new TypeError(`${label}Mappings[${index}] is malformed.`);
    }
    const mapping = entry as { containerID?: unknown; hostID?: unknown; size?: unknown };
    const containerID = boundedId(mapping.containerID, `${label}Mappings[${index}].containerID`, true);
    const hostID = boundedId(mapping.hostID, `${label}Mappings[${index}].hostID`, true);
    const size = boundedId(mapping.size, `${label}Mappings[${index}].size`, false);
    const containerEnd = checkedEnd(containerID, size, `${label} container mapping`);
    const hostEnd = checkedEnd(hostID, size, `${label} host mapping`);
    if (!allowed.some((range) => hostID >= range.start && hostEnd <= range.end)) {
      throw new TypeError(`${label}Mappings[${index}] escapes the configured host subordinate-ID ranges.`);
    }
    return Object.freeze({ containerEnd, containerID, hostEnd, hostID, size });
  });
  if (parsed[0]?.containerID !== 0) throw new TypeError(`${label} mappings must begin at container ID zero.`);
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1]!;
    const current = parsed[index]!;
    if (previous.containerEnd !== current.containerID || previous.hostEnd > current.hostID) {
      throw new TypeError(`${label} mappings must canonically cover container IDs and not overlap host IDs.`);
    }
    if (previous.containerEnd === current.containerID && previous.hostEnd === current.hostID) {
      throw new TypeError(`${label} mappings must merge adjacent container and host ranges.`);
    }
  }
  if (parsed.at(-1)!.containerEnd < REQUIRED_CONTAINER_ID_END) {
    throw new TypeError(`${label} mappings must cover every container ID from 0 through 65532.`);
  }
  return Object.freeze(parsed.map(({ containerID, hostID, size }) => Object.freeze({ containerID, hostID, size })));
}

/**
 * Trusted host user-namespace contract. It is configured once by the
 * orchestrator; no job, request, tenant, or source value can alter it.
 */
const rootlessIdentityMaps = new WeakSet<object>();

export class FastManimRuncRootlessIdentityMapV1 {
  readonly #gidMappings: readonly FastManimRuncLinuxIdMappingV1[];
  readonly #uidMappings: readonly FastManimRuncLinuxIdMappingV1[];

  constructor(options: FastManimRuncRootlessIdentityMapOptionsV1) {
    this.#uidMappings = parseMappings(options?.uidMappings, options?.allowedUidRanges, "Uid");
    this.#gidMappings = parseMappings(options?.gidMappings, options?.allowedGidRanges, "Gid");
    rootlessIdentityMaps.add(this);
    Object.freeze(this);
  }

  hostRootIdentity() {
    return Object.freeze({ gid: this.#gidMappings[0]!.hostID, uid: this.#uidMappings[0]!.hostID });
  }

  ociMappings() {
    return Object.freeze({
      gidMappings: Object.freeze(this.#gidMappings.map((mapping) => Object.freeze({ ...mapping }))),
      uidMappings: Object.freeze(this.#uidMappings.map((mapping) => Object.freeze({ ...mapping }))),
    });
  }
}

export function isFastManimRuncRootlessIdentityMapV1(value: unknown): value is FastManimRuncRootlessIdentityMapV1 {
  return (
    value instanceof FastManimRuncRootlessIdentityMapV1 &&
    Object.getPrototypeOf(value) === FastManimRuncRootlessIdentityMapV1.prototype &&
    rootlessIdentityMaps.has(value)
  );
}
