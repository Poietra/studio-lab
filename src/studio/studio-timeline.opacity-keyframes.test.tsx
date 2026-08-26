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
    drawInClips: [],
    drawInAvailability: new Map(),
    writeInClips: [],
    writeInAvailability: new Map(),
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
    onDrawInAdd: vi.fn(),
    onDrawInChange: vi.fn(),
    onDrawInDelete: vi.fn(),
    onDrawInSelect: vi.fn(),
    onWriteInAdd: vi.fn(),
    onWriteInChange: vi.fn(),
    onWriteInDelete: vi.fn(),
    onWriteInSelect: vi.fn(),
    onInteractionModeChange: vi.fn(),
    onLifetimeChange: vi.fn(),
    onMaterialParameterKeyframeAdd: vi.fn(),
    onMaterialParameterKeyframeChange: vi.fn(),
    onMaterialParameterKeyframeDelete: vi.fn(),
    onMaterialParameterKeyframeDuplicate: vi.fn(() => null),
    onMotionDurationChange: vi.fn(),
    onOpacityKeyframeAdd: vi.fn(),
    onOpacityKeyframeChange: vi.fn(),
    onOpacityKeyframeDelete: vi.fn(),
    onOpacityKeyframeDuplicate: vi.fn(() => null),
    onRotationKeyframeAdd: vi.fn(),
    onRotationKeyframeChange: vi.fn(),
    onRotationKeyframeDelete: vi.fn(),
    onRotationKeyframeDuplicate: vi.fn(() => null),
    onScaleKeyframeAdd: vi.fn(),
    onScaleKeyframeChange: vi.fn(),
    onScaleKeyframeDelete: vi.fn(),
    onScaleKeyframeDuplicate: vi.fn(() => null),
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
  it("keeps the Draw control visible with a reason for an unsupported target", () => {
    const reason = "Draw supports only Studio-created Line, Circle, and Rectangle objects.";
    const markup = renderToStaticMarkup(
      <StudioTimeline {...props()} drawInAvailability={new Map([["circle", reason]])} />,
    );

    expect(markup).toContain('aria-label="Add Draw entrance for Circle"');
    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toMatch(/aria-disabled="true"[^>]*aria-label="Add Draw entrance for Circle"/u);
    expect(markup).toContain(`>${reason}</span>`);
  });

  it("enables the Draw control when availability has no blocker", () => {
    const markup = renderToStaticMarkup(
      <StudioTimeline {...props()} drawInAvailability={new Map([["circle", null]])} />,
    );

    expect(markup).toContain('aria-label="Add Draw entrance for Circle"');
    expect(markup).toMatch(/aria-disabled="false"[^>]*aria-label="Add Draw entrance for Circle"/u);
  });

  it("renders a Studio Draw clip and its duration controls", () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        drawInClips={[
          {
            easing: "linear",
            entityId: "circle",
            interval: { end: 2, start: 1 },
            label: "Circle",
            maximumDuration: 4,
            operationId: "draw-circle",
            readOnlyReason: null,
            transactionId: "create-circle",
          },
        ]}
        editingAppliedTransactionId="create-circle"
      />,
    );

    expect(markup).toContain('aria-label="Edit Circle Draw entrance"');
    expect(markup).toContain('aria-label="Draw duration for Circle"');
    expect(markup).toContain('aria-label="Draw easing for Circle"');
    expect(markup).toContain("Remove Draw");
  });

  it("keeps the Write control visible with a reason for a non-MathTex target", () => {
    const reason = "Write supports only Studio-created MathTex objects.";
    const markup = renderToStaticMarkup(
      <StudioTimeline {...props()} writeInAvailability={new Map([["circle", reason]])} />,
    );

    expect(markup).toContain('aria-label="Add Write entrance for Circle"');
    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toMatch(/aria-disabled="true"[^>]*aria-label="Add Write entrance for Circle"/u);
    expect(markup).toContain(`>${reason}</span>`);
  });

  it("renders a Studio MathTex Write clip and its duration controls", () => {
    const base = props();
    const mathTexTrack = {
      ...base.objectTracks[0]!,
      entityId: "equation",
      label: "E = mc^2",
      type: "MathTex",
    };
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        editingAppliedTransactionId="create-equation"
        objectTracks={[mathTexTrack]}
        selectedIds={new Set(["equation"])}
        writeInAvailability={new Map([["equation", null]])}
        writeInClips={[
          {
            easing: "linear",
            entityId: "equation",
            interval: { end: 2, start: 1 },
            label: "E = mc^2",
            maximumDuration: 4,
            operationId: "write-equation",
            readOnlyReason: null,
            transactionId: "create-equation",
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Edit E = mc^2 Write entrance"');
    expect(markup).toContain('aria-label="Write duration for E = mc^2"');
    expect(markup).toContain('data-write-in-easing="linear"');
    expect(markup).toContain("Remove Write");
    expect(markup).toContain('data-write-in-clip="write-equation"');
  });

  it("renders the marker above lifetime and non-interactive playhead layers", () => {
    const markup = renderToStaticMarkup(<StudioTimeline {...props()} />);

    expect(markup).toContain("data-opacity-keyframe");
    expect(markup).toContain("data-timeline-lifetime");
    expect(markup).toContain("z-40");
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain('aria-label="Add opacity keyframe for Circle"');
  });

  it("renders the canonical fill color add control and projected color markers", () => {
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...props()}
        onPaintColorKeyframeAdd={vi.fn()}
        onPaintColorKeyframeChange={vi.fn()}
        onPaintColorKeyframeDelete={vi.fn()}
        onPaintColorKeyframeDuplicate={vi.fn(() => null)}
        paintColorTrackEligibleProperties={new Map([["circle", "fillColor"]])}
        paintColorTracks={[
          {
            entityId: "circle",
            keyframes: [
              { easing: "linear", sourceTime: 1.001, time: 1.001, value: "#ffffff" },
              { easing: "smooth", sourceTime: 3, time: 3, value: "#0ea5e9" },
            ],
            label: "Circle",
            programIndex: 0,
            property: "fillColor",
            readOnlyReason: null,
            transactionId: "create-circle",
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Add fill color keyframe for Circle"');
    expect(markup).toContain('aria-label="Fill color keyframe 1 at 1.00 seconds"');
    expect(markup).toContain('aria-label="Fill color keyframe 2 at 3.00 seconds"');
    expect(markup.match(/data-paint-color-keyframe/g)).toHaveLength(2);
    expect(markup).toContain("background-color:#0ea5e9");
  });

  it("explains why imported Manim animations are read-only", () => {
    const base = props();
    const reason = "This animation is owned by the imported Manim source. Edit the Python source to change it.";
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...base}
        objectTracks={[
          {
            ...base.objectTracks[0]!,
            animatedChannels: [{ interval: { end: 3, start: 1 }, key: "scale", readOnlyReason: reason }],
          },
        ]}
      />,
    );

    expect(markup).toContain("data-timeline-read-only-animation");
    expect(markup).toContain(`aria-label="scale animation · ${reason}"`);
    expect(markup).toContain('tabindex="0"');
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

  it("keeps the Pen motion action visible with a concrete selection blocker", () => {
    const reason = "Move the target center onto the Pen path start (within 1 px).";
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...props()}
        interactionMode="animate"
        onPathMotionAdd={vi.fn()}
        pathMotionUnavailableReason={reason}
      />,
    );

    expect(markup).toContain('aria-label="Pen motion easing"');
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*title="Move the target center onto the Pen path start \(within 1 px\)\."[^>]*>Use Pen as motion path/u,
    );
    expect(markup).toContain(reason);
  });

  it("enables Pen motion and exposes editing, easing, and deletion for its canonical clip", () => {
    const markup = renderToStaticMarkup(
      <StudioTimeline
        {...props()}
        appliedMotionClips={[
          {
            anchors: [{ maximumDuration: 3, sourceTime: 2, workingTime: 2 }],
            easing: "smooth",
            entityId: "circle",
            interval: { end: 3, start: 2 },
            label: "Circle",
            maximumDuration: 3,
            operationId: "pen-motion",
            penPathMotion: true,
            programIndex: 1,
            readOnlyReason: null,
            sourceStart: 2,
            transactionId: "pen-motion-program",
          },
        ]}
        editingAppliedTransactionId="pen-motion-program"
        interactionMode="animate"
        onAppliedMotionClipDelete={vi.fn()}
        onPathMotionAdd={vi.fn()}
        pathMotionUnavailableReason={null}
      />,
    );

    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*>Use Pen as motion path/u);
    expect(markup).toContain('aria-label="Edit Circle motion clip"');
    expect(markup).toContain('aria-label="Easing for Circle Pen motion"');
    expect(markup).toContain('aria-label="Delete Circle motion clip"');
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
