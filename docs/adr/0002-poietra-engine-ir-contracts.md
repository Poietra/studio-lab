# ADR 0002: Versioned contracts for the Poietra Engine vertical slice

- Status: Accepted for the vertical-slice experiment
- Date: 2026-07-25
- Decision owner: Poietra Studio

## Context

Studio needs low-latency browser preview without moving source authority, arbitrary
Python execution, or final artifact production into an untrusted client. The
current TypeScript core evaluates a Canonical Edit Program into a
`RuntimeSceneState`; React then projects that state into a DOM/SVG/KaTeX preview.
The server remains responsible for Python lowering and authoritative Manim renders.

`fast-manim` is a Python-compatible runtime and reference renderer, not a portable
geometry library. RenderTrace v0 provides runtime identity, event, bounding-box,
and hash evidence, but not complete path points, paint, camera, or asset payloads.
Geometry must never be reconstructed from a bounding box or geometry hash.

The experiment therefore fixes a small renderer-neutral boundary before Rust,
WASM, or WebGPU implementation begins.

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
- affine, opacity, path-trim, path-morph, motion-path, and camera channels;
- linear, smooth, and constrained cubic-bezier easing;
- orthographic camera, asset references, fidelity, and provenance;
- an exact sorted list of capabilities derived from the document's contents.

There is no `unknown` value inside valid Scene IR. A producer that cannot prove
geometry, style, position, ordering, camera, asset identity, or animation meaning
returns a structured compilation error outside the wire document. It must not emit
a Scene with a `supported` assertion. An explicitly `approximate` Scene is allowed
only with non-empty evidence so the preview can label its fidelity.

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
order. Motion-path values are arc-length progress `[0, 1]`; `orientToPath` uses the
forward tangent, retaining the previous non-zero tangent at a cusp; v1 motion paths
contain exactly one subpath. Path morph is component-wise interpolation of matching
cubic control points. A camera channel replaces the base camera view. Only one
channel may write a given entity/property, and only one camera channel may exist.

Before a channel's first keyframe, the base value is used; at and after its final
keyframe, the final value is held. Every non-final keyframe supplies the easing for
its outgoing segment. `linear` uses `t`, and `smooth` uses `3t² - 2t³`. After easing,
numbers, points, camera values, affine matrix components, and cubic control points
interpolate component-wise. The evaluation order is base geometry, path morph,
path trim, base/affine transform, motion-path pose, then root-to-leaf parent
composition. Opacity and camera are sampled independently from their base values.

`cubic-bezier` easing uses the CSS timing-function interpretation: solve the
monotonic x curve for normalized segment time, then evaluate y. All four controls
are bounded to `[0, 1]`, so opacity and trim cannot overshoot. An unsolvable or
non-finite sample rejects evaluation rather than falling back to linear easing.

### Source authority

For Studio-native scenes, the Canonical Edit Program and its evaluated state are
the editing source of truth. A client preview is not evidence that source lowering
or final rendering will succeed.

For imported Manim scenes, Python source and server-side execution remain the
source of truth. An `imported-manim-server-snapshot` is bound to source hash,
runtime configuration hash, snapshot hash, and snapshot schema version. RenderTrace
v0 may correlate identity and provenance, but cannot generate this snapshot alone.
The fast-manim bridge must add an explicit geometry/style/camera/scene-order export
or use the existing server render fallback.

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

The broader architecture may later need clip and glyph-outline primitives, but
they are intentionally not promises of v1. MathTex continues through the existing
DOM/SVG or server-rendered fallback during this vertical slice. Adding clip, glyph,
SVG/JPEG/WebP, gradient, dash, filter, 3D, perspective, or material semantics
requires a new contract version after fixture-backed design.

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
GPU preparation has one operation order:

1. compose parent/local affine transforms and transform local geometry in f64;
2. tessellate fill/stroke in f64 world space;
3. subtract the sampled camera center from positions in f64;
4. map camera-relative values to clip space in f64;
5. reject non-finite values and values outside finite f32 range;
6. convert with IEEE-754 round-to-nearest, ties-to-even f32 at upload.

Canonical hashing normalizes negative zero to positive zero before serialization.
The schemas bound each value and also bound document-wide entity, channel,
keyframe, draw, cubic-segment, asset-byte, decoded-pixel, and viewport-pixel totals.
Limits are v1 semantics, not renderer hints.

## Fail-closed behavior and fallback

The Studio Scene adapter consumes evaluated state and `Knowledge` directly. It must
not consume `ProposedStateProjection.canvas.entities` or `sampleProposedState()`:
that display projection intentionally substitutes `(0,0)`, scale `1`, and opacity
`1` when evidence is absent, and sorts entities for UI display. Those conveniences
would fabricate render evidence and lose paint order.

The first adapter may also consult the Canonical Edit Program that produced the
evaluated state; it does not infer facts absent from both. Its initial mapping is:

| Input evidence | v1 result |
| --- | --- |
| known Circle/Rectangle dimensions, position, style, and ordering | normalized shape entity |
| Edit Program motion with explicit timing/control | affine or motion-path channel |
| default camera with fixed viewport evidence | normalized base camera |
| Line endpoints or cubic points absent from state/program | compilation error and fallback |
| ambiguous current `camera` number channel | compilation error and fallback |
| image without exact PNG digest, dimensions, and nearest/linear sampler | compilation error and fallback |
| any required `Knowledge.unknown` | compilation error and fallback |

In particular, fast-manim's default bicubic ImageMobject sampling is not silently
downgraded to v1 linear sampling. It remains on the server fallback unless an
adapter can prove a supported sampler or a later contract defines bicubic behavior.

Schema, capability, integrity, resource, compiler, initialization, or device-loss
failures return a structured error to the PreviewRenderer adapter. Studio then uses
the existing DOM/SVG semantic preview or current server-rendered artifact, while
visibly preserving the distinction between local preview and authoritative
render/export. A renderer never guesses a default, drops a draw, or renders only
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

## Repository boundary

The TypeScript contracts and first adapter stay in `studio-lab` while the vertical
slice changes. The Rust experiment will be a top-level `engine/` Cargo workspace,
not a child of `src-tauri`, because browser, native/headless, Electron, and Tauri
must consume the same core without a desktop-shell dependency.

Extraction to an independent Poietra repository is considered only after browser
and native consumers pass the same golden fixtures and a release/compatibility
process exists. fast-manim remains a separate Python frontend/reference renderer;
its fork-specific runtime is not copied here.

## Fixed experiment protocol and adoption budget

Every result records commit, contract version, fixture ID, browser build, OS/kernel,
CPU, GPU/adapter, driver, power mode, viewport, warm-up count, and sample count.
Correctness runs use the Playwright 1.61.1 Chromium revision pinned by this
repository. The first performance reference host is:

- Linux 6.6 WSL2, x86-64;
- Intel Core Ultra 7 255H, 16 logical CPUs, 32 GiB RAM;
- NVIDIA RTX PRO 500 Blackwell Laptop GPU, 6 GiB, driver 595.71.

A later host may be added, but results from different hosts are never combined.
WebGPU-disabled and initialization/device-loss runs are correctness/fallback tests,
not GPU performance samples.

The checked-in golden suite will contain 10–20 stable fixture IDs and at least:

- empty camera and frame edges;
- filled Circle, stroked Line, Rectangle with fill and stroke, and a cubic S-curve;
- overlap/alpha and equal source-z ordering;
- translation, rotation, non-uniform scale, and reflection;
- alpha PNG with nearest and linear sampling;
- camera pan/zoom;
- Create, FadeIn, Transform, and MoveAlongPath sampled at start, midpoint, and end.

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
| engine peak memory above loaded Studio baseline | <= 256 MiB |
| initial Scene snapshot | <= 5 MiB |
| typical edit delta across the worker boundary | <= 256 KiB |
| browser/native perceptual parity | SSIM >= 0.995 and <= 0.5% pixels above 8/255 error |

Meeting a timing budget cannot override correctness, asset integrity, visual parity,
or fallback failure. The experiment produces a Go, conditional Go, or No-Go update
to this ADR before production migration.

## Consequences

- The experiment measures one normalization boundary instead of porting Manim.
- Studio preserves its current evaluator and preview while Rust is optional.
- Explicit geometry makes the adapter do real work, but prevents unknown Studio or
  incomplete RenderTrace evidence from entering the renderer.
- The narrow packet excludes useful Manim features; unsupported scenes fall back
  truthfully until a later version defines them.
- Strict versions create migration work, but prevent browser and server from
  silently assigning different meanings to the same bytes.
