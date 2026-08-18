import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_MP4_EXPORT_PROFILE } from "../engine/browser-mp4-export";
import type { SceneIrBundleV1 } from "../engine/contracts";
import { EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1 } from "../engine/fragment-material-registry";
import {
  captureStudioExportPublicationV1,
  prepareStudioExportPublicationV1,
  resolveStudioExportPublicationAvailabilityV1,
  type StudioMp4ExportSourceV1,
} from "./studio-export-publication";
import type { EditorDocumentExportLineageV1 } from "./use-editor-document-authority";

const SOURCE_HASH = "a".repeat(64);
const SCENE_REVISION = "b".repeat(64);
const PUBLICATION_ID = "00000000-0000-4000-8000-000000000002";

function exportSource(overrides: Partial<StudioMp4ExportSourceV1["sourceLineage"]> = {}): StudioMp4ExportSourceV1 {
  return {
    assetPayloads: [],
    bundle: {
      assets: {},
      scene: {
        sceneId: "scene:one",
        source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: SCENE_REVISION },
      },
    } as unknown as SceneIrBundleV1,
    fragmentMaterialRegistry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
    sourceLineage: {
      projectId: "project-a",
      sceneId: "scene:one",
      sceneName: "SceneOne",
      sourceHash: SOURCE_HASH,
      sourcePath: "scene.py",
      workingRevision: "working-7",
      ...overrides,
    },
  };
}

function lineage(overrides: Partial<EditorDocumentExportLineageV1> = {}): EditorDocumentExportLineageV1 {
  return {
    documentEpoch: "00000000-0000-4000-8000-000000000001",
    documentKey: "c".repeat(64),
    documentRevision: "7",
    projectId: "project-a",
    sceneName: "SceneOne",
    sourceHash: SOURCE_HASH,
    sourcePath: "scene.py",
    workingRevision: "working-7",
    ...overrides,
  };
}

function availability(source = exportSource(), documentLineage: EditorDocumentExportLineageV1 | null = lineage()) {
  return resolveStudioExportPublicationAvailabilityV1({
    exportSource: source,
    lineage: documentLineage,
    organizationId: "organization-a",
  });
}

describe("Studio client-export publication controller", () => {
  it("joins the exact presented Scene and durable Editor Document lineage", () => {
    expect(availability()).toEqual({
      context: {
        documentEpoch: "00000000-0000-4000-8000-000000000001",
        documentKey: "c".repeat(64),
        documentRevision: "7",
        organizationId: "organization-a",
        projectId: "project-a",
        sceneRevisionHash: SCENE_REVISION,
        sourceHash: SOURCE_HASH,
        sourcePath: "scene.py",
        workingRevision: "working-7",
      },
      kind: "available",
    });
  });

  it("fails publication closed when source, project, Scene, or working revision drifts", () => {
    expect(availability(exportSource({ sourceHash: "d".repeat(64) }))).toMatchObject({ kind: "unavailable" });
    expect(availability(exportSource({ projectId: "project-b" }))).toMatchObject({ kind: "unavailable" });
    expect(availability(exportSource({ sceneName: "SceneTwo" }))).toMatchObject({ kind: "unavailable" });
    expect(availability(exportSource({ sceneId: "scene:other" }))).toMatchObject({ kind: "unavailable" });
    expect(availability(exportSource({ workingRevision: "working-8" }))).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/apply or discard/i),
    });
  });

  it("captures the publication identity before encoding and binds exact finalized bytes to it", async () => {
    const resolved = availability();
    const captured = captureStudioExportPublicationV1(resolved, () => PUBLICATION_ID);
    expect(captured).not.toBeNull();
    const video = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    const prepared = await prepareStudioExportPublicationV1(captured!, DEFAULT_BROWSER_MP4_EXPORT_PROFILE, video);

    expect(prepared.identity).toEqual({ organizationId: "organization-a", projectId: "project-a" });
    expect(prepared.metadata).toMatchObject({
      byteSize: 8,
      documentRevision: "7",
      encoderEvidence: {
        codec: "h264-mp4",
        frameRate: 30,
        resolution: "854x480",
        schema: "poietra.browser-webcodecs-encoder-evidence",
        version: 1,
      },
      publicationId: PUBLICATION_ID,
      sceneRevisionHash: SCENE_REVISION,
    });
    expect(prepared.metadata.contentDigest).toBe(
      createHash("sha256")
        .update(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]))
        .digest("hex"),
    );
    expect(prepared.video).toBe(video);
    expect([...prepared.video]).toEqual([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  });

  it("does not mint a publication identity while lineage is unavailable", () => {
    let minted = 0;
    const capture = captureStudioExportPublicationV1(availability(exportSource(), null), () => {
      minted += 1;
      return PUBLICATION_ID;
    });
    expect(capture).toBeNull();
    expect(minted).toBe(0);
  });
});
