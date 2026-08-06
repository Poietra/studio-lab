# Real Manim project census v2

This corpus measures three pinned MIT-licensed projects with a pinned fast-manim producer. The source-runtime identity snapshot probe uses profile V2; generic Runtime Trace is measured independently. It does not replace census v1: v1 has 7 accepted compatibility scenes but only 7 accepted and 49 fallback profile attempts, plus two Scene-specific editability profiles.

The required run produced two distinct kinds of preview evidence:

- the generic Runtime Trace entry point safely fell back for all three Scenes with `unsupported-profile`;
- the separate profile-V2 snapshot probe safely fell back with `animation-evidence-incomplete` for Math-To-Manim and ManimML, while manim-slides was rejected with both `result-rejected` and `identity-evidence-invalid`;
- static import recognized the Math-To-Manim and ManimML Scene declarations but produced zero entities; the plugin Scene base in manim-slides was not recognized;
- a bounded Cairo construct smoke for Math-To-Manim completed and produced an 89,953-byte PNG with SHA-256 `45d48c46a6c296d7800b1057d5782072912d5f63e4fa1775be7b530dc7552a93`.

`FourierSeriesSquareWave` is the #509 target because it is the only candidate that combines an observed generic Runtime Trace gap, a safe snapshot fallback, a recognized Scene, a successful source execution, and dependencies already present in the pinned producer environment. It also covers `always_redraw`, ValueTracker, an updater, MathTex, and multiple objects. Demo value and implementation cost are reviewed 1–3 values in the manifest; feature occurrence totals are derived in the baseline rather than converted into a synthetic precision score.

Selection/edit/export/fresh-validation are explicitly `measured: false` fallbacks. They are not success evidence. Accepted evidence from the old Scene-specific profiles is also not relabeled as generic capability.

`Matheart/manim-physics` was considered but excluded: revision `2876741c43e5316332a56e7799e94a706a0d0e26` has no root license file or GitHub-detected SPDX license, so this fail-closed corpus cannot pin its execution license. Its plugin/3D-heavy examples are also a weaker first target for the 2D path.

## Reproduce

The default suite is offline. It validates the manifest and committed baseline without network or external checkouts. The required lane only reads user-provided, already-pinned checkouts; it never clones, syncs, installs, or builds them.

```bash
export POIETRA_REAL_MANIM_PROJECT_CENSUS_ROOTS='{
  "producer":"/absolute/path/to/fast-manim",
  "math-to-manim":"/absolute/path/to/Math-To-Manim",
  "manim-ml":"/absolute/path/to/ManimML",
  "manim-slides":"/absolute/path/to/manim-slides"
}'
export POIETRA_CAIRO_TEX_BIN='/absolute/path/to/tex/bin'
pnpm census:manim:v2
```

The evidence run used shallow blob-filtered sparse checkouts containing only the manifest-pinned files. Their sizes were 452 KiB, 288 KiB, and 1.4 MiB; they were removed after promotion. Set `POIETRA_REAL_MANIM_PROJECT_CENSUS_UPDATE=1` only when intentionally replacing the baseline after review.
