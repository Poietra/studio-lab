import { MAX_FINITE_F32 } from "../engine/primitives";
import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import { type DrawInFragmentMaterialAdmission, drawInUnavailableReason } from "./draw-in-edit";
import type { StudioFragmentMaterialReferenceV1 } from "./fragment-material-authoring";
import type { RuntimeSceneState } from "./model";
import { initialAppearanceEnd, operationId } from "./operations";
import { sourceTimeToWorkingTime } from "./program-composition";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { writeInUnavailableReason } from "./write-in-edit";

const KEYFRAME_EPSILON = 0.0005;
const MAX_KEYFRAMES = 32;

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

function trackOperations(
  entityId: string,
  material: StudioFragmentMaterialReferenceV1,
  name: string,
  parameterIndex: number,
  keyframes: readonly MaterialParameterKeyframe[],
  transactionId: string,
): readonly SceneEditOperation[] {
  const metadata = { material, name, parameterIndex } as const;
  if (keyframes.length === 1) {
    const keyframe = keyframes[0]!;
    return [
      {
        dependsOn: [],
        easing: keyframe.easing,
        entityId,
        from: keyframe.value,
        id: operationId(transactionId, "material-parameter-keyframe-0"),
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
      id: operationId(transactionId, `material-parameter-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: "appearance",
      kind: "AnimateProperty",
      materialParameter: metadata,
      provenance: { evidence: ["Studio material f32 parameter track"], origin: "direct-manipulation" },
      to: to.value,
    };
  });
}

export function replaceMaterialParameterKeyframeProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    entityId: string;
    fragmentMaterial?: DrawInFragmentMaterialAdmission;
    keyframes: readonly MaterialParameterKeyframe[];
    material: StudioFragmentMaterialReferenceV1;
    name: string;
    parameterIndex: number;
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
  const existing = materialParameterKeyframeTrackFromProgram(input.baseProgram, 0);
  if (
    input.keyframes.length > 0 &&
    existing &&
    (existing.entityId !== input.entityId ||
      existing.name !== input.name ||
      existing.parameterIndex !== input.parameterIndex ||
      !sameMaterial(existing.material, input.material))
  ) {
    throw new TypeError("A Studio creation Program can currently own one material parameter track.");
  }
  const retained = input.baseProgram.operations
    .filter(
      (operation) =>
        !(operation.kind === "AnimateProperty" && operation.key === "appearance" && operation.materialParameter),
    )
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const materialOperations = trackOperations(
    input.entityId,
    input.material,
    input.name,
    input.parameterIndex,
    input.keyframes,
    input.baseProgram.transactionId,
  );
  const operations = [...retained, ...materialOperations];
  const evidence = input.baseProgram.provenance.evidence.filter(
    (entry) => entry !== "Studio material f32 parameter keyframes",
  );
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: materialOperations.length === 0 ? "supported" : "unsupported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence:
          materialOperations.length === 0
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

export function materialParameterKeyframeTrackFromProgram(
  program: SceneEdit,
  programIndex: number,
): MaterialParameterKeyframeTrack | null {
  if (program.provenance.origin !== "direct-manipulation" || program.requestedExecution !== "sequence") return null;
  const operations = program.operations.filter(
    (
      operation,
    ): operation is Extract<SceneEditOperation, { kind: "AnimateProperty" }> &
      Required<Pick<Extract<SceneEditOperation, { kind: "AnimateProperty" }>, "materialParameter">> &
      Readonly<{ from: number; to: number }> =>
      operation.kind === "AnimateProperty" &&
      operation.key === "appearance" &&
      operation.materialParameter !== undefined &&
      typeof operation.from === "number" &&
      typeof operation.to === "number",
  );
  const first = operations[0];
  if (
    !first ||
    !program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === first.entityId)
  ) {
    return null;
  }
  const { material, name, parameterIndex } = first.materialParameter;
  if (
    operations.some(
      (operation) =>
        operation.entityId !== first.entityId ||
        operation.materialParameter.name !== name ||
        operation.materialParameter.parameterIndex !== parameterIndex ||
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
    transactionId: program.transactionId,
  };
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
    .map((program, programIndex) => materialParameterKeyframeTrackFromProgram(program, programIndex))
    .find(
      (candidate) =>
        candidate !== null &&
        ((target.entityId !== undefined && candidate.entityId === target.entityId) ||
          (target.shaderId !== undefined && candidate.material.shaderId === target.shaderId)),
    );
  return track ? `Remove the ${track.name} material parameter track before changing its material identity.` : null;
}
