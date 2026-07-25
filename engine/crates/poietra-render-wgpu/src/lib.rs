//! Minimal browser/native WGPU renderer for validated Poietra `RenderPacketV1` frames.
//!
//! The first slice intentionally supports only solid fills of one closed convex
//! cubic subpath per draw. CPU preparation is independent of a GPU device and
//! rejects the complete frame when any draw falls outside that subset.

mod gpu;
mod prepare;

pub use gpu::{CreateRendererErrorV1, RenderFrameErrorV1, WgpuFillRendererV1, WgpuRenderTargetV1};
pub use prepare::{
    FLATTEN_TOLERANCE_PIXELS_V1, MAX_PREPARED_VERTICES_V1, PrepareFrameErrorV1, PreparedDrawV1,
    PreparedFrameV1, PreparedVertexV1, UnsupportedDrawReasonV1, prepare_frame_v1,
};
