# Edit operation model: findings from direct-manipulation experiments

Status: design findings; the Studio-owned v1 prototype boundary is now implemented
Last updated: 2026-07-22

The implementation contract and module map are documented in
[Studio state and canonical Edit Operation model](studio-state-operation-model.md).

The broader state-model comparison and proposed ObjectGraph / PropertyChannel /
EventTrack / ConstraintGraph / ProvenanceGraph split is maintained in the
[Poietra state, time, and edit semantics research memo](https://github.com/Poietra/poietra/blob/main/docs/research/2026-07-20-state-and-edit-semantics.ja.md).

## Outcome

The prototype made the interaction mechanics quickly, but it did not make the
product semantics simple. Each apparently local UI fix exposed a distinction that
must exist in the underlying model. The central product risk is no longer “can we
draw handles over a rendered frame?” It is whether Poietra can preserve one edit
meaning through all of these stages:

```text
RenderTrace and Scene state at time t
                ↓
        user gesture constraints
                ↓
       EditOperation candidates
                ↓
 truthful canvas and timeline previews
                ↓
       selected operation and conflicts
                ↓
    Scene IR mutation and source lowering
                ↓
       render and visual validation
```

The likely missing abstraction is therefore an Edit Operation IR. Scene IR says
what the animation is. Edit Operation IR says what the user proposes to change,
over which time and identities, with which propagation and conflict policy.

## What was easy and what was not

The following were mechanically straightforward in a hard-coded fixture:

- selecting and dragging rendered objects
- drawing ghosts, handles, paths, and timeline clips
- storing pending edits independently from the current selection
- sampling a known motion and displaying its result at a playhead
- splitting a timeline lane at known boundaries

The difficult part was assigning truthful meaning to those elements:

- whether a drag changes a state or creates temporal interpolation
- whether the dragged point is the state at the current playhead, the start of a
  future movement, or the end of a movement that began earlier
- which object identities and dependent objects participate
- how the edit intersects object presence and later transforms
- whether an existing motion is replaced, split, reshaped, or combined
- whether the displayed preview is actually reproducible by the lowered source

The original fixture hard-coded one 2D translation, one source motion, a small
dependency graph, and fixed object lifetimes. The runtime application now replaces
that fixture with a conservative Manim source import; the fixture remains only for
isolated model tests. A future Runtime Trace importer must still replace static
estimates for dynamic Python, updaters, and arbitrary geometry.

## Distinctions established by the experiment

These must not collapse into one UI state or one IR record:

| Concepts that looked similar | Required distinction |
| --- | --- |
| current selection and pending edit | Selection is transient UI state; an edit owns immutable target identities and parameters. |
| Manim `play` and edit zone | A gesture may introduce a new exact boundary inside a play. |
| Scene duration and object lifetime | Effects and picking are intersected with per-object presence. |
| saved group and active group members | A group may retain identities that are absent at the current time. |
| position change and movement | A position effect has no interpolated path; a movement owns time, timing and spatial interpolation. |
| spatial edit and content transform | Replacing MathTex content owns a source identity, target identity and cleanup strategy; it is neither a position change nor a movement subtype. |
| new movement and existing-path edit | One adds a new motion record; the other mutates an identified motion while preserving chosen invariants. |
| visual thumbnail and executable preview | A decorative glyph may explain a category, but it cannot claim to show the result unless it is derived from operation data. |
| candidate choice and parameter editing | Choosing an interpretation and tuning its duration, path or propagation are different interaction stages. |
| preview acceptance and source validity | A visually acceptable operation may still fail source lowering or re-render validation. |

## Gesture is a constraint, not an operation

A drag at 8.00 seconds from point A to point B does not uniquely identify an edit.
It establishes at least these constraints:

- selected runtime identities
- observed state and playhead
- pointer displacement in a known coordinate space
- optional modifiers and handles
- the rendered result the user inspected while dragging

Several operations can satisfy those constraints:

- place the object at B for the whole scene
- apply an offset beginning exactly at 8.00 seconds
- create a keyframe at 8.00 seconds and infer an earlier movement
- start a new movement at 8.00 seconds whose destination is B
- reshape an existing motion so that it passes through B at 8.00 seconds
- propagate any of the above to labels, arrows, layout constraints, camera, or
  later identity-linked objects

The system cannot remove this ambiguity by naming more toolbar modes. It must
generate a bounded set of operations, preview them truthfully, and let the user
confirm the interpretation when the consequences differ materially.

## Proposed conceptual records

The following separation is a design direction, not a frozen schema.

```ts
type GestureConstraint = {
  playhead: Time;
  selectedRuntimeIds: RuntimeObjectId[];
  renderedFrom: RenderedState;
  renderedTo: RenderedState;
  coordinateSpace: CoordinateSpace;
};

type LanguageConstraint = {
  playhead: Time;
  selectedRuntimeIds: RuntimeObjectId[];
  instruction: string;
  visibleContext: SceneContext;
};

type EditCandidate = {
  operation: EditOperation;
  evidence: Evidence[];
  confidence: Confidence;
  conflicts: Conflict[];
  previewStatus: "local" | "rendered" | "validated";
};

type EditOperation =
  | SetStateOperation
  | CreateMotionOperation
  | ModifyMotionOperation
  | CreateTransformOperation
  | CreateExplanationOperation
  | CreateSceneTransitionOperation
  | EditProgramOperation
  | ChangeConstraintOperation
  | ChangePresenceOperation
  | ChangeCameraOperation;
```

Common operation fields will likely include:

- stable target identities, not variable names
- exact temporal domain
- before-state preconditions
- desired after-state or invariant
- source and target semantic parts when the lowering strategy performs identity or
  glyph matching
- dependency-propagation policy
- overlap and composition policy
- coordinate space
- lowering capabilities and unresolved source choices
- evidence and confidence

`MotionRecord` remains useful for executable motion state. It should not also be
made responsible for the user gesture, candidate ranking, source patch, and
validation result.

## Language is another constraint source, not a privileged patch path

A playhead-aware instruction such as “at ten seconds, arc the equation upward over
one second” supplies constraints that a drag cannot express efficiently: an
explicit time anchor, an operation verb and qualitative path intent. It still does
not uniquely determine a source edit. Target identity, dependency propagation,
overlap behavior, coordinate space and lowering form may remain ambiguous.

Relative language is semantic input, not arithmetic-looking prose to discard.
“5秒前” is represented as a playhead-offset anchor and resolved against the
captured playhead before preview. The resolved start and the original anchor both
remain visible so Studio cannot silently reinterpret the phrase as absolute 5s.

Magic Edit should therefore feed the same candidate pipeline:

```text
playhead + selection + instruction
  -> LanguageConstraint
  -> supported-intent decomposition
  -> validated EditOperation or EditProgram candidate
  -> canvas / timeline / inspector projections
  -> user acceptance
  -> source lowering and rendered validation
```

It should not emit Python directly and then ask the UI to explain the result after
the fact. Model output must use a closed operation schema, reference identities that
exist in the supplied context, and remain a draft until the deterministic layers
check its temporal domain, ordering, dependencies, and geometry. Missing low-risk
presentation details can use deterministic defaults when the preview exposes them;
materially different targets, unsafe ordering, or destructive consequences should
become a focused clarification.
This does not mean asking for syntax the user should not need to know. A recognized
name with one dominant conventional form, such as Newton's equation of motion in
the current educational context, may resolve to `F = ma` as an explicit assumption.
Clarification is for competing meanings, not for the absence of user-authored LaTeX.

The first Studio experiment uses a compact floating Magic Edit board instead of a
persistent chat history. Its hypothesis is that creation requests are local to a
selected object and playhead; the video and timeline should remain the primary workspace.
The Magic Edit board lives at the viewport level rather than inside the rendered-frame
overlay, so it can move across the workspace. A persistent header control can hide
or restore it without discarding the current instruction or draft preview.
Whether a later project-level agent also needs durable conversational memory remains
an independent product question.

## Required invariants

1. Canvas sampling, timeline intervals, semantic thumbnails, and code preview read
   the same EditOperation or MotionRecord. No surface keeps a second geometry copy.
2. A position operation never displays a motion trajectory.
3. A displayed motion path is sampled from the path that playback will execute.
4. Selection changes cannot delete, retarget, or move a pending operation.
5. Effects do not silently extend beyond an object's proven presence.
6. Runtime identity and motion execution identity survive every analysis layer.
7. Unknown identity, presence, propagation, or lowering becomes an explicit
   uncertainty; it does not become a confident destructive rewrite.
8. “Apply” is not equivalent to “validated.” The UI retains validation status.
9. An operation that replaces a runtime object exposes the source-to-target identity
   transition; stable source-level variable names must not masquerade as stable
   runtime identity.
10. A relative temporal anchor remains attached to its resolved boundary as evidence;
    later playhead movement cannot retarget an accepted candidate.
11. An Edit Program is not a bag of unrelated edits. It has one captured anchor,
    two or three unique supported operation kinds, a declared `parallel` or
    `sequence` schedule, and an explicit transaction identity; Apply and Undo
    preserve that boundary.
12. Natural-language decomposition does not silently drop a supported sub-request.
    The deterministic layer rejects invalid targets, out-of-range intervals and
    conflicting parallel writes before preview.

## Interaction architecture

### Do not make Edit Type a growing top-level taxonomy

The prototype's explicit `Position / Animate` switch was useful for proving that
the concepts differ. It is not yet a good final navigation model. Adding Camera,
Constraint, Presence, Style, Group, and Transform would create a growing mode grid
before the user can perform a simple drag.

A stronger default flow is:

```text
drag first
  ↓
instant deterministic local preview
  ↓
show at most a few context-relevant interpretations when ambiguity matters
  ↓
select an interpretation
  ↓
show only that operation's inspector schema
```

Stable canvas tools may still exist for Select, Transform, Path, Camera and Timeline.
They should describe manipulation mechanics, not enumerate every semantic operation.

### AI is not required for a simple move

Basic picking, displacement, snapping, local preview, and undo must be deterministic,
low-latency, and usable without a model response. AI is appropriate for:

- ranking interpretations when more than one operation fits the gesture
- suggesting temporal scope and dependency propagation
- explaining and resolving overlaps with existing motions
- proposing source restructuring when no local patch is stable
- generating uncommon high-level constraint edits

StaticFacts, RuntimeTrace and explicit rules should generate the safe baseline
candidate. AI can rank or extend that set asynchronously. “AI-native” means the
system understands and mediates edit ambiguity; it does not mean every pointer move
waits for inference.

### Restore mini previews with a truth contract

The original mini trajectories were visually useful but semantically ungrounded.
They should return as semantic thumbnails generated from the candidate itself:

- SetState: before and after states plus the real temporal boundary
- CreateMotion: sampled spatial path, start/end markers and motion interval
- ModifyMotion: current path and proposed path from the identified MotionRecord
- CreateTransform: source and target content, exact interval, matching strategy and
  source-to-target runtime identity edge
- CreateExplanation: new Text identity, target-relative placement, appearance
  interval and persistent post-animation presence
- CreateSceneTransition: Scene-level shape preset, cover/reveal interval, fully
  covered Scene boundary and next-Scene destination
- EditProgram: ordered child operations, one captured anchor, parallel/sequence
  schedule, dependency checks and the atomic Apply/Undo boundary
- Propagation: target and dependent identity graph
- Presence: visible and absent intervals

A thumbnail is allowed to be a normalized diagram rather than a literal screenshot,
but every encoded relation must come from the operation. Changing operation
parameters must update the thumbnail. The thumbnail, canvas ghost, and timeline are
three projections of one candidate, not three manually synchronized previews.

### Keep candidate selection and parameter inspection separate

The right side currently combines interpretation candidates, animation parameters,
affected objects, source patch, validation and Apply. That will not scale. A likely
structure is:

1. a small contextual candidate strip
2. a schema-driven inspector for the selected operation
3. conflict and validation status next to the affected control
4. source details behind progressive disclosure
5. one clear commit action

## Animation parameters and progressive disclosure

The first fixture exposed only duration and easing. The shared runtime now also
projects an executable quadratic path and editable control handle, but a useful
movement operation still needs more semantic state than the raw Manim call shows:

- temporal anchor, start, end and duration
- destination state: position and potentially scale, rotation, style or opacity
- spatial path and control points
- easing or timing curve
- targets and dependency propagation
- coordinate space and constraints
- overlap/composition policy
- persistent state after the interpolation finishes

The local Manim reference also exposes base Animation options including `run_time`,
`rate_func`, `lag_ratio`, `reverse_rate_function`, `remover`, `introducer`,
`suspend_mobject_updating`, and `name`. Transform adds `path_func`, `path_arc`,
`path_arc_axis`, `path_arc_centers`, and
`replace_mobject_with_target_in_scene`. Composition introduces group runtime and lag
semantics.

Studio should not mirror all of those as one flat form. Use operation-specific tiers:

| Tier | Example fields |
| --- | --- |
| always visible | start/end, duration, easing, destination, affected objects |
| common advanced | path, coordinate space, propagation, lag, overlap policy |
| lifecycle advanced | updater suspension, introducer/remover, post-motion presence |
| Manim/source detail | raw path function, arc axis/centers, replacement and lowering form |

The inspector should be generated from an operation schema or capability registry.
Adding a new animation kind then adds its own fields without enlarging every other
operation's UI.

## Highest-risk unresolved semantics

### 1. Meaning of the dragged point at the playhead

The current prototype treats the playhead as the start of a new movement and the
dragged point as its future destination. Direct manipulation may instead imply that
the dragged point is the state at the current time and that the editor should infer
an earlier start or create a keyframe. Both must be tested on screen.

### 2. Overlap with existing motion

Creating a movement during an existing 4.00–7.00 second motion requires an explicit
policy:

- split the existing motion
- replace the overlapping interval
- apply an additive offset
- blend paths or properties
- reject and ask the user

The prototype currently behaves approximately like additive composition. That is
not a safe product default until it is visible and selectable.

### 3. Runtime identity across Transform and reappearance

At a Transform boundary, a rendered object may correspond to a source object, target
object, submobject matching, or replacement identity. An object may disappear and a
related identity may later reappear. Presence intervals alone do not decide which
later states an edit should affect.

The first executable fixture narrows one case: local Manim's
`TransformMatchingTex` cleanup removes the source mobject and adds the target. The
prototype therefore models `source runtime identity → target runtime identity` and
rebinds the exported Python variable after the play. This is a strategy-specific
fact, not a general promise that every Transform has the same identity semantics.

Matching quality also depends on construction shape. `MathTex("E = mc^2")` is one
matching part, while `MathTex("E", "=", "m", "c^2")` exposes reusable semantic
parts. The current operation therefore carries target `texParts`, supplies the
source parts as model context, and lowers unmatched groups with
`transform_mismatches=True`. Studio's character-level preview is only a semantic
projection of those parts; RenderTrace must replace it with evidence from the actual
Manim glyph animation before the result can be called validated.

### 4. Updaters, layout and constraints

A direct position patch may immediately be overwritten by an updater, regenerated by
`always_redraw`, or invalidated by later `next_to`, camera, and group operations.
Static dependency evidence and runtime behavior must inform both candidates and
validation.

### 5. Screen space, world space and camera

A pointer displacement is measured in screen pixels. Source edits may need world,
object-local, camera-frame, fixed-in-frame, or 3D coordinates. Coordinate space must
be explicit in GestureConstraint and EditOperation rather than inferred again during
source lowering.

### 6. Visual success versus reproducible source

Several different Python changes can render the same immediate frame but diverge
later. A candidate needs separate states for local preview, rendered preview, source
lowering, and post-render validation.

## Recommended next experiments

The next UI work should reduce these uncertainties instead of adding broad feature
surface.

1. Replace the pre-gesture Edit Type requirement with drag-first interaction and a
   contextual candidate strip.
2. Reintroduce faithful semantic thumbnails generated from EditOperation data.
3. Compare “dragged point is current keyframe” with “dragged point is future
   destination” using the same fixture.
4. Add a deliberate overlap fixture and expose split, replace, additive and reject
   outcomes.
5. Move parameters into a schema-driven inspector with basic and advanced tiers.
6. Carry one candidate end-to-end through Scene IR mutation, source lowering,
   partial render and visual validation.

The success criterion is not the number of supported edit types. It is whether one
operation remains understandable, executable and reproducible across every layer.
