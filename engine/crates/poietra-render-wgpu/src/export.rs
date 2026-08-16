//! Crate-private offscreen export rendering for validated frames.
//!
//! This is the production counterpart of the headless GPU proof template:
//! one validated, prepared frame renders into an offscreen
//! `COPY_SRC | RENDER_ATTACHMENT` target through the existing
//! [`WgpuPaintRendererV1`] paint path — including the Manim/Cairo four-sample
//! base-Unorm resolve — is copied out with
//! [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`] row padding, and is de-padded into
//! tight RGBA bytes. The frame-sequence driver steps requested times `i / fps`
//! across the validated Scene's full duration, relies on the caller's sampler
//! to resolve Scene state through
//! [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time),
//! and yields exactly one bounded frame at a time. Every failure is a typed
//! error and no partial frame is ever yielded. The public `ExportProfileV1`
//! wire contract deliberately does not exist yet (#721), so every item here is
//! crate-private and none of it crosses a serialization boundary.

use std::sync::mpsc;
use std::time::Duration;

use poietra_scene_ir::{MAX_VIEWPORT_PIXELS_V1, RenderPacketV1, SceneIrV1, ViewportV1};

use crate::WgpuPaintRendererV1;
use crate::gpu::{CreateRendererErrorV1, RenderFrameErrorV1, WgpuRenderTargetV1};
use crate::prepare::{
    DecodedPngAssetResolverV1, PrepareFrameErrorV1, PreparedFrameV1, prepare_frame_with_assets_v1,
};

/// RGBA8 bytes per exported pixel.
const EXPORT_BYTES_PER_PIXEL_V1: u32 = 4;

/// Unified export view format. Manim/Cairo frames resolve into this format's
/// exact base-Unorm variant through the renderer's existing four-sample paint
/// path, exactly as the interactive canvas target does.
const EXPORT_TARGET_FORMAT_V1: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

/// Bounded fail-closed deadline for one frame's submitted GPU work to finish
/// before readback. Generous so software adapters can finish large frames; a
/// frame that cannot finish inside it aborts the whole export.
const EXPORT_READBACK_TIMEOUT_V1: Duration = Duration::from_mins(1);

/// Mirrors the per-side viewport bound enforced by render-packet validation.
const MAX_EXPORT_VIEWPORT_SIDE_PX_V1: u32 = 16_384;

/// Mirrors the private JavaScript-safe-integer bound used by Scene IR
/// state-sampling validation.
const JAVASCRIPT_MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

/// One offscreen export frame could not be produced truthfully.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ExportFrameErrorV1 {
    #[error(transparent)]
    Prepare(#[from] PrepareFrameErrorV1),
    #[error("export requires a renderer created for {expected:?}, received {actual:?}")]
    RendererTargetFormatUnsupported {
        actual: wgpu::TextureFormat,
        expected: wgpu::TextureFormat,
    },
    #[error("export frames require a non-empty viewport")]
    EmptyViewport,
    #[error(transparent)]
    Render(#[from] RenderFrameErrorV1),
    #[error("export readback byte accounting overflowed")]
    ReadbackByteAccountingOverflow,
    #[error("export readback wait failed: {0}")]
    ReadbackPollFailed(wgpu::PollError),
    #[error("export readback wait did not finish before its deadline")]
    ReadbackWaitIncomplete,
    #[error("export readback map callback did not report a result")]
    ReadbackMapResultMissing,
    #[error("export readback mapping failed: {0}")]
    ReadbackMapFailed(wgpu::BufferAsyncError),
    #[error("export readback mapped range is unavailable: {0}")]
    ReadbackMappedRangeUnavailable(wgpu::MapRangeError),
    #[error("export readback returned {actual} bytes for a {expected}-byte padded image")]
    ReadbackSizeMismatch { actual: usize, expected: usize },
}

/// Export sequence parameters cannot describe a bounded frame grid.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub(crate) enum ExportFrameSequenceParamsErrorV1 {
    #[error("export fps must be positive")]
    ZeroFps,
    #[error("validated scene duration {duration} is not a positive finite time")]
    InvalidSceneDuration { duration: f64 },
    #[error("duration {duration} at {fps} fps does not describe a JavaScript-safe frame count")]
    FrameCountOutOfRange { duration: f64, fps: u32 },
    #[error(
        "export viewport {width_px}x{height_px} sides must be between 1 and {}",
        MAX_EXPORT_VIEWPORT_SIDE_PX_V1
    )]
    ViewportSideOutOfRange { height_px: u32, width_px: u32 },
    #[error(
        "export viewport {width_px}x{height_px} exceeds the {}-pixel limit",
        MAX_VIEWPORT_PIXELS_V1
    )]
    ViewportPixelsExceeded { height_px: u32, width_px: u32 },
}

/// The export frame sequence failed closed before yielding a further frame.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ExportFrameSequenceErrorV1<SampleError>
where
    SampleError: std::error::Error + 'static,
{
    #[error(transparent)]
    Params(#[from] ExportFrameSequenceParamsErrorV1),
    #[error(transparent)]
    Renderer(#[from] CreateRendererErrorV1),
    #[error("export frame {frame_index} could not be sampled: {source}")]
    Sample {
        frame_index: u64,
        #[source]
        source: SampleError,
    },
    #[error(
        "export frame {frame_index} sampled packet reports sample time {actual} instead of {expected}"
    )]
    SampledPacketTimeMismatch {
        actual: f64,
        expected: f64,
        frame_index: u64,
    },
    #[error(
        "export frame {frame_index} sampled packet viewport {actual_width}x{actual_height} does not match export viewport {expected_width}x{expected_height}"
    )]
    SampledPacketViewportMismatch {
        actual_height: u32,
        actual_width: u32,
        expected_height: u32,
        expected_width: u32,
        frame_index: u64,
    },
    #[error("export frame {frame_index} failed: {source}")]
    Frame {
        frame_index: u64,
        #[source]
        source: ExportFrameErrorV1,
    },
}

/// Minimal crate-private export parameters. The closed public contract
/// (`ExportProfileV1`) is deliberately deferred to #721 and must not be
/// defined here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ExportFrameSequenceParamsV1 {
    /// Frames per second for the requested-time grid `i / fps`.
    pub fps: u32,
    pub height_px: u32,
    pub width_px: u32,
}

/// Per-frame request handed to the packet sampler.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExportFrameRequestV1 {
    pub frame_index: u64,
    pub requested_time: f64,
    pub viewport: ViewportV1,
}

/// Borrowed view of one completed export frame. The tight RGBA buffer is
/// reused for the next frame after the callback returns, so a sequence keeps
/// exactly one frame in flight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExportSequenceFrameV1<'a> {
    pub frame_index: u64,
    pub requested_time: f64,
    pub rgba: &'a [u8],
}

/// Requested-time grid for one validated Scene export.
///
/// The grid holds `ceil(duration * fps)` frames at `i / fps`, covering
/// `[0, duration)`. A Scene that retains its terminal state replaces the final
/// grid time with `duration` itself so
/// [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time)
/// resolves the last exported frame to the retained terminal state. A
/// non-retaining Scene never requests `duration`, because that is the
/// half-open endpoint where its entities have already ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExportFrameTimelineV1 {
    duration: f64,
    fps_hz: f64,
    frame_count: u64,
    retains_terminal_state: bool,
}

impl ExportFrameTimelineV1 {
    /// Builds the bounded requested-time grid for one validated Scene
    /// duration.
    ///
    /// # Errors
    ///
    /// Fails closed when `fps` is zero, when the duration is not a positive
    /// finite time, or when `duration * fps` leaves the JavaScript-safe
    /// integer range that bounds every v1 sampling grid.
    pub(crate) fn new(
        duration: f64,
        retains_terminal_state: bool,
        fps: u32,
    ) -> Result<Self, ExportFrameSequenceParamsErrorV1> {
        if fps == 0 {
            return Err(ExportFrameSequenceParamsErrorV1::ZeroFps);
        }
        if !duration.is_finite() || duration <= 0.0 {
            return Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { duration });
        }
        let fps_hz = f64::from(fps);
        let scaled = duration * fps_hz;
        if !scaled.is_finite() || scaled > JAVASCRIPT_MAX_SAFE_INTEGER_F64 {
            return Err(ExportFrameSequenceParamsErrorV1::FrameCountOutOfRange { duration, fps });
        }
        // `0 < scaled <= 2^53 - 1`, so the ceiling is exact in u64.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let frame_count = scaled.ceil() as u64;
        Ok(Self {
            duration,
            fps_hz,
            frame_count,
            retains_terminal_state,
        })
    }

    #[must_use]
    pub(crate) const fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Returns the requested sample time for one frame, or `None` outside the
    /// grid.
    #[must_use]
    pub(crate) fn requested_time(&self, frame_index: u64) -> Option<f64> {
        if frame_index >= self.frame_count {
            return None;
        }
        if self.retains_terminal_state && frame_index == self.frame_count - 1 {
            return Some(self.duration);
        }
        // `frame_index < 2^53`, so the cast is exact.
        #[allow(clippy::cast_precision_loss)]
        Some(frame_index as f64 / self.fps_hz)
    }

    /// Iterates every `(frame_index, requested_time)` pair in export order.
    pub(crate) fn requested_times(&self) -> impl Iterator<Item = (u64, f64)> {
        let timeline = *self;
        (0..timeline.frame_count)
            .filter_map(move |frame_index| Some((frame_index, timeline.requested_time(frame_index)?)))
    }
}

/// Rejects export viewports outside the existing render-packet bounds before
/// any GPU resource exists.
///
/// # Errors
///
/// Fails closed when either side leaves `1..=16384` or the pixel product
/// exceeds [`MAX_VIEWPORT_PIXELS_V1`].
pub(crate) fn validate_export_viewport_v1(
    params: ExportFrameSequenceParamsV1,
) -> Result<(), ExportFrameSequenceParamsErrorV1> {
    let ExportFrameSequenceParamsV1 {
        fps: _,
        height_px,
        width_px,
    } = params;
    if width_px == 0
        || width_px > MAX_EXPORT_VIEWPORT_SIDE_PX_V1
        || height_px == 0
        || height_px > MAX_EXPORT_VIEWPORT_SIDE_PX_V1
    {
        return Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange {
            height_px,
            width_px,
        });
    }
    if u64::from(width_px)
        .checked_mul(u64::from(height_px))
        .is_none_or(|pixels| pixels > MAX_VIEWPORT_PIXELS_V1)
    {
        return Err(ExportFrameSequenceParamsErrorV1::ViewportPixelsExceeded {
            height_px,
            width_px,
        });
    }
    Ok(())
}

/// Tight and [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`]-padded byte widths for one
/// readback row.
///
/// # Errors
///
/// Fails closed when the padded row cannot be represented in u32.
fn export_row_bytes_v1(width_px: u32) -> Result<(u32, u32), ExportFrameErrorV1> {
    let unpadded = width_px
        .checked_mul(EXPORT_BYTES_PER_PIXEL_V1)
        .ok_or(ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded = unpadded
        .checked_add(alignment - 1)
        .ok_or(ExportFrameErrorV1::ReadbackByteAccountingOverflow)?
        / alignment
        * alignment;
    Ok((unpadded, padded))
}

/// Renders one validated, prepared frame into a fresh offscreen
/// `COPY_SRC | RENDER_ATTACHMENT` target and de-pads the aligned readback rows
/// into `rgba`, which afterwards holds exactly `width * height * 4` tight RGBA
/// bytes. The buffer is cleared first and reused across frames so a sequence
/// keeps one frame in flight.
///
/// The target view format follows the prepared frame's explicit compositing
/// contract exactly as the interactive paint path does: linear-light frames
/// draw directly into the sRGB view, Manim/Cairo frames render through the
/// renderer's retained four-sample base-Unorm attachment and resolve into the
/// export target.
///
/// # Errors
///
/// Fails closed with a typed error when the renderer was not created for the
/// unified export view format, when the paint path rejects the frame, or when
/// the bounded readback cannot complete. `rgba` never holds a partial frame:
/// it is empty on every error path.
pub(crate) fn render_export_frame_rgba_v1(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &mut WgpuPaintRendererV1,
    prepared: &PreparedFrameV1,
    rgba: &mut Vec<u8>,
) -> Result<(), ExportFrameErrorV1> {
    rgba.clear();
    if renderer.target_format() != EXPORT_TARGET_FORMAT_V1 {
        return Err(ExportFrameErrorV1::RendererTargetFormatUnsupported {
            actual: renderer.target_format(),
            expected: EXPORT_TARGET_FORMAT_V1,
        });
    }
    let [width_px, height_px] = prepared.viewport();
    if width_px == 0 || height_px == 0 {
        return Err(ExportFrameErrorV1::EmptyViewport);
    }
    let target_format = renderer.target_format_for_compositing(prepared.compositing());
    let extent = wgpu::Extent3d {
        depth_or_array_layers: 1,
        height: height_px,
        width: width_px,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra export frame target v1"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: target_format,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    renderer.render(
        device,
        queue,
        WgpuRenderTargetV1 {
            format: target_format,
            height_px,
            view: &view,
            width_px,
        },
        prepared,
    )?;
    read_back_tight_rgba_v1(device, queue, &texture, extent, rgba)
}

/// Copies one rendered export target out with
/// [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`]-padded rows and de-pads them into
/// `rgba`.
///
/// # Errors
///
/// Fails closed when byte accounting overflows or the bounded map/poll wait
/// cannot complete; `rgba` then holds no partial frame.
fn read_back_tight_rgba_v1(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    extent: wgpu::Extent3d,
    rgba: &mut Vec<u8>,
) -> Result<(), ExportFrameErrorV1> {
    let (unpadded_bytes_per_row, padded_bytes_per_row) = export_row_bytes_v1(extent.width)?;
    let readback_bytes = u64::from(padded_bytes_per_row)
        .checked_mul(u64::from(extent.height))
        .ok_or(ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra export frame readback v1"),
        size: readback_bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("poietra export frame copy encoder v1"),
    });
    copy_encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(extent.height),
            },
        },
        extent,
    );
    let copy_submission = queue.submit([copy_encoder.finish()]);

    let (map_sender, map_receiver) = mpsc::sync_channel(1);
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            // A dropped receiver means this export already failed closed.
            let _ = map_sender.send(result);
        });
    let poll_status = device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(copy_submission),
            timeout: Some(EXPORT_READBACK_TIMEOUT_V1),
        })
        .map_err(ExportFrameErrorV1::ReadbackPollFailed)?;
    if !poll_status.wait_finished() {
        return Err(ExportFrameErrorV1::ReadbackWaitIncomplete);
    }
    map_receiver
        .recv_timeout(EXPORT_READBACK_TIMEOUT_V1)
        .map_err(|_| ExportFrameErrorV1::ReadbackMapResultMissing)?
        .map_err(ExportFrameErrorV1::ReadbackMapFailed)?;

    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .map_err(ExportFrameErrorV1::ReadbackMappedRangeUnavailable)?;
    let padded_row_bytes = usize::try_from(padded_bytes_per_row)
        .map_err(|_| ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let unpadded_row_bytes = usize::try_from(unpadded_bytes_per_row)
        .map_err(|_| ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let height = usize::try_from(extent.height)
        .map_err(|_| ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let expected_padded_bytes = padded_row_bytes
        .checked_mul(height)
        .ok_or(ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    if mapped.len() != expected_padded_bytes {
        return Err(ExportFrameErrorV1::ReadbackSizeMismatch {
            actual: mapped.len(),
            expected: expected_padded_bytes,
        });
    }
    let tight_bytes = unpadded_row_bytes
        .checked_mul(height)
        .ok_or(ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    rgba.reserve(tight_bytes);
    for row in mapped.chunks_exact(padded_row_bytes) {
        rgba.extend_from_slice(&row[..unpadded_row_bytes]);
    }
    drop(mapped);
    readback.unmap();
    debug_assert_eq!(rgba.len(), tight_bytes);
    Ok(())
}

/// Renders every export frame of one validated Scene, yielding tight RGBA
/// bytes through `on_frame` with exactly one frame in flight.
///
/// `sample_packet` receives each requested time `i / fps` and must sample the
/// same validated Scene through its retained evaluator so
/// [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time)
/// resolves the retained-state rules. The sampled packet's correlation
/// `sample_time` and viewport are re-verified here before any GPU work for
/// that frame.
///
/// Returns the number of frames yielded, which on success always equals the
/// timeline's full frame count.
///
/// # Errors
///
/// Fails closed with a typed error on invalid parameters, sampling failures,
/// mismatched packets, or any prepare/render/readback failure. `on_frame`
/// never observes a partial frame.
pub(crate) fn render_export_frame_sequence_v1<SampleError, SamplePacket, OnFrame>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneIrV1,
    params: ExportFrameSequenceParamsV1,
    assets: &dyn DecodedPngAssetResolverV1,
    mut sample_packet: SamplePacket,
    mut on_frame: OnFrame,
) -> Result<u64, ExportFrameSequenceErrorV1<SampleError>>
where
    SampleError: std::error::Error + 'static,
    SamplePacket: FnMut(ExportFrameRequestV1) -> Result<RenderPacketV1, SampleError>,
    OnFrame: FnMut(ExportSequenceFrameV1<'_>),
{
    validate_export_viewport_v1(params)?;
    let timeline = ExportFrameTimelineV1::new(
        scene.duration,
        scene.state_sampling.retains_terminal_state,
        params.fps,
    )?;
    let viewport = ViewportV1 {
        height_px: params.height_px,
        width_px: params.width_px,
    };
    let mut renderer = WgpuPaintRendererV1::new(device, EXPORT_TARGET_FORMAT_V1)?;
    let mut rgba = Vec::new();
    for (frame_index, requested_time) in timeline.requested_times() {
        let packet = sample_packet(ExportFrameRequestV1 {
            frame_index,
            requested_time,
            viewport: viewport.clone(),
        })
        .map_err(|source| ExportFrameSequenceErrorV1::Sample {
            frame_index,
            source,
        })?;
        if packet.sample_time.to_bits() != requested_time.to_bits() {
            return Err(ExportFrameSequenceErrorV1::SampledPacketTimeMismatch {
                actual: packet.sample_time,
                expected: requested_time,
                frame_index,
            });
        }
        if packet.viewport != viewport {
            return Err(ExportFrameSequenceErrorV1::SampledPacketViewportMismatch {
                actual_height: packet.viewport.height_px,
                actual_width: packet.viewport.width_px,
                expected_height: viewport.height_px,
                expected_width: viewport.width_px,
                frame_index,
            });
        }
        let prepared = prepare_frame_with_assets_v1(&packet, assets).map_err(|source| {
            ExportFrameSequenceErrorV1::Frame {
                frame_index,
                source: source.into(),
            }
        })?;
        render_export_frame_rgba_v1(device, queue, &mut renderer, &prepared, &mut rgba).map_err(
            |source| ExportFrameSequenceErrorV1::Frame {
                frame_index,
                source,
            },
        )?;
        on_frame(ExportSequenceFrameV1 {
            frame_index,
            requested_time,
            rgba: &rgba,
        });
    }
    Ok(timeline.frame_count())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use poietra_eval::{EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1};
    use poietra_scene_ir::{
        AffineTransformV1, AnimationChannelV1, AssetManifestReferenceV1, AssetManifestSchemaV1,
        AssetManifestV1, ContractVersionV1, CoordinateSpaceV1, EasingV1, FidelityV1, FillRuleV1,
        FillStyleV1, IntervalV1, KeyframeV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1,
        RenderCompositingV1, RgbaColorV1, SceneAppearanceV1, SceneCameraV1, SceneCameraViewV1,
        SceneCapabilityV1, SceneEntityV1, SceneGeometryV1, SceneIrBundleV1, SceneIrSchemaV1,
        SceneSourceV1, SceneStateSamplingV1,
    };

    use super::*;
    use crate::DecodedPngAssetV1;

    const EMPTY_MANIFEST_DIGEST: &str =
        "e675cb4bad3da6b425e5a6bbe88d7da7a986e3cac61dab06139ef63950dcc181";
    const EXPORT_PROOF_PARAMS: ExportFrameSequenceParamsV1 = ExportFrameSequenceParamsV1 {
        fps: 5,
        height_px: 90,
        width_px: 160,
    };

    fn no_png_assets(_sha256: &str) -> Option<Arc<DecodedPngAssetV1>> {
        None
    }

    /// One red circle whose opacity animates 0 -> 1 linearly across the full
    /// 2-second duration, so every sampled time has a distinct exported frame
    /// and the terminal state is visually decisive.
    fn export_scene_bundle(
        compositing: RenderCompositingV1,
        retains_terminal_state: bool,
    ) -> SceneIrBundleV1 {
        let assets = AssetManifestV1 {
            assets: Vec::new(),
            manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
            manifest_id: "manifest".to_owned(),
            schema: AssetManifestSchemaV1::AssetManifest,
            version: ContractVersionV1,
        };
        let scene = SceneIrV1 {
            animation_channels: vec![AnimationChannelV1::Opacity {
                entity_id: "circle".to_owned(),
                id: "opacity:circle".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: 0.0,
                    },
                    KeyframeV1 {
                        at: 2.0,
                        easing_to_next: None,
                        value: 1.0,
                    },
                ],
                provenance_id: "fixture".to_owned(),
            }],
            asset_manifest: AssetManifestReferenceV1 {
                manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
                manifest_id: "manifest".to_owned(),
            },
            camera: SceneCameraV1 {
                background: RgbaColorV1 {
                    alpha: 1.0,
                    blue: 0.0,
                    green: 0.0,
                    red: 0.0,
                },
                view: SceneCameraViewV1 {
                    center: PointV1 { x: 0.0, y: 0.0 },
                    frame_height: 9.0,
                    frame_width: 16.0,
                },
            },
            compositing,
            coordinate_space: CoordinateSpaceV1::default(),
            duration: 2.0,
            entities: vec![SceneEntityV1 {
                appearance: SceneAppearanceV1::Vector {
                    fill: Some(FillStyleV1 {
                        color: RgbaColorV1 {
                            alpha: 1.0,
                            blue: 0.0,
                            green: 0.0,
                            red: 1.0,
                        },
                        rule: FillRuleV1::NonZero,
                    }),
                    opacity: 1.0,
                    stroke: None,
                },
                geometry: SceneGeometryV1::Circle {
                    center: PointV1 { x: 0.0, y: 0.0 },
                    radius: 1.0,
                },
                id: "circle".to_owned(),
                lifetimes: vec![IntervalV1 {
                    end: 2.0,
                    start: 0.0,
                }],
                parent_id: None,
                provenance_id: "fixture".to_owned(),
                scene_order: 0,
                source_z_index: 0.0,
                transform: AffineTransformV1::identity(),
            }],
            fidelity: FidelityV1::Exact {},
            provenance: vec![ProvenanceRecordV1 {
                evidence: vec!["export unit fixture".to_owned()],
                id: "fixture".to_owned(),
                origin: ProvenanceOriginV1::Fixture,
            }],
            required_capabilities: vec![
                SceneCapabilityV1::OpacityAnimation,
                SceneCapabilityV1::ShapePrimitives,
            ],
            scene_id: "scene".to_owned(),
            schema: SceneIrSchemaV1::SceneIr,
            source: SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: "0".repeat(64),
            },
            state_sampling: SceneStateSamplingV1 {
                frame_rate: None,
                retains_terminal_state,
            },
            version: ContractVersionV1,
        };
        SceneIrBundleV1 { assets, scene }
    }

    fn sample_scene_packet(
        session: &EngineSessionV1,
        request: &ExportFrameRequestV1,
    ) -> Result<RenderPacketV1, EvaluationError> {
        session.sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: &format!("packet:export-{}", request.frame_index),
            sample_time: request.requested_time,
            viewport: request.viewport.clone(),
        })
    }

    #[test]
    fn frame_grid_covers_the_full_duration_without_reaching_it() {
        let timeline = ExportFrameTimelineV1::new(2.0, false, 30)
            .expect("a 2-second grid at 30 fps must be boundable");
        assert_eq!(timeline.frame_count(), 60);
        let times: Vec<(u64, f64)> = timeline.requested_times().collect();
        assert_eq!(times.len(), 60);
        for (index, (frame_index, requested_time)) in (0..60_u32).zip(&times) {
            assert_eq!(*frame_index, u64::from(index));
            let expected = f64::from(index) / 30.0;
            assert_eq!(requested_time.to_bits(), expected.to_bits());
            assert!(*requested_time < 2.0);
        }
        assert_eq!(times[59].1.to_bits(), (59.0_f64 / 30.0).to_bits());
        assert_eq!(timeline.requested_time(60), None);
    }

    #[test]
    fn off_grid_durations_floor_their_final_grid_time() {
        let timeline = ExportFrameTimelineV1::new(2.02, false, 30)
            .expect("an off-grid duration must still be boundable");
        assert_eq!(timeline.frame_count(), 61);
        let last = timeline
            .requested_time(60)
            .expect("the final frame must have a requested time");
        assert_eq!(last.to_bits(), 2.0_f64.to_bits());
        assert!(last < 2.02);
    }

    #[test]
    fn retains_terminal_state_requests_the_exact_duration_for_the_final_frame() {
        let timeline = ExportFrameTimelineV1::new(2.0, true, 30)
            .expect("a retained 2-second grid at 30 fps must be boundable");
        assert_eq!(timeline.frame_count(), 60);
        let last = timeline
            .requested_time(59)
            .expect("the final frame must have a requested time");
        assert_eq!(last.to_bits(), 2.0_f64.to_bits());
        let preceding = timeline
            .requested_time(58)
            .expect("the preceding frame must have a requested time");
        assert_eq!(preceding.to_bits(), (58.0_f64 / 30.0).to_bits());

        let off_grid = ExportFrameTimelineV1::new(2.02, true, 30)
            .expect("a retained off-grid duration must still be boundable");
        let off_grid_last = off_grid
            .requested_time(60)
            .expect("the final frame must have a requested time");
        assert_eq!(off_grid_last.to_bits(), 2.02_f64.to_bits());
    }

    #[test]
    fn terminal_retention_resolves_through_state_sample_time() {
        let mut scene = export_scene_bundle(RenderCompositingV1::LinearLight, true).scene;

        let retained = ExportFrameTimelineV1::new(scene.duration, true, 30)
            .expect("the retained fixture grid must be boundable");
        let retained_last = retained
            .requested_time(retained.frame_count() - 1)
            .expect("the final frame must have a requested time");
        assert_eq!(retained_last.to_bits(), scene.duration.to_bits());
        let resolved = scene.state_sample_time(retained_last);
        assert_eq!(
            resolved.to_bits(),
            f64::from_bits(scene.duration.to_bits() - 1).to_bits(),
            "a retained Scene must resolve the duration request to its \
             retained terminal state just below the half-open endpoint"
        );
        assert!(resolved < scene.duration);

        scene.state_sampling.retains_terminal_state = false;
        let rolling = ExportFrameTimelineV1::new(scene.duration, false, 30)
            .expect("the non-retained fixture grid must be boundable");
        let rolling_last = rolling
            .requested_time(rolling.frame_count() - 1)
            .expect("the final frame must have a requested time");
        assert_eq!(rolling_last.to_bits(), (59.0_f64 / 30.0).to_bits());
        assert_eq!(
            scene.state_sample_time(rolling_last).to_bits(),
            rolling_last.to_bits(),
            "a non-retained Scene must sample its final grid time unchanged"
        );

        scene.state_sampling = SceneStateSamplingV1 {
            frame_rate: Some(30.0),
            retains_terminal_state: true,
        };
        assert_eq!(
            scene.state_sample_time(2.0).to_bits(),
            (59.0_f64 / 30.0).to_bits(),
            "a frame-rate grid must clamp the retained duration request to \
             its final grid frame"
        );
    }

    #[test]
    fn rejects_unboundable_frame_grids() {
        assert_eq!(
            ExportFrameTimelineV1::new(2.0, false, 0),
            Err(ExportFrameSequenceParamsErrorV1::ZeroFps)
        );
        assert!(matches!(
            ExportFrameTimelineV1::new(f64::NAN, false, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(0.0, false, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(-1.0, false, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(f64::MAX, false, 240),
            Err(ExportFrameSequenceParamsErrorV1::FrameCountOutOfRange { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(1.0e300, false, 240),
            Err(ExportFrameSequenceParamsErrorV1::FrameCountOutOfRange { .. })
        ));
    }

    #[test]
    fn mirrors_packet_viewport_limits() {
        let params = |width_px, height_px| ExportFrameSequenceParamsV1 {
            fps: 30,
            height_px,
            width_px,
        };
        assert!(matches!(
            validate_export_viewport_v1(params(0, 90)),
            Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange { .. })
        ));
        assert!(matches!(
            validate_export_viewport_v1(params(160, 16_385)),
            Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange { .. })
        ));
        assert_eq!(validate_export_viewport_v1(params(854, 480)), Ok(()));
        assert_eq!(validate_export_viewport_v1(params(16_384, 2_048)), Ok(()));
        assert!(matches!(
            validate_export_viewport_v1(params(16_384, 2_049)),
            Err(ExportFrameSequenceParamsErrorV1::ViewportPixelsExceeded { .. })
        ));
    }

    #[test]
    fn pads_rows_to_the_copy_alignment() {
        assert!(matches!(export_row_bytes_v1(100), Ok((400, 512))));
        assert!(matches!(export_row_bytes_v1(64), Ok((256, 256))));
        assert!(matches!(export_row_bytes_v1(1), Ok((4, 256))));
        assert!(matches!(export_row_bytes_v1(16_384), Ok((65_536, 65_536))));
        assert!(matches!(
            export_row_bytes_v1(u32::MAX),
            Err(ExportFrameErrorV1::ReadbackByteAccountingOverflow)
        ));
    }

    fn export_gpu_context() -> (wgpu::Device, wgpu::Queue) {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            apply_limit_buckets: false,
            compatible_surface: None,
            force_fallback_adapter: true,
            power_preference: wgpu::PowerPreference::None,
        }))
        .expect("a native fallback WGPU adapter is required for this proof");
        assert_eq!(
            adapter.get_info().device_type,
            wgpu::DeviceType::Cpu,
            "force_fallback_adapter must resolve to a CPU adapter"
        );
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("poietra export proof device"),
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        }))
        .expect("fallback adapter must create the proof device")
    }

    fn pixel(rgba: &[u8], width_px: u32, x: u32, y: u32) -> [u8; 4] {
        assert!(x < width_px, "pixel x must be inside the viewport");
        let pixel_offset = y
            .checked_mul(width_px)
            .and_then(|offset| offset.checked_add(x))
            .and_then(|offset| offset.checked_mul(EXPORT_BYTES_PER_PIXEL_V1))
            .and_then(|offset| usize::try_from(offset).ok())
            .expect("pixel offset must fit usize");
        let pixel_end = pixel_offset
            .checked_add(4)
            .expect("pixel end must fit usize");
        rgba.get(pixel_offset..pixel_end)
            .expect("pixel y must be inside the viewport")
            .try_into()
            .expect("RGBA8 pixel must contain four channels")
    }

    fn assert_pixel_close(actual: [u8; 4], expected: [u8; 4], tolerance: [u8; 4]) {
        for ((actual, expected), tolerance) in actual.into_iter().zip(expected).zip(tolerance) {
            assert!(
                actual.abs_diff(expected) <= tolerance,
                "expected channel {expected} +/- {tolerance}, received {actual}"
            );
        }
    }

    fn assert_no_gpu_error(kind: &str, error: Option<wgpu::Error>) {
        let Some(error) = error else {
            return;
        };
        panic!("{kind} GPU error: {error:?}");
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn exports_a_linear_light_frame_sequence_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

        let session =
            EngineSessionV1::new(export_scene_bundle(RenderCompositingV1::LinearLight, false))
                .expect("the export fixture bundle must validate");
        let mut frames: Vec<(u64, f64, Vec<u8>)> = Vec::new();
        let frame_count = render_export_frame_sequence_v1(
            &device,
            &queue,
            session.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request| sample_scene_packet(&session, &request),
            |frame| frames.push((frame.frame_index, frame.requested_time, frame.rgba.to_vec())),
        )
        .expect("the linear-light fixture must export every frame");

        assert_eq!(frame_count, 10);
        assert_eq!(frames.len(), 10);
        for (index, (frame_index, requested_time, rgba)) in (0..10_u32).zip(&frames) {
            assert_eq!(*frame_index, u64::from(index));
            assert_eq!(
                requested_time.to_bits(),
                (f64::from(index) / 5.0).to_bits()
            );
            assert_eq!(rgba.len(), 160 * 90 * 4);
        }
        let first = &frames[0].2;
        assert_eq!(pixel(first, 160, 80, 45), [0, 0, 0, 255]);
        assert_eq!(pixel(first, 160, 0, 0), [0, 0, 0, 255]);
        // t = 1.8 samples opacity 0.9; sRGB-encoding 0.9 linear red yields 243.
        let last = &frames[9].2;
        assert_pixel_close(pixel(last, 160, 80, 45), [243, 0, 0, 255], [2, 0, 0, 0]);
        assert_eq!(pixel(last, 160, 0, 0), [0, 0, 0, 255]);

        assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
        assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
        assert_no_gpu_error(
            "out-of-memory",
            pollster::block_on(out_of_memory_scope.pop()),
        );
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn retained_terminal_state_drives_the_final_export_frame_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let render_last = |retains_terminal_state: bool| -> (f64, Vec<u8>) {
            let session = EngineSessionV1::new(export_scene_bundle(
                RenderCompositingV1::LinearLight,
                retains_terminal_state,
            ))
            .expect("the export fixture bundle must validate");
            let mut last: Option<(u64, f64, Vec<u8>)> = None;
            let frame_count = render_export_frame_sequence_v1(
                &device,
                &queue,
                session.scene(),
                EXPORT_PROOF_PARAMS,
                &no_png_assets,
                |request| sample_scene_packet(&session, &request),
                |frame| {
                    last = Some((frame.frame_index, frame.requested_time, frame.rgba.to_vec()));
                },
            )
            .expect("the fixture must export every frame");
            let (frame_index, requested_time, rgba) =
                last.expect("the export must yield a final frame");
            assert_eq!(frame_index + 1, frame_count);
            (requested_time, rgba)
        };

        let (retained_time, retained_rgba) = render_last(true);
        assert_eq!(retained_time.to_bits(), 2.0_f64.to_bits());
        // The retained terminal state has opacity 1: fully saturated red.
        assert_pixel_close(pixel(&retained_rgba, 160, 80, 45), [255, 0, 0, 255], [1, 0, 0, 0]);

        let (rolling_time, rolling_rgba) = render_last(false);
        assert_eq!(rolling_time.to_bits(), (9.0_f64 / 5.0).to_bits());
        // The final grid time 1.8 samples opacity 0.9, not the terminal state.
        assert_pixel_close(pixel(&rolling_rgba, 160, 80, 45), [243, 0, 0, 255], [2, 0, 0, 0]);
        assert_ne!(retained_rgba, rolling_rgba);
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn exports_manim_cairo_frames_through_the_base_unorm_resolve_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let session =
            EngineSessionV1::new(export_scene_bundle(RenderCompositingV1::ManimCairoSrgb, true))
                .expect("the Cairo export fixture bundle must validate");
        let params = ExportFrameSequenceParamsV1 {
            fps: 2,
            ..EXPORT_PROOF_PARAMS
        };
        let mut frames: Vec<(f64, Vec<u8>)> = Vec::new();
        let frame_count = render_export_frame_sequence_v1(
            &device,
            &queue,
            session.scene(),
            params,
            &no_png_assets,
            |request| sample_scene_packet(&session, &request),
            |frame| frames.push((frame.requested_time, frame.rgba.to_vec())),
        )
        .expect("the Manim/Cairo fixture must export every frame");

        assert_eq!(frame_count, 4);
        assert_eq!(frames.len(), 4);
        for (requested_time, rgba) in &frames {
            assert!(*requested_time <= 2.0);
            assert_eq!(rgba.len(), 160 * 90 * 4);
        }
        assert_eq!(frames[3].0.to_bits(), 2.0_f64.to_bits());
        assert_eq!(pixel(&frames[0].1, 160, 80, 45), [0, 0, 0, 255]);
        // The retained Cairo terminal state resolves through the four-sample
        // base-Unorm attachment into fully saturated red.
        assert_pixel_close(pixel(&frames[3].1, 160, 80, 45), [255, 0, 0, 255], [1, 0, 0, 0]);
        assert_eq!(pixel(&frames[3].1, 160, 0, 0), [0, 0, 0, 255]);
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn fails_closed_without_yielding_frames_when_the_sampler_mismatches_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let session =
            EngineSessionV1::new(export_scene_bundle(RenderCompositingV1::LinearLight, false))
                .expect("the export fixture bundle must validate");
        let mut yielded = 0_u64;

        let viewport_result = render_export_frame_sequence_v1(
            &device,
            &queue,
            session.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request| {
                session.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:viewport-lie",
                    sample_time: request.requested_time,
                    viewport: ViewportV1 {
                        height_px: 45,
                        width_px: 80,
                    },
                })
            },
            |_frame| yielded += 1,
        );
        assert!(matches!(
            viewport_result,
            Err(ExportFrameSequenceErrorV1::SampledPacketViewportMismatch {
                frame_index: 0,
                ..
            })
        ));

        let time_result = render_export_frame_sequence_v1(
            &device,
            &queue,
            session.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request| {
                session.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:time-lie",
                    sample_time: request.requested_time + 0.125,
                    viewport: request.viewport,
                })
            },
            |_frame| yielded += 1,
        );
        assert!(matches!(
            time_result,
            Err(ExportFrameSequenceErrorV1::SampledPacketTimeMismatch { frame_index: 0, .. })
        ));

        let sample_result = render_export_frame_sequence_v1(
            &device,
            &queue,
            session.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request| {
                session.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:invalid-viewport",
                    sample_time: request.requested_time,
                    viewport: ViewportV1 {
                        height_px: 0,
                        width_px: 0,
                    },
                })
            },
            |_frame| yielded += 1,
        );
        assert!(matches!(
            sample_result,
            Err(ExportFrameSequenceErrorV1::Sample { frame_index: 0, .. })
        ));

        assert_eq!(yielded, 0, "no partial frame may ever be yielded");
    }
}
