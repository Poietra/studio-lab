import { z } from "zod";

import { assetManifestV1Schema } from "./asset-manifest";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import { finiteNumberV1Schema, sha256V1Schema, sourceIdentityV1Schema } from "./primitives";
import {
  animationChannelV1Schema,
  fidelityV1Schema,
  provenanceRecordV1Schema,
  sceneCameraV1Schema,
  sceneCapabilityV1Schema,
  sceneEntityV1Schema,
  sceneIrSourceRevisionHash,
  sceneSourceV1Schema,
} from "./scene-ir";

export const POIETRA_SCENE_DELTA_VERSION = 1 as const;
export const MAX_SCENE_DELTA_OPERATIONS = 256;
export const MAX_SCENE_DELTA_JSON_BYTES = 256 * 1024;

const MAX_SCENE_PROVENANCE_RECORDS = 20_000;

const updateSceneOperationV1Schema = z
  .object({
    assets: assetManifestV1Schema.optional(),
    camera: sceneCameraV1Schema.optional(),
    duration: finiteNumberV1Schema.positive().optional(),
    fidelity: fidelityV1Schema.optional(),
    kind: z.literal("update-scene"),
    provenance: z.array(provenanceRecordV1Schema).min(1).max(MAX_SCENE_PROVENANCE_RECORDS).optional(),
    requiredCapabilities: z.array(sceneCapabilityV1Schema).max(sceneCapabilityV1Schema.options.length).optional(),
  })
  .strict()
  .refine(
    (operation) =>
      operation.assets !== undefined ||
      operation.camera !== undefined ||
      operation.duration !== undefined ||
      operation.fidelity !== undefined ||
      operation.provenance !== undefined ||
      operation.requiredCapabilities !== undefined,
    { message: "update-scene requires at least one changed field." },
  );

export const sceneDeltaOperationV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      entity: sceneEntityV1Schema,
      expected: z.enum(["absent", "present"]),
      kind: z.literal("put-entity"),
    })
    .strict(),
  z.object({ entityId: sourceIdentityV1Schema, kind: z.literal("remove-entity") }).strict(),
  z
    .object({
      channel: animationChannelV1Schema,
      expected: z.enum(["absent", "present"]),
      kind: z.literal("put-animation-channel"),
    })
    .strict(),
  z.object({ channelId: sourceIdentityV1Schema, kind: z.literal("remove-animation-channel") }).strict(),
  updateSceneOperationV1Schema,
]);

export const sceneIrDeltaV1Schema = z
  .object({
    baseRevision: sha256V1Schema,
    nextRevision: sha256V1Schema,
    nextSource: sceneSourceV1Schema,
    operations: z.array(sceneDeltaOperationV1Schema).min(1).max(MAX_SCENE_DELTA_OPERATIONS),
    sceneId: sourceIdentityV1Schema,
    schema: z.literal("poietra.scene-delta"),
    version: z.literal(POIETRA_SCENE_DELTA_VERSION),
  })
  .strict()
  .refine((delta) => delta.baseRevision !== delta.nextRevision, {
    message: "A Scene delta must advance the revision.",
    path: ["nextRevision"],
  })
  .superRefine((delta, context) => {
    const targets = new Set<string>();
    delta.operations.forEach((operation, index) => {
      const target =
        operation.kind === "put-entity"
          ? `entity:${operation.entity.id}`
          : operation.kind === "remove-entity"
            ? `entity:${operation.entityId}`
            : operation.kind === "put-animation-channel"
              ? `channel:${operation.channel.id}`
              : operation.kind === "remove-animation-channel"
                ? `channel:${operation.channelId}`
                : "scene:metadata";
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          message: `A Scene delta may target ${target} only once.`,
          path: ["operations", index],
        });
      }
      targets.add(target);
    });
  });

export type SceneIrDeltaV1 = z.infer<typeof sceneIrDeltaV1Schema>;
export type SceneDeltaOperationV1 = z.infer<typeof sceneDeltaOperationV1Schema>;

function sameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function byId<T extends Readonly<{ id: string }>>(values: readonly T[]) {
  return new Map(values.map((value) => [value.id, value]));
}

function deltaOperationsPreserveOrder<T extends Readonly<{ id: string }>>(base: readonly T[], next: readonly T[]) {
  const baseIds = new Set(base.map(({ id }) => id));
  const nextIds = new Set(next.map(({ id }) => id));
  const appliedIds = [
    ...base.filter(({ id }) => nextIds.has(id)).map(({ id }) => id),
    ...next
      .filter(({ id }) => !baseIds.has(id))
      .map(({ id }) => id)
      .sort(),
  ];
  return sameJsonValue(
    appliedIds,
    next.map(({ id }) => id),
  );
}

/**
 * Produces the bounded v1 transport delta between two complete, verified
 * Studio-owned bundles. `null` deliberately means "use the complete next
 * snapshot": it covers source-only/no-op revisions, unsupported structural
 * changes, operation/byte overflow, and ordering the operation vocabulary
 * cannot preserve.
 *
 * Operations are ordered by kind and stable source identity rather than input
 * iteration order. Existing records keep their slots and additions append in
 * sorted order, so the producer checks that exact resulting ID order before
 * sending the delta. The retained Rust EngineSession is the sole applier and
 * verifies the complete result atomically.
 */
export async function createSceneIrDeltaV1(
  baseValue: SceneIrBundleV1,
  nextValue: SceneIrBundleV1,
): Promise<SceneIrDeltaV1 | null> {
  let base: SceneIrBundleV1;
  let next: SceneIrBundleV1;
  try {
    [base, next] = await Promise.all([
      parseVerifiedSceneIrBundleV1(baseValue),
      parseVerifiedSceneIrBundleV1(nextValue),
    ]);
  } catch {
    return null;
  }

  const baseRevision = sceneIrSourceRevisionHash(base.scene);
  const nextRevision = sceneIrSourceRevisionHash(next.scene);
  if (
    base.scene.sceneId !== next.scene.sceneId ||
    baseRevision === nextRevision ||
    base.scene.source.kind !== "studio-edit-program" ||
    next.scene.source.kind !== "studio-edit-program" ||
    !sameJsonValue(base.assets, next.assets) ||
    !sameJsonValue(base.scene.coordinateSpace, next.scene.coordinateSpace) ||
    base.scene.schema !== next.scene.schema ||
    base.scene.version !== next.scene.version
  ) {
    return null;
  }

  const operations: SceneDeltaOperationV1[] = [];
  const baseEntities = byId(base.scene.entities);
  const nextEntities = byId(next.scene.entities);
  const baseChannels = byId(base.scene.animationChannels);
  const nextChannels = byId(next.scene.animationChannels);
  if (
    !deltaOperationsPreserveOrder(base.scene.entities, next.scene.entities) ||
    !deltaOperationsPreserveOrder(base.scene.animationChannels, next.scene.animationChannels)
  ) {
    return null;
  }

  for (const channelId of [...baseChannels.keys()].filter((id) => !nextChannels.has(id)).sort()) {
    operations.push({ channelId, kind: "remove-animation-channel" });
  }
  for (const entityId of [...baseEntities.keys()].filter((id) => !nextEntities.has(id)).sort()) {
    operations.push({ entityId, kind: "remove-entity" });
  }
  for (const entityId of [...nextEntities.keys()].sort()) {
    const entity = nextEntities.get(entityId)!;
    const previous = baseEntities.get(entityId);
    if (!previous || !sameJsonValue(previous, entity)) {
      operations.push({ entity, expected: previous ? "present" : "absent", kind: "put-entity" });
    }
  }
  for (const channelId of [...nextChannels.keys()].sort()) {
    const channel = nextChannels.get(channelId)!;
    const previous = baseChannels.get(channelId);
    if (!previous || !sameJsonValue(previous, channel)) {
      operations.push({ channel, expected: previous ? "present" : "absent", kind: "put-animation-channel" });
    }
  }

  const metadata: Omit<Extract<SceneDeltaOperationV1, Readonly<{ kind: "update-scene" }>>, "kind"> = {};
  if (!sameJsonValue(base.scene.camera, next.scene.camera)) metadata.camera = next.scene.camera;
  if (base.scene.duration !== next.scene.duration) metadata.duration = next.scene.duration;
  if (!sameJsonValue(base.scene.fidelity, next.scene.fidelity)) metadata.fidelity = next.scene.fidelity;
  if (!sameJsonValue(base.scene.provenance, next.scene.provenance)) metadata.provenance = next.scene.provenance;
  if (!sameJsonValue(base.scene.requiredCapabilities, next.scene.requiredCapabilities)) {
    metadata.requiredCapabilities = next.scene.requiredCapabilities;
  }
  if (Object.keys(metadata).length > 0) operations.push({ kind: "update-scene", ...metadata });
  if (operations.length === 0 || operations.length > MAX_SCENE_DELTA_OPERATIONS) return null;

  const candidate = {
    baseRevision,
    nextRevision,
    nextSource: next.scene.source,
    operations,
    sceneId: next.scene.sceneId,
    schema: "poietra.scene-delta",
    version: POIETRA_SCENE_DELTA_VERSION,
  } as const;
  try {
    return parseSceneIrDeltaV1(candidate);
  } catch {
    return null;
  }
}

export type SceneIrDeltaErrorCodeV1 = "delta-too-large" | "invalid-delta";

export class SceneIrDeltaError extends Error {
  readonly code: SceneIrDeltaErrorCodeV1;
  readonly fallback = "full-snapshot" as const;
  readonly requiresFullSnapshotFallback = true;

  constructor(code: SceneIrDeltaErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SceneIrDeltaError";
  }
}

function deltaError(code: SceneIrDeltaErrorCodeV1, message: string, cause?: unknown) {
  return new SceneIrDeltaError(code, message, cause === undefined ? undefined : { cause });
}

function encodeJson(value: unknown) {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw deltaError("invalid-delta", "The Scene delta is not JSON-serializable.", cause);
  }
  if (json === undefined) throw deltaError("invalid-delta", "The Scene delta is not a JSON value.");
  return json;
}

export function parseSceneIrDeltaV1(value: unknown) {
  const json = encodeJson(value);
  if (new TextEncoder().encode(json).byteLength > MAX_SCENE_DELTA_JSON_BYTES) {
    throw deltaError("delta-too-large", `Scene deltas accept at most ${MAX_SCENE_DELTA_JSON_BYTES} encoded bytes.`);
  }
  const parsed = sceneIrDeltaV1Schema.safeParse(JSON.parse(json) as unknown);
  if (!parsed.success) {
    throw deltaError("invalid-delta", "The Scene delta does not match the v1 contract.", parsed.error);
  }
  return parsed.data;
}
