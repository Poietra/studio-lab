import type { StudioCubicBezierSpec } from "../engine/cubic-bezier-authoring";
import {
  canonicalEditableContent,
  STUDIO_CREATION_TEXT_CONTRACT,
  STUDIO_TEXT_DEFAULT_LAYOUT,
  studioCreationTextContent,
} from "./editable-content";
import {
  importedLifetimeEditEvidence,
  MIN_OBJECT_LIFETIME_SECONDS,
  type ProgramSourceAnchorBounds,
  studioGroupLifetimeTrimTargetUnavailableReason,
} from "./lifetime-editing";
import type {
  DataSeries,
  EntityContent,
  EntityDimensions,
  Interval,
  Point,
  ProgramRecord,
  ProjectedEntity,
  RuntimeSceneState,
} from "./model";
import { EDIT_OPERATION_VERSION, type OperationOrigin, operationId, provisionalEntityId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import {
  isCanonicalRgbHex,
  type SceneEdit,
  type SceneEditOperation,
  type ScenePostEffectParameterTrack,
  type StudioScenePostEffectV1,
  sceneEditOperationSchema,
} from "./scene-edit-contract";
import { STUDIO_STYLE_PROFILE, type StyleProfileRef, styleProfileRef } from "./style-profile";
import { resolveTimeAnchorOnce } from "./time";
import type { SceneDurationTrimAvailability } from "./timeline-projection";

export const INSERT_ENTITY_TYPES = [
  "Text",
  "MathTex",
  "Rectangle",
  "Circle",
  "CubicBezier",
  "Ellipse",
  "Arc",
  "Sector",
  "Triangle",
  "RegularPolygon",
  "NumberLine",
  "Axes",
  "NumberPlane",
  "Line",
  "Arrow",
] as const;

export type InsertEntityType = (typeof INSERT_ENTITY_TYPES)[number];

export type StudioEntityInput = Readonly<{
  content?: EntityContent;
  cubicBezier?: StudioCubicBezierSpec;
  dataSeries?: DataSeries;
  dimensions?: EntityDimensions;
  image?: Readonly<{
    asset: Readonly<{ assetId: string; sha256: string }>;
    localRect: Readonly<{ bottom: number; left: number; right: number; top: number }>;
    sampler: "linear" | "nearest";
  }>;
  position: Point;
  svg?: Readonly<{ source: string }>;
  type: InsertEntityType | "DataPlot" | "ImageMobject" | "SvgPath";
}>;

export function defaultEntityDimensions(
  type: InsertEntityType | "DataPlot" | "ImageMobject" | "SvgPath",
): EntityDimensions | undefined {
  if (type === "Circle") return { radius: 1 };
  if (type === "Rectangle") return { height: 2, width: 4 };
  if (type === "Ellipse") return { height: 2, width: 3 };
  if (type === "Arc" || type === "Sector") {
    return { angles: { start: 0, sweep: Math.PI / 2 }, radius: 1 };
  }
  if (type === "Triangle") return { radius: 1, sides: 3 };
  if (type === "RegularPolygon") return { radius: 1, sides: 6 };
  if (type === "NumberLine") {
    return { coordinateSystem: { x: { maximum: 5, minimum: -5, step: 1 } }, width: 6 };
  }
  if (type === "Axes" || type === "NumberPlane") {
    return {
      coordinateSystem: {
        x: { maximum: 5, minimum: -5, step: 1 },
        y: { maximum: 3, minimum: -3, step: 1 },
      },
      height: 4,
      width: 6,
    };
  }
  return undefined;
}

type AuthoringProgramResult = Readonly<{
  entityIds: readonly string[];
  validation: SceneEditValidationResult;
}>;

export type InspectorEntityEdits = Readonly<{
  content?: EntityContent;
  dimensions?: EntityDimensions;
  position?: Point;
}>;

function provenance(origin: OperationOrigin, evidence: readonly string[]) {
  return { evidence, origin } as const;
}

function authoringProgram(
  operations: readonly SceneEditOperation[],
  input: Readonly<{
    capturedPlayhead: number;
    loweringStatus?: SceneEdit["loweringStatus"];
    origin: OperationOrigin;
    programEvidence?: readonly string[];
    styleProfileRef?: StyleProfileRef;
    requestedExecution?: "parallel" | "sequence";
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const resolution = resolveTimeAnchorOnce(
    {
      kind: "playhead",
      referenceSeconds: input.capturedPlayhead,
    },
    {
      capturedPlayhead: input.capturedPlayhead,
      sceneDuration: input.scene.duration,
    },
  );
  if (resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  const program: SceneEdit = {
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: input.loweringStatus ?? "supported",
    operations,
    provenance: {
      ...provenance(input.origin, ["manual Studio authoring", ...(input.programEvidence ?? [])]),
      ...(input.styleProfileRef ? { styleProfileRef: input.styleProfileRef } : {}),
    },
    requestedExecution: input.requestedExecution ?? "parallel",
    schedule: {
      edges: [],
      mode: input.requestedExecution ?? "parallel",
      order: operations.map((operation) => operation.id),
    },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, input.scene);
}

export function createStudioSceneBackgroundProgram(
  input: Readonly<{
    color: string;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (!isCanonicalRgbHex(input.color)) {
    throw new TypeError("Scene background color must be a lowercase canonical #rrggbb color.");
  }
  return authoringProgram(
    [
      {
        color: input.color,
        dependsOn: [],
        id: operationId(input.transactionId, "set-scene-background"),
        interval: { end: 0, start: 0 },
        kind: "SetSceneBackground",
        provenance: provenance("studio-default", ["Scene graph background color"]),
      },
    ],
    {
      capturedPlayhead: 0,
      loweringStatus: "unsupported",
      origin: "studio-default",
      programEvidence: ["opaque solid Scene background"],
      scene: input.scene,
      transactionId: input.transactionId,
    },
  );
}

export function replaceStudioSceneBackgroundProgram(
  input: Readonly<{
    color: string;
    owner: ProgramRecord;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  if (!isCanonicalRgbHex(input.color)) {
    throw new TypeError("Scene background color must be a lowercase canonical #rrggbb color.");
  }
  const operation = input.owner.program.operations[0];
  if (
    input.owner.program.operations.length !== 1 ||
    operation?.kind !== "SetSceneBackground" ||
    input.owner.program.loweringStatus !== "unsupported"
  ) {
    throw new TypeError("Only one canonical Scene background Program can be replaced.");
  }
  return validateAndScheduleProgram(
    {
      ...input.owner.program,
      operations: [{ ...operation, color: input.color }],
    },
    input.scene,
  );
}

export function createStudioScenePostEffectProgram(
  input: Readonly<{
    capturedPlayhead: number;
    effects: readonly StudioScenePostEffectV1[];
    parameterTracks?: readonly ScenePostEffectParameterTrack[];
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const operation = sceneEditOperationSchema.parse({
    dependsOn: [],
    effects: input.effects,
    id: operationId(input.transactionId, "set-scene-post-effect"),
    interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
    kind: "SetScenePostEffect",
    parameterTracks: input.parameterTracks ?? [],
    provenance: provenance("studio-default", ["Scene graph RGB split post effect"]),
  });
  return authoringProgram([operation], {
    capturedPlayhead: input.capturedPlayhead,
    loweringStatus: "unsupported",
    origin: "studio-default",
    programEvidence: ["renderer-owned Scene-wide RGB split post effect"],
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function replaceStudioScenePostEffectProgram(
  input: Readonly<{
    effects: readonly StudioScenePostEffectV1[];
    owner: ProgramRecord;
    parameterTracks?: readonly ScenePostEffectParameterTrack[];
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const operation = input.owner.program.operations[0];
  if (
    input.owner.program.operations.length !== 1 ||
    operation?.kind !== "SetScenePostEffect" ||
    input.owner.program.loweringStatus !== "unsupported"
  ) {
    throw new TypeError("Only one canonical Scene post-effect Program can be replaced.");
  }
  const replacement = sceneEditOperationSchema.parse({
    ...operation,
    effects: input.effects,
    ...(input.parameterTracks === undefined ? {} : { parameterTracks: input.parameterTracks }),
  });
  return validateAndScheduleProgram(
    {
      ...input.owner.program,
      operations: [replacement],
    },
    input.scene,
  );
}

function appearanceEnd(scene: RuntimeSceneState, start: number) {
  return Math.min(scene.duration, start + STUDIO_STYLE_PROFILE.durationSeconds.brief);
}

export function createStudioGroupProgram(
  input: Readonly<{
    capturedPlayhead: number;
    childEntityIds: readonly string[];
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): Readonly<{ groupId: string; validation: SceneEditValidationResult }> {
  const groupId = provisionalEntityId(input.transactionId, "group");
  const operation: SceneEditOperation = {
    childEntityIds: [...input.childEntityIds],
    dependsOn: [],
    groupId,
    id: operationId(input.transactionId, "group"),
    interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
    kind: "GroupEntities",
    provenance: provenance("direct-manipulation", ["Layers panel", "canonical logical hierarchy"]),
  };
  return {
    groupId,
    validation: authoringProgram([operation], {
      capturedPlayhead: input.capturedPlayhead,
      origin: "direct-manipulation",
      scene: input.scene,
      transactionId: input.transactionId,
    }),
  };
}

export function createStudioUngroupProgram(
  input: Readonly<{
    capturedPlayhead: number;
    groupId: string;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  return authoringProgram(
    [
      {
        dependsOn: [],
        groupId: input.groupId,
        id: operationId(input.transactionId, "ungroup"),
        interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
        kind: "UngroupEntity",
        provenance: provenance("direct-manipulation", ["Layers panel", "canonical logical hierarchy"]),
      },
    ],
    {
      capturedPlayhead: input.capturedPlayhead,
      origin: "direct-manipulation",
      scene: input.scene,
      transactionId: input.transactionId,
    },
  );
}

export function createStudioEntitiesProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entities: readonly StudioEntityInput[];
    origin?: OperationOrigin;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): AuthoringProgramResult {
  if (input.entities.length === 0) throw new Error("Choose at least one object to insert.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to insert an object.");
  }
  const origin = input.origin ?? "studio-default";
  const entityIds: string[] = [];
  const operations = input.entities.flatMap((entity, index): readonly SceneEditOperation[] => {
    let content = entity.content;
    if (entity.type === "Text") {
      const canonicalTextContent = canonicalEditableContent(entity.content, "Text");
      if (canonicalTextContent === null) throw new Error(STUDIO_CREATION_TEXT_CONTRACT);
      content = canonicalTextContent;
    }
    const entityId = provisionalEntityId(input.transactionId, `insert-${index}`);
    const createId = operationId(input.transactionId, `create-${index}`);
    const positionId = operationId(input.transactionId, `position-${index}`);
    const appearId = operationId(input.transactionId, `appear-${index}`);
    const dimensions = entity.dimensions ?? defaultEntityDimensions(entity.type);
    entityIds.push(entityId);
    return [
      {
        dependsOn: [],
        entity: {
          ...(content ? { content } : {}),
          ...(entity.cubicBezier ? { cubicBezier: entity.cubicBezier } : {}),
          ...(entity.dataSeries ? { dataSeries: entity.dataSeries } : {}),
          ...(dimensions ? { dimensions } : {}),
          id: entityId,
          ...(entity.image ? { image: entity.image } : {}),
          ...(entity.svg ? { svg: entity.svg } : {}),
          lifetime: { end: null, start: input.capturedPlayhead },
          type: entity.type,
        },
        id: createId,
        interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
        kind: "CreateEntity",
        provenance: provenance(origin, ["Insert tool", entity.type]),
      },
      {
        dependsOn: [createId],
        entityId,
        id: positionId,
        interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
        key: "position",
        kind: "SetProperty",
        provenance: provenance(origin, ["canvas placement"]),
        value: entity.position,
      },
      {
        dependsOn: [positionId],
        effect: "fade-in",
        entityId,
        id: appearId,
        interval: { end, start: input.capturedPlayhead },
        kind: "ChangePresence",
        persistent: true,
        provenance: provenance(origin, ["Insert tool", "visible creation"]),
      },
    ];
  });
  return {
    entityIds,
    validation: authoringProgram(operations, {
      capturedPlayhead: input.capturedPlayhead,
      origin,
      scene: input.scene,
      styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
      transactionId: input.transactionId,
    }),
  };
}

export function createInspectorEntityEditProgram(
  input: Readonly<{
    capturedPlayhead: number;
    edits: InspectorEntityEdits;
    entityId: string;
    from: Readonly<{
      dimensions?: EntityDimensions;
      position: Point;
      scale: number;
    }>;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entity = input.scene.objectGraph.entities[input.entityId];
  if (!entity) throw new Error(`Object ${input.entityId} is no longer available.`);
  if (
    !entity.lifetime.some(
      (interval) => input.capturedPlayhead >= interval.start && input.capturedPlayhead < interval.end,
    )
  ) {
    throw new Error("The selected object is not present at the source anchor.");
  }
  const shape = entity.type === "Circle" ? "circle" : entity.type === "Rectangle" ? "rectangle" : null;
  if (input.edits.dimensions && !shape) {
    throw new Error(`${entity.type} does not support shape geometry editing.`);
  }
  if (input.edits.dimensions && !input.from.dimensions) {
    throw new Error("Shape geometry editing requires known current dimensions.");
  }
  if (input.edits.content && entity.type !== "Text" && entity.type !== "MathTex") {
    throw new Error(`${entity.type} does not support content editing.`);
  }
  if (input.edits.content && entity.sourceIdentity.kind === "unknown" && !entity.transactionId) {
    throw new Error("Studio cannot edit content without a known or Studio-generated source identity.");
  }
  if (
    input.edits.content &&
    (entity.type === "Text" || entity.type === "MathTex") &&
    entity.sourceIdentity.kind === "unknown" &&
    entity.transactionId
  ) {
    throw new Error("Studio-created content must replace its creation Program.");
  }
  if (
    input.edits.content &&
    entity.type === "Text" &&
    (entity.sourceIdentity.kind !== "unknown" || !entity.transactionId)
  ) {
    const before = studioCreationTextContent(entity.content)?.layout ?? STUDIO_TEXT_DEFAULT_LAYOUT;
    const after = studioCreationTextContent(input.edits.content)?.layout;
    if (
      after &&
      (after.alignment !== before.alignment ||
        (after.fontFamily ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontFamily) !==
          (before.fontFamily ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontFamily) ||
        after.fontSize !== before.fontSize ||
        after.fontWeight !== before.fontWeight ||
        after.lineHeight !== before.lineHeight)
    ) {
      throw new Error("Typography editing is available only for Studio-created Text.");
    }
  }
  if (Object.keys(input.edits).length === 0) {
    throw new Error("Change at least one Inspector field before creating a draft.");
  }

  const interval = { end: input.capturedPlayhead, start: input.capturedPlayhead };
  const operations: SceneEditOperation[] = [];
  if (input.edits.dimensions && input.from.dimensions && shape) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      from: { dimensions: input.from.dimensions, position: input.from.position },
      id: operationId(input.transactionId, "set-geometry"),
      interval,
      kind: "ResizeEntity",
      provenance: provenance("studio-default", ["Inspector geometry fields", "center anchored"]),
      scale: input.from.scale,
      shape,
      to: {
        dimensions: input.edits.dimensions,
        position: input.edits.position ?? input.from.position,
      },
    });
  } else if (input.edits.position) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      id: operationId(input.transactionId, "set-position"),
      interval,
      key: "position",
      kind: "SetProperty",
      provenance: provenance("studio-default", ["Inspector position fields", "one-shot position"]),
      value: input.edits.position,
    });
  }
  if (input.edits.content) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      id: operationId(input.transactionId, "set-content"),
      interval,
      key: "content",
      kind: "SetProperty",
      provenance: provenance("studio-default", ["Inspector content field", entity.type]),
      value: input.edits.content,
    });
  }
  if (operations.length === 0) {
    throw new Error("Change at least one Inspector field before creating a draft.");
  }
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "studio-default",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function replaceStudioCreatedContentProgram(
  input: Readonly<{
    content: EntityContent;
    entityId: string;
    owner: ProgramRecord;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  let replacementCount = 0;
  const operations = input.owner.program.operations.map((operation) => {
    if (operation.kind !== "CreateEntity" || operation.entity.id !== input.entityId) return operation;
    if (operation.entity.type !== "Text" && operation.entity.type !== "MathTex") {
      throw new Error("Only a Studio-created Text or MathTex entity can replace its creation content.");
    }
    const content = canonicalEditableContent(input.content, operation.entity.type);
    if (!content) {
      throw new Error(
        operation.entity.type === "Text"
          ? STUDIO_CREATION_TEXT_CONTRACT
          : "MathTex content must contain one to 16 non-blank TeX parts.",
      );
    }
    replacementCount += 1;
    return {
      ...operation,
      entity: { ...operation.entity, content },
    } satisfies SceneEditOperation;
  });
  if (replacementCount !== 1) {
    throw new Error("The Studio-created content has no unique creation owner.");
  }
  return validateAndScheduleProgram({ ...input.owner.program, operations }, input.scene);
}

export function replaceStudioCreatedDataSeriesProgram(
  input: Readonly<{
    dataSeries: DataSeries;
    entityId: string;
    owner: ProgramRecord;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  let replacementCount = 0;
  const operations = input.owner.program.operations.map((operation) => {
    if (operation.kind !== "CreateEntity" || operation.entity.id !== input.entityId) return operation;
    if (operation.entity.type !== "DataPlot") {
      throw new Error("Only a Studio-created DataPlot can replace its creation data.");
    }
    replacementCount += 1;
    return {
      ...operation,
      entity: { ...operation.entity, dataSeries: input.dataSeries },
    } satisfies SceneEditOperation;
  });
  if (replacementCount !== 1) {
    throw new Error("The Studio-created data plot has no unique creation owner.");
  }
  return validateAndScheduleProgram({ ...input.owner.program, operations }, input.scene);
}

/** Replaces the canonical cubic path and its placement in the owning creation
 * Program. Rust has already normalized the supplied nodes and handles. */
export function replaceStudioCreatedCubicBezierProgram(
  input: Readonly<{
    cubicBezier: StudioCubicBezierSpec;
    dimensions: EntityDimensions;
    entityId: string;
    owner: ProgramRecord;
    position: Point;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  let createCount = 0;
  let positionCount = 0;
  const operations = input.owner.program.operations.map((operation) => {
    if (operation.kind === "CreateEntity" && operation.entity.id === input.entityId) {
      if (operation.entity.type !== "CubicBezier") {
        throw new Error("Only a Studio-created cubic Bézier can replace its path nodes and handles.");
      }
      createCount += 1;
      return {
        ...operation,
        entity: {
          ...operation.entity,
          cubicBezier: input.cubicBezier,
          dimensions: input.dimensions,
        },
      } satisfies SceneEditOperation;
    }
    if (operation.kind === "SetProperty" && operation.key === "position" && operation.entityId === input.entityId) {
      positionCount += 1;
      return { ...operation, value: input.position } satisfies SceneEditOperation;
    }
    return operation;
  });
  if (createCount !== 1 || positionCount !== 1) {
    throw new Error("The Studio-created cubic Bézier has no unique creation owner.");
  }
  return validateAndScheduleProgram(
    {
      ...input.owner.program,
      // Closing an open Pen makes source export unsupported. Reopening must
      // derive the capability from the replacement operations instead of
      // retaining that status from the prior closed shape.
      loweringStatus: "supported",
      operations,
    },
    input.scene,
  );
}

export function createRemoveEntitiesProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityIds: readonly string[];
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entityIds = [...new Set(input.entityIds)];
  if (entityIds.length === 0) throw new Error("Select an object to delete.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to delete an object.");
  }
  const operations = entityIds.map(
    (entityId, index): SceneEditOperation => ({
      dependsOn: [],
      effect: "remove",
      entityId,
      id: operationId(input.transactionId, `remove-${index}`),
      interval: { end, start: input.capturedPlayhead },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance("studio-default", ["Delete command"]),
    }),
  );
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "studio-default",
    scene: input.scene,
    styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
    transactionId: input.transactionId,
  });
}

/** Trims every child in one Studio logical group at the same source time.
 * The zero-duration persistent removals are replayed by the Rust creation
 * authority before it rebuilds the canonical logical parent. */
export function createStudioGroupLifetimeTrimProgram(
  input: Readonly<{
    capturedPlayhead: number;
    childEntityIds: readonly string[];
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const unavailableReason = studioGroupLifetimeTrimTargetUnavailableReason(input);
  if (unavailableReason) throw new Error(unavailableReason);
  const childEntityIds = [...input.childEntityIds];
  const operations = childEntityIds.map(
    (entityId, index): SceneEditOperation => ({
      dependsOn: [],
      effect: "remove",
      entityId,
      id: operationId(input.transactionId, `trim-group-lifetime-${index}`),
      interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance("direct-manipulation", ["Layers panel", "logical group lifetime end"]),
    }),
  );
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "direct-manipulation",
    programEvidence: ["atomic logical group lifetime trim"],
    requestedExecution: "parallel",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function createImportedEntityLifetimeProgram(
  input: Readonly<{
    entityId: string;
    original: Interval;
    scene: RuntimeSceneState;
    sourceAnchor: number;
    sourceAnchorBounds?: ProgramSourceAnchorBounds;
    targetEnd: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entity = input.scene.objectGraph.entities[input.entityId];
  if (!entity) throw new Error(`Object ${input.entityId} is no longer available.`);
  const original = entity.lifetime.find(
    (interval) =>
      Math.abs(interval.start - input.original.start) < 0.001 && Math.abs(interval.end - input.original.end) < 0.001,
  );
  if (!original) throw new Error("The imported lifetime interval changed. Reimport before editing it again.");
  if (!Number.isFinite(input.targetEnd) || input.targetEnd - original.start < MIN_OBJECT_LIFETIME_SECONDS - 0.001) {
    throw new Error(`Keep at least ${MIN_OBJECT_LIFETIME_SECONDS.toFixed(1)} seconds of the selected object lifetime.`);
  }
  if (input.targetEnd > original.end + 0.001) {
    throw new Error("An imported lifetime cannot extend beyond its original source interval.");
  }
  if (
    !Number.isFinite(input.sourceAnchor) ||
    input.sourceAnchor < original.start - 0.001 ||
    input.sourceAnchor > original.end + 0.001
  ) {
    throw new Error("A safe source anchor is required inside the selected lifetime.");
  }
  const restoringOriginal = Math.abs(input.targetEnd - original.end) < 0.001;
  if (
    !restoringOriginal &&
    (input.sourceAnchor < (input.sourceAnchorBounds?.minimum ?? -Infinity) - 0.001 ||
      input.sourceAnchor > (input.sourceAnchorBounds?.maximum ?? Infinity) + 0.001)
  ) {
    throw new Error("This lifetime would place its applied Program out of source order relative to another edit.");
  }

  if (!restoringOriginal && Math.abs(input.sourceAnchor - input.targetEnd) >= 0.001) {
    throw new Error("The imported lifetime end must snap to its safe source anchor.");
  }
  const operation: SceneEditOperation = restoringOriginal
    ? {
        dependsOn: [],
        eventKind: "wait",
        id: operationId(input.transactionId, "restore-lifetime-end"),
        interval: { end: input.sourceAnchor, start: input.sourceAnchor },
        kind: "InsertTimelineEvent",
        label: "Restore imported lifetime",
        provenance: provenance("direct-manipulation", ["lifetime end restore", "source interval unchanged"]),
      }
    : {
        dependsOn: [],
        effect: "remove",
        entityId: input.entityId,
        id: operationId(input.transactionId, "trim-lifetime-end"),
        interval: { end: input.targetEnd, start: input.targetEnd },
        kind: "ChangePresence",
        persistent: true,
        provenance: provenance("direct-manipulation", [
          "lifetime right-edge edit",
          "safe source anchor",
          "persistent exit",
        ]),
      };
  return authoringProgram([operation], {
    capturedPlayhead: input.sourceAnchor,
    origin: "direct-manipulation",
    programEvidence: [
      importedLifetimeEditEvidence({
        entityId: input.entityId,
        kind: "imported-end",
        original,
      }),
    ],
    requestedExecution: "sequence",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

function shiftInterval(interval: Interval, delta: number): Interval {
  return { end: interval.end + delta, start: interval.start + delta };
}

function shiftStudioCreationOperation(
  operation: SceneEditOperation,
  delta: number,
  entityId: string,
  target: Interval,
  sceneDuration: number,
): SceneEditOperation {
  const interval = shiftInterval(operation.interval, delta);
  if (operation.kind === "CreateEntity") {
    return {
      ...operation,
      entity: {
        ...operation.entity,
        lifetime:
          operation.entity.id === entityId
            ? {
                end: Math.abs(target.end - sceneDuration) < 0.001 ? null : target.end,
                start: target.start,
              }
            : {
                end: operation.entity.lifetime.end === null ? null : operation.entity.lifetime.end + delta,
                start: operation.entity.lifetime.start + delta,
              },
      },
      interval,
    };
  }
  if (
    ((operation.kind === "ChangePresence" && operation.effect === "fade-in") ||
      operation.kind === "DrawIn" ||
      operation.kind === "WriteIn") &&
    operation.entityId === entityId &&
    interval.end > target.end
  ) {
    return { ...operation, interval: { ...interval, end: target.end } };
  }
  if (operation.kind === "InsertSceneBoundary") {
    return { ...operation, at: operation.at + delta, interval };
  }
  return { ...operation, interval };
}

function operationTargetsEntity(operation: SceneEditOperation, entityId: string) {
  if (operation.kind === "CreateEntity") return operation.entity.id === entityId;
  if (
    operation.kind === "SetProperty" ||
    operation.kind === "AnimateProperty" ||
    operation.kind === "ChangePresence" ||
    operation.kind === "DrawIn" ||
    operation.kind === "WriteIn" ||
    operation.kind === "TransformPath" ||
    operation.kind === "TransformShape"
  )
    return operation.entityId === entityId;
  if (operation.kind === "CreateMotion") return operation.targetEntityIds.includes(entityId);
  if (operation.kind === "CreatePathMotion") {
    return operation.targetEntityId === entityId || operation.pathEntityId === entityId;
  }
  if (operation.kind === "TransformContent") {
    return operation.sourceEntityId === entityId || operation.targetEntityId === entityId;
  }
  if (operation.kind === "SetRelation") {
    return operation.sourceEntityId === entityId || operation.targetEntityId === entityId;
  }
  return false;
}

export function replaceStudioEntityLifetimeProgram(
  input: Readonly<{
    entityId: string;
    owner: ProgramRecord;
    scene: RuntimeSceneState;
    sourceAnchorBounds?: ProgramSourceAnchorBounds;
    sourceAnchors: readonly number[];
    target: Interval;
  }>,
): SceneEditValidationResult {
  const created = input.owner.program.operations.filter((operation) => operation.kind === "CreateEntity");
  const create = created.find((operation) => operation.entity.id === input.entityId);
  if (!create) throw new Error("The Studio creation Program no longer owns this object.");
  if (
    !Number.isFinite(input.target.start) ||
    !Number.isFinite(input.target.end) ||
    input.target.start < 0 ||
    input.target.end > input.scene.duration + 0.001 ||
    input.target.end - input.target.start < MIN_OBJECT_LIFETIME_SECONDS - 0.001
  ) {
    throw new Error(
      `Keep the lifetime within the Scene and at least ${MIN_OBJECT_LIFETIME_SECONDS.toFixed(1)} seconds wide.`,
    );
  }
  const delta = input.target.start - create.entity.lifetime.start;
  const movesProgram = Math.abs(delta) >= 0.001;
  if (movesProgram && created.length !== 1) {
    throw new Error("This object shares one creation Program with other objects and cannot move independently.");
  }
  if (movesProgram && Math.abs(create.entity.lifetime.start - input.owner.program.anchor.resolvedSeconds) >= 0.001) {
    throw new Error("This object is created after its Program begins and cannot move independently.");
  }
  const replacementAnchor = input.owner.program.anchor.resolvedSeconds + delta;
  const sourceOrderRequired = movesProgram || Math.abs(input.target.end - input.scene.duration) >= 0.001;
  if (
    sourceOrderRequired &&
    (replacementAnchor < (input.sourceAnchorBounds?.minimum ?? -Infinity) - 0.001 ||
      replacementAnchor > (input.sourceAnchorBounds?.maximum ?? Infinity) + 0.001)
  ) {
    throw new Error("This lifetime would place its applied Program out of source order relative to another edit.");
  }
  const hasAnchor = (time: number) => input.sourceAnchors.some((anchor) => Math.abs(anchor - time) < 0.001);
  if (movesProgram && !hasAnchor(replacementAnchor)) {
    throw new Error("The Studio-owned lifetime start must snap to a safe .py source anchor.");
  }
  if (Math.abs(input.target.end - input.scene.duration) >= 0.001 && !hasAnchor(input.target.end)) {
    throw new Error("The Studio-owned lifetime end must snap to a safe .py source anchor or the Scene end.");
  }

  const operations = input.owner.program.operations.map((operation) =>
    shiftStudioCreationOperation(operation, delta, input.entityId, input.target, input.scene.duration),
  );
  const outsideLifetime = operations.find(
    (operation) =>
      operation.kind !== "CreateEntity" &&
      (movesProgram || operationTargetsEntity(operation, input.entityId)) &&
      (operation.interval.start < input.target.start - 0.001 || operation.interval.end > input.target.end + 0.001),
  );
  if (outsideLifetime) {
    throw new Error("The creation Program contains work outside the requested lifetime interval.");
  }
  const replacement = {
    ...input.owner.program,
    anchor: {
      capturedPlayhead: input.owner.program.anchor.capturedPlayhead + delta,
      evidence: [
        ...input.owner.program.anchor.evidence.filter((entry) => !entry.startsWith("lifetime-start:")),
        `lifetime-start:${input.target.start.toFixed(3)}`,
      ].slice(-32),
      resolvedSeconds: replacementAnchor,
      source: { kind: "absolute", seconds: replacementAnchor } as const,
    },
    operations,
    provenance: {
      ...input.owner.program.provenance,
      evidence: [
        ...input.owner.program.provenance.evidence.filter((entry) => entry !== "Studio-owned lifetime replacement"),
        "Studio-owned lifetime replacement",
      ],
    },
  };
  return validateAndScheduleProgram(replacement, input.scene);
}

const DURATION_EPSILON = 0.001;

export function createSceneDurationProgram(
  input: Readonly<{
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    sourceAnchor: number;
    targetDuration: number;
    transactionId: string;
    trimAvailability?: SceneDurationTrimAvailability;
  }>,
): SceneEditValidationResult {
  const change = input.targetDuration - input.scene.duration;
  if (!Number.isFinite(input.targetDuration) || input.targetDuration < 0.1) {
    throw new Error("The new Scene duration must be a finite value of at least 0.1 seconds.");
  }
  if (Math.abs(change) < 0.1 - DURATION_EPSILON) {
    throw new Error("Change the Scene duration by at least 0.1 seconds.");
  }

  if (change < 0) {
    const availability = input.trimAvailability;
    if (!availability) {
      throw new Error("A Rust timeline projection is required to shorten the Scene duration.");
    }
    if (availability.blocker) throw new Error(availability.blocker);
    const removedDuration = -change;
    if (removedDuration > availability.removableDuration + DURATION_EPSILON) {
      throw new Error(
        `The shortest safe duration is ${availability.minimumDuration.toFixed(2)}s. ` +
          `Only ${availability.removableDuration.toFixed(2)}s of Studio-added trailing wait can be removed; imported or animated content would be truncated.`,
      );
    }
    if (availability.anchor === null || availability.waitOperationIds.length === 0) {
      throw new Error("No Studio-added trailing Scene duration wait is available to shorten.");
    }
    const operation: SceneEditOperation = {
      dependsOn: [],
      id: operationId(input.transactionId, "trim-scene-duration"),
      interval: { end: availability.anchor, start: availability.anchor },
      kind: "TrimSceneDuration",
      provenance: provenance("studio-default", [
        "Scene duration control",
        `${removedDuration.toFixed(3)} second Studio wait reduction`,
      ]),
      removedDuration,
      targetDuration: input.targetDuration,
      waitOperationIds: availability.waitOperationIds,
    };
    const program: SceneEdit = {
      anchor: {
        capturedPlayhead: input.capturedPlayhead,
        evidence: [`source-anchor:${availability.anchor.toFixed(3)}`, "Studio duration wait suffix"],
        resolvedSeconds: availability.anchor,
        source: { kind: "absolute", seconds: availability.anchor },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("studio-default", ["manual Scene duration", "safe Studio wait reduction"]),
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    };
    return validateAndScheduleProgram(program, input.scene);
  }

  const extension = change;
  if (!Number.isFinite(input.sourceAnchor) || input.sourceAnchor < 0 || input.sourceAnchor > input.scene.duration) {
    throw new Error("A safe source anchor is required to extend the Scene duration.");
  }
  const operation: SceneEditOperation = {
    dependsOn: [],
    eventKind: "wait",
    id: operationId(input.transactionId, "extend-scene-duration"),
    interval: { end: input.sourceAnchor + extension, start: input.sourceAnchor },
    kind: "InsertTimelineEvent",
    label: `Extend Scene to ${input.targetDuration.toFixed(2)}s`,
    purpose: "scene-duration",
    provenance: provenance("studio-default", ["Scene duration control", `${extension.toFixed(3)} second wait`]),
  };
  const program: SceneEdit = {
    anchor: {
      capturedPlayhead: input.capturedPlayhead,
      evidence: [`source-anchor:${input.sourceAnchor.toFixed(3)}`],
      resolvedSeconds: input.sourceAnchor,
      source: { kind: "absolute", seconds: input.sourceAnchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: provenance("studio-default", ["manual Scene duration"]),
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, input.scene);
}

function duplicatedEntityDimensions(type: string, dimensions: EntityDimensions | null) {
  if (dimensions === null) return undefined;
  const { angles, coordinateSystem, height, radius, sides, width } = dimensions;
  if (type === "Circle" && radius !== undefined && !angles && !coordinateSystem && !height && !sides && !width) {
    return { radius };
  }
  if (
    type === "Rectangle" &&
    height !== undefined &&
    width !== undefined &&
    !angles &&
    !coordinateSystem &&
    !radius &&
    !sides
  ) {
    return { height, width };
  }
  if (
    (type === "Triangle" || type === "RegularPolygon") &&
    radius !== undefined &&
    sides !== undefined &&
    !angles &&
    !coordinateSystem &&
    !height &&
    !width
  ) {
    return { radius, sides };
  }
  if (
    type === "Ellipse" &&
    height !== undefined &&
    width !== undefined &&
    !angles &&
    !coordinateSystem &&
    !radius &&
    !sides
  ) {
    return { height, width };
  }
  if (
    (type === "Arc" || type === "Sector") &&
    angles &&
    radius !== undefined &&
    !coordinateSystem &&
    !height &&
    !sides &&
    !width
  ) {
    return { angles, radius };
  }
  if (
    type === "NumberLine" &&
    coordinateSystem &&
    !coordinateSystem.y &&
    width !== undefined &&
    !angles &&
    !height &&
    !radius &&
    !sides
  ) {
    return { coordinateSystem, width };
  }
  if (
    (type === "Axes" || type === "NumberPlane") &&
    coordinateSystem?.y &&
    height !== undefined &&
    width !== undefined &&
    !angles &&
    !radius &&
    !sides
  ) {
    return { coordinateSystem, height, width };
  }
  return undefined;
}

export function duplicateEntityInput(
  entity: ProjectedEntity,
  offset: number = STUDIO_STYLE_PROFILE.spacingUnitPx,
): StudioEntityInput | null {
  if (!INSERT_ENTITY_TYPES.some((type) => type === entity.type)) return null;
  if (entity.type === "CubicBezier") return null;
  const knownDimensions = entity.geometry.dimensions.kind === "known" ? entity.geometry.dimensions.value : null;
  const dimensions = duplicatedEntityDimensions(entity.type, knownDimensions);
  return {
    content: entity.content,
    ...(dimensions ? { dimensions } : {}),
    position: { x: entity.position.x + offset, y: entity.position.y + offset },
    type: entity.type as InsertEntityType,
  };
}

export function defaultEntityContent(type: InsertEntityType, value: string): EntityContent | undefined {
  if (type === "Text") {
    const candidate = value.trim().length === 0 ? "Text" : value;
    const content = canonicalEditableContent(
      { displayLines: candidate.split(/\r?\n/u), label: candidate, text: candidate },
      "Text",
    );
    if (content === null) throw new Error(STUDIO_CREATION_TEXT_CONTRACT);
    return content;
  }
  const normalized = value.trim();
  if (type === "MathTex") {
    const tex = normalized || "x";
    return { displayLines: [tex], label: tex, texParts: [tex] };
  }
  return { displayLines: [type], label: type };
}
