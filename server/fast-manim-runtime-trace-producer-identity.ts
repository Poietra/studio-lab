export const TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY = Object.freeze({
  fastManimCommit: "edcf6578d7b5515d39f9378d48b2c5e8f9a99fa6",
  fastManimTree: "806b84287549a874393046e35663f07a7ed576d4",
} as const);

/** Non-secret identity injected into the isolated Runtime Trace producer. */
export function fastManimRuntimeTraceProducerEnvironment() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
  });
}
