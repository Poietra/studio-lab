import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { browserMp4ExportFileNameV1 } from "../engine/browser-mp4-export";
import type { SceneIrBundleV1 } from "../engine/contracts";
import {
  StudioExportControl,
  type StudioMp4ExportSourceV1,
  studioExportProgressPercentV1,
} from "./studio-export-control";
import type { StudioExportPublicationAvailabilityV1 } from "./studio-export-publication";

const exportSource: StudioMp4ExportSourceV1 = {
  assetPayloads: [],
  bundle: { assets: {}, scene: { sceneId: "scene:shared_circle_opacity" } } as unknown as SceneIrBundleV1,
  sourceLineage: {
    projectId: "project-a",
    sceneId: "scene:shared_circle_opacity",
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    workingRevision: "pristine",
  },
};
const unavailablePublication: StudioExportPublicationAvailabilityV1 = {
  kind: "unavailable",
  reason: "Wait for the Editor Document lineage before publishing.",
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

describe("StudioExportControl", () => {
  it("renders an honestly disabled affordance without a presented Scene", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl exportSource={null} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="unavailable"');
    expect(markup).toContain("Export MP4");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain(">Cancel<");
    expect(markup).toContain("Publish MP4 unavailable: Wait for the Editor Document lineage before publishing.");
  });

  it("offers an enabled export without a Cancel affordance while idle", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl exportSource={exportSource} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*>Export MP4<\/button>/u);
    expect(markup).not.toContain(">Cancel<");
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain(">Publish</button>");
  });

  it("stays disabled while the surrounding session transition locks the header", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl disabled exportSource={exportSource} publication={unavailablePublication} />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    expect(markup).toContain('disabled=""');
  });
});
