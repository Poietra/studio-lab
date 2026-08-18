//! Offscreen export rendering for validated frames.
//!
//! This is the production counterpart of the headless GPU proof template:
//! one validated, prepared frame renders into an offscreen
//! `COPY_SRC | RENDER_ATTACHMENT` target through the existing
//! [`WgpuPaintRendererV1`] paint path — including the Manim/Cairo four-sample
//! base-Unorm resolve — is copied out with
//! [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`] row padding, and is de-padded into
//! tight RGBA bytes.
//!
//! The core is **async**: readback completion resolves a future when the
//! `map_async` callback fires, and no code path here relies on a blocking
//! `device.poll` for progress, so the same code runs on the browser WebGPU
//! backend (where `poll` is a no-op and callbacks arrive from the event loop)
//! and on native. Native callers drive the futures with the
//! `#[cfg(not(target_arch = "wasm32"))]` blocking driver, which interleaves
//! `device.poll(Wait)` between future polls.
//!
//! The stepwise [`ExportFrameSequenceSessionV1`] yields one bounded frame per
//! `next_frame().await`, so an encoder integrator can interleave backpressure
//! between frames, propagate per-frame errors, and cancel by dropping the
//! session. Requested instants are always exactly `i / fps` on a uniform grid;
//! resolving an instant against retained Scene state — including
//! `retains_terminal_state` — belongs to
//! [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time)
//! inside the caller's sampler (#721 decision). Every failure is a typed error
//! and no partial frame is ever yielded. Export bounds come from the canonical
//! [`ExportProfileV1`](poietra_scene_ir::ExportProfileV1) contract; everything
//! The stepwise session is the production integration boundary used by the
//! browser exporter; the lower-level target/readback details remain private.

use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
#[cfg(not(target_arch = "wasm32"))]
use std::time::{Duration, Instant};

use poietra_scene_ir::{
    ExportFrameRateV1, ExportResolutionV1, MAX_EXPORT_DURATION_SECONDS_V1, RenderPacketV1,
    SceneIrV1, ViewportV1,
};

use crate::PreparedGeometryCacheV1;
use crate::WgpuPaintRendererV1;
use crate::gpu::{
    CreateRendererErrorV1, FragmentMaterialRegistryErrorV1, FragmentMaterialSourceV1,
    RenderFrameErrorV1, WgpuRenderTargetV1,
};
use crate::prepare::{
    DecodedPngAssetResolverV1, PrepareFrameErrorV1, PreparedFrameV1,
    prepare_frame_with_cache_assets_and_fragment_materials_v1,
};

/// RGBA8 bytes per exported pixel.
const EXPORT_BYTES_PER_PIXEL_V1: u32 = 4;

/// Unified export view format. Manim/Cairo frames resolve into this format's
/// exact base-Unorm variant through the renderer's existing four-sample paint
/// path, exactly as the interactive canvas target does.
pub(crate) const EXPORT_TARGET_FORMAT_V1: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

/// Export limits derived from the closed `ExportProfileV1` resolution and
/// frame-rate choices. The duration ceiling is imported from the same
/// contract, leaving `poietra-scene-ir` as their single authority.
const MAX_EXPORT_FRAME_WIDTH_PX_V1: u32 = ExportResolutionV1::FullHd1920x1080.width_px();
const MAX_EXPORT_FRAME_HEIGHT_PX_V1: u32 = ExportResolutionV1::FullHd1920x1080.height_px();
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the closed ExportFrameRateV1 value is an integer frame rate"
)]
const MAX_EXPORT_FPS_V1: u32 = ExportFrameRateV1::Fps60.frames_per_second() as u32;
#[allow(
    clippy::cast_lossless,
    reason = "const evaluation cannot call the From conversions"
)]
const MAX_EXPORT_FRAME_COUNT_V1: u64 =
    (MAX_EXPORT_DURATION_SECONDS_V1 as u64) * (MAX_EXPORT_FPS_V1 as u64);

/// Upper bound on frames the [`prove_export_frame_sequence_readback_v1`]
/// proof hook may return; mirrors the browser readback e2e sequence cap.
const MAX_EXPORT_PROOF_FRAMES_V1: u64 = 32;

/// Bounded fail-closed deadline for the native blocking driver. Generous so
/// software adapters can finish large frames; a future that cannot complete
/// inside it aborts the whole export.
#[cfg(not(target_arch = "wasm32"))]
const EXPORT_BLOCKING_DEADLINE_V1: Duration = Duration::from_mins(1);

/// One offscreen export frame could not be produced truthfully.
#[derive(Debug, thiserror::Error)]
pub enum ExportFrameErrorV1 {
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
pub enum ExportFrameSequenceParamsErrorV1 {
    #[error("export fps {fps} must be between 1 and {}", MAX_EXPORT_FPS_V1)]
    FpsOutOfRange { fps: u32 },
    #[error("validated scene duration {duration} is not a positive finite time")]
    InvalidSceneDuration { duration: f64 },
    #[error(
        "scene duration {duration} exceeds the {}-second export cap",
        MAX_EXPORT_DURATION_SECONDS_V1
    )]
    DurationExceedsExportCap { duration: f64 },
    #[error(
        "duration {duration} at {fps} fps exceeds the {}-frame export cap",
        MAX_EXPORT_FRAME_COUNT_V1
    )]
    FrameCountOutOfRange { duration: f64, fps: u32 },
    #[error(
        "export viewport {width_px}x{height_px} must stay within 1..={} x 1..={}",
        MAX_EXPORT_FRAME_WIDTH_PX_V1,
        MAX_EXPORT_FRAME_HEIGHT_PX_V1
    )]
    ViewportSideOutOfRange { height_px: u32, width_px: u32 },
}

/// The export frame sequence failed closed before yielding a further frame.
#[derive(Debug, thiserror::Error)]
pub enum ExportFrameSequenceErrorV1<SampleError>
where
    SampleError: std::error::Error + 'static,
{
    #[error(transparent)]
    Params(#[from] ExportFrameSequenceParamsErrorV1),
    #[error(transparent)]
    Renderer(#[from] CreateRendererErrorV1),
    #[error(transparent)]
    FragmentMaterialRegistry(#[from] FragmentMaterialRegistryErrorV1),
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

/// The native blocking driver could not complete an export future.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, thiserror::Error)]
pub(crate) enum ExportBlockingDriveErrorV1 {
    #[error("export blocking drive did not complete before its deadline")]
    DeadlineExceeded,
    #[error("export blocking drive polling failed: {0}")]
    Poll(wgpu::PollError),
    #[error(
        "export blocking drive stalled: the device queue is empty and nothing woke the pending future"
    )]
    Stalled,
}

/// Minimal renderer parameters consumed after the canonical
/// `ExportProfileV1` contract has selected the export settings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExportFrameSequenceParamsV1 {
    /// Frames per second for the uniform requested-time grid `i / fps`.
    pub fps: u32,
    pub height_px: u32,
    pub width_px: u32,
}

/// Per-frame request handed to the packet sampler.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportFrameRequestV1 {
    pub frame_index: u64,
    pub requested_time: f64,
    pub viewport: ViewportV1,
}

/// Borrowed view of one completed export frame. The tight RGBA buffer is
/// reused for the next frame after the borrow ends, so a session keeps
/// exactly one frame in flight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExportSequenceFrameV1<'a> {
    pub frame_index: u64,
    pub requested_time: f64,
    pub rgba: &'a [u8],
}

/// Uniform requested-time grid for one validated Scene export.
///
/// The grid holds `ceil(duration * fps)` frames and every requested instant
/// is exactly `i / fps`, covering `[0, duration)`. Terminal-state retention is
/// not a grid concern: resolving a requested instant against retained Scene
/// state — including `retains_terminal_state` — belongs to
/// [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time)
/// inside the caller's sampler (#721 decision).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExportFrameTimelineV1 {
    fps_hz: f64,
    frame_count: u64,
}

impl ExportFrameTimelineV1 {
    /// Builds the bounded uniform requested-time grid for one validated Scene
    /// duration.
    ///
    /// # Errors
    ///
    /// Fails closed when `fps` leaves the canonical `ExportProfileV1` rate cap,
    /// when the duration is not a positive finite time, or when the grid
    /// exceeds the canonical duration/frame-count caps.
    pub(crate) fn new(duration: f64, fps: u32) -> Result<Self, ExportFrameSequenceParamsErrorV1> {
        if fps == 0 || fps > MAX_EXPORT_FPS_V1 {
            return Err(ExportFrameSequenceParamsErrorV1::FpsOutOfRange { fps });
        }
        if !duration.is_finite() || duration <= 0.0 {
            return Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { duration });
        }
        if duration > f64::from(MAX_EXPORT_DURATION_SECONDS_V1) {
            return Err(ExportFrameSequenceParamsErrorV1::DurationExceedsExportCap { duration });
        }
        let fps_hz = f64::from(fps);
        // The validated grid stays below the profile-derived frame ceiling,
        // so the ceiling is exact in u64.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let frame_count = (duration * fps_hz).ceil() as u64;
        if frame_count > MAX_EXPORT_FRAME_COUNT_V1 {
            return Err(ExportFrameSequenceParamsErrorV1::FrameCountOutOfRange { duration, fps });
        }
        Ok(Self {
            fps_hz,
            frame_count,
        })
    }

    #[must_use]
    pub(crate) const fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Returns the uniform requested instant `frame_index / fps`, or `None`
    /// outside the grid.
    #[must_use]
    pub(crate) fn requested_time(&self, frame_index: u64) -> Option<f64> {
        if frame_index >= self.frame_count {
            return None;
        }
        // `frame_index < 2^53`, so the cast is exact.
        #[allow(clippy::cast_precision_loss)]
        Some(frame_index as f64 / self.fps_hz)
    }
}

/// Rejects export viewports outside the canonical `ExportProfileV1` resolution
/// caps before any GPU resource exists.
///
/// # Errors
///
/// Fails closed when either side leaves the positive range bounded by the
/// largest canonical export resolution.
pub(crate) fn validate_export_viewport_v1(
    params: ExportFrameSequenceParamsV1,
) -> Result<(), ExportFrameSequenceParamsErrorV1> {
    let ExportFrameSequenceParamsV1 {
        fps: _,
        height_px,
        width_px,
    } = params;
    if width_px == 0
        || width_px > MAX_EXPORT_FRAME_WIDTH_PX_V1
        || height_px == 0
        || height_px > MAX_EXPORT_FRAME_HEIGHT_PX_V1
    {
        return Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange {
            height_px,
            width_px,
        });
    }
    Ok(())
}

/// Shared completion slot between the `map_async` callback and the awaiting
/// export future.
#[derive(Debug)]
struct ReadbackSignalStateV1 {
    result: Option<Result<(), wgpu::BufferAsyncError>>,
    sender_dropped: bool,
    waker: Option<Waker>,
}

/// A poisoned readback lock cannot corrupt the single-slot protocol; take the
/// inner state either way instead of propagating a panic.
fn lock_readback_state_v1(
    state: &Mutex<ReadbackSignalStateV1>,
) -> MutexGuard<'_, ReadbackSignalStateV1> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Completion side moved into the `map_async` callback.
#[derive(Debug)]
struct ReadbackSenderV1 {
    state: Arc<Mutex<ReadbackSignalStateV1>>,
}

impl ReadbackSenderV1 {
    fn send(&self, result: Result<(), wgpu::BufferAsyncError>) {
        let waker = {
            let mut state = lock_readback_state_v1(&self.state);
            state.result = Some(result);
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl Drop for ReadbackSenderV1 {
    fn drop(&mut self) {
        let waker = {
            let mut state = lock_readback_state_v1(&self.state);
            state.sender_dropped = true;
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

/// Future resolving with the `map_async` result, or `None` when the callback
/// was dropped without reporting one.
#[derive(Debug)]
struct ReadbackReceiverV1 {
    state: Arc<Mutex<ReadbackSignalStateV1>>,
}

impl Future for ReadbackReceiverV1 {
    type Output = Option<Result<(), wgpu::BufferAsyncError>>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = lock_readback_state_v1(&self.state);
        if let Some(result) = state.result.take() {
            return Poll::Ready(Some(result));
        }
        if state.sender_dropped {
            return Poll::Ready(None);
        }
        state.waker = Some(context.waker().clone());
        Poll::Pending
    }
}

fn readback_signal_v1() -> (ReadbackSenderV1, ReadbackReceiverV1) {
    let state = Arc::new(Mutex::new(ReadbackSignalStateV1 {
        result: None,
        sender_dropped: false,
        waker: None,
    }));
    (
        ReadbackSenderV1 {
            state: Arc::clone(&state),
        },
        ReadbackReceiverV1 { state },
    )
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

/// De-pads aligned readback rows into `rgba` after verifying the mapped size.
///
/// # Errors
///
/// Fails closed when byte accounting overflows or the mapped image does not
/// match the padded layout; `rgba` then holds no partial frame.
fn copy_tight_rows_v1(
    mapped: &[u8],
    padded_bytes_per_row: u32,
    unpadded_bytes_per_row: u32,
    height_px: u32,
    rgba: &mut Vec<u8>,
) -> Result<(), ExportFrameErrorV1> {
    let padded_row_bytes = usize::try_from(padded_bytes_per_row)
        .map_err(|_| ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let unpadded_row_bytes = usize::try_from(unpadded_bytes_per_row)
        .map_err(|_| ExportFrameErrorV1::ReadbackByteAccountingOverflow)?;
    let height = usize::try_from(height_px)
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
    debug_assert_eq!(rgba.len(), tight_bytes);
    Ok(())
}

/// Copies one rendered export target out with
/// [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`]-padded rows and de-pads them into
/// `rgba`. Completion is awaited through the `map_async` future; nothing here
/// blocks on `device.poll`, so the same path runs on the browser WebGPU
/// backend where callbacks arrive from the event loop.
///
/// # Errors
///
/// Fails closed when byte accounting overflows or mapping cannot complete;
/// `rgba` then holds no partial frame.
async fn read_back_tight_rgba_v1(
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
    queue.submit([copy_encoder.finish()]);

    let (map_sender, map_receiver) = readback_signal_v1();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            map_sender.send(result);
        });
    match map_receiver.await {
        Some(Ok(())) => {}
        Some(Err(error)) => return Err(ExportFrameErrorV1::ReadbackMapFailed(error)),
        None => return Err(ExportFrameErrorV1::ReadbackMapResultMissing),
    }

    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .map_err(ExportFrameErrorV1::ReadbackMappedRangeUnavailable)?;
    copy_tight_rows_v1(
        &mapped,
        padded_bytes_per_row,
        unpadded_bytes_per_row,
        extent.height,
        rgba,
    )?;
    drop(mapped);
    readback.unmap();
    Ok(())
}

/// Renders one validated, prepared frame into a fresh offscreen
/// `COPY_SRC | RENDER_ATTACHMENT` target and awaits its de-padded tight RGBA
/// bytes into `rgba`, which afterwards holds exactly `width * height * 4`
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
pub(crate) async fn render_export_frame_rgba_v1(
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
    read_back_tight_rgba_v1(device, queue, &texture, extent, rgba).await
}

/// Stepwise driver rendering one validated Scene's uniform export grid,
/// yielding one bounded frame per [`Self::next_frame`] await.
///
/// The session owns the renderer and one reused tight-RGBA buffer, so exactly
/// one frame is in flight; an encoder integrator awaits `next_frame`, hands
/// the borrowed bytes onward, and only then advances — which is where
/// `WebCodecs` dequeue backpressure interleaves. Cancel by dropping the
/// session.
/// After any error the session is fused: the error is yielded once and every
/// later call returns `None`.
pub struct ExportFrameSequenceSessionV1<'assets, SampleError, SamplePacket> {
    assets: &'assets dyn DecodedPngAssetResolverV1,
    device: wgpu::Device,
    failed: bool,
    geometry_cache: PreparedGeometryCacheV1,
    next_frame_index: u64,
    queue: wgpu::Queue,
    renderer: WgpuPaintRendererV1,
    rgba: Vec<u8>,
    sample_error: PhantomData<fn() -> SampleError>,
    sample_packet: SamplePacket,
    timeline: ExportFrameTimelineV1,
    viewport: ViewportV1,
}

impl<SampleError, SamplePacket> std::fmt::Debug
    for ExportFrameSequenceSessionV1<'_, SampleError, SamplePacket>
{
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExportFrameSequenceSessionV1")
            .field("failed", &self.failed)
            .field("frame_count", &self.timeline.frame_count())
            .field("next_frame_index", &self.next_frame_index)
            .field("viewport", &self.viewport)
            .finish_non_exhaustive()
    }
}

impl<'assets, SampleError, SamplePacket>
    ExportFrameSequenceSessionV1<'assets, SampleError, SamplePacket>
where
    SampleError: std::error::Error + 'static,
    SamplePacket: FnMut(ExportFrameRequestV1) -> Result<RenderPacketV1, SampleError>,
{
    /// Validates the export parameters against the canonical `ExportProfileV1`
    /// caps and prepares the session for its first frame. No GPU frame work
    /// happens until [`Self::next_frame`].
    ///
    /// `sample_packet` receives each uniform requested instant `i / fps` and
    /// must sample the same validated Scene through its retained evaluator so
    /// [`SceneIrV1::state_sample_time`](poietra_scene_ir::SceneIrV1::state_sample_time)
    /// resolves the retained-state rules.
    ///
    /// # Errors
    ///
    /// Fails closed on parameters outside the canonical caps or when the
    /// unified-format renderer cannot be created.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &SceneIrV1,
        params: ExportFrameSequenceParamsV1,
        assets: &'assets dyn DecodedPngAssetResolverV1,
        sample_packet: SamplePacket,
    ) -> Result<Self, ExportFrameSequenceErrorV1<SampleError>> {
        validate_export_viewport_v1(params)?;
        let timeline = ExportFrameTimelineV1::new(scene.duration, params.fps)?;
        let renderer = WgpuPaintRendererV1::new(device, EXPORT_TARGET_FORMAT_V1)?;
        Ok(Self {
            assets,
            device: device.clone(),
            failed: false,
            geometry_cache: PreparedGeometryCacheV1::default(),
            next_frame_index: 0,
            queue: queue.clone(),
            renderer,
            rgba: Vec::new(),
            sample_error: PhantomData,
            sample_packet,
            timeline,
            viewport: ViewportV1 {
                height_px: params.height_px,
                width_px: params.width_px,
            },
        })
    }

    /// Creates an export session using the exact project-local fragment
    /// registry shared with the interactive preview renderer.
    ///
    /// # Errors
    ///
    /// Returns an error when export setup or any fragment material is invalid.
    pub async fn new_with_fragment_material_sources(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &SceneIrV1,
        params: ExportFrameSequenceParamsV1,
        assets: &'assets dyn DecodedPngAssetResolverV1,
        sample_packet: SamplePacket,
        fragment_materials: &[FragmentMaterialSourceV1],
    ) -> Result<Self, ExportFrameSequenceErrorV1<SampleError>> {
        let mut session = Self::new(device, queue, scene, params, assets, sample_packet)?;
        session
            .renderer
            .replace_fragment_material_sources(device, fragment_materials)
            .await?;
        Ok(session)
    }

    #[must_use]
    pub const fn frame_count(&self) -> u64 {
        self.timeline.frame_count()
    }

    /// Index of the next frame [`Self::next_frame`] would render; equals the
    /// number of frames already yielded.
    #[must_use]
    pub const fn next_frame_index(&self) -> u64 {
        self.next_frame_index
    }

    /// Renders the next frame of the uniform grid and yields its tight RGBA
    /// bytes, or `None` when the sequence is complete or already failed.
    ///
    /// The sampled packet's correlation `sample_time` (bit-exact) and viewport
    /// are re-verified before any GPU work for the frame. On `Some(Err(_))`
    /// the session is fused and no partial frame was yielded.
    pub async fn next_frame(
        &mut self,
    ) -> Option<Result<ExportSequenceFrameV1<'_>, ExportFrameSequenceErrorV1<SampleError>>> {
        if self.failed {
            return None;
        }
        let frame_index = self.next_frame_index;
        let requested_time = self.timeline.requested_time(frame_index)?;
        match self.render_next(frame_index, requested_time).await {
            Ok(()) => {
                self.next_frame_index += 1;
                Some(Ok(ExportSequenceFrameV1 {
                    frame_index,
                    requested_time,
                    rgba: &self.rgba,
                }))
            }
            Err(error) => {
                self.failed = true;
                Some(Err(error))
            }
        }
    }

    async fn render_next(
        &mut self,
        frame_index: u64,
        requested_time: f64,
    ) -> Result<(), ExportFrameSequenceErrorV1<SampleError>> {
        let packet = (self.sample_packet)(ExportFrameRequestV1 {
            frame_index,
            requested_time,
            viewport: self.viewport.clone(),
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
        if packet.viewport != self.viewport {
            return Err(ExportFrameSequenceErrorV1::SampledPacketViewportMismatch {
                actual_height: packet.viewport.height_px,
                actual_width: packet.viewport.width_px,
                expected_height: self.viewport.height_px,
                expected_width: self.viewport.width_px,
                frame_index,
            });
        }
        let prepared = prepare_frame_with_cache_assets_and_fragment_materials_v1(
            &packet,
            &mut self.geometry_cache,
            self.assets,
            &self.renderer,
        )
        .map_err(|source| ExportFrameSequenceErrorV1::Frame {
            frame_index,
            source: source.into(),
        })?;
        render_export_frame_rgba_v1(
            &self.device,
            &self.queue,
            &mut self.renderer,
            &prepared,
            &mut self.rgba,
        )
        .await
        .map_err(|source| ExportFrameSequenceErrorV1::Frame {
            frame_index,
            source,
        })
    }
}

/// Wake evidence for the native blocking driver: map callbacks fired during
/// `device.poll` set the flag through the future's waker.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Default)]
struct ExportDriveWakeFlagV1(std::sync::atomic::AtomicBool);

#[cfg(not(target_arch = "wasm32"))]
impl std::task::Wake for ExportDriveWakeFlagV1 {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Drives one export future to completion on native by interleaving
/// `device.poll(Wait)` between future polls, so `map_async` callbacks fire
/// and wake the future. The async core itself never blocks; this driver is
/// the only blocking code and exists solely for native callers such as the
/// headless GPU proofs.
///
/// # Errors
///
/// Fails closed when the bounded deadline elapses, when device polling
/// fails, or when the device queue is empty and nothing woke the still
/// pending future, meaning no remaining work can ever complete it.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn drive_export_blocking_v1<F: Future>(
    device: &wgpu::Device,
    future: F,
) -> Result<F::Output, ExportBlockingDriveErrorV1> {
    use std::sync::atomic::Ordering;

    let mut future = Box::pin(future);
    let wake_flag = Arc::new(ExportDriveWakeFlagV1::default());
    let waker = Waker::from(Arc::clone(&wake_flag));
    let mut context = Context::from_waker(&waker);
    let deadline = Instant::now() + EXPORT_BLOCKING_DEADLINE_V1;
    loop {
        wake_flag.0.store(false, Ordering::SeqCst);
        if let Poll::Ready(output) = future.as_mut().poll(&mut context) {
            return Ok(output);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(ExportBlockingDriveErrorV1::DeadlineExceeded);
        }
        let status = device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(deadline - now),
            })
            .map_err(|error| match error {
                wgpu::PollError::Timeout => ExportBlockingDriveErrorV1::DeadlineExceeded,
                other @ wgpu::PollError::WrongSubmissionIndex(..) => {
                    ExportBlockingDriveErrorV1::Poll(other)
                }
            })?;
        if status.is_queue_empty() && !wake_flag.0.load(Ordering::SeqCst) {
            return Err(ExportBlockingDriveErrorV1::Stalled);
        }
    }
}

/// Stringly sampler failure carried through the proof-hook boundary.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct ExportProofSampleErrorV1(String);

/// Test-only proof hook for the crate-private async offscreen export path.
///
/// Drives the stepwise session for one already validated Scene on the given
/// device and returns every frame's tight RGBA bytes, bounded to a small
/// proof grid so the hook can never become a production export surface.
/// Errors are stringified at this boundary. Hidden from documentation: it
/// exists solely so the browser readback e2e can execute the exact async
/// readback code that the native headless proofs execute; the public export
/// contract is #721's work and this hook must be replaced by it.
///
/// # Errors
///
/// Returns the stringified typed error of the first failing stage; no partial
/// frame is ever included.
#[doc(hidden)]
pub async fn prove_export_frame_sequence_readback_v1<SamplePacket>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneIrV1,
    width_px: u32,
    height_px: u32,
    fps: u32,
    mut sample_packet: SamplePacket,
) -> Result<Vec<Vec<u8>>, String>
where
    SamplePacket: FnMut(u64, f64, ViewportV1) -> Result<RenderPacketV1, String>,
{
    let params = ExportFrameSequenceParamsV1 {
        fps,
        height_px,
        width_px,
    };
    let no_assets = |_sha256: &str| Option::<Arc<crate::DecodedPngAssetV1>>::None;
    let mut session = ExportFrameSequenceSessionV1::new(
        device,
        queue,
        scene,
        params,
        &no_assets,
        move |request: ExportFrameRequestV1| {
            sample_packet(
                request.frame_index,
                request.requested_time,
                request.viewport,
            )
            .map_err(ExportProofSampleErrorV1)
        },
    )
    .map_err(|error| error.to_string())?;
    if session.frame_count() > MAX_EXPORT_PROOF_FRAMES_V1 {
        return Err(format!(
            "the export readback proof accepts at most {MAX_EXPORT_PROOF_FRAMES_V1} frames; the requested grid holds {}",
            session.frame_count()
        ));
    }
    let mut frames = Vec::new();
    while let Some(frame) = session.next_frame().await {
        let frame = frame.map_err(|error| error.to_string())?;
        frames.push(frame.rgba.to_vec());
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use poietra_eval::{EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1};
    use poietra_scene_ir::{
        AffineTransformV1, AnimationChannelV1, AssetManifestReferenceV1, AssetManifestSchemaV1,
        AssetManifestV1, ContractVersionV1, CoordinateSpaceV1, EasingV1, FidelityV1, FillRuleV1,
        FillStyleV1, FragmentMaterialV1, IntervalV1, KeyframeV1, PointV1, ProvenanceOriginV1,
        ProvenanceRecordV1, RenderCompositingV1, RgbaColorV1, SceneAppearanceV1, SceneCameraV1,
        SceneCameraViewV1, SceneCapabilityV1, SceneEntityV1, SceneGeometryV1, SceneIrBundleV1,
        SceneIrSchemaV1, SceneSourceV1, SceneStateSamplingV1,
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

    /// One red circle across a 2-second duration. With `animate_opacity` its
    /// opacity rises 0 -> 1 linearly so every sampled instant has a distinct
    /// exported frame; without it the circle is statically opaque.
    #[allow(clippy::too_many_lines)] // One contiguous Scene IR literal.
    fn export_scene_bundle(
        compositing: RenderCompositingV1,
        animate_opacity: bool,
        retains_terminal_state: bool,
    ) -> SceneIrBundleV1 {
        let assets = AssetManifestV1 {
            assets: Vec::new(),
            manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
            manifest_id: "manifest".to_owned(),
            schema: AssetManifestSchemaV1::AssetManifest,
            version: ContractVersionV1,
        };
        let animation_channels = if animate_opacity {
            vec![AnimationChannelV1::Opacity {
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
            }]
        } else {
            Vec::new()
        };
        let required_capabilities = if animate_opacity {
            vec![
                SceneCapabilityV1::OpacityAnimation,
                SceneCapabilityV1::ShapePrimitives,
            ]
        } else {
            vec![SceneCapabilityV1::ShapePrimitives]
        };
        let scene = SceneIrV1 {
            animation_channels,
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
                        fragment_material: None,
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
            required_capabilities,
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

    fn time_gradient_export_bundle() -> SceneIrBundleV1 {
        let mut bundle = export_scene_bundle(RenderCompositingV1::LinearLight, false, false);
        let SceneAppearanceV1::Vector {
            fill: Some(fill), ..
        } = &mut bundle.scene.entities[0].appearance
        else {
            unreachable!()
        };
        fill.fragment_material = Some(FragmentMaterialV1 {
            parameters: vec![1.0, 1.0, 0.0, 0.2],
            revision: crate::TIME_GRADIENT_SHADER_REVISION_V1,
            shader_id: crate::TIME_GRADIENT_SHADER_ID_V1.to_owned(),
        });
        bundle.scene.required_capabilities = vec![
            SceneCapabilityV1::FragmentMaterial,
            SceneCapabilityV1::ShapePrimitives,
        ];
        bundle
    }

    fn sample_scene_packet(
        evaluator: &EngineSessionV1,
        request: &ExportFrameRequestV1,
    ) -> Result<RenderPacketV1, EvaluationError> {
        evaluator.sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: &format!("packet:export-{}", request.frame_index),
            sample_time: request.requested_time,
            viewport: request.viewport.clone(),
        })
    }

    #[test]
    fn uniform_grid_covers_the_full_duration_without_reaching_it() {
        let timeline = ExportFrameTimelineV1::new(2.0, 30)
            .expect("a 2-second grid at 30 fps must be boundable");
        assert_eq!(timeline.frame_count(), 60);
        for index in 0..60_u32 {
            let requested = timeline
                .requested_time(u64::from(index))
                .expect("every grid index must have a requested time");
            assert_eq!(requested.to_bits(), (f64::from(index) / 30.0).to_bits());
            assert!(requested < 2.0);
        }
        assert_eq!(timeline.requested_time(60), None);
    }

    #[test]
    fn off_grid_durations_ceil_to_one_partial_final_frame() {
        let timeline = ExportFrameTimelineV1::new(2.02, 30)
            .expect("an off-grid duration must still be boundable");
        assert_eq!(timeline.frame_count(), 61);
        let last = timeline
            .requested_time(60)
            .expect("the final frame must have a requested time");
        assert_eq!(last.to_bits(), 2.0_f64.to_bits());
        assert!(last < 2.02);
    }

    #[test]
    fn terminal_retention_resolution_belongs_to_state_sample_time() {
        let mut scene = export_scene_bundle(RenderCompositingV1::LinearLight, true, true).scene;
        let timeline = ExportFrameTimelineV1::new(scene.duration, 30)
            .expect("the fixture grid must be boundable");

        // The uniform grid never requests the duration endpoint itself, for
        // retained and non-retained Scenes alike.
        let last_requested = timeline
            .requested_time(timeline.frame_count() - 1)
            .expect("the final frame must have a requested time");
        assert_eq!(last_requested.to_bits(), (59.0_f64 / 30.0).to_bits());
        assert!(last_requested < scene.duration);

        // On-grid instants resolve unchanged under either retention policy.
        assert_eq!(
            scene.state_sample_time(last_requested).to_bits(),
            last_requested.to_bits()
        );
        scene.state_sampling.retains_terminal_state = false;
        assert_eq!(
            scene.state_sample_time(last_requested).to_bits(),
            last_requested.to_bits()
        );

        // Resolving the duration endpoint — for consumers that do request it,
        // such as a scrubber — belongs to the Scene's own sampling rule: a
        // retained Scene resolves to the retained terminal state just below
        // the half-open endpoint, and a frame-rate grid clamps to its final
        // grid frame.
        scene.state_sampling.retains_terminal_state = true;
        let resolved = scene.state_sample_time(scene.duration);
        assert_eq!(
            resolved.to_bits(),
            f64::from_bits(scene.duration.to_bits() - 1).to_bits()
        );
        assert!(resolved < scene.duration);
        scene.state_sampling = SceneStateSamplingV1 {
            frame_rate: Some(30.0),
            retains_terminal_state: true,
        };
        assert_eq!(
            scene.state_sample_time(scene.duration).to_bits(),
            (59.0_f64 / 30.0).to_bits()
        );
    }

    #[test]
    fn rejects_grids_outside_the_export_profile_caps() {
        assert_eq!(
            ExportFrameTimelineV1::new(2.0, 0),
            Err(ExportFrameSequenceParamsErrorV1::FpsOutOfRange { fps: 0 })
        );
        assert_eq!(
            ExportFrameTimelineV1::new(2.0, MAX_EXPORT_FPS_V1 + 1),
            Err(ExportFrameSequenceParamsErrorV1::FpsOutOfRange {
                fps: MAX_EXPORT_FPS_V1 + 1,
            })
        );
        assert!(matches!(
            ExportFrameTimelineV1::new(f64::NAN, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(0.0, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(-1.0, 30),
            Err(ExportFrameSequenceParamsErrorV1::InvalidSceneDuration { .. })
        ));
        assert!(matches!(
            ExportFrameTimelineV1::new(f64::from(MAX_EXPORT_DURATION_SECONDS_V1) + 0.25, 30,),
            Err(ExportFrameSequenceParamsErrorV1::DurationExceedsExportCap { .. })
        ));
        let full = ExportFrameTimelineV1::new(
            f64::from(MAX_EXPORT_DURATION_SECONDS_V1),
            MAX_EXPORT_FPS_V1,
        )
        .expect("the largest export-profile grid must be boundable");
        assert_eq!(full.frame_count(), MAX_EXPORT_FRAME_COUNT_V1);
    }

    #[test]
    fn enforces_export_profile_viewport_caps() {
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
            validate_export_viewport_v1(params(
                MAX_EXPORT_FRAME_WIDTH_PX_V1 + 1,
                MAX_EXPORT_FRAME_HEIGHT_PX_V1,
            )),
            Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange { .. })
        ));
        assert!(matches!(
            validate_export_viewport_v1(params(
                MAX_EXPORT_FRAME_WIDTH_PX_V1,
                MAX_EXPORT_FRAME_HEIGHT_PX_V1 + 1,
            )),
            Err(ExportFrameSequenceParamsErrorV1::ViewportSideOutOfRange { .. })
        ));
        assert_eq!(
            validate_export_viewport_v1(params(
                MAX_EXPORT_FRAME_WIDTH_PX_V1,
                MAX_EXPORT_FRAME_HEIGHT_PX_V1,
            )),
            Ok(())
        );
        assert_eq!(
            validate_export_viewport_v1(params(
                ExportResolutionV1::Sd854x480.width_px(),
                ExportResolutionV1::Sd854x480.height_px(),
            )),
            Ok(())
        );
        assert_eq!(validate_export_viewport_v1(params(160, 90)), Ok(()));
    }

    #[test]
    fn pads_rows_to_the_copy_alignment() {
        assert!(matches!(export_row_bytes_v1(100), Ok((400, 512))));
        assert!(matches!(export_row_bytes_v1(64), Ok((256, 256))));
        assert!(matches!(export_row_bytes_v1(1), Ok((4, 256))));
        assert!(matches!(export_row_bytes_v1(1_920), Ok((7_680, 7_680))));
        assert!(matches!(
            export_row_bytes_v1(u32::MAX),
            Err(ExportFrameErrorV1::ReadbackByteAccountingOverflow)
        ));
    }

    #[test]
    fn readback_signal_resolves_results_and_dropped_senders() {
        let mut context = Context::from_waker(Waker::noop());

        let (sender, mut receiver) = readback_signal_v1();
        assert!(Pin::new(&mut receiver).poll(&mut context).is_pending());
        sender.send(Ok(()));
        assert_eq!(
            Pin::new(&mut receiver).poll(&mut context),
            Poll::Ready(Some(Ok(())))
        );

        let (sender, mut receiver) = readback_signal_v1();
        drop(sender);
        assert_eq!(
            Pin::new(&mut receiver).poll(&mut context),
            Poll::Ready(None)
        );
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

    fn drive<F: Future>(device: &wgpu::Device, future: F) -> F::Output {
        drive_export_blocking_v1(device, future)
            .expect("the export blocking drive must make progress")
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

    fn collect_frames(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bundle: SceneIrBundleV1,
        params: ExportFrameSequenceParamsV1,
    ) -> Vec<(u64, f64, Vec<u8>)> {
        let evaluator = EngineSessionV1::new(bundle).expect("the export fixture must validate");
        let mut session = ExportFrameSequenceSessionV1::new(
            device,
            queue,
            evaluator.scene(),
            params,
            &no_png_assets,
            |request| sample_scene_packet(&evaluator, &request),
        )
        .expect("the export session must accept the fixture parameters");
        let mut frames = Vec::new();
        while let Some(frame) = drive(device, session.next_frame()) {
            let frame = frame.expect("every fixture frame must export");
            frames.push((frame.frame_index, frame.requested_time, frame.rgba.to_vec()));
        }
        assert_eq!(session.next_frame_index(), session.frame_count());
        assert!(
            drive(device, session.next_frame()).is_none(),
            "a completed session must stay finished"
        );
        frames
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn exports_a_linear_light_frame_sequence_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

        let frames = collect_frames(
            &device,
            &queue,
            export_scene_bundle(RenderCompositingV1::LinearLight, true, false),
            EXPORT_PROOF_PARAMS,
        );

        assert_eq!(frames.len(), 10);
        for (index, (frame_index, requested_time, rgba)) in (0..10_u32).zip(&frames) {
            assert_eq!(*frame_index, u64::from(index));
            assert_eq!(requested_time.to_bits(), (f64::from(index) / 5.0).to_bits());
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
    fn exports_time_gradient_frames_through_the_shared_renderer() {
        let (device, queue) = export_gpu_context();
        let frames = collect_frames(
            &device,
            &queue,
            time_gradient_export_bundle(),
            ExportFrameSequenceParamsV1 {
                fps: 4,
                ..EXPORT_PROOF_PARAMS
            },
        );

        assert_eq!(frames.len(), 8);
        assert_eq!(frames[0].1.to_bits(), 0.0_f64.to_bits());
        assert_eq!(frames[1].1.to_bits(), 0.25_f64.to_bits());
        let first_center = pixel(&frames[0].2, 160, 80, 45);
        let later_center = pixel(&frames[1].2, 160, 80, 45);
        assert_ne!(first_center, later_center);
        assert!(first_center[0] > later_center[0]);
        assert_eq!(first_center[1..], [0, 0, 255]);
        assert_eq!(later_center[1..], [0, 0, 255]);
        assert_eq!(pixel(&frames[0].2, 160, 0, 0), [0, 0, 0, 255]);
        assert_eq!(pixel(&frames[1].2, 160, 0, 0), [0, 0, 0, 255]);
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn retained_scenes_share_the_uniform_grid_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let retained = collect_frames(
            &device,
            &queue,
            export_scene_bundle(RenderCompositingV1::LinearLight, true, true),
            EXPORT_PROOF_PARAMS,
        );
        let rolling = collect_frames(
            &device,
            &queue,
            export_scene_bundle(RenderCompositingV1::LinearLight, true, false),
            EXPORT_PROOF_PARAMS,
        );
        // Requested instants stay `i / fps` regardless of terminal retention;
        // with a null Scene frame rate every on-grid instant resolves
        // unchanged, so the exported frames are identical byte-for-byte.
        assert_eq!(retained.len(), rolling.len());
        for (
            (retained_index, retained_time, retained_rgba),
            (rolling_index, rolling_time, rolling_rgba),
        ) in retained.iter().zip(&rolling)
        {
            assert_eq!(retained_index, rolling_index);
            assert_eq!(retained_time.to_bits(), rolling_time.to_bits());
            assert!(*retained_time < 2.0);
            assert_eq!(retained_rgba, rolling_rgba);
        }
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn exports_manim_cairo_frames_through_the_base_unorm_resolve_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let frames = collect_frames(
            &device,
            &queue,
            export_scene_bundle(RenderCompositingV1::ManimCairoSrgb, false, false),
            ExportFrameSequenceParamsV1 {
                fps: 2,
                ..EXPORT_PROOF_PARAMS
            },
        );
        assert_eq!(frames.len(), 4);
        for (_, requested_time, rgba) in &frames {
            assert!(*requested_time < 2.0);
            assert_eq!(rgba.len(), 160 * 90 * 4);
            // The static opaque circle resolves through the four-sample
            // base-Unorm attachment into fully saturated red on black.
            assert_pixel_close(pixel(rgba, 160, 80, 45), [255, 0, 0, 255], [1, 0, 0, 0]);
            assert_eq!(pixel(rgba, 160, 0, 0), [0, 0, 0, 255]);
        }
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn fails_closed_and_fuses_when_the_sampler_mismatches_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let evaluator = EngineSessionV1::new(export_scene_bundle(
            RenderCompositingV1::LinearLight,
            true,
            false,
        ))
        .expect("the export fixture must validate");

        let mut viewport_lie = ExportFrameSequenceSessionV1::new(
            &device,
            &queue,
            evaluator.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request: ExportFrameRequestV1| {
                evaluator.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:viewport-lie",
                    sample_time: request.requested_time,
                    viewport: ViewportV1 {
                        height_px: 45,
                        width_px: 80,
                    },
                })
            },
        )
        .expect("the viewport-lie session must accept the parameters");
        assert!(matches!(
            drive(&device, viewport_lie.next_frame()),
            Some(Err(
                ExportFrameSequenceErrorV1::SampledPacketViewportMismatch { frame_index: 0, .. }
            ))
        ));
        assert!(
            drive(&device, viewport_lie.next_frame()).is_none(),
            "a failed session must fuse instead of yielding partial frames"
        );

        let mut time_lie = ExportFrameSequenceSessionV1::new(
            &device,
            &queue,
            evaluator.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request: ExportFrameRequestV1| {
                evaluator.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:time-lie",
                    sample_time: request.requested_time + 0.125,
                    viewport: request.viewport,
                })
            },
        )
        .expect("the time-lie session must accept the parameters");
        assert!(matches!(
            drive(&device, time_lie.next_frame()),
            Some(Err(ExportFrameSequenceErrorV1::SampledPacketTimeMismatch {
                frame_index: 0,
                ..
            }))
        ));

        let mut sampler_failure = ExportFrameSequenceSessionV1::new(
            &device,
            &queue,
            evaluator.scene(),
            EXPORT_PROOF_PARAMS,
            &no_png_assets,
            |request: ExportFrameRequestV1| {
                evaluator.sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:invalid-viewport",
                    sample_time: request.requested_time,
                    viewport: ViewportV1 {
                        height_px: 0,
                        width_px: 0,
                    },
                })
            },
        )
        .expect("the sampler-failure session must accept the parameters");
        assert!(matches!(
            drive(&device, sampler_failure.next_frame()),
            Some(Err(ExportFrameSequenceErrorV1::Sample {
                frame_index: 0,
                ..
            }))
        ));
        assert!(drive(&device, sampler_failure.next_frame()).is_none());
    }

    #[test]
    #[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
    fn proof_hook_exports_bounded_frames_with_fallback_adapter() {
        let (device, queue) = export_gpu_context();
        let evaluator = EngineSessionV1::new(export_scene_bundle(
            RenderCompositingV1::LinearLight,
            true,
            false,
        ))
        .expect("the export fixture must validate");
        let sampler = |frame_index: u64, requested_time: f64, viewport: ViewportV1| {
            evaluator
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: &format!("packet:proof-{frame_index}"),
                    sample_time: requested_time,
                    viewport,
                })
                .map_err(|error| error.to_string())
        };

        let frames = drive(
            &device,
            prove_export_frame_sequence_readback_v1(
                &device,
                &queue,
                evaluator.scene(),
                160,
                90,
                2,
                sampler,
            ),
        )
        .expect("the proof hook must export the fixture frames");
        assert_eq!(frames.len(), 4);
        for frame in &frames {
            assert_eq!(frame.len(), 160 * 90 * 4);
        }
        assert_eq!(pixel(&frames[0], 160, 80, 45), [0, 0, 0, 255]);
        // t = 1.5 samples opacity 0.75; sRGB-encoding 0.75 linear red yields 225.
        assert_pixel_close(
            pixel(&frames[3], 160, 80, 45),
            [225, 0, 0, 255],
            [2, 0, 0, 0],
        );

        let over_cap = drive(
            &device,
            prove_export_frame_sequence_readback_v1(
                &device,
                &queue,
                evaluator.scene(),
                160,
                90,
                30,
                sampler,
            ),
        );
        let message = over_cap.expect_err("a 60-frame grid must exceed the proof cap");
        assert!(
            message.contains("at most 32"),
            "the proof cap rejection must name its bound: {message}"
        );
    }
}
