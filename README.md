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
The default-off fast-manim execution boundary and its remaining production
dependencies are documented in the
[sandbox backend runbook](docs/fast-manim-sandbox-backend.md).
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
pnpm test:third-party-notices
pnpm test # all unit and boundary/integration tests
pnpm exec playwright install chromium webkit # first E2E run only
pnpm test:e2e
pnpm test:e2e:webkit-smoke
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Pull requests always run style and change-scope checks, then select only the
Engine, WASM, web, unit/integration, storage, Chromium, or Electron lanes affected by the
patch. `CI gate` is the stable required-check name; it accepts intentionally
skipped lanes and fails when any selected lane fails or is cancelled.

Pushes to `main` and manual runs execute the complete matrix, including the
packaged Electron smoke, WebKit, retained WebGPU previews, and native/browser
visual parity. The former Tauri prototype is checked only when its retained
experiment changes; it is not a product gate. Real Manim remains a manual
pre-release smoke because it tests an external renderer.
Playwright diagnostics are retained as workflow artifacts when browser jobs
reach their test steps.

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
fixture behavior at runtime. For loopback development, set `VITE_POIETRA_AI_ENDPOINT`
to `/api/ai/edit-suggestions`, inject `OPENAI_API_KEY` into the actual server process
environment, and optionally select the server-side model with
`POIETRA_OPENAI_MODEL`. Vite may parse dotenv files while loading public settings,
but a dotenv `OPENAI_API_KEY` is never adopted as API configuration or exposed in
diagnostics or the browser bundle; only the actual server process environment supplies
that credential. Server-only `POIETRA_` settings are also read from an explicit
non-secret process-environment allowlist; ordinary `VITE_` browser settings retain
Vite's dotenv behavior. Without both the endpoint and injected credential, Magic Edit
does not call the provider. Enabling it prints a fixed warning that editor context is
sent to the configured remote model.

The legacy repository-root `.openai-key` fallback is disabled by default. It can be
used only by the loopback development server when both the endpoint above and the
process-environment flag `POIETRA_AI_LOCAL_KEY_FILE_OPT_IN=1` are present; this path
prints an explicit fallback warning. Test, staging, and production modes never
read that file even if the flag is set. Production injects an already-constructed AI
adapter from its secret provider or process environment, then routes requests through
the same authenticated principal and tenant registry used by the Manim API. The Vite
development server uses the Responses API and returns the same closed
`CreateMotion | CreateTransform | CreateExplanation | CreateCameraFocus | CreateEquation | CreateExplainedEquation | CreateTextTransform | CreateSceneTransition | ScaleObjects | DeleteObjects | EditProgram`
suggestion result documented in
`src/ai/edit-suggestions.ts`. Provider credentials never use a `VITE_` variable and
are not included in the browser bundle.
Clarification responses may include two or three structured choices. Studio keeps
the original request, up to four resolved question/answer turns, and the current
pending question. A choice click, a relative answer such as `前者`, or a short
answer such as `はい` therefore reaches the model with the decisions that preceded
it instead of becoming an isolated prompt.

By default, the development API writes privacy-safe lifecycle events to stdout and
to a per-workspace file below the operating system's temporary directory, outside
the Vite project root. Each request receives an
`x-poietra-request-id`; telemetry is limited to a bounded request ID, keyed opaque
tenant/principal correlations, latency and HTTP status, fixed lifecycle event names,
and numeric token counters when available.
Prompts, source/object context, clarification content, model instructions and output,
provider response IDs, response bodies, error messages, tracebacks, and absolute log paths
are not recorded. Authenticated tenant and principal scopes each have bounded rate and
concurrency admission. Request quota is consumed after authentication and tenant lookup,
before the JSON body is read; only a schema-valid request can reserve generation capacity.
Client disconnects and generation deadlines abort the provider request, but the capacity
reservation remains held until the provider promise actually settles, including when an
adapter ignores cancellation. Provider adapters receive request data and an abort signal,
never the structured logger; the handler validates their narrow result telemetry before
emitting fixed events. The file rotates to `.previous` at 2 MiB and is created with
user-only permissions. Set `POIETRA_AI_DEBUG_LOG` in the process environment to use
another local path. Setting it to `off` disables both the file sink and the bounded stdout
telemetry.

Logs created by an older Studio version may still contain editor or provider payloads.
Treat both the active JSONL file and `.previous` as sensitive historical data: do not
publish them, and explicitly archive or delete them according to the workspace owner's
retention policy before relying on the new telemetry boundary.

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
It requires `wasm-pack 0.15.0` and builds the canonical engine and MathTex WASM
artifacts as part of a clean package.
The command explicitly runs Electron's runtime installer first, so a clean pnpm
checkout downloads the host runtime before packaging instead of depending on a
previous lifecycle-script side effect.
The packaged app starts the same workspace/render/export service on a random loopback
port. A per-launch capability is injected below the renderer API boundary, and the
window denies new windows, cross-origin navigation, webviews, and permission requests.
This output is a development package, not a signed installer. `pnpm
test:electron-packaged` launches that exact output headlessly and covers native folder
selection, workspace CRUD, render/video, export/save, commit/undo/discard, and shutdown.

Web and packaged Electron distributions expose the canonical font license notice at
`/THIRD_PARTY_NOTICES.txt`. The standalone server distribution places the same file
beside `manim-production-server.mjs`. Its source of truth is the MathTex outline
crate's `PACKAGE-LICENSES.txt`; the build and package smoke checks require byte-identical
copies and verify the RaTeX revision, complete 19-face runtime-reachable KaTeX font
manifest, and aggregate font attestation. The MathTex crate's unit test independently
recomputes that SHA-256 from the exact faces staged from the pinned
`ratex-katex-fonts` build dependency and embedded in the runtime artifact. The
gated snapshot OCI image installs
the same byte-identical notice at
`/usr/share/doc/poietra-mathtex-outline/THIRD_PARTY_NOTICES.txt` and binds its
SHA-256 into the admitted image labels.

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
