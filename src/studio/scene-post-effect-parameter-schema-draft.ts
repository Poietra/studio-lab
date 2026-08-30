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

export type StudioScenePostEffectParameterSchemaDraftRowV1 = Readonly<{
  defaultValue: string;
  max: string;
  min: string;
  name: string;
  step: string;
}>;

export type StudioScenePostEffectParameterSchemaDraftParseResultV1 =
  | Readonly<{ message: string; ok: false }>
  | Readonly<{ ok: true; schema: StudioScenePostEffectParameterSchemaV1 }>;

const EMPTY_DRAFT_ROW: StudioScenePostEffectParameterSchemaDraftRowV1 = Object.freeze({
  defaultValue: "0.5",
  max: "1",
  min: "0",
  name: "",
  step: "0.05",
});

export function scenePostEffectParameterSchemaDraftV1(
  schema: StudioScenePostEffectParameterSchemaV1,
): readonly StudioScenePostEffectParameterSchemaDraftRowV1[] {
  return scenePostEffectParameterSchemaListV1.parse(schema).map((parameter) => ({
    defaultValue: String(parameter.default),
    max: String(parameter.range.max),
    min: String(parameter.range.min),
    name: parameter.name,
    step: String(parameter.range.step),
  }));
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
    rows.map((row) => ({
      default: draftNumber(row.defaultValue),
      name: row.name,
      range: {
        max: draftNumber(row.max),
        min: draftNumber(row.min),
        step: draftNumber(row.step),
      },
      type: "f32" as const,
    })),
  );
  if (parsed.success) return { ok: true, schema: parsed.data };

  const message = parsed.error.issues
    .map((issue) => {
      const [candidateRow, ...path] = issue.path;
      if (typeof candidateRow === "number") {
        return `Parameter ${candidateRow + 1} ${issueField(path)}: ${issue.message}`;
      }
      if (rows.length > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
        return `Parameter ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 + 1} row: ${issue.message}`;
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
) {
  if (rows.length >= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
    throw new RangeError(`A Scene post effect accepts at most ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1} parameters.`);
  }
  return [...rows, { ...EMPTY_DRAFT_ROW }];
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
