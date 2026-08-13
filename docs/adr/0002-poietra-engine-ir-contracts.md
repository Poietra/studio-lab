# ADR 0002: Versioned contracts for the Poietra Engine vertical slice

- Status: Accepted for bounded opt-in adoption
- Date: 2026-07-25
- Decision owner: Poietra Studio

## Context

Studio needs low-latency browser preview without moving source authority, arbitrary
Python execution, or final artifact production into an untrusted client. When this
ADR was adopted, the TypeScript core evaluated a Canonical Edit Program into a
`RuntimeSceneState`, and React projected that state into a DOM/SVG/KaTeX preview.
The implementation now uses the canonical Rust/WebGPU path described below; the
server remains responsible for Python lowering and authoritative Manim renders.

`fast-manim` is a Python-compatible runtime and reference renderer, not a portable
geometry library. RenderTrace v0 provides runtime identity, event, bounding-box,
and hash evidence, but not complete path points, paint, camera, or asset payloads.
Geometry must never be reconstructed from a bounding box or geometry hash.

The experiment therefore fixed a small renderer-neutral boundary before the
Rust/WASM/WebGPU implementation. This ADR now also records the implemented
bounded profiles and the limits of their adoption decision.

## Decision

Poietra Engine starts with three closed wire contracts:

```text
Canonical Edit Program              server-side fast-manim execution
          |                                      |
          v                                      v
  Studio Scene adapter              explicit geometry snapshot
          |                                      |
          +------------> SceneIrV1 <--------------+
                               |
                         pure evaluator
                               |
                               v
                       RenderPacketV1
                               |
                +--------------+---------------+
                |                              |
        Rust/WASM + WebGPU             Rust native/headless
```

- `SceneIrV1` contains known scene geometry and animation meaning.
- `RenderPacketV1` is one fully sampled, back-to-front 2D frame. It contains no
  animation or source semantics.
- `AssetManifestV1` identifies immutable external bytes.

All three use an exact schema name and integer version. Every object is strict at
runtime. A consumer rejects unknown fields, enum values, capabilities, and newer
versions before evaluating or drawing anything.

## Scene IR v1

Scene IR is independent of the current Studio model. The Studio adapter converts
the top-left, y-down viewport state to finite f64 Cartesian scene units. The
fast-manim adapter must produce the same normalized data from an explicit snapshot.
The contract contains:

- opaque identity, parent identity, lifetime, source z-index, and stable scene order;
- Circle, Rectangle, Line, absolute cubic Path, and PNG Image geometry;
- solid fill, solid stroke, opacity, image sampler, and 2D affine transform;
- affine, opacity, path-trim, path-morph, motion-path, vector-appearance, and camera channels;
- linear, smoothstep, Manim default smooth, and constrained cubic-bezier easing;
- orthographic camera, asset references, fidelity, and provenance;
- an exact sorted list of capabilities derived from the document's contents, including
  `vector-appearance-animation` when that channel is present.

There is no `unknown` value inside valid Scene IR. A producer that cannot prove
geometry, style, position, ordering, camera, asset identity, or animation meaning
returns a structured compilation error outside the wire document. It must not emit
a Scene with a `supported` assertion. An explicitly `approximate` Scene is allowed
only with non-empty evidence so the preview can label its fidelity.

`path-trim` defaults to the existing `arc-length-v1` interpretation when its
optional `parameterization` is omitted. `uniform-cubic-parameter-v1` instead
assigns equal progress to explicitly serialized cubics and applies the local
fraction with De Casteljau splitting. The currently partial subpath stays open;
fully consumed prior subpaths retain their closure. This matches Manim's pointwise
partial-path semantics without changing existing bytes.

`motion-path` likewise defaults to `arc-length-v1` when `parameterization` is
omitted. `manim-point-from-proportion-v1` mirrors the bounded canonical subset of
`VMobject.point_from_proportion`: it measures every explicitly serialized cubic
with 10 equally spaced points including both endpoints (9 chords), selects the
first cubic whose cumulative estimated length reaches the requested progress, and
uses the remaining fraction as that cubic's uniform parameter. Progress 1 returns
the final serialized endpoint exactly. A zero-length selected cubic uses parameter
zero; zero-length cubics at later progress are skipped by the cumulative scan. The
close flag does not synthesize another curve. This mode requires `orientToPath` to
be false because `MoveAlongPath` translates its mobject without rotating it.

Scene, entity, channel, and provenance identities preserve the portable ASCII
source fragment separator `#` used by imported IDs such as `scene.py#Scene`.
Generated packet/manifest IDs and asset IDs use the stricter portable subset
without `#`; source identity rules therefore do not leak into asset resolution.

Entity lifetimes are positive, ordered, non-overlapping, and bounded by Scene
duration; a child's lifetime is contained by its parent's lifetime. Parent
references are complete and acyclic. `sceneOrder` is unique.
Entity/channel provenance and animation targets must resolve. Keyframes are
strictly ordered and bounded by duration; the final keyframe has no outgoing
easing. Path-morph topology must match across samples.

Transforms compose from the root entity to the leaf. Within one hierarchy level,
the local affine maps a point as:

```text
x' = m11 * x + m12 * y + tx
y' = m21 * x + m22 * y + ty
```

The compiler resolves `(sourceZIndex, sceneOrder)` to final paint order. A renderer
does not independently sort Scene entities.

Animation channel meaning is fixed as follows. An affine or opacity channel
replaces the entity's base value at the sampled time. Path trim is the visible
prefix fraction `[0, 1]`, measured by cubic arc length across subpaths in declaration
order. Motion-path values are normalized progress `[0, 1]`. In the default
`arc-length-v1` mode, `orientToPath` uses the forward tangent, retaining the previous
non-zero tangent at a cusp. At a stationary path start with no previous tangent,
evaluation uses the first following non-zero tangent; if the entire path has no
tangent, oriented evaluation rejects the frame.
V1 motion paths contain exactly one subpath. Path morph is component-wise
interpolation of matching cubic control points. Path trim is restricted to
stroke-only entities because filling an open prefix would introduce an implicit
closing edge. Vector appearance interpolates solid fill/stroke RGBA components and
stroke width; stroke cap and join are left-held discrete values that switch at a
keyframe boundary, while paint presence, fill rule, and miter limit remain fixed.
An absent base paint may be materialized only by an explicit transparent first
keyframe; later `null`/solid cross-fades are invalid. A camera channel replaces the
base camera view. Only one channel may write a given entity/property, and only one
camera channel may exist.

V1 `arc-length-v1` evaluation is deterministic rather than adaptive: every cubic
is sampled at 64 equal parameter intervals and the resulting chord lengths are
accumulated. A position inside an interval linearly interpolates its parameter endpoints. Path
trim splits the selected cubic at that parameter with de Casteljau's algorithm.
Progress zero is represented by one degenerate cubic at the first path point, since
empty subpaths are not valid v1 data. Motion-path pose replaces the sampled affine
translation; orientation, when enabled, pre-rotates its sampled linear 2x2 part.

Before a channel's first keyframe, the base value is used; at and after its final
keyframe, the final value is held. Every non-final keyframe supplies the easing for
its outgoing segment. `linear` uses `t`, and the existing `smooth` uses
`3t² - 2t³`. `manim-smooth` is the distinct Manim default: the inflection-10
logistic sigmoid normalized to exact zero and one endpoints. After easing,
numbers, points, camera values, affine matrix components, cubic control points, and
vector paint components interpolate component-wise. The evaluation order is base
geometry, path morph,
path trim, base/vector appearance, base/affine transform, motion-path pose, then
root-to-leaf parent composition. Parent and child opacity multiply. Opacity and
camera are sampled independently from their base values.

`cubic-bezier` easing uses the CSS timing-function interpretation: solve the
monotonic x curve for normalized segment time, then evaluate y. All four controls
are bounded to `[0, 1]`, so opacity and trim cannot overshoot. An unsolvable or
non-finite sample rejects evaluation rather than falling back to linear easing.
The v1 reference solver begins at the normalized segment time, performs at most
eight Newton iterations, and then falls back to 24 bisection iterations when the
derivative is too small or Newton would leave `[0, 1]`; convergence tolerance is
`1e-7` in x.

### Source authority

For Studio-native scenes, the Canonical Edit Program and its evaluated state are
the editing source of truth. A client preview is not evidence that source lowering
or final rendering will succeed.

For imported Manim scenes, Python source and server-side execution remain the
source of truth. An `imported-manim-server-snapshot` is bound to source hash,
runtime configuration hash, snapshot hash, and snapshot schema version. The
fast-manim bridge exports explicit geometry, style, camera, scene order, supported
animation, and asset evidence for the bounded V1–V6 profiles. RenderTrace v0 is
used only for source/runtime identity correlation; semantics outside those
profiles remain on the server-rendered fallback.

The contracts have no asset locator, URL, data URL, absolute filesystem path, or
raw Python field. Human-readable provenance may name a source anchor, but the
browser renderer receives only RenderPacket and immutable asset IDs/digests.

## RenderPacket v1

A packet represents exactly one time sample. The renderer does not interpret
lifetimes, easing, keyframes, Manim animations, hierarchy, or Python behavior.
The initial draw union is deliberately limited to:

- an inline absolute cubic path with solid fill and/or solid stroke;
- an immutable PNG image with nearest or linear sampling.

Circle, Rectangle, Line, and quadratic data are compiled to cubic paths before the
packet crosses the boundary. A line from `p0` to `p1` uses control points
`p0 + (p1 - p0) / 3` and `p0 + 2 * (p1 - p0) / 3`. Cairo four-point curves and
OpenGL three-point curves are normalized by their respective adapters. An OpenGL
quadratic `(p0, q, p1)` becomes cubic controls
`c1 = p0 + 2/3 * (q - p0)` and `c2 = p1 + 2/3 * (q - p1)`. Adapters preserve
subpath and curve declaration order. The packet never exposes backend-specific
point layouts.

The canonical cubic representation is a list of subpaths. Each subpath supplies an
absolute start point, one or more `{control1, control2, end}` cubic segments, and a
close flag. Relative commands, quadratic commands, arcs, implicit moves, and empty
subpaths are invalid v1 data.

`draws` is the authoritative back-to-front paint order. `paintOrder` must equal the
array index and exists only as a cross-language consistency check. `sourceZIndex`
is diagnostic evidence and must match the source Scene entity; renderers do not
sort on it. Every entity active at the sample time contributes exactly one draw;
inactive entities contribute none. A path draw carries fill and stroke together.

Paths are transformed into world space in f64 before CPU tessellation. Stroke width
is a world-space value applied after that transform, avoiding backend-specific
non-uniform scaling and hairline rules. Image `localRect` uses
bottom/left/right/top in y-up local space; decoded PNG row zero maps to the top
edge. Sampling clamps to the image edge.

The orthographic camera and output viewport must have matching aspect ratios; v1
does not stretch a frame silently. The only renderer capabilities are
`cubic-path-fill`, `cubic-path-stroke`, and `png-image`. Their sorted list must equal
the features actually used by the packet.

Every production handoff uses the composite `EngineFrameV1` validator. It binds
packet Scene ID, duration, contract version, source/snapshot revision, manifest,
draw entity, lifetime, draw kind, static paint/asset/sampler/local rectangle,
source z-index, and resolved ordering to the same Scene IR. This is structural and
referential integrity, not proof that sampling was implemented correctly. The pure
evaluator tests must independently compare sampled path, transform, opacity, and
camera against golden results before either renderer consumes production frames.

The broader architecture may later need clip and dedicated glyph primitives, but
they are intentionally not promises of v1. Supported MathTex is compiled by the
pinned RaTeX/KaTeX outline module and normalized into the existing closed cubic
path primitive; imported MathTex uses separately verified snapshot geometry.
Unsupported source syntax is reported explicitly instead of invoking another
renderer. Adding clip,
SVG/JPEG/WebP, gradient, dash, filter, 3D, perspective, or material semantics
beyond the compositing modes defined below requires a new contract version after
fixture-backed design.

## Color and image filtering

Wire colors and decoded PNG texels are straight-alpha sRGB values in `[0, 1]`.
Before either nearest or bilinear sampling, a renderer:

1. converts each texel's RGB channels from sRGB to linear light;
2. leaves alpha linear and unchanged;
3. premultiplies linear RGB by alpha;
4. filters the premultiplied linear texels;
5. blends source-over in linear premultiplied space;
6. unpremultiplies when needed and encodes the output target as sRGB.

This order prevents transparent-edge color bleeding from differing between CPU and
WebGPU implementations.

The sequence above is the `linear-light` compositing mode and remains the implicit
v1 wire default. A sealed imported-Manim source profile may instead require the
explicit `manim-cairo-srgb` mode: vector RGB is premultiplied and blended in sRGB
channel space through the matching base-Unorm target view, reproducing Cairo's
observable output. Engine-frame integrity binds that choice to the source profile.
Image draws fail closed in this mode, so the PNG decoding and filtering contract
above remains exclusively linear-light until separate fixture-backed semantics are
defined.

## Asset manifest v1

The first manifest accepts PNG images only. Entries are sorted and uniquely keyed
by a portable ASCII asset ID and contain encoded-byte SHA-256, encoded byte length,
decoded pixel dimensions, exact media type, sRGB color space, and straight alpha
mode. The resolver is injected out of band and resolves only `(assetId, sha256)`.

`manifestDigest` is SHA-256 over UTF-8 JSON containing canonical manifest metadata
without `manifestDigest`. Field order is fixed by `canonicalAssetManifestV1`, and
entries are already in ASCII asset-ID order. Structural Zod parsing is synchronous;
the exported `parseVerified*` trust-boundary functions additionally recompute this
digest with Web Crypto before returning data.

After retrieval, a renderer verifies encoded-byte digest, actual media type,
encoded byte length, and decoded dimensions before making an asset available. A
missing entry, stale digest/reference, MIME mismatch, dimension mismatch, decode
error, or resource-limit violation rejects the entire frame. Placeholders and
partial drawing are not truthful fallbacks.

## Precision and resource limits

Scene evaluation, path geometry, camera math, transforms, and time use finite f64.

One f64 value must be classified against the renderer's narrower domain before
preparation: the determinant of an affine sample. The production snapshot
profile seals every finite, bounded, non-zero matrix, so a direct producer
value such as `stretch(1e-50, 1)` arrives verified; its geometry then collapses
in f32 and fails the *complete* frame. An affine sample is therefore treated as
singular when the determinant of its **f32-rounded** entries has magnitude below
`f32::MIN_POSITIVE` (1.1754943508222875e-38), and its active samples lower to
the draw-local `singular-affine-sample` empty reason. Sibling draws are
unaffected; an exactly singular sample, such as a reflection's midpoint, is the
`determinant == 0` case and is unchanged; and an ordinary small-but-renderable
scale stays a path draw.

Entries are rounded before multiplying because an entry can underflow on its
own — `m11 = 1e-50` with `m22 = 1e30` has an f64 determinant of `1e-20`, but
`m11` is zero once rounded. The threshold is stable across WASM and native
because it is a fixed IEEE-754 binary32 quantity rather than a tuned tolerance,
and the predicate reaches it only through operations IEEE-754 pins exactly in
both targets: round-to-nearest-even f64 to f32 conversion (`as f32` in Rust,
`Math.fround` in TypeScript) and one f64 multiply-subtract. No platform math
library is involved. Both implementations spell the same literal:
`MIN_AFFINE_DETERMINANT_V1` in `poietra-scene-ir` and `MIN_AFFINE_DETERMINANT`
in `src/engine/primitives.ts`.

Evaluation and packet validation classify a sample with the same predicate, not
with two copies of it: `poietra-eval` — the crate the Canvas worker loads through
`poietra-wasm` — calls
`poietra_scene_ir::affine_transform_is_singular_v1`, the function packet
validation itself uses. The golden fixture set carries a near-singular case
(`fixtures/engine-v1/shared-near-singular-affine.json`) which the native Rust
evaluator runs. The retired TypeScript reference evaluator no longer duplicates
this rule.

GPU preparation has one operation order:

1. compose parent/local affine transforms and transform local geometry in f64;
2. flatten cubic geometry in f64 world space at the target-derived 0.25 px bound;
3. subtract the sampled camera center and map fill positions to clip space in f64;
4. reject non-finite values, finite-f32 overflow, more than 0.25 px of conversion
   error, and distinct fill points that collapse in the f32 upload domain;
5. triangulate fills in that exact f32 upload domain; for strokes, camera-rebase
   transformed cubic controls in f64, check their f32 error, then run bounded Lyon
   stroke tessellation with a target-derived 0.25 px tolerance;
6. upload IEEE-754 round-to-nearest, ties-to-even f32 positions.

A single fill phase fails closed before or during tessellation above 2,048 source
cubics, 32,768 flattened input points, or 65,536 Lyon output vertices. A stroke
phase has the same 2,048-source-cubic and 65,536-output-vertex limits. These limits
also preflight at most 32,768 curve-flattening segments and 15 round-arc recursion
levels before entering Lyon, while a pixel-domain f32-ULP guard rejects controls
whose representational resolution exceeds the visible quantization budget. They
bound browser-worker latency and transient memory independently of the 1,000,000
vertex whole-frame ceiling. The 0.25-pixel bound applies to coordinate/scalar
conversion and curve flattening; Lyon's discrete miter-limit branch is evaluated in
the checked f32 domain rather than claimed as a full f64 outline-error proof.

Canonical hashing normalizes negative zero to positive zero before serialization.
The schemas bound each value and also bound document-wide entity, channel,
keyframe, draw, cubic-segment, asset-byte, decoded-pixel, and viewport-pixel totals.
Limits are v1 semantics, not renderer hints.
Scene cubic-segment accounting includes canonical primitive lowering (Circle 4,
Line 1, Rectangle 4, rounded Rectangle 8) and conservatively reserves one
synthetic closing segment for every closed explicit subpath, so a valid Scene
cannot overflow the RenderPacket segment bound merely by being lowered.

## Fail-closed behavior and fallback

The Studio Scene adapter consumes evaluated state and `Knowledge` directly. It must
not consume `ProposedStateProjection.canvas.entities` or `sampleProposedState()`:
that display projection intentionally substitutes `(0,0)`, scale `1`, and opacity
`1` when evidence is absent, and sorts entities for UI display. Those conveniences
would fabricate render evidence and lose paint order.

The adapter may also consult the Canonical Edit Program that produced the
evaluated state; it does not infer facts absent from both. Resolved camera,
appearance, complete paint order, imported geometry, and asset identity remain
explicit evidence because the Runtime Scene cannot reconstruct them. The bounded
mapping is:

| Input evidence | v1 result |
| --- | --- |
| imported vector, PNG, or MathTex with a verified runtime identity and snapshot geometry | preserved entity with Studio position/scale applied exactly once |
| Studio-created Circle, Rectangle, or MathTex with known static geometry/content and supported appearance evidence | normalized shape or closed cubic-path entity |
| supported opacity transition with known endpoints and easing | normalized opacity channel |
| unsupported animation, discontinuity, or MathTex content change | structured unsupported result and whole-Scene fallback |
| exact camera and matching viewport/frame evidence | normalized camera with the evaluated Scene duration |
| image without exact PNG digest, dimensions, and nearest/linear sampler | compilation error and fallback |
| any required `Knowledge.unknown` | compilation error and fallback |

This boundary is extended only when a mapping has fixture proof. Studio motion,
transform, and content channels that are not explicitly mapped are rejected rather
than copied into a different interpolation model. A failure for one entity rejects
the complete Scene and never returns a partial Scene IR.

In particular, fast-manim's default bicubic ImageMobject sampling is not silently
downgraded to v1 linear sampling. It remains unsupported unless an
adapter can prove a supported sampler or a later contract defines bicubic behavior.

Schema, capability, integrity, resource, compiler, initialization, or device-loss
failures return a structured error to the PreviewRenderer adapter. Studio reports
the missing or failed capability and does not substitute DOM/SVG paint or a stale
server artifact. A renderer never guesses a default, drops a draw, or renders only
the valid subset of an invalid frame.

## Versioning and compatibility

Documents are dispatched by exact `(schema, version)` before parsing. A v1 reader
accepts only v1 and a v1 writer emits only v1. Because readers are strict, adding an
optional field is still a wire-format change and requires a new version. The same
is true for field removal, enum addition, meaning change, numeric-limit change, or
new invariant. Editorial clarification that does not alter accepted documents may
remain on the same version.

During migration, a consumer may implement multiple exact schemas and explicitly
upgrade an older document. There is no coercion, passthrough mode, schema default,
or best-effort reading. Producers and consumers without a shared version use the
existing preview/server fallback.

A version suffix belongs only to a serialized or externally consumed contract,
or to an adapter that must implement two such versions at the same time. Internal
domain commands, errors, services, and use cases use semantic names without
`V1`/`V2`/`V3`; replacing their implementation does not create a second product
meaning. An external profile version may appear in integration code only where
the code actually dispatches on that profile. Fixture history is not a domain API.

## Repository boundary

The TypeScript contracts, Studio adapter, and Rust implementation stay in
`studio-lab` while the boundary evolves. Rust lives in the top-level `engine/`
Cargo workspace rather than under `src-tauri`, so browser, native/headless,
Electron, and Tauri can consume the same core without a desktop-shell dependency.

Extraction to an independent Poietra repository is considered only after browser
and native consumers pass the same golden fixtures and a release/compatibility
process exists. fast-manim remains a separate Python frontend/reference renderer;
its fork-specific runtime is not copied here.

### Server snapshot evidence boundary

The Studio server accepts a fast-manim snapshot result only through the strict
`poietra.fast-manim-snapshot-result` v1 envelope. The request ID, project, source
path, Scene name and ID, source hash, and runtime-configuration hash must all match
the pending server request. A compiled result is then checked as a complete
`SceneIrBundleV1`, including the asset-manifest digest and references, and must
contain fast-manim snapshot provenance. Unsupported results are explicit and
bounded rather than partial Scene snapshots.

Snapshot sealing is server-owned. A producer emits the all-zero SHA-256 sentinel
in both snapshot-hash positions. After all structural, correlation, provenance,
and manifest checks pass, the server hashes canonical bundle JSON with the
snapshot hash replaced by that sentinel and installs the resulting digest in both
positions. This avoids requiring the Python producer to reproduce JavaScript
floating-point JSON serialization. Revalidation accepts the resulting sealed
document, rejects a return to the zero sentinel, and rejects content changes.
Every provenance record in an imported snapshot must use the fast-manim server
origin; an unreferenced marker cannot authorize data with another origin.

Raw producer bytes are bounded before UTF-8 decoding or JSON parsing. Compiled
bundles are limited to 5 MiB and structured unsupported evidence to 256 KiB. The
initial bridge also rejects JSON deeper than 64 levels, arrays above 10,000 items,
or more than 25,000 total container entries before Zod validation. These bridge
limits are intentionally narrower than the general Scene IR theoretical maxima:
larger imported Scenes use the server-rendered fallback instead of amplifying
validation errors in the Studio server.

The contract is wired through the Scene-snapshot HTTP endpoint, bounded runner,
server sealing, and fast-manim V1–V6 exporters. Those exporters cover the declared
static/dynamic vector, MathTex, PNG, and generic planar VMobject profiles; they do
not claim arbitrary Python or updater semantics. Unsupported or unverifiable
Scenes continue through the existing server-rendered fallback.

### Canonical Scene replacement boundary

Every committed Scene update crosses the Canvas Worker boundary as a complete,
verified `SceneIrBundleV1`. Canvas ABI v5 correlates the installed base revision
with the candidate revision; Rust validates and indexes the complete candidate
before `EngineSessionV1` atomically swaps it in. A stale base, invalid snapshot,
or asset-integrity failure preserves the installed Scene, and the client advances
its revision only after the correlated acknowledgement. Studio-owned and imported
Manim snapshots use this same replacement path; there is no second delta mutation
implementation in TypeScript or WASM.

## Fixed experiment protocol and adoption budget

Every result records commit, contract version, fixture ID, browser build, OS/kernel,
CPU, GPU/adapter, driver, AC state, active power plan, user-configured AC power
mode, viewport, warm-up count, and sample count. Correctness runs use the
Playwright 1.61.1 Chromium revision
pinned by this repository. Decision-grade performance runs use installed native
Edge and its production-default D3D12 path on the checked-in, separately hashed
reference profile:

The former TypeScript-only evaluator benchmark was retired with its duplicate
evaluator. The canonical browser lane measures the shipped Rust/WASM/WebGPU worker
through `pnpm benchmark:engine:webgpu`; GPU submit/presentation, cold start, memory,
transfer, and bundle measurements remain separate fields rather than being folded
into one misleading evaluator number.

- Windows 11 Home build 26200, native Edge 150.0.4078.105;
- Intel Core Ultra 7 255H, 16 logical CPUs, 64 GiB RAM;
- NVIDIA RTX PRO 500 Blackwell Laptop GPU selected for WebGPU, driver
  32.0.15.9571 (NVIDIA 595.71), with the complete Intel/NVIDIA controller
  inventory pinned;
- AC connected, Windows Balanced active power-plan GUID
  `381b4222-f694-41f0-9685-ff5bb260df2e`, and user-configured AC power-mode GUID
  `ded574b5-45a0-4f42-8737-46345c09c238` (Best performance).

The authoritative values and Worker adapter identity live in the v2 profile
`fixtures/engine-benchmark-v1/windows-d3d12-reference-host.json`; the sibling
`.sha256` file detects byte drift and forces the profile and its pinned digest
to change together. Code review of both files remains the trust decision.
Linux/WSL SwiftShader runs remain useful exploratory regressions but cannot be
decision evidence. The main browser and all 20 independent cold processes must
report the same non-software Worker adapter identity. On wgpu 30's browser
backend, that identity comes from the same created `GPUDevice`: the raw
privacy-safe vendor and architecture strings, fallback classification, and
subgroup bounds. Production-default Edge redacts description, device, and
driver details. Native PCI vendor/device IDs and driver strings therefore
remain a separate OS-owned controller identity, while their Worker fields stay
canonical zero/empty; synthetic native-looking values invalidate the report.
The checked-in profile binds those two evidence classes explicitly instead of
claiming the browser exposed native PCI identity.

The eligibility/provenance envelope and canonical-run nonce are breaking
report-contract changes. Their exact dispatch pairs are
`poietra.engine-webgpu-benchmark` v4,
`poietra.engine-webgpu-stress-benchmark` v5, and
`poietra.engine-webgpu-stage-telemetry` v4. Producers and readers must reject
the respective prior versions instead of interpreting the added fields under
their old contracts. The Windows probe ignores caller `PATH`, `SystemRoot`,
`ProgramFiles`, and `PSModulePath`: it uses fixed Windows system paths and HKLM
machine installation data, and reads the user-configured AC power mode through
`PowerGetUserConfiguredACPowerMode`. Windows may override that configured vote,
so this is not evidence of the dynamically effective power mode. These checks
protect the harness from ordinary environment spoofing, not from an administrator
replacing registry or operating-system state; such a host is outside the
reference-evidence threat model.

Checked-in performance evidence is a rolling single current set, bound to its
profile and commit directory names. A future profile or report-contract
replacement replaces that set rather than making the current reader reinterpret
obsolete evidence. Results from different hosts are never combined. WebGPU-disabled
and initialization/device-loss runs are correctness/fallback tests, not GPU
performance samples.

The checked-in golden suite contains 15 stable workload IDs spanning:

- empty camera and frame edges;
- filled Circle, stroked Line, Rectangle with fill and stroke, and a cubic S-curve;
- overlap/alpha and equal source-z ordering;
- translation, rotation, non-uniform scale, and reflection;
- alpha PNG with nearest and linear sampling;
- camera pan/zoom;
- Create, FadeIn, Transform, and MoveAlongPath sampled at start, midpoint, and end.

Executable cross-runtime fixtures live under `fixtures/engine-v1`. Enumerations,
IDs, ordering, counts, and other discrete semantics compare exactly. Floating
results compare with each fixture's explicit combined absolute/relative tolerance:
`abs(actual - expected) <= tolerance * max(1, abs(expected))`. Packet byte hashes
remain reproducibility evidence within one evaluator/runtime; cross-runtime byte
identity is not claimed until transcendental math and number serialization are
specified independently of the host runtime.

Each benchmark uses 30 warm-up frames and at least 300 measured frames. Browser and
native/headless consume byte-identical EngineFrames. Adoption needs all fail-closed
fixtures and the following budgets on the reference host:

| Metric | Budget |
| --- | --- |
| warm frame evaluate + submit, basic fixture, p95 | <= 16.7 ms |
| warm frame evaluate + submit, stress fixture, p95 | <= 33.3 ms |
| scrub input to presented frame, p95 | <= 50 ms |
| worker + WASM cold ready, p95 over 20 runs | <= 1,000 ms |
| additional compressed engine payload | <= 3 MiB |
| observed retained response-boundary logical peak (`WASM linear + logical GPU resident`) | <= 256 MiB |
| Scene install/replacement snapshot | <= 5 MiB |
| browser/native perceptual parity | SSIM >= 0.995 and <= 0.5% pixels above 8/255 error |

The memory budget has a deliberately narrower boundary than either intra-frame
engine peak or browser-process RSS. `retainedBoundaryTotal` is exactly WebAssembly
linear-memory bytes plus logical GPU resident bytes at the post-GPU-fence,
pre-response-serialization boundary. Logical GPU resident is the allocated
capacity of the retained vertex/index buffer arena, the exact RGBA8 sample bytes
of the optional Manim/Cairo four-sample color target, plus the logical RGBA8 bytes
of retained image textures; it is not a claim about physical VRAM allocation.
The retained Scene index, prepared-geometry cache, and decoded image assets are
informative breakdowns inside WASM linear memory and are never added to the total
a second time.

Transient per-frame image vertex/index buffers (bounded separately at 64 MiB),
browser JS/DOM, and surface, pipeline, bind-group, sampler, driver, browser-process,
and compositor allocations not byte-accounted by the retained caches are outside
this gate. A future asset-workload memory slice must add same-frame transient
accounting before this metric can be called a full intra-frame engine peak.

The canonical gate observes one engine's lifetime high-water mark across every
one of the 300 measured stage-telemetry frames for each pinned workload, after the
30-frame telemetry warm-up. Every measured frame must expose memory evidence, and
the maximum reported `retainedBoundaryTotal.peakBytes` must remain at or below
256 MiB. This is an observed retained-boundary high-water mark with no loaded-
Studio baseline subtraction; full intra-frame peak and browser RSS require
separate evidence if they become adoption criteria.

The stress and stage-report schemas pin exactly six workloads in one canonical
order: 100 and 1,000 shape primitives, animated cubic paths, and PNG images. The
PNG workloads reuse one digest-verified asset with an even nearest/linear sampler
split. After warm-up, every measured PNG frame must hit both retained texture and
sampler-binding caches, perform no texture upload, binding creation, eviction, or
tessellation, create exactly the two transient geometry buffers, and upload exactly
104 bytes of vertex/index geometry per image draw. Retained texture and decoded-
asset memory must also remain observable. This makes asset reuse part of the
repeatable browser workload rather than a one-off fixture proof; it still does not
measure transient buffer allocation, physical VRAM, or browser/driver RSS.

Meeting a timing budget cannot override correctness, asset integrity, visual parity,
or fallback failure. The experiment produces a Go, conditional Go, or No-Go update
to this ADR before production migration.

## Final bounded Go/No-Go decision (2026-07-31)

**Go for the bounded, explicit-opt-in WebGPU preview on the named-host evidence;
No-Go for making it Studio's universal default renderer or exposing Python
execution to untrusted SaaS traffic.** The checked-in physical run meets every
defined correctness, latency, retained-memory, and static real-Manim compositor
gate. The 1,000 animated-cubic workload remains a documented service-level limit:
acknowledgement p95 is within 33.3 ms, but paced presentation reaches 40.42 fps
rather than 60 fps. Issue #295 is therefore a non-blocking optimization for this
bounded adoption, not evidence that every supported workload sustains 60 Hz.

The following evidence is reproducible in this repository:

| Area | Status | Evidence |
| --- | --- | --- |
| closed v1 contracts and integrity checks | met | TypeScript and Rust reject unknown fields, versions, capabilities, stale manifests, invalid references, and bounded-resource violations |
| canonical evaluation | met for the shared fill/Line fixture | the same Rust evaluator produces the pinned semantic result for `eng-v1-shared-circle-opacity` through native tests and the browser WASM adapter, including the canonical Line cubic |
| native WGPU output | met for the shared fill/Line fixture | Lavapipe readback proves black background, opaque blue fill, opacity-composited red fill, and green round-cap/interior pixels |
| browser WASM/WebGPU output | met for the shared fill/Line fixture | Chromium 146 Worker readback proves the same fill and round-capped Line sample points through retained Scene evaluation |
| retained browser boundary | met | the Worker transfers one Scene snapshot and canvas, retains both in Rust, and returns only bounded presentation correlation per frame |
| whole-Scene failure policy | met at contract, renderer, Worker, and client boundaries | unsupported draws, malformed responses, stale correlation, surface/device failures, and protocol divergence never produce a partial success |
| generated payload | met on the named host | the clean-commit report binds the served release WASM at 1,631,912 raw bytes / 552,354 gzip bytes with SHA-256 `2d917354...a640`, below the 3 MiB compressed budget |
| initial shared snapshot | met for the fixture | 2,414 encoded bytes, below the 5 MiB budget |
| fixture breadth and visual parity | met for the bounded corpus, static real-Scene slice, and exact `UpdatersExample` Runtime Trace slice | the catalog fixes 15 workload IDs; the corpus-driven full-RGBA lane covers affine/camera, PNG alpha, nested MathTex, generic stroke topology, and five bounded real MathTex morph samples. The V5 aggregate-path interpolation remains semantic evidence rather than exact Manim/Cairo animation parity. The independent static `RealPreviewScene` Cairo-to-visible-Edge compositor run passes at SSIM `0.9985658029` with `1,855 / 389,376` pixels (`0.47640327%`) above `8/255`, against gates of `0.995` and `0.5%`; expected, actual, diff, report, source, host, commit, producer, and served-WASM identities are checked in under [`docs/evidence/manim-compositor-parity-2026-07-31`](../evidence/manim-compositor-parity-2026-07-31/report.json). The local required Runtime Trace lane independently executes Cairo and compares seven full 640x360 RGBA frames after the real producer, server verification, lowering, and one retained WebGPU install. Its worst frame passes at SSIM `0.9993221454`; its largest over-`8/255` fraction is `1,007 / 230,400` pixels (`0.43706597%`), and a backward seek reproduces the bottom frame byte-for-byte. This is exact evidence only for the sealed official `UpdatersExample` profile, not arbitrary updater semantics. |
| renderer capability coverage | partial | non-convex closed cubic fills, multiple subpaths, holes, self-intersections, nonzero/even-odd rules, general cubic strokes with v1 caps/joins/miter limits, ordered fill-then-stroke composition, transforms/camera/animation, verified PNG images, and four-sample coverage for Manim/Cairo vector frames work; the shared stroke fixture also samples nonzero trim, morph, and motion. Open fill paths, portable linear-light antialiasing, and clipping remain truthful fallbacks. |
| Studio preview integration | met for bounded V1–V6 | The standard UI selects the server-backed WebGPU preview by default, preserves explicit tab-local consent before workspace Python executes, installs its verified snapshot once, and accepts only exactly correlated retained frame acknowledgements. Verified prepared geometry drives the paint-free React interaction overlay; unsupported semantics and failures are explicit rather than rendered by a second DOM implementation. Exact GPU texture readback and the named-host visible browser-compositor path are both covered. |
| atomic Scene replacement | met | Canvas Worker ABI v5 installs or replaces one complete verified snapshot; Rust validates and indexes the candidate before the swap, stale or invalid updates preserve the installed Scene, and imported Manim snapshots use the same boundary. |
| fast-manim bridge | met for bounded V1–V6; production arbitrary Python blocked | V1 covers the static Circle/Rectangle/Line slice; V2 adds variable duration and bounded affine, opacity, trim, morph, and motion channels; V3 adds hermetic MathTex; V4 adds verified PNG; V5 adds the bounded MathTex A/B/A morph; V6 adds generic planar VMobject paths. Studio hands canonical immutable request bytes to the explicit [sandbox backend boundary](../fast-manim-sandbox-backend.md), rechecks backend attestation and result correlation, and then verifies and seals the result. Runner-owned lifecycle bounds quarantine invalid adapters, omitted deployment defaults to production, and the local-process adapter remains explicit dev/test-only. |
| frame, scrub, and cold-start latency | met on the named host | native Edge/D3D12 on the pinned NVIDIA adapter records warm acknowledgement p95 0.7 ms, scrub p95 0.3 ms, and 20-process cold scene-ready p95 397.6 ms. Five stress workloads sustain about 60 fps; 1,000 animated cubics sustain 40.42 fps while remaining within the 33.3 ms acknowledgement budget. |
| retained-boundary memory budget | met for six canonical linear-light workloads; mixed-compositing follow-up pending | the existing six workloads remain single-sample and their largest post-fence high-water is 11,534,336 bytes for 1,000 animated cubics. A 1,920 x 1,080 Manim/Cairo frame adds an exact 33,177,600-byte retained target component; a fresh mixed-compositing benchmark remains follow-up evidence. Transient image allocation and browser/driver RSS remain explicitly excluded. |

The correctness run used Rust 1.92.0, Node 24.13.0, Playwright 1.61.1,
Chromium 146.0.7678.0, and Linux 6.6.87.2 WSL2 on the reference CPU. It passed
all Rust workspace tests, both separately enabled native GPU proofs, web unit tests,
wasm32 check and Clippy, release WASM smoke, and the Chromium WebGPU pixel proof.
Those Linux results remain correctness evidence rather than performance evidence.
The separate checked-in Windows run records Edge 150.0.4078.105 on D3D12/NVIDIA
Blackwell, 20 fresh browser processes, six stress and stage workloads, AC power,
the exact driver/profile/commit/WASM identities, and no eligibility exceptions.

Production-default migration remains blocked until independent follow-up work:

1. expands real Manim/Cairo parity beyond the bounded static Scene and sealed
   `UpdatersExample` Runtime Trace whenever a broader profile is proposed for
   default rendering;
2. promotes the current immutable snapshot/render artifacts and passes the
   operator-owned rootless production conformance gates (#186, #227, #280); and
3. completes the production rollout and multi-tenant adversarial evidence for
   arbitrary Python execution (#80–#85).

The measured 1,000 animated-cubic cadence limit is explicitly accepted for this
opt-in decision and tracked as non-blocking follow-up #295. It must be resolved or
given a narrower product service level before any claim of universal 60 Hz preview.

The Studio-side backend/job contract, runner-owned lifecycle bounds, production-
safe deployment default, and default-off local adapter are defined by #81 and
documented in the sandbox runbook. They establish the fail-closed handoff but do
not satisfy the OS isolation, hard-limit, multi-tenant, or rollout evidence
required from #82–#85.

The `PreviewRenderer` host and explicit server-side fast-manim snapshot exporter
cover the bounded snapshot profiles, while the separate verified Runtime Trace
path covers the sealed official `UpdatersExample`. The static real-Scene
visible-compositor gate and this one dynamic updater gate are complete; broader
dynamic Manim/Cairo parity and production operator evidence remain outside this
bounded decision.

WebGPU is accepted as an explicit bounded client preview, while the semantic
preview remains the default fallback. Server-side video rendering/export remains
authoritative; presenting a client frame never asserts that a final render or
source commit succeeded.

## Consequences

- The experiment measures one normalization boundary instead of porting Manim.
- Studio preserves its current evaluator and preview while Rust is optional.
- Explicit geometry makes the adapter do real work, but prevents unknown Studio or
  incomplete RenderTrace evidence from entering the renderer.
- The narrow packet excludes useful Manim features; unsupported scenes fall back
  truthfully until a later version defines them.
- Strict versions create migration work, but prevent browser and server from
  silently assigning different meanings to the same bytes.
