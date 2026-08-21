import { z } from "zod";

import {
  inspectStudioSvgPathAsset,
  type StudioSvgPathAssetInspection,
  studioSvgPathAssetInspectionSchema,
} from "../engine/svg-path-asset";

export const MAX_STUDIO_SVG_SOURCE_BYTES = 256 * 1024;

const studioSvgPathAssetSchema = z
  .object({
    dimensions: studioSvgPathAssetInspectionSchema.shape.dimensions,
    hasFill: z.boolean(),
    hasStroke: z.boolean(),
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(240),
    segmentCount: studioSvgPathAssetInspectionSchema.shape.segmentCount,
    source: z.string().min(1).max(MAX_STUDIO_SVG_SOURCE_BYTES),
    subpathCount: studioSvgPathAssetInspectionSchema.shape.subpathCount,
  })
  .strict();

export type StudioSvgPathAsset = z.infer<typeof studioSvgPathAssetSchema>;

function exactInspection(asset: StudioSvgPathAsset, inspection: StudioSvgPathAssetInspection) {
  return (
    asset.dimensions.height === inspection.dimensions.height &&
    asset.dimensions.width === inspection.dimensions.width &&
    asset.hasFill === inspection.hasFill &&
    asset.hasStroke === inspection.hasStroke &&
    asset.segmentCount === inspection.segmentCount &&
    asset.subpathCount === inspection.subpathCount
  );
}

function sourceByteLength(source: string) {
  return new TextEncoder().encode(source).byteLength;
}

function assertBoundedSource(source: string) {
  const byteLength = sourceByteLength(source);
  if (byteLength === 0 || byteLength > MAX_STUDIO_SVG_SOURCE_BYTES) {
    throw new TypeError(`An SVG path asset must contain between 1 and ${MAX_STUDIO_SVG_SOURCE_BYTES} UTF-8 bytes.`);
  }
}

/** Imports one file only after the canonical Rust parser accepts its complete SVG source. */
export async function importStudioSvgPathAsset(file: Pick<File, "arrayBuffer" | "name" | "size">) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_STUDIO_SVG_SOURCE_BYTES) {
    throw new TypeError(`An SVG path asset must contain between 1 and ${MAX_STUDIO_SVG_SOURCE_BYTES} bytes.`);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new TypeError("The selected SVG changed size while Studio was reading it.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError("SVG path assets must use valid UTF-8.", { cause });
  }
  assertBoundedSource(source);
  const inspection = await inspectStudioSvgPathAsset(source);
  return studioSvgPathAssetSchema.parse({
    ...inspection,
    id: `svg-path:${crypto.randomUUID()}`,
    label: file.name.trim() || "vector.svg",
    source,
  });
}

export function parseStudioSvgPathAssets(value: unknown): readonly StudioSvgPathAsset[] {
  return z.array(studioSvgPathAssetSchema).max(128).parse(value);
}

/** Revalidates persisted source through Rust before exposing it to Assets or authoring. */
export async function restoreStudioSvgPathAssets(value: unknown): Promise<readonly StudioSvgPathAsset[]> {
  const assets = parseStudioSvgPathAssets(value ?? []);
  const inspections = await Promise.all(
    assets.map(async (asset) => {
      assertBoundedSource(asset.source);
      return inspectStudioSvgPathAsset(asset.source);
    }),
  );
  if (assets.some((asset, index) => !exactInspection(asset, inspections[index]!))) {
    throw new TypeError("A stored SVG path asset no longer matches the canonical Rust inspection.");
  }
  return assets;
}

export function studioSvgPathAssetsMatchingQuery(
  assets: readonly StudioSvgPathAsset[],
  query: string,
): readonly StudioSvgPathAsset[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return assets;
  return assets.filter((asset) =>
    `${asset.label} ${asset.subpathCount} subpaths ${asset.segmentCount} segments`.toLowerCase().includes(normalized),
  );
}
