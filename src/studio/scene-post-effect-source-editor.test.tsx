import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  acceptStudioScenePostEffectSourceV1,
  createStudioScenePostEffectSourceV1,
  EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE,
  findStudioScenePostEffectSourceV1,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  rejectStudioScenePostEffectSourceV1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
} from "./scene-post-effect-source";
import { readStudioScenePostEffectGlslFileV1, ScenePostEffectSourceEditor } from "./scene-post-effect-source-editor";

const GLSL_SOURCE = `#version 450
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;
layout(set = 0, binding = 1) uniform texture2D scene_texture;
layout(set = 0, binding = 2) uniform sampler scene_sampler;
void main() {
    vec2 coordinate = gl_FragCoord.xy / max(host.viewport_and_time.xy, vec2(1.0));
    output_color = texture(sampler2D(scene_texture, scene_sampler), coordinate);
}
`;

const callbacks = () => ({
  duration: 4,
  imageAssets: [],
  onAddToStack: vi.fn(),
  onCompile: vi.fn(),
  onCreate: vi.fn(),
  onParametersChange: vi.fn(),
  onParameterTrackChange: vi.fn(),
  onRemove: vi.fn(),
  onSelect: vi.fn(),
  onTextureChange: vi.fn(),
  parameterAnimationAvailable: true,
  selectedRevision: null,
  parameterTracks: [],
  playhead: 1,
  texture: null,
});

function createAsset(name: string, state = EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE) {
  return createStudioScenePostEffectSourceV1(state, { name });
}

function acceptAsset(created: ReturnType<typeof createAsset>) {
  const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
  const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, asset.draft);
  return { asset: findStudioScenePostEffectSourceV1(state, created.revision)!, state };
}

describe("ScenePostEffectSourceEditor", () => {
  it("offers the bounded starter preset catalog when the project has no custom asset", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[]}
        assets={[]}
        available
        parameters={null}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain('aria-label="Custom Scene post effect"');
    expect(markup).toContain("Wave Distortion");
    expect(markup).toContain('<option value="vignette">Vignette</option>');
    expect(markup).toContain('<option value="color-tint">Color Tint</option>');
    expect(markup).toContain("Create starter");
    expect(markup).toContain(
      "Choose a code-free WGSL starter, then edit its source or import Vulkan GLSL 450 when needed.",
    );
  });

  it("lists two named assets and selects the active revision", () => {
    const first = createAsset("Wave Distortion");
    const second = createAsset("Chromatic Shift", first.state);
    const secondAsset = findStudioScenePostEffectSourceV1(second.state, second.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(second.state, second.revision, secondAsset.draft);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[second.revision]}
        assets={state.assets}
        available
        parameters={[12, 64, 0.75]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain("2 / 8 project effects");
    expect(markup).toContain('aria-label="Edit Scene effect Wave Distortion, revision 1"');
    expect(markup).toContain('aria-label="Edit Scene effect Chromatic Shift, revision 2" aria-pressed="true"');
    expect(markup).toContain(`data-scene-post-effect-asset-revision="${first.revision}"`);
    expect(markup).toContain(`data-scene-post-effect-asset-revision="${second.revision}"`);
    expect(markup).toContain("Chromatic Shift · WGSL");
    expect(markup).toContain("Active · generation 1");
    expect(markup).toContain("In Scene stack");
  });

  it("renders the accepted identity, fixed ABI, source editor, and live scalar controls", () => {
    const created = createAsset("Wave Distortion");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[created.revision]}
        assets={accepted.state.assets}
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
    expect(markup).toContain("binding 2 is the fixed linear clamp sampler");
    expect(markup).toContain("renderer-owned");
    expect(markup).toContain("Create a new effect to change this accepted binding contract.");
    expect(markup).toContain('aria-label="Scene post-effect parameters"');
    expect(markup).toContain('aria-label="Scene post-effect parameter schema"');
    expect(markup).toContain("3 / 8");
    expect(markup).toContain("parameters_0.x");
    expect(markup).toContain("parameters_0.z");
    expect(markup).toMatch(/aria-label="Scene effect parameter 1 name"[^>]*disabled=""/u);
    expect(markup).toContain("Remove this effect from the Scene stack before changing its parameter contract.");
    expect(markup).toContain('aria-label="Amplitude Scene post-effect parameter"');
    expect(markup).toContain('aria-label="Wavelength Scene post-effect parameter"');
    expect(markup).toContain('aria-label="Speed Scene post-effect parameter"');
    expect(markup).toContain("<output>18</output>");
    expect(markup).toContain("<output>80</output>");
    expect(markup).toContain("<output>1.25</output>");
    expect(markup).toContain('aria-label="Scene post-effect WGSL source"');
    expect(markup).toContain("textureSample(scene_texture, scene_sampler");
    expect(markup).toContain("Compile &amp; accept WGSL");
    expect(markup).toContain("Reset source");
    expect(markup).toContain("In Scene stack");
  });

  it("renders one logical RGB control over three flat Scene effect parameters", () => {
    const created = createAsset("Color grade");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      parameterSchema: [
        { default: 0.4, name: "Strength", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        { default: [0.2, 0.55, 1], name: "Tint", type: "rgb" },
      ],
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={state.assets}
        available
        parameters={[0.4, 1, 0.25, 0.75]}
        sourceAvailable
      />,
    );

    expect(markup).toContain("4 / 8");
    expect(markup).toContain("parameters_0.y, parameters_0.z, parameters_0.w");
    expect(markup).toContain('aria-label="Tint Scene post-effect color parameter"');
    expect(markup).toContain('type="color" value="#ff40bf"');
    expect(markup).toContain("<output>#ff40bf</output>");
    expect(markup).toContain("0 / 2 parameters animated");
    expect(markup).toContain("Tint");
  });

  it("reconstructs three aligned scalar tracks as one logical RGB animation", () => {
    const created = createAsset("Color grade");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      parameterSchema: [
        { default: 0.4, name: "Strength", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        { default: [0.2, 0.55, 1], name: "Tint", type: "rgb" },
      ],
    });
    const parameterTracks = [0.2, 0.55, 1].map((base, component) => ({
      keyframes: [
        { easing: "linear" as const, time: 0, value: base },
        { easing: "smooth" as const, time: 2, value: component === 2 ? 0.25 : base },
      ],
      name: "Tint",
      parameterIndex: component + 1,
      revision: created.revision,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    }));
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={state.assets}
        available
        parameters={[0.4, 0.2, 0.55, 1]}
        parameterTracks={parameterTracks}
        sourceAvailable
      />,
    );

    expect(markup).toContain("1 / 2 parameters animated");
    expect(markup).toContain("Tint · animated");
    expect(markup).toContain("Tint · 2 color keyframes");
    expect(markup).toContain('aria-label="Tint color keyframe 2 value"');
    expect(markup).toContain('type="color" value="#338c40"');
    expect(markup).toMatch(/aria-label="Tint Scene post-effect color parameter"[^>]*disabled=""/u);
  });

  it("uses the flattened offset for a scalar animation after RGB", () => {
    const created = createAsset("Color grade");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      parameterSchema: [
        { default: [0.2, 0.55, 1], name: "Tint", type: "rgb" },
        { default: 0.4, name: "Strength", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
      ],
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={state.assets}
        available
        parameters={[0.2, 0.55, 1, 0.4]}
        parameterTracks={[
          {
            keyframes: [
              { easing: "linear", time: 0, value: 0.4 },
              { easing: "smooth", time: 2, value: 0.8 },
            ],
            name: "Strength",
            parameterIndex: 3,
            revision: created.revision,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          },
        ]}
        sourceAvailable
      />,
    );

    expect(markup).toContain("1 / 2 parameters animated");
    expect(markup).toContain("Strength · animated");
    expect(markup).toContain('data-scene-post-effect-parameter-index="3"');
    expect(markup).toMatch(/aria-label="Strength Scene post-effect parameter"[^>]*disabled=""/u);
    expect(markup).not.toMatch(/aria-label="Tint Scene post-effect color parameter"[^>]*disabled=""/u);
  });

  it("fails closed without crashing when an RGB component track is missing", () => {
    const created = createAsset("Color grade");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      parameterSchema: [{ default: [0.2, 0.55, 1], name: "Tint", type: "rgb" }],
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={state.assets}
        available
        parameters={[0.2, 0.55, 1]}
        parameterTracks={[
          {
            keyframes: [
              { easing: "linear", time: 0, value: 0.2 },
              { easing: "smooth", time: 2, value: 0.5 },
            ],
            name: "Tint",
            parameterIndex: 0,
            revision: created.revision,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          },
        ]}
        sourceAvailable
      />,
    );

    expect(markup).toContain("Tint · invalid animation");
    expect(markup).toContain("requires exactly three complete scalar component tracks");
    expect(markup).not.toContain("Animate color from");
  });

  it("reserves three scalar tracks before offering a new RGB animation", () => {
    const created = createAsset("Color grade");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      parameterSchema: [{ default: [0.2, 0.55, 1], name: "Tint", type: "rgb" }],
    });
    const occupiedTracks = Array.from({ length: 30 }, (_, index) => ({
      keyframes: [
        { easing: "linear" as const, time: 0, value: 0 },
        { easing: "smooth" as const, time: 2, value: 1 },
      ],
      name: `Other ${index}`,
      parameterIndex: index % 8,
      revision: created.revision + index + 1,
      shaderId: `other-${index}`,
    }));
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={state.assets}
        available
        parameters={[0.2, 0.55, 1]}
        parameterTracks={occupiedTracks}
        sourceAvailable
      />,
    );

    expect(markup).toContain("It uses three of the 32 scalar tracks.");
    expect(markup).toMatch(/disabled=""[^>]*>Animate color from 0s to 1\.00s/u);
  });

  it("renders the active parameter animation from the canonical Scene effect Program", () => {
    const created = createAsset("Wave Distortion");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={accepted.state.assets}
        available
        parameters={[18, 80, 1.25]}
        parameterTracks={[
          {
            keyframes: [
              { easing: "smooth", time: 0, value: 18 },
              { easing: "linear", time: 2, value: 32 },
            ],
            name: "Amplitude",
            parameterIndex: 0,
            revision: created.revision,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          },
        ]}
        sourceAvailable
      />,
    );

    expect(markup).toContain('aria-label="Scene post-effect parameter animation"');
    expect(markup).toContain("Amplitude · 2 keyframes");
    expect(markup).toContain('aria-label="Amplitude keyframe 2 value"');
    expect(markup).toContain("Update animation");
    expect(markup).toContain("Remove animation");
    expect(markup).toContain("1 / 3 parameters animated");
    expect(markup).toContain("Amplitude · animated");
    expect(markup).toContain("Animated parameters keep their static baseline locked.");
    expect(markup).toContain("Remove this effect");
    expect(markup).toContain("parameter animation before changing its parameter contract.");
    expect(markup).toMatch(/aria-label="Amplitude Scene post-effect parameter"[^>]*disabled=""/u);
    expect(markup).not.toMatch(/aria-label="Wavelength Scene post-effect parameter"[^>]*disabled=""/u);
  });

  it("lists independent animation targets when two parameters have Timeline tracks", () => {
    const created = createAsset("Wave Distortion");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={accepted.state.assets}
        available
        parameters={[18, 80, 1.25]}
        parameterTracks={[
          {
            keyframes: [
              { easing: "smooth", time: 0, value: 18 },
              { easing: "linear", time: 2, value: 32 },
            ],
            name: "Amplitude",
            parameterIndex: 0,
            revision: created.revision,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          },
          {
            keyframes: [
              { easing: "smooth", time: 0, value: 80 },
              { easing: "ease-out", time: 2.75, value: 120 },
            ],
            name: "Wavelength",
            parameterIndex: 1,
            revision: created.revision,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          },
        ]}
        sourceAvailable
      />,
    );

    expect(markup).toContain("2 / 3 parameters animated");
    expect(markup).toContain("Amplitude · animated");
    expect(markup).toContain("Wavelength · animated");
    expect(markup).toContain('data-scene-post-effect-parameter-track="Amplitude"');
    expect(markup).toMatch(/aria-label="Amplitude Scene post-effect parameter"[^>]*disabled=""/u);
    expect(markup).toMatch(/aria-label="Wavelength Scene post-effect parameter"[^>]*disabled=""/u);
    expect(markup).not.toMatch(/aria-label="Speed Scene post-effect parameter"[^>]*disabled=""/u);
  });

  it("disables parameter animation while the timeline projection is not ready", () => {
    const created = createAsset("Wave Distortion");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={accepted.state.assets}
        available
        parameterAnimationAvailable={false}
        parameters={[18, 80, 1.25]}
        sourceAvailable
      />,
    );

    const animateControl = markup.match(/<button[^>]*disabled=""[^>]*>Animate from 0s to/u)?.[0];
    expect(animateControl).toBeDefined();
    const sourceControl = markup.match(/<textarea[^>]*aria-label="Scene post-effect WGSL source"[^>]*>/u)?.[0];
    expect(sourceControl).toBeDefined();
    expect(sourceControl).not.toContain("disabled");
  });

  it("offers one verified project PNG and sampler for a declared auxiliary texture slot", () => {
    const created = createAsset("PNG Mix");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      textureSlot: "texture2d",
    });
    const imageAsset = {
      byteLength: 4,
      bytes: new ArrayBuffer(4),
      image: {
        asset: { assetId: "effect-texture", sha256: "a".repeat(64) },
        localRect: { bottom: -1, left: -1, right: 1, top: 1 },
        sampler: "linear" as const,
      },
      label: "effect-texture.png",
      pixelHeight: 2,
      pixelWidth: 2,
    };
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        {...callbacks()}
        activeRevisions={[created.revision]}
        assets={accepted.assets}
        available
        imageAssets={[imageAsset]}
        parameters={[12, 64, 0.75]}
        sourceAvailable
        texture={{ asset: imageAsset.image.asset, sampler: "nearest" }}
      />,
    );

    expect(markup).toContain('aria-label="Declare auxiliary Scene effect texture"');
    expect(markup).toMatch(/aria-label="Declare auxiliary Scene effect texture"[^>]*checked=""/);
    expect(markup).toContain('aria-label="Auxiliary Scene effect texture"');
    expect(markup).toContain('aria-label="Auxiliary Scene effect image"');
    expect(markup).toContain("effect-texture.png · 2×2");
    expect(markup).not.toContain("Choose a project PNG");
    expect(markup).toContain('<option value="nearest" selected="">Nearest</option>');
    expect(markup).toContain("Update auxiliary texture");
  });

  it("renders GLSL paste and bounded local file import while retaining canonical WGSL", () => {
    const created = createAsset("Custom GLSL");
    const createdAsset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      canonicalWgslSource: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
      parameterSchema: createdAsset.draft.parameterSchema,
      source: GLSL_SOURCE,
      sourceLanguage: "glsl",
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[created.revision]}
        assets={accepted.assets}
        available
        parameters={[12, 64, 0.75]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain("Custom GLSL");
    expect(markup).toContain('aria-label="Scene post-effect source language"');
    expect(markup).toContain('<option value="glsl" selected="">Vulkan GLSL 450</option>');
    expect(markup).toContain("entry point main");
    expect(markup).toContain("set 0 binding 0");
    expect(markup).toContain("binding 2 is the fixed linear clamp sampler");
    expect(markup).toContain('accept=".frag,.glsl"');
    expect(markup).toContain('aria-label="Scene post-effect GLSL source"');
    expect(markup).toContain("#version 450");
    expect(markup).toContain("Compile &amp; accept GLSL");
    expect(markup).toContain("Clear source");
    expect(markup).not.toContain("@fragment\nfn fs_main");
  });

  it("shows a rejected draft while explaining that the accepted revision remains active", () => {
    const created = createAsset("Broken WGSL");
    const accepted = acceptAsset(created);
    const rejected = rejectStudioScenePostEffectSourceV1(accepted.state, created.revision, {
      diagnostic: "post-effect.wgsl:7:4: expected expression",
      parameterSchema: accepted.asset.draft.parameterSchema,
      source: "@fragment fn broken(",
      textureSlot: "texture2d",
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[created.revision]}
        assets={rejected.assets}
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
    expect(markup).toContain("In Scene stack");
    expect(markup).toMatch(/aria-label="Declare auxiliary Scene effect texture"[^>]*disabled=""[^>]*type="checkbox"/u);
    expect(markup).not.toMatch(/aria-label="Declare auxiliary Scene effect texture"[^>]*checked=""/u);
  });

  it("keeps an inactive accepted effect off the stack until its changed schema compiles", () => {
    const created = createAsset("Schema draft");
    const accepted = acceptAsset(created);
    const rejected = rejectStudioScenePostEffectSourceV1(accepted.state, created.revision, {
      diagnostic: "post-effect.wgsl:8: expected expression",
      parameterSchema: [
        { default: 0.25, name: "Red level", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        { default: 0.5, name: "Green level", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
      ],
      source: "@fragment fn broken(",
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[]}
        assets={rejected.assets}
        available
        parameters={null}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain('value="Red level"');
    expect(markup).toContain('value="Green level"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Compile parameter changes<\/button>/u);
    expect(markup).toContain("Last accepted generation 1 remains active.");
  });

  it("labels a rejected GLSL draft and keeps the last accepted generation available", () => {
    const created = createAsset("Broken GLSL");
    const accepted = acceptAsset(created);
    const rejected = rejectStudioScenePostEffectSourceV1(accepted.state, created.revision, {
      diagnostic: "post-effect.glsl:8: binding 4 is unsupported",
      parameterSchema: accepted.asset.draft.parameterSchema,
      source: GLSL_SOURCE,
      sourceLanguage: "glsl",
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[created.revision]}
        assets={rejected.assets}
        available
        parameters={[12, 64, 0.75]}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain("GLSL was rejected");
    expect(markup).toContain("post-effect.glsl:8: binding 4 is unsupported");
    expect(markup).toContain("Last accepted generation 1 remains active.");
    expect(markup).toContain('aria-label="Scene post-effect GLSL source"');
    expect(markup).toContain("#version 450");
  });

  it("keeps assignment controls unavailable without trapping source recovery", () => {
    const created = createAsset("Unavailable");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevisions={[created.revision]}
        assets={accepted.state.assets}
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

  it("reads only bounded .frag/.glsl UTF-8 files", async () => {
    const encoded = new TextEncoder().encode(GLSL_SOURCE);
    await expect(
      readStudioScenePostEffectGlslFileV1({
        arrayBuffer: async () => encoded.buffer,
        name: "wave.frag",
        size: encoded.byteLength,
      }),
    ).resolves.toBe(GLSL_SOURCE);
    await expect(
      readStudioScenePostEffectGlslFileV1({
        arrayBuffer: async () => encoded.buffer,
        name: "wave.txt",
        size: encoded.byteLength,
      }),
    ).rejects.toThrow(/\.frag or \.glsl/);
    await expect(
      readStudioScenePostEffectGlslFileV1({
        arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer,
        name: "broken.glsl",
        size: 2,
      }),
    ).rejects.toThrow(/UTF-8/);
    const unread = vi.fn(async () => new ArrayBuffer(0));
    await expect(
      readStudioScenePostEffectGlslFileV1({
        arrayBuffer: unread,
        name: "huge.frag",
        size: MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 + 1,
      }),
    ).rejects.toThrow(/at most/);
    expect(unread).not.toHaveBeenCalled();
  });
});
