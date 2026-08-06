# Testing strategy

Studio Lab keeps tests at the narrowest layer that can detect a real regression.
Test count is not a coverage target.

## Suites

| Suite | Command | Responsibility |
| --- | --- | --- |
| Unit | `pnpm test:unit` | Pure state rules, closed schemas, canonicalization, scheduling, and component rendering. |
| Boundary and integration | `pnpm test:integration` | Source parsing/lowering, HTTP, filesystem/process safety, and the render manager with a fake process adapter. |
| Browser E2E | `pnpm test:e2e` | Cross-component journeys whose failures depend on React state, pointer events, layout, and the browser. |
| WebKit minimum smoke | `pnpm test:e2e:webkit-smoke` | Workspace open, object creation, and export in WebKit at the supported 960×640 viewport. |
| Real Manim smoke | Manual, before a render-pipeline release | One Docker-backed preview and discard or commit/undo. This checks the external renderer rather than duplicating deterministic lowering cases. |

## Large binary fixture assertions

Cairo reference readers in the unit lane still read every PNG, validate its
encoded SHA-256, decode the complete RGBA frame, and validate the decoded
SHA-256. Tests that assert equality or progression between 640×360 RGBA frames
compare those verified SHA-256 values instead of asking Vitest to perform a deep
structural comparison of `Uint8Array` values. The latter spent about 2.2 seconds
per scenario during the Issue #489 profile even though fixture I/O, parsing,
decoding, and integrity checks took only 38–53 milliseconds. Corpus-binding tests
likewise reuse one fully validated read of a reference set instead of decoding the
same set once per corpus entry. The native WebGPU/Cairo lane remains responsible
for pixel metrics and diagnostic diffs.

The browser suite stays deliberately small. It covers the original journey where
moving two different objects must retain both positions through Apply, plus the
cross-owner editor foundations: manual geometry creation and export, live Bézier
path editing and export, registered-project switching, and Scene-duration extension
through an exported wait.
These regressions cannot be detected by evaluating already-constructed Programs in
a unit test because the defects sit in React orchestration, pointer geometry, or
the browser download boundary.
The WebKit journey lives in its own `*.smoke.ts` project so browser-specific
coverage stays one test instead of multiplying the full Chromium suite.

## Placement rule

Add a test only when it protects a named behavior or trust boundary:

1. Use a unit test for branching domain logic with a stable input/output contract.
2. Use a boundary or integration test for model input, HTTP, source files, process
   control, concurrency, or filesystem safety.
3. Use an E2E test only when the regression requires browser event dispatch or
   coordination across multiple UI owners.
4. Extend an existing scenario instead of repeating the same successful path at a
   second layer.
5. Do not test Tailwind classes, trivial immutable-array helpers, TypeScript-only
   structure, or an implementation detail already covered by an observable test.

Every regression test should fail on the faulty implementation. If it does not, it
belongs at a different layer or should be removed.

## Current ownership

- `src/studio/studio-model.test.ts` owns canonicalization, scheduling, transaction,
  and ProposedState invariants.
- `src/studio/draft-validation.test.ts` owns only the validation boundary used when
  installing a Draft.
- `src/studio/workspace-projection.test.ts` owns the imported-Scene boundary.
- `src/render-pipeline/*test.ts` owns source import, lowering, and browser/server
  response contracts.
- `server/*test.ts` owns HTTP, logging, filesystem, process, concurrency, and
  session-safety boundaries.
- `e2e/*.e2e.ts` owns a deliberately small set of user journeys.
- `e2e/*.smoke.ts` owns the minimum-viewport WebKit compatibility journey.
