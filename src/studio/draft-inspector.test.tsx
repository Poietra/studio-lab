import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DraftInspector } from "./draft-inspector";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { createDirectManipulationModifyMotionProgram } from "./suggestion-program";

describe("DraftInspector execution capabilities", () => {
  it("shows the shared preview/apply/lowering contract and disables blocked Apply", () => {
    const validation = createDirectManipulationModifyMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: -32 },
      interval: { end: 7, start: 4 },
      motionId: "move-equation",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "modify-motion-inspector",
    });
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

    expect(markup).toContain("Preview");
    expect(markup).toContain("Apply");
    expect(markup).toContain("Lowering");
    expect(markup).toContain("ModifyMotion has no truthful source lowering yet.");
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
