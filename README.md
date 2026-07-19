# Poietra Studio Lab

Disposable, evidence-driven experiments for choosing the Poietra Studio client architecture.

This repository is intentionally separate from the product repository. Its first experiment compares Tauri and Electron by running the same React application and the same representative Studio workload in both shells.

## Scope

- frame-oriented media playback and seeking
- Canvas/WebGL overlays for object picking and ghost trajectories
- Python/Manim process lifecycle
- Runtime IR streaming
- file watching and partial re-render feedback
- development, packaging, memory, and cross-platform behavior

The experiment charter and decision gate live in [docs/shell-evaluation.md](docs/shell-evaluation.md).

## Commands

```sh
pnpm install
pnpm dev:web
pnpm dev:electron
pnpm dev:tauri
pnpm check:web
cargo check --manifest-path src-tauri/Cargo.toml
```

Linux development requires the [system packages listed by Tauri](https://v2.tauri.app/start/prerequisites/#linux) before `dev:tauri` or `cargo check` can run.

The application code under `src/` is shared without shell-specific branches. Native integration must stay behind a small adapter so the comparison measures the shell rather than two different implementations.

## Status

Experimental. Nothing in this repository is a supported Poietra product API.
