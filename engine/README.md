# Poietra Engine

This workspace is the renderer-neutral Rust experiment described by
[`ADR 0002`](../docs/adr/0002-poietra-engine-ir-contracts.md). The core crates
deliberately have no Tauri, Electron, browser, or GPU dependency; the browser
ABI is isolated in `poietra-wasm`.

- `poietra-scene-ir`: strict versioned JSON wire types and validation.
- `poietra-geometry`: deterministic cubic geometry and easing primitives.
- `poietra-eval`: pure `SceneIrV1` to `RenderPacketV1` frame sampling.
- `poietra-wasm`: retained Scene snapshot session and bounded browser-worker ABI.

Run the workspace checks with:

```sh
cargo fmt --all --manifest-path engine/Cargo.toml -- --check
cargo test --locked --workspace --manifest-path engine/Cargo.toml
cargo clippy --locked --workspace --all-targets --all-features --manifest-path engine/Cargo.toml -- -D warnings
cargo check --locked --package poietra-wasm --target wasm32-unknown-unknown --manifest-path engine/Cargo.toml
```

Both evaluators consume the JSON fixtures under `fixtures/engine-v1`; categorical
results are exact and floating-point results use the fixture's explicit combined
absolute/relative tolerance. The TypeScript evaluator remains Studio's current
implementation while the Rust path is experimental. `poietra-wasm` exposes a
worker-oriented boundary, but Studio does not yet use it as its visible renderer
and this workspace does not yet contain a GPU renderer.

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
