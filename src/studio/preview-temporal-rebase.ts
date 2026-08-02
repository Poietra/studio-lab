import { type SceneEntityV1, type SceneIrV1, sceneIrSourceRevisionHash, sceneIrV1Schema } from "../engine/scene-ir";
import type { Point, ProposedState } from "./model";
import { PRISTINE_WORKING_REVISION, type StudioVerifiedPreviewSnapshotV1 } from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewTemporalRebaseIssueCodeV1 =
  | "camera-edit-unsupported"
  | "channel-timing-edit-unsupported"
  | "conflicting-edit-unsupported"
  | "geometry-edit-unsupported"
  | "identity-unverified"
  | "mid-animation-edit-unsupported"
  | "motion-path-edit-unsupported"
  | "profile-unsupported"
  | "scale-edit-unsupported"
  | "source-correlation-invalid"
  | "target-edit-unsupported";

export type StudioPreviewTemporalRebaseIssueV1 = Readonly<{
  code: StudioPreviewTemporalRebaseIssueCodeV1;
  message: string;
}>;

export type StudioPreviewTemporalRebaseResultV1 =
  | Readonly<{ issue: StudioPreviewTemporalRebaseIssueV1; kind: "unsupported" }>
  | Readonly<{ kind: "rebased"; scene: SceneIrV1 }>;

type AuthorizedEditV1 = Readonly<{
  operationIds: readonly string[];
  position: Point | null;
  runtimeEntityId: string;
  scaleFactor: number | null;
  studioEntityId: string;
}>;

function unsupported(code: StudioPreviewTemporalRebaseIssueCodeV1, message: string) {
  return { issue: { code, message }, kind: "unsupported" } as const;
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function isFinitePoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function isExactCreateChannel(channel: SceneIrV1["animationChannels"][number]) {
  return (
    channel.kind === "path-trim" &&
    channel.parameterization === "uniform-cubic-parameter-v1" &&
    channel.keyframes.length === 2 &&
    channel.keyframes[0]?.at === 0 &&
    channel.keyframes[0]?.value === 0 &&
    channel.keyframes[1]?.value === 1
  );
}

function snapshotCorrelationIsExact(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    source.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 7 &&
    sceneIrSourceRevisionHash(bundle.scene) === correlation.engineRevisionHash &&
    source.sourceHash === correlation.context.sourceHash &&
    bundle.assets.manifestDigest === correlation.assetsManifestDigest &&
    bundle.scene.sceneId === correlation.sceneId &&
    snapshot.sceneId === correlation.sceneId &&
    bundle.scene.duration === correlation.sceneDuration &&
    snapshot.duration === correlation.sceneDuration &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    correlation.context.workingRevision === PRISTINE_WORKING_REVISION
  );
}

function localCenter(entity: SceneEntityV1) {
  if (entity.geometry.kind !== "cubic-path") return null;
  const points = entity.geometry.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
  ]);
  if (points.length === 0) return null;
  return {
    x: (Math.min(...points.map(({ x }) => x)) + Math.max(...points.map(({ x }) => x))) / 2,
    y: (Math.min(...points.map(({ y }) => y)) + Math.max(...points.map(({ y }) => y))) / 2,
  };
}

function studioPointToScenePoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Point,
) {
  return {
    x: cameraCenter.x + (point.x / STUDIO_VIEWPORT.width - 0.5) * frame.width,
    y: cameraCenter.y + (0.5 - point.y / STUDIO_VIEWPORT.height) * frame.height,
  };
}

function operationIssueCode(
  kind: ProposedState["programs"][number]["program"]["operations"][number]["kind"],
): StudioPreviewTemporalRebaseIssueCodeV1 {
  if (kind === "ChangeCamera") return "camera-edit-unsupported";
  if (kind === "CreateMotion" || kind === "ModifyMotion") return "motion-path-edit-unsupported";
  if (kind === "InsertSceneBoundary" || kind === "InsertTimelineEvent" || kind === "TrimSceneDuration") {
    return "channel-timing-edit-unsupported";
  }
  if (kind === "ResizeEntity" || kind === "TransformContent") return "geometry-edit-unsupported";
  return "target-edit-unsupported";
}

function planInitialTransformEdit(
  input: Readonly<{
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
  }>,
): Readonly<{ edit: AuthorizedEditV1; kind: "supported" }> | StudioPreviewTemporalRebaseResultV1 {
  const scene = input.snapshot.snapshot.scene;
  if (!snapshotCorrelationIsExact(input.snapshot)) {
    return unsupported("source-correlation-invalid", "The verified V7 snapshot has inconsistent source authority.");
  }
  if (input.proposedState.evaluatedScene.duration !== scene.duration) {
    return unsupported(
      "channel-timing-edit-unsupported",
      "Mixed V7 initial edits cannot change Scene or channel timing.",
    );
  }
  if (
    input.proposedState.base.runtimeSceneState.duration !== scene.duration ||
    input.proposedState.evaluatedScene.sceneId !== input.proposedState.base.runtimeSceneState.sceneId
  ) {
    return unsupported("source-correlation-invalid", "Studio state is not correlated with the verified V7 Scene.");
  }

  const identity = input.snapshot.sourceRuntimeIdentity;
  if (!identity || identity.size !== scene.entities.length) {
    return unsupported("identity-unverified", "Mixed V7 initial edits require complete runtime identity.");
  }
  const runtimeEntities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const verifiedRuntimeIds = new Set<string>();
  for (const [sourceName, mapping] of identity) {
    if (
      mapping.sourceName !== sourceName ||
      !runtimeEntities.has(mapping.entityId) ||
      verifiedRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Mixed V7 source/runtime identity is incomplete or ambiguous.");
    }
    verifiedRuntimeIds.add(mapping.entityId);
  }
  if (verifiedRuntimeIds.size !== runtimeEntities.size) {
    return unsupported("identity-unverified", "Mixed V7 source/runtime identity does not cover every entity.");
  }
  const baseEntities = input.proposedState.base.runtimeSceneState.objectGraph.entities;
  const evaluatedEntities = input.proposedState.evaluatedScene.objectGraph.entities;
  if (Object.keys(baseEntities).length !== Object.keys(evaluatedEntities).length) {
    return unsupported(
      "target-edit-unsupported",
      "Mixed V7 initial edits cannot create, remove, or replace Studio-imported entities.",
    );
  }

  const mappedStudioRuntimeIds = new Set<string>();
  const studioToRuntime = new Map<string, string>();
  for (const entity of Object.values(evaluatedEntities)) {
    const baseEntity = baseEntities[entity.id];
    if (
      !baseEntity ||
      entity.provisional ||
      entity.transactionId !== undefined ||
      entity.type !== baseEntity.type ||
      entity.sourceIdentity.kind !== "known" ||
      baseEntity.sourceIdentity.kind !== "known" ||
      entity.sourceIdentity.value !== baseEntity.sourceIdentity.value
    ) {
      return unsupported("identity-unverified", "A mixed V7 edit target has no stable imported identity.");
    }
    const mapping = identity.get(entity.sourceIdentity.value);
    if (
      !mapping ||
      mapping.sourceName !== entity.sourceIdentity.value ||
      !runtimeEntities.has(mapping.entityId) ||
      mappedStudioRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Mixed V7 source/runtime identity is incomplete or ambiguous.");
    }
    mappedStudioRuntimeIds.add(mapping.entityId);
    studioToRuntime.set(entity.id, mapping.entityId);
  }

  const channelsByEntity = new Map<string, SceneIrV1["animationChannels"]>();
  for (const channel of scene.animationChannels) {
    if (channel.kind !== "path-trim" && channel.kind !== "motion-path") {
      return unsupported("profile-unsupported", "Mixed V7 temporal preview found an unsupported channel kind.");
    }
    channelsByEntity.set(channel.entityId, [...(channelsByEntity.get(channel.entityId) ?? []), channel]);
  }

  let edit: AuthorizedEditV1 | null = null;
  const authorizedOperations = new Map<
    string,
    Readonly<{ key: "position" | "scale"; studioEntityId: string; value: Point | number }>
  >();
  for (const record of input.proposedState.programs) {
    const { program } = record;
    if (record.validation.status !== "valid") {
      return unsupported("conflicting-edit-unsupported", "Mixed V7 initial preview cannot apply an invalid Program.");
    }
    if (program.anchor.resolvedSeconds !== 0 || program.anchor.capturedPlayhead !== 0) {
      return unsupported(
        "mid-animation-edit-unsupported",
        "Mixed V7 initial edits must be captured and anchored at source time zero.",
      );
    }
    if (program.loweringStatus !== "supported") {
      return unsupported("target-edit-unsupported", "Mixed V7 initial preview accepts only source-lowerable edits.");
    }
    for (const operation of program.operations) {
      if (operation.interval.start !== 0 || operation.interval.end !== 0) {
        return unsupported(
          "mid-animation-edit-unsupported",
          "Mixed V7 initial edits must be instantaneous at source time zero.",
        );
      }
      if (authorizedOperations.has(operation.id)) {
        return unsupported("conflicting-edit-unsupported", "Mixed V7 initial operation IDs must be unique.");
      }
      if (!("entityId" in operation)) {
        return unsupported(operationIssueCode(operation.kind), "The operation does not commute with imported V7 time.");
      }
      const runtimeEntityId = studioToRuntime.get(operation.entityId);
      if (!runtimeEntityId) {
        return unsupported("identity-unverified", "An edited Studio entity has no verified V7 runtime identity.");
      }
      if (edit && edit.runtimeEntityId !== runtimeEntityId) {
        return unsupported(
          "conflicting-edit-unsupported",
          "One mixed V7 preview revision may edit one logical target.",
        );
      }
      const targetChannels = channelsByEntity.get(runtimeEntityId) ?? [];
      if (targetChannels.some(({ kind }) => kind === "motion-path")) {
        return unsupported(
          "motion-path-edit-unsupported",
          "Mixed V7 initial preview cannot edit a MoveAlongPath target or path.",
        );
      }
      const studioEntity = evaluatedEntities[operation.entityId];
      const staticMathTex = studioEntity?.type === "MathTex" && targetChannels.length === 0;
      const createTarget = targetChannels.length === 1 && isExactCreateChannel(targetChannels[0]!);
      const runtimeEntity = runtimeEntities.get(runtimeEntityId);
      if ((!staticMathTex && !createTarget) || runtimeEntity?.geometry.kind !== "cubic-path") {
        return unsupported(
          "target-edit-unsupported",
          "Mixed V7 initial edits are limited to static MathTex and exact cubic Create targets.",
        );
      }
      const prior: AuthorizedEditV1 = edit ?? {
        operationIds: [],
        position: null,
        runtimeEntityId,
        scaleFactor: null,
        studioEntityId: operation.entityId,
      };
      if (operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value)) {
        if (prior.position) {
          return unsupported("conflicting-edit-unsupported", "One mixed V7 target has conflicting position edits.");
        }
        edit = { ...prior, operationIds: [...prior.operationIds, operation.id], position: { ...operation.value } };
        authorizedOperations.set(operation.id, {
          key: "position",
          studioEntityId: operation.entityId,
          value: operation.value,
        });
        continue;
      }
      if (
        operation.kind === "AnimateProperty" &&
        operation.key === "scale" &&
        operation.control === undefined &&
        typeof operation.from === "number" &&
        typeof operation.to === "number" &&
        typeof operation.relativeFactor === "number" &&
        Number.isFinite(operation.from) &&
        Number.isFinite(operation.to) &&
        Number.isFinite(operation.relativeFactor) &&
        operation.from > 0 &&
        operation.to > 0 &&
        operation.relativeFactor > 0 &&
        closeEnough(operation.to / operation.from, operation.relativeFactor)
      ) {
        if (prior.scaleFactor !== null) {
          return unsupported("conflicting-edit-unsupported", "One mixed V7 target has conflicting scale edits.");
        }
        edit = {
          ...prior,
          operationIds: [...prior.operationIds, operation.id],
          scaleFactor: operation.relativeFactor,
        };
        authorizedOperations.set(operation.id, {
          key: "scale",
          studioEntityId: operation.entityId,
          value: operation.to,
        });
        continue;
      }
      return unsupported(
        operationIssueCode(operation.kind),
        "Mixed V7 initial preview accepts only finite position and positive uniform scale edits.",
      );
    }
  }
  if (!edit) {
    return unsupported("target-edit-unsupported", "Mixed V7 initial preview found no supported edit.");
  }

  const observedOperations = new Map<string, number>();
  for (const channel of Object.values(input.proposedState.evaluatedScene.propertyChannels)) {
    for (const sample of channel.samples) {
      if (!sample.operationId) continue;
      const authorized = authorizedOperations.get(sample.operationId);
      const positionMatches =
        authorized?.key === "position" &&
        sample.kind === "exact" &&
        isFinitePoint(sample.value) &&
        isFinitePoint(authorized.value) &&
        closeEnough(sample.value.x, authorized.value.x) &&
        closeEnough(sample.value.y, authorized.value.y);
      const scaleMatches =
        authorized?.key === "scale" &&
        sample.kind === "animated" &&
        typeof sample.from === "number" &&
        typeof sample.value === "number" &&
        typeof authorized.value === "number" &&
        closeEnough(sample.value, authorized.value);
      if (
        !authorized ||
        authorized.studioEntityId !== channel.entityId ||
        authorized.key !== channel.key ||
        (!positionMatches && !scaleMatches)
      ) {
        return unsupported(
          "conflicting-edit-unsupported",
          "Evaluated mixed V7 property evidence does not match its authorized operation value.",
        );
      }
      observedOperations.set(sample.operationId, (observedOperations.get(sample.operationId) ?? 0) + 1);
    }
  }
  if ([...authorizedOperations].some(([operationId]) => observedOperations.get(operationId) !== 1)) {
    return unsupported(
      "conflicting-edit-unsupported",
      "Mixed V7 initial preview requires one evaluated property sample per authorized operation.",
    );
  }
  return { edit, kind: "supported" };
}

/**
 * Rebase one bounded t=0 Studio transform directly onto a verified mixed V7
 * snapshot. The static Studio adapter is deliberately bypassed: untouched
 * dynamic semantic state is not reconstructed or flattened.
 */
export function compileStudioPreviewTemporalRebaseV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
  }>,
): StudioPreviewTemporalRebaseResultV1 {
  const scene = input.snapshot.snapshot.scene;
  if (
    !Number.isFinite(input.frame.width) ||
    !Number.isFinite(input.frame.height) ||
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight
  ) {
    return unsupported("camera-edit-unsupported", "Mixed V7 rebase requires the exact verified camera frame.");
  }
  const planned = planInitialTransformEdit(input);
  if (planned.kind !== "supported") return planned;
  const { edit } = planned;
  const targetIndex = scene.entities.findIndex(({ id }) => id === edit.runtimeEntityId);
  const target = scene.entities[targetIndex];
  const center = target ? localCenter(target) : null;
  if (!target || !center) {
    return unsupported("geometry-edit-unsupported", "The authorized V7 target has no bounded cubic geometry.");
  }
  if (
    target.transform.m11 !== 1 ||
    target.transform.m12 !== 0 ||
    target.transform.m21 !== 0 ||
    target.transform.m22 !== 1 ||
    target.transform.tx !== 0 ||
    target.transform.ty !== 0
  ) {
    return unsupported(
      "profile-unsupported",
      "Verified V7 base entities must retain the canonical identity transform.",
    );
  }
  const scale = edit.scaleFactor ?? 1;
  const targetCenter = edit.position
    ? studioPointToScenePoint(edit.position, input.frame, scene.camera.view.center)
    : center;
  const provenanceId = `studio-temporal-rebase:${input.sourceRevisionHash}`;
  if (scene.provenance.some(({ id }) => id === provenanceId)) {
    return unsupported("conflicting-edit-unsupported", "The Studio V7 rebase provenance identity already exists.");
  }
  const editedEntity: SceneEntityV1 = {
    ...target,
    provenanceId,
    transform: {
      m11: scale,
      m12: 0,
      m21: 0,
      m22: scale,
      tx: targetCenter.x - scale * center.x,
      ty: targetCenter.y - scale * center.y,
    },
  };
  const candidate: SceneIrV1 = {
    ...scene,
    entities: scene.entities.map((entity, index) => (index === targetIndex ? editedEntity : entity)),
    provenance: [
      ...scene.provenance,
      {
        evidence: [
          "Studio t=0 transform rebased onto verified mixed V7 geometry",
          ...edit.operationIds.map((operationId) => `authorized operation ${operationId}`),
        ],
        id: provenanceId,
        origin: "studio-edit-program",
      },
    ],
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: input.sourceRevisionHash },
  };
  const parsed = sceneIrV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return unsupported(
      "conflicting-edit-unsupported",
      `The mixed V7 temporal rebase is not valid Scene IR: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return { kind: "rebased", scene: candidate };
}
