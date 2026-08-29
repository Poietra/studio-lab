//! Engine-owned thumbnail rendering and PNG encoding.
//!
//! Manim's former `-s` thumbnail path saved the Scene's last frame. The Rust
//! replacement samples the last representable instant inside the Scene's
//! half-open duration, then lets `state_sample_time` apply the Scene's retained
//! sampling rule. Rendering reuses the offscreen export target/readback path;
//! only the resulting tight RGBA bytes are encoded here.

use png::{BitDepth, ColorType, Encoder};
use poietra_scene_ir::{ExportResolutionV1, RenderPacketV1, SceneIrV1, ViewportV1};

use crate::export::{EXPORT_TARGET_FORMAT_V1, render_export_frame_rgba_v1};
use crate::{
    CreateRendererErrorV1, DecodedPngAssetResolverV1, FragmentMaterialRegistryErrorV1,
    FragmentMaterialSourceV1, PrepareFrameErrorV1, PreparedGeometryCacheV1,
    ScenePostEffectRegistryErrorV1, ScenePostEffectSourceV1, WgpuPaintRendererV1,
    prepare_frame_with_cache_assets_and_shader_sources_v1,
};

pub const ENGINE_THUMBNAIL_WIDTH_PX: u32 = ExportResolutionV1::Sd854x480.width_px();
pub const ENGINE_THUMBNAIL_HEIGHT_PX: u32 = ExportResolutionV1::Sd854x480.height_px();
/// Existing durable thumbnail publication limit (`MAX_RENDER_THUMBNAIL_BYTES_V1`).
pub const MAX_ENGINE_THUMBNAIL_PNG_BYTES: usize = 4 * 1024 * 1024;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const RGBA_BYTES_PER_PIXEL: usize = 4;
#[allow(
    clippy::cast_lossless,
    reason = "the closed thumbnail dimensions fit every supported usize target"
)]
const EXPECTED_RGBA_BYTES: usize = (ENGINE_THUMBNAIL_WIDTH_PX as usize)
    * (ENGINE_THUMBNAIL_HEIGHT_PX as usize)
    * RGBA_BYTES_PER_PIXEL;

#[derive(Debug, thiserror::Error)]
pub enum RenderThumbnailError {
    #[error("thumbnail frame sampling failed: {0}")]
    Sample(String),
    #[error("thumbnail sampler returned time {actual} instead of {expected}")]
    SampleTimeMismatch { actual: f64, expected: f64 },
    #[error(
        "thumbnail sampler returned viewport {actual_width}x{actual_height} instead of {expected_width}x{expected_height}"
    )]
    SampleViewportMismatch {
        actual_height: u32,
        actual_width: u32,
        expected_height: u32,
        expected_width: u32,
    },
    #[error(transparent)]
    Prepare(#[from] PrepareFrameErrorV1),
    #[error(transparent)]
    Renderer(#[from] CreateRendererErrorV1),
    #[error(transparent)]
    FragmentMaterialRegistry(#[from] FragmentMaterialRegistryErrorV1),
    #[error(transparent)]
    ScenePostEffectRegistry(#[from] ScenePostEffectRegistryErrorV1),
    #[error("thumbnail offscreen readback failed: {0}")]
    Readback(String),
    #[error("thumbnail RGBA length is {actual}, expected {expected}")]
    InvalidRgbaLength { actual: usize, expected: usize },
    #[error(transparent)]
    Encode(#[from] png::EncodingError),
    #[error("encoded thumbnail contains {actual} bytes; maximum is {maximum}")]
    EncodedPngTooLarge { actual: usize, maximum: usize },
    #[error("encoded thumbnail does not satisfy the PNG signature and 854x480 IHDR contract")]
    EncodedPngContractMismatch,
}

/// Returns the final representable instant inside the Scene's half-open
/// duration, resolved through its retained-state sampling rule.
#[must_use]
pub fn representative_thumbnail_time(scene: &SceneIrV1) -> f64 {
    // Scene validation normally guarantees this precondition. Keep this
    // helper total for callers holding an unvalidated wire value; the
    // evaluator will reject that duration without an integer underflow here.
    if !scene.duration.is_finite() || scene.duration <= 0.0 {
        return scene.duration;
    }
    let inside_duration = f64::from_bits(scene.duration.to_bits() - 1);
    scene.state_sample_time(inside_duration)
}

fn png_dimension(bytes: &[u8], offset: usize) -> Option<u32> {
    let encoded: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(encoded))
}

fn validate_encoded_thumbnail(bytes: &[u8]) -> Result<(), RenderThumbnailError> {
    if bytes.len() > MAX_ENGINE_THUMBNAIL_PNG_BYTES {
        return Err(RenderThumbnailError::EncodedPngTooLarge {
            actual: bytes.len(),
            maximum: MAX_ENGINE_THUMBNAIL_PNG_BYTES,
        });
    }
    if bytes.get(..PNG_SIGNATURE.len()) != Some(PNG_SIGNATURE.as_slice())
        || png_dimension(bytes, 16) != Some(ENGINE_THUMBNAIL_WIDTH_PX)
        || png_dimension(bytes, 20) != Some(ENGINE_THUMBNAIL_HEIGHT_PX)
    {
        return Err(RenderThumbnailError::EncodedPngContractMismatch);
    }
    Ok(())
}

fn encode_thumbnail_png(rgba: &[u8]) -> Result<Vec<u8>, RenderThumbnailError> {
    if rgba.len() != EXPECTED_RGBA_BYTES {
        return Err(RenderThumbnailError::InvalidRgbaLength {
            actual: rgba.len(),
            expected: EXPECTED_RGBA_BYTES,
        });
    }
    let mut png_bytes = Vec::new();
    {
        let mut png_encoder = Encoder::new(
            &mut png_bytes,
            ENGINE_THUMBNAIL_WIDTH_PX,
            ENGINE_THUMBNAIL_HEIGHT_PX,
        );
        png_encoder.set_color(ColorType::Rgba);
        png_encoder.set_depth(BitDepth::Eight);
        let mut writer = png_encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()?;
    }
    validate_encoded_thumbnail(&png_bytes)?;
    Ok(png_bytes)
}

/// Samples and renders one Scene's representative frame to the existing
/// durable 854x480 PNG thumbnail contract.
///
/// The sampler must use the supplied time and viewport with the canonical
/// evaluator. Image assets are resolved through the same verified registry as
/// interactive canvas rendering. Project shader registries are installed into
/// the offscreen renderer before the representative frame is prepared.
///
/// # Errors
///
/// Returns a typed error without returning partial PNG bytes when sampling,
/// preparation, offscreen readback, encoding, or publication-shape validation
/// fails.
pub async fn render_thumbnail_png<SamplePacket>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneIrV1,
    assets: &dyn DecodedPngAssetResolverV1,
    fragment_materials: &[FragmentMaterialSourceV1],
    scene_post_effects: &[ScenePostEffectSourceV1],
    mut sample_packet: SamplePacket,
) -> Result<Vec<u8>, RenderThumbnailError>
where
    SamplePacket: FnMut(f64, ViewportV1) -> Result<RenderPacketV1, String>,
{
    let sample_time = representative_thumbnail_time(scene);
    let viewport = ViewportV1 {
        height_px: ENGINE_THUMBNAIL_HEIGHT_PX,
        width_px: ENGINE_THUMBNAIL_WIDTH_PX,
    };
    let packet =
        sample_packet(sample_time, viewport.clone()).map_err(RenderThumbnailError::Sample)?;
    if packet.sample_time.to_bits() != sample_time.to_bits() {
        return Err(RenderThumbnailError::SampleTimeMismatch {
            actual: packet.sample_time,
            expected: sample_time,
        });
    }
    if packet.viewport != viewport {
        return Err(RenderThumbnailError::SampleViewportMismatch {
            actual_height: packet.viewport.height_px,
            actual_width: packet.viewport.width_px,
            expected_height: viewport.height_px,
            expected_width: viewport.width_px,
        });
    }
    let mut renderer = WgpuPaintRendererV1::new(device, EXPORT_TARGET_FORMAT_V1)?;
    renderer
        .replace_fragment_material_sources(device, fragment_materials)
        .await?;
    renderer
        .replace_scene_post_effect_sources(device, scene_post_effects)
        .await?;
    let mut geometry_cache = PreparedGeometryCacheV1::default();
    let prepared = prepare_frame_with_cache_assets_and_shader_sources_v1(
        &packet,
        &mut geometry_cache,
        assets,
        &renderer,
        &renderer,
    )?;
    let mut rgba = Vec::new();
    render_export_frame_rgba_v1(device, queue, &mut renderer, &prepared, &mut rgba)
        .await
        .map_err(|error| RenderThumbnailError::Readback(error.to_string()))?;
    encode_thumbnail_png(&rgba)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn scene() -> SceneIrV1 {
        let fixture: Value = serde_json::from_slice(include_bytes!(
            "../../../../fixtures/engine-v1/shared-circle-opacity.json"
        ))
        .expect("the shared fixture envelope must remain valid");
        serde_json::from_value(fixture["scene"].clone())
            .expect("the shared fixture Scene must remain valid")
    }

    #[test]
    fn representative_time_replaces_manim_save_last_frame_with_the_final_half_open_state() {
        let mut scene = scene();
        let continuous = representative_thumbnail_time(&scene);
        assert_eq!(continuous.to_bits(), scene.duration.to_bits() - 1);
        assert!(continuous < scene.duration);

        scene.state_sampling.frame_rate = Some(30.0);
        assert_eq!(
            representative_thumbnail_time(&scene).to_bits(),
            (59.0 / 30.0_f64).to_bits()
        );
    }

    #[test]
    fn rgba_encodes_to_the_existing_thumbnail_publication_shape() {
        let encoded = encode_thumbnail_png(&vec![0; EXPECTED_RGBA_BYTES])
            .expect("an exact RGBA frame must encode");
        assert!(encoded.len() <= MAX_ENGINE_THUMBNAIL_PNG_BYTES);
        assert_eq!(
            encoded.get(..PNG_SIGNATURE.len()),
            Some(PNG_SIGNATURE.as_slice())
        );
        assert_eq!(png_dimension(&encoded, 16), Some(ENGINE_THUMBNAIL_WIDTH_PX));
        assert_eq!(
            png_dimension(&encoded, 20),
            Some(ENGINE_THUMBNAIL_HEIGHT_PX)
        );
    }

    #[test]
    fn rgba_and_publication_contract_fail_closed() {
        assert!(matches!(
            encode_thumbnail_png(&[]),
            Err(RenderThumbnailError::InvalidRgbaLength { .. })
        ));
        let oversized = vec![0; MAX_ENGINE_THUMBNAIL_PNG_BYTES + 1];
        assert!(matches!(
            validate_encoded_thumbnail(&oversized),
            Err(RenderThumbnailError::EncodedPngTooLarge { .. })
        ));
        assert!(matches!(
            validate_encoded_thumbnail(&[0; 24]),
            Err(RenderThumbnailError::EncodedPngContractMismatch)
        ));
    }
}
