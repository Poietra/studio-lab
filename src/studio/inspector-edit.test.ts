import { describe, expect, it } from "vitest";

import { projectProposedState } from "./evaluator";
import { entityInspectorKey } from "./entity-inspector";
import { createFixtureProposedState } from "./fixture";
import { initialInspectorEditValues, validateInspectorEdits, type InspectorEditValues } from "./inspector-edit";
import type { ProjectedEntity } from "./model";

function fixtureEntity(id: string) {
  const entity = projectProposedState(createFixtureProposedState(), 5).inspector.entities.find(
    (candidate) => candidate.id === id,
  );
  if (!entity) throw new Error(`Missing fixture entity ${id}.`);
  return entity;
}

function values(entity: ProjectedEntity, changes: Partial<InspectorEditValues> = {}) {
  return { ...initialInspectorEditValues(entity), ...changes };
}

describe("Inspector field validation", () => {
  it("returns only changed position and valid MathTex fields", () => {
    const entity = fixtureEntity("equation_1");
    const result = validateInspectorEdits(
      entity,
      values(entity, {
        content: "F\n=\nm\na",
        x: "410",
        y: "170",
      }),
    );

    expect(result).toEqual({
      edits: {
        content: {
          displayLines: ["F = m a"],
          label: "equation",
          texParts: ["F", "=", "m", "a"],
        },
        position: { x: 410, y: 170 },
      },
      kind: "valid",
    });
  });

  it("preserves multiline Text content as one canonical content value", () => {
    const entity = fixtureEntity("label_1");
    expect(validateInspectorEdits(entity, values(entity, { content: "mass\nand energy" }))).toEqual({
      edits: {
        content: {
          displayLines: ["mass", "and energy"],
          label: undefined,
          text: "mass\nand energy",
        },
      },
      kind: "valid",
    });
  });

  it("reports MathTex syntax and empty parts on the content field before staging", () => {
    const entity = fixtureEntity("equation_1");
    const invalidSyntax = validateInspectorEdits(
      entity,
      values(entity, {
        content: String.raw`\notARealCommand{`,
      }),
    );
    expect(invalidSyntax).toEqual({
      errors: { content: expect.stringMatching(/cannot parse/i) },
      kind: "invalid",
    });

    const emptyPart = validateInspectorEdits(entity, values(entity, { content: "F\n\n= ma" }));
    expect(emptyPart).toEqual({
      errors: { content: expect.stringMatching(/non-empty part/i) },
      kind: "invalid",
    });
  });

  it("reports independent errors for each invalid numeric field", () => {
    const entity = fixtureEntity("equation_1");
    const result = validateInspectorEdits(entity, values(entity, { x: "Infinity", y: "" }));

    expect(result).toEqual({
      errors: {
        x: "Enter a finite number.",
        y: "Enter a number.",
      },
      kind: "invalid",
    });
  });

  it("fails closed for runtime-dependent position and unstable content identity", () => {
    const base = fixtureEntity("equation_1");
    const entity: ProjectedEntity = {
      ...base,
      geometry: {
        ...base.geometry,
        position: { kind: "unknown", reason: "Runtime move_to call" },
      },
      sourceIdentity: { kind: "unknown", reason: "Runtime alias" },
    };
    const result = validateInspectorEdits(entity, {
      ...values(base),
      content: "F = ma",
      x: "200",
      y: "100",
    });

    expect(result).toEqual({
      errors: {
        content: expect.stringMatching(/stable source identity/i),
        x: expect.stringMatching(/runtime-dependent/i),
        y: expect.stringMatching(/unavailable/i),
      },
      kind: "invalid",
    });
  });

  it("remounts fields when geometry knowledge resolves at the same sampled position", () => {
    const known = fixtureEntity("equation_1");
    const unknown: ProjectedEntity = {
      ...known,
      geometry: {
        ...known.geometry,
        position: { kind: "unknown", reason: "Runtime move_to call" },
      },
    };

    expect(entityInspectorKey(unknown)).not.toBe(entityInspectorKey(known));
  });

  it("does not revalidate unchanged content when editing an independent field", () => {
    const base = fixtureEntity("equation_1");
    const entity: ProjectedEntity = {
      ...base,
      content: {
        displayLines: [String.raw`\notARealCommand{`],
        texParts: [String.raw`\notARealCommand{`],
      },
      sourceIdentity: { kind: "unknown", reason: "Runtime alias" },
    };

    expect(validateInspectorEdits(entity, values(entity, { x: "410" }))).toEqual({
      edits: { position: { x: 410, y: entity.position.y } },
      kind: "valid",
    });
  });

  it("validates Circle and Rectangle dimensions without emitting unchanged values", () => {
    const circle = {
      ...fixtureEntity("equation_1"),
      content: undefined,
      geometry: {
        dimensions: { kind: "known" as const, value: { radius: 1 } },
        position: { kind: "known" as const, value: { x: 200, y: 100 } },
        scale: { kind: "known" as const, value: 1 },
        style: { kind: "known" as const, value: {} },
      },
      id: "circle",
      position: { x: 200, y: 100 },
      type: "Circle",
    } satisfies ProjectedEntity;
    expect(validateInspectorEdits(circle, values(circle, { radius: "1.75" }))).toEqual({
      edits: { dimensions: { radius: 1.75 } },
      kind: "valid",
    });
    expect(validateInspectorEdits(circle, values(circle, { radius: "0" }))).toEqual({
      errors: { radius: expect.stringMatching(/at least 0.1/i) },
      kind: "invalid",
    });

    const rectangle = {
      ...circle,
      geometry: {
        ...circle.geometry,
        dimensions: { kind: "known" as const, value: { height: 2, width: 4 } },
      },
      id: "rectangle",
      type: "Rectangle",
    } satisfies ProjectedEntity;
    expect(validateInspectorEdits(rectangle, values(rectangle, { height: "3", width: "5" }))).toEqual({
      edits: { dimensions: { height: 3, width: 5 } },
      kind: "valid",
    });
    expect(validateInspectorEdits(rectangle, values(rectangle))).toEqual({ edits: {}, kind: "valid" });
  });
});
