import type { RuntimeSceneState } from "./model";
import { operationExecutionCapabilities } from "./operation-registry";
import { operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const WRITE_IN_EPSILON = 0.0005;

export const WRITE_IN_EASINGS = ["linear"] as const;
export type WriteInEasing = (typeof WRITE_IN_EASINGS)[number];

export type WriteInClip = Readonly<{
  easing: WriteInEasing;
  entityId: string;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  transactionId: string;
}>;

function createdEntity(program: SceneEdit, entityId: string) {
  return program.operations.find((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId);
}

export function sceneProgramsHaveWriteIn(programs: readonly SceneEdit[], entityId: string) {
  return programs.some((program) =>
    program.operations.some((operation) => operation.kind === "WriteIn" && operation.entityId === entityId),
  );
}

/** Returns null unless this is the exact, single Studio-owned Write entrance. */
export function writeInClipFromProgram(program: SceneEdit): WriteInClip | null {
  const operations = program.operations.filter(
    (operation): operation is Extract<SceneEditOperation, { kind: "WriteIn" }> => operation.kind === "WriteIn",
  );
  const operation = operations[0];
  if (
    operations.length !== 1 ||
    !operation ||
    operation.easing !== "linear" ||
    program.provenance.origin !== "direct-manipulation" ||
    !createdEntity(program, operation.entityId)
  ) {
    return null;
  }
  return {
    easing: operation.easing,
    entityId: operation.entityId,
    interval: operation.interval,
    operationId: operation.id,
    transactionId: program.transactionId,
  };
}

export function writeInUnavailableReason(program: SceneEdit, entityId: string): string | null {
  const create = createdEntity(program, entityId);
  if (!create || create.kind !== "CreateEntity") return "Write supports only Studio-created objects.";
  if (create.entity.type !== "MathTex") return "Write currently supports Studio-created MathTex objects.";
  const hasPaintColorTrack = program.operations.some(
    (operation) =>
      operation.kind === "AnimateProperty" &&
      operation.entityId === entityId &&
      (operation.key === "fillColor" || operation.key === "strokeColor") &&
      operation.timelineTrack === true,
  );
  if (hasPaintColorTrack) return "Remove the object's paint color track before adding Write.";
  const otherWrite = program.operations.find(
    (operation) => operation.kind === "WriteIn" && operation.entityId !== entityId,
  );
  return otherWrite ? "A shared creation Program can currently own one Write entrance." : null;
}

function loweringStatusFor(operations: readonly SceneEditOperation[]) {
  const rank = { illustrative: 1, supported: 0, unsupported: 2 } as const;
  return operations
    .map((operation) => operationExecutionCapabilities(operation).lowering)
    .reduce<SceneEdit["loweringStatus"]>(
      (current, candidate) => (rank[candidate] > rank[current] ? candidate : current),
      "supported",
    );
}

/** Replaces the object's automatic fade with one canonical segmented Write entrance. */
export function replaceWriteInProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    entityId: string;
    scene: RuntimeSceneState;
    write: Readonly<{ easing: WriteInEasing; end: number }> | null;
  }>,
): SceneEditValidationResult {
  const unavailable = writeInUnavailableReason(input.baseProgram, input.entityId);
  if (unavailable) throw new TypeError(unavailable);
  const create = createdEntity(input.baseProgram, input.entityId);
  if (!create || create.kind !== "CreateEntity") throw new TypeError("The Studio creation operation is unavailable.");
  const start = create.entity.lifetime.start;
  const lifetimeEnd = create.entity.lifetime.end ?? input.scene.duration;
  if (
    input.write &&
    (!Number.isFinite(input.write.end) ||
      input.write.end < start + 0.1 - WRITE_IN_EPSILON ||
      input.write.end > lifetimeEnd + WRITE_IN_EPSILON ||
      input.write.end > input.scene.duration + WRITE_IN_EPSILON)
  ) {
    throw new RangeError("Write duration must be at least 0.1 seconds and stay inside the object's lifetime.");
  }

  const replacesEntrance = (operation: SceneEditOperation) =>
    (operation.kind === "WriteIn" && operation.entityId === input.entityId) ||
    (operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === input.entityId);
  const replacedEntranceIndex = input.baseProgram.operations.findIndex(replacesEntrance);
  const replacedEntrance = input.baseProgram.operations[replacedEntranceIndex];
  const retained = input.baseProgram.operations
    .filter((operation) => !replacesEntrance(operation))
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const position = retained.find(
    (operation) =>
      operation.kind === "SetProperty" && operation.key === "position" && operation.entityId === input.entityId,
  );
  const write: readonly SceneEditOperation[] = input.write
    ? [
        {
          dependsOn: replacedEntrance?.dependsOn ?? [position?.id ?? create.id],
          easing: input.write.easing,
          entityId: input.entityId,
          id: operationId(input.baseProgram.transactionId, "write-in"),
          interval: { end: input.write.end, start },
          kind: "WriteIn",
          provenance: {
            evidence: ["Timeline Write entrance", "canonical Rust segmented MathTex Write"],
            origin: "direct-manipulation",
          },
        },
      ]
    : [];
  const insertionIndex =
    replacedEntranceIndex < 0
      ? retained.length
      : input.baseProgram.operations.slice(0, replacedEntranceIndex).filter((operation) => !replacesEntrance(operation))
          .length;
  const operations: SceneEditOperation[] = [...retained];
  operations.splice(insertionIndex, 0, ...write);
  const evidence = input.baseProgram.provenance.evidence.filter((entry) => entry !== "Studio Write entrance");
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: loweringStatusFor(operations),
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: input.write ? [...new Set([...evidence, "Studio Write entrance"])] : evidence,
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}
