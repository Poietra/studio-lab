import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
  type FastManimSnapshotProducerRequestV1,
  type FastManimSnapshotRuntimeConfigV1,
  fastManimSnapshotSceneIdV1,
} from "../fast-manim-snapshot-contract";
import { runtimeConfig } from "./fast-manim-snapshot-runner-fixture";

export const sandboxPngSource = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ImageScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
`;

export const sandboxTransformedPngSource = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class TransformedImageScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        image.move_to((1.25, -0.75, 0))
        image.scale(1.5)
        image.move_to((-0.25, 0.75, 0))
        image.scale(0.5)
        self.wait(2)
`;

export const SANDBOX_TRANSFORMED_PNG_EXPECTED = Object.freeze({
  centerX: -0.25,
  centerY: 0.75,
  cumulativeScale: 0.75,
});

export function sandboxPngBytes() {
  return Uint8Array.from(readFileSync(fileURLToPath(new URL("../../src-tauri/icons/32x32.png", import.meta.url))));
}

export function sandboxPngProducerRequest(): FastManimSnapshotProducerRequestV1 {
  const config: FastManimSnapshotRuntimeConfigV1 = {
    ...runtimeConfig(),
    capabilities: ["png-image"],
    snapshotVersion: 4,
  };
  const sourcePath = "image_scene.py";
  const sceneName = "ImageScene";
  return {
    projectId: "default",
    requestId: "snapshot-png-request-1",
    runtimeConfig: config,
    runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(config),
    sceneId: fastManimSnapshotSceneIdV1(sourcePath, sceneName),
    sceneName,
    schema: FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
    snapshotVersion: 4,
    sourceHash: createHash("sha256").update(sandboxPngSource, "utf8").digest("hex"),
    sourcePath,
    sourceText: sandboxPngSource,
    version: 1,
  };
}

export function sandboxTransformedPngProducerRequest(): FastManimSnapshotProducerRequestV1 {
  const config: FastManimSnapshotRuntimeConfigV1 = {
    ...runtimeConfig(),
    capabilities: ["png-image"],
    snapshotVersion: 4,
  };
  const sourcePath = "transformed_image_scene.py";
  const sceneName = "TransformedImageScene";
  return {
    projectId: "default",
    requestId: "snapshot-transformed-png-request-1",
    runtimeConfig: config,
    runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(config),
    sceneId: fastManimSnapshotSceneIdV1(sourcePath, sceneName),
    sceneName,
    schema: FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
    snapshotVersion: 4,
    sourceHash: createHash("sha256").update(sandboxTransformedPngSource, "utf8").digest("hex"),
    sourcePath,
    sourceText: sandboxTransformedPngSource,
    version: 1,
  };
}
