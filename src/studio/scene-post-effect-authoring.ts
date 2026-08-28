import type { ProgramRecord, WorkingState } from "./model";
import type { SceneEdit, SceneEditOperation, StudioScenePostEffectV1 } from "./scene-edit-contract";

export const DEFAULT_RGB_SPLIT_POST_EFFECT_V1: StudioScenePostEffectV1 = {
  parameters: [4, 2, 1, 0],
  revision: 1,
  shaderId: "rgb-split",
};

export type ScenePostEffectProgramOwnerV1 = Readonly<{
  index: number;
  operation: Extract<SceneEditOperation, { kind: "SetScenePostEffect" }>;
  record: ProgramRecord;
}>;

export function isScenePostEffectProgramV1(record: ProgramRecord) {
  return (
    record.program.operations.length === 1 &&
    record.program.operations[0]?.kind === "SetScenePostEffect" &&
    record.program.provenance.origin === "studio-default" &&
    record.program.loweringStatus === "unsupported"
  );
}

export function scenePostEffectProgramOwnerV1(records: readonly ProgramRecord[]): ScenePostEffectProgramOwnerV1 | null {
  let owner: ScenePostEffectProgramOwnerV1 | null = null;
  records.forEach((record, index) => {
    const matching = record.program.operations.filter(({ kind }) => kind === "SetScenePostEffect");
    if (matching.length === 0) return;
    if (matching.length !== 1 || !isScenePostEffectProgramV1(record) || matching[0]?.kind !== "SetScenePostEffect") {
      throw new TypeError("A Scene post effect must own one standalone Program.");
    }
    if (owner !== null) throw new TypeError("More than one Program controls the Scene post effect.");
    owner = { index, operation: matching[0], record };
  });
  return owner;
}

export function withoutScenePostEffectProgramsV1(workingState: WorkingState) {
  const appliedOwner = scenePostEffectProgramOwnerV1(workingState.appliedEdits);
  const stagedOwner = scenePostEffectProgramOwnerV1(workingState.stagedEdits);
  if (appliedOwner && stagedOwner) throw new TypeError("More than one Program controls the Scene post effect.");
  const effectOwner = stagedOwner?.record ?? appliedOwner?.record ?? null;
  return {
    effectOwner,
    workingState: {
      ...workingState,
      appliedEdits: recordsWithoutScenePostEffectProgramsV1(workingState.appliedEdits),
      stagedEdits: recordsWithoutScenePostEffectProgramsV1(workingState.stagedEdits),
    } as WorkingState,
  } as const;
}

export function recordsWithoutScenePostEffectProgramsV1(records: readonly ProgramRecord[]) {
  scenePostEffectProgramOwnerV1(records);
  return records.filter((record) => !record.program.operations.some(({ kind }) => kind === "SetScenePostEffect"));
}

export function programsWithoutScenePostEffectV1(programs: readonly SceneEdit[]) {
  let found = false;
  return programs.filter((program) => {
    const matching = program.operations.filter(({ kind }) => kind === "SetScenePostEffect");
    if (matching.length === 0) return true;
    if (matching.length !== 1 || program.operations.length !== 1) {
      throw new TypeError("A Scene post effect must own one standalone Program.");
    }
    if (found) throw new TypeError("More than one Program controls the Scene post effect.");
    found = true;
    return false;
  });
}
