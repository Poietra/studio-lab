# Historical editability census evidence

`playback-manifest.json` is the canonical parsed manifest that produced the
historical V1 playback and editability baselines. Its producer identity and
JSON property order are part of the recorded manifest digest.

The active producer pin lives in `../real-manim-census-v1/manifest.json` and
intentionally differs. Do not relabel these historical measurements with that
active identity, reorder this archived manifest, or use it as a current
producer checkout instruction.
