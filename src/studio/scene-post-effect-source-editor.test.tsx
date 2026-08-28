import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  acceptStudioScenePostEffectSourceV1,
  createStudioScenePostEffectSourceV1,
  EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  rejectStudioScenePostEffectSourceV1,
} from "./scene-post-effect-source";
import { ScenePostEffectSourceEditor } from "./scene-post-effect-source-editor";

const callbacks = () => ({
  onActivate: vi.fn(),
  onCompile: vi.fn(),
  onCreate: vi.fn(),
  onParametersChange: vi.fn(),
  onRemove: vi.fn(),
});

describe("ScenePostEffectSourceEditor", () => {
  it("offers one Wave Distortion starter when the project has no custom asset", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        active={false}
        asset={null}
        available
        parameters={null}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain('aria-label="Custom Scene post effect"');
    expect(markup).toContain("Wave Distortion");
    expect(markup).toContain("Create starter");
    expect(markup).toContain("project-local WGSL effect");
  });

  it("renders the accepted identity, fixed ABI, source editor, and live scalar controls", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        active
        asset={accepted.asset}
        available
        parameters={[18, 80, 1.25]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain(PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1);
    expect(markup).toContain("Active · generation 1");
    expect(markup).toContain("binding 0 is viewport, sample time, and 8 scalar slots");
    expect(markup).toContain("binding 1 is the current Scene texture");
    expect(markup).toContain("renderer-owned");
    expect(markup).toContain('aria-label="Scene post-effect parameters"');
    expect(markup).toContain('aria-label="Amplitude Scene post-effect parameter"');
    expect(markup).toContain('aria-label="Wavelength Scene post-effect parameter"');
    expect(markup).toContain('aria-label="Speed Scene post-effect parameter"');
    expect(markup).toContain("<output>18</output>");
    expect(markup).toContain("<output>80</output>");
    expect(markup).toContain("<output>1.25</output>");
    expect(markup).toContain('aria-label="Scene post-effect WGSL source"');
    expect(markup).toContain("textureLoad(scene_texture");
    expect(markup).toContain("Compile &amp; accept WGSL");
    expect(markup).toContain("Reset source");
    expect(markup).toContain("Applied to Scene");
  });

  it("shows a rejected draft while explaining that the accepted revision remains active", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    const rejected = rejectStudioScenePostEffectSourceV1(accepted, {
      diagnostic: "post-effect.wgsl:7:4: expected expression",
      parameterSchema: accepted.asset!.draft.parameterSchema,
      source: "@fragment fn broken(",
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        active
        asset={rejected.asset}
        available
        parameters={[12, 64, 0.75]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain("Rejected draft");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("post-effect.wgsl:7:4: expected expression");
    expect(markup).toContain("Last accepted generation 1 remains active.");
    expect(markup).toContain("@fragment fn broken(");
    expect(markup).toContain("Applied to Scene");
  });

  it("keeps assignment controls unavailable without trapping source recovery", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        active
        asset={accepted.asset}
        available={false}
        parameters={[12]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain("The active Scene reference does not match the accepted parameter schema.");
    expect(markup).toContain("Reapply the effect.");
    expect(markup).toContain('disabled=""');
    const sourceControl = markup.match(/<textarea[^>]*aria-label="Scene post-effect WGSL source"[^>]*>/u)?.[0];
    expect(sourceControl).toBeDefined();
    expect(sourceControl).not.toContain("disabled");
  });
});
