# Testing strategy

Studio Lab keeps tests at the narrowest layer that can detect a real regression.
Test count is not a coverage target.

## Suites

| Suite | Command | Responsibility |
| --- | --- | --- |
| Unit | `pnpm test:unit` | Pure state rules, closed schemas, canonicalization, scheduling, and component rendering. |
| Boundary and integration | `pnpm test:integration` | Source parsing/lowering, HTTP, filesystem/process safety, and the render manager with a fake process adapter. |
| Main browser E2E | `pnpm test:e2e:ci` | Tagged representative journeys whose failures depend on React state, pointer events, layout, WebGPU, or browser compatibility. |
| Full browser corpus | `pnpm test:e2e` | Manual diagnosis and render-change validation; real-render profiles and performance measurements are excluded. |
| Account E2E | `pnpm test:e2e:account:ci` | Four production-shaped PostgreSQL/browser journeys selected when account-owned paths change. |
| WebKit minimum smoke | `pnpm test:e2e:webkit-smoke` | Workspace open and export in WebKit at the supported 960×640 viewport. |
| Studio gesture benchmark | `pnpm benchmark:studio:gesture` | Explicit browser performance evidence; not a deterministic correctness gate. |
| Real Manim smoke | Manual, before a render-pipeline release | One Docker-backed preview and discard or commit/undo. This checks the external renderer rather than duplicating deterministic lowering cases. |

## CI lanes

Pull requests use a change-scoped fast lane. Style and scope routing always run;
Engine core, browser WASM, web builds, unit/integration tests, durable storage,
the explicitly tagged Chromium smoke journeys, and the packaged Electron startup smoke
run only when their owned paths change. Unit and integration tests both load the real WASM module, so they
consume its artifact and then run in parallel. The final `CI gate` reports one
stable result even when unrelated lanes are intentionally skipped.

Pushes to `main` run a bounded compatibility set: `@ci-smoke` plus `@ci-main`,
the four retained-preview smoke contracts, and the minimum WebKit journey. These
expensive jobs wait for style, Engine, unit/integration, and web-build gates and
stop after the first failure. Production-account tests run only for account-owned
changes. Native Lavapipe, the full WebGPU corpus, retained-preview corpus, and
visual parity run only for render-owned changes. A manual workflow dispatch still
selects every lane. Tauri remains source-controlled as an experiment; it is
checked for owned pull-request changes and every code push to `main`, but is not
a production shell gate. Real
Manim profiles are manual because they are external integrations with a
release-specific cost and owner, not a weekly health signal.

The generic WebGPU project explicitly ignores every `real-*-preview.webgpu.ts`
profile. Those files have dedicated real-preview commands and must not be picked
up accidentally by a broad `*.webgpu.ts` match. Browser performance probes are
likewise explicit benchmark commands rather than correctness E2E.

The lane selector also checks that every tracked deterministic Vitest file is
owned by either the unit or integration command. Only the selector's own
dependency-free tests and the explicitly external real-Manim census tests may
sit outside those commands. This keeps the path lists auditable instead of
silently dropping a newly added test file.

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

The tagged main browser set samples each real browser boundary without replaying
every domain-rule branch already covered by unit tests. It covers workspace
launch/import/export/CRUD, timeline scrubbing, encoder negotiation, WebGPU
worker/readback/device recovery, PNG transfer, MP4 preview, and one
minimum-viewport WebKit download journey. Domain variants stay at the unit or
integration layer; the broader Playwright corpus is retained for focused
diagnosis and render-owned changes.

The group-visibility and Magic Edit imported-Scene journeys still rely on the
selection-only V2 fake snapshot and carry `@manual-authority`. Automated render
parity excludes them until they have endpoint-capable Runtime Trace V3 evidence;
running them as ordinary CI would only spend 30-second timeouts proving that the
current authority model correctly disabled editing.

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
