# Real-Manim census regeneration

The checked-in v1 and v2 census evidence is valid only when the fast-manim checkout, the identity injected into the Runtime Trace producer, and the Studio trust anchor name the same commit and tree.

Current producer identity:

- repository: `https://github.com/Poietra/fast-manim.git`
- commit: `d24026e11fbf30fa820593e1f0c59dd02ea82c25`
- tree: `93a1467e7d6ba23e9fac5baf827523ae893b6267`
- repository digest: `3127902f233906cfd70b75097ac8ae507b7f827e220697808c257a1b6399a747`

Both real census lanes require Linux because the verified source reader deliberately fails closed on unsupported platforms. Use an x86-64 clean checkout with Git, Node 24, pnpm 10.23.0, uv 0.12.3, Python 3.13.11, Manim 0.20.1, ffmpeg, LaTeX, and dvisvgm. Do not regenerate evidence from a dirty checkout.

## V1 compatibility census

Prepare the exact fast-manim checkout and its frozen environment:

```sh
git clone https://github.com/Poietra/fast-manim.git /work/fast-manim
git -C /work/fast-manim checkout --detach d24026e11fbf30fa820593e1f0c59dd02ea82c25
test "$(git -C /work/fast-manim rev-parse HEAD^{tree})" = 93a1467e7d6ba23e9fac5baf827523ae893b6267
test -z "$(git -C /work/fast-manim status --porcelain)"
uv sync --frozen --python 3.13.11 --project /work/fast-manim
```

Verify the existing baseline:

```sh
pnpm census:manim --fast-manim-root /work/fast-manim
```

Regenerate it after an intentional producer repin:

```sh
pnpm census:manim --update --fast-manim-root /work/fast-manim
```

The real test verifies the checkout commit, tree, cleanliness, repository digest, source bytes, and producer modules before executing a producer. It derives the Runtime Trace environment from the manifest and rejects it unless that identity also matches Studio's trust anchor.

The v1 lane runs producer cases one at a time with a five-minute per-case deadline. This avoids turning host process pressure into misleading compatibility evidence as the pinned Runtime Trace producer grows.

## V2 project census

In addition to the producer checkout, prepare clean exact checkouts for every `codebases` entry in `fixtures/real-manim-census-v2/manifest.json`. The roots object must contain exactly `producer`, `math-to-manim`, `manim-ml`, and `manim-slides`.

```sh
export POIETRA_CAIRO_TEX_BIN=/usr/bin
export POIETRA_REAL_MANIM_PROJECT_CENSUS_ROOTS='{
  "producer":"/work/fast-manim",
  "math-to-manim":"/work/math-to-manim",
  "manim-ml":"/work/manim-ml",
  "manim-slides":"/work/manim-slides"
}'
export POIETRA_REAL_MANIM_PROJECT_CENSUS_REQUIRED=1

pnpm exec vitest run scripts/run-real-manim-project-census.real.test.ts
```

To rewrite the v2 baseline after an intentional repin, also set `POIETRA_REAL_MANIM_PROJECT_CENSUS_UPDATE=1`. Review every changed artifact digest. A new manifest digest alone is not evidence that the real producer ran successfully.

The v2 target remains eligible when its generic Runtime Trace preview advances from a safe fallback to accepted evidence. Rejected previews, unrecognized Scenes, failed source execution, unsafe snapshot results, and incompatible dependencies remain ineligible. The report records whether selection used an observed gap or an accepted preview so that a producer capability improvement cannot stop baseline regeneration or be mislabeled as a gap.
