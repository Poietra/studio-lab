import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1,
  FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1,
  FastManimOciBrokerDispatchV1,
  fastManimOciJobDescriptorV1Schema,
} from "./fast-manim-oci-sandbox-profile";
import type { FastManimRuncOciSpecV1 } from "./fast-manim-runc-oci-spec";
import {
  type FastManimRuncRootlessIdentityMapV1,
  isFastManimRuncRootlessIdentityMapV1,
} from "./fast-manim-runc-rootless-identity";
import { isFastManimSandboxResourceCgroupNameV1 } from "./fast-manim-sandbox-resources";

const CONFIG_FILE_NAME = "config.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PLAIN_JSON_NODES = 20_000;
const EXCLUSIVE_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type BundleEntryExpectation = Readonly<{ kind: "directory" | "file"; mode: number }>;

/** Trusted test seam. Production omits it and enforces mapped container-root ownership. */
export interface FastManimRuncJobBundleMetadataPolicyV1 {
  prepare(handle: FileHandle, expectation: BundleEntryExpectation): Promise<void>;
  verifyRoot(handle: FileHandle): Promise<void>;
}

export type FastManimRuncJobBundleStoreOptionsV1 = Readonly<{
  identityMap: FastManimRuncRootlessIdentityMapV1;
  metadataPolicy?: FastManimRuncJobBundleMetadataPolicyV1;
  root: string;
}>;

export type FastManimRuncJobBundleHandleV1 = Readonly<{
  assetsPath: string;
  bundlePath: string;
}>;

export type FastManimRuncJobBundlePlanV1 = FastManimRuncJobBundleHandleV1;
export type FastManimRuncJobBundleV1 = FastManimRuncJobBundleHandleV1;

type BundleState = {
  bundleCreated: boolean;
  cleanupPromise: Promise<void> | null;
  cleaned: boolean;
  containerId: string;
  handle: FastManimRuncJobBundleHandleV1;
  stageAttempted: boolean;
  stagePromise: Promise<FastManimRuncJobBundleHandleV1> | null;
};

function assertEntryMetadata(metadata: Stats, expectation: BundleEntryExpectation, uid: number, gid: number) {
  const kindMatches = expectation.kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (
    !kindMatches ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== expectation.mode ||
    (expectation.kind === "file" && metadata.nlink !== 1)
  ) {
    throw new Error("The runc job bundle metadata contract was not established.");
  }
}

function productionMetadataPolicy(identityMap: FastManimRuncRootlessIdentityMapV1) {
  const { gid, uid } = identityMap.hostRootIdentity();
  return Object.freeze({
    async prepare(handle: FileHandle, expectation: BundleEntryExpectation) {
      await handle.chown(uid, gid);
      await handle.chmod(expectation.mode);
      assertEntryMetadata(await handle.stat({ bigint: false }), expectation, uid, gid);
    },
    async verifyRoot(handle: FileHandle) {
      const metadata = await handle.stat({ bigint: false });
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.gid !== gid) {
        throw new Error("The runc job bundle root is not owned by mapped container root.");
      }
      if ((metadata.mode & 0o022) !== 0) throw new Error("The runc job bundle root is writable by another identity.");
    },
  }) satisfies FastManimRuncJobBundleMetadataPolicyV1;
}

const productionBundleStores = new WeakSet<object>();

export function isProductionFastManimRuncJobBundleStoreV1(value: unknown): value is FastManimRuncJobBundleStoreV1 {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    productionBundleStores.has(value) &&
    Object.getPrototypeOf(value) === FastManimRuncJobBundleStoreV1.prototype
  );
}

function canonicalRoot(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parsePath(value).root ||
    value.endsWith(sep)
  ) {
    throw new TypeError("The runc bundle root must be a canonical absolute non-root path.");
  }
  return value;
}

function assertPlainJson(value: unknown) {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): void => {
    nodes += 1;
    if (nodes > MAX_PLAIN_JSON_NODES) throw new TypeError("The OCI spec exceeds its JSON node budget.");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry !== "object" || seen.has(entry))
      throw new TypeError("The OCI spec must be an acyclic plain JSON value.");
    seen.add(entry);
    const array = Array.isArray(entry);
    if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype)) {
      throw new TypeError("The OCI spec must contain plain JSON containers only.");
    }
    const keys = Object.keys(entry);
    const ownKeys = Reflect.ownKeys(entry);
    const expectedOwnKeyCount = keys.length + (array ? 1 : 0);
    if (
      ownKeys.length !== expectedOwnKeyCount ||
      ownKeys.some((key) => typeof key !== "string") ||
      (array && (keys.length !== entry.length || keys.some((key, index) => key !== String(index))))
    ) {
      throw new TypeError("The OCI spec contains a non-JSON property or a sparse array.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("The OCI spec must contain enumerable data properties only.");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
}

async function withDirectoryHandle<T>(path: string, operation: (handle: FileHandle) => Promise<T>) {
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    return await operation(handle);
  } finally {
    await handle.close();
  }
}

async function createExclusiveFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
  metadataPolicy: FastManimRuncJobBundleMetadataPolicyV1,
) {
  const handle = await open(path, EXCLUSIVE_FILE_FLAGS, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await metadataPolicy.prepare(handle, { kind: "file", mode });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSpecMatchesPlan(
  spec: FastManimRuncOciSpecV1,
  state: BundleState,
  mappings: ReturnType<FastManimRuncRootlessIdentityMapV1["ociMappings"]>,
) {
  assertPlainJson(spec);
  if (spec.linux?.cgroupsPath?.split("/").at(-1) !== state.containerId) {
    throw new TypeError("The OCI spec cgroup does not match its server bundle plan.");
  }
  const assetMounts = spec.mounts?.filter((mount) => mount.destination === "/opt/poietra/assets");
  if (
    assetMounts?.length !== 1 ||
    assetMounts[0]?.source !== state.handle.assetsPath ||
    assetMounts[0].type !== "bind" ||
    canonicalJsonV1(assetMounts[0].options) !== canonicalJsonV1(["rbind", "ro", "nosuid", "nodev", "noexec"])
  ) {
    throw new TypeError("The OCI spec asset mount does not match its server bundle plan.");
  }
  if (
    canonicalJsonV1(spec.linux.uidMappings) !== canonicalJsonV1(mappings.uidMappings) ||
    canonicalJsonV1(spec.linux.gidMappings) !== canonicalJsonV1(mappings.gidMappings)
  ) {
    throw new TypeError("The OCI spec user namespace does not match its server bundle store.");
  }
}

export class FastManimRuncJobBundleStoreV1 {
  readonly #active = new Map<string, BundleState>();
  readonly #identityMappings: ReturnType<FastManimRuncRootlessIdentityMapV1["ociMappings"]>;
  readonly #metadataPolicy: FastManimRuncJobBundleMetadataPolicyV1;
  readonly #plans = new WeakMap<FastManimRuncJobBundleHandleV1, BundleState>();
  readonly #root: string;

  constructor(options: FastManimRuncJobBundleStoreOptionsV1) {
    this.#root = canonicalRoot(options?.root);
    if (!isFastManimRuncRootlessIdentityMapV1(options.identityMap)) {
      throw new TypeError("The runc bundle store requires a trusted rootless identity mapping contract.");
    }
    this.#identityMappings = options.identityMap.ociMappings();
    this.#metadataPolicy = options.metadataPolicy ?? productionMetadataPolicy(options.identityMap);
    if (typeof this.#metadataPolicy?.prepare !== "function" || typeof this.#metadataPolicy.verifyRoot !== "function") {
      throw new TypeError("The runc bundle metadata policy is malformed.");
    }
    if (options.metadataPolicy === undefined) productionBundleStores.add(this);
  }

  async assertReady() {
    if ((await realpath(this.#root)) !== this.#root) {
      throw new Error("The runc bundle root is not its canonical filesystem path.");
    }
    await withDirectoryHandle(this.#root, (root) => this.#metadataPolicy.verifyRoot(root));
  }

  plan(containerId: string): FastManimRuncJobBundleHandleV1 {
    if (!isFastManimSandboxResourceCgroupNameV1(containerId) || this.#active.has(containerId)) {
      throw new TypeError("The runc container identity is invalid or already planned.");
    }
    const bundlePath = join(this.#root, containerId);
    const handle = Object.freeze({ assetsPath: join(bundlePath, "assets"), bundlePath });
    const state: BundleState = {
      bundleCreated: false,
      cleaned: false,
      cleanupPromise: null,
      containerId,
      handle,
      stageAttempted: false,
      stagePromise: null,
    };
    this.#active.set(containerId, state);
    this.#plans.set(handle, state);
    return handle;
  }

  stage(
    options: Readonly<{
      dispatch: FastManimOciBrokerDispatchV1;
      plan: FastManimRuncJobBundleHandleV1;
      spec: FastManimRuncOciSpecV1;
    }>,
  ) {
    const state = this.#known(options?.plan);
    if (state.stageAttempted || state.cleaned || state.cleanupPromise !== null) {
      throw new TypeError("The runc bundle plan cannot be staged again.");
    }
    state.stageAttempted = true;
    state.stagePromise = this.#stage(state, options.dispatch, options.spec);
    return state.stagePromise;
  }

  async cleanup(handle: FastManimRuncJobBundleHandleV1) {
    const state = this.#known(handle);
    if (state.cleaned) return;
    if (state.cleanupPromise !== null) return state.cleanupPromise;
    const cleanup = (async () => {
      await state.stagePromise?.catch(() => undefined);
      if (state.bundleCreated) {
        const bundleRelative = relative(this.#root, state.handle.bundlePath);
        if (
          bundleRelative !== state.containerId ||
          bundleRelative.startsWith(`..${sep}`) ||
          isAbsolute(bundleRelative)
        ) {
          throw new Error("The runc bundle cleanup target escaped its configured root.");
        }
        const assetMetadata = await lstat(state.handle.assetsPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (assetMetadata !== null) {
          if (!assetMetadata.isDirectory() || assetMetadata.isSymbolicLink()) {
            throw new Error("The runc asset cleanup target changed type.");
          }
          await chmod(state.handle.assetsPath, 0o700);
        }
        await rm(state.handle.bundlePath, { force: true, recursive: true });
        state.bundleCreated = false;
        await withDirectoryHandle(this.#root, (root) => root.sync());
      }
      state.cleaned = true;
      this.#active.delete(state.containerId);
    })();
    state.cleanupPromise = cleanup;
    try {
      await cleanup;
    } catch (error) {
      state.cleanupPromise = null;
      throw error;
    }
  }

  async #stage(state: BundleState, dispatch: FastManimOciBrokerDispatchV1, spec: FastManimRuncOciSpecV1) {
    if (!(dispatch instanceof FastManimOciBrokerDispatchV1)) {
      throw new TypeError("A runc bundle requires a verified OCI broker dispatch.");
    }
    assertSpecMatchesPlan(spec, state, this.#identityMappings);
    const descriptor = fastManimOciJobDescriptorV1Schema.parse(dispatch.descriptor);
    const assets = dispatch.copyAssets();
    if (assets.length !== descriptor.assets.length) throw new TypeError("The OCI asset copies changed before staging.");
    const verifiedAssets = assets.map((asset, index) => {
      const expected = descriptor.assets[index];
      if (
        expected === undefined ||
        canonicalJsonV1(asset.descriptor) !== canonicalJsonV1(expected) ||
        asset.bytes.byteLength !== expected.byteLength ||
        createHash("sha256").update(asset.bytes).digest("hex") !== expected.sha256
      ) {
        throw new TypeError("An OCI asset changed before runc bundle staging.");
      }
      return { bytes: asset.bytes, descriptor: expected };
    });
    const manifest = {
      assets: descriptor.assets.map(({ byteLength, fileName, sha256 }) => ({ byteLength, fileName, sha256 })),
      count: descriptor.assets.length,
      schema: FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1,
      version: 1,
    };
    const configBytes = Buffer.from(`${canonicalJsonV1(spec)}\n`, "utf8");
    if (configBytes.byteLength > MAX_CONFIG_BYTES) throw new RangeError("The OCI config exceeds its byte budget.");

    const actualRoot = await realpath(this.#root);
    if (actualRoot !== this.#root) throw new Error("The runc job bundle root is not its canonical real path.");
    await withDirectoryHandle(this.#root, async (root) => {
      await this.#metadataPolicy.verifyRoot(root);
      await mkdir(state.handle.bundlePath, { mode: 0o700 });
      state.bundleCreated = true;
      await withDirectoryHandle(state.handle.bundlePath, async (bundle) => {
        await this.#metadataPolicy.prepare(bundle, { kind: "directory", mode: 0o700 });
        await mkdir(state.handle.assetsPath, { mode: 0o700 });
        await withDirectoryHandle(state.handle.assetsPath, async (assetDirectory) => {
          await this.#metadataPolicy.prepare(assetDirectory, { kind: "directory", mode: 0o700 });
          await createExclusiveFile(
            join(state.handle.assetsPath, FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1),
            Buffer.from(canonicalJsonV1(manifest), "utf8"),
            0o444,
            this.#metadataPolicy,
          );
          for (const asset of verifiedAssets) {
            await createExclusiveFile(
              join(state.handle.assetsPath, asset.descriptor.fileName),
              asset.bytes,
              0o444,
              this.#metadataPolicy,
            );
          }
          await this.#metadataPolicy.prepare(assetDirectory, { kind: "directory", mode: 0o555 });
          await assetDirectory.sync();
        });
        await createExclusiveFile(
          join(state.handle.bundlePath, CONFIG_FILE_NAME),
          configBytes,
          0o400,
          this.#metadataPolicy,
        );
        await bundle.sync();
      });
      await root.sync();
    });
    return state.handle;
  }

  #known(handle: FastManimRuncJobBundleHandleV1) {
    const state = this.#plans.get(handle);
    if (state === undefined) throw new TypeError("The runc job bundle handle was not issued by this store.");
    return state;
  }
}
