# Poietra Engine

This workspace is the renderer-neutral Rust experiment described by
[`ADR 0002`](../docs/adr/0002-poietra-engine-ir-contracts.md). The core crates
deliberately have no Tauri, Electron, browser, or GPU dependency; the browser
ABI is isolated in `poietra-wasm`.

- `poietra-scene-ir`: strict versioned JSON wire types and validation.
- `poietra-geometry`: deterministic cubic geometry and easing primitives.
- `poietra-eval`: pure `SceneIrV1` to `RenderPacketV1` frame sampling.
- `poietra-render-wgpu`: fail-closed CPU preparation and a minimal WGPU 30 solid-fill pipeline.
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
WGPU_BACKEND=vulkan cargo test --locked --package poietra-render-wgpu --test headless_gpu --manifest-path engine/Cargo.toml renders_shared_fixture_with_fallback_adapter -- --ignored --exact --nocapture
```

The proof fails when no fallback adapter is available. It renders the shared
fixture into an sRGB texture, reads aligned rows back to the CPU, checks stable
interior pixels, and emits machine-readable adapter evidence.

Both evaluators consume the JSON fixtures under `fixtures/engine-v1`; categorical
results are exact and floating-point results use the fixture's explicit combined
absolute/relative tolerance. The TypeScript evaluator remains Studio's current
implementation while the Rust path is experimental. `poietra-wasm` exposes a
worker-oriented boundary, but Studio does not yet use it as its visible renderer.

`poietra-render-wgpu` is the first deliberately narrow GPU slice. Its pure CPU
stage validates the complete `RenderPacketV1`, maps each local cubic's controls to
world space in f64, then adaptively flattens there with a conservative target-derived
0.25-pixel control-hull tolerance. Camera subtraction and clip mapping happen only
after tessellation, before the finite f32 upload check. It supports only one closed,
non-degenerate convex subpath with a solid fill per draw. Stroke, image, open,
multi-subpath, non-convex, degenerate, numeric, and tessellation-limit cases reject
the complete frame with a structured error. The frame-wide preparation ceiling is
1,000,000 vertices.

The shared browser/native WGPU 30 pipeline accepts caller-owned `Device`, `Queue`,
and `TextureView` values, clears an extent-checked target, and draws premultiplied
linear-light indexed triangles in packet paint order. It accepts only
`Rgba8UnormSrgb` and `Bgra8UnormSrgb` single-sample render targets. Device creation,
browser fallback policy, stroke/image support, and general path tessellation remain
outside this initial slice. A native software-adapter smoke test proves the shared
fixture through actual GPU submission and readback.

On `wasm32`, `PoietraCanvasEngineV1` owns an `OffscreenCanvas` WebGPU surface,
device, queue, and the fill renderer. Its asynchronous `create` method installs a
validated snapshot, `replaceSnapshot` atomically replaces that snapshot, and
`render` consumes the existing bounded sample request. Render responses contain
only presentation correlation metadata or a structured error; they never transfer
a `RenderPacket` back to JavaScript.

The WASM session validates and retains a complete Scene bundle on installation.
Subsequent playhead requests are bounded JSON messages and return only the sampled
`RenderPacket`; immutable Scene and manifest data are not cloned across the worker
boundary on every frame. Build the web-target package with the repository script:

```sh
cargo install wasm-pack --locked --version 0.15.0
pnpm build:engine:wasm
```

Generated bindings are written to `public/engine-wasm` and intentionally remain
untracked build artifacts.

Untrusted contract JSON is rejected before deserialization above the 8 MiB
envelope limit. Asset bytes are resolved out of band and are not part of that
limit.
