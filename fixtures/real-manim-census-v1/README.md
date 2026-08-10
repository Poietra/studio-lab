# Real-Manim census v1 environment

`manifest.json` pins the fast-manim producer checkout and `baseline.json`
records the reviewed measurement. Reproducing that measurement needs more
than the pinned checkout; this file records the full environment contract
so a clean host cannot silently regress the accepted floor (#539).

## Producer environment

- Checkout the manifest's fast-manim revision into a clean worktree; the
  census run itself provisions Python with `uv sync --frozen` (CPython and
  all wheels come from fast-manim's committed `uv.lock`).
- **Hermetic MathTex outline provider** (the RaTeX bridge): `uv sync` does
  not install `poietra_mathtex_outline.abi3.so`. Build it from this
  repository and install it into the census venv site-packages:

  ```bash
  cargo build --locked --profile mathtex-python-release \
    --package poietra-mathtex-py --manifest-path engine/Cargo.toml
  cp engine/target/mathtex-python-release/libpoietra_mathtex_outline.so \
    /path/to/fast-manim/.venv/lib/python3.13/site-packages/poietra_mathtex_outline.abi3.so
  ```

  The census preflight imports this module, checks its ABI versions, and
  compiles one bounded expression before any case runs. Without the provider,
  every MathTex-bearing case degrades to
  `unsupported:runtime-semantics-unsupported` and the accepted floor
  regresses by six scenes.
- **TeX toolchain**: `latex` and `dvisvgm` must be on `PATH`. The reviewed
  measurement's versions are recorded by
  `fixtures/fourier-v3-cairo-reference-v1/reference.json`.

## Known bit-reproducibility limits

Runtime-trace hashes in `baseline.json` are byte pins over producer
output, so two environment facts matter beyond the pins above:

- `fast-manim-basic` runtime traces embed the trusted producer identity
  injected by this repository
  (`server/fast-manim-runtime-trace-producer-identity.ts`); trace hashes
  therefore only reproduce from the studio-lab revision that recorded the
  baseline.
- Scenes that evaluate transcendental functions may inherit last-ULP
  differences from the host libm. Treating those differences as a new
  baseline still requires review; the preflight does not attempt to identify
  or pin a host C library.
