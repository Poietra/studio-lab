import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  resolveStudioPreviewControlState,
  StudioPreviewControl,
  type StudioPreviewControlProps,
} from "./studio-preview-control";
import type { StudioPreviewRendererView } from "./use-preview-renderer";

function renderer(state: StudioPreviewRendererView["state"]): StudioPreviewRendererView {
  return {
    attachCanvas: vi.fn(),
    generateThumbnail: vi.fn(),
    boundEntityProjection: null,
    cameraCenter: null,
    canonicalScene: null,
    creationProjection: null,
    epoch: 0,
    interactionAuthority: { kind: "interactive" },
    interactionGeometry: null,
    mathTexTransformProjection: null,
    motionProjection: null,
    persistentRemoveProjection: null,
    staticRootProjection: null,
    editAuthority: null,
    runtimeTraceEditAnchor: null,
    runtimeTraceEditCandidates: [],
    runtimeTraceOpaqueSelectionEntities: [],
    runtimeTraceProgramValidation: "not-applicable",
    sourceLabel: "verified server snapshot r7",
    sourceMetadataFailureKind: null,
    sourceMetadataPhase: "ready",
    sourceRuntimeIdentity: null,
    state,
    timelineProjection: null,
    verifiedSourceDuration: 1,
  };
}

function props(overrides: Partial<StudioPreviewControlProps> = {}): StudioPreviewControlProps {
  return {
    onRetry: vi.fn(),
    providerPending: false,
    renderer: null,
    ...overrides,
  };
}

describe("StudioPreviewControl", () => {
  it("reports canonical provider resolution without an activation control", () => {
    const markup = renderToStaticMarkup(<StudioPreviewControl {...props({ providerPending: true })} />);

    expect(markup).toContain('data-studio-manim-preview-state="loading"');
    expect(markup).toContain("WebGPU Preview · Loading…");
    expect(markup).not.toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("Verified");
  });

  it("distinguishes loading from an exactly presented verified frame", () => {
    const loading = renderToStaticMarkup(<StudioPreviewControl {...props({ providerPending: true })} />);
    const presented = renderToStaticMarkup(
      <StudioPreviewControl
        {...props({
          renderer: renderer({
            frame: {
              packetId: "canvas:1",
              revision: "a".repeat(64),
              sampleTime: 0,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          }),
        })}
      />,
    );

    expect(loading).toContain('data-studio-manim-preview-state="loading"');
    expect(loading).not.toContain("Verified");
    expect(presented).toContain('data-studio-manim-preview-state="presented"');
    expect(presented).toContain("WebGPU Preview · Verified");
  });

  it("separates terminal unsupported outcomes from retryable failures", () => {
    const unsupported = renderToStaticMarkup(
      <StudioPreviewControl
        {...props({
          renderer: {
            ...renderer({
              detail: "The Scene snapshot endpoint did not verify this Scene (unsupported).",
              phase: "fallback",
              reason: "snapshot-unavailable",
            }),
            sourceMetadataFailureKind: "unsupported",
          },
        })}
      />,
    );
    const failed = renderToStaticMarkup(
      <StudioPreviewControl
        {...props({
          renderer: renderer({ detail: "producer failed", phase: "fallback", reason: "snapshot-unavailable" }),
        })}
      />,
    );

    expect(unsupported).toContain('data-studio-manim-preview-state="unsupported"');
    expect(unsupported).toContain("WebGPU Preview · Unsupported");
    expect(unsupported).not.toContain("Retry");
    expect(failed).toContain('data-studio-manim-preview-state="failed"');
    expect(failed).toContain("WebGPU Preview · Failed");
    expect(failed).toContain('data-studio-preview-detail="true"');
    expect(failed).toContain("producer failed");
    expect(failed).toContain("Retry");
  });

  it("does not offer retry when the browser capability or disposed lifecycle is terminal", () => {
    for (const reason of ["capability-unsupported", "disposed"] as const) {
      const state = resolveStudioPreviewControlState({
        providerPending: false,
        renderer: renderer({ detail: null, phase: "fallback", reason }),
      });
      expect(state.retryable).toBe(false);
    }
  });

  it("reports correlation gaps as paused without claiming fallback paint", () => {
    for (const reason of ["snapshot-uncorrelated"] as const) {
      const state = resolveStudioPreviewControlState({
        providerPending: false,
        renderer: renderer({ detail: null, phase: "fallback", reason }),
      });
      expect(state).toMatchObject({ kind: "paused", retryable: false });
    }
  });

  it("reports unsupported core compilation explicitly", () => {
    const state = resolveStudioPreviewControlState({
      providerPending: false,
      renderer: renderer({
        detail: "No canonical command supports this edit.",
        phase: "fallback",
        reason: "scene-unsupported",
      }),
    });
    expect(state).toMatchObject({ kind: "unsupported", retryable: false });
  });
});
