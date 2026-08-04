# MathTex default-Manim source profile

Poietra's browser outline compiler accepts a bounded `core-ams` source profile. Acceptance means
both the pinned Manim default `MathTex` template and the RaTeX-native compiler successfully compile
the same source. RaTeX support by itself is not compatibility evidence.

## Positive evidence

[`source-profile.json`](../fixtures/mathtex-manim-parity-v1/source-profile.json) records 15
compile-only cases generated with Manim 0.20.1 from the digest-pinned
`manimcommunity/manim` image. It also records the runtime `latex` and `dvisvgm` versions and a
SHA-256 identity of `config.tex_template.get_texcode_for_expression(...)`. Regenerate it with:

```sh
node scripts/regenerate-mathtex-manim-parity.mjs
```

The profile covers the evidenced lowercase and uppercase Greek commands; fractions, radicals,
limits, integrals, sums, products, and contour integrals; common relations, set and logic symbols;
accents, vectors, selected font commands, named operators including starred `\operatorname*`, and
safe escaped control symbols. The accepted inner environments are `aligned`, `array` with bounded
`l`/`c`/`r`/`|` columns, `matrix`, `bmatrix`, `pmatrix`, and `cases`.
Sized delimiters are limited to the evidenced braces, parentheses, and brackets. The profile also
records the evidenced argument shapes for `\frac`, `\hat`, `\sqrt`, `\text`, `\textbf`, and
`\vec` instead of treating control-name membership as a complete grammar.

The Rust unit test lexes the three-case pinned real-Manim visual corpus together with this matrix
and requires every allowlisted control sequence, environment, sized delimiter, and argument-policy
entry to occur in that checked-in evidence. The native test compiles all 15 cases twice, and the
WASM smoke test requires byte-identical native/WASM responses. The existing three-case SVG/mask
corpus remains the separate visual-similarity gate; compile-only coverage does not claim pixel
parity.

The executable profile has its own canonical, length-framed digest. Its policy revision and digest
are inputs to the MathTex toolchain digest, so changing an accepted token or its bounded argument
grammar invalidates retained artifacts.

The 31-call-site fast-manim support floor is independently pinned to a source commit. Re-run its AST
census against that exact checkout with:

```sh
python3 scripts/verify-fast-manim-mathtex-callsite-corpus.py --repository ../fast-manim
```

## Fail-closed boundary

The profile rejects KaTeX HTML/link extensions, `mhchem` and other package-dependent commands,
custom `TexTemplate` definitions, raw Unicode rejected by the pinned pdfLaTeX template, raw
`#`/`%`/`$`, user-defined macros, unsupported paint commands, modified line breaks, unsupported
array column specifications, malformed command arguments or scripts, mismatched or outer
environments, unavailable glyphs, and geometry above the public bounds. These inputs return
structured `syntax-unsupported` or another bounded fallback instead of being presented as truthful
default-Manim previews.
