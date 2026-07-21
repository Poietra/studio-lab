# Drag interpretation prototype

## Purpose

This disposable screen turns the discussion about edit intent into a concrete
interaction. It is not the final Studio design and it does not claim that the
displayed patches are safe for arbitrary Manim source.

The reusable design conclusions from this fixture are extracted into the
[Edit operation model memo](edit-operation-model.md). This document describes what
the current screen does; the memo distinguishes working conclusions from open
product and protocol questions.

The fixture starts at five seconds with `equation_1` selected at its rendered
position. A reviewer can:

1. play the scene and observe the example animation between four and seven seconds
2. select one or more objects with the object-list checkboxes, Select all, or Shift-click
   on the canvas
3. choose `Position` when the drag should change layout without creating interpolation
4. choose `Animate` to create a timed movement or edit an existing source motion
5. inspect the selected object's stored source motion and its complete spatial path
6. drag the selected object group or adjust it with the arrow keys
7. change the selection without discarding any pending displacement
8. save a multi-object selection as a named group, reselect it, and drag it together
9. drag the path handle to bend the candidate trajectory; the object position at the
   playhead is sampled from that edited trajectory immediately
10. scrub the playhead to choose the exact frame where a new edit starts
11. compare a position-only change with a new timed movement or an edited existing motion
12. compare the ghost object, affected timeline range, object list, and source diff
13. apply multiple edits to the working preview, scrub across their temporal boundaries,
   and undo them in reverse order
14. type a playhead-relative instruction such as “move 96 px right in an upward arc
   over 1.5s” and inspect the resulting motion in those same surfaces
15. use an explicit time anchor such as “10秒の時点から64ピクセル上へ1秒かけて移動”
   to create a new timeline boundary and motion clip at ten seconds
16. ask “これをマクスウェル方程式に変更して”, review a distinct MathTex
   transform candidate, and Apply it across the canvas, Scene lane, object lane,
   source preview, and working playback state
17. ask “Newtonの運動方程式に変形して” without spelling out LaTeX, obtain the
   canonical `F = ma` target, and play or scrub a semantic symbol-matching preview
18. ask “5秒前からマクスウェル方程式に文字を出現させて解説して”, preserve
   `playhead-offset: -5` as evidence, and preview one atomic parallel `EditProgram`:
   `E = mc²` transforms to Maxwell's equations while a persistent explanatory Text
   appears beside the replacement target
19. freely combine movement, content transform, and visible explanation in one
   sentence; review the three decomposed steps and their dependency-safe sequence
   without choosing one verb or restating default durations
20. ask “ここで良い感じの図形でシーンチェンジしたい” without selecting a
   target object or naming a shape; review a Scene-level diamond cover/reveal,
   its fully covered next-Scene boundary, and its generated source marker

`Position` and `Animate` are separate primary modes. A position edit shows only the
current object and its proposed destination; it never draws a trajectory arrow and
never creates temporal interpolation. `Animate` creates an explicit motion interval.
The user chooses its duration, the default `smooth` easing is visible, the timeline
shows a `new move` clip, and playback samples the candidate between its start and end.
The blue path in the frame is built from the same start, control, and destination
values used by that sampler. It is not a decorative candidate thumbnail.

The timeline has one Scene lane and one lane per Scene object. Existing animation
appears on the owning object's lane. Persistent position effects and path-shape
changes use different labels and intervals; there is no generic `Edit` clip. A
pending candidate is dashed and becomes a solid working-preview effect after Apply.
Starting a positional edit creates an exact boundary at the dragged playhead. The
Scene lane automatically subdivides its existing play zone there instead of snapping
the change back to the containing play's start.

Object presence is also time-varying. This fixture keeps the equation for the full
scene, removes the label and arrow at 9.50s, and removes the proof box at 10.50s.
The canvas, object list, candidate generator, group outline, and timeline all read
the same lifetime intervals. A positional edit is intersected with each affected
object's active lifetime, so an edit started at 8.50s affects the equation until
12.00s but its label and arrow followers only until 9.50s. Their lanes show both the
presence rail and the exact endpoint of the edit effect.

The source animation is represented by one `MotionRecord`. Its time interval,
spatial path, target Object IDs, and Manim `rate_func` name are kept together.
Both canvas drawing and playhead sampling read that same record, so applying a
path edit cannot leave playback on a stale copy of the original trajectory.
Spatial path and easing remain independent properties; this fixture uses Manim's
default `smooth` rate function.

Pending edits are also independent from the current selection. When selection
changes, the active candidate is staged with its own object IDs, interpretation,
time interval, affected objects, displacement, and path change. It therefore
remains visible and keeps affecting the preview while another object is edited.

The candidate list is mode- and playhead-sensitive. In `Animate`, `Edit “Move
equation”` appears only while the selected object is inside that existing
source-motion interval. `Create movement` remains available in Outro. Clicking a
source-motion clip switches to `Animate`, moves the playhead into the interval, and
selects that exact stored motion.

The right panel no longer contains schematic mini-paths. Position candidates state
their temporal scope, while movement candidates show their actual start, end,
duration, easing, and affected objects. Source-lowering language is kept inside the
optional Code change disclosure.

This removal is not a conclusion that mini previews are undesirable. The experiment
showed that hand-authored curves which do not describe the candidate are misleading.
A future iteration should restore them as semantic thumbnails generated from the
same EditOperation or MotionRecord used by canvas sampling and playback.

The viewport-level workspace also contains a compact `Magic Edit` board.
It can be dragged beyond the rendered frame, or hidden and restored from the
persistent header control without discarding its current instruction or draft. It
is intentionally not a persistent chat panel. The current playhead and selected
runtime object are supplied as visible context, so an instruction is interpreted
as an edit request at a concrete frame rather than as a conversation about the
whole project. A successful response is converted into a closed EditOperation candidate.
Spatial instructions use the same `Create movement` candidate as direct
manipulation. A supported MathTex content request instead produces a distinct
`CreateTransform` candidate with source and target runtime identities, a target
equation preview, an exact interval, and a `TransformMatchingTex` lowering strategy.
An explanation request produces `CreateExplanation`: a new Text identity, its
selected target, relative placement, FadeIn interval, persistent lifetime, and the
original absolute or playhead-relative time anchor. In all cases the owning object
lane, inspector, Code change preview and Apply action
remain authoritative.

A shape-based Scene-change request produces standalone `CreateSceneTransition`.
Unlike the object operations, it requires no selected target. Its closed preset
contains `circle | diamond | hexagon`, `black | sky | white`, a cover/reveal
interval, and the next-Scene destination. For vague aesthetic wording the model
chooses within that bounded vocabulary from the supplied context and exposes its
choice as an assumption; Studio does not force a fixed shape/color pair.
The canvas samples the real coverage curve, the Scene lane exposes the fully
covered midpoint, and source preview marks where the incoming Scene composition
must be connected. The browser does not invent the contents of that incoming Scene.

Free-form instructions are first decomposed into the supported leaf operations.
One effect remains a leaf candidate; two or three effects become a bounded
`EditProgram` with one captured time anchor, unique operation kinds, and an explicit
`parallel` or `sequence` schedule. This is not tied to one example sentence or to
the Transform-plus-Explanation pair. Studio independently verifies every target,
interval, dependency and parallel write before preview, lowers the accepted program
as one or more Manim plays, and applies or undoes the transaction atomically.

The current compatibility rule permits the MathTex transform and its explanation
in one parallel play. A movement that writes the same object as a transform, or
whose position is observed by a new explanation, is scheduled sequentially. A
parallel request with those conflicting dependencies is not guessed into a
different result; it receives a focused ordering clarification.

Magic Edit now requires a configured model endpoint. There is no runtime keyword
parser or deterministic fixture fallback. If the endpoint is absent the composer is
disabled with a visible configuration error. The remote endpoint must return the
closed operation union, and its object IDs, object types, interval, content and
geometry are checked again before preview.

### Live-model checkpoint · 2026-07-20

The local server adapter was exercised with `gpt-5.6-luna` through the OpenAI
Responses API and a strict structured-output schema. These are individual smoke
tests, not latency or quality benchmarks:

| Instruction | Result | Wall time |
| --- | --- | ---: |
| `10秒の時点から64ピクセル上へ1秒かけて移動` | `CreateMotion`, 10.00–11.00s, Δy −64, selected equation only | 3.71s |
| `10秒の時点でモーションを追加して` | clarification asking for a direction or destination | 1.62s |
| `Move 96 px right in an upward arc over 1.5 seconds` | destination correctly separated as Δx 96, but the first result added an unjustified horizontal control offset | 3.13s |
| same arc instruction after tightening the coordinate contract | Δx 96, control offset (0, −48), matching the symmetric upward arc | 8.67s |
| `これをマクスウェル方程式に変更して` | `CreateTransform`, 5.00–6.50s, four-equation MathTex target, source identity replaced | 2.76s |
| `Newtonの運動方程式に変形して` | `CreateTransform`, canonical `F = ma`, matchable parts `F`, `=`, `m`, `a`, mismatch morph enabled | 2.32s |
| `5秒前からマクスウェル方程式に文字を出現させて解説して` at 5.00s | parallel `EditProgram(CreateTransform, CreateExplanation)`, captured playhead 5.00s, offset −5, resolved start 0.00s | 4.4s |
| `5秒前から右へ80px動かして、その後マクスウェル方程式に変えて、初心者向けの説明文を横に表示して` | sequence `EditProgram(CreateMotion, CreateTransform, CreateExplanation)`, default durations 1.5s + 1.5s + 1.0s, atomic browser preview | 6.9s |
| `ここで良い感じの図形でシーンチェンジしたい` | `CreateSceneTransition`, Scene-level diamond + sky defaults, 5.00–6.50s cover/reveal, midpoint next-Scene boundary | 6.7s |

The first result propagated through the browser into the real canvas path, exact
timeline boundary, pending object-lane clip and existing inspector. This establishes
that an API key and structured model output are enough to test the language-to-
candidate UX. It does not establish that model inference is required for every edit,
that latency is acceptable without streaming, or that the candidate can be lowered
and visually validated against a real Manim scene.

The arc case exposed a separate semantic-validation requirement. Strict structured
output guaranteed the operation shape, but it did not guarantee that the chosen
control point was the simplest geometry consistent with the instruction. The model
added `controlOffset.x = 48` to a horizontal move while describing that offset
inconsistently. The server prompt now defines the control point relative to the
straight-path midpoint and constrains a plain upward arc to zero horizontal offset.
This kind of invariant belongs in deterministic candidate validation once the path
vocabulary is formalized; prompt wording alone is not a sufficient long-term guard.

The MathTex case exposed a different boundary. The earlier operation schema could
only represent translation, so a request to change equation content necessarily
failed even though the model understood the words. Extending the schema—not merely
adding `Transform` to a prompt—was required. The UI now treats the result as a
content transform rather than another `Position / Animate` mode, displays its target
equations and identity transition, creates exact timeline boundaries, and advances
to the target state after Apply. A live Manim render is still required to validate
glyph correspondence. When the requested interval overlaps the fixture's existing
4.00–7.00s equation motion, the inspector exposes the unresolved need to split or
compose that play instead of hiding it.

The first prompt policy was still too conservative for named equations. It treated
missing literal LaTeX as material ambiguity and asked the user to restate Newton's
equation even though `F = ma` is the dominant conventional interpretation in this
context. The revised policy resolves widely recognized equation names to their
canonical forms, records the choice as an assumption, and reserves clarification
for names without a dominant form. The remote model receives the current MathTex
parts and returns target `texParts`; a test-only fixture covers the same canonical
Newton mapping without acting as a runtime provider.

For the fixture source, `E = mc^2` is constructed as the matchable arguments `E`,
`=`, `m`, and `c^2`. The Newton target is constructed as `F`, `=`, `m`, and `a`.
`TransformMatchingTex(..., transform_mismatches=True)` therefore keeps exact shared
parts such as `=` and `m` continuous while morphing unmatched groups. The browser
plays a time-sampled character-level approximation derived from the same source and
target display data. It is labelled a semantic morph because only a Manim render can
validate the exact vector-glyph correspondence.

## Interpretation of this experiment

The explicit `Position / Animate` control is a research instrument. It proved that
state edits and temporal interpolation need different semantics and visual
affordances. It should not yet become the product's growing top-level Edit Type
taxonomy. Camera, constraint, presence, style, grouping, and transform semantics
would make that taxonomy expand before a user can perform a simple drag.

The stronger product hypothesis is drag-first interaction: provide an immediate,
deterministic local preview and surface only a bounded set of context-relevant
interpretations when their consequences differ. Basic displacement must not require
AI. StaticFacts, RuntimeTrace, and local rules produce a safe baseline; AI may rank
or extend candidates for temporal scope, propagation, conflicts, and source
restructuring.

Natural-language input complements that hypothesis rather than replacing it. Drag
is best when the desired result is spatial and already visible. Language is useful
for creating behavior that is not yet on the canvas, naming a time anchor, or
combining temporal and spatial constraints in one gesture. Both inputs should
produce EditOperation candidates; neither should bypass preview, conflict analysis,
source lowering, or validation.

The prototype also exposed a missing boundary between Scene IR and UI state. A
GestureConstraint records what the user did at the rendered frame. An EditOperation
records one proposed meaning, its temporal domain, identities, propagation and
conflict policy. Selection, candidate, source patch, and validation status must not
be combined into one mutable record.

Run it in the provisional Tauri shell with:

```sh
pnpm dev:tauri
```

`pnpm dev:web` is sufficient when reviewing only the shared interaction.

## Decisions to make from the screen

- Is `Position` versus `Animate` the correct first decision, or should the editor
  infer a default and expose the distinction only when ambiguity is material?
- Should all candidate ghosts be visible together, or only the selected plan?
- Should a position effect be drawn as a continuing range, a keyframe marker, or
  a separate property track?
- Does the affected-object list make follower propagation understandable, or
  does the relationship need to be drawn directly on the canvas?
- Is source diff useful during candidate selection, or should it appear only
  after the visual plan is chosen?
- Does “Apply selected patch” imply more certainty than the system has before a
  full render?
- When an object is added after a drag, should it inherit the entire pending
  displacement, join only from the current time, or start a separate edit?
- Is one shared quadratic control point sufficient for a selected group, or does
  each object need an independent path plus an optional group constraint?
- Should path editing preserve timing, speed, easing, arc length, or only the
  geometric trace?
- After anchoring a new movement at the playhead, should its end default to object
  exit, the next structural boundary, a user-drawn duration, or an AI suggestion?
- Should a newly created movement place the dragged destination at the interval end,
  as this prototype does, or create a keyframe at the current playhead and infer its start?
- Should changing the propagation plan alter only the downstream effect range,
  or also move and resize the motion clip?
- Is a Studio group only a saved selection/constraint, or should it lower to a
  persistent Manim `Group` / `VGroup` identity in exported source?
- Should group membership itself vary over time?

## Findings from this iteration

- `Edit scope` was the wrong abstraction. The first choice is the meaning of the
  gesture; temporal scope and dependency propagation are properties of that meaning.
- A flat Edit Type selector is also unlikely to be the final abstraction. It is
  useful for isolating hypotheses, but operation kinds and their independent time,
  propagation and conflict axes would produce a combinatorial menu.
- A simple position drag does not need AI. Model assistance belongs where a gesture
  admits materially different temporal, dependency, conflict, or source meanings.
- The likely durable boundary is GestureConstraint → EditOperation candidates →
  truthful preview → source lowering and validation.
- Position and motion are different edit kinds, not two differently styled scope
  candidates. A position edit has no trajectory. A movement owns a time interval,
  easing, spatial path, and persistent end state.
- A motion-path preview must be executable data. Decorative mini-curves that are not
  derived from the proposed motion make the UI less trustworthy. Compact previews
  remain desirable when generated as faithful projections of operation data.
- Selection cannot own draft geometry. Otherwise clicking a different object
  makes an unrelated pending edit disappear or jump.
- A single aggregate edit lane hides which objects actually change. Object identity
  must remain visible through source motion, candidate generation, and Apply.
- Spatial-path edits are not translated-object edits. Editing an existing move keeps
  endpoints and timing fixed and solves a path control from the dragged point.
- A path-edit candidate is valid only when the playhead lies inside the motion it
  edits. Showing it in Outro created a selectable no-op.
- A play is not an edit zone. Snapping an Outro drag back to 7.00s hid the gesture's
  actual temporal meaning. New positional edits now split the timeline at the exact
  dragged frame.
- Scene duration is not object duration. Object-level presence must constrain picking,
  group membership at a frame, affected-object propagation, preview geometry, and the
  endpoint drawn on each timeline lane.
- Multi-selection and grouping are different. Multi-selection is transient; a named
  group stores Object IDs and gives the canvas a persistent joint-manipulation target.
- Layout stability is part of direct-manipulation correctness. Variable-width delta
  labels previously reflowed the frame header and moved the entire viewport, which
  looked exactly like the object position had been reset.
- New motion created inside an existing motion introduces an unresolved composition
  policy: split, replace, add, blend, or reject. The current additive approximation
  must not become an invisible product default.

## Deliberate fixture assumptions

- The scene objects, relations, plays, and source anchors are hard-coded.
- The EditPlans are not generated by AI or StaticFacts yet.
- `next_to` and Arrow endpoint relations are labeled as construction-time
  snapshots, not live followers.
- “From this frame” starts at the exact playhead used for the first non-zero drag.
- A new positional effect continues only through each affected object's current
  lifetime. Objects already off screen are excluded from the candidate.
- Object lifetimes are hard-coded fixture data. Reappearance of the same runtime
  identity remains unresolved. The fixture models `TransformMatchingTex` as source
  identity replacement by a target identity, in accordance with the current local
  Manim cleanup path; other Transform strategies remain unresolved.
- A new movement starts at the current playhead and defaults to one second. Its end
  is clipped to the earliest exit among affected objects, and its final offset persists
  for each object until that object's own exit.
- Selection changes stage the current candidate instead of applying or discarding it.
- Named groups currently store Object IDs in Studio state. They do not yet rewrite
  the source into `Group` or `VGroup`. A group's active members are the stored IDs
  that are present at the playhead; disappeared members remain in the saved group.
- Multiple staged candidates can be applied together; the prototype does not yet
  expose a dedicated stack for reordering or removing one pending candidate.
- The source patch is illustrative and is not written to disk.
- Source and edited paths are retained in the in-memory working preview and drive
  both trajectory drawing and playback. Lowering a curved path into Manim source
  or a future Scene IR is deliberately unresolved.
- The main Apply action changes only the in-memory working preview. A separate
  rendered-validation slice can lower one straight `CreateMotion` with known
  source targets at an explicit source anchor, run Manim against a temporary copy,
  then atomically commit or discard it. Other operations still have no source
  writer or render validation.
- Natural-language suggestions currently create `CreateMotion`, the narrowly
  supported MathTex `CreateTransform`, bounded `CreateExplanation`, or standalone
  Scene-level `CreateSceneTransition` operations.
  Explanation creation keeps its relative anchor, adds a Text object on a separate
  timeline lane, and previews target-relative FadeIn plus persistent presence. The
  bounded `EditProgram` transaction combines any two or three unique
  motion/transform/explanation operation kinds, preserving parallel or sequential
  order instead of forcing a choose-one clarification or silently discarding one
  requested effect.
  `CreateSceneTransition` remains standalone in this version because its midpoint
  changes the active Scene composition rather than one object property.
  Tests use explicit structured operations. No keyword parser exists in either the
  test path or runtime Magic Edit; runtime requires `VITE_POIETRA_AI_ENDPOINT` and
  labels every accepted candidate as an AI draft.
- Applied `CreateEntity` and `TransformContent` results become normal selectable
  runtime identities. They can be selected from the object list or canvas, moved
  directly, and supplied as targets to the next model request. Preview-only
  identities remain locked until Apply.
- API credentials must remain in the local or hosted suggestion service. A browser
  or Tauri webview must never receive a provider secret through `VITE_` variables.

These assumptions identify the next integration boundary without turning this
shell experiment into a second product repository.
