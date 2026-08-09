# Real-Manim census regeneration

The active v1 and v2 manifests are valid only when the verified fast-manim
checkout, the Python environment that imports it, the identity injected into
the Runtime Trace producer, and the Studio trust anchor name the same commit
and tree. The reproduced v2 baseline uses that active identity. The checked-in
v1 baseline is a historical compatibility floor and remains bound to its
original producer through
`fixtures/real-manim-editability-census-v1/playback-manifest.json`; it must not
be relabelled as a run of the active manifest.

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

`uv sync` alone is not a complete V1 producer environment. Profiles 3, 5, 7,
11, and 12 also require the native `poietra_mathtex_outline` extension. The
pinned fast-manim checkout deliberately does not declare or build that Studio
artifact, and its snapshot producer fails closed when the extension is absent.

Before treating a V1 run as regeneration evidence, pin and verify the Studio
engine commit and tree, the extension SHA-256 and ABI, and the font/toolchain
digests, then install that exact native artifact into the same Python
interpreter used by both producer commands. Production promotion of that
artifact is tracked by existing Issue #280. Until its non-zero artifact pin and
reproduction path are available, do not use `--update` and do not relabel the
previous V1 measurements with the new producer digest.

The historical V1 baseline cannot be verified by running the active manifest:
the producer identities intentionally differ. Its archived playback manifest
exists only to preserve the provenance and editability floor of those earlier
measurements. After the native-provider prerequisite is complete, run the
active manifest without writing evidence first:

```sh
pnpm census:manim --fast-manim-root /work/fast-manim
```

That command compares the active run with the historical compatibility floor
without writing evidence. A producer-pin difference alone is allowed, but all
previously accepted cases must remain accepted, fallback must not become
rejection, and aggregate acceptance floors and rejection ceilings must hold.
The currently missing native provider causes that comparison to fail because
previously accepted cases are lost.

Only after a successful comparison and intentional review of the producer
repin, write the new evidence. Update mode enforces the same historical floor
before replacing the baseline:

```sh
pnpm census:manim --update --fast-manim-root /work/fast-manim
```

The update is valid only after the native-provider prerequisite above has been
met. A provider-absent run is useful fail-closed evidence, but it is not a basis
for lowering the accepted-case floor.

The real test verifies the checkout commit, tree, cleanliness, repository
digest, source bytes, exact `.venv/bin/python` command, imported `manim` module
path, and producer modules before executing a producer. It derives the Runtime
Trace environment from the manifest and rejects it unless that identity also
matches Studio's trust anchor.

The v1 lane runs one producer case at a time with a 300-second deadline for
each case; the complete Vitest case has a 15-minute deadline. This avoids
turning host process pressure into misleading compatibility evidence as the
pinned Runtime Trace producer grows.

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

V2 target selection remains specific to an observed generic Runtime Trace
fallback. If the producer now accepts every generic preview, the report records
`selectedCodebaseId: null` with `generic-runtime-trace-gap-not-observed` rather
than relabelling the improvement as a gap. If a fallback exists but none is a
safe eligible target, it records
`safe-generic-runtime-trace-target-not-observed`. Rejected previews,
unrecognized Scenes, failed source execution, unsafe snapshot results, and
incompatible dependencies remain ineligible.
