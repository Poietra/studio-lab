import { z } from "zod";

import { type AssetManifestV1, assetManifestV1Schema } from "./asset-manifest";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import { finiteNumberV1Schema, sha256V1Schema, sourceIdentityV1Schema } from "./primitives";
import {
  animationChannelV1Schema,
  fidelityV1Schema,
  provenanceRecordV1Schema,
  type SceneIrV1,
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

/**
 * Produces the bounded v1 transport delta between two complete, verified
 * Studio-owned bundles. `null` deliberately means "use the complete next
 * snapshot": it covers source-only/no-op revisions, unsupported structural
 * changes, operation/byte overflow, and any candidate whose exact application
 * would not reproduce the requested bundle.
 *
 * Operations are ordered by kind and stable source identity rather than input
 * iteration order. The final apply-and-compare guard is important because the
 * v1 operation vocabulary cannot express arbitrary entity/channel array
 * reordering; those revisions must use the existing full replacement path.
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
  let delta: SceneIrDeltaV1;
  try {
    delta = parseSceneIrDeltaV1(candidate);
    const applied = await applySceneIrDeltaV1(base, delta);
    if (!sameJsonValue(applied, next)) return null;
  } catch {
    return null;
  }
  return delta;
}

export type SceneIrDeltaErrorCodeV1 =
  | "base-invalid"
  | "delta-too-large"
  | "invalid-delta"
  | "next-revision-mismatch"
  | "operation-conflict"
  | "result-invalid"
  | "scene-mismatch"
  | "source-unsupported"
  | "stale-base-revision";

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

function operationConflict(message: string): never {
  throw deltaError("operation-conflict", message);
}

function putById<T extends Readonly<{ id: string }>>(
  values: readonly T[],
  value: T,
  expected: "absent" | "present",
  label: string,
) {
  const index = values.findIndex(({ id }) => id === value.id);
  if (expected === "absent") {
    if (index !== -1) operationConflict(`${label} ${value.id} already exists.`);
    return [...values, value];
  }
  if (index === -1) operationConflict(`${label} ${value.id} does not exist.`);
  return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

function removeById<T extends Readonly<{ id: string }>>(values: readonly T[], id: string, label: string) {
  const index = values.findIndex((value) => value.id === id);
  if (index === -1) operationConflict(`${label} ${id} does not exist.`);
  return values.filter((_, currentIndex) => currentIndex !== index);
}

function applyOperation(
  bundle: Readonly<{ assets: AssetManifestV1; scene: SceneIrV1 }>,
  operation: SceneDeltaOperationV1,
): SceneIrBundleV1 {
  if (operation.kind === "put-entity") {
    return {
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: putById(bundle.scene.entities, operation.entity, operation.expected, "Entity"),
      },
    };
  }
  if (operation.kind === "remove-entity") {
    return {
      ...bundle,
      scene: { ...bundle.scene, entities: removeById(bundle.scene.entities, operation.entityId, "Entity") },
    };
  }
  if (operation.kind === "put-animation-channel") {
    return {
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: putById(
          bundle.scene.animationChannels,
          operation.channel,
          operation.expected,
          "Animation channel",
        ),
      },
    };
  }
  if (operation.kind === "remove-animation-channel") {
    return {
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: removeById(bundle.scene.animationChannels, operation.channelId, "Animation channel"),
      },
    };
  }

  const assets = operation.assets ?? bundle.assets;
  return {
    assets,
    scene: {
      ...bundle.scene,
      ...(operation.camera === undefined ? {} : { camera: operation.camera }),
      ...(operation.duration === undefined ? {} : { duration: operation.duration }),
      ...(operation.fidelity === undefined ? {} : { fidelity: operation.fidelity }),
      ...(operation.provenance === undefined ? {} : { provenance: operation.provenance }),
      ...(operation.requiredCapabilities === undefined ? {} : { requiredCapabilities: operation.requiredCapabilities }),
      ...(operation.assets === undefined
        ? {}
        : {
            assetManifest: {
              manifestDigest: operation.assets.manifestDigest,
              manifestId: operation.assets.manifestId,
            },
          }),
    },
  };
}

export async function applySceneIrDeltaV1(currentValue: unknown, deltaValue: unknown) {
  const delta = parseSceneIrDeltaV1(deltaValue);
  let current: SceneIrBundleV1;
  try {
    current = await parseVerifiedSceneIrBundleV1(currentValue);
  } catch (cause) {
    throw deltaError("base-invalid", "The installed Scene snapshot is invalid.", cause);
  }

  if (current.scene.sceneId !== delta.sceneId) {
    throw deltaError("scene-mismatch", "The Scene delta targets a different Scene ID.");
  }
  if (sceneIrSourceRevisionHash(current.scene) !== delta.baseRevision) {
    throw deltaError("stale-base-revision", "The Scene delta base revision is not installed.");
  }
  if (current.scene.source.kind !== "studio-edit-program" || delta.nextSource.kind !== "studio-edit-program") {
    throw deltaError(
      "source-unsupported",
      "Scene delta v1 accepts Studio Edit Program revisions only; imported snapshots require full replacement.",
    );
  }
  if (sceneIrSourceRevisionHash({ ...current.scene, source: delta.nextSource }) !== delta.nextRevision) {
    throw deltaError("next-revision-mismatch", "The Scene delta next revision does not match its source evidence.");
  }

  let candidate: SceneIrBundleV1 = current;
  for (const operation of delta.operations) candidate = applyOperation(candidate, operation);
  candidate = { ...candidate, scene: { ...candidate.scene, source: delta.nextSource } };

  try {
    return await parseVerifiedSceneIrBundleV1(candidate);
  } catch (cause) {
    throw deltaError("result-invalid", "The Scene delta result failed whole-bundle verification.", cause);
  }
}
