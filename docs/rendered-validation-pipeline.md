# Rendered validation pipeline

Status: implemented experimental slice
Last updated: 2026-07-22

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
        ├──→ text/x-python attachment (no Manim process or source write)
        ↓
isolated Manim subprocess + MP4 → user review → atomic source commit or discard
```

The workspace bridge discovers Python files and ordered Scene classes below each
configured project root. The header switches between server-authorized projects by
opaque ID. Browser Add creates a managed workspace and starter Scene from a display
name alone; desktop shells may register an existing local folder. Workspace,
render, and export requests use only the resulting opaque ID. `nextSceneId`
follows class order within one source file;
unrelated files are not joined by an invented edge. The application imports
conservative runtime snapshots once and uses the selected Scene for canvas, object
list, timeline, AI context, and rendered validation. The right-side panel exports
the selected Python source unchanged before the first edit and switches to validated
canonical lowering after an edit. It also exposes renderer availability, progress,
cancellation, bounded logs, the complete inserted source block, rendered MP4,
commit, discard, and exact Undo.

## Configuration

`POIETRA_MANIM_PROJECT_ROOT` selects the fallback filesystem root the local Vite
bridge may inspect or edit. It defaults to the Studio Lab checkout.

`POIETRA_MANIM_PROJECTS` may instead contain a JSON array of root strings or
`{ "id", "name", "root" }` records. These values seed the private
`.poietra/workspace-catalog.json` on first start. The launcher then owns persistent
creation/registration, display-name changes, and unregistration. Browser-created
workspaces live below `.poietra/.workspaces` with an importable `main.py`. Removing
an existing-folder workspace only unregisters it and leaves its root and Python
source in place. Removing a browser-managed workspace moves its root to Studio
Trash at `.poietra/.trash` rather than hard-deleting it; there is currently no
Studio UI for restoring a trashed workspace. `POIETRA_STUDIO_DATA_ROOT` relocates
the private catalog, managed workspace content, and Studio Trash. The server
resolves every root and gives the browser catalog only opaque project IDs and
display names.

`POIETRA_MANIM_COMMAND` is either one executable or a JSON array such as
`["uv", "run", "manim"]`. The bridge invokes it directly without a shell. The
default is `manim`.

`scripts/manim-docker-runner.mjs` is an optional local adapter for the versioned
`manimcommunity/manim:v0.20.1` image. It runs without container networking, mounts
the project read-only, and exposes only the isolated preview directory as writable.

`POIETRA_MANIM_FRAME_WIDTH` and `POIETRA_MANIM_FRAME_HEIGHT` default to Manim's
14.222 × 8 world frame. Screen-pixel deltas are converted once against this
explicit frame and the captured Studio viewport.

## Local API boundary

- `GET /api/manim/projects` returns only opaque IDs, ownership kinds, and display names.
- `POST /api/manim/projects` accepts either `{ "kind": "managed", "name" }` to
  create a starter workspace or `{ "kind": "existing", "name", "root" }` for a
  desktop-selected folder. Its response always omits filesystem roots.
- `PATCH /api/manim/projects/:projectId` changes only the display name.
- `DELETE /api/manim/projects/:projectId` unregisters an existing-folder workspace
  without changing its source, or moves a browser-managed workspace to Studio
  Trash below the configured data root. It does not hard-delete source, and Studio
  does not yet expose a restore UI. Active or retained render sessions must be
  discarded first.
- `GET /api/manim/projects/:projectId/thumbnail` stops after the first importable
  Scene and returns a bounded semantic SVG derived from its imported object state.
  It never runs the Manim command; a missing Scene returns a safe SVG fallback and
  unsupported entities are omitted.
- `GET /api/manim/projects/:projectId/workspace` imports one registered project;
  `GET /api/manim/workspace` remains a default-project compatibility alias.
- `POST /api/manim/projects/:projectId/export` returns the selected source unchanged
  when no Program is supplied. Otherwise it validates and lowers the project-bound
  Program to a `text/x-python` attachment. It does not check Manim command availability
  and does not write the source.
- `POST /api/manim/projects/:projectId/renders` starts isolated rendered validation.
  Session status and action URLs use the random session ID; the registry routes
  Commit, Undo, Discard, and video reads back to the session's original project.

The body of every render/export request also carries `projectId`; the route and body
must agree. Every workspace and session response repeats its project ID so the
client can reject a cross-project response before it enters editor state.

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

- straight and quadratic Bézier `CreateMotion`, lowered exactly through Manim
  `CubicBezier`/`MoveAlongPath`, plus exact 2D position;
- MathTex, Text, Rectangle, Circle, Line, Arrow, and Square creation with stable
  transaction-scoped identity markers;
- snapshot `next_to` placement and FadeIn/removal;
- `TransformMatchingTex` and replacement transform with variable rebinding,
  including consecutive transforms of one logical MathTex in a sequence;
- an inserted `wait` used to extend Scene duration at a safe source anchor;
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
  bindings, the imported source SHA-256, finite geometry, an exact Scene
  destination, and Python source paths inside the configured project root;
- the server revalidates the Program against its own imported Scene and rejects
  stale hashes, unknown targets, and source bindings that do not match that import;
- render preparation imports only the requested source snapshot; project-wide
  discovery is reserved for the workspace endpoint and concurrent inspections are
  coalesced;
- client responses are parsed through closed runtime schemas before they can enter
  Studio state;
- subprocesses are spawned without a shell and can be cancelled as a process group;
- the manager permits two concurrent render processes, retains at most 32 source
  snapshots per configured project, and terminates a render that exceeds two minutes;
- preview source and media live in an isolated operating-system temporary directory;
- the original source is untouched until Manim exits successfully and produces an MP4;
- commit compares the current source SHA-256 with the previewed snapshot and rejects
  stale writes;
- commit uses a same-directory atomic rename and retains the exact original source
  in the live server session for guarded Undo;
- Undo refuses to overwrite a file changed after Studio's commit;
- the browser receives a bounded log tail and a session-scoped MP4 URL, never an
  arbitrary filesystem path; project discovery and workspace responses also omit
  absolute project roots;
- every workspace, render, export, and retained session is bound to one registered
  project ID, so Commit and Undo do not depend on the currently selected project;
- the editor retains its last render-session view separately per project through a
  project switch and rejects polling/action responses whose project ID changes;
- when a Program is present, the Python attachment endpoint repeats canonical
  validation, stale-source checks, and deterministic lowering; without a Program it
  verifies the selected source identity and returns that source byte-for-byte. Neither
  path requires a successful Manim render or writes the project source.

## Current limits

- all referenced existing targets must have imported source variables before the
  same safe anchor;
- camera lowering, overlapping animation composition, and insertion inside an
  existing source play remain unsupported;
- Scene duration can be extended by inserting a wait at an existing safe anchor;
  shrinking a Scene or rewriting arbitrary earlier timing is not implemented;
- the next Scene preview uses its imported initial composition; it does not splice
  the destination Scene's later animation timeline into the outgoing Scene;
- source discovery uses conservative Scene, assignment, play, wait, and marker
  parsing rather than a Python AST plus Runtime Trace, so dynamic control flow and
  updater-driven geometry remain unknown;
- preview and Undo evidence is retained in memory for 30 minutes and temporary
  media is then removed automatically; durable project history remains future
  product work;
- desktop shells still use a path field for existing folders and should replace it
  with their native OS directory picker;
- the bridge is a local development experiment, not a remotely exposed render
  service or Python sandbox.

These limits are visible blockers. The pipeline never substitutes a fixture video
or marks illustrative lowering as rendered validation when Manim is unavailable.
