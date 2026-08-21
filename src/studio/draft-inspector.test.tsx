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
  rotationDeltaRadians: null,
  start: 5,
  targetObjectIds: ["equation_1"],
};

const STUDIO_CREATED_ENTITY_ID = "tx:spin-created/entity:circle";
const STUDIO_MOTION: CreateMotionSuggestion = {
  ...MOTION,
  targetObjectIds: [STUDIO_CREATED_ENTITY_ID],
};
const STUDIO_CREATED_SCENE = {
  ...STUDIO_FIXTURE_SCENE,
  objectGraph: {
    ...STUDIO_FIXTURE_SCENE.objectGraph,
    entities: {
      ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
      [STUDIO_CREATED_ENTITY_ID]: {
        id: STUDIO_CREATED_ENTITY_ID,
        lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "unknown" as const, reason: "Created in Studio." },
        transactionId: "spin-created",
        type: "Circle",
      },
    },
  },
};

describe("DraftInspector execution capabilities", () => {
  it("edits motion spin in degrees while keeping client Apply available", () => {
    const spinningMotion = { ...STUDIO_MOTION, rotationDeltaRadians: 2 * Math.PI };
    const validation = canonicalizeSuggestionProgram(spinningMotion, {
      capturedPlayhead: 5,
      origin: "direct-manipulation",
      scene: STUDIO_CREATED_SCENE,
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

  it("rejects motion spin for a source-bound target", () => {
    const validation = canonicalizeSuggestionProgram(
      { ...MOTION, rotationDeltaRadians: Math.PI },
      {
        capturedPlayhead: 5,
        origin: "direct-manipulation",
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "source-bound-motion-spin",
      },
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ message: "Motion spin requires exactly one Studio-created target." }),
    );
  });

  it("offers path orientation for a Studio-created motion", () => {
    const orientedMotion = { ...STUDIO_MOTION, orientToPath: true };
    const validation = canonicalizeSuggestionProgram(orientedMotion, {
      capturedPlayhead: 5,
      origin: "direct-manipulation",
      scene: STUDIO_CREATED_SCENE,
      transactionId: "oriented-motion-inspector",
    });
    expect(validation.kind).toBe("valid");
    const markup = renderToStaticMarkup(
      <DraftInspector
        error={null}
        isApplying={false}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onOperationChange={() => undefined}
        operation={orientedMotion}
        record={programRecord(validation.program, validation)}
      />,
    );

    expect(markup).toContain('aria-label="Follow path direction"');
    expect(markup).toMatch(/<input[^>]*aria-label="Follow path direction"[^>]*checked=""/);
    expect(markup).toMatch(/<dd class="mt-0.5 text-zinc-300">unsupported<\/dd>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply program<\/button>/);
  });

  it("rejects path orientation for a source-bound target", () => {
    const validation = canonicalizeSuggestionProgram(
      { ...MOTION, orientToPath: true },
      {
        capturedPlayhead: 5,
        origin: "direct-manipulation",
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "source-bound-motion-orientation",
      },
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ message: "Follow path direction requires exactly one Studio-created target." }),
    );
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

  it("directs approximate CameraFocus suggestions to the exact Inspector controls", () => {
    const validation = canonicalizeSuggestionProgram(CAMERA_FOCUS, {
      capturedPlayhead: 4.42,
      origin: "remote-model",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "camera-focus-inspector",
    });
    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/exact prepared WebGPU bounds.*Studio Inspector Camera controls/),
      }),
    );
  });
});
