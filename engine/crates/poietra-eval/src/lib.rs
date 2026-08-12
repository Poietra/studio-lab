//! Canonical Poietra Engine v1 Scene semantics.
//!
//! This crate owns retained Scene revision application and samples a validated
//! [`poietra_scene_ir::SceneIrV1`] into the renderer-facing
//! [`poietra_scene_ir::RenderPacketV1`] boundary. It performs no I/O and has no
//! renderer or shell dependency, so native and WASM adapters use the same core.

mod authoring;
mod evaluator;
mod retained_index;
mod scene_delta;

pub use authoring::{
    RotateSceneEntityCommand, RotateSceneEntityError, SetSubtreeVectorPaintAlphaCommand,
    SetSubtreeVectorPaintAlphaError, TransformSceneEntityCommand, TransformSceneEntityError,
    UniformScaleAboutPivot,
};
pub use evaluator::{
    CompileEngineFrameOptionsV1, EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1,
    compile_engine_frame_v1, compile_render_packet_v1,
};
pub use retained_index::{
    MAX_RETAINED_SCENE_INDEX_BYTES_V1, RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1,
};
pub use scene_delta::{
    MAX_SCENE_DELTA_ACK_JSON_BYTES_V1, MAX_SCENE_DELTA_JSON_BYTES_V1, SceneDeltaErrorV1,
    scene_delta_updates_assets_v1,
};
