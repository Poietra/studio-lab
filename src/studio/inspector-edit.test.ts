import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STUDIO_TEXT_DEFAULT_LAYOUT } from "./editable-content";
import { EntityInspectorEditor, entityInspectorKey } from "./entity-inspector";
import { projectProposedState } from "./evaluator";
import { createFixtureProposedState } from "./fixture";
import { type InspectorEditValues, initialInspectorEditValues, validateInspectorEdits } from "./inspector-edit";
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

function studioTextEntity() {
  return {
    ...fixtureEntity("label_1"),
    id: "tx:studio-text/entity:label",
    sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
    transactionId: "studio-text",
  } satisfies ProjectedEntity;
}

function studioMathTexEntity() {
  return {
    ...fixtureEntity("equation_1"),
    content: {
      displayLines: ["E = mc^2"],
      label: "E = mc^2",
      texParts: ["E = mc^2"],
    },
    id: "tx:studio-mathtex/entity:equation",
    sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
    transactionId: "studio-mathtex",
  } satisfies ProjectedEntity;
}

function studioRectangleEntity(cornerRadius = 0) {
  const base = fixtureEntity("equation_1");
  return {
    ...base,
    content: undefined,
    geometry: {
      dimensions: { kind: "known" as const, value: { cornerRadius, height: 2, width: 4 } },
      position: { kind: "known" as const, value: { x: 200, y: 100 } },
      scale: { kind: "known" as const, value: 1 },
      style: { kind: "known" as const, value: {} },
    },
    id: "tx:studio-rectangle/entity:rectangle",
    position: { x: 200, y: 100 },
    sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
    transactionId: "studio-rectangle",
    type: "Rectangle",
  } satisfies ProjectedEntity;
}

describe("Inspector field validation", () => {
  it("offers only bundled Sans/Mono families and real Regular/Bold weights for Studio-created Text", () => {
    const markup = renderToStaticMarkup(
      createElement(EntityInspectorEditor, {
        entity: studioTextEntity(),
        onCreateDraft: () => true,
        onFocusRestored: () => undefined,
        restoreFocus: null,
      }),
    );
    expect(markup).toContain('aria-label="Text font weight of energy"');
    expect(markup).toContain('aria-label="Text font family of energy"');
    expect(markup).toContain('aria-label="Text wrap width of energy"');
    expect(markup).toContain('<option value="sans" selected="">Sans</option>');
    expect(markup).toContain('<option value="mono">Mono</option>');
    expect(markup).toContain('<option value="regular" selected="">Regular</option>');
    expect(markup).toContain('<option value="bold">Bold</option>');
  });

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

  it("updates the display label when Studio-created MathTex content changes", () => {
    const entity = studioMathTexEntity();
    expect(validateInspectorEdits(entity, values(entity, { content: "F\n=\nma" }))).toEqual({
      edits: {
        content: {
          displayLines: ["F = ma"],
          label: "F = ma",
          texParts: ["F", "=", "ma"],
        },
      },
      kind: "valid",
    });
  });

  it("normalizes Japanese multiline and canonically equivalent IME Text for edits and re-editing", () => {
    const entity = fixtureEntity("label_1");
    expect(validateInspectorEdits(entity, values(entity, { content: "日本語で動画を作る\r\nこんにちは" }))).toEqual({
      edits: {
        content: {
          displayLines: ["日本語で動画を作る", "こんにちは"],
          label: undefined,
          text: "日本語で動画を作る\nこんにちは",
          textLayout: {
            alignment: "left",
            fontFamily: "sans",
            fontSize: 1,
            fontWeight: "regular",
            lineHeight: 1.2,
          },
        },
      },
      kind: "valid",
    });

    const restored = {
      ...entity,
      content: { displayLines: ["日本語で動画を作る", "こんにちは"], text: "日本語で動画を作る\r\nこんにちは" },
    } satisfies ProjectedEntity;
    expect(initialInspectorEditValues(restored).content).toBe("日本語で動画を作る\nこんにちは");

    const decomposed = validateInspectorEdits(entity, values(entity, { content: "Cafe\u0301" }));
    expect(decomposed).toMatchObject({
      edits: { content: { displayLines: ["Caf\u00e9"], text: "Caf\u00e9" } },
      kind: "valid",
    });
  });

  it("validates Text size, alignment, real weight, line height, and wrap width as one content edit", () => {
    const entity = studioTextEntity();
    expect(initialInspectorEditValues(entity).textWrapWidth).toBe("");
    expect(
      validateInspectorEdits(
        entity,
        values(entity, {
          textAlignment: "center",
          textFontFamily: "mono",
          textFontSize: "1.5",
          textFontWeight: "bold",
          textLineHeight: "1.8",
          textWrapWidth: "5.5",
        }),
      ),
    ).toEqual({
      edits: {
        content: {
          displayLines: ["energy"],
          label: undefined,
          text: "energy",
          textLayout: {
            alignment: "center",
            fontFamily: "mono",
            fontSize: 1.5,
            fontWeight: "bold",
            lineHeight: 1.8,
            wrapWidth: 5.5,
          },
        },
      },
      kind: "valid",
    });
    expect(validateInspectorEdits(entity, values(entity, { textFontSize: "0" }))).toEqual({
      errors: { textFontSize: expect.stringMatching(/greater than zero/i) },
      kind: "invalid",
    });
    expect(validateInspectorEdits(entity, values(entity, { textLineHeight: "0" }))).toEqual({
      errors: { textLineHeight: expect.stringMatching(/greater than zero/i) },
      kind: "invalid",
    });
    expect(validateInspectorEdits(entity, values(entity, { textWrapWidth: "0" }))).toEqual({
      errors: { textWrapWidth: expect.stringMatching(/greater than zero/i) },
      kind: "invalid",
    });
    expect(validateInspectorEdits(entity, values(entity, { textWrapWidth: "Infinity" }))).toEqual({
      errors: { textWrapWidth: expect.stringMatching(/finite number/i) },
      kind: "invalid",
    });
    const imported = fixtureEntity("label_1");
    expect(validateInspectorEdits(imported, values(imported, { textAlignment: "right" }))).toEqual({
      errors: { textAlignment: expect.stringMatching(/only for Studio-created Text/i) },
      kind: "invalid",
    });
    expect(validateInspectorEdits(imported, values(imported, { textWrapWidth: "5" }))).toEqual({
      errors: { textWrapWidth: expect.stringMatching(/only for Studio-created Text/i) },
      kind: "invalid",
    });
  });

  it("clears an existing Text wrap width without inventing a zero-width box", () => {
    const entity = studioTextEntity();
    const wrapped = {
      ...entity,
      content: {
        displayLines: ["energy"],
        text: "energy",
        textLayout: { ...STUDIO_TEXT_DEFAULT_LAYOUT, wrapWidth: 4 },
      },
    } satisfies ProjectedEntity;

    expect(initialInspectorEditValues(wrapped).textWrapWidth).toBe("4.00");
    expect(validateInspectorEdits(wrapped, values(wrapped, { textWrapWidth: "" }))).toEqual({
      edits: {
        content: {
          displayLines: ["energy"],
          label: undefined,
          text: "energy",
          textLayout: STUDIO_TEXT_DEFAULT_LAYOUT,
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

  it("edits only Studio-native Rectangle corner radius and canonically clamps it to the short edge", () => {
    const rectangle = studioRectangleEntity(0.75);
    expect(initialInspectorEditValues(rectangle).cornerRadius).toBe("0.75");
    expect(validateInspectorEdits(rectangle, values(rectangle, { cornerRadius: "8" }))).toEqual({
      edits: { dimensions: { cornerRadius: 1, height: 2, width: 4 } },
      kind: "valid",
    });
    expect(validateInspectorEdits(rectangle, values(rectangle, { height: "1" }))).toEqual({
      edits: { dimensions: { cornerRadius: 0.5, height: 1, width: 4 } },
      kind: "valid",
    });

    const imported = { ...rectangle, sourceIdentity: { kind: "known" as const, value: "rectangle" } };
    expect(initialInspectorEditValues(imported).cornerRadius).toBeNull();
    const markup = renderToStaticMarkup(
      createElement(EntityInspectorEditor, {
        entity: imported,
        onCreateDraft: () => true,
        onFocusRestored: () => undefined,
        restoreFocus: null,
      }),
    );
    expect(markup).not.toContain("Corner radius of");
    expect(validateInspectorEdits(imported, values(imported, { cornerRadius: "0.5" }))).toEqual({
      errors: { cornerRadius: expect.stringMatching(/only for Studio-created Rectangles/i) },
      kind: "invalid",
    });
  });

  it("renders the corner radius field for a Studio-native Rectangle", () => {
    const markup = renderToStaticMarkup(
      createElement(EntityInspectorEditor, {
        entity: studioRectangleEntity(),
        onCreateDraft: () => true,
        onFocusRestored: () => undefined,
        restoreFocus: null,
      }),
    );
    expect(markup).toContain('aria-label="Corner radius of rectangle"');
    expect(markup).toContain('data-inspector-field="cornerRadius"');
  });
});
