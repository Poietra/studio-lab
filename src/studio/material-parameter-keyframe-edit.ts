import { MAX_FINITE_F32, MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 } from "../engine/primitives";
import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import { type DrawInFragmentMaterialAdmission, drawInUnavailableReason } from "./draw-in-edit";
import type { StudioFragmentMaterialReferenceV1, StudioFragmentMaterialRgbV1 } from "./fragment-material-authoring";
import type { RuntimeSceneState } from "./model";
import { initialAppearanceEnd, operationId } from "./operations";
import { sourceTimeToWorkingTime } from "./program-composition";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { writeInUnavailableReason } from "./write-in-edit";

const KEYFRAME_EPSILON = 0.0005;
const MAX_KEYFRAMES = 32;
const RGB_COMPONENTS = ["r", "g", "b"] as const;

type MaterialRgbParameterComponent = (typeof RGB_COMPONENTS)[number];

export type MaterialParameterKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: number;
}>;

export type MaterialParameterKeyframeTrack = Readonly<{
  entityId: string;
  keyframes: readonly MaterialParameterKeyframe[];
  material: StudioFragmentMaterialReferenceV1;
  name: string;
  parameterIndex: number;
  programIndex: number;
  rgbComponent?: MaterialRgbParameterComponent;
  transactionId: string;
}>;

export type MaterialRgbParameterKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: StudioFragmentMaterialRgbV1;
}>;

export type MaterialRgbParameterTarget = Readonly<{
  entityId: string;
  material: StudioFragmentMaterialReferenceV1;
  name: string;
  /** The first of the three consecutive scalar host slots. */
  parameterIndex: number;
}>;

export type MaterialRgbParameterKeyframeTrack = MaterialRgbParameterTarget &
  Readonly<{
    keyframes: readonly MaterialRgbParameterKeyframe[];
    parameterType: "rgb";
    programIndex: number;
    transactionId: string;
  }>;

function sameMaterial(left: StudioFragmentMaterialReferenceV1, right: StudioFragmentMaterialReferenceV1) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validKeyframes(keyframes: readonly MaterialParameterKeyframe[], duration: number) {
  return (
    keyframes.length > 0 &&
    keyframes.length <= MAX_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= duration &&
        Number.isFinite(value) &&
        Math.abs(value) <= MAX_FINITE_F32,
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

function validRgbValue(value: unknown): value is StudioFragmentMaterialRgbV1 {
  return (
    Array.isArray(value) &&
    value.length === RGB_COMPONENTS.length &&
    value.every((component) => Number.isFinite(component) && component >= 0 && component <= 1)
  );
}

function validRgbKeyframes(keyframes: readonly MaterialRgbParameterKeyframe[], duration: number) {
  return (
    keyframes.length > 0 &&
    keyframes.length <= MAX_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) => Number.isFinite(time) && time >= 0 && time <= duration && validRgbValue(value),
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

function trackOperations(
  entityId: string,
  material: StudioFragmentMaterialReferenceV1,
  name: string,
  parameterIndex: number,
  keyframes: readonly MaterialParameterKeyframe[],
  transactionId: string,
  rgbComponent?: MaterialRgbParameterComponent,
): readonly SceneEditOperation[] {
  const metadata = { material, name, parameterIndex, ...(rgbComponent ? { rgbComponent } : {}) } as const;
  const operationIdPrefix = `material-parameter-${parameterIndex}`;
  if (keyframes.length === 1) {
    const keyframe = keyframes[0]!;
    return [
      {
        dependsOn: [],
        easing: keyframe.easing,
        entityId,
        from: keyframe.value,
        id: operationId(transactionId, `${operationIdPrefix}-keyframe-0`),
        interval: { end: keyframe.time, start: keyframe.time },
        key: "appearance",
        kind: "AnimateProperty",
        materialParameter: metadata,
        provenance: { evidence: ["Studio material f32 parameter track"], origin: "direct-manipulation" },
        to: keyframe.value,
      },
    ];
  }
  return keyframes.slice(0, -1).map((from, index): SceneEditOperation => {
    const to = keyframes[index + 1]!;
    return {
      dependsOn: [],
      easing: from.easing,
      entityId,
      from: from.value,
      id: operationId(transactionId, `${operationIdPrefix}-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: "appearance",
      kind: "AnimateProperty",
      materialParameter: metadata,
      provenance: { evidence: ["Studio material f32 parameter track"], origin: "direct-manipulation" },
      to: to.value,
    };
  });
}

type MaterialParameterOperation = Extract<SceneEditOperation, { kind: "AnimateProperty" }> &
  Required<Pick<Extract<SceneEditOperation, { kind: "AnimateProperty" }>, "materialParameter">> &
  Readonly<{ from: number; to: number }>;

function hasMaterialParameter(operation: SceneEditOperation) {
  return (
    operation.kind === "AnimateProperty" && operation.key === "appearance" && operation.materialParameter !== undefined
  );
}

function isMaterialParameterOperation(operation: SceneEditOperation): operation is MaterialParameterOperation {
  return (
    operation.kind === "AnimateProperty" &&
    operation.key === "appearance" &&
    operation.materialParameter !== undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number"
  );
}

function sameTrackTarget(
  operation: MaterialParameterOperation,
  target: Readonly<{
    entityId: string;
    material: StudioFragmentMaterialReferenceV1;
    parameterIndex: number;
  }>,
) {
  return (
    operation.entityId === target.entityId &&
    operation.materialParameter.parameterIndex === target.parameterIndex &&
    operation.materialParameter.material.shaderId === target.material.shaderId &&
    operation.materialParameter.material.revision === target.material.revision
  );
}

function materialParameterTrackFromOperations(
  operations: readonly MaterialParameterOperation[],
  program: SceneEdit,
  programIndex: number,
): MaterialParameterKeyframeTrack | null {
  const first = operations[0];
  if (!first) return null;
  const { material, name, parameterIndex, rgbComponent } = first.materialParameter;
  if (
    operations.some(
      (operation) =>
        operation.entityId !== first.entityId ||
        operation.materialParameter.name !== name ||
        operation.materialParameter.parameterIndex !== parameterIndex ||
        operation.materialParameter.rgbComponent !== rgbComponent ||
        !sameMaterial(operation.materialParameter.material, material),
    )
  ) {
    return null;
  }
  if (operations.length === 1 && first.interval.start === first.interval.end) {
    if (Math.abs(first.from - first.to) > KEYFRAME_EPSILON) return null;
    return {
      entityId: first.entityId,
      keyframes: [{ easing: first.easing, time: first.interval.start, value: first.to }],
      material,
      name,
      parameterIndex,
      programIndex,
      ...(rgbComponent ? { rgbComponent } : {}),
      transactionId: program.transactionId,
    };
  }
  const keyframes: MaterialParameterKeyframe[] = [
    { easing: first.easing, time: first.interval.start, value: first.from },
  ];
  for (const [index, operation] of operations.entries()) {
    const previous = operations[index - 1];
    if (
      operation.interval.end <= operation.interval.start + KEYFRAME_EPSILON ||
      (previous &&
        (Math.abs(previous.interval.end - operation.interval.start) > KEYFRAME_EPSILON ||
          Math.abs(previous.to - operation.from) > KEYFRAME_EPSILON))
    ) {
      return null;
    }
    keyframes.push({
      easing: operations[index + 1]?.easing ?? "smooth",
      time: operation.interval.end,
      value: operation.to,
    });
  }
  return {
    entityId: first.entityId,
    keyframes,
    material,
    name,
    parameterIndex,
    programIndex,
    ...(rgbComponent ? { rgbComponent } : {}),
    transactionId: program.transactionId,
  };
}

type ReplaceMaterialParameterKeyframeProgramInput = Readonly<{
  baseProgram: SceneEdit;
  entityId: string;
  fragmentMaterial?: DrawInFragmentMaterialAdmission;
  keyframes: readonly MaterialParameterKeyframe[];
  material: StudioFragmentMaterialReferenceV1;
  name: string;
  parameterIndex: number;
  scene: RuntimeSceneState;
}>;

function replaceMaterialParameterKeyframeProgramInternal(
  input: Readonly<{
    baseProgram: SceneEdit;
    entityId: string;
    fragmentMaterial?: DrawInFragmentMaterialAdmission;
    keyframes: readonly MaterialParameterKeyframe[];
    material: StudioFragmentMaterialReferenceV1;
    name: string;
    parameterIndex: number;
    rgbComponent?: MaterialRgbParameterComponent;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const targetCreate = input.baseProgram.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.id === input.entityId,
  );
  if (!targetCreate || targetCreate.kind !== "CreateEntity") {
    throw new TypeError("Material parameter keyframes support only Studio-created objects.");
  }
  const baseValue = input.material.parameters[input.parameterIndex];
  if (baseValue === undefined || !Number.isFinite(baseValue)) {
    throw new TypeError("The selected material parameter no longer exists.");
  }
  if (input.keyframes.length > 0 && !validKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError("Material keyframes must be ordered, distinct, finite, and inside the Scene.");
  }
  if (input.keyframes[0] && Math.abs(input.keyframes[0].value - baseValue) > KEYFRAME_EPSILON) {
    throw new TypeError("The first material keyframe must preserve the assigned parameter value.");
  }
  const hasDraw = input.baseProgram.operations.some(
    (operation) => operation.kind === "DrawIn" && operation.entityId === input.entityId,
  );
  const hasWrite = input.baseProgram.operations.some(
    (operation) => operation.kind === "WriteIn" && operation.entityId === input.entityId,
  );
  if (input.keyframes.length > 0 && (hasDraw || hasWrite)) {
    if (!input.fragmentMaterial) {
      throw new TypeError(
        `Wait for the fragment material metadata before editing keyframes with ${hasWrite ? "Write" : "Draw"}.`,
      );
    }
    const unavailable = hasWrite
      ? writeInUnavailableReason(input.baseProgram, input.entityId, { fragmentMaterial: input.fragmentMaterial })
      : drawInUnavailableReason(input.baseProgram, input.entityId, {
          fragmentMaterial: input.fragmentMaterial,
        });
    if (unavailable) throw new TypeError(unavailable);
  }
  const entranceEnd = initialAppearanceEnd(
    hasDraw
      ? input.baseProgram.operations.filter(
          (operation) => operation.kind !== "DrawIn" || operation.entityId !== input.entityId,
        )
      : input.baseProgram.operations,
    input.entityId,
    targetCreate.entity.lifetime.start,
  );
  const firstKeyframeTime =
    input.keyframes[0] && hasWrite
      ? sourceTimeToWorkingTime([input.baseProgram], input.keyframes[0].time)
      : input.keyframes[0]?.time;
  if (firstKeyframeTime !== undefined && firstKeyframeTime <= entranceEnd + KEYFRAME_EPSILON) {
    throw new TypeError("The first material keyframe must be after the object's initial entrance.");
  }
  const materialOperations = input.baseProgram.operations.filter(isMaterialParameterOperation);
  const existingTracks = materialParameterKeyframeTracksFromProgram(input.baseProgram, 0);
  if (
    input.baseProgram.operations.filter(hasMaterialParameter).length !== materialOperations.length ||
    (materialOperations.length > 0 && existingTracks.length === 0)
  ) {
    throw new TypeError("The Studio creation Program contains malformed material parameter tracks.");
  }
  if (
    existingTracks.some((track) => track.entityId !== input.entityId || !sameMaterial(track.material, input.material))
  ) {
    throw new TypeError("Material parameter tracks in one creation Program must target one object and material.");
  }
  const existingTarget = existingTracks.find((track) => track.parameterIndex === input.parameterIndex);
  if (existingTarget && existingTarget.rgbComponent !== input.rgbComponent) {
    throw new TypeError(
      existingTarget.rgbComponent
        ? "Use the logical RGB material track editor to change this component."
        : "The RGB material parameter overlaps an existing scalar track.",
    );
  }
  if (existingTarget && existingTarget.name !== input.name) {
    throw new TypeError("The selected material parameter target has conflicting metadata.");
  }
  if (input.keyframes.length > 0 && !existingTarget && existingTracks.length >= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
    throw new TypeError(
      `A Studio creation Program accepts at most ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1} material tracks.`,
    );
  }
  const target = {
    entityId: input.entityId,
    material: input.material,
    parameterIndex: input.parameterIndex,
  } as const;
  const firstTargetOperationIndex = input.baseProgram.operations.findIndex(
    (operation) => isMaterialParameterOperation(operation) && sameTrackTarget(operation, target),
  );
  const retained = input.baseProgram.operations
    .filter((operation) => !(isMaterialParameterOperation(operation) && sameTrackTarget(operation, target)))
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const replacementOperations = trackOperations(
    input.entityId,
    input.material,
    input.name,
    input.parameterIndex,
    input.keyframes,
    input.baseProgram.transactionId,
    input.rgbComponent,
  );
  const retainedInsertionIndex = firstTargetOperationIndex < 0 ? retained.length : firstTargetOperationIndex;
  const operations = [
    ...retained.slice(0, retainedInsertionIndex),
    ...replacementOperations,
    ...retained.slice(retainedInsertionIndex),
  ];
  const hasMaterialTracks = operations.some(isMaterialParameterOperation);
  const evidence = input.baseProgram.provenance.evidence.filter(
    (entry) => entry !== "Studio material f32 parameter keyframes",
  );
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: hasMaterialTracks ? "unsupported" : "supported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: !hasMaterialTracks
          ? evidence
          : [...new Set([...evidence, "Studio material f32 parameter keyframes"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}

export function replaceMaterialParameterKeyframeProgram(
  input: ReplaceMaterialParameterKeyframeProgramInput,
): SceneEditValidationResult {
  return replaceMaterialParameterKeyframeProgramInternal(input);
}

export function materialParameterKeyframeTracksFromProgram(
  program: SceneEdit,
  programIndex: number,
): readonly MaterialParameterKeyframeTrack[] {
  if (program.provenance.origin !== "direct-manipulation" || program.requestedExecution !== "sequence") return [];
  const operations = program.operations.filter(isMaterialParameterOperation);
  if (program.operations.filter(hasMaterialParameter).length !== operations.length) return [];
  const first = operations[0];
  if (
    !first ||
    !program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === first.entityId)
  ) {
    return [];
  }
  const material = first.materialParameter.material;
  if (
    operations.some(
      (operation) =>
        operation.entityId !== first.entityId || !sameMaterial(operation.materialParameter.material, material),
    )
  ) {
    return [];
  }
  const grouped = new Map<number, MaterialParameterOperation[]>();
  for (const operation of operations) {
    const parameterIndex = operation.materialParameter.parameterIndex;
    const group = grouped.get(parameterIndex) ?? [];
    group.push(operation);
    grouped.set(parameterIndex, group);
  }
  if (grouped.size > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) return [];
  const tracks = [...grouped.values()]
    .map((group) => materialParameterTrackFromOperations(group, program, programIndex))
    .sort((left, right) => (left?.parameterIndex ?? 0) - (right?.parameterIndex ?? 0));
  return tracks.every((track): track is MaterialParameterKeyframeTrack => track !== null) ? tracks : [];
}

function rgbComponentIndex(parameterIndex: number, component: MaterialRgbParameterComponent) {
  return parameterIndex + RGB_COMPONENTS.indexOf(component);
}

function rgbRootParameterIndex(parameterIndex: number, component: MaterialRgbParameterComponent) {
  return parameterIndex - RGB_COMPONENTS.indexOf(component);
}

function materialRgbBaseline(target: MaterialRgbParameterTarget): StudioFragmentMaterialRgbV1 {
  if (
    !Number.isInteger(target.parameterIndex) ||
    target.parameterIndex < 0 ||
    target.parameterIndex + RGB_COMPONENTS.length > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1
  ) {
    throw new TypeError("An RGB material parameter requires three consecutive host slots.");
  }
  const value = target.material.parameters.slice(target.parameterIndex, target.parameterIndex + RGB_COMPONENTS.length);
  if (!validRgbValue(value)) {
    throw new TypeError("The selected RGB material parameter no longer has three finite unit-color components.");
  }
  return value;
}

function rgbComponentTracks(
  program: SceneEdit,
  programIndex: number,
  target: MaterialRgbParameterTarget,
): readonly MaterialParameterKeyframeTrack[] | null {
  materialRgbBaseline(target);
  const targetIndices = new Set(RGB_COMPONENTS.map((component) => rgbComponentIndex(target.parameterIndex, component)));
  const targetOperations = program.operations.filter(
    (operation) =>
      isMaterialParameterOperation(operation) &&
      operation.entityId === target.entityId &&
      targetIndices.has(operation.materialParameter.parameterIndex),
  );
  if (targetOperations.length === 0) return null;

  const tracks = materialParameterKeyframeTracksFromProgram(program, programIndex);
  if (tracks.length === 0) {
    throw new TypeError("The Studio creation Program contains malformed RGB material component tracks.");
  }
  const components = RGB_COMPONENTS.map((rgbComponent) => {
    const parameterIndex = rgbComponentIndex(target.parameterIndex, rgbComponent);
    const track = tracks.find(
      (candidate) => candidate.entityId === target.entityId && candidate.parameterIndex === parameterIndex,
    );
    if (
      !track ||
      track.rgbComponent !== rgbComponent ||
      track.name !== target.name ||
      !sameMaterial(track.material, target.material)
    ) {
      throw new TypeError(
        "An RGB material parameter track requires exactly r, g, and b component tracks on consecutive slots.",
      );
    }
    return track;
  });
  return components;
}

/** Reconstructs one logical RGB track from its three persisted scalar component tracks. */
export function materialRgbParameterKeyframeTrackFromProgram(
  program: SceneEdit,
  programIndex: number,
  target: MaterialRgbParameterTarget,
): MaterialRgbParameterKeyframeTrack | null {
  const components = rgbComponentTracks(program, programIndex, target);
  if (!components) return null;
  const [red, green, blue] = components;
  if (!red || !green || !blue) {
    throw new TypeError("An RGB material parameter track requires all three component tracks.");
  }
  if (
    green.keyframes.length !== red.keyframes.length ||
    blue.keyframes.length !== red.keyframes.length ||
    red.keyframes.some((keyframe, index) =>
      [green.keyframes[index], blue.keyframes[index]].some(
        (component) => component?.time !== keyframe.time || component.easing !== keyframe.easing,
      ),
    )
  ) {
    throw new TypeError("RGB material component tracks must use identical keyframe times and easing.");
  }
  const keyframes = red.keyframes.map((keyframe, index): MaterialRgbParameterKeyframe => {
    const value = [keyframe.value, green.keyframes[index]!.value, blue.keyframes[index]!.value];
    if (!validRgbValue(value)) {
      throw new TypeError("RGB material component keyframes must contain finite unit-color values.");
    }
    return { easing: keyframe.easing, time: keyframe.time, value };
  });
  const baseline = materialRgbBaseline(target);
  if (
    keyframes[0] &&
    keyframes[0].value.some((component, index) => Math.abs(component - baseline[index]!) > KEYFRAME_EPSILON)
  ) {
    throw new TypeError("The first RGB material keyframe must preserve the assigned color value.");
  }
  return {
    ...target,
    keyframes,
    parameterType: "rgb",
    programIndex,
    transactionId: program.transactionId,
  };
}

/** Atomically replaces one logical RGB track while retaining unrelated scalar or RGB tracks. */
export function replaceMaterialRgbParameterKeyframeProgram(
  input: MaterialRgbParameterTarget &
    Readonly<{
      baseProgram: SceneEdit;
      fragmentMaterial?: DrawInFragmentMaterialAdmission;
      keyframes: readonly MaterialRgbParameterKeyframe[];
      scene: RuntimeSceneState;
    }>,
): SceneEditValidationResult {
  const baseline = materialRgbBaseline(input);
  const existing = materialRgbParameterKeyframeTrackFromProgram(input.baseProgram, 0, input);
  if (input.keyframes.length > 0 && !validRgbKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError("RGB material keyframes must be ordered, distinct, finite unit colors inside the Scene.");
  }
  if (
    input.keyframes[0] &&
    input.keyframes[0].value.some((component, index) => Math.abs(component - baseline[index]!) > KEYFRAME_EPSILON)
  ) {
    throw new TypeError("The first RGB material keyframe must preserve the assigned color value.");
  }
  const existingTracks = materialParameterKeyframeTracksFromProgram(input.baseProgram, 0);
  if (
    input.keyframes.length > 0 &&
    !existing &&
    existingTracks.length + RGB_COMPONENTS.length > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1
  ) {
    throw new TypeError(
      `A Studio creation Program accepts at most ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1} scalar material tracks.`,
    );
  }

  let result: SceneEditValidationResult | null = null;
  for (const [componentOffset, rgbComponent] of RGB_COMPONENTS.entries()) {
    result = replaceMaterialParameterKeyframeProgramInternal({
      baseProgram: result?.program ?? input.baseProgram,
      entityId: input.entityId,
      ...(input.fragmentMaterial ? { fragmentMaterial: input.fragmentMaterial } : {}),
      keyframes: input.keyframes.map(({ easing, time, value }) => ({
        easing,
        time,
        value: value[componentOffset]!,
      })),
      material: input.material,
      name: input.name,
      parameterIndex: input.parameterIndex + componentOffset,
      rgbComponent,
      scene: input.scene,
    });
  }
  if (!result) throw new TypeError("RGB material parameter lowering did not produce component tracks.");
  const reconstructed = materialRgbParameterKeyframeTrackFromProgram(result.program, 0, input);
  if ((input.keyframes.length === 0) !== (reconstructed === null)) {
    throw new TypeError("RGB material parameter lowering did not replace all three components atomically.");
  }
  return result;
}

export function replaceMaterialRgbParameterKeyframe(
  keyframes: readonly MaterialRgbParameterKeyframe[],
  index: number,
  patch: Partial<MaterialRgbParameterKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected RGB material keyframe no longer exists.");
  if (patch.value !== undefined && !validRgbValue(patch.value)) {
    throw new TypeError("RGB material keyframes require three finite unit-color components.");
  }
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function appendMaterialRgbParameterKeyframe(
  keyframes: readonly MaterialRgbParameterKeyframe[],
  time: number,
  baseValue: StudioFragmentMaterialRgbV1,
) {
  if (!validRgbValue(baseValue)) throw new TypeError("The RGB material baseline is unavailable.");
  const last = keyframes.at(-1);
  if (!Number.isFinite(time) || (last && time <= last.time + KEYFRAME_EPSILON)) {
    throw new RangeError(
      "Add new RGB material keyframes after the final marker so the canonical sampled color is preserved.",
    );
  }
  return [...keyframes, { easing: "smooth" as const, time, value: last?.value ?? baseValue }];
}

export function materialRgbToHexColor(value: StudioFragmentMaterialRgbV1) {
  if (!validRgbValue(value)) throw new TypeError("RGB material colors require three finite unit components.");
  return `#${value
    .map((component) =>
      Math.round(component * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function materialRgbFromHexColor(value: string): StudioFragmentMaterialRgbV1 | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/u.exec(value);
  return match
    ? [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255]
    : null;
}

export function replaceMaterialParameterKeyframe(
  keyframes: readonly MaterialParameterKeyframe[],
  index: number,
  patch: Partial<MaterialParameterKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected material keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function appendMaterialParameterKeyframe(
  keyframes: readonly MaterialParameterKeyframe[],
  time: number,
  baseValue: number,
) {
  const last = keyframes.at(-1);
  if (last && time <= last.time + KEYFRAME_EPSILON) {
    throw new RangeError(
      "Add new material keyframes after the final marker so the canonical sampled value is preserved.",
    );
  }
  return [...keyframes, { easing: "smooth" as const, time, value: last?.value ?? baseValue }];
}

export function materialParameterAssignmentBlocker(
  programs: readonly SceneEdit[],
  assignments: Readonly<Record<string, StudioFragmentMaterialReferenceV1>>,
) {
  for (const program of programs) {
    const rgbTargets = new Map<string, MaterialRgbParameterTarget>();
    for (const operation of program.operations) {
      if (operation.kind !== "AnimateProperty" || !operation.materialParameter?.rgbComponent) continue;
      const rootParameterIndex = rgbRootParameterIndex(
        operation.materialParameter.parameterIndex,
        operation.materialParameter.rgbComponent,
      );
      const key = `${operation.entityId}\u0000${rootParameterIndex}`;
      rgbTargets.set(key, {
        entityId: operation.entityId,
        material: operation.materialParameter.material,
        name: operation.materialParameter.name,
        parameterIndex: rootParameterIndex,
      });
    }
    for (const target of rgbTargets.values()) {
      try {
        if (!materialRgbParameterKeyframeTrackFromProgram(program, 0, target)) {
          return `RGB material parameter track ${target.name} is missing one or more component tracks.`;
        }
      } catch (error) {
        return error instanceof Error
          ? `RGB material parameter track ${target.name} is malformed: ${error.message}`
          : `RGB material parameter track ${target.name} is malformed.`;
      }
    }
    for (const operation of program.operations) {
      if (operation.kind !== "AnimateProperty" || !operation.materialParameter) continue;
      const assignment = assignments[operation.entityId];
      if (!assignment || !sameMaterial(assignment, operation.materialParameter.material)) {
        return `Material parameter track ${operation.materialParameter.name} no longer matches the assigned material. Remove the track or restore that material before previewing.`;
      }
    }
  }
  return null;
}

export function materialParameterIdentityEditBlocker(
  programs: readonly SceneEdit[],
  target: Readonly<{ entityId?: string; shaderId?: string }>,
) {
  const track = programs
    .flatMap((program, programIndex) => materialParameterKeyframeTracksFromProgram(program, programIndex))
    .find(
      (candidate) =>
        (target.entityId !== undefined && candidate.entityId === target.entityId) ||
        (target.shaderId !== undefined && candidate.material.shaderId === target.shaderId),
    );
  return track ? `Remove the ${track.name} material parameter track before changing its material identity.` : null;
}
