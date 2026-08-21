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
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError,
    ApplyStudioFragmentMaterialsCommand, ApplyStudioFragmentMaterialsError,
    ApplyStudioMathTexTransformEditCommand, ApplyStudioMathTexTransformEditError,
    ApplyStudioMotionEditCommand, ApplyStudioMotionEditError, ApplyStudioPersistentRemoveError,
    ApplyStudioTimelineEditCommand, ApplyStudioTimelineEditError, CreateSceneEntitiesError,
    ProjectStudioCreationEditError, ProjectStudioMotionEditCommand, ProjectStudioMotionEditError,
    SceneEditAnchorSource, SceneEditExecution, SceneEditScheduleMode,
    StaticRootMotionProjectionEntityIdentity, StaticRootTransformDimensions,
    StaticRootTransformEditInput, StaticRootTransformEntityKind, StaticRootTransformOperation,
    StaticRootTransformOperationKind, StaticRootTransformOrigin, StaticRootTransformSize,
    StaticRootTransformSourceBinding, StaticRootTransformStudioEntity, StudioAuthoringDimensions,
    StudioAuthoringEditResult, StudioAuthoringEntityKind, StudioAuthoringOrigin,
    StudioAuthoringSize, StudioBoundEntityAnchorSource, StudioBoundEntityEditCandidate,
    StudioBoundEntityEditCapabilities, StudioBoundEntityEditInput, StudioBoundEntityEditPhase,
    StudioBoundEntityEditResult, StudioBoundEntityExecution, StudioBoundEntityOperation,
    StudioBoundEntityProjection, StudioBoundEntityProjectionMutation,
    StudioBoundEntityScheduleMode, StudioCreationEditInput, StudioCreationEntitySpec,
    StudioCreationImageSpec, StudioCreationMathTexOutline, StudioCreationOperation,
    StudioCreationOperationKind, StudioCreationProjectedMutation,
    StudioCreationProjectedMutationKind, StudioCreationProjection,
    StudioCreationSegmentedMathTexFragment, StudioCreationSegmentedMathTexOutline,
    StudioCreationSegmentedMathTexRepresentation, StudioCreationSegmentedMathTexSourceCorrelation,
    StudioCreationSegmentedMathTexSourceCorrelationKind, StudioCreationSegmentedMathTexWritePlan,
    StudioCreationTextOutline, StudioFragmentMaterialAssignment, StudioMathTexContent,
    StudioMathTexTransformEditInput, StudioMathTexTransformEntityIdentity,
    StudioMathTexTransformOperation, StudioMathTexTransformOutline,
    StudioMathTexTransformProjectedReplacement, StudioMathTexTransformProjection,
    StudioMathTexTransformProjectionEntityIdentity, StudioMathTexTransformSourceBinding,
    StudioMathTexTransformStrategy, StudioMotionEasing, StudioMotionEditInput,
    StudioMotionEntityIdentity, StudioMotionOperation, StudioMotionProjection,
    StudioMotionProjectionBatch, StudioMotionProjectionEntityIdentity,
    StudioMotionProjectionInsertion, StudioMotionSourceBinding, StudioPersistentRemoveProjection,
    StudioPersistentRemoveProjectionEntry, StudioProjectedCreationEntity, StudioProjectedMotion,
    StudioProjectionEasing, StudioPropertyEasing, StudioTextFontFamily, StudioTimelineEditInput,
    StudioTimelineEditProjection, StudioTimelineEditTransform, StudioTimelineEventKind,
    StudioTimelineOperation, StudioTimelineProjection, StudioTimelinePurpose,
    StudioTimelineWaitReduction, project_studio_creation_edits,
    project_studio_math_tex_transform_edits, project_studio_motion_edit,
    project_studio_timeline_edits,
};
// Compatibility names for downstream Rust callers. Internal code and adapters use the
// Scene Edit vocabulary above; these aliases do not affect the serialized contracts.
pub use authoring::{
    SceneEditAnchorSource as StudioProgramAnchorSource,
    SceneEditExecution as StudioProgramExecution,
    SceneEditScheduleMode as StudioProgramScheduleMode,
    StaticRootTransformEditInput as StaticRootTransformProgram,
    StudioBoundEntityEditInput as StudioBoundEntityProgram,
    StudioCreationEditInput as StudioCreationProgram,
    StudioMathTexTransformEditInput as StudioMathTexTransformProgram,
    StudioMotionEditInput as StudioMotionProgram, StudioTimelineEditInput as StudioTimelineProgram,
    StudioTimelineEditProjection as StudioTimelineProgramProjection,
    project_studio_creation_edits as project_studio_creation_programs,
    project_studio_math_tex_transform_edits as project_studio_math_tex_transform_programs,
    project_studio_timeline_edits as project_studio_timeline_programs,
};
pub use evaluator::{
    CompileEngineFrameOptionsV1, EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1,
    compile_engine_frame_v1, compile_render_packet_v1,
};
pub use retained_index::{
    MAX_RETAINED_SCENE_INDEX_BYTES_V1, RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1,
};
