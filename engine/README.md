# Poietra Engine

This workspace is the renderer-neutral Rust experiment described by
[`ADR 0002`](../docs/adr/0002-poietra-engine-ir-contracts.md). The core crates
deliberately have no Tauri, Electron, browser, or GPU dependency; the browser
ABI is isolated in `poietra-wasm`.

- `poietra-scene-ir`: strict versioned JSON wire types and validation.
- `poietra-geometry`: deterministic cubic geometry and easing primitives.
- `poietra-eval`: pure `SceneIrV1` to `RenderPacketV1` frame sampling.
- `poietra-render-wgpu`: fail-closed CPU preparation and WGPU 30 path/image pipelines.
- `poietra-wasm`: retained Scene snapshot session and bounded browser-worker ABI.
- `poietra-mathtex-outline`: pinned RaTeX layout plus embedded KaTeX fonts,
  lowered into the same bounded cubic-path contract used by browser and Python.
- `poietra-mathtex-wasm` / `poietra-mathtex-py`: byte-identical browser and
  native boundaries around that compiler.

Run the workspace checks with:

```sh
cargo fmt --all --manifest-path engine/Cargo.toml -- --check
cargo test --locked --workspace --manifest-path engine/Cargo.toml
cargo clippy --locked --workspace --all-targets --all-features --manifest-path engine/Cargo.toml -- -D warnings
cargo check --locked --package poietra-wasm --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
cargo check --locked --package poietra-render-wgpu --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
```

The MathTex compiler accepts an evidence-backed subset of default-template
formula source; it does not load user packages, fonts, files, or custom
`TexTemplate` definitions. Unsupported syntax, raw Unicode rejected by the
pinned pdfLaTeX template, user-defined macros, unavailable glyphs, non-default
paint, and geometry above the public bounds return a structured fallback. Its
checked-in acceptance corpus contains 25 representative Manim expressions,
including fractions, radicals, text, accents, stretchy delimiters, matrices,
and multi-part formulas. A separate 15-case compile-only
[`core-ams` evidence matrix](../docs/mathtex-source-profile.md) expands that profile only where the
pinned default Manim template and RaTeX both succeed. A 31-call-site census pinned to a fast-manim
commit guards the measured support floor (30/31; the remaining call requires a custom TeX package).
Three pinned real-Manim SVG references separately measure normalized outline similarity:

```sh
node scripts/regenerate-mathtex-manim-parity.mjs
```

The sibling `poietra.segmented-tex-outline` V1 ABI preserves the aggregate
MathTex V1 wire contract while exposing deterministic display-item fragments
for Studio authoring. `tex-text` accepts a bounded literal ASCII subset and
provides exact UTF-8 source ranges, including deterministic literal paint
matches; `mathtex-math` preserves expression-wide correlation rather than
inventing glyph ranges for macros. Each fragment supplies separate outline and
fill entity IDs plus a normalized two-phase Write plan: trimmed stroke reveal,
then a full-path stroke-to-fill transition. The checked-in WriteStuff fixture
covers the official text and summation expressions across Rust, TypeScript,
WASM, and Python. This contract is outline evidence, not full Manim/Cairo scene
parity; producer hierarchy, runtime admission, and final raster parity remain
downstream responsibilities.

The native GPU proof is ignored by the portable default test suite. On a host
with a software Vulkan adapter such as Mesa Lavapipe, run it explicitly with:

```sh
WGPU_BACKEND=vulkan cargo test --locked --package poietra-render-wgpu --test headless_gpu --manifest-path engine/Cargo.toml -- --ignored --nocapture
```

The proofs fail when no fallback adapter is available. They render the shared
fixture, a focused round-cap packet, and verified PNG sampling/order cases into
sRGB textures, read aligned rows back to the CPU, check pixels, and emit
machine-readable adapter evidence.

The native-to-browser visual-parity corpus is enumerated from
`fixtures/visual-parity-v1/corpus.json`. Regenerate its complete evidence set with:

```sh
pnpm visual-parity:regenerate
```

The command renders every corpus-pinned EngineFrame once with the native fallback
adapter, rejects any entry that did not produce a fresh artifact, writes unpadded
top-to-bottom RGBA plus adapter/format metadata under
`test-results/visual-parity/native/`, builds the browser WASM module, then transfers
the complete browser RGBA frame out of the dedicated E2E worker. Deterministic
`expected.png`, `actual.png`, `diff.png`, and `report.json` files land under
`test-results/visual-parity/output/`. The browser tests are generated from the same
corpus, so a new entry cannot be omitted from the native-artifact or browser lanes.
The v1 corpus fixes each fixture revision, sample semantic digest and viewport, the
sRGB byte-domain four-channel SSIM definition, and the gate of SSIM >= 0.995 with
at most 0.5% of pixels having any RGBA channel differ by more than 8. Threshold
exceptions require both an explicit override and a non-empty reason. This is
test-only instrumentation: the production canvas response and frame-evidence ABIs
are unchanged.

Both evaluators consume the JSON fixtures under `fixtures/engine-v1`; categorical
results are exact and floating-point results use the fixture's explicit combined
absolute/relative tolerance. The TypeScript evaluator remains Studio's current
implementation while the Rust path is experimental. Studio can explicitly opt into
the retained worker through `?previewRenderer=server`: it loads a same-origin,
server-verified fast-manim snapshot and reveals the WebGPU canvas only after an
exactly correlated frame is presented. The semantic editor stays mounted as the
interactive overlay and whole-Scene fallback; it remains the default without that
query. Server-backed final video rendering and `.py` export remain separate,
authoritative workflows.

`poietra-render-wgpu` is a deliberately narrow GPU slice. Its pure CPU
stage validates the complete `RenderPacketV1`, maps each local cubic's controls to
world space in f64, then adaptively flattens there with a conservative target-derived
0.25-pixel control-hull tolerance. Filled contours then undergo camera subtraction
and clip mapping in f64. Conversion to the final f32 upload domain rejects more than
0.25 pixels of error or any distinct-point collapse; Lyon triangulates those exact
upload coordinates without a second quantization. Fill draws support closed concave
and disjoint subpaths, holes, self-intersections, and explicit nonzero/even-odd rules.
Strokes preserve cubic curves and support open, closed, multi-segment, and
multi-subpath paths with butt/square/round caps, bevel/miter/round joins, and the
packet miter limit. Stroke inputs are transformed and camera-rebased in f64 before
checked f32 Lyon tessellation at the target-derived 0.25-pixel tolerance;
world-space width is not multiplied by the object transform. Combined paths emit
adjacent fill-then-stroke paint phases with distinct materials, before the next
source draw. Nonzero morph/trim/motion samples use this same path; exact zero trim
lowers to an explicit `path-trim-zero` empty visual, while an exactly singular
sample from a direct leaf affine-transform channel lowers to
`singular-affine-sample`; neither contributes a paint phase.
Verified static PNG draws are prepared as camera-projected affine quads with
row-zero-top UVs. The decoder converts straight-alpha sRGB samples to
premultiplied linear-light RGBA8 before nearest or linear clamp-to-edge sampling;
path and image pipeline switches preserve packet paint order. Image packets need
an immutable decoded-asset resolver. Before creating GPU resources, frame preflight
caps unique textures at 4,096, texture/sampler bindings at 8,192, and decoded
texture upload at 256 MiB. Open fill, unresolved or invalid image,
unmarked degenerate, numeric, precision-collapse, and tessellation-limit cases
reject the complete frame with a structured error. Each fill is bounded to 2,048 source
cubics, 32,768 flattened input points, and 65,536 Lyon output vertices; each stroke
is bounded to 2,048 source cubics, a preflighted 32,768 flattened segments, 65,536
Lyon output vertices, and 15 recursive round-cap/join subdivisions. The preflight
also rejects pixel-domain inputs whose f32 ULP cannot preserve the visible
quantization budget. The independent frame-wide preparation ceiling remains
1,000,000 vertices. The 0.25-pixel bound covers input/scalar conversion and curve
flattening; Lyon's discrete miter-limit branch remains an f32 renderer decision.

Preparation keeps four ownership boundaries explicit: position-only geometry,
per-phase material, stable ordered draw ranges, and the transient GPU upload plan.
Changing only paint therefore leaves geometry and ordering unchanged. The upload
plan interleaves positions and materials into the existing 24-byte shader layout
under a checked 64 MiB hard limit, then is discarded after buffer staging. No
prepared-geometry cache exists yet, so telemetry continues to report
`preparedGeometry: "absent"` rather than treating transient upload data as a cache.

Each renderer retains immutable image textures by verified digest, dimensions,
decode version, and sampler binding under explicit 128 MiB decoded-CPU,
256 MiB GPU-texture, and 4,096-entry limits. LRU eviction never removes a
texture needed by the current frame; a later miss recreates it from the shared
verified decoded bytes. Texture uploads and nearest/linear binding reuse are
reported separately by opt-in telemetry.

The shared browser/native WGPU 30 pipeline accepts caller-owned `Device`, `Queue`,
and `TextureView` values, clears an extent-checked target, and draws premultiplied
linear-light indexed path triangles and verified PNG quads in packet paint order.
It accepts only `Rgba8UnormSrgb` and `Bgra8UnormSrgb` single-sample render targets.
Device creation, cross-worker/persistent texture caching, antialiasing, and
clipping remain outside this slice. Native software-adapter and
Chromium Worker readbacks share fixtures for generic fill topology and for animated
curved/joined strokes, fill/stroke composition, and translucent source order; the
native proof additionally covers exact PNG sampling and mixed path/image order.

On `wasm32`, `PoietraCanvasEngineV1` owns an `OffscreenCanvas` WebGPU surface,
device, queue, path/image renderer, and immutable digest-keyed PNG registry. Its
asynchronous `create` method installs a validated snapshot and verified asset bytes,
`replaceSnapshot` atomically replaces both authorities, and `render` consumes the
existing bounded sample request. Render responses contain only presentation
correlation metadata or a structured error; they never transfer a `RenderPacket`
back to JavaScript.

Normal `render` calls recover one lost-device generation lazily. The engine
reacquires a complete adapter/device/queue/surface/renderer candidate, preserves
the retained Scene and decoded PNG registry, and retries that prepared frame at
most once. Candidate acquisition failure or a second device loss returns the
existing structured `device-lost` error so the page keeps its whole-Scene fatal
fallback. This does not change the Canvas ABI or the opt-in telemetry path.

The canvas engine also exposes an opt-in stage-telemetry ABI, versioned
independently of the base canvas ABI (`poietraCanvasTelemetryAbiVersion`).
`renderWithTelemetry` runs the identical pipeline while recording one bounded
per-frame phase map, and `adapterEvidence` returns the wgpu `AdapterInfo` of
the adapter the worker actually created its device with, plus the requested
device features/limits and surface selection — deliberately distinct from any
page-level `navigator.gpu` hint. The normal `render` acknowledgement is
unchanged and never carries telemetry.

Telemetry phase names state literally what each wall-clock interval covers,
and every phase is always present as `measured`, `skipped` (did not execute
for this frame), or `unavailable` with a reason:

- `evaluate`: retained-session sampling of the playhead into a `RenderPacket`.
- `prepare`: packet validation (`validate_frame_packet_v1`); its unforgeable
  token is the only path into tessellation, so the split cannot bypass the
  fail-closed contract.
- `tessellate`: CPU flattening and triangulation of the validated packet.
- `vertexIndexEncode`: CPU encoding of vertices/indices into byte vectors.
- `bufferCreateAndStage`: retained-buffer growth, exact dirty-range comparison,
  and `queue.write_buffer` staging; a CPU-side cost, not GPU transfer time.
- `commandEncodeTotal`: encoder creation through `finish()`; a labeled nested
  total that includes `drawRecord`.
- `drawRecord`: CPU recording of the ordered compatible `draw_indexed` batches.
- `surfaceAcquire`: surface configuration, current-texture acquisition, and
  view creation as one non-overlapping interval.
- `submit` / `present`: the CPU `queue.submit` / `queue.present` calls; their
  return proves nothing about GPU execution.
- `gpuErrorScopeResolution`: the awaited resolution of the three popped
  WebGPU error scopes, which can block on GPU progress.
- `gpuQueueSubmittedWorkDone`: a genuinely awaited
  `GPUQueue.onSubmittedWorkDone` fence — the only phase allowed to claim GPU
  completion, and only on this opt-in path.
- `gpuExecution` and `browserComposite`: always `unavailable`, because the
  pipeline requests no timestamp queries and a dedicated worker cannot
  observe browser compositing.

Intervals come from the worker's `performance.now`; a missing clock or a
negative/non-finite difference is reported as `unavailable`, never as a
healthy zero. Per-frame counts (evaluated entities/draws, tessellation calls
counted at the tessellation call sites, tessellated vertices/indices, buffer
creations, staged upload bytes, draw calls, surface configurations) and cache
outcomes are recorded at their actual call sites; the absent prepared-geometry
cache reports `absent` rather than a fabricated miss.

The WASM session validates and retains a complete Scene bundle on installation.
It also builds one immutable evaluator index containing entity/channel lookup,
hierarchy order, and stable translucent paint order. Index construction uses
checked accounting under an 8 MiB hard limit. A replacement first validates and
indexes a complete candidate, then atomically swaps it in; failure preserves the
previous Scene, assets, index, and sampling evidence, while successful replacement
drops the old retained state. Subsequent playhead requests are bounded JSON messages
and return only the sampled `RenderPacket`; immutable Scene and manifest data are
not cloned across the worker boundary on every frame. Build the web-target package
with the repository script:

Canvas ABI v4 additionally accepts transferable, manifest-verified PNG assets
during atomic install/replacement. It retains the Studio-only `SceneDeltaV1`
transport from v3 (256 KiB and 256 operations maximum) as one transferred
`ArrayBuffer`. Rust checks the
transport base/next revisions, constructs and indexes the complete candidate,
and pre-serializes a 128 KiB-bounded entity/channel/camera/asset dirty-set ACK
before the atomic swap. The page client advances its revision only after that
ACK; malformed, unsupported, or stale deltas retain the base revision and may
recover through the existing full `replace-scene` operation. The authoring
call site that turns subsequent Studio edits into deltas remains part of #67;
initial Studio compilation still belongs to `studio-scene-adapter`. Dirty sets
are dependency-safe invalidation candidates, not a minimal list of changed
records: channel edits include both their old and new entity target (or the
camera), while entity edits include descendants from both the installed and
candidate parent graphs. IDs are deduplicated and sorted, and a closure that
exceeds either 256-ID bound rejects before the swap so it cannot be truncated
into an unsafe ACK. These candidates do not yet make GPU preparation/upload
incremental because prepared geometry is not retained; that cache/invalidation
work remains in #70.

```sh
cargo install wasm-pack --locked --version 0.15.0
pnpm build:canvas:wasm
pnpm build:mathtex:wasm
# or build both packages for a release/CI artifact
pnpm build:engine:wasm
```

Generated bindings are written to `public/engine-wasm` and intentionally remain
untracked build artifacts.

After that build, exercise the real fast-manim-to-Studio path with an explicit
producer interpreter:

```sh
POIETRA_FAST_MANIM_SNAPSHOT_COMMAND='["/path/to/fast-manim/.venv/bin/python","-m","manim.renderer.source_runtime_identity"]' \
  pnpm test:e2e:preview:real
```

This lane uses a checked-in Python Scene with a filled Circle, filled Rectangle,
and stroked Line, plus a V2 Scene with linear FadeIn/FadeOut opacity and bounded
lifetime intervals. It verifies retained-host correlation, non-monotonic forward/backward
seeks, exact GPU texture readback, variable duration, and verified runtime hit
geometry. It is not a browser-compositor golden, reference-image comparison, or
decision-grade real-GPU performance report; those remain tracked separately.

## Canonical WebGPU benchmark lane

Run benchmarks only through:

```sh
pnpm benchmark:engine:webgpu
```

The runner builds the WASM module, produces a dedicated benchmark production
build in a run-specific `dist-benchmark/run-*/` directory (the normal Studio
build never bundles the `benchmark.html` host entry), writes a build manifest
hashing the exact benchmark executable set — `benchmark.html`, every
`assets/*.js` chunk, and every `engine-wasm/*.js`/`*.wasm` file; non-executable
assets are not hashed — and drives `playwright.benchmark.config.ts`
against an owned static `vite preview` server on `POIETRA_BENCHMARK_PORT`
(default 4175). Reports land under `test-results-benchmark/`. Direct
Playwright invocations without the runner fail fast: the config requires
`POIETRA_BENCHMARK_DIST` and every spec verifies the served bytes against the
manifest and the current HEAD before and after measurement.

Evidence rules:

- Decision-grade runs require a clean tracked/untracked working tree; the
  lane aborts on a dirty tree. `POIETRA_BENCHMARK_ALLOW_DIRTY=1` permits a
  development smoke whose report is permanently graded
  `non-decision-grade-dirty-tree`.
- Every report carries machine-readable `decisionEligibility`; software
  adapters (for example SwiftShader/CPU), Linux hosts, and missing or mismatched
  driver/AC/power evidence keep a run exploratory regardless of budget
  booleans. The only decision candidate is native Windows Edge on its default
  D3D12 path, with no Linux Vulkan/ANGLE flags.
- `fixtures/engine-benchmark-v1/windows-d3d12-reference-host.json` is the
  strict v2 reference-host profile; its sibling `.sha256` file pins the exact
  bytes and detects drift, while review of both files establishes trust. Windows
  build, CPU, complete GPU/driver inventory, AC state, active power-plan GUID,
  user-configured AC power-mode GUID, launched Edge version, and selected Worker
  adapter must all match. The primary adapter and all 20 fresh-process cold samples
  must also have one identical hardware identity. Browser identity is
  read from the same created `GPUDevice`: raw privacy-safe vendor/architecture,
  fallback class, and subgroup bounds. Production-default Edge redacts
  description/device/driver details, so native PCI and driver identity stays a
  separately pinned OS controller record and discarded Worker fields remain
  canonical zero/empty. Environment
  variables cannot replace any of this OS/browser evidence: the production
  probe launches the canonical Windows PowerShell and `powercfg` binaries by
  fixed absolute path, uses a fixed system module path, reads the configured AC
  power mode through `PowerGetUserConfiguredACPowerMode`, and discovers Edge from
  HKLM or fixed machine-install paths. Windows may override that configured vote,
  so the harness does not claim to observe the dynamically effective power mode.
  This fail-closed harness does not claim resistance to an administrator modifying
  HKLM or Windows system files.
- The current exact report pairs are `poietra.engine-webgpu-benchmark` v4,
  `poietra.engine-webgpu-stress-benchmark` v5, and
  `poietra.engine-webgpu-stage-telemetry` v4. Their eligibility/provenance,
  reference-host, and canonical-run nonce additions are breaking changes;
  prior-version readers must reject them rather than accepting a widened
  envelope.
- Checked-in performance evidence is a rolling single current set bound to its
  profile and commit directory names. The three raw JSON reports are stored as
  deterministic gzip files so per-frame telemetry remains revalidatable without
  adding hundreds of thousands of source lines. Once physical evidence lands,
  replacing the profile or report contract replaces that set rather than asking
  the current reader to reinterpret obsolete history.
- The lane never retries: a Worker crash or destroyed page context fails the
  run, and the reports record the actual retry counters.
- The stress report compares the existing no-interaction acknowledgement with
  100 requested bounds and the capped 128 requested bounds in a 1,000-entity
  Scene, recording page-visible logical response JSON bytes under the 16 KiB
  acknowledgement budget. It does not claim 1,000 returned bounds or actual
  structured-clone transport bytes.
- The dev-server smoke tests (pixel/readback proofs against `pnpm dev:web`)
  are a separate lane and never produce benchmark evidence.

Untrusted contract JSON is rejected before deserialization above the 8 MiB
envelope limit. Asset bytes are resolved out of band and are not part of that
limit.
