# ADR 0004: Separate persistent Studio edits from runtime Scene application

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Poietra Studio
- Issue: #659
- Related epic: #560

## Context

The canonical-core work moved production Scene edit admission, planning, and
mutation into Rust. TypeScript still owns the current time-sampled Studio read
model after it receives Rust-derived edit facts; that read-model sampling is not a
second mutation implementation. The migration removed the production generic
TypeScript mutation fallback, but it also accumulated several different concerns
under the word `authoring`. At the time of this decision,
[`poietra-eval/src/authoring.rs`](../../engine/crates/poietra-eval/src/authoring.rs)
contains the public edit inputs, closed-subset admission, identity correlation,
coordinate conversion, feature planners, Scene mutation, and Studio projections.
The corresponding
[`poietra-wasm/src/authoring.rs`](../../engine/crates/poietra-wasm/src/authoring.rs)
owns the browser wire adapter.

The TypeScript terms are also split across boundaries:

- [`studio/operations.ts`](../../src/studio/operations.ts) declares
  `CanonicalEditProgram` and `CanonicalEditOperation`;
- [`studio/operation-registry.ts`](../../src/studio/operation-registry.ts) owns the
  operation schema as well as Studio validation and source-lowering capabilities;
- [`render-pipeline/contracts.ts`](../../src/render-pipeline/contracts.ts) owns the
  accepted Program schema;
- [`collaboration/editor-session-contract.ts`](../../src/collaboration/editor-session-contract.ts)
  repeats a looser Program schema because an unfinished draft may be invalid.

The initial #659 hypothesis called `EngineSessionV1` an aggregate root because it
checks revisions and replaces a snapshot atomically. The implementation does not
support that conclusion. The persistent revision, accepted edit list, event
history, epoch, and compare-and-swap boundary belong to `EditorDocument`.
`EngineSessionV1` retains one validated `SceneIrBundleV1` and derived index for
runtime sampling. Atomic replacement is an important runtime invariant, but it
does not make a cache or execution holder a persistent aggregate.

This ADR names the owners before files or crates are rearranged. It does not add a
framework around the existing code.

## Decision

### Ubiquitous language

| Term | Meaning in Poietra |
| --- | --- |
| Authoring | The product activity of creating and editing a video. It is an umbrella term, not a state owner or a sufficiently precise core module name. |
| Studio | The editor application context: use-case orchestration, interaction state, and read-model presentation. It does not decide Scene mutation semantics. |
| Scene | The renderer-neutral animation model represented by Scene IR. `Scene` does not mean the React workspace, an Editor Document, or Python source text. |
| Edit | One structurally normalized, non-empty envelope admitted to an `EditorDocument` commit. The domain name is `SceneEdit`; the name does not assert that the edit is semantically applicable to an arbitrary Scene. |
| Program | Reserved for an actual executable program, such as Python source, or a future whole-video `MotionProgram`. It does not name one edit. |
| Operation | One ordered semantic operation inside a `SceneEdit`. It is not independently persisted or applied. |
| Command | An ephemeral invocation DTO. A command carries preconditions and one or more edits to an application or runtime boundary. |
| Plan | A private, typed Rust result of admission and planning against a particular base Scene. It is neither persisted nor serialized. |
| Projection | Read-only facts derived from accepted inputs or a validated Scene. A projection is never accepted as authority for a later mutation without revalidation. |

The main state-bearing concepts are:

| Concept | Lifetime and responsibility |
| --- | --- |
| `EditorDocument` | Persistent aggregate containing the committed, structurally accepted edit sequence and its revision history for one source-bound Scene. |
| `SceneEdit` | Immutable, structurally normalized edit envelope currently represented by the accepted subset of `CanonicalEditProgram`. It has one edit identity, anchor, provenance, schedule, and one or more operations. Rust admission against a particular base Scene decides semantic applicability. |
| `SceneEditDraft` | Subject-private, unaccepted editor state. It may be incomplete or invalid and cannot enter `EditorDocument` or a Rust apply command without validation. |
| `SceneEditOperation` | Ordered child of a `SceneEdit`, currently named `CanonicalEditOperation`. |
| batch apply pipeline | Private Rust procedure that can apply a non-empty sequence of `SceneEdit` envelopes as one all-or-nothing Scene snapshot transition. This ADR does not fix a public command name or wire contract for it. |
| `SceneEditPlan` | Private Rust plan produced for one base Scene. Feature-specific plan types remain implementation details. |
| `SceneIrBundleV1` | Immutable, validated preview/render snapshot. It is a materialized result, not edit history. |
| `EngineSessionV1` | Temporary runtime holder for a validated Scene bundle and retained index. It samples and atomically replaces snapshots but owns no persistent history. |
| `EditorSceneProjection` | Candidate name for the UI-facing model currently called `RuntimeSceneState`; it is a Studio read model, not runtime truth. |
| `EditorSessionSnapshotV1` | Subject-private resume data, including UI preferences, draft, and undo/redo state. Transactional storage beside a document commit does not make it part of the `EditorDocument` aggregate. |

`SceneEdit` is one structural persistence unit, but it is not proof of semantic
applicability and it is not every atomicity boundary in the system. One
`EditorDocument` mutation appends, replaces, or removes one edit. A private Rust
batch pipeline may apply a non-empty sequence of edits and replace the runtime
snapshot once. These are intentionally different boundaries.

### Persistent aggregate and invariants

`EditorDocument` is the persistent aggregate root. Its server-side transaction
owns these invariants:

1. tenant, project, document key, epoch, source path, Scene occurrence, and source
   hash identify the same open document;
2. revision numbers are contiguous and monotonic, and a mutation names the current
   base revision;
3. accepted edit identities are unique and their source-anchor order remains valid;
4. append, replace, or remove either updates the accepted edit projection and event
   ledger together or changes neither;
5. an idempotent client-mutation replay returns the original outcome rather than
   applying the edit twice;
6. a source change or sealed epoch cannot silently accept an edit for older source;
7. an optional private session update names the post-mutation document revision,
   while the session generation remains a separate subject-private concurrency
   boundary.

Undo and redo stacks are editor-session state. Their committed effects become
ordinary `EditorDocument` append, replace, or remove mutations, depending on the
resulting accepted sequence; the aggregate does not persist a user's private undo
stack or expose special undo/redo mutation semantics.

For an imported Manim Scene, Python source remains the final source authority.
`EditorDocument` is an edit overlay bound to an exact source hash. It does not
authorize Python references or claim that final Manim rendering succeeded.

### Runtime holder and invariants

Rust remains the single production authority for deciding whether a structurally
accepted Scene Edit is applicable to a particular base Scene, planning it,
mutating the Scene, and producing the resulting edit facts. TypeScript currently
samples those facts into the editor-facing read model. `EngineSessionV1` enforces
a narrower runtime boundary:

1. it contains exactly one validated `SceneIrBundleV1` and a matching retained
   index;
2. an apply invocation checks its expected base snapshot revision;
3. planning and mutation operate on a candidate, not the installed bundle;
4. complete Scene and asset validation plus index construction finish before a
   replacement;
5. any failure preserves the installed bundle and index;
6. one successful apply invocation replaces the snapshot once;
7. it owns no tenant, collaboration history, undo/redo history, source patch, or
   durable revision ledger.

The core may therefore be the semantic mutation authority without being the
persistence aggregate.

### Authority matrix

| Concern | Decision owner | Explicitly not the owner |
| --- | --- | --- |
| Scene Edit structural grammar, normalization, and non-empty closed schema | dependency-leaf Scene Edit contract | Rust semantic planner, render pipeline, collaboration transport, React component |
| draft construction, selection, gesture, playhead | Studio application and presentation | Rust Scene core, EditorDocument repository |
| accepted edit list, revision, CAS, event order | `EditorDocument` aggregate | browser replica, EngineSession |
| browser reconciliation and retry | collaboration client replica | persistent authority; the current `EditorDocumentAuthorityV1` name is misleading |
| Scene semantic applicability, admission, planning, and mutation | Rust core | structural schema acceptance, TypeScript read-model sampling, WASM adapter |
| edit-result facts, including projected channels, lifetimes, identity effects, and geometry | Rust core | React component, TypeScript feature-specific mutation logic |
| time-sampled Studio entity, canvas, inspector, and timeline read model | Studio TypeScript read-model sampling over the materialized Scene and Rust facts | Rust core today, React components, feature-specific TypeScript mutation logic |
| UI layout and presentation projection | Studio application | Rust renderer |
| Scene bundle validation, indexing, renderer-frame sampling, atomic swap | `EngineSessionV1` | EditorDocument, source lowerer, Studio read-model sampling |
| source occurrence and binding analysis | Manim integration and Source Analysis | Scene domain |
| source/runtime/Studio identity correlation | Manim integration supplies evidence; Rust admission checks the correlation it consumes | UI labels, raw variable-name guesses |
| Python reference safety and source patching | source lowerer / Manim anti-corruption layer | Rust Scene core |
| JSON parsing, byte limits, error transport | WASM and HTTP delivery adapters | domain planner |
| final render and fresh Manim validation | server sandbox and Manim | browser preview |
| tenant, authentication, billing, object storage | SaaS platform | Scene Edit and evaluation core |

The current read path is deliberately split rather than described as a completed
Rust-only evaluator:

```text
Rust semantic admission and edit application
                    |
                    v
validated Scene and Rust-derived edit facts
                    |
                    v
TypeScript time-sampled Studio read model
                    |
                    v
React presentation
```

TypeScript may mechanically materialize and sample the read model, but it must not
infer or replay edit mutation semantics. Moving this time-sampled read model into
Rust is tracked by #688; it is not part of the
behavior-preserving vocabulary rename or a prerequisite for accepting this ADR.

### Identity vocabulary

| Term | Meaning |
| --- | --- |
| source occurrence identity | One statically identified Python binding occurrence under an exact source hash. A variable name alone is not sufficient. |
| runtime identity | An object identity observed in a particular Runtime Trace or verified Scene snapshot. It is not assumed stable across unrelated executions. |
| Studio entity identity | The editor-facing identity used by selections and edits, including transaction-scoped identities for newly created entities. |
| binding evidence | Fresh integration evidence mapping source occurrence, runtime identity, and Studio identity. It is evidence supplied to admission, not a fourth identity. |
| provenance | Why a value or mutation exists. Provenance does not grant mutation authority. |
| Editor revision | Monotonic persistent `EditorDocument` revision. |
| Scene snapshot revision | Revision hash on one materialized Scene IR snapshot. It is a runtime precondition, not the Editor event sequence number. |

Manim-specific source hashes, variable names, Runtime Trace versions, and producer
profiles stay in the integration boundary. General Scene mutation does not branch
on them.

### Dependency direction

The intended dependency direction is:

```text
React / Electron presentation
            |
            v
Studio application use cases -------> Scene Edit contract
            |                                  ^
            |                                  |
            +--> Engine adapter                +-- EditorDocument application
            |        |                                  |
            |        v                                  v
            |     WASM adapter                 collaboration / repository adapters
            |        |
            |        v
            |     Rust Scene edit semantics --> Scene IR / evaluator
            |
            +--> Manim integration --> Source Analysis / lowering / sandbox
```

The following import rules apply to migration work:

- the Scene Edit contract is a leaf and imports no Studio application,
  collaboration, render-pipeline, React, HTTP, or persistence code;
- collaboration and render/source adapters may consume the contract but do not
  own or redefine it;
- persistence schemas do not call Studio capability or evaluation functions;
- the Studio application consumes Rust projections and does not re-run Scene
  mutation to construct a successful-looking read model;
- the current TypeScript read-model sampler may sample the resulting materialized
  Scene and Rust facts; replacing it with Rust-owned sampling is tracked by #688,
  not an implicit part of a rename;
- the Rust core imports no React, Electron, browser, Manim, Cloudflare, HTTP, or
  database dependency;
- the WASM adapter parses, bounds, converts, serializes, and transports errors; it
  does not decide edit semantics;
- feature modules depend on concepts such as timeline or identity owned by a
  named module, not on a new catch-all `common` or `utils` module.

This decision requires one contract owner, not a new package hierarchy. The first
implementation may be one leaf TypeScript module; a new `src` directory or Rust
crate is not justified by this ADR.

### Names and compatibility

The behavior-preserving rename issue #637 uses these targets:

| Current internal name | Target name or action |
| --- | --- |
| accepted, non-empty `CanonicalEditProgram` contract | `SceneEdit`; this is a structurally normalized envelope, not proof of semantic applicability |
| `CanonicalEditOperation` | `SceneEditOperation` |
| `ProgramValidationIssue` / `ProgramValidationResult` | `SceneEditValidationIssue` / `SceneEditValidationResult` |
| `ProgramRecord` | no blanket rename in #637; first separate accepted records from private draft/validation state, then name each role in the follow-up linked from #637 |
| `appliedPrograms` | internal `appliedEdits` |
| `stagedPrograms` | internal `stagedEdits`; changing the collection to a single draft is separate behavior work |
| `draftProgram` | internal `draftEdit` |
| `transactionId` | means edit identity; use internal `editId` only behind an adapter while the serialized field remains unchanged |
| `Studio*Program` Rust admission DTOs | `Studio*EditInput`, because each is a feature-narrowed input rather than a whole video Program |
| `StudioProgramExecution` / `StudioProgramScheduleMode` / `StudioProgramAnchorSource` | `SceneEditExecution` / `SceneEditScheduleMode` / `SceneEditAnchorSource` |
| `RuntimeSceneState` | later `EditorSceneProjection`; do not mix this state-shape change into #637 |
| `EditorDocumentAuthorityV1` | later `EditorDocumentReplica`; it coordinates a browser replica rather than owning persistence |
| `ProposedState` and `ProgramBatchAuthority` | delete if unused after #560 rather than preserving them through a rename |

`Canonical` disappears from the accepted envelope name because structural
normalization establishes that property. It does not mean that TypeScript proved
semantic applicability; Rust admission establishes that against each base Scene.
`SceneEditDraft` is a separate unaccepted contract. Neither `SceneEditDraft` nor a
speculative `SceneEditRecord` is a blanket replacement name for `ProgramRecord`.

Persisted and wire field names such as `program`, `programs`, `appliedPrograms`,
`transactionId`, and their version numbers remain byte-for-byte compatible during
these internal renames. A boundary adapter may expose the new vocabulary inside
the process. Changing serialized names requires a separate migration decision.

Version suffixes remain meaningful on external or durable contracts such as
`SceneIrBundleV1`, `EditorSessionSnapshotV1`, HTTP schemas, and WASM ABI symbols.
Internal planners, helpers, controllers, and repositories do not gain a `V1`
suffix merely because they are new. This ADR does not perform the repository-wide
version-name audit.

### Crate and module decision

`authoring` remains a product umbrella term, but it is too broad to name the core
mutation concern permanently. Future internal modules should use the concept they
own, such as Scene edit, timeline, identity, presence, creation, motion, or
transform.

The `poietra-eval` crate name remains unchanged for now. Renaming or splitting a
crate before its actual dependency boundary is established would add workspace,
packaging, and release churn without changing ownership. First separate cohesive
modules inside the existing crate. Reconsider the crate name only if the resulting
public API and independent consumers demonstrate a stable broader Scene-core
boundary.

## Migration order

Each step preserves current behavior unless it has its own feature issue.

1. Finish #560, including removal of the production generic TypeScript evaluator
   fallback.
2. In #689, add one dependency-leaf Scene Edit contract owner. Move the operation schema,
   accepted edit schema, and their TypeScript types behind compatibility
   re-exports. Do not rename call sites in that PR.
3. Also in #689, give accepted `SceneEdit` and unaccepted `SceneEditDraft` separate schemas.
   Applied EditorDocument entries use the non-empty accepted schema; a private
   draft may remain invalid. Move application capability checks out of persistence
   schema parsing.
4. Apply the safe internal renames from #637 while preserving every wire and
   persisted field. Do not rename `ProgramRecord` until accepted records and
   private draft/validation state have separate contracts and owners.
5. In #690, inside `poietra-eval`, extract cohesive behavior in dependency order: timeline
   transforms, identity correlation, presence/subtree removal, creation, motion,
   and transform families. Keep existing crate re-exports and WASM ABI stable.
6. After at least two feature paths demonstrate the same flow, factor one private
   batch-apply pipeline: validate envelope and schedule, plan against the base
   Scene, clone the bundle once, apply typed plans, validate the complete
   candidate, and replace the `EngineSessionV1` snapshot once. Do not publish or
   standardize a new command name until an actual external boundary requires one.
7. Move one existing apply entry at a time to that pipeline. Do not introduce a
   generic command bus, handler registry, factory hierarchy, or public plan types.
8. Delete superseded feature admission and TypeScript mutation paths only after
   their production references reach zero. A replacement path is not complete
   while the old semantic implementation remains callable.
9. Split large React and collaboration controllers only after their domain
   decisions have moved to the owners above; moving functions between hooks is not
   a substitute for this boundary.
10. Reassess the private `authoring` module and `poietra-eval` crate names after the
    migration. No rename is pre-authorized by this ADR.

## Public Rust authoring inventory

This appendix classifies the complete production inventory as of 2026-08-16. The
private `authoring` module declares 100 `pub` types. After #560, `poietra-eval`
re-exports 85 of them and four projection functions. The remaining 15 are
implementation-facing Scene mutation or projection types. Grouping them here
avoids turning 100 names into 100 proposed abstractions.

### Crate-exported types

| Owner/category | Current symbols | Candidate/action |
| --- | --- | --- |
| Application commands | `ApplyStaticRootTransformEditCommand`, `ApplyStudioBoundEntityEditCommand`, `ApplyStudioCreationEditCommand`, `ApplyStudioMathTexTransformEditCommand`, `ApplyStudioMotionEditCommand`, `ApplyStudioTimelineEditCommand`, `ProjectStudioMotionEditCommand` | Keep explicit commands while a private shared batch-apply pipeline absorbs demonstrated common mechanics; this ADR does not predeclare their replacement command or a command bus. |
| Command and projection errors | `ApplyStaticRootTransformEditError`, `ApplyStudioBoundEntityEditError`, `ApplyStudioCreationEditError`, `ApplyStudioMathTexTransformEditError`, `ApplyStudioMotionEditError`, `ApplyStudioPersistentRemoveError`, `ApplyStudioTimelineEditError`, `CreateSceneEntitiesError`, `ProjectStudioCreationEditError`, `ProjectStudioMotionEditError` | Stay with the feature that creates them; later common errors must arise from actual shared admission, not a speculative hierarchy. |
| Edit envelope and operation inputs | `StaticRootTransformOperation`, `StaticRootTransformOperationKind`, `StaticRootTransformOrigin`, `StaticRootTransformProgram`, `StudioAuthoringOrigin`, `StudioBoundEntityAnchorSource`, `StudioBoundEntityExecution`, `StudioBoundEntityOperation`, `StudioBoundEntityProgram`, `StudioBoundEntityScheduleMode`, `StudioCreationOperation`, `StudioCreationOperationKind`, `StudioCreationProgram`, `StudioMathTexTransformOperation`, `StudioMathTexTransformProgram`, `StudioMathTexTransformStrategy`, `StudioMotionEasing`, `StudioMotionOperation`, `StudioMotionProgram`, `StudioProgramAnchorSource`, `StudioProgramExecution`, `StudioProgramScheduleMode`, `StudioTimelineEventKind`, `StudioTimelineOperation`, `StudioTimelineProgram`, `StudioTimelinePurpose` | `*Program` becomes `*EditInput`; shared Program vocabulary becomes Scene Edit vocabulary. These remain feature-narrowed admission inputs until the common pipeline consumes the full edit contract. |
| Integration identity, geometry, and evidence inputs | `StaticRootMotionProjectionEntityIdentity`, `StaticRootTransformDimensions`, `StaticRootTransformEntityKind`, `StaticRootTransformSize`, `StaticRootTransformSourceBinding`, `StaticRootTransformStudioEntity`, `StudioAuthoringDimensions`, `StudioAuthoringEntityKind`, `StudioAuthoringSize`, `StudioBoundEntityEditCandidate`, `StudioBoundEntityEditCapabilities`, `StudioBoundEntityEditPhase`, `StudioCreationEntitySpec`, `StudioCreationMathTexOutline`, `StudioMathTexContent`, `StudioMathTexTransformEntityIdentity`, `StudioMathTexTransformOutline`, `StudioMathTexTransformProjectionEntityIdentity`, `StudioMathTexTransformSourceBinding`, `StudioMotionEntityIdentity`, `StudioMotionProjectionEntityIdentity`, `StudioMotionSourceBinding` | Keep explicit facts. Move each beside the identity, geometry, or feature owner when modules split; do not combine them into a generic evidence bag. |
| Semantic projections and results | `StudioAuthoringEditResult`, `StudioBoundEntityEditResult`, `StudioBoundEntityProjection`, `StudioBoundEntityProjectionMutation`, `StudioCreationProjectedMutation`, `StudioCreationProjectedMutationKind`, `StudioCreationProjection`, `StudioMathTexTransformProjectedReplacement`, `StudioMathTexTransformProjection`, `StudioMotionProjection`, `StudioMotionProjectionBatch`, `StudioMotionProjectionInsertion`, `StudioPersistentRemoveProjection`, `StudioPersistentRemoveProjectionEntry`, `StudioProjectedCreationEntity`, `StudioProjectedMotion`, `StudioTimelineEditTransform`, `StudioTimelineProgramProjection`, `StudioTimelineProjection`, `StudioTimelineWaitReduction` | Stay as Rust-derived read facts. Rename `StudioTimelineProgramProjection` to `StudioTimelineEditProjection`; do not let TypeScript recompute their meaning. |

The four exported projection functions are
`project_studio_creation_programs`,
`project_studio_math_tex_transform_programs`,
`project_studio_motion_edit`, and
`project_studio_timeline_programs`. They remain compatibility entry points while
their planners move; later names use `edit`, not `program`.

### Declared public types not re-exported by the crate

| Owner/category | Current symbols | Candidate/action |
| --- | --- | --- |
| Low-level Scene mutation primitives | `RotateSceneEntityCommand`, `ScaleAboutPivot`, `SceneEntityAxisFactors`, `SetSubtreeVectorPaintAlphaCommand`, `TransformSceneEntityAtTimeCommand`, `TransformSceneEntityCommand`, `TransformSceneEntityExpectedBaseline`, `TransformSceneEntityIntent` | Keep with transform or presence implementation and reduce visibility when no cross-module caller requires it. They are not EditorDocument commands. |
| Primitive mutation errors | `RotateSceneEntityError`, `SetSubtreeVectorPaintAlphaError`, `TransformSceneEntityError` | Keep private to the owning mutation path or translate once at the public apply boundary. |
| Projection vocabulary | `StudioProjectionEasing` | Keep with the private projection model unless a crate consumer actually requires it. |
| Static-root projection details | `StudioStaticRootMutation`, `StudioStaticRootProjectedMutation`, `StudioStaticRootProjection` | Keep as semantic projection facts and expose only through the result that needs them. |

## Consequences

- The persistent aggregate and runtime atomic holder are no longer conflated.
- Rust remains the only Scene mutation authority without becoming responsible for
  collaboration, Python source surgery, or SaaS infrastructure.
- Draft persistence can remain useful without weakening the accepted edit
  contract.
- Internal naming can improve without a persisted JSON or WASM migration.
- Module extraction has an order based on domain ownership instead of line count.
- `poietra-eval` may remain a slightly broad crate during migration; that is less
  harmful than an unproven crate split.

## Non-goals

- changing edit behavior, scheduling, ordering, revision digests, or source
  lowering;
- changing persisted JSON, HTTP contracts, collaboration wire fields, or WASM ABI;
- adding a new Rust crate, `src` folder, generic command bus, repository port,
  factory, or service layer;
- moving accounts, billing, R2, Cloudflare, sandbox execution, or final rendering
  into the Scene core;
- renaming every `V1`, `authority`, `Project`, `Workspace`, `Snapshot`, or `Runtime`
  symbol in this decision;
- treating a smaller source file as proof that responsibility ownership improved.
