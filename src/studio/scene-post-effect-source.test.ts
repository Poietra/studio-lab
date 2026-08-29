import { describe, expect, it } from "vitest";

import {
  acceptedStudioScenePostEffectReferenceV1,
  acceptedStudioScenePostEffectRegistrySourceV1,
  acceptStudioScenePostEffectSourceV1,
  createStudioScenePostEffectSourceV1,
  EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE,
  findStudioScenePostEffectSourceV1,
  listStudioScenePostEffectSourcesV1,
  MAX_PROJECT_SCENE_POST_EFFECT_ASSETS,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  projectScenePostEffectLibraryStateSchema,
  rejectStudioScenePostEffectSourceV1,
  removeStudioScenePostEffectSourceV1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
  updateStudioScenePostEffectReferenceTextureV1,
} from "./scene-post-effect-source";

const PROJECT_TEXTURE = {
  asset: { assetId: "project-image", sha256: "a".repeat(64) },
  sampler: "linear" as const,
};

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

function createAsset(name: string, state = EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE) {
  return createStudioScenePostEffectSourceV1(state, { name });
}

describe("project Scene post-effect asset library", () => {
  it("creates named Wave Distortion starters with stable, monotonic revisions", () => {
    const first = createAsset("Wave Distortion");
    const second = createAsset("Scan Lines", first.state);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.state.nextAssetRevision).toBe(3);
    expect(listStudioScenePostEffectSourcesV1(second.state).map(({ name, revision }) => ({ name, revision }))).toEqual([
      { name: "Wave Distortion", revision: 1 },
      { name: "Scan Lines", revision: 2 },
    ]);
    expect(findStudioScenePostEffectSourceV1(second.state, first.revision)).toMatchObject({
      accepted: null,
      draft: {
        diagnostic: null,
        parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
        source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
        sourceLanguage: "wgsl",
      },
      name: "Wave Distortion",
      revision: 1,
    });
    expect(findStudioScenePostEffectSourceV1(second.state, 99)).toBeNull();
  });

  it("enforces the library bound and validates semantic names", () => {
    const first = createAsset("Effect 1");
    expect(() => createAsset(" Effect 2 ", first.state)).toThrow(/surrounding whitespace/);

    let state = first.state;
    for (let index = 2; index <= MAX_PROJECT_SCENE_POST_EFFECT_ASSETS; index += 1) {
      state = createAsset(`Effect ${index}`, state).state;
    }
    expect(state.assets).toHaveLength(MAX_PROJECT_SCENE_POST_EFFECT_ASSETS);
    expect(() => createAsset("Effect 9", state)).toThrow(/at most 8/);
  });

  it("accepts each asset independently and projects the selected stable revision", () => {
    const first = createAsset("Wave Distortion");
    const second = createAsset("GLSL Copy", first.state);
    const firstAsset = findStudioScenePostEffectSourceV1(second.state, first.revision)!;
    const firstAccepted = acceptStudioScenePostEffectSourceV1(second.state, first.revision, firstAsset.draft);
    const secondAsset = findStudioScenePostEffectSourceV1(firstAccepted, second.revision)!;
    const bothAccepted = acceptStudioScenePostEffectSourceV1(firstAccepted, second.revision, {
      canonicalWgslSource: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
      parameterSchema: secondAsset.draft.parameterSchema,
      source: GLSL_SOURCE,
      sourceLanguage: "glsl",
    });

    expect(findStudioScenePostEffectSourceV1(bothAccepted, first.revision)?.accepted).toMatchObject({
      generation: 1,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    });
    expect(findStudioScenePostEffectSourceV1(bothAccepted, second.revision)?.accepted).toMatchObject({
      generation: 1,
      originalGlslSource: GLSL_SOURCE,
    });
    expect(acceptedStudioScenePostEffectReferenceV1(bothAccepted, second.revision)).toEqual({
      parameters: [12, 64, 0.75],
      revision: second.revision,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    });
    expect(acceptedStudioScenePostEffectRegistrySourceV1(bothAccepted, second.revision)).toEqual({
      revision: second.revision,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
      source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
    });
    expect(JSON.stringify(acceptedStudioScenePostEffectRegistrySourceV1(bothAccepted, second.revision))).not.toContain(
      "#version 450",
    );
  });

  it("keeps asset identity stable while accepted source generation changes", () => {
    const created = createAsset("Editable");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, asset.draft);
    const repeatedAsset = findStudioScenePostEffectSourceV1(accepted, created.revision)!;
    const repeated = acceptStudioScenePostEffectSourceV1(accepted, created.revision, repeatedAsset.draft);
    expect(findStudioScenePostEffectSourceV1(repeated, created.revision)?.accepted?.generation).toBe(1);

    const editedAsset = findStudioScenePostEffectSourceV1(repeated, created.revision)!;
    const edited = acceptStudioScenePostEffectSourceV1(repeated, created.revision, {
      ...editedAsset.draft,
      source: `${editedAsset.draft.source}\n// accepted edit`,
    });
    expect(findStudioScenePostEffectSourceV1(edited, created.revision)).toMatchObject({
      accepted: { generation: 2 },
      revision: created.revision,
    });
    expect(acceptedStudioScenePostEffectReferenceV1(edited, created.revision)?.revision).toBe(created.revision);
  });

  it("keeps the auxiliary texture declaration aligned across source, registry, and Scene reference", () => {
    const created = createAsset("Textured effect");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
      ...asset.draft,
      textureSlot: "texture2d",
    });

    expect(findStudioScenePostEffectSourceV1(accepted, created.revision)).toMatchObject({
      accepted: { generation: 1, textureSlot: "texture2d" },
      draft: { textureSlot: "texture2d" },
    });
    expect(acceptedStudioScenePostEffectRegistrySourceV1(accepted, created.revision)).toMatchObject({
      revision: created.revision,
      textureSlot: "texture2d",
    });
    expect(() => acceptedStudioScenePostEffectReferenceV1(accepted, created.revision)).toThrow(
      /requires one project texture assignment/,
    );
    const reference = acceptedStudioScenePostEffectReferenceV1(accepted, created.revision, undefined, PROJECT_TEXTURE);
    expect(reference?.texture).toEqual(PROJECT_TEXTURE);
    expect(
      updateStudioScenePostEffectReferenceTextureV1(accepted, created.revision, reference!, {
        ...PROJECT_TEXTURE,
        sampler: "nearest",
      }).texture,
    ).toEqual({ ...PROJECT_TEXTURE, sampler: "nearest" });
    expect(() => updateStudioScenePostEffectReferenceTextureV1(accepted, created.revision, reference!, null)).toThrow(
      /requires one project texture assignment/,
    );
  });

  it("rejects a texture reference when the accepted source declares no auxiliary slot", () => {
    const created = createAsset("No texture");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, asset.draft);

    expect(() =>
      acceptedStudioScenePostEffectReferenceV1(accepted, created.revision, undefined, PROJECT_TEXTURE),
    ).toThrow(/does not declare a texture slot/);
  });

  it("keeps the texture ABI immutable after the first accepted generation", () => {
    const created = createAsset("ABI change");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, asset.draft);
    expect(() =>
      acceptStudioScenePostEffectSourceV1(accepted, created.revision, {
        ...findStudioScenePostEffectSourceV1(accepted, created.revision)!.draft,
        textureSlot: "texture2d",
      }),
    ).toThrow(/texture-slot contract is immutable/);
  });

  it("contains a rejected draft to one asset and retains its last accepted source", () => {
    const first = createAsset("Stable");
    const second = createAsset("Broken", first.state);
    const firstAccepted = acceptStudioScenePostEffectSourceV1(
      second.state,
      first.revision,
      findStudioScenePostEffectSourceV1(second.state, first.revision)!.draft,
    );
    const secondAccepted = acceptStudioScenePostEffectSourceV1(
      firstAccepted,
      second.revision,
      findStudioScenePostEffectSourceV1(firstAccepted, second.revision)!.draft,
    );
    const rejected = rejectStudioScenePostEffectSourceV1(secondAccepted, second.revision, {
      diagnostic: "WGSL parse error at line 1",
      parameterSchema: findStudioScenePostEffectSourceV1(secondAccepted, second.revision)!.draft.parameterSchema,
      source: "@fragment fn broken(",
    });

    expect(findStudioScenePostEffectSourceV1(rejected, first.revision)).toEqual(
      findStudioScenePostEffectSourceV1(secondAccepted, first.revision),
    );
    expect(findStudioScenePostEffectSourceV1(rejected, second.revision)).toMatchObject({
      accepted: findStudioScenePostEffectSourceV1(secondAccepted, second.revision)!.accepted,
      draft: { diagnostic: "WGSL parse error at line 1", source: "@fragment fn broken(" },
    });
    expect(acceptedStudioScenePostEffectRegistrySourceV1(rejected, second.revision)?.source).toBe(
      STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
    );
  });

  it("removes only uncompiled assets without reusing their revisions", () => {
    const first = createAsset("Draft");
    const second = createAsset("Accepted", first.state);
    const accepted = acceptStudioScenePostEffectSourceV1(
      second.state,
      second.revision,
      findStudioScenePostEffectSourceV1(second.state, second.revision)!.draft,
    );

    expect(() => removeStudioScenePostEffectSourceV1(accepted, second.revision)).toThrow(/Undo and Redo/);
    const removed = removeStudioScenePostEffectSourceV1(accepted, first.revision);
    expect(findStudioScenePostEffectSourceV1(removed, first.revision)).toBeNull();
    const replacement = createAsset("Replacement", removed);
    expect(replacement.revision).toBe(3);
    expect(() => removeStudioScenePostEffectSourceV1(replacement.state, 99)).toThrow(/does not exist/);
  });

  it("migrates legacy singleton states without losing accepted source data", () => {
    const legacy = {
      asset: {
        accepted: {
          generation: 4,
          parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
        },
        draft: {
          diagnostic: null,
          parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
          source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
        },
      },
      schema: "poietra.scene-post-effect-source-state",
      version: 1,
    };

    const migrated = projectScenePostEffectLibraryStateSchema.parse(legacy);
    expect(migrated).toMatchObject({
      assets: [
        {
          accepted: { generation: 4, source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1 },
          draft: { sourceLanguage: "wgsl" },
          name: "Custom Scene effect",
          revision: 1,
        },
      ],
      nextAssetRevision: 2,
      schema: "poietra.scene-post-effect-library-state",
      version: 1,
    });
    expect(acceptedStudioScenePostEffectReferenceV1(migrated, 1)?.revision).toBe(1);
    expect(projectScenePostEffectLibraryStateSchema.parse({ ...legacy, asset: null })).toEqual(
      EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE,
    );
  });

  it("validates persisted library invariants, UTF-8 bytes, and exact parameter values", () => {
    const created = createAsset("Validated");
    const asset = findStudioScenePostEffectSourceV1(created.state, created.revision)!;
    expect(() =>
      acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
        parameterSchema: asset.draft.parameterSchema,
        source: "界".repeat(Math.ceil(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 / 3) + 1),
      }),
    ).toThrow(/UTF-8 bytes/);
    expect(() =>
      acceptStudioScenePostEffectSourceV1(created.state, created.revision, {
        parameterSchema: [
          { default: 0, name: "Amount", range: { max: 1, min: 0, step: 0.1 }, type: "f32" },
          { default: 0, name: "amount", range: { max: 1, min: 0, step: 0.1 }, type: "f32" },
        ],
        source: asset.draft.source,
      }),
    ).toThrow(/Parameter names must be unique/);

    const accepted = acceptStudioScenePostEffectSourceV1(created.state, created.revision, asset.draft);
    expect(() => acceptedStudioScenePostEffectReferenceV1(accepted, created.revision, [12, 64])).toThrow(
      /every declared parameter/,
    );
    expect(() => acceptedStudioScenePostEffectReferenceV1(accepted, created.revision, [65, 64, 0.75])).toThrow(
      /Amplitude must be between 0 and 64/,
    );
    expect(
      projectScenePostEffectLibraryStateSchema.safeParse({
        ...accepted,
        assets: [...accepted.assets, { ...accepted.assets[0], name: "Other", revision: accepted.assets[0]!.revision }],
      }).success,
    ).toBe(false);
    expect(
      projectScenePostEffectLibraryStateSchema.safeParse({
        ...accepted,
        nextAssetRevision: accepted.assets[0]!.revision,
      }).success,
    ).toBe(false);
  });
});
