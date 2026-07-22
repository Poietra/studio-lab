# Testing strategy

Studio Lab keeps tests at the narrowest layer that can detect a real regression.
Test count is not a coverage target.

## Suites

| Suite | Command | Responsibility |
| --- | --- | --- |
| Unit | `pnpm test:unit` | Pure state rules, closed schemas, canonicalization, scheduling, and component rendering. |
| Boundary and integration | `pnpm test:integration` | Source parsing/lowering, HTTP, filesystem/process safety, and the render manager with a fake process adapter. |
| Browser E2E | `pnpm test:e2e` | Cross-component journeys whose failures depend on React state, pointer events, layout, and the browser. |
| Real Manim smoke | Manual, before a render-pipeline release | One Docker-backed preview and discard or commit/undo. This checks the external renderer rather than duplicating deterministic lowering cases. |

The browser suite intentionally starts with one journey: moving two different
objects must retain both positions through Apply. This regression cannot be
detected by evaluating two already-constructed Programs in a unit test; the defect
was in the application's Draft-to-working-state orchestration.

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
