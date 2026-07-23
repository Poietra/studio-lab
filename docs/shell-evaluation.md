# ADR: first desktop shell

- Status: Accepted
- Decision date: 2026-07-23
- Decision owner: `Hosi121` / Poietra Studio
- Tracking issue: [#32](https://github.com/Poietra/studio-lab/issues/32)
- Follow-up implementation: [#33](https://github.com/Poietra/studio-lab/issues/33)

## Decision

Use **Electron** for the first Poietra Studio desktop shell. Keep the React renderer,
domain model, source analysis/lowering, and render services independent of Electron.
Electron owns only application lifecycle, a restricted native bootstrap, and the local
service process.

This replaces the earlier provisional Tauri default. Tauri remains a viable future
alternative, but it does not pass the current decision gate without either rewriting the
existing Node render/workspace service in Rust or shipping and supervising a Node sidecar.
Neither path has been demonstrated, and both are product-level workarounds rather than a
narrow shell adapter.

The decision is based primarily on delivery architecture and browser-engine consistency,
not on a claim that Electron is faster. A representative Tauri workload has not yet been
measured on target desktops.

## Context and decision drivers

Studio currently has two materially different halves:

1. The shared React editor uses video, SVG overlays, KaTeX, pointer interactions, and
   browser fetch contracts.
2. The local service discovers and writes workspaces, watches source, starts and cancels
   Python/Manim process groups, serves ranged MP4 responses, and guards source commits.

The second half is implemented in TypeScript/Node and is currently attached to Vite as
development middleware. The existing packaged Electron path and Tauri path both load only
the static React build, so neither is product-complete today. Their cost to close that gap
is different:

| Driver | Electron | Tauri |
| --- | --- | --- |
| Existing service reuse | Runs unchanged in the bundled Node runtime; it should move to an Electron utility process. | Requires a Node sidecar or a Rust port of filesystem, process, HTTP, and safety logic. |
| Renderer consistency | Ships one Chromium version on Linux, macOS, and Windows. | Uses WebKitGTK, WKWebView, or WebView2, so media and interaction behavior must be qualified per OS. |
| Binary/runtime boundary | Ships Chromium and Node; the downloaded Linux runtime measured 326,063,995 bytes. | The preliminary unbundled Linux binary measured 10,673,304 bytes and uses the system WebView. |
| Native exposure | Renderer can remain sandboxed with no Node integration and a small preload/bootstrap surface. | Tauri capabilities are narrow by default, but the actual Studio commands or sidecar policy do not exist yet. |
| Product risk | Larger footprint and Chromium patch cadence. | Duplicate safety logic or sidecar lifecycle, signing, and update complexity before feature parity. |

Tauri would have been selected if the representative workflow worked behind a narrow
adapter. The absent local-service implementation means that condition is not met. Electron
removes that demonstrated delivery blocker while preserving the option to change shells
later through the boundary below.

## Reproducible workload

The committed harness has two parts:

- `shell-evaluation/workload.html` and `workload.js` run a deterministic renderer session:
  a generated 12-second 1280x720 30 fps H.264 video, ten frame-aligned seeks, 400 moving
  boxes, three quadratic ghost trajectories, and 60,000 Runtime IR-shaped JSON events.
- `scripts/shell-evaluation.mjs native` rewrites one Python source file twenty times and
  measures watcher delivery, then starts, interrupts, cleans up, and restarts a Python
  parent/child process group. It also records the measurement runtime and artifact
  boundaries that are present.

The Runtime IR data is deterministic synthetic load, not a captured production trace.
The fixture therefore supports shell-to-shell regression comparisons but does not establish
a final production capacity target.

### Prerequisites

- Node and pnpm versions pinned by this repository
- `ffmpeg` with `libx264` for the generated video
- Python 3 for the process fixture
- the native prerequisites for the shell being evaluated

Install and verify the shared application first:

```sh
pnpm install --frozen-lockfile
pnpm check:web
```

Start the renderer fixture server in one terminal. It generates an ignored MP4 at
`shell-evaluation/fixture.mp4`; the fixture is never committed.

```sh
pnpm evaluate:shell:serve
```

Run Electron on an actual desktop without headless or GPU flags:

```sh
POIETRA_SHELL_EVALUATION_URL='http://127.0.0.1:4174/shell-evaluation/workload.html?shell=electron&autorun=1' \
  pnpm exec electron electron/main.mjs
```

Run the same page in Tauri. The override changes only the development URL and does not add
native commands or permissions:

```sh
pnpm tauri dev --no-watch --config shell-evaluation/tauri.workload.conf.json
```

In evaluation mode Electron prints one JSON line and exits. Tauri displays the same JSON in
the fixture window; save it manually. Keep the window visible and unobscured, do not interact
with it during the five-second concurrent phase, and record display refresh rate, power mode,
GPU, and operating system beside the result. Run at least three warm repetitions on each
target OS before using distributions as a release gate.

Run the common Node service workload with system Node and Electron's bundled Node:

```sh
pnpm evaluate:shell:native
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/shell-evaluation.mjs native
```

There is deliberately no Tauri-native equivalent in this decision PR. Implementing a Rust
port would prejudge #33; using the Node command as a Tauri result would conceal the sidecar
that Tauri would need. If Tauri is reconsidered, run this exact workload through the proposed
sidecar or Rust adapter and record its process tree and cleanup behavior.

For footprint evidence, use the operating system's proportional/private-memory metric over
the complete process tree after 30 seconds idle and again during the concurrent workload.
Do not sum RSS across processes: shared pages are counted more than once. Also record the
installed application, bundled runtime/sidecar, and system-WebView boundaries separately.

## Evidence captured

Raw 2026-07-23 output is stored in
[`docs/evidence/shell-evaluation-2026-07-23.jsonl`](evidence/shell-evaluation-2026-07-23.jsonl).

Environment: WSL2 Linux 6.6, x86-64, Node 24.13.0, Electron 43.1.1 with Node 24.18.0,
Python 3.12.3. The three recorded warm renderer runs used Electron's headless,
software-rendered path because no interactive display was available. These numbers prove
that the fixture and Chromium path work; they are not native-GPU or cross-platform release
numbers.

| Check | 2026-07-23 observation |
| --- | --- |
| Shared TypeScript/Vite production build | Pass; 1.47 seconds on this host; generated `dist` boundary 1,986,034 bytes. |
| Electron exact frame seeks | 30/30 returned the requested 30 fps media time; median run p50 24.6 ms and p95 50.4 ms (p95 range 50.1–59.9 ms). |
| Concurrent video and overlays | Median 60.01 animation fps; zero intervals over 25 ms across 903 frames; zero dropped video frames out of 785. |
| Runtime IR-shaped ingestion | Median 60,000 events in 585.6 ms (102,459 events/second) while overlay/video work continued. |
| Renderer JS heap | Median used heap increased from 2,181,222 to 10,576,262 bytes; this is Chromium-only diagnostic data, not total application memory. |
| Electron-bundled Node file watch | 20/20 writes observed; p95 1.08 ms on the local WSL filesystem. |
| Electron-bundled Node Python lifecycle | Ready 24.5 ms; process-group stop 20.64 ms; restart ready 14.41 ms; fixture parent and child both gone. |
| Electron downloaded Linux runtime | 326,063,995 bytes; this is not an installed-package measurement. |
| Local Tauri check | Not available on this WSL host: `pkg-config`/DBus development packages are absent. This is an environment limitation, not a Tauri failure. |

### Earlier reproducible Linux check

`Dockerfile.linux` pins Node 24, pnpm 10.23, Rust 1.92, and WebKitGTK 4.1. The
2026-07-19 Debian bookworm/Xvfb run established only basic build and startup viability:

| Check | Result |
| --- | --- |
| Shared production build | Pass |
| Tauri `cargo check --locked` and release build without bundling | Pass |
| Five-second Xvfb smoke | Both shells stayed alive |
| Tauri unbundled application binary | 10,673,304 bytes |
| Electron downloaded runtime directory | 326,079,615 bytes |
| Rough summed process RSS | Tauri about 536 MiB; Electron about 637 MiB |

The RSS figures are explicitly excluded from the decision: container/Xvfb is not a native
desktop and summed RSS double-counts shared pages. The size figures have different
boundaries because Tauri relies on the system WebView. Electron used `--no-sandbox` only
because that disposable smoke ran as root; production must never use that flag.

## Browser/common adapter boundary

The renderer must not import Electron, Tauri, Node filesystem, or child-process APIs.
The intended boundary is:

```text
React editor
  -> typed StudioBackendClient
       -> browser: same-origin HTTP service
       -> desktop: authenticated loopback service in an Electron utility process
  -> NativeBootstrap
       -> browser: managed-workspace capability only
       -> desktop: directory picker, service lifecycle, external-link and update hooks

Shared domain/service modules
  -> workspace registry, source analysis/lowering, render sessions, AI suggestions
  -> no Vite, Electron, or Tauri imports
```

The Electron main process starts and stops the utility process. A sandboxed preload exposes
only immutable bootstrap metadata and narrow native requests. The existing closed schemas
remain the trust boundary for every service request and response.

The packaged transport must use a random loopback port plus a per-launch capability token,
or an equivalently isolated application protocol. Every HTTP/API route validates that
capability. Media URLs require scoped, unguessable capabilities because a `<video>` element
cannot attach the normal authorization header. The renderer continues to receive opaque
workspace/session IDs and never absolute filesystem paths. Browser development keeps the
same client contracts through same-origin routes.

Moving the current Vite middleware into shell-neutral service modules and implementing this
bootstrap is #33. This ADR does not pretend the current static packaged window is at parity.

## Consequences and known risks

Positive consequences:

- The existing TypeScript filesystem, process-control, render, and safety behavior can be
  reused instead of rewritten.
- One pinned Chromium engine reduces media, Canvas/SVG, font, and pointer variance during the
  first product iteration.
- Browser and desktop can keep the same closed contracts and domain implementation.

Costs and risks:

- Electron has a materially larger download/install boundary and normally a larger idle
  footprint than a system-WebView shell.
- The team owns Chromium/Electron security update cadence and must ship updates promptly.
- A local service adds authentication, lifecycle, crash recovery, logging, and port-conflict
  work; moving it to a utility process is required to protect the main/UI processes.
- Python/Manim discovery, Windows process-tree termination, macOS signing/notarization, Linux
  codecs, and application updates are not yet qualified.
- The current Electron entry point does not yet enforce navigation allowlists, a production
  CSP, permission denial, or packaged API parity. These are acceptance criteria for #33.
- No representative Tauri renderer result, native macOS result, or native Windows result is
  available. The Linux renderer measurement was headless and software rendered.

## Reconsideration triggers

Reopen this decision when any of the following becomes true:

1. The completed Electron adapter cannot meet approved install-size, idle-memory, startup,
   battery, or update-frequency budgets on supported hardware.
2. A core video, overlay, accessibility, input, or distribution requirement is blocked in
   Electron/Chromium on a target OS.
3. Security, store, or enterprise policy prevents shipping the bundled Chromium/Node runtime.
4. Studio moves its render/workspace service out of the desktop application, eliminating the
   need for a local Node service.
5. A Tauri prototype runs this same renderer and native workload on Linux, macOS, and Windows
   without duplicated safety logic, and demonstrates a material product benefit under the
   approved budgets.
6. Electron drops or materially weakens a required platform, sandbox, media, or utility-process
   capability.

## Non-goals

- final Studio visual design
- production packaging, code signing, auto-update, or installer implementation
- complete Python sandboxing
- choosing the Runtime IR wire format or production event volume
- proving performance from WSL/Xvfb results
- deleting the Tauri experiment before the Electron adapter reaches packaged parity
