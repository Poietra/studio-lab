//! Engine-owned project thumbnail production: representative frame
//! selection, offscreen rendering, and fail-closed PNG encoding (#695).
//!
//! # Representative frame rule (#695 decision)
//!
//! The retired Manim sandbox produced project thumbnails with
//! `-s --output_file poietra-thumbnail`, and Manim's `-s` saves the scene's
//! **last** frame, so every published thumbnail showed the final composed
//! state of the animation. The engine replacement keeps that meaning instead
//! of adopting a midpoint sample:
//!
//! - the requested instant is the greatest `f64` strictly below
//!   `scene.duration` (`f64::from_bits(duration.to_bits() - 1)`), so the
//!   request stays inside the half-open `[0, duration)` playback range that
//!   the export grid also never leaves;
//! - that instant resolves through the Scene's own retained sampling rule
//!   ([`SceneIrV1::state_sample_time`]), so a declared `frameRate` clamps to
//!   the final representable grid frame and terminal-state retention keeps
//!   its Scene-owned meaning (#721 decision);
//! - a non-finite or non-positive duration falls back to `t = 0`. Scene
//!   validation rejects such durations, so the fallback only keeps
//!   [`representative_thumbnail_time_v1`] total for unvalidated values; the
//!   evaluator still fails closed on them.
//!
//! A midpoint sample (`state_sample_time(duration / 2)`) was evaluated and
//! rejected: it would silently change what every already-published thumbnail
//! depicts, and staged scenes frequently sit mid-transition at their midpoint
//! rather than on the composed final result that `-s` always captured.
//!
//! # Output contract
//!
//! One 854x480 eight-bit RGBA PNG — the exact shape the existing publication
//! pipeline verifies: `MAX_RENDER_THUMBNAIL_BYTES_V1 = 4 MiB`
//! (`server/storage/render-artifact-repository.ts`, enforced again by
//! `verified-artifact-publisher.ts`) and the retired sandbox `_validate_png`
//! gate (`sandbox/manim-render-gated-oci/render-entrypoint.py`: PNG
//! signature, exactly 854x480, a single frame). Every bound is re-checked
//! here so a caller never receives bytes the publication path would reject.
//!
//! # Rendering path
//!
//! The frame renders through the crate's async offscreen export
//! target/readback core (#732), which never blocks on `device.poll`, so the
//! same producer serves the browser WASM engine (client generation) and
//! native callers (server-side generation and headless GPU proofs). Native
//! callers use [`render_thumbnail_png_blocking_v1`], which drives the future
//! with the export module's bounded blocking driver.

use png::{BitDepth, ColorType, Encoder};
use poietra_scene_ir::{ExportResolutionV1, RenderPacketV1, SceneIrV1, ViewportV1};

use crate::export::{EXPORT_TARGET_FORMAT_V1, render_export_frame_rgba_v1};
use crate::{
    CreateRendererErrorV1, DecodedPngAssetResolverV1, PrepareFrameErrorV1, WgpuPaintRendererV1,
    prepare_frame_with_assets_v1,
};

/// Canonical thumbnail width from the closed `ExportProfileV1` SD rung.
pub const THUMBNAIL_WIDTH_PX_V1: u32 = ExportResolutionV1::Sd854x480.width_px();
/// Canonical thumbnail height from the closed `ExportProfileV1` SD rung.
pub const THUMBNAIL_HEIGHT_PX_V1: u32 = ExportResolutionV1::Sd854x480.height_px();
/// Engine-side mirror of the durable publication limit
/// `MAX_RENDER_THUMBNAIL_BYTES_V1` in
/// `server/storage/render-artifact-repository.ts`.
pub const MAX_THUMBNAIL_PNG_BYTES_V1: usize = 4 * 1024 * 1024;

const PNG_SIGNATURE_V1: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const RGBA_BYTES_PER_PIXEL_V1: usize = 4;
#[allow(
    clippy::cast_lossless,
    reason = "the closed thumbnail dimensions fit usize on every supported target"
)]
const THUMBNAIL_RGBA_BYTES_V1: usize =
    (THUMBNAIL_WIDTH_PX_V1 as usize) * (THUMBNAIL_HEIGHT_PX_V1 as usize) * RGBA_BYTES_PER_PIXEL_V1;

/// One thumbnail could not be produced truthfully; no partial PNG is ever
/// returned alongside any of these.
#[derive(Debug, thiserror::Error)]
pub enum RenderThumbnailErrorV1 {
    #[error("thumbnail frame sampling failed: {0}")]
    Sample(String),
    #[error("thumbnail packet reports sample time {actual} instead of {expected}")]
    SampledPacketTimeMismatch { actual: f64, expected: f64 },
    #[error(
        "thumbnail packet viewport {actual_width}x{actual_height} does not match the {expected_width}x{expected_height} contract"
    )]
    SampledPacketViewportMismatch {
        actual_height: u32,
        actual_width: u32,
        expected_height: u32,
        expected_width: u32,
    },
    #[error(transparent)]
    Prepare(#[from] PrepareFrameErrorV1),
    #[error(transparent)]
    Renderer(#[from] CreateRendererErrorV1),
    #[error("thumbnail offscreen frame failed: {0}")]
    Frame(String),
    #[cfg(not(target_arch = "wasm32"))]
    #[error("thumbnail blocking drive failed: {0}")]
    BlockingDrive(String),
    #[error("thumbnail frame holds {actual} RGBA bytes; the 854x480 contract requires {expected}")]
    RgbaLengthMismatch { actual: usize, expected: usize },
    #[error(transparent)]
    Encode(#[from] png::EncodingError),
    #[error("encoded thumbnail holds {actual} bytes; the durable publication limit is {maximum}")]
    PngTooLarge { actual: usize, maximum: usize },
    #[error("encoded thumbnail violates the PNG signature or 854x480 IHDR contract")]
    PngContractViolation,
}

/// Returns the representative thumbnail instant for one Scene: the final
/// representable instant inside the half-open `[0, duration)` playback range,
/// resolved through the Scene's retained sampling rule. This replaces the
/// retired Manim `-s` save-last-frame semantics; see the module documentation
/// for the full decision record.
#[must_use]
pub fn representative_thumbnail_time_v1(scene: &SceneIrV1) -> f64 {
    if !scene.duration.is_finite() || scene.duration <= 0.0 {
        // Scene validation rejects such durations; stay total for callers
        // holding an unvalidated value and let the evaluator fail closed.
        return 0.0;
    }
    let final_instant = f64::from_bits(scene.duration.to_bits() - 1);
    scene.state_sample_time(final_instant)
}

fn png_ihdr_dimension_v1(bytes: &[u8], offset: usize) -> Option<u32> {
    let encoded: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(encoded))
}

/// Verifies the exact publication shape the durable pipeline enforces: the
/// byte bound, the PNG signature, and the 854x480 IHDR dimensions.
fn validate_encoded_thumbnail_v1(bytes: &[u8]) -> Result<(), RenderThumbnailErrorV1> {
    if bytes.len() > MAX_THUMBNAIL_PNG_BYTES_V1 {
        return Err(RenderThumbnailErrorV1::PngTooLarge {
            actual: bytes.len(),
            maximum: MAX_THUMBNAIL_PNG_BYTES_V1,
        });
    }
    // The IHDR chunk is required to be first, so the encoded width and height
    // sit at fixed offsets 16 and 20 directly after the 8-byte signature and
    // the 8-byte chunk header.
    if bytes.get(..PNG_SIGNATURE_V1.len()) != Some(PNG_SIGNATURE_V1.as_slice())
        || png_ihdr_dimension_v1(bytes, 16) != Some(THUMBNAIL_WIDTH_PX_V1)
        || png_ihdr_dimension_v1(bytes, 20) != Some(THUMBNAIL_HEIGHT_PX_V1)
    {
        return Err(RenderThumbnailErrorV1::PngContractViolation);
    }
    Ok(())
}

/// Encodes one tight 854x480 RGBA frame as a single-frame eight-bit PNG and
/// re-validates the encoded bytes against the publication contract.
fn encode_thumbnail_png_v1(rgba: &[u8]) -> Result<Vec<u8>, RenderThumbnailErrorV1> {
    if rgba.len() != THUMBNAIL_RGBA_BYTES_V1 {
        return Err(RenderThumbnailErrorV1::RgbaLengthMismatch {
            actual: rgba.len(),
            expected: THUMBNAIL_RGBA_BYTES_V1,
        });
    }
    let mut png_bytes = Vec::new();
    {
        let mut png_encoder = Encoder::new(
            &mut png_bytes,
            THUMBNAIL_WIDTH_PX_V1,
            THUMBNAIL_HEIGHT_PX_V1,
        );
        png_encoder.set_color(ColorType::Rgba);
        png_encoder.set_depth(BitDepth::Eight);
        let mut writer = png_encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()?;
    }
    validate_encoded_thumbnail_v1(&png_bytes)?;
    Ok(png_bytes)
}

/// Renders one Scene's representative frame to the durable 854x480 PNG
/// thumbnail contract through the async offscreen export core, so the same
/// code serves the browser WASM engine and native callers.
///
/// `sample_packet` receives the representative instant and the thumbnail
/// viewport and must sample the same validated Scene through its retained
/// evaluator; the returned packet's correlation `sample_time` (bit-exact) and
/// viewport are re-verified before any GPU work. Image assets resolve through
/// the same verified decoded-PNG registry as interactive canvas rendering.
///
/// # Errors
///
/// Fails closed with a typed [`RenderThumbnailErrorV1`] — and never partial
/// PNG bytes — when sampling, preparation, rendering, the bounded readback,
/// encoding, or the publication-shape validation fails.
pub async fn render_thumbnail_png_v1<SamplePacket>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneIrV1,
    assets: &dyn DecodedPngAssetResolverV1,
    mut sample_packet: SamplePacket,
) -> Result<Vec<u8>, RenderThumbnailErrorV1>
where
    SamplePacket: FnMut(f64, ViewportV1) -> Result<RenderPacketV1, String>,
{
    let sample_time = representative_thumbnail_time_v1(scene);
    let viewport = ViewportV1 {
        height_px: THUMBNAIL_HEIGHT_PX_V1,
        width_px: THUMBNAIL_WIDTH_PX_V1,
    };
    let packet =
        sample_packet(sample_time, viewport.clone()).map_err(RenderThumbnailErrorV1::Sample)?;
    if packet.sample_time.to_bits() != sample_time.to_bits() {
        return Err(RenderThumbnailErrorV1::SampledPacketTimeMismatch {
            actual: packet.sample_time,
            expected: sample_time,
        });
    }
    if packet.viewport != viewport {
        return Err(RenderThumbnailErrorV1::SampledPacketViewportMismatch {
            actual_height: packet.viewport.height_px,
            actual_width: packet.viewport.width_px,
            expected_height: viewport.height_px,
            expected_width: viewport.width_px,
        });
    }
    let prepared = prepare_frame_with_assets_v1(&packet, assets)?;
    let mut renderer = WgpuPaintRendererV1::new(device, EXPORT_TARGET_FORMAT_V1)?;
    let mut rgba = Vec::new();
    render_export_frame_rgba_v1(device, queue, &mut renderer, &prepared, &mut rgba)
        .await
        .map_err(|error| RenderThumbnailErrorV1::Frame(error.to_string()))?;
    encode_thumbnail_png_v1(&rgba)
}

/// Native convenience over [`render_thumbnail_png_v1`] for callers without an
/// event loop — the future server-side producer and the headless GPU proofs —
/// driving the async render with the export module's bounded blocking driver.
///
/// # Errors
///
/// Returns every [`render_thumbnail_png_v1`] error unchanged, plus
/// [`RenderThumbnailErrorV1::BlockingDrive`] when the bounded driver cannot
/// complete the future.
#[cfg(not(target_arch = "wasm32"))]
pub fn render_thumbnail_png_blocking_v1<SamplePacket>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneIrV1,
    assets: &dyn DecodedPngAssetResolverV1,
    sample_packet: SamplePacket,
) -> Result<Vec<u8>, RenderThumbnailErrorV1>
where
    SamplePacket: FnMut(f64, ViewportV1) -> Result<RenderPacketV1, String>,
{
    crate::export::drive_export_blocking_v1(
        device,
        render_thumbnail_png_v1(device, queue, scene, assets, sample_packet),
    )
    .map_err(|error| RenderThumbnailErrorV1::BlockingDrive(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn fixture_scene() -> SceneIrV1 {
        let fixture: Value = serde_json::from_slice(include_bytes!(
            "../../../../fixtures/engine-v1/shared-circle-opacity.json"
        ))
        .expect("the shared fixture envelope must remain valid");
        serde_json::from_value(fixture["scene"].clone())
            .expect("the shared fixture Scene must remain valid")
    }

    #[test]
    fn representative_time_keeps_manim_save_last_frame_semantics() {
        let mut scene = fixture_scene();

        // Continuous sampling: the greatest instant strictly below the
        // half-open duration endpoint.
        let continuous = representative_thumbnail_time_v1(&scene);
        assert_eq!(continuous.to_bits(), scene.duration.to_bits() - 1);
        assert!(continuous < scene.duration);

        // Terminal retention does not change an in-range instant.
        scene.state_sampling.retains_terminal_state = true;
        assert_eq!(
            representative_thumbnail_time_v1(&scene).to_bits(),
            continuous.to_bits()
        );

        // A declared Scene frame rate clamps to the final representable grid
        // frame, exactly as `state_sample_time` resolves scrubber requests.
        scene.state_sampling.frame_rate = Some(30.0);
        assert_eq!(
            representative_thumbnail_time_v1(&scene).to_bits(),
            (59.0 / 30.0_f64).to_bits()
        );
    }

    #[test]
    fn representative_time_falls_back_to_zero_for_unvalidated_durations() {
        let mut scene = fixture_scene();
        for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            scene.duration = duration;
            assert_eq!(
                representative_thumbnail_time_v1(&scene).to_bits(),
                0.0_f64.to_bits()
            );
        }
    }

    #[test]
    fn rgba_encodes_to_the_durable_publication_shape() {
        let encoded = encode_thumbnail_png_v1(&vec![0; THUMBNAIL_RGBA_BYTES_V1])
            .expect("an exact 854x480 RGBA frame must encode");
        assert!(encoded.len() <= MAX_THUMBNAIL_PNG_BYTES_V1);
        assert_eq!(
            encoded.get(..PNG_SIGNATURE_V1.len()),
            Some(PNG_SIGNATURE_V1.as_slice())
        );
        assert_eq!(
            png_ihdr_dimension_v1(&encoded, 16),
            Some(THUMBNAIL_WIDTH_PX_V1)
        );
        assert_eq!(
            png_ihdr_dimension_v1(&encoded, 20),
            Some(THUMBNAIL_HEIGHT_PX_V1)
        );
    }

    #[test]
    fn byte_bound_and_publication_contract_fail_closed() {
        assert!(matches!(
            encode_thumbnail_png_v1(&[]),
            Err(RenderThumbnailErrorV1::RgbaLengthMismatch {
                actual: 0,
                expected: THUMBNAIL_RGBA_BYTES_V1,
            })
        ));
        let oversized = vec![0; MAX_THUMBNAIL_PNG_BYTES_V1 + 1];
        assert!(matches!(
            validate_encoded_thumbnail_v1(&oversized),
            Err(RenderThumbnailErrorV1::PngTooLarge {
                actual,
                maximum: MAX_THUMBNAIL_PNG_BYTES_V1,
            }) if actual == MAX_THUMBNAIL_PNG_BYTES_V1 + 1
        ));
        assert!(matches!(
            validate_encoded_thumbnail_v1(&[0; 24]),
            Err(RenderThumbnailErrorV1::PngContractViolation)
        ));
        // A correctly signed PNG with wrong IHDR dimensions is rejected.
        let mut wrong_dimensions = Vec::new();
        {
            let mut encoder = Encoder::new(&mut wrong_dimensions, 160, 90);
            encoder.set_color(ColorType::Rgba);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().expect("the header must encode");
            writer
                .write_image_data(&vec![0; 160 * 90 * 4])
                .expect("the frame must encode");
            writer.finish().expect("the PNG must finish");
        }
        assert!(matches!(
            validate_encoded_thumbnail_v1(&wrong_dimensions),
            Err(RenderThumbnailErrorV1::PngContractViolation)
        ));
    }
}
