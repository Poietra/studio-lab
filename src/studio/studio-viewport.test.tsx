import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./studio-canvas", () => ({
  StudioCanvas: ({ onImageAssetDrop }: Readonly<{ onImageAssetDrop?: unknown }>) => (
    <div data-image-asset-drop={onImageAssetDrop ? "forwarded" : "missing"} />
  ),
}));

vi.mock("./studio-timeline", () => ({ StudioTimeline: () => null }));
vi.mock("./studio-toolbar", () => ({ StudioToolbar: () => null }));

import { createStudioGesturePreviewStore } from "./studio-gesture-preview-store";
import { StudioViewport, type StudioViewportProps } from "./studio-viewport";

describe("StudioViewport", () => {
  it("forwards image asset drops to the production Canvas boundary", () => {
    const markup = renderToStaticMarkup(
      <StudioViewport
        {...({
          gesturePreviewStore: createStudioGesturePreviewStore(),
          insertTool: "select",
          insertValue: "",
          onImageAssetDrop: vi.fn(),
          previewPaintAvailable: true,
          projection: {
            camera: { scale: 1 },
            canvas: { sampleId: "sample" },
            timeline: { events: [], objectTracks: [] },
          },
          selectedIds: new Set(),
          selectionLayoutUnavailableReason: null,
        } as unknown as StudioViewportProps)}
      />,
    );

    expect(markup).toContain('data-image-asset-drop="forwarded"');
  });
});
