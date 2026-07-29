import { z } from "zod";

import {
  assetManifestReferenceV1Schema,
  assetReferenceV1Schema,
  coordinateV1Schema,
  countCubicPathSegments,
  cubicPathV1Schema,
  engineAffineTransformV1Schema,
  evidenceV1Schema,
  fillStyleV1Schema,
  finiteNumberV1Schema,
  MAX_TOTAL_PATH_SEGMENTS,
  normalizedNumberV1Schema,
  opaqueIdV1Schema,
  POIETRA_ENGINE_CONTRACT_VERSION,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "./primitives";

const MAX_DRAWS = 100_000;
const MAX_VIEWPORT_PIXELS = 33_554_432;

const imageLocalRectV1Schema = z
  .object({
    bottom: coordinateV1Schema,
    left: coordinateV1Schema,
    right: coordinateV1Schema,
    top: coordinateV1Schema,
  })
  .strict()
  .refine((rectangle) => rectangle.right > rectangle.left && rectangle.top > rectangle.bottom, {
    message: "Image localRect must have positive width and height.",
  });

const drawBase = {
  drawId: opaqueIdV1Schema,
  entityId: sourceIdentityV1Schema,
  opacity: normalizedNumberV1Schema,
  paintOrder: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_DRAWS - 1),
  sourceZIndex: finiteNumberV1Schema,
  transform: engineAffineTransformV1Schema,
};

const pathDrawV1Schema = z
  .object({
    ...drawBase,
    fill: fillStyleV1Schema.nullable(),
    kind: z.literal("path"),
    path: cubicPathV1Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict();

const emptyDrawV1Schema = z
  .object({
    ...drawBase,
    kind: z.literal("empty"),
    reason: z.enum(["path-trim-zero", "singular-affine-sample"]),
  })
  .strict();

const imageDrawV1Schema = z
  .object({
    ...drawBase,
    asset: assetReferenceV1Schema,
    kind: z.literal("image"),
    localRect: imageLocalRectV1Schema,
    sampler: z.enum(["linear", "nearest"]),
  })
  .strict();

const renderDrawV1Schema = z.discriminatedUnion("kind", [emptyDrawV1Schema, imageDrawV1Schema, pathDrawV1Schema]);
const renderCapabilityV1Schema = z.enum(["cubic-path-fill", "cubic-path-stroke", "png-image"]);

const renderCameraV1Schema = z
  .object({
    bottom: coordinateV1Schema,
    clearColor: rgbaColorV1Schema,
    kind: z.literal("orthographic-2d"),
    left: coordinateV1Schema,
    right: coordinateV1Schema,
    top: coordinateV1Schema,
  })
  .strict()
  .refine((camera) => camera.right > camera.left && camera.top > camera.bottom, {
    message: "Camera extents must have positive width and height.",
  });

export const renderViewportV1Schema = z
  .object({
    heightPx: z.number().int().positive().max(16_384),
    widthPx: z.number().int().positive().max(16_384),
  })
  .strict()
  .refine((viewport) => viewport.widthPx * viewport.heightPx <= MAX_VIEWPORT_PIXELS, {
    message: `A viewport may contain at most ${MAX_VIEWPORT_PIXELS} pixels.`,
  });

const renderPacketV1BaseSchema = z
  .object({
    assetManifest: assetManifestReferenceV1Schema,
    camera: renderCameraV1Schema,
    coordinateSpace: z
      .object({
        cpuPrecision: z.literal("f64"),
        kind: z.literal("cartesian-2d"),
        origin: z.literal("center"),
        unit: z.literal("scene-unit"),
        xAxis: z.literal("right"),
        yAxis: z.literal("up"),
      })
      .strict(),
    draws: z.array(renderDrawV1Schema).max(MAX_DRAWS),
    evidence: z.array(evidenceV1Schema).max(64),
    packetId: opaqueIdV1Schema,
    requiredCapabilities: z.array(renderCapabilityV1Schema).max(renderCapabilityV1Schema.options.length),
    sampleTime: finiteNumberV1Schema.nonnegative(),
    sceneDuration: finiteNumberV1Schema.positive(),
    sceneId: sourceIdentityV1Schema,
    sceneRevisionHash: sha256V1Schema,
    schema: z.literal("poietra.render-packet"),
    sceneContractVersion: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
    version: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
    viewport: renderViewportV1Schema,
  })
  .strict();

type RenderPacketV1Input = z.infer<typeof renderPacketV1BaseSchema>;

function requiredCapabilities(packet: RenderPacketV1Input) {
  const capabilities = new Set<z.infer<typeof renderCapabilityV1Schema>>();
  for (const draw of packet.draws) {
    if (draw.kind === "image") capabilities.add("png-image");
    if (draw.kind === "path" && draw.fill !== null) capabilities.add("cubic-path-fill");
    if (draw.kind === "path" && draw.stroke !== null) capabilities.add("cubic-path-stroke");
  }
  return [...capabilities].sort();
}

export const renderPacketV1Schema = renderPacketV1BaseSchema.superRefine((packet, context) => {
  if (packet.sampleTime > packet.sceneDuration) {
    context.addIssue({
      code: "custom",
      message: "sampleTime must not exceed sceneDuration.",
      path: ["sampleTime"],
    });
  }

  const cameraAspect = (packet.camera.right - packet.camera.left) / (packet.camera.top - packet.camera.bottom);
  const viewportAspect = packet.viewport.widthPx / packet.viewport.heightPx;
  if (Math.abs(cameraAspect / viewportAspect - 1) > 0.000_001) {
    context.addIssue({
      code: "custom",
      message: "Camera and viewport aspect ratios must match.",
      path: ["camera"],
    });
  }

  const expectedCapabilities = requiredCapabilities(packet);
  if (
    expectedCapabilities.length !== packet.requiredCapabilities.length ||
    expectedCapabilities.some((capability, index) => capability !== packet.requiredCapabilities[index])
  ) {
    context.addIssue({
      code: "custom",
      message: `requiredCapabilities must exactly equal: ${expectedCapabilities.join(", ") || "(none)"}.`,
      path: ["requiredCapabilities"],
    });
  }

  const drawIds = new Set<string>();
  let segmentCount = 0;
  packet.draws.forEach((draw, index) => {
    if (drawIds.has(draw.drawId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate draw ID ${draw.drawId}.`,
        path: ["draws", index, "drawId"],
      });
    }
    if (draw.paintOrder !== index) {
      context.addIssue({
        code: "custom",
        message: "paintOrder must equal the draw's back-to-front array index.",
        path: ["draws", index, "paintOrder"],
      });
    }
    if (draw.kind === "path") {
      segmentCount += countCubicPathSegments(draw.path);
      if (draw.fill === null && draw.stroke === null) {
        context.addIssue({ code: "custom", message: "Path draws require a fill or stroke.", path: ["draws", index] });
      }
    }
    if (
      draw.kind === "empty" &&
      draw.reason === "singular-affine-sample" &&
      draw.transform.m11 * draw.transform.m22 - draw.transform.m12 * draw.transform.m21 !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "singular-affine-sample requires an exactly singular transform.",
        path: ["draws", index, "transform"],
      });
    }
    drawIds.add(draw.drawId);
  });
  if (segmentCount > MAX_TOTAL_PATH_SEGMENTS) {
    context.addIssue({
      code: "custom",
      message: `RenderPacket accepts at most ${MAX_TOTAL_PATH_SEGMENTS} total cubic segments.`,
    });
  }
});

export type RenderPacketV1 = z.infer<typeof renderPacketV1Schema>;
