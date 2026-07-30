//! Minimal browser/native WGPU renderer for validated Poietra `RenderPacketV1` frames.
//!
//! CPU preparation supports non-convex solid fills across closed cubic subpaths,
//! including holes and both v1 fill rules, plus bounded cubic-path strokes across
//! open, closed, and multiple subpaths with v1 caps, joins, and miter limits. A
//! path's fill and stroke become consecutive paint phases with distinct materials.
//! A verified decoded-asset resolver enables affine PNG quads with row-zero-top UVs,
//! premultiplied linear-light samples, and exact nearest/linear clamp filtering.
//! Preparation is independent of a GPU device and rejects the complete frame when
//! any phase falls outside the bounded subset.

mod arena;
mod asset;
mod cache;
mod gpu;
mod image_gpu;
mod prepare;
mod upload;

pub use arena::{GpuBufferArenaErrorV1, MAX_GPU_BUFFER_ARENA_BYTES_V1};
pub use asset::{
    DecodePngAssetErrorV1, DecodedPngAssetV1, MAX_ENCODED_PNG_BYTES_V1, decode_verified_png_v1,
};
pub use gpu::{
    CreateRendererErrorV1, RenderFrameErrorV1, RenderStageEvidenceV1, WgpuFillRendererV1,
    WgpuRenderTargetV1,
};
pub use image_gpu::{
    ImageGpuUploadErrorV1, ImageTextureCacheFrameStatsV1, ImageTextureCacheLimitsV1,
    MAX_IMAGE_BIND_GROUPS_PER_FRAME_V1, MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1,
    MAX_IMAGE_TEXTURES_PER_FRAME_V1, MAX_RETAINED_IMAGE_TEXTURE_CPU_BYTES_V1,
    MAX_RETAINED_IMAGE_TEXTURE_ENTRIES_V1, MAX_RETAINED_IMAGE_TEXTURE_GPU_BYTES_V1,
};
pub use prepare::{
    DecodedPngAssetResolverV1, FLATTEN_TOLERANCE_PIXELS_V1, MAX_PREPARED_VERTICES_V1,
    OrderedDrawPlanV1, PrepareFrameErrorV1, PreparedDrawV1, PreparedFrameV1,
    PreparedGeometryPlanV1, PreparedGeometryVertexV1, PreparedImageDrawV1, PreparedImageVertexV1,
    PreparedMaterialPlanV1, PreparedMaterialV1, PreparedRenderCommandV1, UnsupportedDrawReasonV1,
    ValidatedRenderPacketV1, prepare_frame_v1, prepare_frame_with_assets_v1,
    prepare_frame_with_cache_and_assets_v1, prepare_frame_with_cache_v1,
    tessellate_validated_frame_v1, tessellate_validated_frame_with_assets_v1,
    tessellate_validated_frame_with_cache_and_assets_v1, tessellate_validated_frame_with_cache_v1,
    validate_frame_packet_v1,
};
pub use upload::{
    GpuUploadPlanErrorV1, GpuUploadPlanV1, MAX_GPU_UPLOAD_PLAN_BYTES_V1, build_gpu_upload_plan_v1,
};

/// Preferred name for the shared path/image renderer.
pub type WgpuPaintRendererV1 = WgpuFillRendererV1;
pub use cache::{
    MAX_PREPARED_GEOMETRY_CACHE_BYTES_V1, MAX_PREPARED_GEOMETRY_CACHE_ENTRIES_V1,
    PreparedGeometryCacheFrameStatsV1, PreparedGeometryCacheV1,
};
