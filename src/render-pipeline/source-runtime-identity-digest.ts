import { createHash } from "node:crypto";

import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
  type SourceBindingV1,
} from "../engine/source-runtime-identity";

export function sourceRuntimeSceneIdentifierV1(sourcePath: string, sceneName: string) {
  return `scene:${createHash("sha256").update(`${sourcePath}\0${sceneName}`).digest("hex")}`;
}

export function fastManimSourceBindingIdentifierV1(
  sourceHash: string,
  sceneId: string,
  binding: Readonly<{ name: string; ordinal: number; span: SourceBindingV1["span"] }>,
) {
  const payload = [
    FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
    String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
    sourceHash,
    sceneId,
    binding.name,
    String(binding.ordinal),
    String(binding.span.startLine),
    String(binding.span.startColumn),
    String(binding.span.endLine),
    String(binding.span.endColumn),
  ].join("\u0000");
  return `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}
