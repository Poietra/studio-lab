import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioExportPublicationAvailabilityV1 } from "./studio-export-publication";
import { StudioExportSettingsControl } from "./studio-export-settings-control";

const unavailablePublication: StudioExportPublicationAvailabilityV1 = {
  kind: "unavailable",
  reason: "Wait for the canonical preview before publishing.",
};

describe("StudioExportSettingsControl", () => {
  it("collects local export and publication actions behind one labelled dialog entry", () => {
    const markup = renderToStaticMarkup(
      <StudioExportSettingsControl exportSource={null} generateThumbnail={null} publication={unavailablePublication} />,
    );

    expect(markup).toMatch(
      /<button[^>]*aria-controls="studio-export-settings-dialog"[^>]*aria-haspopup="dialog"[^>]*>Export settings<\/button>/u,
    );
    expect(markup).toContain('<dialog aria-describedby="studio-export-settings-description"');
    expect(markup).toContain('aria-labelledby="studio-export-settings-title"');
    expect(markup).toContain('id="studio-export-settings-dialog"');
    expect(markup).toContain('id="studio-export-settings-title"');
    expect(markup).toContain("Video export");
    expect(markup).toContain("MP4 publishing");
    expect(markup).toContain("Project thumbnail");
    expect(markup).toContain('data-studio-export-mp4-state="unavailable"');
    expect(markup).toContain('data-studio-thumbnail-state="idle"');
  });

  it("locks the entry and nested actions during an Editor session transition", () => {
    const markup = renderToStaticMarkup(
      <StudioExportSettingsControl
        disabled
        exportSource={null}
        generateThumbnail={null}
        publication={unavailablePublication}
      />,
    );

    expect(markup).toMatch(/<button[^>]*aria-controls="studio-export-settings-dialog"[^>]*disabled=""/u);
    expect(markup).toContain("Export is unavailable while the Editor session changes.");
    expect(markup).toContain("Thumbnail updates are unavailable while the Editor session changes.");
  });
});
