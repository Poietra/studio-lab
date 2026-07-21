# Rendered validation pipeline

Status: implemented experimental slice
Last updated: 2026-07-21

## Outcome

Studio can carry one complete canonical `EditProgram` into a real Manim preview
without writing model-authored Python or modifying the source before validation.

```text
canonical EditProgram
        ↓
imported runtime → source variable bindings and Scene graph
        ↓
explicit # poietra:anchor boundary
        ↓
deterministic operation-by-operation source lowering
        ↓
isolated Manim subprocess + MP4
        ↓
user review
        ↓
atomic source commit or discard
```

The workspace bridge discovers Python files and ordered Scene classes below the
configured project root. The application imports their conservative runtime
snapshots once and uses the selected Scene for canvas, object list, timeline, AI
context, and rendered validation. The right-side panel exposes renderer
availability, progress, cancellation, bounded logs, the complete inserted source
block, rendered MP4, commit, discard, and exact Undo.

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

This pipeline does not pretend arbitrary Python has an unambiguous temporal
insertion point. A source file opts in with an exact marker inside the Scene method:

```py
# poietra:anchor 7.000
```

Every referenced imported source variable must be assigned before that marker. The
resolved Program anchor must match the marker exactly. The lowerer generates Python
only from the closed Canonical operation vocabulary. It groups animations sharing
one interval into one `self.play`, preserves sequence gaps with `self.wait`, and
rejects unsupported overlap.

Supported source forms in this experiment are:

- straight `CreateMotion` and exact 2D position;
- MathTex and Text creation with stable transaction-scoped identity markers;
- snapshot `next_to` placement and FadeIn/removal;
- `TransformMatchingTex` and replacement transform with variable rebinding;
- circle, diamond, or hexagon cover/reveal;
- an explicit full-cover boundary that clears the outgoing composition, installs
  the initial composition of the actual next imported Scene, reveals it, and ends
  the outgoing construct.

Committed generated entities carry a JSON-encoded `poietra:entity` comment. The
source importer treats it as data, recovers the same Studio ID and Python binding,
and ignores unmarked transient `poietra_` variables. Scene changes similarly carry
a data-only boundary marker. The explicit anchor remains temporary integration
evidence; a later Runtime Trace importer should produce equivalent safe structural
boundaries without hand-authored comments.

## Safety and truthfulness

- request schemas accept only a bounded canonical Program, imported source
  bindings, finite geometry, an exact Scene destination, and Python source paths
  inside the configured project root;
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

- all referenced existing targets must have imported source variables before the
  same safe anchor;
- curved paths, camera changes, overlapping animation composition, and arbitrary
  time insertion remain unsupported;
- the next Scene preview uses its imported initial composition; it does not splice
  the destination Scene's later animation timeline into the outgoing Scene;
- source discovery uses conservative Scene, assignment, play, wait, and marker
  parsing rather than a Python AST plus Runtime Trace, so dynamic control flow and
  updater-driven geometry remain unknown;
- Undo evidence lives for the Vite server session; durable project history remains
  future product work;
- the bridge is a local development experiment, not a remotely exposed render
  service or Python sandbox.

These limits are visible blockers. The pipeline never substitutes a fixture video
or marks illustrative lowering as rendered validation when Manim is unavailable.
