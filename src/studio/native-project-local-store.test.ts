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
import { importStudioSvgPathAsset } from "./studio-svg-assets";

const DOCUMENT_KEY = "d".repeat(64);
const IDENTITY = { documentKey: DOCUMENT_KEY, projectId: "project-a" } as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_2 = new Uint8Array([...PNG, 1]);
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);

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

class ReferenceMemoryAdapter extends MemoryAdapter {
  override async read(identity: NativeProjectLocalIdentity) {
    return this.records.get(key(identity)) ?? null;
  }

  override async write(record: Parameters<NativeProjectLocalStorageAdapter["write"]>[0]) {
    this.records.set(key(record), record);
  }
}

async function authoredState(includeSvg = false) {
  const bundle = await createStudioNativeBlankSceneIrBundle(createStudioNativeBlankScene(DOCUMENT_KEY), {
    height: 8,
    width: 14.222,
  });
  const first = await ingestNativeProjectPngV1({
    decodeDimensions: async () => ({ pixelHeight: 1, pixelWidth: 2 }),
    source: { bytes: PNG.buffer.slice(0), kind: "bytes", mediaType: "image/png" },
    state: { assetPayloads: [], bundle },
  });
  const ingested = await ingestNativeProjectPngV1({
    decodeDimensions: async () => ({ pixelHeight: 1, pixelWidth: 2 }),
    source: { bytes: PNG_2.buffer.slice(0), kind: "bytes", mediaType: "image/png" },
    state: first,
  });
  return {
    assetPayloads: ingested.assetPayloads,
    bundle: ingested.bundle,
    fragmentMaterials: createStudioWaveFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1).state,
    svgAssets: includeSvg
      ? [
          await importStudioSvgPathAsset(
            new File(['<svg viewBox="0 0 3 2"><path d="M0 0 L3 0 L3 2 Z" fill="#38bdf8"/></svg>'], "diagram.svg", {
              type: "image/svg+xml",
            }),
          ),
        ]
      : [],
  };
}

describe("Studio-native local project persistence", () => {
  it("restores the verified PNG manifest, all owned bytes, and material state", async () => {
    const adapter = new MemoryAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    const state = await authoredState(true);
    const expectedBytes = new Map(
      state.assetPayloads.map((payload) => [payload.sha256, new Uint8Array(payload.bytes).slice()]),
    );

    await store.save(IDENTITY, state);
    new Uint8Array(state.assetPayloads[0]!.bytes)[0] = 0;

    const restored = await store.restore(IDENTITY);
    expect(restored?.bundle.assets).toEqual(state.bundle.assets);
    expect(restored?.assetPayloads).toHaveLength(2);
    for (const payload of restored!.assetPayloads) {
      expect(new Uint8Array(payload.bytes)).toEqual(expectedBytes.get(payload.sha256));
    }
    expect(restored?.fragmentMaterials).toEqual(state.fragmentMaterials);
    expect(restored?.svgAssets).toEqual(state.svgAssets);
    expect(restored).not.toHaveProperty("audioTrack");
  });

  it("saves and restores one WAV track with independent exact byte copies", async () => {
    const adapter = new ReferenceMemoryAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    const wavBytes = WAV.slice().buffer;
    const state = {
      ...(await authoredState()),
      audioTrack: {
        fileName: "narration take 2.wav",
        sourceSampleFrames: 24_000,
        timelineOffsetSampleFrames: 4_800,
        trimEndSampleFrames: 19_200,
        trimStartSampleFrames: 2_400,
        wavBytes,
      },
    };
    const expectedBytes = WAV.slice();

    await store.save(IDENTITY, state);
    const persisted = adapter.records.get(key(IDENTITY)) as {
      audioTrack: {
        fileName: string;
        sourceSampleFrames: number;
        timelineOffsetSampleFrames: number;
        trimEndSampleFrames: number;
        trimStartSampleFrames: number;
        wavBytes: ArrayBuffer;
      };
      version: number;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.audioTrack.fileName).toBe("narration take 2.wav");
    expect(persisted.audioTrack).toMatchObject({
      sourceSampleFrames: 24_000,
      timelineOffsetSampleFrames: 4_800,
      trimEndSampleFrames: 19_200,
      trimStartSampleFrames: 2_400,
    });
    expect(persisted.audioTrack.wavBytes).not.toBe(wavBytes);
    expect(new Uint8Array(persisted.audioTrack.wavBytes)).toEqual(expectedBytes);

    new Uint8Array(wavBytes).fill(0);
    expect(new Uint8Array(persisted.audioTrack.wavBytes)).toEqual(expectedBytes);

    const restored = await store.restore(IDENTITY);
    expect(restored?.audioTrack?.fileName).toBe("narration take 2.wav");
    expect(restored?.audioTrack).toMatchObject({
      sourceSampleFrames: 24_000,
      timelineOffsetSampleFrames: 4_800,
      trimEndSampleFrames: 19_200,
      trimStartSampleFrames: 2_400,
    });
    expect(restored?.audioTrack?.wavBytes).not.toBe(persisted.audioTrack.wavBytes);
    expect(new Uint8Array(restored!.audioTrack!.wavBytes)).toEqual(expectedBytes);

    new Uint8Array(restored!.audioTrack!.wavBytes).fill(0xff);
    expect(new Uint8Array(persisted.audioTrack.wavBytes)).toEqual(expectedBytes);
  });

  it("restores a legacy byte-only WAV as an untrimmed track at Scene time zero", async () => {
    const adapter = new ReferenceMemoryAdapter();
    const store = new NativeProjectLocalStore(adapter, async () => ({ pixelHeight: 1, pixelWidth: 2 }));
    await store.save(IDENTITY, await authoredState());
    const record = adapter.records.get(key(IDENTITY)) as Record<string, unknown>;
    adapter.records.set(key(IDENTITY), {
      ...record,
      audioTrack: { fileName: "legacy.wav", wavBytes: WAV.slice().buffer },
    });

    await expect(store.restore(IDENTITY)).resolves.toMatchObject({
      audioTrack: {
        fileName: "legacy.wav",
        sourceSampleFrames: null,
        timelineOffsetSampleFrames: 0,
        trimEndSampleFrames: null,
        trimStartSampleFrames: 0,
      },
    });
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
      svgAssets: [],
    });
  });
});
