import { MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 } from "../engine/primitives";
import {
  type StudioScenePostEffectParameterSchemaV1,
  scenePostEffectParameterSchemaListV1,
} from "./scene-post-effect-source";

export const SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1 = [
  "parameters_0.x",
  "parameters_0.y",
  "parameters_0.z",
  "parameters_0.w",
  "parameters_1.x",
  "parameters_1.y",
  "parameters_1.z",
  "parameters_1.w",
] as const;

export type StudioScenePostEffectF32ParameterSchemaDraftRowV1 = Readonly<{
  defaultValue: string;
  max: string;
  min: string;
  name: string;
  step: string;
  type: "f32";
}>;

export type StudioScenePostEffectRgbParameterSchemaDraftRowV1 = Readonly<{
  blue: string;
  green: string;
  name: string;
  red: string;
  type: "rgb";
}>;

export type StudioScenePostEffectParameterSchemaDraftRowV1 =
  | StudioScenePostEffectF32ParameterSchemaDraftRowV1
  | StudioScenePostEffectRgbParameterSchemaDraftRowV1;

export type StudioScenePostEffectParameterSchemaDraftParseResultV1 =
  | Readonly<{ message: string; ok: false }>
  | Readonly<{ ok: true; schema: StudioScenePostEffectParameterSchemaV1 }>;

const EMPTY_F32_DRAFT_ROW: StudioScenePostEffectF32ParameterSchemaDraftRowV1 = Object.freeze({
  defaultValue: "0.5",
  max: "1",
  min: "0",
  name: "",
  step: "0.05",
  type: "f32",
});

const EMPTY_RGB_DRAFT_ROW: StudioScenePostEffectRgbParameterSchemaDraftRowV1 = Object.freeze({
  blue: "1",
  green: "0.65",
  name: "",
  red: "0.25",
  type: "rgb",
});

export function scenePostEffectRgbToHexColorV1(rgb: readonly [number, number, number]) {
  return `#${rgb
    .map((component) =>
      Math.round(component * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function scenePostEffectHexColorToRgbV1(value: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  return match
    ? [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255]
    : null;
}

export function scenePostEffectParameterSchemaDraftSlotCountV1(
  rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
) {
  return rows.reduce((count, row) => count + (row.type === "rgb" ? 3 : 1), 0);
}

export function scenePostEffectParameterSchemaDraftV1(
  schema: StudioScenePostEffectParameterSchemaV1,
): readonly StudioScenePostEffectParameterSchemaDraftRowV1[] {
  return scenePostEffectParameterSchemaListV1.parse(schema).map((parameter) =>
    parameter.type === "rgb"
      ? {
          blue: String(parameter.default[2]),
          green: String(parameter.default[1]),
          name: parameter.name,
          red: String(parameter.default[0]),
          type: "rgb" as const,
        }
      : {
          defaultValue: String(parameter.default),
          max: String(parameter.range.max),
          min: String(parameter.range.min),
          name: parameter.name,
          step: String(parameter.range.step),
          type: "f32" as const,
        },
  );
}

function draftNumber(value: string) {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function issueField(path: PropertyKey[]) {
  const [field, nestedField] = path;
  if (field === "name") return "name";
  if (field === "default") return "defaultValue";
  if (field !== "range") return "row";
  if (nestedField === "min" || nestedField === "max" || nestedField === "step") return nestedField;
  return "min/max";
}

export function parseScenePostEffectParameterSchemaDraftV1(
  rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
): StudioScenePostEffectParameterSchemaDraftParseResultV1 {
  const parsed = scenePostEffectParameterSchemaListV1.safeParse(
    rows.map((row) => {
      if (row.type === "rgb") {
        return {
          default: [draftNumber(row.red), draftNumber(row.green), draftNumber(row.blue)],
          name: row.name,
          type: "rgb" as const,
        };
      }
      return {
        default: draftNumber(row.defaultValue),
        name: row.name,
        range: {
          max: draftNumber(row.max),
          min: draftNumber(row.min),
          step: draftNumber(row.step),
        },
        type: "f32" as const,
      };
    }),
  );
  if (parsed.success) return { ok: true, schema: parsed.data };

  const message = parsed.error.issues
    .map((issue) => {
      const [candidateRow, ...path] = issue.path;
      if (typeof candidateRow === "number") {
        if (rows[candidateRow]?.type === "rgb" && path[0] === "default") {
          return `Parameter ${candidateRow + 1} defaultColor: ${issue.message}`;
        }
        return `Parameter ${candidateRow + 1} ${issueField(path)}: ${issue.message}`;
      }
      return `Parameter schema: ${issue.message}`;
    })
    .join("\n");
  return { message, ok: false };
}

function requireRow(rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[], index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
    throw new RangeError("The selected Scene post-effect parameter row does not exist.");
  }
}

export function appendScenePostEffectParameterSchemaDraftV1(
  rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  type: "f32" | "rgb" = "f32",
) {
  const width = type === "rgb" ? 3 : 1;
  if (scenePostEffectParameterSchemaDraftSlotCountV1(rows) + width > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
    throw new RangeError(`A Scene post effect accepts at most ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1} scalar values.`);
  }
  return [...rows, { ...(type === "rgb" ? EMPTY_RGB_DRAFT_ROW : EMPTY_F32_DRAFT_ROW) }];
}

export function removeScenePostEffectParameterSchemaDraftV1(
  rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
) {
  requireRow(rows, index);
  return rows.filter((_, candidateIndex) => candidateIndex !== index);
}

export function moveScenePostEffectParameterSchemaDraftV1(
  rows: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
  direction: -1 | 1,
) {
  requireRow(rows, index);
  const destination = index + direction;
  requireRow(rows, destination);
  const next = [...rows];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}
