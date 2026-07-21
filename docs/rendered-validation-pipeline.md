# Rendered validation pipeline

Status: implemented experimental slice
Last updated: 2026-07-21

## Outcome

Studio can carry one straight canonical `CreateMotion` from the existing gesture
candidate into a real Manim preview without writing model-authored Python or
modifying the source before validation.

```text
canonical CreateMotion
        ↓
known runtime → source variable mapping
        ↓
explicit # poietra:anchor boundary
        ↓
temporary source lowering
        ↓
isolated Manim subprocess + MP4
        ↓
user review
        ↓
atomic source commit or discard
```

The right-side `Rendered validation` panel discovers Python files and Scene
classes below the configured project root. It exposes source anchors, renderer
availability, progress, cancellation, bounded logs, the inserted source block,
the rendered MP4, commit, discard, and exact Undo.

## Configuration

`POIETRA_MANIM_PROJECT_ROOT` selects the only filesystem root the local Vite
bridge may inspect or edit. It defaults to the Studio Lab checkout.

`POIETRA_MANIM_COMMAND` is either one executable or a JSON array such as
`["uv", "run", "manim"]`. The bridge invokes it directly without a shell. The
default is `manim`.

`scripts/manim-docker-runner.mjs` is an optional local adapter for the versioned
`manimcommunity/manim:v0.20.1` image. It runs without container networking, mounts
the project read-only, and exposes only the isolated preview directory as writable.

`POIETRA_MANIM_FRAME_WIDTH` and `POIETRA_MANIM_FRAME_HEIGHT` default to Manim's
14.222 × 8 world frame. Screen-pixel deltas are converted once against this
explicit frame and the captured Studio viewport.

## Source contract

This slice does not pretend arbitrary Python has an unambiguous temporal insertion
point. A source file opts in with an exact marker inside the Scene method:

```py
# poietra:anchor 7.000
```

The selected source variable must be assigned before that marker. The resolved
operation start must match the marker exactly. Lowering currently inserts one
`self.play(variable.animate.shift(...), run_time=..., rate_func=smooth)` block.

The explicit marker is temporary integration evidence, not the final Scene IR or
Runtime Trace format. A later importer should produce equivalent structural
boundaries without requiring hand-authored comments.

## Safety and truthfulness

- request schemas accept only `CreateMotion`, identifiers, finite geometry, and a
  Python source path inside the configured project root;
- subprocesses are spawned without a shell and can be cancelled as a process group;
- preview source and media live in an isolated operating-system temporary directory;
- the original source is untouched until Manim exits successfully and produces an MP4;
- commit compares the current source SHA-256 with the previewed snapshot and rejects
  stale writes;
- commit uses a same-directory atomic rename and retains the exact original source
  in the live server session for guarded Undo;
- Undo refuses to overwrite a file changed after Studio's commit;
- the browser receives a bounded log tail and a session-scoped MP4 URL, never an
  arbitrary filesystem path.

## Current limits

- only one straight `CreateMotion` is supported; all of its targets must have
  known source variables before the same anchor;
- curved paths, overlapping motion composition, general source identity recovery,
  and arbitrary time insertion remain unsupported;
- source discovery uses conservative Scene-class and anchor parsing rather than a
  Python AST plus Runtime Trace;
- Undo evidence lives for the Vite server session; durable project history remains
  future product work;
- the bridge is a local development experiment, not a remotely exposed render
  service or Python sandbox.

These limits are visible blockers. The pipeline never substitutes a fixture video
or marks illustrative lowering as rendered validation when Manim is unavailable.
