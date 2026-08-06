import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  resolveStudioPreviewControlStateV1,
  StudioPreviewControl,
  type StudioPreviewControlPropsV1,
} from "./studio-preview-control";
import type { StudioPreviewRendererViewV1 } from "./use-preview-renderer";

function renderer(state: StudioPreviewRendererViewV1["state"]): StudioPreviewRendererViewV1 {
  return {
    attachCanvas: vi.fn(),
    cameraCenter: null,
    epoch: 0,
    initialEditRuntimeAuthority: null,
    interactionAuthority: { kind: "interactive" },
    interactionGeometry: null,
    runtimeTraceBaseFrameRetained: false,
    runtimeTraceOpaqueSelectionEntities: [],
    runtimeTraceTerminalEditAuthority: null,
    runtimeTraceValidationPending: null,
    sourceLabel: "verified server snapshot r7",
    sourceMetadataFailureKind: null,
    sourceMetadataPhase: "ready",
    sourceRuntimeIdentity: null,
    state,
    syntheticInitialEditAnchor: null,
    verifiedSourceDuration: 1,
  };
}

function props(overrides: Partial<StudioPreviewControlPropsV1> = {}): StudioPreviewControlPropsV1 {
  return {
    activated: false,
    activationAllowed: true,
    activationRequested: false,
    onRequest: vi.fn(),
    onRetry: vi.fn(),
    providerPending: false,
    renderer: null,
    ...overrides,
  };
}

describe("StudioPreviewControl", () => {
  it("offers an explicit standard-UI request without claiming that Manim already ran", () => {
    const markup = renderToStaticMarkup(<StudioPreviewControl {...props()} />);

    expect(markup).toContain('data-studio-manim-preview-state="idle"');
    expect(markup).toContain("Manim Preview");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("Verified");
  });

  it("distinguishes loading from an exactly presented verified frame", () => {
    const loading = renderToStaticMarkup(
      <StudioPreviewControl {...props({ activated: true, activationRequested: true, providerPending: true })} />,
    );
    const presented = renderToStaticMarkup(
      <StudioPreviewControl
        {...props({
          activated: true,
          activationRequested: true,
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
    expect(presented).toContain("Manim Preview · Verified");
  });

  it("separates terminal unsupported outcomes from retryable failures", () => {
    const unsupported = renderToStaticMarkup(
      <StudioPreviewControl
        {...props({
          activated: true,
          activationRequested: true,
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
          activated: true,
          activationRequested: true,
          renderer: renderer({ detail: "producer failed", phase: "fallback", reason: "snapshot-unavailable" }),
        })}
      />,
    );

    expect(unsupported).toContain('data-studio-manim-preview-state="unsupported"');
    expect(unsupported).toContain("Manim Preview · Unsupported");
    expect(unsupported).not.toContain("Retry");
    expect(failed).toContain('data-studio-manim-preview-state="failed"');
    expect(failed).toContain("Manim Preview · Failed");
    expect(failed).toContain("Retry");
  });

  it("does not offer retry when the browser capability or disposed lifecycle is terminal", () => {
    for (const reason of ["capability-unsupported", "disposed"] as const) {
      const state = resolveStudioPreviewControlStateV1({
        activated: true,
        activationRequested: true,
        providerPending: false,
        renderer: renderer({ detail: null, phase: "fallback", reason }),
      });
      expect(state.retryable).toBe(false);
    }
  });

  it("reports transient and correlation fallbacks as semantic without a verified claim", () => {
    for (const reason of ["snapshot-uncorrelated", "transient-edit"] as const) {
      const state = resolveStudioPreviewControlStateV1({
        activated: true,
        activationRequested: true,
        providerPending: false,
        renderer: renderer({ detail: null, phase: "fallback", reason }),
      });
      expect(state).toMatchObject({ kind: "semantic-fallback", retryable: false });
    }
  });
});
