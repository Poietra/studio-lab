import type { ClientExportFinalizeMetadataV1 } from "../collaboration/client-export-http-contract";
import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import type { SceneIrBundleV1 } from "../engine/contracts";
import type { ExportProfileV1 } from "../engine/export-profile";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import type { EditorDocumentExportLineageV1 } from "./use-editor-document-authority";

export type StudioMp4ExportSourceV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
  /** Exact imported-source context that produced this presented Scene. */
  sourceLineage: Readonly<{
    projectId: string;
    sceneId: string;
    sceneName: string;
    sourceHash: string;
    sourcePath: string;
    workingRevision: string;
  }>;
}>;

export type StudioExportPublicationContextV1 = Readonly<{
  documentEpoch: string;
  documentKey: string;
  documentRevision: string;
  organizationId: string;
  projectId: string;
  sceneRevisionHash: string;
  sourceHash: string;
  sourcePath: string;
  workingRevision: string;
}>;

export type StudioExportPublicationAvailabilityV1 =
  | Readonly<{ context: StudioExportPublicationContextV1; kind: "available" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * Joins the exact presented Scene to the exact durable Editor Document head.
 * A local MP4 may still be exported when this join fails; only publication is
 * disabled because no later async read may repair missing lineage safely.
 */
export function resolveStudioExportPublicationAvailabilityV1(
  input: Readonly<{
    exportSource: StudioMp4ExportSourceV1 | null;
    lineage: EditorDocumentExportLineageV1 | null;
    organizationId: string | null;
  }>,
): StudioExportPublicationAvailabilityV1 {
  if (!input.organizationId) {
    return { kind: "unavailable", reason: "Sign in to publish this local export." };
  }
  if (!input.exportSource) {
    return { kind: "unavailable", reason: "Wait for the canonical preview before publishing." };
  }
  if (!input.lineage) {
    return { kind: "unavailable", reason: "Wait for the Editor Document lineage before publishing." };
  }
  const { sourceLineage } = input.exportSource;
  if (
    input.lineage.projectId !== sourceLineage.projectId ||
    input.lineage.sceneName !== sourceLineage.sceneName ||
    input.lineage.sourceHash !== sourceLineage.sourceHash ||
    input.lineage.sourcePath !== sourceLineage.sourcePath
  ) {
    return { kind: "unavailable", reason: "The preview no longer matches the active Editor Document." };
  }
  if (input.lineage.workingRevision !== sourceLineage.workingRevision) {
    return {
      kind: "unavailable",
      reason: "Apply or discard pending Studio edits before publishing this export.",
    };
  }
  if (input.exportSource.bundle.scene.sceneId !== sourceLineage.sceneId) {
    return { kind: "unavailable", reason: "The preview Scene identity is no longer current." };
  }
  return {
    context: Object.freeze({
      documentEpoch: input.lineage.documentEpoch,
      documentKey: input.lineage.documentKey,
      documentRevision: input.lineage.documentRevision,
      organizationId: input.organizationId,
      projectId: sourceLineage.projectId,
      sceneRevisionHash: sceneIrSourceRevisionHash(input.exportSource.bundle.scene),
      sourceHash: sourceLineage.sourceHash,
      sourcePath: sourceLineage.sourcePath,
      workingRevision: sourceLineage.workingRevision,
    }),
    kind: "available",
  };
}

export type CapturedStudioExportPublicationV1 = Readonly<{
  context: StudioExportPublicationContextV1;
  publicationId: string;
}>;

/** Called synchronously by the Export click before the encoder can yield. */
export function captureStudioExportPublicationV1(
  availability: StudioExportPublicationAvailabilityV1,
  mintPublicationId: () => string = () => globalThis.crypto.randomUUID(),
): CapturedStudioExportPublicationV1 | null {
  if (availability.kind !== "available") return null;
  return Object.freeze({ context: availability.context, publicationId: mintPublicationId() });
}

export type PreparedStudioExportPublicationV1 = Readonly<{
  identity: Readonly<{ organizationId: string; projectId: string }>;
  metadata: ClientExportFinalizeMetadataV1;
  video: Uint8Array<ArrayBuffer>;
}>;

function browserEncoderEvidenceV1(profile: ExportProfileV1) {
  return {
    codec: profile.codec,
    frameRate: profile.frameRate,
    resolution: profile.resolution,
    schema: "poietra.browser-webcodecs-encoder-evidence",
    version: 1,
  } as const;
}

async function sha256HexV1(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Binds finalized bytes to the lineage captured before encoding began. */
export async function prepareStudioExportPublicationV1(
  capture: CapturedStudioExportPublicationV1,
  profile: ExportProfileV1,
  video: Uint8Array<ArrayBuffer>,
): Promise<PreparedStudioExportPublicationV1> {
  // `video` is the private ArrayBuffer materialized once from the finalized
  // Blob by StudioExportControl; retaining it avoids another up-to-128 MiB copy.
  const exactVideo = video;
  const { context } = capture;
  return Object.freeze({
    identity: Object.freeze({ organizationId: context.organizationId, projectId: context.projectId }),
    metadata: Object.freeze({
      byteSize: exactVideo.byteLength,
      contentDigest: await sha256HexV1(exactVideo),
      documentEpoch: context.documentEpoch,
      documentKey: context.documentKey,
      documentRevision: context.documentRevision,
      encoderEvidence: browserEncoderEvidenceV1(profile),
      exportProfile: profile,
      projectId: context.projectId,
      publicationId: capture.publicationId,
      schema: "poietra.client-export-finalize",
      sceneRevisionHash: context.sceneRevisionHash,
      version: 1,
    }),
    video: exactVideo,
  });
}
