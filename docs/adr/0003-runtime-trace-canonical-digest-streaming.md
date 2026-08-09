# ADR 0003: Stream the Runtime Trace canonical digest instead of materializing it

- Status: Accepted for the Runtime Trace V1/V2 verification path
- Date: 2026-08-09
- Decision owner: Poietra Studio
- Issue: #499

## Context

The OpeningManim fresh Runtime Trace V2 round-trip E2E proves the right thing —
a real producer, real Manim, all 900 frames, frames 0–839 completely invariant,
840–899 limited to a source-derived translation, verified against both WebGPU
and Cairo. It is also expensive. The 2026-08-06 measurement recorded:

- Vite/server `VmHWM` 3,145,528 kB
- Playwright worker `VmHWM` 855,224 kB
- total peak across Python producer and Chromium above 4 GiB
- candidate trace 89,695,142 bytes, just under the 88 MiB admission ceiling
- wall time about 5.5 minutes

Production admission is exclusive, weighted, and released in `finally`, so this
is not a correctness problem. It is operating margin: a small-RAM CI runner or
SaaS pod has very little headroom, and the run holds a base trace and a
candidate trace at the same time.

Two structural costs dominate the server side, and neither is inherent to the
verification contract:

1. **The whole-trace digest.** `digestFastManimRuntimeTraceV*` built the entire
   canonical JSON document as one string and then hashed it. `canonicalJsonV1`
   composes bottom-up — every nested object and array produces its own string —
   so an 88 MiB document costs the 88 MiB result plus roughly one transient copy
   per nesting level, all live at once.
2. **The one-second Wait holds.** The V2 schema refinement compared each frame's
   draws to the first frame of its range by canonicalizing both. That is ~300
   frame-sized strings per trace, built and discarded, inside `safeParse`.

The decoded request text and the pre-schema object graph also stayed reachable
for the whole parse, so a base and a candidate could hold four large graphs
between them.

## Decision

Keep every verification rule exactly as it is. Change only how the same bytes
are produced.

`writeCanonicalJsonV1(value, sink)` performs the identical traversal in the
identical order and emits one scalar token per call instead of concatenating a
subtree. `digestCanonicalJsonV1` feeds that into SHA-256 through a 1 MiB flush
buffer. The hashed byte sequence is unchanged by construction, so every
persisted digest, correlation check, and self-seal keeps its value.

The Wait-hold comparison now compares per-frame digests produced by the same
streaming writer rather than materialized canonical strings. `canonicalJsonV1`
and `writeCanonicalJsonV1` walk the full value and raise the same `TypeError`
for non-finite numbers and non-JSON values, so the failure surface is unchanged.

The parse path releases the decoded text once the object graph exists, and
releases the pre-schema graph once the schema owns its own copy.

## Consequences

`server/canonical-json-digest.test.ts` pins the equivalence: the streamed
characters equal `canonicalJsonV1` over a corpus that includes `-0`, key
ordering, escapes, astral characters, and documents that cross the flush
boundary repeatedly; the digests equal
`createHash("sha256").update(canonicalJsonV1(value))`; and the writer never
hands a sink more than one scalar token, which is the structural property the
memory reduction rests on.

Measured effect on the closest available proxy, the V2 OpeningManim candidate
runner integration test, on one WSL2 host:

| | before | after |
| --- | --- | --- |
| `fast-manim-runtime-trace-v2-candidate-runner.test.ts` | 136 s (exceeded its inline 120 s budget and failed) | 65 s (passes) |
| full `vitest run` | 150 s, 1 failed | 82 s, 0 failed |

That test was failing on this host before the change and passes after it.

### Budget still to confirm

The RSS targets in #499 — server peak at or below 2 GiB and observed total at or
below 3 GiB — are **not** confirmed by this ADR. They need the pinned Linux E2E
host with the real fast-manim producer and WebGPU Chromium, which this change
was not measured on. The analysis above predicts the largest single reduction
comes from item 1, but the number that matters is the one from that host.

Recording the intended budget so the follow-up measurement has something to
check against:

- server (`vite` dev server process) peak `VmHWM` at or below 2 GiB
- observed peak across server, Playwright worker, Python producer, and Chromium
  at or below 3 GiB
- no regression in wall time

If the measured peak lands above those numbers, the remaining candidate levers
from #499 are incremental frame-evidence comparison with early discard, a
temporary-file boundary for the candidate payload, and shortening how long
Playwright and the server retain evidence.

## Non-goals

Unchanged, per #499: the verification contract is not relaxed, frames are not
sampled, and the fresh producer is not replaced by a stored fixture. No trace
fixture is committed to the repository.
