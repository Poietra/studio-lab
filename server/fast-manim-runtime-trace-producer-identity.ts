export const TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY = Object.freeze({
  fastManimCommit: "f37b32200eb111678411ca347486779cb73c5e0a",
  fastManimTree: "f6c7c196a5e3ff33ff2f5b4f56a2286aa88282f6",
} as const);

/** Non-secret identity injected into the isolated Runtime Trace producer. */
export function fastManimRuntimeTraceProducerEnvironment() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
  });
}
