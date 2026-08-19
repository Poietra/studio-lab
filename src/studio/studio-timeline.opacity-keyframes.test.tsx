import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StudioTimeline, type StudioTimelineProps } from "./studio-timeline";

function props(): StudioTimelineProps {
  return {
    anchors: [],
    appliedMotionClips: [],
    appliedTransactionIds: new Set(["create-circle"]),
    currentTime: 2,
    duration: 5,
    editingAppliedTransactionId: null,
    events: [],
    interactionMode: "position",
    isPlaying: false,
    lifetimeControls: {},
    lifetimeEditMessage: null,
    lifetimeTrimDisabled: false,
    motionDuration: 1,
    objectTracks: [
      {
        animatedChannels: [],
        entityId: "circle",
        label: "Circle",
        lifetimes: [{ end: 5, start: 1 }],
        provisional: false,
        transactionId: "create-circle",
        type: "Circle",
      },
    ],
    onAppliedMotionClipChange: vi.fn(),
    onAppliedMotionClipSelect: vi.fn(),
    onInteractionModeChange: vi.fn(),
    onLifetimeChange: vi.fn(),
    onMotionDurationChange: vi.fn(),
    onOpacityKeyframeAdd: vi.fn(),
    onOpacityKeyframeChange: vi.fn(),
    onOpacityKeyframeDelete: vi.fn(),
    onSelectEntity: vi.fn(),
    onTimeChange: vi.fn(),
    onTogglePlayback: vi.fn(),
    opacityTrackEligibleIds: new Set(["circle"]),
    opacityTracks: [
      {
        entityId: "circle",
        keyframes: [{ easing: "smooth", sourceTime: 2, time: 2.4, value: 1 }],
        label: "Circle",
        programIndex: 0,
        readOnlyReason: null,
        transactionId: "create-circle",
      },
    ],
    readOnly: false,
    selectedIds: new Set(["circle"]),
  };
}

describe("StudioTimeline opacity keyframes", () => {
  it("renders the marker above lifetime and non-interactive playhead layers", () => {
    const markup = renderToStaticMarkup(<StudioTimeline {...props()} />);

    expect(markup).toContain("data-opacity-keyframe");
    expect(markup).toContain("data-timeline-lifetime");
    expect(markup).toContain("z-40");
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain('aria-label="Add opacity keyframe for Circle"');
  });
});
