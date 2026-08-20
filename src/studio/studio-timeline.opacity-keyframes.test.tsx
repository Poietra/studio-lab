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
    materialParameterOptions: [],
    materialParameterTracks: [],
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
    onMaterialParameterKeyframeAdd: vi.fn(),
    onMaterialParameterKeyframeChange: vi.fn(),
    onMaterialParameterKeyframeDelete: vi.fn(),
    onMotionDurationChange: vi.fn(),
    onOpacityKeyframeAdd: vi.fn(),
    onOpacityKeyframeChange: vi.fn(),
    onOpacityKeyframeDelete: vi.fn(),
    onRotationKeyframeAdd: vi.fn(),
    onRotationKeyframeChange: vi.fn(),
    onRotationKeyframeDelete: vi.fn(),
    onScaleKeyframeAdd: vi.fn(),
    onScaleKeyframeChange: vi.fn(),
    onScaleKeyframeDelete: vi.fn(),
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
    rotationTrackEligibleIds: new Set(["circle"]),
    rotationTracks: [],
    scaleTrackEligibleIds: new Set(["circle"]),
    scaleTracks: [],
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

  it("renders a named material parameter picker and marker with the shared keyframe controls", () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        materialParameterOptions={[{ entityId: "circle", materialName: "Wave", name: "amplitude" }]}
        materialParameterTracks={[
          {
            assignmentChanged: false,
            entityId: "circle",
            keyframes: [{ easing: "smooth", sourceTime: 2.5, time: 2.9, value: 0.35 }],
            label: "Circle",
            materialName: "Wave",
            parameterIndex: 0,
            parameterName: "amplitude",
            programIndex: 0,
            range: { max: 1, min: 0, step: 0.05 },
            readOnlyReason: null,
            transactionId: "create-circle",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-property-keyframe="material"');
    expect(markup).toContain("Material parameter for Circle");
    expect(markup).toContain("amplitude");
  });

  it("renders uniform scale through the shared property marker lane", () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        scaleTracks={[
          {
            entityId: "circle",
            keyframes: [{ easing: "linear", sourceTime: 2.5, time: 2.9, value: 1 }],
            label: "Circle",
            programIndex: 0,
            readOnlyReason: null,
            transactionId: "create-circle",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-property-keyframe="scale"');
    expect(markup).toContain('aria-label="Add scale keyframe for Circle"');
  });

  it("renders rotation in degrees without normalizing multiple turns", () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        rotationTracks={[
          {
            entityId: "circle",
            keyframes: [{ easing: "linear", sourceTime: 2.5, time: 2.9, value: 720 }],
            label: "Circle",
            programIndex: 0,
            readOnlyReason: null,
            transactionId: "create-circle",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-property-keyframe="rotation"');
    expect(markup).toContain('aria-label="Add rotation keyframe for Circle"');
    expect(markup).toContain("Rotation 720.0° · linear");
  });

  it("keeps an explicit whole-track recovery action when the material assignment changed", () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        materialParameterTracks={[
          {
            assignmentChanged: true,
            entityId: "circle",
            keyframes: [{ easing: "smooth", sourceTime: 2.5, time: 2.9, value: 0.35 }],
            label: "Circle",
            materialName: "Wave",
            parameterIndex: 0,
            parameterName: "amplitude",
            programIndex: 0,
            range: { max: 1, min: 0, step: 0.05 },
            readOnlyReason: "The assigned material changed. Restore it or remove this track.",
            transactionId: "create-circle",
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Remove stale material track for Circle"');
    expect(markup).toContain("Remove track");
  });

  it("keeps a locked object selectable while disabling timeline mutations", () => {
    const markup = renderToStaticMarkup(<StudioTimeline {...props()} lockedEntityIds={new Set(["circle"])} />);

    expect(markup).toMatch(/aria-pressed="true"[^>]*title="Circle · Locked in Layers"/);
    expect(markup).toMatch(/aria-label="Add opacity keyframe for Circle"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="Add rotation keyframe for Circle"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="Add scale keyframe for Circle"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="Opacity keyframe 1[^>]*disabled=""/);
  });
});
