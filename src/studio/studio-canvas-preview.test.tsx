import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedEntity } from "./model";
import { StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
import type { StudioPreviewRendererViewV1 } from "./use-preview-renderer";

const CIRCLE_ENTITY: ProjectedEntity = {
  geometry: {
    dimensions: { kind: "known", value: { radius: 0.5 } },
    position: { kind: "known", value: { x: 320, y: 180 } },
    scale: { kind: "known", value: 1 },
    style: { kind: "known", value: {} },
  },
  id: "entity:circle_1",
  opacity: 1,
  position: { x: 320, y: 180 },
  present: true,
  provisional: false,
  scale: 1,
  sourceIdentity: { kind: "known", value: "circle_1" },
  type: "Circle",
};

function baseProps(): StudioCanvasProps {
  return {
    appliedTransactionIds: new Set<string>(),
    boundaryActive: false,
    cameraScale: 1,
    draftTransactionId: null,
    dragPreview: null,
    editableMotionIds: new Set<string>(),
    entities: [CIRCLE_ENTITY],
    frame: { height: 8, width: 14.222 },
    geometryPreview: null,
    incomingSceneName: null,
    insertTool: "select",
    interactionMode: "position",
    motionPaths: [],
    onCanvasPlace: vi.fn(),
    onEntityKeyDown: vi.fn(),
    onEntityPointerCancel: vi.fn(),
    onEntityPointerDown: vi.fn(),
    onEntityPointerMove: vi.fn(),
    onEntityPointerUp: vi.fn(),
    onEntityResizeCancel: vi.fn(),
    onEntityResizeKeyDown: vi.fn(),
    onEntityResizePointerDown: vi.fn(),
    onEntityResizePointerMove: vi.fn(),
    onEntityResizePointerUp: vi.fn(),
    onMotionControlChange: vi.fn(),
    readOnly: false,
    sampleId: "sample-1",
    scalePreview: null,
    selectedIds: new Set<string>(),
  };
}

function previewView(
  state: StudioPreviewRendererViewV1["state"],
  interactionGeometry: StudioPreviewRendererViewV1["interactionGeometry"] = null,
  sourceRuntimeIdentity: StudioPreviewRendererViewV1["sourceRuntimeIdentity"] = null,
): StudioPreviewRendererViewV1 {
  return {
    attachCanvas: vi.fn(),
    epoch: 0,
    interactionGeometry,
    sourceLabel: "verified fixture",
    sourceMetadataPhase: "ready",
    sourceRuntimeIdentity,
    state,
    verifiedSourceDuration: 2,
  };
}

describe("StudioCanvas retained preview layer", () => {
  it("renders no canvas layer by default so the semantic preview stays authoritative", () => {
    const markup = renderToStaticMarkup(<StudioCanvas {...baseProps()} />);
    expect(markup).toContain('data-preview-renderer="off"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).not.toContain("data-studio-preview-canvas");
    expect(markup).not.toContain("data-studio-preview-status");
  });

  it("exposes the whole-Scene fallback reason without hiding the semantic DOM", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({ detail: "wasm-load-failed: no module", phase: "fallback", reason: "install-failed" })}
      />,
    );
    expect(markup).toContain('data-preview-renderer="fallback"');
    expect(markup).toContain('data-preview-fallback-reason="install-failed"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).toContain("Canvas preview fallback · snapshot install failed");
    expect(markup).toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    // Fallback restores the semantic paint in the same render.
    expect(markup).toContain('data-studio-semantic-paint="painted"');
    expect(markup).not.toContain("deferred-to-canvas");
  });

  it("labels a presented frame as an editing preview without claiming render authority", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({
          frame: {
            packetId: "canvas:2",
            revision: "a".repeat(64),
            sampleTime: 1,
            viewport: { heightPx: 90, widthPx: 160 },
          },
          phase: "presented",
        })}
      />,
    );
    expect(markup).toContain('data-preview-renderer="presented"');
    // The exact presented packet is exposed so E2E can bind pixel evidence to
    // this frame and no other.
    expect(markup).toContain('data-preview-packet-id="canvas:2"');
    expect(markup).toContain(`data-preview-revision="${"a".repeat(64)}"`);
    expect(markup).not.toContain("data-preview-fallback-reason");
    expect(markup).toContain("Canvas preview · verified fixture · editing preview only");
    expect(markup).not.toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    // A fully correlated presented frame replaces only the duplicate object
    // paint; the semantic hit target (the move button) stays in the
    // accessibility tree as a paint-free interaction overlay.
    expect(markup).toContain('data-studio-semantic-paint="deferred-to-canvas"');
    expect(markup).toContain('data-studio-entity="entity:circle_1"');
    expect(markup).toContain("Move circle_1");
  });

  it("moves hit targets to the verified snapshot's positions while presented", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:2",
              revision: "a".repeat(64),
              sampleTime: 1,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          },
          new Map([
            ["scene:runtime/entity:0", { dimensions: { radius: 8 / 9 }, position: { x: 0.4375 * 640, y: 180 } }],
          ]),
          new Map([
            [
              "circle_1",
              {
                bindingId: `source-binding:${"b".repeat(64)}`,
                entityId: "scene:runtime/entity:0",
                sourceName: "circle_1",
              },
            ],
          ]),
        )}
      />,
    );
    // 0.4375 of the 640-wide Studio viewport = 43.75% — the IR position, not
    // the semantic projection's 50% center.
    expect(markup).toContain("left:43.75%");
    expect(markup).toContain('data-studio-runtime-entity="scene:runtime/entity:0"');
    expect(markup).toContain(`data-studio-runtime-binding="source-binding:${"b".repeat(64)}"`);
    const fallbackMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(
          {
            detail: "An Edit Program changed the working revision.",
            phase: "fallback",
            reason: "snapshot-uncorrelated",
          },
          new Map([
            ["scene:runtime/entity:0", { dimensions: { radius: 8 / 9 }, position: { x: 0.4375 * 640, y: 180 } }],
          ]),
          new Map([
            [
              "circle_1",
              {
                bindingId: `source-binding:${"b".repeat(64)}`,
                entityId: "scene:runtime/entity:0",
                sourceName: "circle_1",
              },
            ],
          ]),
        )}
      />,
    );
    // An Edit Program makes snapshot pixels and their map uncorrelated in the
    // same render; hit targets return to semantic geometry even if the stale
    // map and runtime geometry are still retained in React state.
    expect(fallbackMarkup).toContain("left:50%");
    expect(fallbackMarkup).not.toContain("data-studio-runtime-entity");
  });

  it("never guesses a runtime entity from geometry or a duplicated current source name", () => {
    const state = {
      frame: {
        packetId: "canvas:2",
        revision: "a".repeat(64),
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      },
      phase: "presented" as const,
    };
    const runtimeGeometry = new Map([
      ["scene:runtime/entity:0", { dimensions: { radius: 1 }, position: { x: 100, y: 100 } }],
    ]);
    const verifiedIdentity = new Map([
      [
        "circle_1",
        {
          bindingId: `source-binding:${"b".repeat(64)}`,
          entityId: "scene:runtime/entity:0",
          sourceName: "circle_1",
        },
      ],
    ]);
    const missingMap = renderToStaticMarkup(
      <StudioCanvas {...baseProps()} preview={previewView(state, runtimeGeometry)} />,
    );
    expect(missingMap).toContain("left:50%");
    expect(missingMap).not.toContain("data-studio-runtime-entity");

    const duplicate = { ...CIRCLE_ENTITY, id: "entity:circle_2" };
    const duplicateSource = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        entities={[CIRCLE_ENTITY, duplicate]}
        preview={previewView(state, runtimeGeometry, verifiedIdentity)}
      />,
    );
    expect(duplicateSource).not.toContain("left:15.625%");
    expect(duplicateSource).not.toContain("data-studio-runtime-entity");
  });
});
