# FourierSeriesSquareWave Cairo reference v1

These seven PNGs are independent Manim/Cairo renders of the source, source
revision, and producer revision pinned in `reference.json`. The generator
rejects dirty or mismatched tracked checkouts and records the renderer,
Python, native Cairo, Pillow, NumPy, TeX, Node PNG encoder, and lockfile
identity used by the run.

Use an absent output path; the generator never overwrites evidence:

```bash
export POIETRA_FOURIER_FAST_MANIM_ROOT=/absolute/path/to/pinned/fast-manim
export POIETRA_FOURIER_SOURCE_ROOT=/absolute/path/to/pinned/Math-To-Manim
export POIETRA_FOURIER_PYTHON=/absolute/path/to/fast-manim/.venv/bin/python
export POIETRA_CAIRO_TEX_BIN=/absolute/path/to/tex/bin
POIETRA_FOURIER_OUTPUT_PARENT="$(mktemp -d /tmp/poietra-fourier-cairo.XXXXXX)"

PATH="$POIETRA_CAIRO_TEX_BIN:$PATH" \
PYTHONHASHSEED=0 \
PYTHONPATH="$POIETRA_FOURIER_FAST_MANIM_ROOT" \
"$POIETRA_FOURIER_PYTHON" scripts/generate-fourier-v3-cairo-reference.py \
  --fast-manim "$POIETRA_FOURIER_FAST_MANIM_ROOT" \
  --source-repository "$POIETRA_FOURIER_SOURCE_ROOT" \
  --output "$POIETRA_FOURIER_OUTPUT_PARENT/reference"
```

Each generated PNG must be byte-identical to the corresponding committed
PNG. `e2e/fourier-v3-cairo-reference.test.ts` additionally pins the canonical
digest of all reference metadata and decoded RGBA bytes.
