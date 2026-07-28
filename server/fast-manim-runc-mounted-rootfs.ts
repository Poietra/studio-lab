import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import { isFastManimSandboxResourceCgroupNameV1 } from "./fast-manim-sandbox-resources";

const MAX_IMAGE_BYTES_V1 = 8n * 1024n * 1024n * 1024n;
const READ_BYTES_V1 = 1024 * 1024;
const digestV1 = /^[a-f0-9]{64}$/u;
const asciiPathV1 = /^\/[\x21-\x5b\x5d-\x7e]*$/u;
const IMAGE_STAT_KEYS = ["ctimeNs", "dev", "ino", "mode", "mtimeNs", "uid", "gid", "nlink", "size"] as const;
type ImageStatV1 = Readonly<Record<(typeof IMAGE_STAT_KEYS)[number], bigint>>;

type ImageV1 = Readonly<{
  close(): Promise<void>;
  read(position: number, length: number): Promise<Uint8Array>;
  stat(): Promise<ImageStatV1>;
}>;

type DirectoryV1 = Readonly<{
  close(): Promise<void>;
  stat(): Promise<Readonly<{ dev: bigint; mode: bigint }>>;
}>;

type PathStatV1 = Readonly<{ gid: bigint; mode: bigint; uid: bigint }>;

export type FastManimRuncMountedRootfsIoV1 = Readonly<{
  lstatPath(path: string): Promise<PathStatV1>;
  openImage(path: string): Promise<ImageV1>;
  openRootfs(path: string): Promise<DirectoryV1>;
  realpath(path: string): Promise<string>;
  readText(path: string): Promise<string>;
}>;

export type FastManimRuncMountedRootfsLeaseV1 = Readonly<{
  close(): Promise<void>;
  rootfsPath: string;
}>;

export class FastManimRuncMountedRootfsError extends Error {
  readonly code: "cleanup" | "configuration" | "unavailable";

  constructor(code: "cleanup" | "configuration" | "unavailable") {
    super("Fast-manim mounted rootfs verification failed.");
    this.name = "FastManimRuncMountedRootfsError";
    this.code = code;
  }
}

const handleCapabilityV1 = Object.freeze({ kind: "fast-manim-runc-mounted-rootfs" as const });
const productionRegistriesV1 = new WeakSet<object>();

function fail(code: FastManimRuncMountedRootfsError["code"]): never {
  throw new FastManimRuncMountedRootfsError(code);
}

function canonicalPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !asciiPathV1.test(value) ||
    value.length > 4096 ||
    resolve(value) !== value ||
    value === parse(value).root
  ) {
    fail("configuration");
  }
  return value;
}

function notAborted(signal: AbortSignal) {
  if (!(signal instanceof AbortSignal)) fail("configuration");
  signal.throwIfAborted();
}

function parseMountInfo(value: string) {
  if (!value.endsWith("\n") || value.length > 8 * 1024 * 1024) fail("unavailable");
  return value
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      const device = fields[2]?.match(/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u);
      if (separator < 6 || fields.length !== separator + 4 || !device || !/^[1-9][0-9]*$/u.test(fields[0] ?? "")) {
        return fail("unavailable");
      }
      const major = Number(device[1]);
      const minor = Number(device[2]);
      if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) fail("unavailable");
      return {
        deviceMajor: major,
        deviceMinor: minor,
        fsType: fields[separator + 1] ?? "",
        id: fields[0] ?? "",
        mountOptions: (fields[5] ?? "").split(","),
        mountPoint: fields[4] ?? "",
        optional: fields.slice(6, separator),
        root: fields[3] ?? "",
        superOptions: (fields[separator + 3] ?? "").split(","),
      };
    });
}

function assertImageStat(stat: ImageStatV1) {
  const typeMask = BigInt(constants.S_IFMT);
  if (
    (stat.mode & typeMask) !== BigInt(constants.S_IFREG) ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    stat.nlink !== 1n ||
    (stat.mode & 0o222n) !== 0n ||
    stat.size <= 0n ||
    stat.size > MAX_IMAGE_BYTES_V1
  ) {
    fail("unavailable");
  }
}

function sameImage(left: ImageStatV1, right: ImageStatV1) {
  return IMAGE_STAT_KEYS.every((key) => left[key] === right[key]);
}

async function verifyPath(io: FastManimRuncMountedRootfsIoV1, path: string, signal: AbortSignal) {
  if ((await io.realpath(path)) !== path) fail("unavailable");
  let ancestor = dirname(path);
  while (true) {
    notAborted(signal);
    const stat = await io.lstatPath(ancestor);
    if (
      (stat.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFDIR) ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      (stat.mode & 0o022n) !== 0n
    ) {
      fail("unavailable");
    }
    if (ancestor === parse(ancestor).root) return;
    ancestor = dirname(ancestor);
  }
}

const realIoV1: FastManimRuncMountedRootfsIoV1 = Object.freeze({
  lstatPath: (path) => lstat(path, { bigint: true }),
  async openImage(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      close: () => handle.close(),
      async read(position, length) {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      },
      async stat() {
        return handle.stat({ bigint: true });
      },
    };
  },
  async openRootfs(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { close: () => handle.close(), stat: () => handle.stat({ bigint: true }) };
  },
  realpath,
  readText: (path) => readFile(path, "utf8"),
});

async function verifyImage(image: ImageV1, expected: string, cached: ImageStatV1 | undefined, signal: AbortSignal) {
  const before = await image.stat();
  assertImageStat(before);
  if (cached) {
    if (!sameImage(before, cached)) fail("unavailable");
    return before;
  }
  const hash = createHash("sha256");
  let position = 0;
  while (BigInt(position) < before.size) {
    notAborted(signal);
    const wanted = Number(
      before.size - BigInt(position) > BigInt(READ_BYTES_V1) ? READ_BYTES_V1 : before.size - BigInt(position),
    );
    const bytes = await image.read(position, wanted);
    if (bytes.byteLength !== wanted) fail("unavailable");
    hash.update(bytes);
    position += bytes.byteLength;
  }
  if ((await image.read(position, 1)).byteLength !== 0) fail("unavailable");
  const after = await image.stat();
  if (!sameImage(before, after) || hash.digest("hex") !== expected) fail("unavailable");
  return after;
}

async function verifyMount(
  io: FastManimRuncMountedRootfsIoV1,
  rootfsPath: string,
  imagePath: string,
  format: "erofs" | "squashfs",
  signal: AbortSignal,
) {
  notAborted(signal);
  const mounts = parseMountInfo(await io.readText("/proc/self/mountinfo"));
  const matches = mounts.filter((mount) => mount.mountPoint === rootfsPath);
  if (matches.length !== 1) fail("unavailable");
  const mount = matches[0];
  if (
    !mount ||
    mount.root !== "/" ||
    mount.fsType !== format ||
    !mount.mountOptions.includes("ro") ||
    mount.mountOptions.includes("rw") ||
    !mount.mountOptions.includes("nodev") ||
    !mount.mountOptions.includes("nosuid") ||
    !mount.superOptions.includes("ro") ||
    mount.superOptions.includes("rw") ||
    mount.optional.length !== 0 ||
    mounts.some((candidate) => candidate !== mount && candidate.mountPoint.startsWith(`${rootfsPath}/`))
  ) {
    fail("unavailable");
  }
  const sys = `/sys/dev/block/${mount.deviceMajor}:${mount.deviceMinor}`;
  const diskseq = await io.readText(`${sys}/diskseq`);
  if (!/^[1-9][0-9]*\n$/u.test(diskseq)) fail("unavailable");
  const [backingFile, readonly, offset, sizeLimit, partscan] = await Promise.all([
    io.readText(`${sys}/loop/backing_file`),
    io.readText(`${sys}/ro`),
    io.readText(`${sys}/loop/offset`),
    io.readText(`${sys}/loop/sizelimit`),
    io.readText(`${sys}/loop/partscan`),
  ]);
  notAborted(signal);
  if (
    backingFile !== `${imagePath}\n` ||
    readonly !== "1\n" ||
    offset !== "0\n" ||
    sizeLimit !== "0\n" ||
    partscan !== "0\n" ||
    (await io.readText(`${sys}/diskseq`)) !== diskseq
  ) {
    fail("unavailable");
  }
  return { diskseq, mount };
}

function linuxDeviceNumbers(device: bigint) {
  return {
    major: Number(((device & (0xfffn << 8n)) >> 8n) | ((device & (0xfffffn << 44n)) >> 32n)),
    minor: Number((device & 0xffn) | ((device & (0xffffffn << 20n)) >> 12n)),
  };
}

async function closeVerified(image: ImageV1, rootfs: DirectoryV1) {
  const settled = await Promise.allSettled([image.close(), rootfs.close()]);
  if (settled.some((result) => result.status === "rejected")) fail("cleanup");
}

export class FastManimRuncMountedRootfsHandleV1 {
  readonly #registry: FastManimRuncMountedRootfsRegistryV1;

  constructor(capability: typeof handleCapabilityV1, registry: FastManimRuncMountedRootfsRegistryV1) {
    if (capability !== handleCapabilityV1) fail("configuration");
    this.#registry = registry;
    Object.freeze(this);
  }

  assertReady(signal: AbortSignal) {
    return this.#registry.assertReady(signal);
  }

  acquireForJob(jobId: string, signal: AbortSignal) {
    return this.#registry.acquire(jobId, signal);
  }
}

export class FastManimRuncMountedRootfsRegistryV1 {
  readonly #active = new Map<string, FastManimRuncMountedRootfsLeaseV1 | null>();
  readonly #format: "erofs" | "squashfs";
  readonly #imagePath: string;
  readonly #io: FastManimRuncMountedRootfsIoV1;
  readonly #rootfsDigest: string;
  readonly #rootfsPath: string;
  readonly #usesRealIo: boolean;
  #tainted = false;
  #verifiedMount: string | undefined;
  #verifiedStat: ImageStatV1 | undefined;

  constructor(
    options: Readonly<{
      format: "erofs" | "squashfs";
      imagePath: string;
      io?: FastManimRuncMountedRootfsIoV1;
      rootfsDigest: string;
      rootfsPath: string;
    }>,
  ) {
    try {
      const format = options?.format;
      const imagePath = options?.imagePath;
      const io = options?.io;
      const rootfsDigest = options?.rootfsDigest;
      const rootfsPath = options?.rootfsPath;
      if (
        typeof rootfsDigest !== "string" ||
        !digestV1.test(rootfsDigest) ||
        (format !== "erofs" && format !== "squashfs")
      ) {
        fail("configuration");
      }
      this.#imagePath = canonicalPath(imagePath);
      this.#rootfsPath = canonicalPath(rootfsPath);
      if (this.#imagePath === this.#rootfsPath) fail("configuration");
      this.#format = format;
      this.#rootfsDigest = rootfsDigest;
      this.#io = io ?? realIoV1;
      this.#usesRealIo = io === undefined;
      Object.freeze(this);
    } catch {
      fail("configuration");
    }
  }

  resolve(rootfsDigest: string) {
    if (this.#tainted || rootfsDigest !== this.#rootfsDigest) fail("configuration");
    return new FastManimRuncMountedRootfsHandleV1(handleCapabilityV1, this);
  }

  async assertReady(signal: AbortSignal) {
    if (this.#tainted) fail("unavailable");
    const verified = await this.#verify(signal);
    try {
      await closeVerified(verified.image, verified.rootfs);
      if (this.#usesRealIo) productionRegistriesV1.add(this);
    } catch (error) {
      this.#latch();
      throw error;
    }
  }

  async acquire(jobId: string, signal: AbortSignal): Promise<FastManimRuncMountedRootfsLeaseV1> {
    if (!isFastManimSandboxResourceCgroupNameV1(jobId)) fail("configuration");
    if (this.#tainted || this.#active.has(jobId)) fail("unavailable");
    this.#active.set(jobId, null);
    try {
      const verified = await this.#verify(signal);
      let closing: Promise<void> | undefined;
      const lease = Object.freeze({
        close: () =>
          (closing ??= closeVerified(verified.image, verified.rootfs).then(
            () => {
              this.#active.delete(jobId);
            },
            (error) => {
              this.#latch();
              throw error;
            },
          )),
        rootfsPath: this.#rootfsPath,
      });
      this.#active.set(jobId, lease);
      return lease;
    } catch (error) {
      this.#active.delete(jobId);
      throw error;
    }
  }

  async #verify(signal: AbortSignal) {
    notAborted(signal);
    let image: ImageV1 | undefined;
    let rootfs: DirectoryV1 | undefined;
    try {
      await verifyPath(this.#io, this.#imagePath, signal);
      image = await this.#io.openImage(this.#imagePath);
      const stat = await verifyImage(image, this.#rootfsDigest, this.#verifiedStat, signal);
      await verifyPath(this.#io, this.#rootfsPath, signal);
      rootfs = await this.#io.openRootfs(this.#rootfsPath);
      const rootStat = await rootfs.stat();
      const { diskseq, mount } = await verifyMount(this.#io, this.#rootfsPath, this.#imagePath, this.#format, signal);
      const device = linuxDeviceNumbers(rootStat.dev);
      const mountIdentity = `${mount.id}:${mount.deviceMajor}:${mount.deviceMinor}:${diskseq}`;
      if (
        (rootStat.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFDIR) ||
        device.major !== mount.deviceMajor ||
        device.minor !== mount.deviceMinor ||
        (this.#verifiedMount !== undefined && this.#verifiedMount !== mountIdentity)
      ) {
        fail("unavailable");
      }
      this.#verifiedStat ??= stat;
      this.#verifiedMount ??= mountIdentity;
      if (!sameImage(this.#verifiedStat, stat)) fail("unavailable");
      return { image, rootfs };
    } catch (error) {
      const aborted = signal.aborted;
      if (this.#verifiedStat !== undefined && !aborted) this.#latch();
      const settled = await Promise.allSettled([image?.close(), rootfs?.close()]);
      if (settled.some((result) => result.status === "rejected")) {
        this.#latch();
        fail("cleanup");
      }
      if (aborted) signal.throwIfAborted();
      if (error instanceof FastManimRuncMountedRootfsError) throw error;
      return fail("unavailable");
    }
  }

  #latch() {
    this.#tainted = true;
    productionRegistriesV1.delete(this);
  }
}

export function isProductionFastManimRuncMountedRootfsRegistryV1(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === FastManimRuncMountedRootfsRegistryV1.prototype &&
    productionRegistriesV1.has(value)
  );
}
