import type { AssetManifestV1 } from "./asset-manifest";
import { type EngineFrameV1, parseVerifiedEngineFrameV1, parseVerifiedSceneIrBundleV1 } from "./contracts";
import { applyEngineEasingV1, type EngineEasingV1 } from "./easing";
import {
  applyManimMotionPathV1,
  applyMotionPathV1,
  composeAffineTransformsV1,
  interpolateAffineTransformV1,
  interpolateCubicPathV1,
  sceneGeometryAsCubicPathV1,
  trimCubicPathUniformParameterV1,
  trimCubicPathV1,
} from "./geometry";
import { type CubicPathV1, type EngineAffineTransformV1, isSingularAffineTransform } from "./primitives";
import { type SceneIrV1, sceneIrSourceRevisionHash } from "./scene-ir";

type KeyframeV1<T> = Readonly<{
  at: number;
  easingToNext: EngineEasingV1 | null;
  value: T;
}>;

type SampledValue<T> = Readonly<{ active: boolean; value: T }>;

function sampleKeyframes<T>(
  base: T,
  keyframes: readonly KeyframeV1<T>[],
  time: number,
  interpolate: (left: T, right: T, progress: number) => T,
): SampledValue<T> {
  if (time < keyframes[0].at) return { active: false, value: base };
  const final = keyframes.at(-1)!;
  if (time >= final.at) return { active: true, value: final.value };

  let lower = 0;
  let upper = keyframes.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (keyframes[middle].at <= time) lower = middle + 1;
    else upper = middle;
  }
  const left = keyframes[lower - 1];
  const right = keyframes[lower];
  if (!left?.easingToNext || !right) throw new Error("A sampled keyframe segment is missing easingToNext.");
  const progress = (time - left.at) / (right.at - left.at);
  return {
    active: true,
    value: interpolate(left.value, right.value, applyEngineEasingV1(left.easingToNext, progress)),
  };
}

function interpolateNumber(left: number, right: number, progress: number) {
  return left + (right - left) * progress;
}

function interpolateCameraView(
  left: SceneIrV1["camera"]["view"],
  right: SceneIrV1["camera"]["view"],
  progress: number,
): SceneIrV1["camera"]["view"] {
  return {
    center: {
      x: interpolateNumber(left.center.x, right.center.x, progress),
      y: interpolateNumber(left.center.y, right.center.y, progress),
    },
    frameHeight: interpolateNumber(left.frameHeight, right.frameHeight, progress),
    frameWidth: interpolateNumber(left.frameWidth, right.frameWidth, progress),
  };
}

type AnimationChannelV1 = SceneIrV1["animationChannels"][number];
type EntityAnimationChannelV1 = Exclude<AnimationChannelV1, { kind: "camera" }>;
type EntityChannelKindV1 = EntityAnimationChannelV1["kind"];

function entityChannelKey(entityId: string, kind: EntityChannelKindV1) {
  return `${entityId}\u0000${kind}`;
}

function indexEntityChannels(scene: SceneIrV1) {
  const channels = new Map<string, EntityAnimationChannelV1>();
  for (const channel of scene.animationChannels) {
    if (channel.kind !== "camera") channels.set(entityChannelKey(channel.entityId, channel.kind), channel);
  }
  return channels;
}

function entityChannel<K extends EntityChannelKindV1>(
  channels: ReadonlyMap<string, EntityAnimationChannelV1>,
  entityId: string,
  kind: K,
) {
  return channels.get(entityChannelKey(entityId, kind)) as Extract<EntityAnimationChannelV1, { kind: K }> | undefined;
}

type SampledLocalEntity = Readonly<{
  emptyReason?: "path-trim-zero" | "singular-affine-sample";
  entity: SceneIrV1["entities"][number];
  opacity: number;
  path?: CubicPathV1;
  transform: EngineAffineTransformV1;
}>;

function sampleLocalEntity(
  channels: ReadonlyMap<string, EntityAnimationChannelV1>,
  entity: SceneIrV1["entities"][number],
  time: number,
): SampledLocalEntity {
  const opacityChannel = entityChannel(channels, entity.id, "opacity");
  const opacity = opacityChannel
    ? sampleKeyframes(entity.appearance.opacity, opacityChannel.keyframes, time, interpolateNumber).value
    : entity.appearance.opacity;

  const transformChannel = entityChannel(channels, entity.id, "affine-transform");
  const transformSample = transformChannel
    ? sampleKeyframes(entity.transform, transformChannel.keyframes, time, interpolateAffineTransformV1)
    : undefined;
  let transform = transformSample?.value ?? entity.transform;
  // V1 evidence is direct-channel only and is sampled before motion/world
  // composition. Ancestor/motion-induced singularity remains fail-closed.
  //
  // "Singular" is the renderer's threshold, not an exact zero: the production
  // snapshot profile seals every finite, bounded, non-zero matrix, so a sample
  // such as `stretch(1e-50, 1)` reaches f32 preparation and collapses there,
  // failing the complete frame. Lowering it to this draw-local empty reason
  // keeps sibling draws visible instead.
  const singularAffineSample = transformSample?.active === true && isSingularAffineTransform(transform);
  const motionPathChannel = entityChannel(channels, entity.id, "motion-path");
  if (motionPathChannel) {
    const motion = sampleKeyframes(0, motionPathChannel.keyframes, time, interpolateNumber);
    if (motion.active) {
      transform =
        motionPathChannel.parameterization === "manim-point-from-proportion-v1"
          ? applyManimMotionPathV1(transform, motionPathChannel.path, motion.value)
          : applyMotionPathV1(transform, motionPathChannel.path, motion.value, motionPathChannel.orientToPath);
    }
  }

  if (entity.geometry.kind === "image") return { entity, opacity, transform };
  let emptyReason: SampledLocalEntity["emptyReason"] = singularAffineSample ? "singular-affine-sample" : undefined;
  let path = sceneGeometryAsCubicPathV1(entity.geometry);
  const pathMorphChannel = entityChannel(channels, entity.id, "path-morph");
  if (pathMorphChannel) {
    path = sampleKeyframes(path, pathMorphChannel.keyframes, time, interpolateCubicPathV1).value;
  }
  const pathTrimChannel = entityChannel(channels, entity.id, "path-trim");
  if (pathTrimChannel) {
    const trim = sampleKeyframes(1, pathTrimChannel.keyframes, time, interpolateNumber).value;
    if (trim === 0) {
      emptyReason = "path-trim-zero";
    } else {
      path =
        pathTrimChannel.parameterization === "uniform-cubic-parameter-v1"
          ? trimCubicPathUniformParameterV1(path, trim)
          : trimCubicPathV1(path, trim);
    }
  }
  return { emptyReason, entity, opacity, path, transform };
}

type WorldSample = Readonly<{ opacity: number; transform: EngineAffineTransformV1 }>;

function worldSamples(
  scene: SceneIrV1,
  active: readonly SceneIrV1["entities"][number][],
  local: ReadonlyMap<string, SampledLocalEntity>,
) {
  const output = new Map<string, WorldSample>();
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  for (const entity of active) {
    if (output.has(entity.id)) continue;
    const chain: SceneIrV1["entities"][number][] = [];
    let current: SceneIrV1["entities"][number] | undefined = entity;
    while (current && !output.has(current.id)) {
      chain.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    let parentSample = current ? output.get(current.id) : undefined;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const member = chain[index];
      const localSample = local.get(member.id)!;
      const sample = {
        opacity: (parentSample?.opacity ?? 1) * localSample.opacity,
        transform: parentSample
          ? composeAffineTransformsV1(parentSample.transform, localSample.transform)
          : localSample.transform,
      };
      output.set(member.id, sample);
      parentSample = sample;
    }
  }
  return output;
}

function sampleCamera(scene: SceneIrV1, time: number) {
  const channel = scene.animationChannels.find((candidate) => candidate.kind === "camera");
  return channel
    ? sampleKeyframes(scene.camera.view, channel.keyframes, time, interpolateCameraView).value
    : scene.camera.view;
}

function renderCapabilities(
  draws: readonly Readonly<{ fill?: unknown; kind: "empty" | "image" | "path"; stroke?: unknown }>[],
) {
  const capabilities = new Set<"cubic-path-fill" | "cubic-path-stroke" | "png-image">();
  for (const draw of draws) {
    if (draw.kind === "image") capabilities.add("png-image");
    if (draw.kind === "path" && draw.fill !== null) capabilities.add("cubic-path-fill");
    if (draw.kind === "path" && draw.stroke !== null) capabilities.add("cubic-path-stroke");
  }
  return [...capabilities].sort();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type CompileEngineFrameV1Options = Readonly<{
  assets: AssetManifestV1;
  evidence?: readonly string[];
  packetId: string;
  sampleTime: number;
  scene: SceneIrV1;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

export type CompileEngineFrameV1Result =
  | Readonly<{ code: "invalid-input" | "invalid-output"; kind: "error"; message: string }>
  | Readonly<{ frame: EngineFrameV1; kind: "ready" }>;

export async function compileEngineFrameV1(options: CompileEngineFrameV1Options): Promise<CompileEngineFrameV1Result> {
  const evidence = [...(options.evidence ?? ["Poietra reference evaluator v1"])];
  const packetId = options.packetId;
  const sampleTime = options.sampleTime;
  const viewport = { heightPx: options.viewport.heightPx, widthPx: options.viewport.widthPx };
  let verified: Awaited<ReturnType<typeof parseVerifiedSceneIrBundleV1>>;
  try {
    verified = await parseVerifiedSceneIrBundleV1({ assets: options.assets, scene: options.scene });
  } catch (error) {
    return { code: "invalid-input", kind: "error", message: errorMessage(error) };
  }

  if (!Number.isFinite(sampleTime) || sampleTime < 0 || sampleTime > verified.scene.duration) {
    return { code: "invalid-input", kind: "error", message: "sampleTime must be finite and inside Scene duration" };
  }

  try {
    const { assets, scene } = verified;
    const channels = indexEntityChannels(scene);
    const active = scene.entities
      .filter((entity) =>
        entity.lifetimes.some((lifetime) => sampleTime >= lifetime.start && sampleTime < lifetime.end),
      )
      .sort((left, right) => left.sourceZIndex - right.sourceZIndex || left.sceneOrder - right.sceneOrder);
    const local = new Map(active.map((entity) => [entity.id, sampleLocalEntity(channels, entity, sampleTime)]));
    const world = worldSamples(scene, active, local);

    const draws = active.map((entity, paintOrder) => {
      const localSample = local.get(entity.id)!;
      const worldSample = world.get(entity.id)!;
      if (localSample.emptyReason) {
        return {
          drawId: `draw:${entity.sceneOrder}`,
          entityId: entity.id,
          kind: "empty" as const,
          opacity: worldSample.opacity,
          paintOrder,
          reason: localSample.emptyReason,
          sourceZIndex: entity.sourceZIndex,
          transform: worldSample.transform,
        };
      }
      if (entity.geometry.kind === "image") {
        return {
          asset: entity.geometry.asset,
          drawId: `draw:${entity.sceneOrder}`,
          entityId: entity.id,
          kind: "image" as const,
          localRect: entity.geometry.localRect,
          opacity: worldSample.opacity,
          paintOrder,
          sampler: entity.geometry.sampler,
          sourceZIndex: entity.sourceZIndex,
          transform: worldSample.transform,
        };
      }
      return {
        drawId: `draw:${entity.sceneOrder}`,
        entityId: entity.id,
        fill: entity.appearance.kind === "vector" ? entity.appearance.fill : null,
        kind: "path" as const,
        opacity: worldSample.opacity,
        paintOrder,
        path: localSample.path!,
        sourceZIndex: entity.sourceZIndex,
        stroke: entity.appearance.kind === "vector" ? entity.appearance.stroke : null,
        transform: worldSample.transform,
      };
    });

    const camera = sampleCamera(scene, sampleTime);
    const packet = {
      assetManifest: scene.assetManifest,
      camera: {
        bottom: camera.center.y - camera.frameHeight / 2,
        clearColor: scene.camera.background,
        kind: "orthographic-2d" as const,
        left: camera.center.x - camera.frameWidth / 2,
        right: camera.center.x + camera.frameWidth / 2,
        top: camera.center.y + camera.frameHeight / 2,
      },
      coordinateSpace: scene.coordinateSpace,
      draws,
      evidence,
      packetId,
      requiredCapabilities: renderCapabilities(draws),
      sampleTime,
      sceneContractVersion: scene.version,
      sceneDuration: scene.duration,
      sceneId: scene.sceneId,
      sceneRevisionHash: sceneIrSourceRevisionHash(scene),
      schema: "poietra.render-packet" as const,
      version: 1 as const,
      viewport,
    };
    const frame = await parseVerifiedEngineFrameV1({ assets, packet, scene });
    return { frame, kind: "ready" };
  } catch (error) {
    return { code: "invalid-output", kind: "error", message: errorMessage(error) };
  }
}
