import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SceneIrBundleV1 } from "../engine/contracts";
import { MAX_EXPORT_DURATION_SECONDS, MAX_EXPORT_OUTPUT_BYTES } from "../engine/export-profile";
import { studioMp4ExportFileNameV1 } from "../engine/export-session-client";
import {
  StudioExportControl,
  type StudioMp4ExportSourceV1,
  studioExportProfileV1,
  studioExportProgressPercentV1,
} from "./studio-export-control";

const exportSource: StudioMp4ExportSourceV1 = {
  assetPayloads: [],
  bundle: { assets: {}, scene: {} } as unknown as SceneIrBundleV1,
  revision: "a".repeat(64),
};

describe("studioExportProfileV1", () => {
  it("builds the closed default 30 fps H.264 profile for the chosen rung", () => {
    expect(studioExportProfileV1("854x480")).toEqual({
      codec: "h264-mp4",
      colorContractVersion: 1,
      frameRate: 30,
      maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS,
      maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
      resolution: "854x480",
      schema: "poietra.export-profile",
      version: 1,
    });
    expect(studioExportProfileV1("1920x1080").resolution).toBe("1920x1080");
  });
});

describe("studioExportProgressPercentV1", () => {
  it("reports bounded whole percentages and tolerates the empty grid", () => {
    expect(studioExportProgressPercentV1(null)).toBe(0);
    const progress = (framesEncoded: number, frameCount: number) =>
      ({ chunksMuxed: framesEncoded, frameCount, framesEncoded, kind: "progress", muxedMediaBytes: 1 }) as const;
    expect(studioExportProgressPercentV1(progress(0, 0))).toBe(0);
    expect(studioExportProgressPercentV1(progress(30, 60))).toBe(50);
    expect(studioExportProgressPercentV1(progress(60, 60))).toBe(100);
  });
});

describe("studioMp4ExportFileNameV1", () => {
  it("derives a sanitized mp4 name and falls back honestly", () => {
    expect(studioMp4ExportFileNameV1("Opening Scene v2")).toBe("poietra-Opening-Scene-v2.mp4");
    expect(studioMp4ExportFileNameV1("../..//etc passwd")).toBe("poietra-etc-passwd.mp4");
    expect(studioMp4ExportFileNameV1(null)).toBe("poietra-scene.mp4");
    expect(studioMp4ExportFileNameV1("---")).toBe("poietra-scene.mp4");
  });
});

describe("StudioExportControl", () => {
  it("renders an honestly disabled affordance without a presented Scene", () => {
    const markup = renderToStaticMarkup(<StudioExportControl exportSource={null} fileBaseName="Opening" />);
    expect(markup).toContain('data-studio-export-mp4-state="unavailable"');
    expect(markup).toContain("Export requires an exactly presented verified preview.");
    expect(markup).toContain("Export MP4");
    const disabledButtons = markup.match(/disabled=""/g) ?? [];
    expect(disabledButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("offers the closed resolution ladder with the 854x480 default while presentable", () => {
    const markup = renderToStaticMarkup(<StudioExportControl exportSource={exportSource} fileBaseName="Opening" />);
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    expect(markup).toContain('selected=""');
    expect(markup).toContain(">854x480<");
    expect(markup).toContain(">1280x720<");
    expect(markup).toContain(">1920x1080<");
    expect(markup).not.toContain('disabled=""');
  });

  it("stays disabled while the surrounding session transition locks the header", () => {
    const markup = renderToStaticMarkup(
      <StudioExportControl disabled exportSource={exportSource} fileBaseName="Opening" />,
    );
    expect(markup).toContain('data-studio-export-mp4-state="idle"');
    const disabledButtons = markup.match(/disabled=""/g) ?? [];
    expect(disabledButtons.length).toBeGreaterThanOrEqual(2);
  });
});
