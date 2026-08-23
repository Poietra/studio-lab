# FourierSeriesSquareWave Runtime Trace evidence v1

`baseline.json` is the reviewable outcome of running the pinned generic
Runtime Trace V3 preview against the pinned FourierSeriesSquareWave source
through the full `FastManimSnapshotRunner` path (producer seal, server
verification, and wire V2 lowering included). It records identities and
bounded evidence only — never the raw multi-megabyte trace.

## Pinned inputs

- Source: `legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py`
  from https://github.com/HarleyCoops/Math-To-Manim.git at
  `fcad0674c9791690d47664492fd1a052024b63a0`
  (tree `d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698`, SHA-256
  `3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72`,
  the same pin as `fixtures/fourier-v3-cairo-reference-v1`).
- Producer: https://github.com/Poietra/fast-manim.git at commit
  `f37b32200eb111678411ca347486779cb73c5e0a`, tree
  `f6c7c196a5e3ff33ff2f5b4f56a2286aa88282f6` — the literal trusted identity
  in `server/fast-manim-runtime-trace-producer-identity.ts`.
- Python environment: CPython `3.13.11`, resolved with fast-manim's committed
  `uv.lock` (SHA-256
  `3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753`)
  using uv `0.9.26` and `uv sync --frozen`. This also builds the native
  source-binding ledger; an unconstrained `pip install -e` is not equivalent
  evidence.
- TeX toolchain: the Scene renders `Tex` labels, so `latex` and `dvisvgm`
  must be on `PATH`. The recorded run used pdfTeX
  `3.141592653-2.6-1.40.29` from TeX Live 2026 and dvisvgm `3.6`, matching
  the Cairo reference.

## Reproduce

Run from the Studio repository root. `latex`, `dvisvgm`, `git`, and `uv`
must already be on `PATH`; a clean Ubuntu host also needs the Cairo/Pango C
build prerequisites used by fast-manim (`build-essential`, `pkg-config`,
`libcairo2-dev`, and `libpango1.0-dev`). The following commands create only a
temporary evidence checkout and use no unresolved revision placeholders:

```bash
POIETRA_FOURIER_EVIDENCE_ROOT="$(mktemp -d /tmp/poietra-fourier-evidence.XXXXXX)"

git clone --filter=blob:none https://github.com/Poietra/fast-manim.git \
  "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim"
git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim" checkout --detach \
  f37b32200eb111678411ca347486779cb73c5e0a
test "$(git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim" rev-parse HEAD)" = \
  f37b32200eb111678411ca347486779cb73c5e0a
test "$(git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim" rev-parse 'HEAD^{tree}')" = \
  f6c7c196a5e3ff33ff2f5b4f56a2286aa88282f6
test "$(sha256sum "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim/uv.lock" | cut -d ' ' -f 1)" = \
  3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753
uv python install 3.13.11
uv sync --frozen --project "$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim" --python 3.13.11

"$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim/.venv/bin/python" - <<'PY'
import importlib.machinery
import _manim_native_snapshot

assert _manim_native_snapshot.__file__.endswith(tuple(importlib.machinery.EXTENSION_SUFFIXES))
PY

git clone --filter=blob:none --no-checkout \
  https://github.com/HarleyCoops/Math-To-Manim.git \
  "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim"
git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim" sparse-checkout init --no-cone
git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim" sparse-checkout set \
  /legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py
git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim" checkout --detach \
  fcad0674c9791690d47664492fd1a052024b63a0
test "$(git -C "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim" rev-parse 'HEAD^{tree}')" = \
  d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698
test "$(sha256sum "$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim/legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py" | cut -d ' ' -f 1)" = \
  3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72
```

Confirm the exact TeX executables, then reproduce and compare against the
committed baseline:

```bash
test "$(latex --version | head -n 1)" = \
  "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)"
test "$(dvisvgm --version)" = "dvisvgm 3.6"

POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND="[\"$POIETRA_FOURIER_EVIDENCE_ROOT/fast-manim/.venv/bin/python\",\"-m\",\"manim.renderer.runtime_trace\"]" \
POIETRA_FOURIER_SOURCE_ROOT="$POIETRA_FOURIER_EVIDENCE_ROOT/Math-To-Manim" \
pnpm exec vitest run server/fast-manim-runtime-trace-fourier.real.test.ts
```

Remove the generated checkout as soon as the comparison is complete. The
prefix and non-symlink checks keep this cleanup scoped to the directory made
by the `mktemp` command above:

```bash
POIETRA_FOURIER_EVIDENCE_CANONICAL="$(realpath -e -- "$POIETRA_FOURIER_EVIDENCE_ROOT")" &&
case "$POIETRA_FOURIER_EVIDENCE_CANONICAL" in
  /tmp/poietra-fourier-evidence.??????)
    test "$POIETRA_FOURIER_EVIDENCE_CANONICAL" = "$POIETRA_FOURIER_EVIDENCE_ROOT" &&
      test "$(dirname -- "$POIETRA_FOURIER_EVIDENCE_CANONICAL")" = /tmp &&
      test ! -L "$POIETRA_FOURIER_EVIDENCE_CANONICAL" &&
      find "$POIETRA_FOURIER_EVIDENCE_CANONICAL" -depth -delete &&
      unset POIETRA_FOURIER_EVIDENCE_CANONICAL POIETRA_FOURIER_EVIDENCE_ROOT
    ;;
  *) echo "Refusing to remove an unexpected evidence root." >&2; false ;;
esac
```

Add `POIETRA_FOURIER_RUNTIME_TRACE_UPDATE=1` to regenerate `baseline.json`
after an intentional producer or source repin. A failed or non-V2 producer
can never replace the baseline. On 2026-08-22, two consecutive frozen runs
produced byte-identical `baseline.json` files with SHA-256
`07558ca2cadd7cb7d6b0500394ed8147b67599a1c359f1a4612d53dfe82e5893`,
visual semantics digest
`c817fdb502a46e6ec2cf47602684e7acc64a9e31ec42599e35ee97752d8f5ef5`,
and trace digest
`99c2455bcd2658378ba10171b257a977c731811a60f64f092b110cbe1dca78fe`.

## What the recorded evidence established (2026-08-09)

- The full preview pipeline verifies the Scene end to end: 870 frames at
  60fps over 14.5s, 7 top-level roots, and a ~28 MiB raw trace inside every
  bounded limit. Multi-root generic V3 previews are already admissible; the
  single-root restriction applies only to the browser edit-candidate
  profile.
- Five of the seven SourceAnalysis candidates receive producer mappings;
  `amplitudes` (not a Mobject) and `final_vector_dot` (a family member,
  not a root) are correctly omitted.
- Every mapped binding reports `updaterStatus: "conflict"`, so under the
  shipped bounded contract this Scene is preview-only with zero edit
  candidates. Issue #536 must either source its editable second Scene
  elsewhere or first refine producer updater-status granularity.
