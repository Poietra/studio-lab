# Desktop shell evaluation

## Decision

Choose the first desktop shell for Poietra Studio without coupling product code to that shell.

Tauri is the provisional default. Electron replaces it only when the shared workload reveals a material WebView, media, IPC, tooling, or distribution disadvantage that would slow the product more than Electron's resource and security costs.

## Timebox

Two focused engineering days. Stop when the evidence is sufficient to choose; do not turn this repository into a second product implementation.

## Rules of comparison

1. Both shells run the same React build from `src/`.
2. Shell-specific code only starts the window and implements a narrow native adapter.
3. Both shells use the same fixture video, Runtime IR stream, subprocess workload, and measurement script.
4. Record measurements before optimizing either implementation.
5. Keep raw measurements and reproduction instructions in this repository.

## Representative workload

The completed fixture must exercise all of the following in a single session:

- open a local rendered video and seek repeatedly to exact requested frames
- render bounding boxes, selection affordances, and three ghost trajectories over the video
- ingest a recorded Runtime IR stream at representative event volume
- start, interrupt, and restart a Python child process
- watch a Manim source file and surface a simulated partial render result
- remain responsive while trace parsing and overlay updates run

## Evidence to capture

| Area | Observation |
| --- | --- |
| Frame seeking | requested frame, displayed frame, latency distribution |
| Overlay | steady frame rate and dropped frames at representative object counts |
| Runtime IR | parse throughput, memory growth, main-thread blocking |
| Python lifecycle | start, interrupt, cleanup, and orphan-process behavior |
| File watching | event consistency and restart behavior |
| Idle footprint | process count, resident memory, CPU, installed size |
| Development | clean-start time, hot reload, debugging, failure clarity |
| Distribution | unsigned local package on target operating systems |
| Portability | behavior differences on Windows, macOS, and Linux |
| Security | exposed native surface, permission model, update implications |

## Reproducible Linux build

`Dockerfile.linux` pins the Node, pnpm, Rust, and WebKitGTK build environment used for the
Linux Tauri check. It is a build-reproducibility fixture, not a substitute for measuring
native WebView behavior on the host desktop. Interactive media, pointer, GPU, and process
lifecycle observations must still be recorded on an actual Linux desktop session.

### 2026-07-19 preliminary result

Environment: Debian bookworm container, Xvfb, Node 24, pnpm 10.23, Rust 1.92,
WebKitGTK 4.1, Electron 43.1.1, and Tauri 2.11.x.

| Check | Result |
| --- | --- |
| Shared TypeScript/Vite production build | pass |
| Tauri `cargo check --locked` | pass |
| Tauri release build without bundling | pass |
| Tauri five-second Xvfb smoke | stayed alive |
| Electron five-second Xvfb smoke | stayed alive |
| Tauri application binary | 10,673,304 bytes |
| Electron downloaded runtime directory | 326,079,615 bytes |
| Rough summed process RSS | Tauri ~536 MiB; Electron ~637 MiB |

The RSS values are not a decision metric: Xvfb/container execution is not a native desktop,
and summing per-process RSS double-counts shared pages. The size values also have different
boundaries because Tauri uses the system WebView while Electron ships Chromium. This result
only removes a basic Linux build/start risk for both shells. It does not exercise the
representative media, overlay, trace, subprocess, or file-watching workload.

Electron was launched with `--no-sandbox` only because the smoke ran as root inside a disposable
container. The application fixture itself keeps renderer sandboxing, context isolation, and
Node integration disabled; production must never use the container-only flag.

## Decision gate

Select Tauri when the representative workflow works without a product-level workaround and its platform differences are containable behind the native adapter.

Select Electron when Chromium consistency or Electron tooling removes a demonstrated blocker in core editing interactions, media correctness, process control, or delivery. Familiarity alone is not sufficient evidence.

The final record must state:

- selected shell and date
- rejected alternative
- measured evidence
- known platform risks
- conditions that would reopen the decision

## Non-goals

- final Studio visual design
- public API design
- production packaging and auto-update implementation
- complete Python sandboxing
- choosing the Scene IR wire format
- preserving experimental code after the decision
