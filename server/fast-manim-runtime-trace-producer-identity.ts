export const TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY = Object.freeze({
  fastManimCommit: "d24026e11fbf30fa820593e1f0c59dd02ea82c25",
  fastManimTree: "93a1467e7d6ba23e9fac5baf827523ae893b6267",
} as const);

/** Non-secret identity injected into the isolated Runtime Trace producer. */
export function fastManimRuntimeTraceProducerEnvironment() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
  });
}
