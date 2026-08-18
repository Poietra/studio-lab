# Generic Manim importability quality gate

`fixtures/generic-importability/manifest.json` is the offline scoreboard for the current generic Manim path. It
lists the seven official `example_scenes/basic.py` Scenes, `StaticSquare`, `FeynmanDiagram`, and
`FourierSeriesSquareWave` without turning old Scene-specific profiles into generic support claims.

Each stage is reported independently:

1. discovery
2. preview
3. source binding
4. Studio selection
5. edit, split into move, uniform resize, rotation, and opacity
6. Python export
7. reimport
8. fresh validation

The three stage statuses have deliberately narrow meanings:

- `pass`: a cited offline test or committed generic fixture checks this exact stage;
- `fail`: the stage was measured and is explicitly `read-only` or `unsupported` in the manifest;
- `unmeasured`: no current offline assertion exists, even if adjacent stages work;

An isolated lowering test may therefore mark an edit and Python export as measured while preview or reimport remains
unmeasured. That is not an end-to-end support claim. The gate command reruns every test file cited by the manifest:

```bash
pnpm test:importer:quality
```

## Completion criteria

The importer is not complete merely because a Scene renders. Completion requires all three machine-readable gates:

- silent omissions among accepted generic roots: `0`;
- missing visible roots in an accepted generic preview: `0`; and
- claimed edit operations with export, reimport, and fresh validation: `100%`.

The first two gates currently pass for four committed accepted fixtures: official `WriteStuff` has two accepted
source-visible roots, `StaticSquare` has one, `FeynmanDiagram` has four, and `FourierSeriesSquareWave` has five. The
other six official Scenes remain unmeasured on the current generic preview route, so these 12 roots do not mean that
the importer is complete. `WriteStuff` reuses the checked 61-entity V12 Scene IR and its existing WGPU parity as real
glyph geometry. The generic verified-snapshot selection policy admits `example_text` and `example_tex` from verified
source/runtime identity, while the source-lifecycle-free `group` layout helper is explicitly not a visible selector.
No new WriteStuff dispatch is added. Its static importer duration is 3 seconds while the runtime fixture is 4 seconds,
so the measured preview remains selection-only and no edit or export claim is promoted.

The edit roundtrip gate is green: `StaticSquare` reimports all four advertised operations through the full static
importer, and the three claimed official-corpus edits (`OpeningManim` move, `WarpSquare` move, and `UpdatersExample`
uniform resize) now reimport and independently re-derive their emitted Python. The scoreboard therefore records all
seven claimed operation roundtrips, or `100%`.

Adding a Scene or promoting a status requires an existing offline test in the gate command. A measured official root
fixture must carry the exact full-source path and content hash; a standalone extracted Scene is not evidence for the
official multi-Scene source. External clones, a new producer, OCI execution, and a new Scene-specific production
branch are outside this gate.
