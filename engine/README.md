# Poietra Engine

This workspace is the renderer-neutral Rust experiment described by
[`ADR 0002`](../docs/adr/0002-poietra-engine-ir-contracts.md). The core crates
deliberately have no Tauri, Electron, browser, or GPU dependency; the browser
ABI is isolated in `poietra-wasm`.

- `poietra-scene-ir`: strict versioned JSON wire types and validation.
- `poietra-geometry`: deterministic cubic geometry and easing primitives.
- `poietra-eval`: pure `SceneIrV1` to `RenderPacketV1` frame sampling.
- `poietra-render-wgpu`: fail-closed CPU preparation and a minimal WGPU 30 solid-paint pipeline.
- `poietra-wasm`: retained Scene snapshot session and bounded browser-worker ABI.

Run the workspace checks with:

```sh
cargo fmt --all --manifest-path engine/Cargo.toml -- --check
cargo test --locked --workspace --manifest-path engine/Cargo.toml
cargo clippy --locked --workspace --all-targets --all-features --manifest-path engine/Cargo.toml -- -D warnings
cargo check --locked --package poietra-wasm --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
cargo check --locked --package poietra-render-wgpu --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
```

The native GPU proof is ignored by the portable default test suite. On a host
with a software Vulkan adapter such as Mesa Lavapipe, run it explicitly with:

```sh
WGPU_BACKEND=vulkan cargo test --locked --package poietra-render-wgpu --test headless_gpu --manifest-path engine/Cargo.toml -- --ignored --nocapture
```

The proofs fail when no fallback adapter is available. They render the shared
fixture and a focused round-cap packet into sRGB textures, read aligned rows back
to the CPU, check stable interior pixels, and emit machine-readable adapter evidence.

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
lowers to an explicit `path-trim-zero` empty visual and contributes no paint phase.
Open fill, image, unmarked degenerate, numeric, precision-collapse, and tessellation-limit cases reject
the complete frame with a structured error. Each fill is bounded to 2,048 source
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

The shared browser/native WGPU 30 pipeline accepts caller-owned `Device`, `Queue`,
and `TextureView` values, clears an extent-checked target, and draws premultiplied
linear-light indexed solid-paint triangles in packet paint order. It accepts only
`Rgba8UnormSrgb` and `Bgra8UnormSrgb` single-sample render targets. Device creation,
browser fallback policy, image support, antialiasing, and clipping remain outside
this slice. Native software-adapter and Chromium Worker readbacks share fixtures for
generic fill topology and for animated curved/joined strokes, fill/stroke
composition, and later translucent source order.

On `wasm32`, `PoietraCanvasEngineV1` owns an `OffscreenCanvas` WebGPU surface,
device, queue, and the solid-paint renderer. Its asynchronous `create` method
installs a validated snapshot, `replaceSnapshot` atomically replaces that snapshot,
and `render` consumes the existing bounded sample request. Render responses contain
only presentation correlation metadata or a structured error; they never transfer a
`RenderPacket` back to JavaScript.

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
- `bufferCreateAndStage`: `create_buffer_init` calls that create the GPU
  buffers and stage the encoded bytes; a CPU-side cost, not a GPU transfer.
- `commandEncodeTotal`: encoder creation through `finish()`; a labeled nested
  total that includes `drawRecord`.
- `drawRecord`: CPU recording of the per-draw `draw_indexed` loop.
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

```sh
cargo install wasm-pack --locked --version 0.15.0
pnpm build:engine:wasm
```

Generated bindings are written to `public/engine-wasm` and intentionally remain
untracked build artifacts.

After that build, exercise the real fast-manim-to-Studio path with an explicit
producer interpreter:

```sh
POIETRA_FAST_MANIM_SNAPSHOT_COMMAND='["/path/to/fast-manim/.venv/bin/python","-m","manim.renderer.scene_snapshot"]' \
  pnpm test:e2e:preview:real
```

This lane uses a checked-in Python Scene with a filled Circle, filled Rectangle,
and stroked Line. It verifies the retained host correlation and exact GPU texture
readback. It is not a browser-compositor golden, reference-image comparison, or
decision-grade real-GPU performance report; those remain tracked separately. It
also proves that Studio projects the static producer profile's verified 1-second
duration instead of its 0.1-second source-import estimate; arbitrary Manim Scene
duration and source-to-runtime hit-target identity remain follow-up work.

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
  adapters (for example SwiftShader/CPU) and missing driver/power-mode
  evidence keep a run exploratory regardless of budget booleans.
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
