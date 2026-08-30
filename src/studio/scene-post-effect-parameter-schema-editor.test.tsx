import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1 } from "./scene-post-effect-parameter-schema-draft";
import { ScenePostEffectParameterSchemaEditor } from "./scene-post-effect-parameter-schema-editor";

const row = (index: number) => ({
  defaultValue: `${index + 1}`,
  max: "10",
  min: "0",
  name: `Parameter ${index + 1}`,
  step: "0.1",
  type: "f32" as const,
});

describe("ScenePostEffectParameterSchemaEditor", () => {
  it("renders editable scalar fields, fixed host slots, and row controls", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectParameterSchemaEditor disabledReason={null} draft={[row(0), row(1)]} onChange={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Scene post-effect parameter schema"');
    expect(markup).toContain("2 / 8");
    expect(markup).toContain(SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1[0]);
    expect(markup).toContain(SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1[1]);
    expect(markup).toContain('aria-label="Scene effect parameter 1 name"');
    expect(markup).toContain('aria-label="Scene effect parameter 1 default"');
    expect(markup).toContain('aria-label="Scene effect parameter 1 min"');
    expect(markup).toContain('aria-label="Scene effect parameter 1 max"');
    expect(markup).toContain('aria-label="Scene effect parameter 1 step"');
    expect(markup).toContain('aria-label="Move parameter 2 up"');
    expect(markup).toContain('aria-label="Move parameter 1 down"');
    expect(markup).toContain('aria-label="Remove parameter 1"');
    expect(markup).toContain("Add parameter");
    expect(markup).toContain("Add color parameter");
  });

  it("renders one RGB control across three contiguous host slots", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectParameterSchemaEditor
        disabledReason={null}
        draft={[row(0), { blue: "1", green: "0.55", name: "Tint", red: "0.2", type: "rgb" }]}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("4 / 8");
    expect(markup).toContain("Parameter 2 · Color");
    expect(markup).toContain("parameters_0.y, parameters_0.z, parameters_0.w");
    expect(markup).toContain('aria-label="Scene effect parameter 2 default color"');
    expect(markup).toContain('type="color" value="#338cff"');
  });

  it("shows the reason and disables every mutation while schema editing is unavailable", () => {
    const reason = "Remove this effect from the Scene stack before editing its parameter schema.";
    const markup = renderToStaticMarkup(
      <ScenePostEffectParameterSchemaEditor disabledReason={reason} draft={[row(0)]} onChange={vi.fn()} />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain(reason);
    expect(markup).toMatch(/aria-label="Scene effect parameter 1 name"[^>]*disabled=""/u);
    expect(markup).toMatch(/aria-label="Remove parameter 1"[^>]*disabled=""/u);
    expect(markup).toMatch(/>Add parameter<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Add parameter<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Add color parameter<\/button>/u);
  });

  it("uses every fixed slot once and refuses a ninth row", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectParameterSchemaEditor
        disabledReason={null}
        draft={SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.map((_, index) => row(index))}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("8 / 8");
    for (const slot of SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1) expect(markup).toContain(slot);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>All 8 parameter slots used<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>3 contiguous slots required<\/button>/u);
    expect(markup).not.toContain('aria-label="Scene effect parameter 9 name"');
  });
});
