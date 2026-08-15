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
    ApplyStudioBoundEntityEditCommand, ApplyStudioBoundEntityEditError,
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError, ApplyStudioMotionEditCommand,
    ApplyStudioMotionEditError, ApplyStudioTimelineEditCommand, ApplyStudioTimelineEditError,
    CreateSceneEntitiesError, StaticRootTransformDimensions, StaticRootTransformEntityKind,
    StaticRootTransformOperation, StaticRootTransformOperationKind, StaticRootTransformOrigin,
    StaticRootTransformProgram, StaticRootTransformSize, StaticRootTransformSourceBinding,
    StaticRootTransformStudioEntity, StudioAuthoringDimensions, StudioAuthoringEntityKind,
    StudioAuthoringOrigin, StudioAuthoringSize, StudioBoundEntityAnchorSource,
    StudioBoundEntityEditCandidate, StudioBoundEntityEditCapabilities, StudioBoundEntityEditPhase,
    StudioBoundEntityExecution, StudioBoundEntityOperation, StudioBoundEntityProgram,
    StudioBoundEntityScheduleMode, StudioCreationEntitySpec, StudioCreationMathTexOutline,
    StudioCreationOperation, StudioCreationOperationKind, StudioCreationProgram,
    StudioMotionEasing, StudioMotionEntityIdentity, StudioMotionOperation, StudioMotionProgram,
    StudioMotionSourceBinding, StudioProgramAnchorSource, StudioProgramExecution,
    StudioProgramScheduleMode, StudioTimelineEditTransform, StudioTimelineEventKind,
    StudioTimelineOperation, StudioTimelineProgram, StudioTimelineProgramProjection,
    StudioTimelineProjection, StudioTimelinePurpose, StudioTimelineWaitReduction,
    project_studio_timeline_programs,
};
pub use evaluator::{
    CompileEngineFrameOptionsV1, EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1,
    compile_engine_frame_v1, compile_render_packet_v1,
};
pub use retained_index::{
    MAX_RETAINED_SCENE_INDEX_BYTES_V1, RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1,
};
