import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
  type SourceBindingV1,
} from "../engine/source-runtime-identity";

/** Exact cross-runtime bytes hashed for one canonical source binding ID. */
export function fastManimSourceBindingIdentityPayloadV1(
  sourceHash: string,
  sceneId: string,
  binding: Readonly<{ name: string; ordinal: number; span: SourceBindingV1["span"] }>,
) {
  return [
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
}
