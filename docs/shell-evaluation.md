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
