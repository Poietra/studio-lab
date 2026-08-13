import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CreateCameraFocusSuggestion } from "../ai/edit-suggestions";
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

describe("DraftInspector execution capabilities", () => {
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
