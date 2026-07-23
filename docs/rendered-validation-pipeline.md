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

Rendered workspace thumbnails are derived cache data below
`POIETRA_STUDIO_DATA_ROOT/thumbnails/:projectId`, never inside a linked project.
Each project retains at most eight PNG frames keyed by source SHA-256 plus the
source path and Scene identity. Manifest and image writes use same-directory
atomic replacement; a new manifest is published before old images are collected.
Startup removes orphan images and interrupted temporary writes. The cache survives
Studio restarts and is removed through a validated same-root quarantine when its
workspace is unregistered; it is not part of Python source or project history.

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
- `GET /api/manim/projects/:projectId/thumbnail/status` safely inspects the first
  importable Scene and reports `current`, `stale`, `missing`, `generating`, `failed`,
  or `unavailable`, together with whether the served image is rendered, semantic,
  or empty. `missing` means discovery succeeded but found no Scene; `unavailable`
  means the workspace root could not be inspected.
- `GET /api/manim/projects/:projectId/thumbnail` returns the source-matching cached
  PNG when one exists. Otherwise it returns the bounded semantic SVG derived from
  current imported object state, or a safe empty SVG when no Scene is available.
  Neither GET endpoint starts Manim or executes project Python.
- `POST /api/manim/projects/:projectId/thumbnail/generate` is the explicit execution
  boundary. It renders the first importable Scene's last frame in an isolated
  temporary copy with `--output_file poietra-thumbnail` and accepts only a strict
  `application/json` `{}` request. Cross-origin browser requests are rejected.
  Studio publishes only the exact `poietra-thumbnail.png` after Manim exits
  successfully. Opening a workspace invokes this boundary only after the user selected that workspace,
  only when the renderer is available, and only while the cache is not current.
  Successful source Commit and Undo also request a refresh. Merely viewing the
  launcher never invokes it.
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

The ownership and evidence rules for static facts, Studio markers, Runtime Trace,
and fail-closed editing are defined by
[ADR 0001](adr/0001-studio-owned-source-analysis.md). Source analysis is a Studio
editing responsibility; it is not implemented as a Studio mode in `manim-lint`.

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
- thumbnail generation uses the same direct-spawn, timeout, process-group stop,
  bounded traversal, and isolated temporary-source boundary. Thumbnail jobs share
  the per-project concurrent-render limit with validation renders;
- a generated thumbnail is current only while its persisted source hash, source
  path, and Scene identity match the safely rediscovered target. A failed generation
  for a changed source uses the current semantic SVG; a failed refresh of the same
  source remains visibly `failed` while serving its last successful rendered frame;
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
- source discovery still uses a transitional conservative parser for Scene,
  assignment, play, wait, and marker facts. ADR 0001 requires migration to AST
  source occurrences plus optional Runtime Trace; until then dynamic control flow
  and updater-driven geometry remain unknown;
- preview and Undo evidence is retained in memory for 30 minutes and temporary
  media is then removed automatically; durable project history remains future
  product work;
- desktop shells still use a path field for existing folders and should replace it
  with their native OS directory picker;
- the bridge is a local development experiment, not a remotely exposed render
  service or Python sandbox.
- one workspace card currently represents the first importable Scene in sorted
  source traversal order; choosing another Scene for the card is future metadata.

These limits are visible blockers. The pipeline never substitutes a fixture video
or marks illustrative lowering as rendered validation when Manim is unavailable.
