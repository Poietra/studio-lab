export const TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY = Object.freeze({
  fastManimCommit: "9b3d6d5dc81c6f45a256d2d9f71d53ce0f6d8075",
  fastManimTree: "a10c9852a8966fc8d38798d50b821feb89772955",
} as const);

/** Non-secret identity injected into the isolated Runtime Trace producer. */
export function fastManimRuntimeTraceProducerEnvironment() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
  });
}
