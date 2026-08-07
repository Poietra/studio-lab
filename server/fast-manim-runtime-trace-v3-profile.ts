import { TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY } from "./fast-manim-runtime-trace-producer-identity";
import type { TrustedFastManimRuntimeTraceProducerV3 } from "./fast-manim-runtime-trace-v3-result-contract";

const trustedProducer = Object.freeze({
  ...TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
  manimVersion: "0.20.1",
} as const satisfies TrustedFastManimRuntimeTraceProducerV3);

/** Returns a copy of the reviewed generic producer identity. */
export function trustedFastManimRuntimeTraceProducerV3(): TrustedFastManimRuntimeTraceProducerV3 {
  return { ...trustedProducer };
}
