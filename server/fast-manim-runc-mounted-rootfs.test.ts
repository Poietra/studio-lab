import { createHash } from "node:crypto";
import { constants } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FastManimRuncMountedRootfsError,
  type FastManimRuncMountedRootfsIoV1,
  FastManimRuncMountedRootfsRegistryV1,
  isProductionFastManimRuncMountedRootfsRegistryV1,
} from "./fast-manim-runc-mounted-rootfs";

const IMAGE_PATH = "/srv/poietra/images/rootfs.erofs";
const ROOTFS_PATH = "/srv/poietra/rootfs/current";
const CONTENT = Buffer.from("immutable-rootfs-image", "utf8");
const DIGEST = createHash("sha256").update(CONTENT).digest("hex");
const MOUNT = `1 0 0:1 / / rw - tmpfs tmpfs rw\n42 1 7:3 / ${ROOTFS_PATH} ro,nosuid,nodev - erofs /dev/loop3 ro\n`;

type FixtureOptions = Readonly<{
  closeFails?: boolean;
  content?: Uint8Array;
  mountinfo?: string;
  rootfsDev?: bigint;
  stat?: Partial<{
    dev: bigint;
    gid: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    uid: bigint;
  }>;
  sys?: Readonly<Record<string, string | readonly string[]>>;
}>;

function fixture(options: FixtureOptions = {}) {
  const content = options.content ?? CONTENT;
  const stat = {
    ctimeNs: 30n,
    dev: 11n,
    gid: 0n,
    ino: 22n,
    mode: BigInt(constants.S_IFREG | 0o444),
    mtimeNs: 31n,
    nlink: 1n,
    size: BigInt(content.byteLength),
    uid: 0n,
    ...options.stat,
  };
  const defaults: Record<string, string | readonly string[]> = {
    "/proc/self/mountinfo": options.mountinfo ?? MOUNT,
    "/sys/dev/block/7:3/diskseq": "19\n",
    "/sys/dev/block/7:3/loop/backing_file": `${IMAGE_PATH}\n`,
    "/sys/dev/block/7:3/loop/offset": "0\n",
    "/sys/dev/block/7:3/loop/partscan": "0\n",
    "/sys/dev/block/7:3/loop/sizelimit": "0\n",
    "/sys/dev/block/7:3/ro": "1\n",
    ...options.sys,
  };
  const readCounts = new Map<string, number>();
  let closeCount = 0;
  let imageReadCount = 0;
  const io: FastManimRuncMountedRootfsIoV1 = {
    async openImage(path) {
      expect(path).toBe(IMAGE_PATH);
      let closed = false;
      return {
        async close() {
          if (!closed) closeCount += 1;
          closed = true;
          if (options.closeFails) throw new Error("close failed");
        },
        async read(position, length) {
          imageReadCount += 1;
          return content.slice(position, position + length);
        },
        async stat() {
          return stat;
        },
      };
    },
    async openRootfs(path) {
      expect(path).toBe(ROOTFS_PATH);
      let closed = false;
      return {
        async close() {
          if (!closed) closeCount += 1;
          closed = true;
          if (options.closeFails) throw new Error("close failed");
        },
        async stat() {
          return { dev: options.rootfsDev ?? 0x703n, mode: BigInt(constants.S_IFDIR | 0o555) };
        },
      };
    },
    async readText(path) {
      const value = defaults[path];
      if (typeof value === "string") return value;
      if (!value) throw new Error("unexpected read");
      const index = readCounts.get(path) ?? 0;
      readCounts.set(path, index + 1);
      return value[Math.min(index, value.length - 1)] ?? "";
    },
  };
  const registry = new FastManimRuncMountedRootfsRegistryV1({
    format: "erofs",
    imagePath: IMAGE_PATH,
    io,
    rootfsDigest: DIGEST,
    rootfsPath: ROOTFS_PATH,
  });
  return { closeCount: () => closeCount, imageReadCount: () => imageReadCount, registry };
}

describe("mounted rootfs verifier", () => {
  it("holds the verified image fd for an opaque job lease and closes idempotently", async () => {
    const test = fixture();
    const handle = test.registry.resolve(DIGEST);
    expect(Object.keys(handle)).toEqual([]);
    expect(isProductionFastManimRuncMountedRootfsRegistryV1(test.registry)).toBe(false);

    await handle.assertReady(new AbortController().signal);
    expect(test.closeCount()).toBe(2);
    expect(test.imageReadCount()).toBe(2);
    await handle.assertReady(new AbortController().signal);
    expect(test.imageReadCount()).toBe(2);
    const lease = await handle.acquireForJob(
      "poietra-job-v1-0123456789abcdef0123456789abcdef-1",
      new AbortController().signal,
    );
    expect(lease.rootfsPath).toBe(ROOTFS_PATH);
    expect(test.closeCount()).toBe(4);
    expect(test.imageReadCount()).toBe(2);
    await Promise.all([lease.close(), lease.close()]);
    expect(test.closeCount()).toBe(6);

    const production = new FastManimRuncMountedRootfsRegistryV1({
      format: "erofs",
      imagePath: IMAGE_PATH,
      rootfsDigest: DIGEST,
      rootfsPath: ROOTFS_PATH,
    });
    expect(isProductionFastManimRuncMountedRootfsRegistryV1(production)).toBe(false);
  });

  it("classifies an fd close failure as cleanup", async () => {
    const test = fixture({ closeFails: true });
    await expect(test.registry.assertReady(new AbortController().signal)).rejects.toMatchObject({ code: "cleanup" });
  });

  it.each([
    { label: "writable", options: { stat: { mode: BigInt(constants.S_IFREG | 0o644) } } },
    { label: "not root-owned", options: { stat: { uid: 1000n } } },
    { label: "multiply linked", options: { stat: { nlink: 2n } } },
    { label: "digest mismatch", options: { content: Buffer.from("different") } },
  ])("rejects a $label image and closes its fd", async ({ options }) => {
    const test = fixture(options);
    await expect(test.registry.assertReady(new AbortController().signal)).rejects.toBeInstanceOf(
      FastManimRuncMountedRootfsError,
    );
    expect(test.closeCount()).toBeGreaterThanOrEqual(1);
  });

  it("rejects a mount fd from a different device", async () => {
    await expect(
      fixture({ rootfsDev: 0x704n }).registry.assertReady(new AbortController().signal),
    ).rejects.toBeInstanceOf(FastManimRuncMountedRootfsError);
  });

  it.each([
    ["wrong filesystem", MOUNT.replace(" erofs ", " squashfs ")],
    ["writable mount", MOUNT.replace("ro,nosuid,nodev", "rw,nosuid,nodev")],
    ["propagating mount", MOUNT.replace(" ro,nosuid,nodev -", " ro,nosuid,nodev shared:8 -")],
    ["child mount", `${MOUNT}43 42 0:2 / ${ROOTFS_PATH}/proc ro - proc proc ro\n`],
  ])("rejects %s evidence", async (_label, mountinfo) => {
    await expect(fixture({ mountinfo }).registry.assertReady(new AbortController().signal)).rejects.toBeInstanceOf(
      FastManimRuncMountedRootfsError,
    );
  });

  it.each([
    ["backing file", "/sys/dev/block/7:3/loop/backing_file", "/other/image\n"],
    ["read-only flag", "/sys/dev/block/7:3/ro", "0\n"],
    ["offset", "/sys/dev/block/7:3/loop/offset", "4096\n"],
    ["size limit", "/sys/dev/block/7:3/loop/sizelimit", "1\n"],
    ["partition scan", "/sys/dev/block/7:3/loop/partscan", "1\n"],
    ["stable disk sequence", "/sys/dev/block/7:3/diskseq", ["19\n", "20\n"]],
  ])("rejects an invalid %s", async (_label, path, value) => {
    await expect(
      fixture({ sys: { [path]: value } }).registry.assertReady(new AbortController().signal),
    ).rejects.toBeInstanceOf(FastManimRuncMountedRootfsError);
  });

  it("rejects unknown digests, unsafe job ids, and aborted verification", async () => {
    const test = fixture();
    expect(() => test.registry.resolve("f".repeat(64))).toThrow(FastManimRuncMountedRootfsError);
    await expect(
      test.registry.resolve(DIGEST).acquireForJob("../job", new AbortController().signal),
    ).rejects.toBeInstanceOf(FastManimRuncMountedRootfsError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(test.registry.assertReady(aborted.signal)).rejects.toBeInstanceOf(FastManimRuncMountedRootfsError);
  });

  it("permanently taints mount drift and rejects a duplicate active job lease", async () => {
    const test = fixture({
      sys: { "/sys/dev/block/7:3/diskseq": ["19\n", "19\n", "20\n", "20\n"] },
    });
    await test.registry.assertReady(new AbortController().signal);
    await expect(test.registry.assertReady(new AbortController().signal)).rejects.toBeInstanceOf(
      FastManimRuncMountedRootfsError,
    );
    await expect(test.registry.assertReady(new AbortController().signal)).rejects.toBeInstanceOf(
      FastManimRuncMountedRootfsError,
    );

    const separate = fixture();
    const handle = separate.registry.resolve(DIGEST);
    const jobId = "poietra-job-v1-0123456789abcdef0123456789abcdef-1";
    const lease = await handle.acquireForJob(jobId, new AbortController().signal);
    await expect(handle.acquireForJob(jobId, new AbortController().signal)).rejects.toBeInstanceOf(
      FastManimRuncMountedRootfsError,
    );
    await lease.close();
  });
});
