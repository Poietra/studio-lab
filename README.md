# Poietra Studio Lab

Disposable, evidence-driven experiments for choosing the Poietra Studio client architecture.

This repository is intentionally separate from the product repository. Its first experiment compares Tauri and Electron by running the same React application and the same representative Studio workload in both shells.

## Scope

- frame-oriented media playback and seeking
- Canvas/WebGL overlays for object picking and ghost trajectories
- Python/Manim process lifecycle
- Runtime IR streaming
- file watching and partial re-render feedback
- development, packaging, memory, and cross-platform behavior

The experiment charter and decision gate live in [docs/shell-evaluation.md](docs/shell-evaluation.md).

The current shared screen also contains a disposable
[drag-interpretation prototype](docs/drag-interpretation-prototype.md). It exists
to examine gesture interpretation from a working canvas, timeline, ghost, and
source diff before EditOperation concepts become protocol contracts. The same
screen now includes a playhead-aware Magic Edit board that can create a
structured motion draft without requiring a drag, or transform one selected
`MathTex` object into new equation content as a distinct timed operation. It can
also create explanatory `Text` beside a selected object with `FadeIn`, including
an explicit playhead-relative anchor such as “5秒前”. Named
equations with a dominant conventional form can be inferred—for example,
“Newtonの運動方程式” becomes a matchable `F = ma` transform—without asking the
user for literal LaTeX. Magic Edit also previews a bounded camera-focus preset,
MathTex-to-explanatory-Text replacement, and new provisional MathTex creation;
the floating Magic Edit board can be dragged across the workspace, hidden, and
restored without losing its instruction or draft preview.

Cross-cutting findings from that screen are maintained separately in the
[Edit operation model memo](docs/edit-operation-model.md). It records the emerging
GestureConstraint → EditOperation → truthful preview → source-lowering boundary,
the role of AI, and the highest-risk unresolved semantics.

The implemented versioned state layers, canonical operation registry, dependency
DAG, pure ProposedState evaluator, transaction rules, and verification boundary are
documented in the [Studio state and operation model](docs/studio-state-operation-model.md).
The first real Manim round trip is documented in the
[rendered validation pipeline](docs/rendered-validation-pipeline.md).

## Commands

```sh
pnpm install
pnpm dev:web
pnpm dev:electron
pnpm dev:tauri
pnpm check:web
pnpm test
cargo check --manifest-path src-tauri/Cargo.toml
```

Magic Edit requires an explicit model endpoint; it never falls back to keyword or
fixture behavior at runtime. Set `VITE_POIETRA_AI_ENDPOINT` to
`/api/ai/edit-suggestions`, provide `OPENAI_API_KEY` in the server environment or
the ignored `.openai-key` file, and optionally select the server-side model with
`POIETRA_OPENAI_MODEL`. The Vite development server uses the Responses API and
returns the same closed `CreateMotion | CreateTransform | CreateExplanation | CreateCameraFocus | CreateEquation | CreateExplainedEquation | CreateTextTransform | CreateSceneTransition | EditProgram`
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

The rendered-validation experiment can lower one straight canonical `CreateMotion`
into a real Manim source marker, render an isolated preview, and commit only after
the video succeeds. Start Studio with a Manim project root and command when they
differ from this checkout and the `manim` executable:

```sh
POIETRA_MANIM_PROJECT_ROOT=/path/to/project \
POIETRA_MANIM_COMMAND='["uv", "run", "manim"]' \
pnpm dev:web
```

If Manim is available through Docker instead, the included runner mounts the
project read-only, mounts only the operating-system preview directory as writable,
and disables container networking:

```sh
POIETRA_MANIM_COMMAND='["node", "scripts/manim-docker-runner.mjs"]' pnpm dev:web
```

Eligible source boundaries use an explicit marker such as
`# poietra:anchor 7.000` inside a Scene method. Studio rejects missing anchors,
curved paths, unknown source variables, stale source hashes, and failed renders
instead of writing an illustrative patch. The included `examples/relativity.py`
provides a minimal `GroupedEquation` Scene with a 7-second anchor.

Linux development requires the [system packages listed by Tauri](https://v2.tauri.app/start/prerequisites/#linux) before `dev:tauri` or `cargo check` can run.
When those packages are not available on the host, the Linux build path can be reproduced in a container:

```sh
docker build --file Dockerfile.linux --tag poietra-studio-lab-linux .
docker run --rm poietra-studio-lab-linux
```

The application code under `src/` is shared without shell-specific branches. Native integration must stay behind a small adapter so the comparison measures the shell rather than two different implementations.

## Status

Experimental. Nothing in this repository is a supported Poietra product API.
