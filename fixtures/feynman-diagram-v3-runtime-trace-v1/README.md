# FeynmanDiagram editable Runtime Trace evidence v1

`baseline.json` selects a second real Manim Scene for the generic Studio edit
path. The evidence comes from the pinned Runtime Trace V3 producer, not from a
static source heuristic. It stores only bounded identities, endpoint facts,
capabilities, and digests; the raw trace is not committed.

## Selection outcome

The selected Scene is `FeynmanDiagram` from Math-To-Manim. The real producer
establishes all of the properties needed by #536 and #510:

- generic Runtime Trace V3 verifies end to end and lowers through the negotiated
  wire V2 response into a one-second, 60-frame Scene IR;
- SourceAnalysis projects four unambiguous construct-local assignments in
  source order: `electron1`, `electron2`, `photon`, and `labels`;
- the producer maps those bindings to four distinct top-level runtime roots with
  exact source-binding IDs;
- every mapped root reports `updaterStatus: "none"`;
- every binding retains both `move: "source-eligible"` and
  `uniformResize: "source-eligible"` in the exact SourceAnalysis used to create
  the producer request; and
- the same pinned Python/Manim/TeX environment renders an independent Cairo
  854x480 last frame, so #510 can capture base and edited Cairo references
  without changing projects or dependencies.

This is deliberately a selection fixture, not proof that multi-binding target
selection is already implemented. The currently shipped generic edit lowering
still requires exactly one projected binding. Issue #536 must make the selected
binding explicit without granting authority to its siblings.

## Why this Scene

| Candidate | Real evidence | Decision |
| --- | --- | --- |
| `FourierSeriesSquareWave` | #538 verifies five mapped bindings, all with `updaterStatus: "conflict"` | Preview-only; cannot truthfully authorize a source edit. |
| `FeynmanDiagram` | This fixture verifies four distinct roots and four updater-free bindings | Selected: smallest real multi-root Scene that exercises #536 and remains useful for visible move/resize review. |
| Other updater-free classes in the same pin | Source-level shortlist only | Not promoted after the smaller selected Scene satisfied the discriminating contract; they are not treated as negative Runtime Trace evidence. |

The source-wide import of `random` is inert for this Scene. `FeynmanDiagram`
constructs only three cubic paths and one MathTex label group, and contains no
updater, `ValueTracker`, `always_redraw`, camera mutation, external asset, or
project-local import.

## Pinned inputs

- Source repository: https://github.com/HarleyCoops/Math-To-Manim.git at
  `fcad0674c9791690d47664492fd1a052024b63a0`, tree
  `d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698`.
- Source path:
  `legacy/Math-To-Manim/examples/physics/quantum/Hunyuan-T1QED.py`, SHA-256
  `50588cf26a63b955f59c0411886f1781276c59c8cd5ad65963dc9c56759a5e9f`.
- Producer repository: https://github.com/Poietra/fast-manim.git at
  `f37b32200eb111678411ca347486779cb73c5e0a`, tree
  `f6c7c196a5e3ff33ff2f5b4f56a2286aa88282f6`.
- Python environment: CPython `3.13.11` with fast-manim's committed `uv.lock`,
  SHA-256
  `3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753`,
  resolved by uv `0.9.26` using `uv sync --frozen --no-dev`.
- TeX environment: pdfTeX
  `3.141592653-2.6-1.40.29 (TeX Live 2026)` and dvisvgm `3.6`.

An extension module merely ending in `.so` is insufficient. The reproduction
check below also requires the three native source-binding ledger entry points;
this prevents an older cached fast-manim extension from silently turning a real
producer run into false evidence.

## Reproduce

Run from the Studio repository root. The commands use exact detached revisions
and create both external checkouts under one temporary directory.

```bash
POIETRA_SECOND_SCENE_EVIDENCE_ROOT="$(mktemp -d /tmp/poietra-second-scene-evidence.XXXXXX)"

git clone --filter=blob:none https://github.com/Poietra/fast-manim.git \
  "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim"
git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim" checkout --detach \
  f37b32200eb111678411ca347486779cb73c5e0a
test "$(git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim" rev-parse HEAD)" = \
  f37b32200eb111678411ca347486779cb73c5e0a
test "$(git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim" rev-parse 'HEAD^{tree}')" = \
  f6c7c196a5e3ff33ff2f5b4f56a2286aa88282f6
test "$(sha256sum "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim/uv.lock" | cut -d ' ' -f 1)" = \
  3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753

UV_PROJECT_ENVIRONMENT="$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim-venv" \
  uv sync --frozen --no-dev \
  --project "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim" \
  --python 3.13.11

"$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim-venv/bin/python" - <<'PY'
import importlib.machinery
import _manim_native_snapshot as native

assert native.__file__.endswith(tuple(importlib.machinery.EXTENSION_SUFFIXES))
assert callable(native._create_runtime_trace_source_binding_capture)
assert callable(native._bind_runtime_trace_source_binding_capture)
assert callable(native._runtime_trace_source_binding_capture_values)
PY

git clone --filter=blob:none --no-checkout \
  https://github.com/HarleyCoops/Math-To-Manim.git \
  "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim"
git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim" sparse-checkout init --no-cone
git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim" sparse-checkout set \
  /LICENSE \
  /legacy/Math-To-Manim/examples/physics/quantum/Hunyuan-T1QED.py
git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim" checkout --detach \
  fcad0674c9791690d47664492fd1a052024b63a0
test "$(git -C "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim" rev-parse 'HEAD^{tree}')" = \
  d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698
test "$(sha256sum "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim/legacy/Math-To-Manim/examples/physics/quantum/Hunyuan-T1QED.py" | cut -d ' ' -f 1)" = \
  50588cf26a63b955f59c0411886f1781276c59c8cd5ad65963dc9c56759a5e9f
```

Point `POIETRA_CAIRO_TEX_BIN` at the pinned TeX executables, then run the
environment-gated test twice. The first command compares to the committed
fixture; the second is intentionally identical and proves consecutive-run
stability.

```bash
export POIETRA_CAIRO_TEX_BIN=/absolute/path/to/TinyTeX/bin/x86_64-linux
export POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND="[\"$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/fast-manim-venv/bin/python\",\"-m\",\"manim.renderer.runtime_trace\"]"
export POIETRA_SECOND_EDITABLE_SCENE_SOURCE_ROOT="$POIETRA_SECOND_SCENE_EVIDENCE_ROOT/Math-To-Manim"

PATH="$POIETRA_CAIRO_TEX_BIN:$PATH" \
  pnpm exec vitest run server/fast-manim-runtime-trace-feynman.real.test.ts
PATH="$POIETRA_CAIRO_TEX_BIN:$PATH" \
  pnpm exec vitest run server/fast-manim-runtime-trace-feynman.real.test.ts
```

Use `POIETRA_SECOND_EDITABLE_SCENE_UPDATE=1` only after an intentional reviewed
repin. Failed, conflicted, duplicate-root, non-V2, or source-mismatched outcomes
cannot replace the baseline.

After the run, remove the temporary checkouts. The prefix, parent, and symlink
checks keep cleanup scoped to the directory created above.

```bash
POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL="$(realpath -e -- "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT")" &&
case "$POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL" in
  /tmp/poietra-second-scene-evidence.??????)
    test "$POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL" = "$POIETRA_SECOND_SCENE_EVIDENCE_ROOT" &&
      test "$(dirname -- "$POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL")" = /tmp &&
      test ! -L "$POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL" &&
      find "$POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL" -depth -delete &&
      unset POIETRA_SECOND_SCENE_EVIDENCE_CANONICAL POIETRA_SECOND_SCENE_EVIDENCE_ROOT
    ;;
  *) echo "Refusing to remove an unexpected evidence root." >&2; false ;;
esac
```

## Recorded result

Two consecutive frozen runs on 2026-08-22 produced identical evidence:

- baseline SHA-256:
  `f636c4b402438cc5386bde8f1e3ca3cecacdfd4f017809155d7c4e93ae53ed14`;
- Runtime Trace digest:
  `a52227459039b7d60c451b58fa1e449b6fd1a4b3806f457d4e7f86e21b7f6292`;
- visual-semantics digest:
  `44d98aa3274efed2b5ed341a17278b23b3092005503b260c49747d2559ea096e`;
  and
- Cairo last-frame PNG: 10,641 bytes, SHA-256
  `d3eecdd445a72679be8437fa2bfa1d5f670846bb211b8decf115dc2b803373ad`.
