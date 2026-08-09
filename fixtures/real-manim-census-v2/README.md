# Real Manim project census v2

This corpus measures three pinned MIT-licensed projects with a pinned fast-manim producer. The source-runtime identity snapshot probe uses profile V2; generic Runtime Trace is measured independently. It does not replace census v1: v1 has 7 accepted compatibility scenes but only 7 accepted and 49 fallback profile attempts, plus two Scene-specific editability profiles.

The required run produced two distinct kinds of preview evidence:

- the generic Runtime Trace entry point accepted Math-To-Manim and rejected ManimML and manim-slides with `producer-exit`;
- the separate profile-V2 snapshot probe safely fell back with `animation-evidence-incomplete` for all three projects;
- static import recognized the Math-To-Manim and ManimML Scene declarations but produced zero entities; the plugin Scene base in manim-slides was not recognized;
- a bounded Cairo construct smoke for Math-To-Manim completed and produced an 89,930-byte PNG with SHA-256 `b786567c23f235befbbb386ae81ea57eb7793ec5910ef8ed5d3c5e67b9e3c25a`.

No follow-up target is selected in the current report. `FourierSeriesSquareWave`, the only candidate that otherwise satisfies the bounded-execution, snapshot-fallback, recognized-Scene, and producer-dependency gates, is now accepted by generic Runtime Trace, so the gap this census selects for is no longer observed. A zero-candidate result is represented by `selectedCodebaseId: null`; it does not relax or substitute any selection metric. `followUpIssue: 509` is retained as provenance for the generic Runtime Trace work that this selection measures, not as a claim that the closed issue needs another target. Demo value and implementation cost are reviewed 1–3 values in the manifest; feature occurrence totals are derived in the baseline rather than converted into a synthetic precision score.

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
