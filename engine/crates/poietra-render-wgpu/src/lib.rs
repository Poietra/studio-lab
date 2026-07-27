//! Minimal browser/native WGPU renderer for validated Poietra `RenderPacketV1` frames.
//!
//! CPU preparation supports non-convex solid fills across closed cubic subpaths,
//! including holes and both v1 fill rules, plus stroke-only canonical Line cubics
//! whose cross-runtime control roundoff remains safe for the 0.25 px centerline
//! and stroke-normal error budgets. It is independent of a GPU device and rejects
//! the complete frame when any draw falls outside that bounded subset.

mod gpu;
mod prepare;
mod upload;

pub use gpu::{
    CreateRendererErrorV1, RenderFrameErrorV1, RenderStageEvidenceV1, WgpuFillRendererV1,
    WgpuRenderTargetV1,
};
pub use prepare::{
    FLATTEN_TOLERANCE_PIXELS_V1, MAX_PREPARED_VERTICES_V1, OrderedDrawPlanV1, PrepareFrameErrorV1,
    PreparedDrawV1, PreparedFrameV1, PreparedGeometryPlanV1, PreparedGeometryVertexV1,
    PreparedMaterialPlanV1, PreparedMaterialV1, UnsupportedDrawReasonV1, ValidatedRenderPacketV1,
    prepare_frame_v1, tessellate_validated_frame_v1, validate_frame_packet_v1,
};
pub use upload::{
    GpuUploadPlanErrorV1, GpuUploadPlanV1, MAX_GPU_UPLOAD_PLAN_BYTES_V1, build_gpu_upload_plan_v1,
};

/// Preferred name for the shared solid fill/stroke triangle renderer.
pub type WgpuPaintRendererV1 = WgpuFillRendererV1;
