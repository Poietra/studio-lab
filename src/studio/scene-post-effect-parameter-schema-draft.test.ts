import { describe, expect, it } from "vitest";
import {
  appendScenePostEffectParameterSchemaDraftV1,
  moveScenePostEffectParameterSchemaDraftV1,
  parseScenePostEffectParameterSchemaDraftV1,
  removeScenePostEffectParameterSchemaDraftV1,
  SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1,
  type StudioScenePostEffectF32ParameterSchemaDraftRowV1,
  type StudioScenePostEffectParameterSchemaDraftRowV1,
  scenePostEffectParameterSchemaDraftSlotCountV1,
  scenePostEffectParameterSchemaDraftV1,
  scenePostEffectRgbToHexColorV1,
} from "./scene-post-effect-parameter-schema-draft";
import type { StudioScenePostEffectParameterSchemaV1 } from "./scene-post-effect-source";

const SCHEMA = [
  { default: 0.5, name: "Strength", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
  { default: 8, name: "Bands", range: { max: 24, min: 1, step: 1 }, type: "f32" },
] satisfies StudioScenePostEffectParameterSchemaV1;

function row(
  patch: Partial<StudioScenePostEffectF32ParameterSchemaDraftRowV1> = {},
): StudioScenePostEffectF32ParameterSchemaDraftRowV1 {
  return { defaultValue: "0.5", max: "1", min: "0", name: "Strength", step: "0.05", type: "f32", ...patch };
}

function errorMessage(rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[]) {
  const result = parseScenePostEffectParameterSchemaDraftV1(rows);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.message;
}

describe("Scene post-effect parameter schema draft", () => {
  it("round-trips canonical scalar parameters through string rows", () => {
    const rows = scenePostEffectParameterSchemaDraftV1(SCHEMA);
    expect(rows).toEqual([
      { defaultValue: "0.5", max: "1", min: "0", name: "Strength", step: "0.05", type: "f32" },
      { defaultValue: "8", max: "24", min: "1", name: "Bands", step: "1", type: "f32" },
    ]);
    expect(parseScenePostEffectParameterSchemaDraftV1(rows)).toEqual({ ok: true, schema: SCHEMA });
  });

  it("round-trips RGB defaults without reducing them to eight-bit color", () => {
    const schema = [
      { default: [0.2, 0.55, 1] as const, name: "Tint", type: "rgb" as const },
    ] satisfies StudioScenePostEffectParameterSchemaV1;
    const rows = scenePostEffectParameterSchemaDraftV1(schema);
    expect(rows).toEqual([{ blue: "1", green: "0.55", name: "Tint", red: "0.2", type: "rgb" }]);
    expect(scenePostEffectRgbToHexColorV1(schema[0].default)).toBe("#338cff");
    expect(parseScenePostEffectParameterSchemaDraftV1(rows)).toEqual({ ok: true, schema });
  });

  it("reports non-finite values with their row and field", () => {
    expect(errorMessage([row({ defaultValue: "NaN" })])).toContain("Parameter 1 defaultValue:");
    expect(errorMessage([row({ max: "Infinity" })])).toContain("Parameter 1 max:");
  });

  it("reports duplicate names case-insensitively", () => {
    expect(errorMessage([row(), row({ name: "strength" })])).toContain("Parameter 2 name:");
  });

  it("reports defaults outside the range", () => {
    expect(errorMessage([row({ defaultValue: "2" })])).toContain("Parameter 1 defaultValue:");
  });

  it("reports invalid ranges and steps", () => {
    expect(errorMessage([row({ max: "0" })])).toContain("Parameter 1 min/max:");
    expect(errorMessage([row({ step: "0" })])).toContain("Parameter 1 step:");
    expect(errorMessage([row({ step: "2" })])).toContain("Parameter 1 step:");
  });

  it("publishes the eight scalar host slots in ABI order", () => {
    expect(SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1).toEqual([
      "parameters_0.x",
      "parameters_0.y",
      "parameters_0.z",
      "parameters_0.w",
      "parameters_1.x",
      "parameters_1.y",
      "parameters_1.z",
      "parameters_1.w",
    ]);
  });

  it("appends, removes, and moves rows without mutating their input", () => {
    const initial = [row({ name: "A" }), row({ name: "B" })];
    const added = appendScenePostEffectParameterSchemaDraftV1(initial);
    expect(added.map(({ name }) => name)).toEqual(["A", "B", ""]);
    expect(initial.map(({ name }) => name)).toEqual(["A", "B"]);
    expect(removeScenePostEffectParameterSchemaDraftV1(initial, 0).map(({ name }) => name)).toEqual(["B"]);
    expect(moveScenePostEffectParameterSchemaDraftV1(initial, 1, -1).map(({ name }) => name)).toEqual(["B", "A"]);
    const withColor = appendScenePostEffectParameterSchemaDraftV1(initial, "rgb");
    expect(withColor.at(-1)).toMatchObject({ name: "", type: "rgb" });
    expect(scenePostEffectParameterSchemaDraftSlotCountV1(withColor)).toBe(5);
  });

  it("rejects a ninth row through parsing and append", () => {
    const eightRows = Array.from({ length: 8 }, (_, index) => row({ name: `Parameter ${index + 1}` }));
    expect(errorMessage([...eightRows, row({ name: "Parameter 9" })])).toContain("at most 8 scalar values");
    expect(() => appendScenePostEffectParameterSchemaDraftV1(eightRows)).toThrow("at most 8 scalar values");
    expect(() => appendScenePostEffectParameterSchemaDraftV1(eightRows.slice(0, 6), "rgb")).toThrow(
      "at most 8 scalar values",
    );
  });
});
