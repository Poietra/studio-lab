import {
  type AssetManifestV1,
  assetManifestV1Schema,
  digestAssetManifestV1,
  MAX_IMAGE_PIXELS,
  type PngAssetV1,
  pngAssetV1Schema,
} from "../engine/asset-manifest";
import {
  type CanvasPngAssetTransferV1,
  type CanvasPngDimensionDecoderV1,
  canvasPngAssetTransfersV1Schema,
  decodeCanvasPngDimensionsV1,
  prepareCanvasPngAssetTransfersV1,
} from "../engine/canvas-png-assets";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";

export const MAX_NATIVE_PROJECT_PNG_BYTES_V1 = 16 * 1024 * 1024;
export const NATIVE_PROJECT_IMAGE_FILE_ACCEPT_V1 = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

const PNG_MEDIA_TYPE = "image/png";
const JPEG_MEDIA_TYPE = "image/jpeg";
const WEBP_MEDIA_TYPE = "image/webp";
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZERO_SHA256 = "0".repeat(64);

export type NativeProjectAssetStateV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
}>;

export type NativeProjectPngSourceV1 =
  | Readonly<{
      file: Pick<File, "arrayBuffer" | "size">;
      kind: "file";
    }>
  | Readonly<{
      bytes: ArrayBuffer;
      kind: "bytes";
      mediaType: string;
    }>;

export type NativeProjectPngIngressResultV1 = NativeProjectAssetStateV1 &
  Readonly<{
    asset: PngAssetV1;
    added: boolean;
  }>;

export class NativeProjectAssetValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeProjectAssetValidationError";
  }
}

type SupportedBrowserImageKind = "jpeg" | "png" | "webp";

function supportedBrowserImageKind(file: Pick<File, "name" | "type">): SupportedBrowserImageKind | null {
  const mediaType = file.type.trim().toLowerCase();
  if (mediaType === PNG_MEDIA_TYPE) return "png";
  if (mediaType === JPEG_MEDIA_TYPE || mediaType === "image/jpg") return "jpeg";
  if (mediaType === WEBP_MEDIA_TYPE) return "webp";
  if (mediaType.length > 0) return null;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpeg";
  if (name.endsWith(".webp")) return "webp";
  return null;
}

async function browserImageFileAsPngBytesV1(file: File) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new NativeProjectAssetValidationError("This browser cannot decode JPEG or WebP images for Studio.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (cause) {
    throw new NativeProjectAssetValidationError("Studio could not decode the selected JPEG or WebP image.", {
      cause,
    });
  }
  try {
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      bitmap.width * bitmap.height > MAX_IMAGE_PIXELS
    ) {
      throw new NativeProjectAssetValidationError(
        `A decoded Studio-native image must contain between 1 and ${MAX_IMAGE_PIXELS} pixels.`,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new NativeProjectAssetValidationError("This browser cannot create a canvas for Studio image import.");
    }
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new NativeProjectAssetValidationError("Studio could not encode the decoded image as PNG.")),
        PNG_MEDIA_TYPE,
      ),
    );
    return await png.arrayBuffer();
  } catch (cause) {
    if (cause instanceof NativeProjectAssetValidationError) throw cause;
    throw new NativeProjectAssetValidationError("Studio could not normalize the selected image as PNG.", { cause });
  } finally {
    bitmap.close();
  }
}

/** Keeps PNG input byte-identical and normalizes JPEG/WebP through the
 * browser's decoder before entering the existing canonical PNG pipeline. */
export async function normalizeNativeProjectImageFileV1(
  file: File,
  transcode: (file: File) => Promise<ArrayBuffer> = browserImageFileAsPngBytesV1,
): Promise<NativeProjectPngSourceV1> {
  const kind = supportedBrowserImageKind(file);
  if (!kind) {
    throw new NativeProjectAssetValidationError("Studio image import supports PNG, JPEG, and WebP files.");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_NATIVE_PROJECT_PNG_BYTES_V1) {
    throw new NativeProjectAssetValidationError(
      `A Studio image input must contain between 1 and ${MAX_NATIVE_PROJECT_PNG_BYTES_V1} bytes.`,
    );
  }
  if (kind === "png") return { file, kind: "file" };
  return { bytes: await transcode(file), kind: "bytes", mediaType: PNG_MEDIA_TYPE };
}

function copyFixedBytes(bytes: ArrayBuffer) {
  try {
    return bytes.slice(0);
  } catch (cause) {
    throw new NativeProjectAssetValidationError("The PNG bytes are detached or cannot be copied.", { cause });
  }
}

function assertPngMediaType(mediaType: string) {
  if (mediaType !== PNG_MEDIA_TYPE) {
    throw new NativeProjectAssetValidationError("Studio-native image assets must use the image/png media type.");
  }
}

function assertBoundedByteLength(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_NATIVE_PROJECT_PNG_BYTES_V1) {
    throw new NativeProjectAssetValidationError(
      `A Studio-native PNG must contain between 1 and ${MAX_NATIVE_PROJECT_PNG_BYTES_V1} bytes.`,
    );
  }
}

function assertPngSignature(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PNG_SIGNATURE.length));
  if (view.length !== PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => view[index] !== byte)) {
    throw new NativeProjectAssetValidationError("The selected bytes do not carry the PNG file signature.");
  }
}

async function readOwnedPngBytes(source: NativeProjectPngSourceV1) {
  const declaredByteLength = source.kind === "file" ? source.file.size : source.bytes.byteLength;
  if (source.kind === "bytes") assertPngMediaType(source.mediaType);
  assertBoundedByteLength(declaredByteLength);

  let loaded: ArrayBuffer;
  try {
    loaded = source.kind === "file" ? await source.file.arrayBuffer() : source.bytes;
  } catch (cause) {
    throw new NativeProjectAssetValidationError("Studio could not read the selected PNG bytes.", { cause });
  }
  if (loaded.byteLength !== declaredByteLength) {
    throw new NativeProjectAssetValidationError("The selected PNG changed size while Studio was reading it.");
  }
  const owned = copyFixedBytes(loaded);
  assertBoundedByteLength(owned.byteLength);
  assertPngSignature(owned);
  return owned;
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nativeProjectPngAssetIdV1(digest: string) {
  return `asset:studio-png:${digest}`;
}

function samePngContentMetadata(left: PngAssetV1, right: PngAssetV1) {
  return (
    left.byteLength === right.byteLength &&
    left.pixelHeight === right.pixelHeight &&
    left.pixelWidth === right.pixelWidth &&
    left.sha256 === right.sha256
  );
}

async function verifiedUpdatedManifest(bundle: SceneIrBundleV1, asset: PngAssetV1) {
  const existing = bundle.assets.assets.find((candidate) => candidate.sha256 === asset.sha256);
  if (existing && !samePngContentMetadata(existing, asset)) {
    throw new NativeProjectAssetValidationError(
      `PNG digest ${asset.sha256} conflicts with immutable metadata already present in this project.`,
    );
  }
  const collidingId = bundle.assets.assets.find((candidate) => candidate.id === asset.id);
  if (collidingId && collidingId.sha256 !== asset.sha256) {
    throw new NativeProjectAssetValidationError(`PNG asset ID ${asset.id} already refers to different content.`);
  }
  const selected = existing ?? asset;
  const assets = existing
    ? bundle.assets.assets
    : [...bundle.assets.assets, asset].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const draft = assetManifestV1Schema.parse({
    ...bundle.assets,
    assets,
    manifestDigest: ZERO_SHA256,
  } satisfies AssetManifestV1);
  const manifest = assetManifestV1Schema.parse({
    ...draft,
    manifestDigest: await digestAssetManifestV1(draft),
  });
  return { added: existing === undefined, manifest, selected } as const;
}

/**
 * Adds one browser-local PNG to the canonical Scene bundle and its retained
 * payload set. The function has no storage side effects: callers commit the
 * returned pair only after the whole contract has been verified.
 */
export async function ingestNativeProjectPngV1(
  input: Readonly<{
    decodeDimensions?: CanvasPngDimensionDecoderV1;
    source: NativeProjectPngSourceV1;
    state: NativeProjectAssetStateV1;
  }>,
): Promise<NativeProjectPngIngressResultV1> {
  const decodeDimensions = input.decodeDimensions ?? decodeCanvasPngDimensionsV1;
  let currentBundle: SceneIrBundleV1;
  let currentPayloads: readonly CanvasPngAssetTransferV1[];
  try {
    currentBundle = await parseVerifiedSceneIrBundleV1(input.state.bundle);
    if (currentBundle.scene.source.kind !== "studio-edit-program") {
      throw new TypeError("Only a Studio-native Scene may admit browser-local assets.");
    }
    currentPayloads = (
      await prepareCanvasPngAssetTransfersV1({
        decodeDimensions,
        manifest: currentBundle.assets,
        payloads: input.state.assetPayloads,
      })
    ).transfers;
  } catch (cause) {
    throw new NativeProjectAssetValidationError("The current Studio-native asset state is not canonical.", {
      cause,
    });
  }

  const bytes = await readOwnedPngBytes(input.source);
  let dimensions: Awaited<ReturnType<CanvasPngDimensionDecoderV1>>;
  let digest: string;
  try {
    [dimensions, digest] = await Promise.all([decodeDimensions(new Uint8Array(bytes)), sha256(bytes)]);
  } catch (cause) {
    throw new NativeProjectAssetValidationError("Studio could not decode and verify the selected PNG.", { cause });
  }
  if (
    !Number.isSafeInteger(dimensions.pixelWidth) ||
    !Number.isSafeInteger(dimensions.pixelHeight) ||
    dimensions.pixelWidth <= 0 ||
    dimensions.pixelHeight <= 0 ||
    dimensions.pixelWidth * dimensions.pixelHeight > MAX_IMAGE_PIXELS
  ) {
    throw new NativeProjectAssetValidationError(
      `A decoded Studio-native image must contain between 1 and ${MAX_IMAGE_PIXELS} pixels.`,
    );
  }

  let incoming: PngAssetV1;
  try {
    incoming = pngAssetV1Schema.parse({
      alphaMode: "straight",
      byteLength: bytes.byteLength,
      colorSpace: "srgb",
      id: nativeProjectPngAssetIdV1(digest),
      kind: "png-image",
      mediaType: PNG_MEDIA_TYPE,
      pixelHeight: dimensions.pixelHeight,
      pixelWidth: dimensions.pixelWidth,
      sha256: digest,
    });
  } catch (cause) {
    throw new NativeProjectAssetValidationError("The selected PNG exceeds the canonical asset contract.", { cause });
  }

  let updated: Awaited<ReturnType<typeof verifiedUpdatedManifest>>;
  try {
    updated = await verifiedUpdatedManifest(currentBundle, incoming);
  } catch (cause) {
    if (cause instanceof NativeProjectAssetValidationError) throw cause;
    throw new NativeProjectAssetValidationError("The PNG cannot be added to this project's asset manifest.", {
      cause,
    });
  }
  const candidateBundle = {
    assets: updated.manifest,
    scene: {
      ...currentBundle.scene,
      assetManifest: {
        manifestDigest: updated.manifest.manifestDigest,
        manifestId: updated.manifest.manifestId,
      },
    },
  };

  let bundle: SceneIrBundleV1;
  let assetPayloads: readonly CanvasPngAssetTransferV1[];
  try {
    bundle = await parseVerifiedSceneIrBundleV1(candidateBundle);
    const byDigest = new Map(currentPayloads.map((payload) => [payload.sha256, payload]));
    if (!byDigest.has(digest)) {
      byDigest.set(digest, {
        assetId: updated.selected.id,
        byteLength: bytes.byteLength,
        bytes,
        mediaType: PNG_MEDIA_TYPE,
        pixelHeight: dimensions.pixelHeight,
        pixelWidth: dimensions.pixelWidth,
        sha256: digest,
      });
    }
    assetPayloads = canvasPngAssetTransfersV1Schema.parse(
      bundle.assets.assets.map((asset) => byDigest.get(asset.sha256)),
    );
  } catch (cause) {
    throw new NativeProjectAssetValidationError("The updated native Scene and PNG payloads are not canonical.", {
      cause,
    });
  }

  return { added: updated.added, asset: updated.selected, assetPayloads, bundle };
}
