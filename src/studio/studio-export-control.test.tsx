import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  browserMp4ExportFileNameV1,
  browserMp4ExportProfileV1,
  DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
} from "../engine/browser-mp4-export";
import type { SceneIrBundleV1 } from "../engine/contracts";
import { EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1 } from "../engine/fragment-material-registry";
import { EMPTY_SCENE_POST_EFFECT_REGISTRY_V1 } from "../engine/scene-post-effect-registry";
import {
  completeBrowserMp4ExportV1,
  StudioExportControl,
  type StudioMp4ExportSourceV1,
  studioExportProgressPercentV1,
} from "./studio-export-control";
import type {
  CapturedStudioExportPublicationV1,
  StudioExportPublicationAvailabilityV1,
} from "./studio-export-publication";

const exportSource: StudioMp4ExportSourceV1 = {
  assetPayloads: [],
  bundle: { assets: {}, scene: { sceneId: "scene:shared_circle_opacity" } } as unknown as SceneIrBundleV1,
  fragmentMaterialRegistry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  scenePostEffectRegistry: EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  sourceLineage: {
    projectId: "project-a",
    sceneId: "scene:shared_circle_opacity",
    sceneName: "SharedCircleOpacity",
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    workingRevision: "pristine",
  },
};
const unavailablePublication: StudioExportPublicationAvailabilityV1 = {
  kind: "unavailable",
  reason: "Wait for the Editor Document lineage before publishing.",
};
const capturedPublication: CapturedStudioExportPublicationV1 = {
  context: {
    documentEpoch: "00000000-0000-4000-8000-000000000001",
    documentKey: "c".repeat(64),
    documentRevision: "0",
    organizationId: "organization-a",
    projectId: "project-a",
    sceneRevisionHash: "d".repeat(64),
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    workingRevision: "pristine",
  },
  publicationId: "00000000-0000-4000-8000-000000000002",
};

describe("studioExportProgressPercentV1", () => {
  it("reports bounded whole percentages and tolerates the empty grid", () => {
    expect(studioExportProgressPercentV1(null)).toBe(0);
    const progress = (framesEncoded: number, frameCount: number) =>
      ({ encodedMediaBytes: framesEncoded * 64, frameCount, framesEncoded, kind: "progress" }) as const;
    expect(studioExportProgressPercentV1(progress(0, 0))).toBe(0);
    expect(studioExportProgressPercentV1(progress(30, 60))).toBe(50);
    expect(studioExportProgressPercentV1(progress(59, 60))).toBe(98);
    expect(studioExportProgressPercentV1(progress(60, 60))).toBe(100);
    expect(studioExportProgressPercentV1(progress(120, 60))).toBe(100);
  });
});

describe("browserMp4ExportFileNameV1", () => {
  it("derives the sanitized scene download name and falls back honestly", () => {
    expect(browserMp4ExportFileNameV1("shared-circle-opacity")).toBe("shared-circle-opacity.mp4");
    expect(browserMp4ExportFileNameV1("scene:shared circle")).toBe("scene-shared-circle.mp4");
    expect(browserMp4ExportFileNameV1("---")).toBe("poietra-scene.mp4");
    expect(browserMp4ExportFileNameV1("")).toBe("poietra-scene.mp4");
  });
});

describe("completeBrowserMp4ExportV1", () => {
  it("keeps the local download successful when publication preparation fails", async () => {
    const calls: string[] = [];
    const completion = await completeBrowserMp4ExportV1({
      capturedAvailability: unavailablePublication,
      capturedPublication,
      deliverLocal: () => calls.push("download"),
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      publicationCaptureFailure: null,
      preparePublication: async () => {
        calls.push("digest");
        throw new Error("WebCrypto unavailable");
      },
      video: new Uint8Array([1, 2, 3]),
    });

    expect(calls).toEqual(["download", "digest"]);
    expect(completion).toEqual({
      artifact: null,
      state: { kind: "failed", message: "WebCrypto unavailable" },
    });
  });

  it("delivers locally even when publication identity capture failed", async () => {
    let delivered = false;
    const completion = await completeBrowserMp4ExportV1({
      capturedAvailability: unavailablePublication,
      capturedPublication: null,
      deliverLocal: () => {
        delivered = true;
      },
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      publicationCaptureFailure: "UUID unavailable",
      video: new Uint8Array([1, 2, 3]),
    });

    expect(delivered).toBe(true);
    expect(completion.state).toEqual({ kind: "failed", message: "UUID unavailable" });
  });

  it("keeps a selected non-default profile in publication metadata", async () => {
    const profile = browserMp4ExportProfileV1({ frameRate: 60, resolution: "1280x720" });
    const completion = await completeBrowserMp4ExportV1({
      capturedAvailability: unavailablePublication,
      capturedPublication,
      deliverLocal: () => undefined,
      profile,
      publicationCaptureFailure: null,
      video: new Uint8Array([1, 2, 3]),
    });

    expect(completion.artifact?.metadata.exportProfile).toEqual(profile);
    expect(completion.artifact?.metadata.encoderEvidence).toMatchObject({
      frameRate: 60,
      resolution: "1280x720",
    });
    expect(completion.state).toEqual({ kind: "ready" });
  });
});

describe("StudioExportControl", () => {
  it("renders an honestly disabled affordance without a presented Scene", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl exportSource={null} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="unavailable"');
    expect(markup).toContain("Export MP4");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain(">Cancel<");
    expect(markup).toContain("Wait for the canonical WebGPU preview before exporting.");
    expect(markup).toContain("Wait for the Editor Document lineage before publishing.");
  });

  it("offers an enabled export without a Cancel affordance while idle", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl exportSource={exportSource} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*>Export MP4<\/button>/u);
    expect(markup).not.toContain(">Cancel<");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('role="status"');
    expect(markup).toContain(">Publish MP4</button>");
    expect(markup).toContain(">Choose WAV</button>");
    expect(markup).toContain('accept=".wav,audio/wav,audio/x-wav"');
    expect(markup).toContain('for="studio-export-resolution"');
    expect(markup).toContain('id="studio-export-resolution"');
    expect(markup).toContain(">Resolution<select");
    expect(markup).toContain('<option value="854x480" selected="">480p</option>');
    expect(markup).toContain('<option value="1280x720">720p</option>');
    expect(markup).toContain('<option value="1920x1080">1080p</option>');
    expect(markup).toContain('for="studio-export-frame-rate"');
    expect(markup).toContain('id="studio-export-frame-rate"');
    expect(markup).toContain(">Frame rate<select");
    expect(markup).toContain('<option value="30" selected="">30 fps</option>');
    expect(markup).toContain('<option value="60">60 fps</option>');
    expect(markup).toContain('data-studio-export-profile="854x480@30"');
  });

  it("directs an empty Studio-native project to its Assets panel", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl audioTrack={null} exportSource={exportSource} publication={unavailablePublication} />,
    );

    expect(markup).toContain("No project audio is attached");
    expect(markup).not.toContain("Choose WAV");
  });

  it("reports the project audio that will be attached", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl
        audioTrack={{
          fileName: "narration.wav",
          sourceSampleFrames: 48_000,
          timelineOffsetSampleFrames: 0,
          trimEndSampleFrames: 48_000,
          trimStartSampleFrames: 0,
          volumePercent: 100,
          wavBytes: new ArrayBuffer(44),
        }}
        exportSource={exportSource}
        publication={unavailablePublication}
      />,
    );

    expect(markup).toContain("narration.wav");
    expect(markup).toContain("WAV audio exports are local-only in this release.");
    expect(markup).not.toContain("Choose WAV");
  });

  it("stays disabled while the surrounding session transition locks the header", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl disabled exportSource={exportSource} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Export is unavailable while the Editor session changes.");
  });
});
