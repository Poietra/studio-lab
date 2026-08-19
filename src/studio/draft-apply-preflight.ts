import { programExecutionCapabilities } from "./operation-registry";
import type { SceneEdit } from "./scene-edit-contract";

export async function runDraftSourcePreflight(program: SceneEdit, sourcePreflight: () => Promise<void>) {
  const execution = programExecutionCapabilities(program);
  if (execution.apply !== "supported") {
    throw new TypeError(execution.applyBlocker ?? "The draft cannot be applied safely.");
  }
  if (execution.lowering === "unsupported") return;
  if (execution.lowering !== "supported") {
    throw new TypeError(execution.applyBlocker ?? "The draft has no applicable source preflight.");
  }
  await sourcePreflight();
}
