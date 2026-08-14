//! Canonical Poietra Engine v1 Scene semantics.
//!
//! This crate owns retained Scene revision application and samples a validated
//! [`poietra_scene_ir::SceneIrV1`] into the renderer-facing
//! [`poietra_scene_ir::RenderPacketV1`] boundary. It performs no I/O and has no
//! renderer or shell dependency, so native and WASM adapters use the same core.

mod authoring;
mod evaluator;
mod retained_index;

pub use authoring::{
    ApplyStaticRootTransformEditCommand, ApplyStaticRootTransformEditError,
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError, ApplyStudioTimelineEditCommand,
    ApplyStudioTimelineEditError, CreateSceneEntitiesError, CreateSceneMotionCommand,
    CreateSceneMotionEasing, CreateSceneMotionError, RotateSceneEntityCommand,
    RotateSceneEntityError, ScaleAboutPivot, SceneEntityAxisFactors,
    SetSubtreeVectorPaintAlphaCommand, SetSubtreeVectorPaintAlphaError,
    StaticRootTransformDimensions, StaticRootTransformEntityKind, StaticRootTransformOperation,
    StaticRootTransformOperationKind, StaticRootTransformOrigin, StaticRootTransformSize,
    StaticRootTransformSourceBinding, StaticRootTransformStudioEntity, StudioAuthoringDimensions,
    StudioAuthoringEntityKind, StudioAuthoringOrigin, StudioAuthoringSize,
    StudioCreationEntitySpec, StudioCreationEvaluatedEntity, StudioCreationEvaluatedEvent,
    StudioCreationMathTexOutline, StudioCreationOperation, StudioCreationOperationKind,
    StudioCreationProgram, StudioTimelineEventKind, StudioTimelineOperation, StudioTimelineProgram,
    StudioTimelinePurpose, TransformSceneEntityAtTimeCommand, TransformSceneEntityCommand,
    TransformSceneEntityError, TransformSceneEntityExpectedBaseline, TransformSceneEntityIntent,
};
pub use evaluator::{
    CompileEngineFrameOptionsV1, EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1,
    compile_engine_frame_v1, compile_render_packet_v1,
};
pub use retained_index::{
    MAX_RETAINED_SCENE_INDEX_BYTES_V1, RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1,
};
