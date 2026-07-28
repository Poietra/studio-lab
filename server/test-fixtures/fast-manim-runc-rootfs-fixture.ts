import { createHash } from "node:crypto";
import { constants } from "node:fs";

import { FastManimRuncMountedRootfsRegistryV1 } from "../fast-manim-runc-mounted-rootfs";

export const FAST_MANIM_TEST_ROOTFS_BYTES_V1 = Buffer.from("signed-rootfs-image", "utf8");
export const FAST_MANIM_TEST_ROOTFS_DIGEST_V1 = createHash("sha256")
  .update(FAST_MANIM_TEST_ROOTFS_BYTES_V1)
  .digest("hex");

export function createFastManimRuncRootfsFixtureV1(
  rootfsPath: string,
  options: Readonly<{ onEvent?: (event: string) => void }> = {},
) {
  const imagePath = `${rootfsPath}.erofs`;
  const imageStat = Object.freeze({
    ctimeNs: 1n,
    dev: 1n,
    gid: 0n,
    ino: 2n,
    mode: BigInt(constants.S_IFREG | 0o444),
    mtimeNs: 1n,
    nlink: 1n,
    size: BigInt(FAST_MANIM_TEST_ROOTFS_BYTES_V1.byteLength),
    uid: 0n,
  });
  return new FastManimRuncMountedRootfsRegistryV1({
    format: "erofs",
    imagePath,
    io: {
      async openImage() {
        options.onEvent?.("rootfs:image-open");
        return {
          async close() {
            options.onEvent?.("rootfs:image-close");
          },
          async read(position, length) {
            return FAST_MANIM_TEST_ROOTFS_BYTES_V1.subarray(position, position + length);
          },
          async stat() {
            return imageStat;
          },
        };
      },
      async openRootfs() {
        options.onEvent?.("rootfs:mount-open");
        return {
          async close() {
            options.onEvent?.("rootfs:mount-close");
          },
          async stat() {
            return { dev: 0x703n, mode: BigInt(constants.S_IFDIR | 0o555) };
          },
        };
      },
      async readText(path) {
        const values: Readonly<Record<string, string>> = {
          "/proc/self/mountinfo": `42 1 7:3 / ${rootfsPath} ro,nosuid,nodev - erofs /dev/loop3 ro\n`,
          "/sys/dev/block/7:3/diskseq": "19\n",
          "/sys/dev/block/7:3/loop/backing_file": `${imagePath}\n`,
          "/sys/dev/block/7:3/loop/offset": "0\n",
          "/sys/dev/block/7:3/loop/partscan": "0\n",
          "/sys/dev/block/7:3/loop/sizelimit": "0\n",
          "/sys/dev/block/7:3/ro": "1\n",
        };
        const value = values[path];
        if (value === undefined) throw new Error("Unexpected rootfs fixture read.");
        return value;
      },
    },
    rootfsDigest: FAST_MANIM_TEST_ROOTFS_DIGEST_V1,
    rootfsPath,
  });
}
