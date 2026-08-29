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
void main() {
    output_color = texelFetch(scene_texture, ivec2(gl_FragCoord.xy), 0);
}
`;

const callbacks = () => ({
  onActivate: vi.fn(),
  onCompile: vi.fn(),
  onCreate: vi.fn(),
  onParametersChange: vi.fn(),
  onRemove: vi.fn(),
  onSelect: vi.fn(),
  selectedRevision: null,
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
  it("offers one Wave Distortion starter when the project has no custom asset", () => {
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevision={null}
        assets={[]}
        available
        parameters={null}
        sourceAvailable
        {...callbacks()}
      />,
    );

    expect(markup).toContain('aria-label="Custom Scene post effect"');
    expect(markup).toContain("Wave Distortion");
    expect(markup).toContain("Create starter");
    expect(markup).toContain("Create a WGSL starter, then paste or import Vulkan GLSL 450 when needed.");
  });

  it("lists two named assets and selects the active revision", () => {
    const first = createAsset("Wave Distortion");
    const second = createAsset("Chromatic Shift", first.state);
    const secondAsset = findStudioScenePostEffectSourceV1(second.state, second.revision)!;
    const state = acceptStudioScenePostEffectSourceV1(second.state, second.revision, secondAsset.draft);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevision={second.revision}
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
    expect(markup).toContain("Applied to Scene");
  });

  it("renders the accepted identity, fixed ABI, source editor, and live scalar controls", () => {
    const created = createAsset("Wave Distortion");
    const accepted = acceptAsset(created);
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevision={created.revision}
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
        activeRevision={created.revision}
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
    });
    const markup = renderToStaticMarkup(
      <ScenePostEffectSourceEditor
        activeRevision={created.revision}
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
    expect(markup).toContain("Applied to Scene");
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
        activeRevision={created.revision}
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
        activeRevision={created.revision}
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
