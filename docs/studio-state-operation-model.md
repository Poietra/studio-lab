# Studio state and canonical Edit Operation model

Status: implemented prototype boundary
Version: 1
Last updated: 2026-07-21

## Outcome

Studio now treats language and direct manipulation as constraint sources for the
same canonical, versioned operation pipeline. React owns interaction state, but it
does not resolve time anchors, expand UX macros, analyze channel dependencies, or
evaluate proposed Scene state.

```text
language / gesture constraint
            ↓
shared closed input schema
            ↓
canonical EditProgram + captured anchor + transaction ID
            ↓
capability registry → deterministic validation → dependency DAG
            ↓
pure ProposedState evaluator
            ↓
canvas / object list / timeline / inspector / thumbnail / playback / source status
```

Every projection receives the same `sampleId` and sampled entity array from one
`ProposedState`. The attributes in the prototype UI expose that identity for
inspection without introducing a second projection-specific state copy.

## Versioned state layers

The records in `src/studio/model.ts` keep five layers explicit:

1. `SourceSnapshot` identifies the source, hash, and config.
2. `StaticSemanticState` contains imported static facts and explicit `Unknown`
   values. Studio does not mutate this layer.
3. `RuntimeSceneState` contains runtime identities and the distinct
   `ObjectGraph`, `PropertyChannels`, `EventTrack`, `ConstraintGraph`, and
   `ProvenanceGraph` projections.
4. `EditorContext` contains playhead, selection, viewport, active Scene, and
   captured gesture/language context. Selection is never stored as an operation
   target.
5. `WorkingState` stores applied and staged program records. Its pure evaluation
   produces `ProposedState`.

The UI may additionally hold one ephemeral clarification envelope containing the
original instruction, latest model question, ordered choices, and an editor-context
fingerprint. It is request context only: it does not enter `RuntimeSceneState`, and
a choice always requests a new candidate before the normal Preview/Apply boundary.

Absence is represented by entity lifetime/presence. It is not `Unknown`.
Source identities use `Knowledge<T>` and are not runtime IDs. Timeline events are
not inferred from source order.

## Closed time anchors

`src/studio/time.ts` supports absolute Scene time, captured playhead,
playhead-offset, and structural boundaries. `resolveTimeAnchorOnce` returns a
resolved number plus the original closed record and evidence.

For example, with a captured playhead of 8 seconds, “5秒前” remains:

```ts
{
  source: {
    kind: "playhead-offset",
    referenceSeconds: 8,
    offsetSeconds: -5,
  },
  capturedPlayhead: 8,
  resolvedSeconds: 3,
  evidence: ["captured-playhead:8.000", "playhead-offset:-5.000"],
}
```

Changing the editor playhead later cannot mutate that record.

## Canonical operations and macros

The IR uses the bounded vocabulary in `src/studio/operations.ts`, including
`CreateEntity`, `SetProperty`, `AnimateProperty`, `CreateMotion`,
`ModifyMotion`, `TransformContent`, `SetRelation`, `ChangePresence`,
`InsertTimelineEvent`, and `InsertSceneBoundary`.

UX macros expand before validation:

- Explanation → `CreateEntity(Text)` → `SetRelation(next-to, snapshot)` →
  `ChangePresence(fade-in, persistent)`.
- Scene transition → provisional overlay → cover → explicit full-cover Scene
  boundary → reveal/remove.
- Camera focus → `ChangeCamera(scale)` in parallel with bounded
  `AnimateProperty(scale)` emphasis on the captured selection.
- New equation → `CreateEntity(MathTex)` → snapshot position → persistent
  `ChangePresence(fade-in)`; no selection is required.
- New equation + its explanation → the new-equation expansion plus
  `CreateEntity(Text)` → `SetRelation` to the transaction-local MathTex identity →
  persistent `ChangePresence`; both intents share one Apply/Undo boundary.
- MathTex-to-words → `TransformContent(replacement-transform)` with a new Text
  runtime identity and a semantic cross-fade preview.
- Transform + explanation → `TransformContent` plus the explanation expansion;
  the relation targets the transform's transaction-scoped replacement identity.

New entity IDs use `tx:<transaction>/entity:<local-name>`. While a program is only
staged, validation rejects its provisional IDs from every other transaction. Apply
promotes the produced runtime entities to stable Studio identities, so later
transactions may select and edit them without pretending that an unknown Python
source identity has been recovered.

## Registry and deterministic invariants

`src/studio/operation-registry.ts` is the capability boundary. Each operation
declares its closed Zod schema, defaults, read/write channels, target and lifetime
requirements, validator, evaluator, projection consumers, and lowering status.

`src/studio/program-validation.ts` adds explicit, identity, read-after-write, and
write-conflict edges before a stable topological sort. A requested parallel
program is rejected with the exact `execution` field when overlapping channel
writes or non-identity read-after-write hazards need an order. It is never silently
rewritten into a different semantic schedule.

Unknown source identity blocks destructive `TransformContent`. Unsupported
destructive lowering is invalid. Illustrative lowering stays visibly marked and
does not claim source or visual validation is complete.

## Shared model-output validation

`src/ai/edit-suggestion-schema.ts` is imported by both the Vite server endpoint
and browser client. Remote structured output passes the same schema and refinements
before canonicalization. Tests construct explicit operation values and contain no
natural-language suggestion implementation. Model output remains a draft; prompt
instructions do not replace deterministic safety checks.

## Transaction behavior

`src/studio/transactions.ts` stages, applies, and undoes whole `ProgramRecord`
values. A record owns one captured anchor and transaction ID, so selection changes
cannot retarget it and Apply/Undo cannot split a multi-intent request.

## Verification and current limits

`pnpm test` covers relative anchors (including the recorded “直前” -1 second
default), immutable targets, transform/explanation
identity dependencies, three-intent preservation, parallel conflicts,
transactional Apply/Undo, provisional-to-stable identity promotion, cross-transaction
preview rejection, projection consistency, snapshot relations,
Scene boundaries, camera focus, new MathTex creation, MathTex-to-Text replacement,
direct motion normalization, shared schemas, and Unknown identity rejection.

Source lowering and browser morph rendering remain prototype-grade. Registry
metadata labels those paths as `supported`, `illustrative`, or `unsupported`.
The separate rendered-validation experiment now carries one straight
`CreateMotion` with known source targets through explicit source-anchor lowering
and an actual Manim MP4 before guarded commit; it does not generalize that evidence
to other operations or claim arbitrary Python execution.
