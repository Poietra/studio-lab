//! Pure Poietra Engine v1 scene evaluation.
//!
//! This crate samples a validated [`poietra_scene_ir::SceneIrV1`] into the
//! renderer-facing [`poietra_scene_ir::RenderPacketV1`] boundary. It performs no
//! I/O and has no renderer or shell dependency, so the same core is suitable for
//! native and WASM consumers.

mod evaluator;
mod retained_index;

pub use evaluator::{
    CompileEngineFrameOptionsV1, EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1,
    compile_engine_frame_v1, compile_render_packet_v1,
};
pub use retained_index::{
    MAX_RETAINED_SCENE_INDEX_BYTES_V1, RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1,
};
