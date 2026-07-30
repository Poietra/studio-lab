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
        image = ImageMobject(
            "image.png",
            resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"],
        )
        self.add(image)
`;

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
