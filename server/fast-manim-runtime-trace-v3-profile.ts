import type { TrustedFastManimRuntimeTraceProducerV3 } from "./fast-manim-runtime-trace-v3-result-contract";

const trustedProducer = Object.freeze({
  fastManimCommit: "42c2eaf07a086b4944d45f14866a8c506ac9a145",
  fastManimTree: "4ba1bfdc73c910453ef6c49315ce645eb5a9a7b9",
  manimVersion: "0.20.1",
} as const satisfies TrustedFastManimRuntimeTraceProducerV3);

/** Returns a copy of the reviewed generic producer identity. */
export function trustedFastManimRuntimeTraceProducerV3(): TrustedFastManimRuntimeTraceProducerV3 {
  return { ...trustedProducer };
}

/** Non-secret identity injected into the isolated producer process. */
export function fastManimRuntimeTraceProducerEnvironmentV3() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: trustedProducer.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: trustedProducer.fastManimTree,
  });
}
