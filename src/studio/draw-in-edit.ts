import type { RuntimeSceneState } from "./model";
import { operationExecutionCapabilities } from "./operation-registry";
import { operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const DRAW_IN_EPSILON = 0.0005;

export const DRAW_IN_EASINGS = ["linear", "smooth"] as const;
export type DrawInEasing = (typeof DRAW_IN_EASINGS)[number];

export type DrawInClip = Readonly<{
  easing: DrawInEasing;
  entityId: string;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  transactionId: string;
}>;

export type DrawInFragmentMaterialAdmission = Readonly<{
  hasParameterKeyframes: boolean;
  texture: boolean;
}>;

const DRAWABLE_STUDIO_TYPES = new Set([
  "Arc",
  "Axes",
  "Circle",
  "CubicBezier",
  "DataPlot",
  "Ellipse",
  "Line",
  "NumberLine",
  "NumberPlane",
  "Rectangle",
  "RegularPolygon",
  "Sector",
  "SvgPath",
  "Triangle",
]);

export function sceneProgramsHaveDrawIn(programs: readonly SceneEdit[], entityId: string) {
  return programs.some((program) =>
    program.operations.some((operation) => operation.kind === "DrawIn" && operation.entityId === entityId),
  );
}

function createdEntity(program: SceneEdit, entityId: string) {
  return program.operations.find((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId);
}

/** Returns null unless this is the exact, single Studio-owned Draw entrance. */
export function drawInClipFromProgram(program: SceneEdit): DrawInClip | null {
  const operations = program.operations.filter(
    (operation): operation is Extract<SceneEditOperation, { kind: "DrawIn" }> => operation.kind === "DrawIn",
  );
  const operation = operations[0];
  if (
    operations.length !== 1 ||
    !operation ||
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

export function drawInUnavailableReason(
  program: SceneEdit,
  entityId: string,
  options: Readonly<{
    fragmentMaterial?: DrawInFragmentMaterialAdmission | null;
    svgHasFill?: boolean | null;
  }> = {},
): string | null {
  const create = createdEntity(program, entityId);
  if (!create || create.kind !== "CreateEntity") return "Draw supports only Studio-created objects.";
  if (!DRAWABLE_STUDIO_TYPES.has(create.entity.type)) {
    return "Draw supports Studio-created path objects.";
  }
  if (create.entity.type === "SvgPath" && options.svgHasFill !== false) {
    return options.svgHasFill
      ? 'Draw supports stroke-only SVG paths. Import a path with fill="none" to animate its stroke.'
      : "Wait for the Rust-validated SVG paint metadata before adding Draw.";
  }
  if (create.entity.type === "CubicBezier" && create.entity.cubicBezier?.closed) {
    return "Draw currently supports open Pen paths. Reopen the path before adding Draw.";
  }
  if (options.fragmentMaterial) {
    if (create.entity.type !== "Line" && create.entity.type !== "CubicBezier") {
      return "Draw with a fragment material supports only Studio-created Line and open, non-arrow Pen paths.";
    }
    if (create.entity.type === "CubicBezier" && create.entity.cubicBezier?.arrowEnd) {
      return "Draw with a fragment material supports non-arrow Pen paths. Turn off the arrow before combining them.";
    }
    if (options.fragmentMaterial.texture) {
      return "Draw does not support texture fragment materials. Choose a texture-free material or remove Draw.";
    }
    if (options.fragmentMaterial.hasParameterKeyframes) {
      return "Draw does not support material parameter keyframes. Remove the material track before combining them.";
    }
  }
  const otherDraw = program.operations.find(
    (operation) => operation.kind === "DrawIn" && operation.entityId !== entityId,
  );
  if (otherDraw) return "A shared creation Program can currently own one Draw entrance.";
  const filled = program.operations.some(
    (operation) =>
      "entityId" in operation &&
      operation.entityId === entityId &&
      ((operation.kind === "SetProperty" && operation.key === "fillColor") ||
        (operation.kind === "AnimateProperty" && operation.materialParameter !== undefined)),
  );
  return filled ? "Draw currently supports stroke-only Studio shapes." : null;
}

function loweringStatusFor(operations: readonly SceneEditOperation[]) {
  const rank = { illustrative: 1, supported: 0, unsupported: 2 } as const;
  const sourceLowerableLineIds = new Set(
    operations.flatMap((operation) =>
      operation.kind === "CreateEntity" && operation.entity.type === "Line" ? [operation.entity.id] : [],
    ),
  );
  return operations
    .map((operation) =>
      operation.kind === "DrawIn" && sourceLowerableLineIds.has(operation.entityId)
        ? "supported"
        : operationExecutionCapabilities(operation).lowering,
    )
    .reduce<SceneEdit["loweringStatus"]>(
      (current, candidate) => (rank[candidate] > rank[current] ? candidate : current),
      "supported",
    );
}

/** Replaces the object's automatic fade with one canonical path-trim entrance. */
export function replaceDrawInProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    draw: Readonly<{ easing: DrawInEasing; end: number }> | null;
    entityId: string;
    scene: RuntimeSceneState;
    svgHasFill?: boolean | null;
  }>,
): SceneEditValidationResult {
  const unavailable = drawInUnavailableReason(input.baseProgram, input.entityId, {
    svgHasFill: input.svgHasFill,
  });
  if (unavailable) throw new TypeError(unavailable);
  const create = createdEntity(input.baseProgram, input.entityId);
  if (!create || create.kind !== "CreateEntity") throw new TypeError("The Studio creation operation is unavailable.");
  const start = create.entity.lifetime.start;
  const lifetimeEnd = create.entity.lifetime.end ?? input.scene.duration;
  if (
    input.draw &&
    (!Number.isFinite(input.draw.end) ||
      input.draw.end < start + 0.1 - DRAW_IN_EPSILON ||
      input.draw.end > lifetimeEnd + DRAW_IN_EPSILON ||
      input.draw.end > input.scene.duration + DRAW_IN_EPSILON)
  ) {
    throw new RangeError("Draw duration must be at least 0.1 seconds and stay inside the object's lifetime.");
  }

  const replacesEntrance = (operation: SceneEditOperation) =>
    (operation.kind === "DrawIn" && operation.entityId === input.entityId) ||
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
  const draw: readonly SceneEditOperation[] = input.draw
    ? [
        {
          dependsOn: replacedEntrance?.dependsOn ?? [position?.id ?? create.id],
          easing: input.draw.easing,
          entityId: input.entityId,
          id: operationId(input.baseProgram.transactionId, "draw-in"),
          interval: { end: input.draw.end, start },
          kind: "DrawIn",
          provenance: {
            evidence: ["Timeline Draw entrance", "canonical Rust path trim"],
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
  operations.splice(insertionIndex, 0, ...draw);
  const evidence = input.baseProgram.provenance.evidence.filter((entry) => entry !== "Studio Draw entrance");
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: loweringStatusFor(operations),
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: input.draw ? [...new Set([...evidence, "Studio Draw entrance"])] : evidence,
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}
