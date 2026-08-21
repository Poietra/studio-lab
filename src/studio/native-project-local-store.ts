import { editorDocumentKeySchemaV1 } from "../collaboration/editor-document-http-contract";
import {
  type CanvasPngAssetTransferV1,
  type CanvasPngDimensionDecoderV1,
  canvasPngAssetTransfersV1Schema,
  prepareCanvasPngAssetTransfersV1,
} from "../engine/canvas-png-assets";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import {
  type ProjectFragmentMaterialStateV1,
  projectFragmentMaterialStateV1Schema,
} from "./fragment-material-authoring";
import { parseStudioSvgPathAssets, restoreStudioSvgPathAssets, type StudioSvgPathAsset } from "./studio-svg-assets";

const DATABASE_NAME = "poietra-studio-native-projects";
const DATABASE_VERSION = 1;
const DOCUMENT_STORE = "documents";
const PROJECT_INDEX = "projectId";

export type NativeProjectLocalIdentity = Readonly<{
  documentKey: string;
  projectId: string;
}>;

export type NativeProjectLocalState = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
  fragmentMaterials: ProjectFragmentMaterialStateV1;
  svgAssets: readonly StudioSvgPathAsset[];
}>;

type NativeProjectLocalRecord = NativeProjectLocalIdentity &
  NativeProjectLocalState &
  Readonly<{
    version: 1;
  }>;

export interface NativeProjectLocalStorageAdapter {
  deleteProject(projectId: string): Promise<void>;
  read(identity: NativeProjectLocalIdentity): Promise<unknown | null>;
  write(record: NativeProjectLocalRecord): Promise<void>;
}

function parseIdentity(identity: NativeProjectLocalIdentity) {
  return {
    documentKey: editorDocumentKeySchemaV1.parse(identity.documentKey),
    projectId: manimProjectIdSchema.parse(identity.projectId),
  };
}

function copyAssetPayloads(payloads: readonly CanvasPngAssetTransferV1[]) {
  return canvasPngAssetTransfersV1Schema.parse(
    payloads.map((payload) => ({ ...payload, bytes: payload.bytes.slice(0) })),
  );
}

/** Browser-local persistence for native PNGs and their material state. Editor
 * Programs remain in EditorSessionStore; raw image bytes only cross this
 * IndexedDB-backed boundary. */
export class NativeProjectLocalStore {
  private pendingMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: NativeProjectLocalStorageAdapter,
    private readonly decodeDimensions?: CanvasPngDimensionDecoderV1,
  ) {}

  async restore(identityValue: NativeProjectLocalIdentity): Promise<NativeProjectLocalState | null> {
    const identity = parseIdentity(identityValue);
    await this.pendingMutation;
    const value = await this.adapter.read(identity);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<NativeProjectLocalRecord>;
    if (
      record.version !== 1 ||
      record.projectId !== identity.projectId ||
      record.documentKey !== identity.documentKey
    ) {
      throw new TypeError("The stored native project does not match the requested document.");
    }
    const bundle = await parseVerifiedSceneIrBundleV1(record.bundle);
    if (
      bundle.scene.source.kind !== "studio-edit-program" ||
      bundle.scene.sceneId !== `native:${identity.documentKey}`
    ) {
      throw new TypeError("The stored native project Scene is not supported by this local document.");
    }
    const prepared = await prepareCanvasPngAssetTransfersV1({
      decodeDimensions: this.decodeDimensions,
      manifest: bundle.assets,
      payloads: record.assetPayloads,
    });
    return {
      assetPayloads: prepared.transfers,
      bundle,
      fragmentMaterials: projectFragmentMaterialStateV1Schema.parse(record.fragmentMaterials),
      svgAssets: await restoreStudioSvgPathAssets(record.svgAssets),
    };
  }

  async save(identityValue: NativeProjectLocalIdentity, state: NativeProjectLocalState) {
    const identity = parseIdentity(identityValue);
    if (
      state.bundle.scene.source.kind !== "studio-edit-program" ||
      state.bundle.scene.sceneId !== `native:${identity.documentKey}`
    ) {
      throw new TypeError("Only the current native document can be stored locally.");
    }
    const record = {
      ...identity,
      assetPayloads: copyAssetPayloads(state.assetPayloads),
      bundle: state.bundle,
      fragmentMaterials: projectFragmentMaterialStateV1Schema.parse(state.fragmentMaterials),
      svgAssets: parseStudioSvgPathAssets(state.svgAssets),
      version: 1 as const,
    };
    await this.enqueueMutation(() => this.adapter.write(record));
  }

  async deleteProject(projectIdValue: string) {
    const projectId = manimProjectIdSchema.parse(projectIdValue);
    await this.enqueueMutation(() => this.adapter.deleteProject(projectId));
  }

  private enqueueMutation(operation: () => Promise<void>) {
    const result = this.pendingMutation.then(operation, operation);
    this.pendingMutation = result.catch(() => undefined);
    return result;
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), {
      once: true,
    });
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
  });
}

class IndexedDbNativeProjectLocalStorageAdapter implements NativeProjectLocalStorageAdapter {
  constructor(private readonly factory: IDBFactory) {}

  async deleteProject(projectId: string) {
    const database = await this.open();
    try {
      const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
      const cursorRequest = transaction.objectStore(DOCUMENT_STORE).index(PROJECT_INDEX).openCursor(projectId);
      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      });
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async read(identity: NativeProjectLocalIdentity) {
    const database = await this.open();
    try {
      const transaction = database.transaction(DOCUMENT_STORE, "readonly");
      const request = transaction.objectStore(DOCUMENT_STORE).get([identity.projectId, identity.documentKey]);
      const [result] = await Promise.all([requestResult(request), transactionDone(transaction)]);
      return result ?? null;
    } finally {
      database.close();
    }
  }

  async write(record: NativeProjectLocalRecord) {
    const database = await this.open();
    try {
      const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
      transaction.objectStore(DOCUMENT_STORE).put(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private open() {
    const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(DOCUMENT_STORE, {
        keyPath: ["projectId", "documentKey"],
      });
      store.createIndex(PROJECT_INDEX, "projectId");
    });
    return requestResult(request);
  }
}

export function browserNativeProjectLocalStore(): NativeProjectLocalStore | null {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") return null;
  return new NativeProjectLocalStore(new IndexedDbNativeProjectLocalStorageAdapter(window.indexedDB));
}
