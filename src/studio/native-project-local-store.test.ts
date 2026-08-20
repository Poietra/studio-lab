import { describe, expect, it } from "vitest";

import {
  createStudioWaveFragmentMaterialPresetV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
} from "./fragment-material-authoring";
import { ingestNativeProjectPngV1 } from "./native-project-assets";
import {
  type NativeProjectLocalIdentity,
  type NativeProjectLocalStorageAdapter,
  NativeProjectLocalStore,
} from "./native-project-local-store";
import { createStudioNativeBlankScene, createStudioNativeBlankSceneIrBundle } from "./studio-native-workspace";

const DOCUMENT_KEY = "d".repeat(64);
const IDENTITY = { documentKey: DOCUMENT_KEY, projectId: "project-a" } as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function key(identity: NativeProjectLocalIdentity) {
  return `${identity.projectId}\0${identity.documentKey}`;
}

class MemoryAdapter implements NativeProjectLocalStorageAdapter {
  readonly records = new Map<string, unknown>();

  async deleteProject(projectId: string) {
    for (const candidate of this.records.keys()) {
      if (candidate.startsWith(`${projectId}\0`)) this.records.delete(candidate);
    }
  }

  async read(identity: NativeProjectLocalIdentity) {
    const value = this.records.get(key(identity));
    return value === undefined ? null : structuredClone(value);
  }

  async write(record: Parameters<NativeProjectLocalStorageAdapter["write"]>[0]) {
    this.records.set(key(record), structuredClone(record));
  }
}

class DelayedFirstWriteAdapter extends MemoryAdapter {
  startedWrites = 0;
  private releaseFirstWrite!: () => void;
  private readonly firstWrite = new Promise<void>((resolve) => {
    this.releaseFirstWrite = resolve;
  });

  release() {
    this.releaseFirstWrite();
  }

  override async write(record: Parameters<NativeProjectLocalStorageAdapter["write"]>[0]) {
    this.startedWrites += 1;
    if (this.startedWrites === 1) await this.firstWrite;
    await super.write(record);
  }
}

async function authoredState() {
  const bundle = await createStudioNativeBlankSceneIrBundle(createStudioNativeBlankScene(DOCUMENT_KEY), {
    height: 8,
    width: 14.222,
  });
  const ingested = await ingestNativeProjectPngV1({
    decodeDimensions: async () => ({ pixelHeight: 1, pixelWidth: 2 }),
    source: { bytes: PNG.buffer.slice(0), kind: "bytes", mediaType: "image/png" },
    state: { assetPayloads: [], bundle },
  });
  return {
    assetPayloads: ingested.assetPayloads,
    bundle: ingested.bundle,
    fragmentMaterials: createStudioWaveFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1).state,
  };
}

describe("Studio-native local project persistence", () => {
  it("restores the verified PNG manifest, owned bytes, and material state", async () => {
    const adapter = new MemoryAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    const state = await authoredState();

    await store.save(IDENTITY, state);
    new Uint8Array(state.assetPayloads[0]!.bytes)[0] = 0;

    const restored = await store.restore(IDENTITY);
    expect(restored?.bundle.assets).toEqual(state.bundle.assets);
    expect(new Uint8Array(restored!.assetPayloads[0]!.bytes)).toEqual(PNG);
    expect(restored?.fragmentMaterials).toEqual(state.fragmentMaterials);
  });

  it("isolates document keys and removes every local document for a deleted project", async () => {
    const adapter = new MemoryAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    await store.save(IDENTITY, await authoredState());

    await expect(store.restore({ ...IDENTITY, documentKey: "e".repeat(64) })).resolves.toBeNull();
    await store.deleteProject(IDENTITY.projectId);
    await expect(store.restore(IDENTITY)).resolves.toBeNull();
    expect(adapter.records).toHaveLength(0);
  });

  it("commits concurrent saves in invocation order", async () => {
    const adapter = new DelayedFirstWriteAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    const first = await authoredState();
    const second = { ...first, fragmentMaterials: EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1 };

    const firstSave = store.save(IDENTITY, first);
    const secondSave = store.save(IDENTITY, second);
    await Promise.resolve();
    expect(adapter.startedWrites).toBe(1);

    adapter.release();
    await Promise.all([firstSave, secondSave]);
    await expect(store.restore(IDENTITY)).resolves.toMatchObject({
      fragmentMaterials: EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
    });
  });
});
