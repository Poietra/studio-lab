import { describe, expect, it } from "vitest";

import {
  acceptedStudioScenePostEffectReferenceV1,
  acceptedStudioScenePostEffectRegistrySourceV1,
  acceptStudioScenePostEffectSourceV1,
  createStudioScenePostEffectSourceV1,
  EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  projectScenePostEffectSourceStateV1Schema,
  rejectStudioScenePostEffectSourceV1,
  removeStudioScenePostEffectSourceV1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
} from "./scene-post-effect-source";

describe("project Scene post-effect source state", () => {
  it("creates one unaccepted Wave Distortion starter with the fixed ABI", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);

    expect(created.asset).toMatchObject({
      accepted: null,
      draft: {
        diagnostic: null,
        parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
        source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
      },
    });
    expect(created.asset?.draft.source).toContain("@group(0) @binding(0)");
    expect(created.asset?.draft.source).toContain("@group(0) @binding(1)");
    expect(created.asset?.draft.source).toContain("@fragment\nfn fs_main");
    expect(created.asset?.draft.source).not.toContain("@vertex");
    expect(() => createStudioScenePostEffectSourceV1(created)).toThrow(/exactly one custom Scene post effect/);
  });

  it("accepts a source, exposes only its reference to Scene IR, and revises material changes", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);

    expect(accepted.asset?.accepted).toMatchObject({
      generation: 1,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
      source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
    });
    expect(acceptedStudioScenePostEffectReferenceV1(accepted)).toEqual({
      parameters: [12, 64, 0.75],
      revision: 1,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    });
    expect(JSON.stringify(acceptedStudioScenePostEffectReferenceV1(accepted))).not.toContain("source");
    expect(acceptedStudioScenePostEffectRegistrySourceV1(accepted)).toEqual({
      revision: 1,
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
      source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
    });

    const repeated = acceptStudioScenePostEffectSourceV1(accepted, accepted.asset!.draft);
    expect(repeated.asset?.accepted?.generation).toBe(1);
    const edited = acceptStudioScenePostEffectSourceV1(repeated, {
      ...repeated.asset!.draft,
      source: `${repeated.asset!.draft.source}\n// accepted edit`,
    });
    expect(edited.asset?.accepted?.generation).toBe(2);
  });

  it("retains the last accepted source while preserving a rejected draft and diagnostic", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    const rejectedSource = "@fragment fn broken(";
    const rejected = rejectStudioScenePostEffectSourceV1(accepted, {
      diagnostic: "WGSL parse error at line 1",
      parameterSchema: accepted.asset!.draft.parameterSchema,
      source: rejectedSource,
    });

    expect(rejected.asset?.accepted).toEqual(accepted.asset?.accepted);
    expect(rejected.asset?.draft).toMatchObject({
      diagnostic: "WGSL parse error at line 1",
      source: rejectedSource,
    });
    expect(acceptedStudioScenePostEffectRegistrySourceV1(rejected)?.source).toBe(
      STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
    );
    expect(acceptedStudioScenePostEffectReferenceV1(rejected)?.revision).toBe(1);

    const repaired = acceptStudioScenePostEffectSourceV1(rejected, {
      parameterSchema: rejected.asset!.draft.parameterSchema,
      source: `${STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1}\n// repaired`,
    });
    expect(repaired.asset?.accepted?.generation).toBe(2);
    expect(repaired.asset?.draft.diagnostic).toBeNull();
  });

  it("validates UTF-8 bytes, parameter shape, ranges, and exact values", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    expect(() =>
      acceptStudioScenePostEffectSourceV1(created, {
        parameterSchema: created.asset!.draft.parameterSchema,
        source: "界".repeat(Math.ceil(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 / 3) + 1),
      }),
    ).toThrow(/UTF-8 bytes/);
    expect(() =>
      acceptStudioScenePostEffectSourceV1(created, {
        parameterSchema: Array.from({ length: 9 }, (_, index) => ({
          default: 0,
          name: `Parameter ${index}`,
          range: { max: 1, min: 0, step: 0.1 },
          type: "f32" as const,
        })),
        source: created.asset!.draft.source,
      }),
    ).toThrow();
    expect(() =>
      acceptStudioScenePostEffectSourceV1(created, {
        parameterSchema: [
          { default: 0, name: "Amount", range: { max: 1, min: 0, step: 0.1 }, type: "f32" },
          { default: 0, name: "amount", range: { max: 1, min: 0, step: 0.1 }, type: "f32" },
        ],
        source: created.asset!.draft.source,
      }),
    ).toThrow(/Parameter names must be unique/);

    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    expect(() => acceptedStudioScenePostEffectReferenceV1(accepted, [12, 64])).toThrow(/every declared parameter/);
    expect(() => acceptedStudioScenePostEffectReferenceV1(accepted, [65, 64, 0.75])).toThrow(
      /Amplitude must be between 0 and 64/,
    );
  });

  it("parses persisted state strictly and removes only an uncompiled custom asset", () => {
    const created = createStudioScenePostEffectSourceV1(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
    const accepted = acceptStudioScenePostEffectSourceV1(created, created.asset!.draft);
    expect(projectScenePostEffectSourceStateV1Schema.parse(JSON.parse(JSON.stringify(accepted)))).toEqual(accepted);
    expect(projectScenePostEffectSourceStateV1Schema.safeParse({ ...accepted, extra: true }).success).toBe(false);
    expect(() => removeStudioScenePostEffectSourceV1(accepted)).toThrow(/remains a project asset/);
    expect(removeStudioScenePostEffectSourceV1(created)).toEqual(EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1);
  });
});
