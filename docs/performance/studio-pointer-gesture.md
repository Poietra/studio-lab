# Studio pointer gesture render boundary

Issue #340 tracks the pointer gesture hot path. The checked-in fixture keeps the detailed drag and resize preview outside `App` state, profiles the canvas, timeline, and toolbar independently, and fails when a pointer move rebuilds or commits the unrelated timeline or toolbar.

## Reproduce

```sh
pnpm exec playwright test e2e/studio-gesture-performance.e2e.ts --project=chromium
```

The fixture opens the standard Studio Lab workspace, hides Magic Edit, inserts six Circles, and applies them as one representative multi-entity scene. It then performs 24 pointer moves for both a Circle drag and its bottom-right resize handle. The pointer remains down for the complete sample, so the path also exercises the canvas pointer-capture handlers.

Each run attaches `studio-gesture-profile.json`. Frame intervals and Profiler durations are diagnostic evidence; the stable regression gate is structural: canvas renders must be observed while timeline and toolbar render and commit counts remain zero.

## Measurement environment

- Recorded: 2026-08-09
- OS: Windows
- Node.js: 24.12.0
- Playwright / Chromium: Playwright 1.61.1 bundled Chromium
- Viewport: 1440 × 900
- Development React Strict Mode: enabled; each of the 24 commits invokes a rendered component twice
- Slow-frame observation threshold: greater than 32 ms

## Before and after

The baseline used the same profiler and fixture before moving the gesture preview out of `App` state. Durations are summed React Profiler `actualDuration` values for one run.

| Gesture | Boundary | Before renders / commits | After renders / commits | Before duration | After duration |
| --- | --- | ---: | ---: | ---: | ---: |
| Drag | Canvas | 48 / 24 | 48 / 24 | 172.9 ms | 189.9 ms |
| Drag | Timeline | 48 / 24 | 0 / 0 | 374.0 ms | 0 ms |
| Drag | Toolbar | 48 / 24 | 0 / 0 | 19.5 ms | 0 ms |
| Resize | Canvas | 48 / 24 | 48 / 24 | 121.6 ms | 193.1 ms |
| Resize | Timeline | 48 / 24 | 0 / 0 | 235.8 ms | 0 ms |
| Resize | Toolbar | 48 / 24 | 0 / 0 | 15.8 ms | 0 ms |

The canvas duration varies between browser runs, so it is not used as a pass/fail threshold. The eliminated work is deterministic: all 48 development renders and all 24 commits of each unrelated boundary disappear for both gestures.

| Gesture | Before slow intervals | After slow intervals | Before maximum | After maximum |
| --- | ---: | ---: | ---: | ---: |
| Drag | 26 / 91 (28.6%) | 2 / 55 (3.6%) | 66.8 ms | 33.4 ms |
| Resize | 17 / 92 (18.5%) | 3 / 58 (5.2%) | 50.0 ms | 33.3 ms |

Frame counts depend on host scheduling and are retained as evidence rather than a CI threshold.

## Boundary design

- `StudioGesturePreviewStore` owns the mutually exclusive drag, geometry, and scale snapshots.
- `App` subscribes only to the primitive gesture `kind`. A transition between idle, drag, geometry, and scale still updates preview authority, but another move within the same gesture does not rebuild `App`.
- A canvas-only child below `StudioViewport` subscribes to the complete snapshot and sends it to `StudioCanvas`.
- `StudioViewport`, timeline, and toolbar do not subscribe to detailed preview snapshots. They retain their previous render behavior for every observable App prop change, while canvas-only pointer moves cannot reach them.
- Scene changes, workspace exit, pointer up, pointer cancel, and lost pointer capture clear the same store before any early draft return.

## Related interaction coverage

The performance fixture covers drag, resize handles, preview completion, pointer capture, and draft discard in a multi-entity scene. Existing Playwright coverage remains responsible for the surrounding behavior:

- `direct-manipulation.e2e.ts`: safe source-anchor snapping and Circle geometry resize/export/undo
- `editor-foundations.e2e.ts`: imported and Studio-owned lifetime editing
- `editor-foundations.e2e.ts`: motion-path preview, control adjustment, and Bézier export

No entity DOM memoization was added. The optimization is limited to the profiler-demonstrated Studio boundary.
