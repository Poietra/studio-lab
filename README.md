# Poietra Studio Lab

Disposable, evidence-driven experiments for choosing the Poietra Studio client architecture.

This repository is intentionally separate from the product repository. Its first experiment
compared Tauri and Electron with the same React application and representative Studio
workload. The accepted [desktop shell ADR](docs/shell-evaluation.md) selects Electron for the
first product path while preserving a shell-neutral renderer and service boundary.

## Scope

- frame-oriented media playback and seeking
- Canvas/WebGL overlays for object picking and ghost trajectories
- Python/Manim process lifecycle
- Runtime IR streaming
- file watching and partial re-render feedback
- development, packaging, memory, and cross-platform behavior

The experiment charter and decision gate live in [docs/shell-evaluation.md](docs/shell-evaluation.md).

The current shared screen imports conservative Scene, entity, lifetime, event,
source-identity, and anchor snapshots from the configured Manim workspace. The
canvas, object list, timeline, Inspector, and Magic Edit request all project that
same imported `RuntimeSceneState`; runtime fixture data remains test-only. A
playhead-aware Magic Edit board can create a structured motion draft without
requiring a drag, or transform one selected `MathTex` object into new equation
content as a distinct timed operation. It can also create explanatory `Text`
beside a selected object with `FadeIn`, including an explicit playhead-relative
anchor such as “5秒前”. Named
equations with a dominant conventional form can be inferred—for example,
“Newtonの運動方程式” becomes a matchable `F = ma` transform—without asking the
user for literal LaTeX. Browser previews typeset the canonical MathTex `texParts`
with KaTeX and safely fall back to display text when an expression is unsupported.
Edit Programs can sequence a new equation or atomic equation-plus-explanation macro
before a Scene-level cover-and-reveal transition, then Apply or Undo the composite as
one transaction. The Scene boundary points to the actual next imported Scene, whose
objects replace the outgoing composition at full cover. Magic Edit also previews a bounded camera-focus preset,
MathTex-to-explanatory-Text replacement, and new provisional MathTex creation;
the floating Magic Edit board can be dragged across the workspace, hidden, and
restored without losing its instruction or draft preview.

The web editor also has a workspace launcher that creates a ready-to-edit managed
Manim workspace from a name alone, an
Insert toolbar for Text, MathTex, Rectangle, Circle, Line, and Arrow objects, and
PowerPoint-style select/copy/paste/duplicate/delete/undo/redo shortcuts. New motion
duration is editable, its quadratic Bézier path and control handle are projected
from executable operation data, and Scene duration can be extended at a safe source
anchor. Sequential Edit Programs may transform the same logical MathTex more than
once, rebinding each step to the preceding replacement identity.

Cross-cutting findings from that screen are maintained separately in the
[Edit operation model memo](docs/edit-operation-model.md). It records the emerging
GestureConstraint → EditOperation → truthful preview → source-lowering boundary,
the role of AI, and the highest-risk unresolved semantics.

The implemented versioned state layers, canonical operation registry, dependency
DAG, pure ProposedState evaluator, transaction rules, and verification boundary are
documented in the [Studio state and operation model](docs/studio-state-operation-model.md).
The first real Manim round trip is documented in the
[rendered validation pipeline](docs/rendered-validation-pipeline.md).
The ownership boundary between Studio source analysis, Runtime Trace, Studio
markers, and the independent `manim-lint` project is recorded in
[ADR 0001](docs/adr/0001-studio-owned-source-analysis.md).

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev:web
pnpm dev:electron
pnpm package:electron
pnpm test:electron-packaged
pnpm dev:tauri
pnpm evaluate:shell:native
pnpm evaluate:shell:serve
pnpm check:web
pnpm check:style # zero-warning lint plus incremental format check
pnpm test:unit
pnpm test:integration
pnpm test # all unit and boundary/integration tests
pnpm exec playwright install chromium webkit # first E2E run only
pnpm test:e2e
pnpm test:e2e:webkit-smoke
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Pull requests run the same build, unit, boundary/integration, browser, and Tauri
checks in GitHub Actions. The stable required-check names are `Style checks`,
`Web build`, `Unit and integration tests`, `Browser E2E`, and `Tauri cargo check`.
Playwright diagnostics are retained as a workflow artifact when the browser job
reaches its test step.

Biome provides the TypeScript/React lint and formatting baseline. Run `pnpm lint:fix`
for safe lint fixes and `pnpm format` to format files changed from the pull request
base (or `main` locally); `pnpm lint`, `pnpm format:check`, and the combined
`pnpm check:style` never write files.
The incremental format scope includes committed, staged, unstaged, and untracked files,
preventing a one-time rewrite of untouched source. CI fetches full history and passes
the pull request base SHA or push event's previous SHA to `pnpm check:style`.

The suite boundaries and the rule for adding regression coverage are documented in
[the testing strategy](docs/testing-strategy.md).

Magic Edit requires an explicit model endpoint; it never falls back to keyword or
fixture behavior at runtime. Set `VITE_POIETRA_AI_ENDPOINT` to
`/api/ai/edit-suggestions`, provide `OPENAI_API_KEY` in the server environment or
the ignored `.openai-key` file, and optionally select the server-side model with
`POIETRA_OPENAI_MODEL`. The Vite development server uses the Responses API and
returns the same closed `CreateMotion | CreateTransform | CreateExplanation | CreateCameraFocus | CreateEquation | CreateExplainedEquation | CreateTextTransform | CreateSceneTransition | ScaleObjects | DeleteObjects | EditProgram`
suggestion result documented in
`src/ai/edit-suggestions.ts`. Provider credentials never use a `VITE_` variable and
are not included in the browser bundle.
Clarification responses may include two or three structured choices. Studio keeps
the original request, up to four resolved question/answer turns, and the current
pending question. A choice click, a relative answer such as `前者`, or a short
answer such as `はい` therefore reaches the model with the decisions that preceded
it instead of becoming an isolated prompt.

The development API writes correlated lifecycle events to stdout and full structured
events to the ignored `.studio-logs/ai-edit-suggestions.jsonl` file. Each request
receives an `x-poietra-request-id`, and the file records the validated model input,
instructions, parsed model output, usage, and final HTTP response under that ID. It rotates
to `.previous` at 2 MiB, is created with user-only permissions, and can contain
editor content; do not publish it. Set `POIETRA_AI_DEBUG_LOG` to another local path
or to `off` to disable this debug logging. Provider credentials are never supplied
to the logger, and common credential-shaped fields are redacted by the logging
layer.

The rendered-validation experiment lowers a complete canonical `EditProgram` at an
explicit safe source marker. Straight or quadratic Bézier motion, position,
MathTex/Text/basic-shape creation, relative placement, FadeIn/removal, chained
content transforms, explicit waits, and cover-and-reveal Scene boundaries can share
one isolated Manim preview and guarded source commit. Start
Studio with a Manim project root and command when they differ from this checkout and
the `manim` executable:

```sh
POIETRA_MANIM_PROJECT_ROOT=/path/to/project \
POIETRA_MANIM_COMMAND='["uv", "run", "manim"]' \
pnpm dev:web
```

Multiple roots can be seeded before the first launch. `POIETRA_MANIM_PROJECTS` is a JSON array of root strings or
`{"id":"project-a","name":"Display name","root":"/path"}` objects; the legacy
single-root variable remains the fallback. On first start these values seed the local
`.poietra/workspace-catalog.json`. In a browser, Add workspace asks only for a name
and creates an importable `MainScene` under `.poietra/.workspaces`. Electron uses a
native directory picker for existing folders and a native Save dialog for `.py`
exports in the packaged app; neither operation exposes an absolute path to the renderer.
`pnpm dev:electron` deliberately leaves the native bridge disabled and uses Vite's
existing-folder registration form instead. Tauri retains that form while it remains
an evaluation shell. The launcher can rename or remove either registration
persistently. Removing an existing-folder workspace only unregisters it, leaving
its folder and Python files in place. Removing a browser-managed workspace moves
its directory to Studio Trash at `.poietra/.trash` instead of permanently deleting
it; Studio does not yet provide a UI for restoring trashed workspaces. Set
`POIETRA_STUDIO_DATA_ROOT` to relocate the private catalog, browser-managed
workspace content, and Studio Trash. The local server remains bound to loopback,
validates every registered folder with `realpath`, and never returns filesystem
roots in API responses.

`pnpm package:electron` builds the web renderer and Electron main process, then
assembles a host-platform application under `release/electron-<platform>-<arch>`.
The command explicitly runs Electron's runtime installer first, so a clean pnpm
checkout downloads the host runtime before packaging instead of depending on a
previous lifecycle-script side effect.
The packaged app starts the same workspace/render/export service on a random loopback
port. A per-launch capability is injected below the renderer API boundary, and the
window denies new windows, cross-origin navigation, webviews, and permission requests.
This output is a development package, not a signed installer. `pnpm
test:electron-packaged` launches that exact output headlessly and covers native folder
selection, workspace CRUD, render/video, export/save, commit/undo/discard, and shutdown.

Studio starts at a workspace chooser. Visible cards lazily parse only the first
importable Scene into a bounded semantic SVG thumbnail; this does not execute
Manim or import the rest of the project, and failures retain the metadata cover.
The complete workspace is imported only after it is opened. Returning to the
chooser keeps each Scene's in-memory editor session available for the next open.
The project-bound export API does not require Manim and never writes the source
file. Before the first edit, `Export .py` downloads the selected Scene's Python
source unchanged. Once an edit exists, it exports the result of canonical lowering
after the same validation and stale-source checks used by rendered validation.

If Manim is available through Docker instead, the included runner mounts the
project read-only, mounts only the operating-system preview directory as writable,
and disables container networking:

```sh
POIETRA_MANIM_COMMAND='["node", "scripts/manim-docker-runner.mjs"]' pnpm dev:web
```

Run the fixed real-render smoke fixture with the same Docker adapter used by the
scheduled and manually dispatched CI workflow:

```sh
pnpm test:manim-smoke
```

The smoke test renders and decodes an MP4 with the pinned image, commits and
exactly undoes the lowered source, and verifies that both project and render
temporary directories are removed. It also interrupts a live render to verify
that the Vitest process tree, owned Docker container, temporary files, and
artifact writers have all stopped before the runner exits. Its MP4, decoded
media metadata, source hashes, cleanup result, and captured Vitest/Manim log are
written under `test-results/manim-smoke/`. Set `POIETRA_MANIM_COMMAND` to use a
local Manim installation and `POIETRA_MANIM_FFPROBE_COMMAND` when its `ffprobe`
binary is not available on `PATH`.

Eligible source boundaries use an explicit marker such as
`# poietra:anchor 5.000` inside a Scene method. Studio rejects missing anchors,
unknown source variables, stale source hashes, unsupported overlap or camera
operations, invalid next-Scene destinations, and failed renders instead of writing
an illustrative patch. Committed
generated entities carry data-only `poietra:entity` markers, so a subsequent import
recovers their Studio identity and Python binding. Scene changes carry an explicit
boundary marker and terminate the outgoing construct after revealing the imported
next composition. The included `examples/relativity.py` provides two ordered Scenes
and safe 5- and 7-second anchors.

Linux development requires the [system packages listed by Tauri](https://v2.tauri.app/start/prerequisites/#linux) before `dev:tauri` or `cargo check` can run.
When those packages are not available on the host, the Linux build path can be reproduced in a container:

```sh
docker build --file Dockerfile.linux --tag poietra-studio-lab-linux .
docker run --rm poietra-studio-lab-linux
```

The application code under `src/` is shared without shell-specific branches. Native integration must stay behind a small adapter so the comparison measures the shell rather than two different implementations.

## Status

Experimental. Nothing in this repository is a supported Poietra product API.
