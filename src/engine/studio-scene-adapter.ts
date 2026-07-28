import type {
  EntityDimensions,
  Knowledge,
  Point,
  PropertyChannel,
  PropertyChannelSample,
  PropertyValue,
  ProposedState,
  RuntimeEntity,
} from "../studio/model";
import {
  isEntityDimensionsValue,
  isPointValue,
  samplePropertyKnowledge,
  samplePropertyValue,
} from "../studio/property-sampling";
import { STUDIO_VIEWPORT } from "../studio/studio-viewport-geometry";
import { type AssetManifestV1, parseVerifiedAssetManifestV1 } from "./asset-manifest";
import type { SceneIrBundleV1 } from "./contracts";
import type { EnginePointV1 } from "./primitives";
import { type SceneIrV1, sceneIrV1Schema } from "./scene-ir";

type VectorAppearanceV1 = Extract<SceneIrV1["entities"][number]["appearance"], { kind: "vector" }>;

export type StudioSceneIrAdapterEvidenceV1 = Readonly<{
  appearances: Readonly<Record<string, VectorAppearanceV1>>;
  camera: SceneIrV1["camera"];
  entityIds?: Readonly<Record<string, string>>;
  fidelity?: SceneIrV1["fidelity"];
  paintOrder: readonly Readonly<{ entityId: string; sourceZIndex: number }>[];
  provenance: readonly string[];
}>;

export type StudioSceneIrAdapterRuntimeIdentityV1 = ReadonlyMap<
  string,
  Readonly<{ bindingId: string; entityId: string; sourceName: string }>
>;

export type StudioSceneIrAdapterInputV1 = Readonly<{
  assets: AssetManifestV1;
  evidence: StudioSceneIrAdapterEvidenceV1;
  frame: Readonly<{ height: number; width: number }>;
  proposedState: Pick<ProposedState, "evaluatedScene" | "programs">;
  sourceRevisionHash: string;
}>;

export type StudioSceneIrAdapterIssueCodeV1 =
  | "asset-evidence-invalid"
  | "camera-evidence-invalid"
  | "geometry-unsupported"
  | "invalid-program"
  | "ordering-evidence-invalid"
  | "output-invalid"
  | "program-state-mismatch"
  | "property-animation-unsupported"
  | "property-discontinuity-unsupported"
  | "property-unsupported"
  | "render-style-unresolved"
  | "scene-constraint-unsupported"
  | "unknown-evidence";

export type StudioSceneIrAdapterIssueV1 = Readonly<{
  code: StudioSceneIrAdapterIssueCodeV1;
  entityId?: string;
  evidence: readonly string[];
  message: string;
  operationId?: string;
}>;

export type StudioSceneIrAdapterResultV1 =
  | Readonly<{ kind: "compiled"; scene: SceneIrV1 }>
  | Readonly<{ issues: readonly StudioSceneIrAdapterIssueV1[]; kind: "unsupported" }>;

const STATIC_PROPERTY_KEYS = new Set<PropertyChannel["key"]>([
  "appearance",
  "dimensions",
  "position",
  "presence",
  "scale",
]);

function issue(
  code: StudioSceneIrAdapterIssueCodeV1,
  message: string,
  options: Readonly<{ entityId?: string; evidence?: readonly string[]; operationId?: string }> = {},
): StudioSceneIrAdapterIssueV1 {
  const { evidence = [], ...context } = options;
  return { code, evidence, message, ...context };
}

const MANIM_WHITE = { alpha: 1, blue: 1, green: 1, red: 1 } as const;
const MANIM_DEFAULT_SHAPE_APPEARANCE: VectorAppearanceV1 = {
  fill: null,
  kind: "vector",
  opacity: 1,
  stroke: {
    cap: "butt",
    color: MANIM_WHITE,
    join: "miter",
    miterLimit: 10,
    widthWorld: 0.04,
  },
};

export type BuildStudioSceneIrAdapterEvidenceResultV1 =
  | Readonly<{ evidence: StudioSceneIrAdapterEvidenceV1; kind: "resolved" }>
  | Readonly<{ issues: readonly StudioSceneIrAdapterIssueV1[]; kind: "unsupported" }>;

/**
 * Resolves only evidence that the Studio adapter is allowed to claim. Imported
 * objects inherit camera, paint, appearance, and runtime identity from the
 * server-verified snapshot map. Studio-created Circle/Rectangle objects use
 * Manim's fixed vector defaults only while Studio carries known empty style
 * evidence; custom or unknown style stays on the semantic fallback path.
 */
export function buildStudioSceneIrAdapterEvidenceV1(
  input: Readonly<{
    proposedState: Pick<ProposedState, "evaluatedScene" | "programs">;
    snapshot: SceneIrBundleV1;
    sourceRuntimeIdentity: StudioSceneIrAdapterRuntimeIdentityV1 | null;
  }>,
): BuildStudioSceneIrAdapterEvidenceResultV1 {
  const issues: StudioSceneIrAdapterIssueV1[] = [];
  const appearances: Record<string, VectorAppearanceV1> = {};
  const entityIds: Record<string, string> = {};
  const paintOrder: { entityId: string; sourceZIndex: number }[] = [];
  const snapshotEntities = new Map(input.snapshot.scene.entities.map((entity) => [entity.id, entity]));
  const mappedRuntimeIds = new Set<string>();
  const created: RuntimeEntity[] = [];

  for (const entity of Object.values(input.proposedState.evaluatedScene.objectGraph.entities)) {
    const imported = !entity.provisional && entity.transactionId === undefined;
    if (!imported) {
      created.push(entity);
      continue;
    }
    if (entity.sourceIdentity.kind !== "known" || !input.sourceRuntimeIdentity) {
      issues.push(
        issue("unknown-evidence", `Imported entity ${entity.id} has no verified source/runtime identity.`, {
          entityId: entity.id,
        }),
      );
      continue;
    }
    const mapping = input.sourceRuntimeIdentity.get(entity.sourceIdentity.value);
    const runtimeEntity = mapping ? snapshotEntities.get(mapping.entityId) : undefined;
    if (!mapping || !runtimeEntity || mapping.sourceName !== entity.sourceIdentity.value) {
      issues.push(
        issue("unknown-evidence", `Imported entity ${entity.id} does not match one verified runtime entity.`, {
          entityId: entity.id,
        }),
      );
      continue;
    }
    if (mappedRuntimeIds.has(runtimeEntity.id) || runtimeEntity.appearance.kind !== "vector") {
      issues.push(
        issue("render-style-unresolved", `Imported entity ${entity.id} has ambiguous or non-vector runtime paint.`, {
          entityId: entity.id,
        }),
      );
      continue;
    }
    mappedRuntimeIds.add(runtimeEntity.id);
    appearances[entity.id] = runtimeEntity.appearance;
    entityIds[entity.id] = runtimeEntity.id;
    paintOrder.push({ entityId: entity.id, sourceZIndex: runtimeEntity.sourceZIndex });
  }

  if ([...snapshotEntities.keys()].some((entityId) => !mappedRuntimeIds.has(entityId))) {
    issues.push(
      issue(
        "unknown-evidence",
        "The verified snapshot contains runtime entities that the Studio source identity map does not cover.",
      ),
    );
  }

  paintOrder.sort((left, right) => {
    const leftRuntime = snapshotEntities.get(entityIds[left.entityId]);
    const rightRuntime = snapshotEntities.get(entityIds[right.entityId]);
    return left.sourceZIndex - right.sourceZIndex || (leftRuntime?.sceneOrder ?? 0) - (rightRuntime?.sceneOrder ?? 0);
  });
  let nextZ = paintOrder.reduce((maximum, entry) => Math.max(maximum, entry.sourceZIndex), -1);
  for (const entity of created) {
    const style = entity.geometry?.style;
    if (
      !entity.provisional ||
      entity.transactionId === undefined ||
      entity.sourceIdentity.kind !== "unknown" ||
      (entity.type !== "Circle" && entity.type !== "Rectangle") ||
      style?.kind !== "known" ||
      Object.values(style.value).some((value) => value !== undefined)
    ) {
      issues.push(
        issue(
          "render-style-unresolved",
          `Studio-created entity ${entity.id} has no supported, known Manim vector style.`,
          { entityId: entity.id },
        ),
      );
      continue;
    }
    nextZ += 1;
    appearances[entity.id] = MANIM_DEFAULT_SHAPE_APPEARANCE;
    entityIds[entity.id] = entity.id;
    paintOrder.push({ entityId: entity.id, sourceZIndex: nextZ });
  }

  if (issues.length > 0) return { issues, kind: "unsupported" };
  return {
    evidence: {
      appearances,
      camera: input.snapshot.scene.camera,
      entityIds,
      fidelity: {
        evidence: ["Studio shape geometry reconstructed from server-correlated static/runtime evidence"],
        kind: "approximate",
      },
      paintOrder,
      provenance: [
        "server-verified imported snapshot and source/runtime identity",
        "known Studio Circle/Rectangle defaults",
      ],
    },
    kind: "resolved",
  };
}

function samePoint(left: Point, right: Point) {
  return left.x === right.x && left.y === right.y;
}

function sameDimensions(left: EntityDimensions, right: EntityDimensions) {
  return left.height === right.height && left.radius === right.radius && left.width === right.width;
}

function activeCriticalTimes(entity: RuntimeEntity, channel: PropertyChannel | undefined) {
  const times = new Set(entity.lifetime.map(({ start }) => start));
  for (const sample of channel?.samples ?? []) {
    if (entity.lifetime.some(({ end, start }) => sample.interval.start >= start && sample.interval.start < end)) {
      times.add(sample.interval.start);
    }
  }
  return [...times].sort((left, right) => left - right);
}

function resolveStaticKnowledge<T extends EntityDimensions | number | Point>(
  entity: RuntimeEntity,
  channel: PropertyChannel | undefined,
  fallback: Knowledge<T> | undefined,
  guard: (value: PropertyValue | undefined) => value is T,
  equals: (left: T, right: T) => boolean,
  key: "dimensions" | "position" | "scale",
  issues: StudioSceneIrAdapterIssueV1[],
) {
  if (channel?.samples.some(({ kind }) => kind === "animated")) {
    issues.push(
      issue("property-animation-unsupported", `Static Studio adapter cannot compile animated ${key}.`, {
        entityId: entity.id,
      }),
    );
    return undefined;
  }

  let resolved: T | undefined;
  for (const time of activeCriticalTimes(entity, channel)) {
    const sampled = samplePropertyValue(channel?.samples ?? [], time);
    if (sampled !== undefined && !guard(sampled)) {
      issues.push(
        issue("unknown-evidence", `Entity ${entity.id} has invalid ${key} evidence at ${time}.`, {
          entityId: entity.id,
        }),
      );
      return undefined;
    }
    const value = guard(sampled) ? sampled : fallback?.kind === "known" ? fallback.value : undefined;
    const knowledge =
      value !== undefined
        ? samplePropertyKnowledge(channel?.samples ?? [], time, value)
        : fallback?.kind === "unknown"
          ? fallback
          : undefined;
    if (value === undefined || knowledge?.kind !== "known") {
      const unknown = knowledge?.kind === "unknown" ? knowledge : fallback?.kind === "unknown" ? fallback : undefined;
      issues.push(
        issue("unknown-evidence", `Entity ${entity.id} has no known ${key} at ${time}.`, {
          entityId: entity.id,
          evidence: unknown?.evidence ?? (unknown ? [unknown.reason] : []),
        }),
      );
      return undefined;
    }
    if (resolved !== undefined && !equals(resolved, value)) {
      issues.push(
        issue("property-discontinuity-unsupported", `Entity ${entity.id} changes ${key} over its lifetime.`, {
          entityId: entity.id,
        }),
      );
      return undefined;
    }
    resolved = value;
  }
  return resolved;
}

function validatePresence(
  entity: RuntimeEntity,
  channel: PropertyChannel | undefined,
  issues: StudioSceneIrAdapterIssueV1[],
) {
  if (!channel) return;
  if (channel.samples.some(({ kind }) => kind === "animated")) {
    issues.push(
      issue("property-animation-unsupported", "Static Studio adapter cannot compile animated presence.", {
        entityId: entity.id,
      }),
    );
    return;
  }
  for (const time of activeCriticalTimes(entity, channel)) {
    if (samplePropertyValue(channel.samples, time) !== true) {
      issues.push(
        issue("property-discontinuity-unsupported", `Entity ${entity.id} is not present throughout its lifetimes.`, {
          entityId: entity.id,
        }),
      );
      return;
    }
  }
}

function channelFor(
  scene: StudioSceneIrAdapterInputV1["proposedState"]["evaluatedScene"],
  entityId: string,
  key: string,
) {
  return scene.propertyChannels[`${entityId}/${key}`];
}

export function studioPointToScenePointV1(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: EnginePointV1,
): EnginePointV1 {
  return {
    x: cameraCenter.x + (point.x / STUDIO_VIEWPORT.width - 0.5) * frame.width,
    y: cameraCenter.y + (0.5 - point.y / STUDIO_VIEWPORT.height) * frame.height,
  };
}

function validateGlobalEvidence(input: StudioSceneIrAdapterInputV1, issues: StudioSceneIrAdapterIssueV1[]) {
  const scene = input.proposedState.evaluatedScene;
  const entityIds = new Set(Object.keys(scene.objectGraph.entities));
  const orderedIds = new Set<string>();
  for (const entry of input.evidence.paintOrder) {
    if (!entityIds.has(entry.entityId) || orderedIds.has(entry.entityId) || !Number.isFinite(entry.sourceZIndex)) {
      issues.push(issue("ordering-evidence-invalid", "Paint order must contain each known entity once with finite z."));
    }
    orderedIds.add(entry.entityId);
  }
  for (const [recordId, entity] of Object.entries(scene.objectGraph.entities)) {
    if (recordId !== entity.id) {
      issues.push(
        issue("unknown-evidence", `Object graph key ${recordId} does not match entity identity ${entity.id}.`, {
          entityId: entity.id,
        }),
      );
    }
  }
  if (orderedIds.size !== entityIds.size || [...entityIds].some((id) => !orderedIds.has(id))) {
    issues.push(issue("ordering-evidence-invalid", "Paint order must cover the complete Scene."));
  }
  for (const id of Object.keys(input.evidence.appearances)) {
    if (!entityIds.has(id)) {
      issues.push(
        issue("render-style-unresolved", `Appearance evidence references unknown entity ${id}.`, { entityId: id }),
      );
    }
  }
  if (input.evidence.entityIds) {
    const outputIds = new Set<string>();
    for (const [entityId, outputId] of Object.entries(input.evidence.entityIds)) {
      if (!entityIds.has(entityId) || outputIds.has(outputId)) {
        issues.push(
          issue("unknown-evidence", "Runtime entity identity evidence must be complete and one-to-one.", {
            entityId,
          }),
        );
      }
      outputIds.add(outputId);
    }
    if (Object.keys(input.evidence.entityIds).length !== entityIds.size) {
      issues.push(issue("unknown-evidence", "Runtime entity identity evidence must cover the complete Scene."));
    }
  }
  if (
    !Number.isFinite(input.frame.width) ||
    !Number.isFinite(input.frame.height) ||
    input.frame.width <= 0 ||
    input.frame.height <= 0 ||
    input.evidence.camera.view.frameWidth !== input.frame.width ||
    input.evidence.camera.view.frameHeight !== input.frame.height ||
    Math.abs(input.frame.width / input.frame.height / (STUDIO_VIEWPORT.width / STUDIO_VIEWPORT.height) - 1) > 1e-9
  ) {
    issues.push(issue("camera-evidence-invalid", "Camera and Studio viewport frame evidence must match at 16:9."));
  }
  if (input.evidence.provenance.length === 0) {
    issues.push(issue("unknown-evidence", "Adapter provenance evidence cannot be empty."));
  }
  if (scene.constraintGraph.constraints.length > 0) {
    issues.push(issue("scene-constraint-unsupported", "Static Studio adapter cannot compile Scene constraints."));
  }
}

function validateProgramsAndChannels(input: StudioSceneIrAdapterInputV1, issues: StudioSceneIrAdapterIssueV1[]) {
  const entityIds = new Set(Object.keys(input.proposedState.evaluatedScene.objectGraph.entities));
  const validOperationIds = new Set<string>();
  for (const record of input.proposedState.programs) {
    if (record.validation.status !== "valid") {
      issues.push(issue("invalid-program", "ProposedState contains a program that did not validate."));
      continue;
    }
    for (const operation of record.program.operations) validOperationIds.add(operation.id);
  }
  for (const [recordId, channel] of Object.entries(input.proposedState.evaluatedScene.propertyChannels)) {
    if (recordId !== `${channel.entityId}/${channel.key}`) {
      issues.push(
        issue("unknown-evidence", `Property channel key ${recordId} does not match its entity and property.`, {
          entityId: channel.entityId,
        }),
      );
    }
    if (!entityIds.has(channel.entityId)) {
      issues.push(
        issue("unknown-evidence", `Property channel references unknown entity ${channel.entityId}.`, {
          entityId: channel.entityId,
        }),
      );
    }
    if (!STATIC_PROPERTY_KEYS.has(channel.key)) {
      issues.push(
        issue("property-unsupported", `Static Studio adapter cannot compile ${channel.key} channels.`, {
          entityId: channel.entityId,
        }),
      );
    }
    for (const sample of channel.samples) {
      if (sample.knowledge?.kind === "unknown") {
        issues.push(
          issue("unknown-evidence", `Property channel ${recordId} contains unresolved evidence.`, {
            entityId: channel.entityId,
            evidence: sample.knowledge.evidence ?? [sample.knowledge.reason],
            operationId: sample.operationId,
          }),
        );
      }
      if (sample.operationId && !validOperationIds.has(sample.operationId)) {
        issues.push(
          issue("program-state-mismatch", "A property sample references no valid evaluated operation.", {
            entityId: channel.entityId,
            operationId: sample.operationId,
          }),
        );
      }
    }
  }
}

function compileEntities(input: StudioSceneIrAdapterInputV1, issues: StudioSceneIrAdapterIssueV1[]) {
  const scene = input.proposedState.evaluatedScene;
  return input.evidence.paintOrder.flatMap((order, sceneOrder) => {
    const entity = scene.objectGraph.entities[order.entityId];
    if (!entity) return [];
    if (entity.type !== "Circle" && entity.type !== "Rectangle") {
      issues.push(
        issue("geometry-unsupported", `Static Studio adapter does not have geometry for ${entity.type}.`, {
          entityId: entity.id,
        }),
      );
      return [];
    }
    if (entity.lifetime.length === 0) {
      issues.push(issue("unknown-evidence", `Entity ${entity.id} has no lifetime evidence.`, { entityId: entity.id }));
      return [];
    }
    const appearance = input.evidence.appearances[entity.id];
    if (!appearance) {
      issues.push(
        issue("render-style-unresolved", `Entity ${entity.id} has no resolved appearance.`, { entityId: entity.id }),
      );
      return [];
    }
    for (const channel of Object.values(scene.propertyChannels).filter(({ entityId }) => entityId === entity.id)) {
      if (!STATIC_PROPERTY_KEYS.has(channel.key)) return [];
    }

    const dimensions = resolveStaticKnowledge(
      entity,
      channelFor(scene, entity.id, "dimensions"),
      entity.geometry?.dimensions,
      isEntityDimensionsValue,
      sameDimensions,
      "dimensions",
      issues,
    );
    const position = resolveStaticKnowledge(
      entity,
      channelFor(scene, entity.id, "position"),
      entity.geometry?.position,
      isPointValue,
      samePoint,
      "position",
      issues,
    );
    const scale = resolveStaticKnowledge(
      entity,
      channelFor(scene, entity.id, "scale"),
      entity.geometry?.scale,
      (value): value is number => typeof value === "number" && Number.isFinite(value),
      (left, right) => left === right,
      "scale",
      issues,
    );
    validatePresence(entity, channelFor(scene, entity.id, "presence"), issues);
    if (!dimensions || !position || scale === undefined) return [];

    const geometry =
      entity.type === "Circle" && dimensions.radius !== undefined
        ? { center: { x: 0, y: 0 }, kind: "circle" as const, radius: dimensions.radius }
        : entity.type === "Rectangle" && dimensions.height !== undefined && dimensions.width !== undefined
          ? {
              center: { x: 0, y: 0 },
              cornerRadius: 0,
              height: dimensions.height,
              kind: "rectangle" as const,
              width: dimensions.width,
            }
          : undefined;
    if (!geometry || scale <= 0) {
      issues.push(
        issue("unknown-evidence", `Entity ${entity.id} has invalid shape dimensions or scale.`, {
          entityId: entity.id,
        }),
      );
      return [];
    }
    const translation = studioPointToScenePointV1(position, input.frame, input.evidence.camera.view.center);
    return [
      {
        appearance,
        geometry,
        id: input.evidence.entityIds?.[entity.id] ?? entity.id,
        lifetimes: entity.lifetime,
        parentId: null,
        provenanceId: "studio-adapter",
        sceneOrder,
        sourceZIndex: order.sourceZIndex,
        transform: { m11: scale, m12: 0, m21: 0, m22: scale, tx: translation.x, ty: translation.y },
      },
    ];
  });
}

function normalizedOpacity(value: PropertyValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function appearanceSampleIsCompatible(
  sample: PropertyChannelSample,
  animated: PropertyChannelSample,
  issues: StudioSceneIrAdapterIssueV1[],
  entityId: string,
) {
  if (sample.kind !== "exact" || !normalizedOpacity(sample.value)) {
    issues.push(
      issue("property-animation-unsupported", `Entity ${entityId} has non-numeric opacity evidence.`, {
        entityId,
      }),
    );
    return false;
  }
  const expected = sample.interval.end <= animated.interval.start ? animated.from : animated.value;
  if (
    !normalizedOpacity(expected) ||
    (sample.interval.start < animated.interval.end && sample.interval.end > animated.interval.start) ||
    sample.value !== expected
  ) {
    issues.push(
      issue("property-discontinuity-unsupported", `Entity ${entityId} has unsupported opacity continuity.`, {
        entityId,
      }),
    );
    return false;
  }
  return true;
}

function compileOpacityChannels(input: StudioSceneIrAdapterInputV1, issues: StudioSceneIrAdapterIssueV1[]) {
  const scene = input.proposedState.evaluatedScene;
  return input.evidence.paintOrder.flatMap((order, sceneOrder) => {
    const entity = scene.objectGraph.entities[order.entityId];
    const channel = channelFor(scene, order.entityId, "appearance");
    if (!entity || !channel || channel.samples.length === 0) return [];
    const animated = channel.samples.filter((sample) => sample.kind === "animated");
    if (!entity.provisional || entity.transactionId === undefined || animated.length !== 1) {
      issues.push(
        issue("property-animation-unsupported", "Only one Studio-created shape opacity transition is supported.", {
          entityId: order.entityId,
        }),
      );
      return [];
    }
    const transition = animated[0];
    const lifetime = entity.lifetime.length === 1 ? entity.lifetime[0] : undefined;
    if (
      !transition ||
      !lifetime ||
      !normalizedOpacity(transition.from) ||
      !normalizedOpacity(transition.value) ||
      transition.from !== 0 ||
      transition.value !== 1 ||
      (transition.easing !== "linear" && transition.easing !== "smooth") ||
      transition.interval.end <= transition.interval.start ||
      transition.interval.start !== lifetime.start ||
      transition.interval.end > lifetime.end
    ) {
      issues.push(
        issue("property-animation-unsupported", "Studio opacity transition evidence is incomplete.", {
          entityId: order.entityId,
        }),
      );
      return [];
    }
    const exactSamples = channel.samples.filter((sample) => sample !== transition);
    if (exactSamples.some((sample) => !appearanceSampleIsCompatible(sample, transition, issues, order.entityId))) {
      return [];
    }
    if (
      transition.interval.end < lifetime.end &&
      !exactSamples.some(
        (sample) => sample.interval.start === transition.interval.end && sample.interval.end >= lifetime.end,
      )
    ) {
      issues.push(
        issue("property-discontinuity-unsupported", "Studio fade-in evidence does not cover the object lifetime.", {
          entityId: order.entityId,
        }),
      );
      return [];
    }
    return [
      {
        entityId: input.evidence.entityIds?.[order.entityId] ?? order.entityId,
        id: `studio-opacity-${sceneOrder}`,
        keyframes: [
          {
            at: transition.interval.start,
            easingToNext: { kind: transition.easing },
            value: transition.from,
          },
          { at: transition.interval.end, easingToNext: null, value: transition.value },
        ],
        kind: "opacity" as const,
        provenanceId: "studio-adapter",
      },
    ];
  });
}

export async function compileStudioSceneIrV1(
  input: StudioSceneIrAdapterInputV1,
): Promise<StudioSceneIrAdapterResultV1> {
  const issues: StudioSceneIrAdapterIssueV1[] = [];
  let stableInput: StudioSceneIrAdapterInputV1;
  try {
    stableInput = structuredClone(input);
  } catch (error) {
    return {
      issues: [issue("unknown-evidence", error instanceof Error ? error.message : String(error))],
      kind: "unsupported",
    };
  }
  let assets: AssetManifestV1;
  try {
    assets = await parseVerifiedAssetManifestV1(stableInput.assets);
  } catch (error) {
    return {
      issues: [issue("asset-evidence-invalid", error instanceof Error ? error.message : String(error))],
      kind: "unsupported",
    };
  }

  validateGlobalEvidence(stableInput, issues);
  validateProgramsAndChannels(stableInput, issues);
  const entities = compileEntities(stableInput, issues);
  const animationChannels = compileOpacityChannels(stableInput, issues);
  if (issues.length > 0) return { issues, kind: "unsupported" };

  const candidate = {
    animationChannels,
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: stableInput.evidence.camera,
    coordinateSpace: {
      cpuPrecision: "f64",
      kind: "cartesian-2d",
      origin: "center",
      unit: "scene-unit",
      xAxis: "right",
      yAxis: "up",
    },
    duration: stableInput.proposedState.evaluatedScene.duration,
    entities,
    fidelity: stableInput.evidence.fidelity ?? { kind: "exact" },
    provenance: [
      {
        evidence: [...stableInput.evidence.provenance],
        id: "studio-adapter",
        origin: "studio-edit-program",
      },
    ],
    requiredCapabilities: [
      ...(animationChannels.length > 0 ? (["opacity-animation"] as const) : []),
      ...(entities.length > 0 ? (["shape-primitives"] as const) : []),
    ],
    sceneId: stableInput.proposedState.evaluatedScene.sceneId,
    schema: "poietra.scene-ir",
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: stableInput.sourceRevisionHash },
    version: 1,
  };
  const result = sceneIrV1Schema.safeParse(candidate);
  if (!result.success) {
    return {
      issues: result.error.issues.map((entry) =>
        issue("output-invalid", entry.message, { evidence: [entry.path.join(".")] }),
      ),
      kind: "unsupported",
    };
  }
  return { kind: "compiled", scene: result.data };
}
