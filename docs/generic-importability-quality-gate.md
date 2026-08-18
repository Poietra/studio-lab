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

The first two gates currently pass only for the three committed accepted generic fixtures: `StaticSquare` has one
accepted root, `FeynmanDiagram` has four, and `FourierSeriesSquareWave` has five. The seven official Scenes remain
unmeasured on the current generic preview route, so these root totals do not mean that the importer is complete. The
edit roundtrip gate is intentionally red:
existing tests prove several lowerings and fresh validations, but none reimports every exported operation through the
full static importer. The scoreboard records this as `0%`; it must not be rounded up from source-lowering coverage.

Adding a Scene or promoting a status requires an existing offline test in the gate command. External clones, a new
producer, OCI execution, and a new Scene-specific production branch are outside this gate.
