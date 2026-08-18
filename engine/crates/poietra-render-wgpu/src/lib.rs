//! Minimal browser/native WGPU renderer for validated Poietra `RenderPacketV1` frames.
//!
//! CPU preparation supports non-convex solid fills across cubic subpaths with
//! Cairo-compatible implicit closure, including holes and both v1 fill rules, plus
//! bounded cubic-path strokes across open, closed, and multiple subpaths with v1
//! caps, joins, and miter limits. A
//! path's fill and stroke become consecutive paint phases with distinct materials.
//! A verified decoded-asset resolver enables affine PNG quads with row-zero-top UVs,
//! premultiplied linear-light samples, and exact nearest/linear clamp filtering.
//! Vector paints support the packet's explicit linear-light or Manim/Cairo sRGB
//! compositing contract through paired sRGB and base-Unorm target pipelines.
//! Linear-light paths and images draw into a two-times single-sample sRGB target
//! and use an explicit four-texel linear-light resolve for portable
//! browser/native antialiasing. Manim/Cairo vector frames use hardware
//! four-sample coverage and resolve into the caller's target; image draws remain
//! restricted to linear-light compositing.
//! Preparation is independent of a GPU device and rejects the complete frame when
//! any phase falls outside the bounded subset.

pub(crate) const MANIM_CAIRO_SAMPLE_COUNT_V1: u32 = 4;

mod arena;
mod asset;
mod cache;
#[cfg_attr(not(test), allow(dead_code))]
mod export;
mod gpu;
mod image_gpu;
mod prepare;
mod thumbnail;
mod upload;

pub use arena::{GpuBufferArenaErrorV1, MAX_GPU_BUFFER_ARENA_BYTES_V1};
pub use asset::{
    DecodePngAssetErrorV1, DecodedPngAssetV1, MAX_ENCODED_PNG_BYTES_V1, decode_verified_png_v1,
};
pub use export::{
    ExportFrameErrorV1, ExportFrameRequestV1, ExportFrameSequenceErrorV1,
    ExportFrameSequenceParamsErrorV1, ExportFrameSequenceParamsV1, ExportFrameSequenceSessionV1,
    ExportSequenceFrameV1,
};
pub use gpu::{
    CreateRendererErrorV1, MAX_MULTISAMPLE_COLOR_TARGET_BYTES_V1, RenderFrameErrorV1,
    RenderStageEvidenceV1, RendererMemorySnapshotErrorV1, RendererMemorySnapshotV1,
    WgpuFillRendererV1, WgpuRenderTargetV1,
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
pub use thumbnail::{
    ENGINE_THUMBNAIL_HEIGHT_PX, ENGINE_THUMBNAIL_WIDTH_PX, MAX_ENGINE_THUMBNAIL_PNG_BYTES,
    RenderThumbnailError, render_thumbnail_png, representative_thumbnail_time,
};
pub use upload::{
    GpuUploadPlanErrorV1, GpuUploadPlanV1, MAX_GPU_UPLOAD_PLAN_BYTES_V1, build_gpu_upload_plan_v1,
};

// Test-only hook retained for the focused browser readback proof.
#[doc(hidden)]
pub use export::prove_export_frame_sequence_readback_v1;

/// Preferred name for the shared path/image renderer.
pub type WgpuPaintRendererV1 = WgpuFillRendererV1;
pub use cache::{
    MAX_PREPARED_GEOMETRY_CACHE_BYTES_V1, MAX_PREPARED_GEOMETRY_CACHE_ENTRIES_V1,
    PreparedGeometryCacheFrameStatsV1, PreparedGeometryCacheV1,
};
