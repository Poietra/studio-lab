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
  (SHA-256 `3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72`,
  the same pin as `fixtures/fourier-v3-cairo-reference-v1`).
- Producer: the trusted fast-manim identity in
  `server/fast-manim-runtime-trace-producer-identity.ts`.
- TeX toolchain: the Scene renders `Tex` labels, so `latex` and `dvisvgm`
  must be on `PATH` (the recorded run used TeX Live 2026 with dvisvgm 3.6,
  matching the dvisvgm version pinned by the Cairo reference). The trace
  digest is tied to this toolchain identity, exactly like the Cairo
  reference PNGs.

## Reproduce

Prerequisites (once per machine; the second command needs no sudo):

```bash
git -C /path/to/fast-manim worktree add /path/to/fast-manim-pinned <trusted fastManimCommit> \
  && python3 -m venv /path/to/fast-manim-pinned/.venv \
  && /path/to/fast-manim-pinned/.venv/bin/pip install -e /path/to/fast-manim-pinned
git clone --filter=blob:none https://github.com/HarleyCoops/Math-To-Manim.git /path/to/math-to-manim \
  && git -C /path/to/math-to-manim checkout fcad0674c9791690d47664492fd1a052024b63a0
```

An editable install shadows `PYTHONPATH`, so the pinned worktree must own
its venv; do not point a development venv at the worktree.

Reproduce and compare against this baseline with one command:

```bash
PATH="$HOME/.TinyTeX/bin/x86_64-linux:$PATH" \
POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND='["/path/to/fast-manim-pinned/.venv/bin/python","-m","manim.renderer.runtime_trace"]' \
POIETRA_FOURIER_SOURCE_ROOT=/path/to/math-to-manim \
pnpm vitest run server/fast-manim-runtime-trace-fourier.real.test.ts
```

Add `POIETRA_FOURIER_RUNTIME_TRACE_UPDATE=1` to regenerate `baseline.json`
after an intentional producer or source repin. The run takes about 2.5
minutes and back-to-back runs reproduce the identical trace digest.

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
