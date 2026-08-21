import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CreateCameraFocusSuggestion, CreateMotionSuggestion } from "../ai/edit-suggestions";
import { DraftInspector } from "./draft-inspector";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { canonicalizeSuggestionProgram } from "./suggestion-program";

const CAMERA_FOCUS: CreateCameraFocusSuggestion = {
  anchor: { kind: "playhead", referenceSeconds: 4.42 },
  easing: "smooth",
  emphasisScale: 1.12,
  end: 5.92,
  kind: "create-camera-focus",
  start: 4.42,
  targetObjectIds: ["equation_1"],
  zoomScale: 1.35,
};

const MOTION: CreateMotionSuggestion = {
  anchor: { kind: "playhead", referenceSeconds: 5 },
  controlOffset: { x: 0, y: 0 },
  delta: { x: 40, y: 0 },
  easing: "smooth",
  end: 7,
  kind: "create-motion",
  start: 5,
  targetObjectIds: ["equation_1"],
};

describe("DraftInspector execution capabilities", () => {
  it("edits motion spin in degrees while keeping client Apply available", () => {
    const spinningMotion = { ...MOTION, rotationDeltaRadians: 2 * Math.PI };
    const validation = canonicalizeSuggestionProgram(spinningMotion, {
      capturedPlayhead: 5,
      origin: "direct-manipulation",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "spinning-motion-inspector",
    });
    expect(validation.kind).toBe("valid");
    const markup = renderToStaticMarkup(
      <DraftInspector
        error={null}
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={spinningMotion}
        record={programRecord(validation.program, validation)}
      />,
    );

    expect(markup).toContain('aria-label="Motion spin degrees"');
    expect(markup).toContain('value="360"');
    expect(markup).toContain("Remove spin");
    expect(markup).toMatch(/<dd class="mt-0.5 text-zinc-300">unsupported<\/dd>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply program<\/button>/);
  });

  it("shows StyleProfile warnings without blocking Apply", () => {
    const validation = canonicalizeSuggestionProgram(MOTION, {
      capturedPlayhead: 5,
      origin: "remote-model",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "style-warning-inspector",
    });
    expect(validation.kind).toBe("valid");
    const record = programRecord(validation.program, validation);
    const markup = renderToStaticMarkup(
      <DraftInspector
        error={null}
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={MOTION}
        record={{
          ...record,
          program: {
            ...record.program,
            provenance: {
              ...record.program.provenance,
              styleProfileRef: { id: "poietra-balanced", version: 1 },
            },
          },
          validation: {
            issues: [
              ...record.validation.issues,
              {
                code: "style-profile-deviation",
                field: "duration",
                message: "create-motion lasts 2s; poietra-balanced recommends 1.5s.",
                severity: "warning",
              },
            ],
            status: "valid",
          },
        }}
      />,
    );

    expect(markup).toContain("Style profile deviation");
    expect(markup).toContain("poietra-balanced");
    expect(markup).toContain("poietra-balanced recommends 1.5s");
    expect(markup).toContain("Add 360° spin");
    expect(markup).toMatch(/<button[^>]*>Apply program<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply program<\/button>/);
  });

  it("shows the shared apply/lowering contract and disables blocked Apply", () => {
    const validation = canonicalizeSuggestionProgram(CAMERA_FOCUS, {
      capturedPlayhead: 4.42,
      origin: "remote-model",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "camera-focus-inspector",
    });
    expect(validation.kind).toBe("valid");
    const markup = renderToStaticMarkup(
      <DraftInspector
        error="A newer transient error."
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={null}
        record={programRecord(validation.program, validation)}
      />,
    );

    expect(markup).toContain("Apply");
    expect(markup).toContain("Lowering");
    expect(markup).toContain(
      "CameraFocus can be previewed, but ChangeCamera cannot yet be lowered back to Manim source.",
    );
    expect(markup).not.toContain("A newer transient error.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply program<\/button>/);

    const replacementMarkup = renderToStaticMarkup(
      <DraftInspector
        applyLabel="Replace program"
        error={null}
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={null}
        record={programRecord(validation.program, validation)}
      />,
    );
    expect(replacementMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Replace program<\/button>/);

    const applyingMarkup = renderToStaticMarkup(
      <DraftInspector
        error={null}
        isApplying
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={null}
        record={programRecord(validation.program, validation)}
      />,
    );
    expect(applyingMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Checking source…<\/button>/);

    const unavailablePreviewMarkup = renderToStaticMarkup(
      <DraftInspector
        editingDisabled
        error="Canonical preview is unavailable."
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={null}
        record={programRecord(validation.program, validation)}
      />,
    );
    expect(unavailablePreviewMarkup).toMatch(/<fieldset[^>]*disabled=""/);
    expect(unavailablePreviewMarkup).toMatch(/<button[^>]*>Discard<\/button>/);
  });
});
