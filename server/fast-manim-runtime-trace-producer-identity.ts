export const TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY = Object.freeze({
  fastManimCommit: "d24026e11fbf30fa820593e1f0c59dd02ea82c25",
  fastManimTree: "93a1467e7d6ba23e9fac5baf827523ae893b6267",
} as const);

export type FastManimRuntimeTraceProducerIdentity = Readonly<{
  fastManimCommit: string;
  fastManimTree: string;
}>;

/** Non-secret identity injected into the isolated Runtime Trace producer. */
export function fastManimRuntimeTraceProducerEnvironment(
  identity: FastManimRuntimeTraceProducerIdentity = TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
) {
  if (
    identity.fastManimCommit !== TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit ||
    identity.fastManimTree !== TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree
  ) {
    throw new Error("The Runtime Trace producer identity does not match the Studio trust anchor.");
  }
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: identity.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: identity.fastManimTree,
  });
}
