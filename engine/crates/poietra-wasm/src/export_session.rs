//! Composed browser MP4 export session (#722).
//!
//! One retained, validated Scene plus one canonical [`ExportProfileV1`] drives
//! the offscreen async frame sequence ([`ExportFrameSequenceSessionV1`]) into
//! the hand-owned `WebCodecs` H.264 encoder and streams every encoded chunk —
//! as encoder output arrives — into the progressive MP4 muxer
//! (`poietra-export-mux`) over an in-memory sink bounded by the profile's
//! declared output byte bound.
//!
//! The session is a parallel export entry: it never touches the interactive
//! canvas engine or its surface. It acquires its own surface-free WebGPU
//! device, owns a dedicated encoder, and returns the finalized MP4 to
//! JavaScript as exactly one `Uint8Array` transfer. Progress and refusals
//! travel through the bounded JSON envelope of `export_session_protocol`;
//! bytes never travel through JSON. Every failure — including cancellation
//! through the progress callback — discards all collected output and reports
//! one named reason; no partial file can ever be observed.
//!
//! Timestamp truth (PR #730 review requirement): chunk timestamps from the
//! proven AVC configuration are asserted strictly monotonic AND exactly on
//! the canonical `floor(i * 1_000_000 / fps)` grid before muxing; any
//! violation fails the whole session closed by name.

use std::cell::Cell;
use std::fmt;
use std::io::Write;
use std::num::{NonZeroU16, NonZeroU32};
use std::rc::Rc;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_export_mux::{
    ColorParametersV1, EncodedSampleV1, ExportMuxConfigV1, ExportMuxErrorV1, ExportMuxSessionV1,
    VideoParametersV1,
};
use poietra_render_wgpu::{
    ExportFrameRequestV1, ExportFrameSequenceParamsV1, ExportFrameSequenceSessionV1,
};
use poietra_scene_ir::{
    ExportProfileV1, export_profile_hash_v1, parse_export_profile_json_v1,
    parse_scene_ir_bundle_json_v1,
};
use wasm_bindgen::prelude::*;

use crate::canvas_assets::CanvasPngAssetRegistryV1;
use crate::export_encoder::{
    CollectedChunkV1, EncoderFailureV1, EncoderHarnessV1, build_encoder_config,
    collected_decoder_config_v1, prove_encoder_config, read_encoder_failure, rgba_video_frame,
    take_collected_chunks_v1, video_encoder_constructor_available,
};
use crate::export_encoder_protocol::{
    EXPORT_ENCODER_FLUSH_TIMEOUT_MILLISECONDS_V1, ExportEncoderSessionConfigV1,
    H264_CODEC_LADDER_V1, frame_duration_microseconds_v1, frame_timestamp_microseconds_v1,
    key_frame_required_v1,
};
use crate::export_session_protocol::{
    ExportSessionColorEvidenceV1, ExportSessionFailureV1, ExportSessionRefusalReasonV1,
    ExportSessionResultV1, export_provenance_payload_v1, export_session_bitrate_v1,
    export_session_refusal_result, export_session_response, resolve_export_colr_v1,
};

const EXPORT_SESSION_REFUSED_ERROR_NAME: &str = "PoietraExportSessionRefused";

/// Media timescale for the muxed track: microsecond timestamps stay exact.
const EXPORT_MUX_TIMESCALE_HZ_V1: u32 = 1_000_000;

/// Rejection carrying `PoietraExportSessionRefused` as its `name` and the
/// stable refusal wire name as its message prefix.
fn refused_session_js_error(failure: &ExportSessionFailureV1) -> JsValue {
    let error = js_sys::Error::new(&format!(
        "{}: {}",
        failure.reason.wire_name(),
        failure.message
    ));
    error.set_name(EXPORT_SESSION_REFUSED_ERROR_NAME);
    error.into()
}

impl From<EncoderFailureV1> for ExportSessionFailureV1 {
    fn from(failure: EncoderFailureV1) -> Self {
        Self::new(failure.reason.into(), failure.message)
    }
}

/// Forward-only in-memory mux sink that fails every write which would push
/// the buffer past the profile's declared output byte bound. The shared flag
/// lets the session name the refusal precisely after the muxer surfaces the
/// rejected write as an I/O error.
#[derive(Debug)]
struct BoundedExportSinkV1 {
    buffer: Vec<u8>,
    exceeded: Rc<Cell<bool>>,
    max_output_bytes: u64,
}

impl Write for BoundedExportSinkV1 {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let next_length = u64::try_from(self.buffer.len())
            .ok()
            .and_then(|length| length.checked_add(u64::try_from(data.len()).ok()?));
        match next_length {
            Some(length) if length <= self.max_output_bytes => {
                self.buffer.extend_from_slice(data);
                Ok(data.len())
            }
            _ => {
                self.exceeded.set(true);
                Err(std::io::Error::other(
                    "the muxed output exceeds the profile's declared byte bound",
                ))
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn mux_failure(error: &ExportMuxErrorV1, output_bound_exceeded: bool) -> ExportSessionFailureV1 {
    let reason = match error {
        ExportMuxErrorV1::Io(_) if output_bound_exceeded => {
            ExportSessionRefusalReasonV1::OutputTooLarge
        }
        ExportMuxErrorV1::NonMonotonicTimestamp { .. }
        | ExportMuxErrorV1::TimestampTickCollision { .. } => {
            ExportSessionRefusalReasonV1::NonMonotonicChunkTimestamps
        }
        ExportMuxErrorV1::FirstSampleNotKey => ExportSessionRefusalReasonV1::NoKeyFrame,
        _ => ExportSessionRefusalReasonV1::MuxFailed,
    };
    ExportSessionFailureV1::new(reason, error.to_string())
}

/// Everything the run loop accumulates while chunks stream into the muxer.
struct MuxDriveStateV1 {
    chunks_muxed: u64,
    color: Option<ExportSessionColorEvidenceV1>,
    key_frame_count: u64,
    last_muxed_timestamp_microseconds: Option<u64>,
    mux: Option<ExportMuxSessionV1<BoundedExportSinkV1>>,
    muxed_media_bytes: u64,
    output_bound_exceeded: Rc<Cell<bool>>,
}

#[derive(Debug)]
enum ExportSessionStateV1 {
    Ready,
    Running,
    Failed(ExportSessionFailureV1),
    Finished { output: Vec<u8> },
}

/// One composed browser MP4 export session owned by a dedicated worker.
///
/// [`Self::create`] validates the Scene bundle, assets, and export profile,
/// acquires a surface-free WebGPU device, and proves one exact H.264 ladder
/// configuration with a real two-frame encode. [`Self::run`] then drives the
/// whole export to completion, reporting bounded JSON progress through an
/// optional callback whose literal `false` return cancels fail-closed. The
/// finalized MP4 is read once via [`Self::output_bytes`].
#[wasm_bindgen]
pub struct PoietraExportSessionV1 {
    assets: CanvasPngAssetRegistryV1,
    codec: String,
    device: wgpu::Device,
    encoder_config: js_sys::Object,
    evaluator: EngineSessionV1,
    export_profile_hash: String,
    profile: ExportProfileV1,
    provenance: Vec<u8>,
    queue: wgpu::Queue,
    scene_revision_hash: String,
    state: ExportSessionStateV1,
}

impl fmt::Debug for PoietraExportSessionV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PoietraExportSessionV1")
            .field("codec", &self.codec)
            .field("profile", &self.profile)
            .field("scene_revision_hash", &self.scene_revision_hash)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

async fn acquire_export_gpu(device_label: &str) -> Result<(wgpu::Device, wgpu::Queue), String> {
    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(instance_descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|error| format!("no WebGPU adapter for offscreen export: {error}"))?;
    adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some(device_label),
            ..wgpu::DeviceDescriptor::default()
        })
        .await
        .map_err(|error| format!("could not create the export WebGPU device: {error}"))
}

/// Proves the exact requested configuration against the closed H.264 ladder
/// and returns the first codec string that passes the full two-frame proof.
async fn prove_ladder_codec(
    width_px: u32,
    height_px: u32,
    frames_per_second: u32,
    bitrate: u32,
) -> Result<(String, js_sys::Object), ExportSessionFailureV1> {
    let mut attempts = Vec::with_capacity(H264_CODEC_LADDER_V1.len());
    let mut last_reason = ExportSessionRefusalReasonV1::UnsupportedCodec;
    for codec in H264_CODEC_LADDER_V1 {
        let config = ExportEncoderSessionConfigV1 {
            bitrate,
            codec: codec.to_owned(),
            frames_per_second,
            height_px,
            width_px,
        };
        let encoder_config =
            build_encoder_config(codec, width_px, height_px, bitrate, frames_per_second)
                .map_err(ExportSessionFailureV1::from)?;
        match prove_encoder_config(&config, &encoder_config).await {
            Ok(()) => return Ok((codec.to_owned(), encoder_config)),
            Err(failure) => {
                attempts.push(format!(
                    "{codec}: {} ({})",
                    failure.message,
                    failure.reason.wire_name()
                ));
                last_reason = failure.reason.into();
            }
        }
    }
    Err(ExportSessionFailureV1::new(
        last_reason,
        attempts.join("; "),
    ))
}

#[wasm_bindgen]
impl PoietraExportSessionV1 {
    /// Validates one complete Scene bundle (with its PNG asset transfer) and
    /// one canonical `ExportProfileV1`, acquires a surface-free WebGPU
    /// device, and proves one exact H.264 ladder configuration with a real
    /// two-frame encode before any session exists.
    ///
    /// # Errors
    ///
    /// Rejects with a JavaScript `Error` named `PoietraExportSessionRefused`
    /// whose message starts with the stable refusal wire name.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        snapshot_json: &[u8],
        asset_metadata_json: &[u8],
        asset_bytes: js_sys::Array,
        profile_json: &[u8],
    ) -> Result<PoietraExportSessionV1, JsValue> {
        Self::create_admitted(
            snapshot_json,
            asset_metadata_json,
            &asset_bytes,
            profile_json,
        )
        .await
        .map_err(|failure| refused_session_js_error(&failure))
    }

    /// Drives the complete export: offscreen frame sequence → encoder →
    /// muxer, chunk-by-chunk as encoder output arrives. The optional
    /// `progress` callback receives one bounded JSON envelope per exported
    /// frame; returning the literal `false` cancels the session fail-closed.
    ///
    /// The bounded JSON response reports the finished evidence — including
    /// which authority supplied the `colr` values — or one named refusal.
    /// On any failure every collected byte is discarded.
    #[wasm_bindgen(js_name = run)]
    pub async fn run(&mut self, progress: Option<js_sys::Function>) -> Vec<u8> {
        match self.state {
            ExportSessionStateV1::Ready => {}
            ExportSessionStateV1::Running => {
                return export_session_response(export_session_refusal_result(
                    &ExportSessionFailureV1::new(
                        ExportSessionRefusalReasonV1::SessionClosed,
                        "the session is already running",
                    ),
                ));
            }
            ExportSessionStateV1::Failed(ref failure) => {
                return export_session_response(export_session_refusal_result(failure));
            }
            ExportSessionStateV1::Finished { .. } => {
                return export_session_response(export_session_refusal_result(
                    &ExportSessionFailureV1::new(
                        ExportSessionRefusalReasonV1::SessionClosed,
                        "the session already finished",
                    ),
                ));
            }
        }
        self.state = ExportSessionStateV1::Running;
        match self.run_export(progress.as_ref()).await {
            Ok((output, result)) => {
                self.state = ExportSessionStateV1::Finished { output };
                export_session_response(result)
            }
            Err(failure) => {
                let refusal = export_session_refusal_result(&failure);
                self.state = ExportSessionStateV1::Failed(failure);
                export_session_response(refusal)
            }
        }
    }

    /// Returns the finalized MP4 bytes of a successfully finished run as one
    /// fresh `Uint8Array`. Bytes never travel through the JSON envelope.
    ///
    /// # Errors
    ///
    /// Rejects with a `PoietraExportSessionRefused` error when the session
    /// has not finished successfully.
    #[wasm_bindgen(js_name = outputBytes)]
    pub fn output_bytes(&self) -> Result<js_sys::Uint8Array, JsValue> {
        match &self.state {
            ExportSessionStateV1::Finished { output } => {
                Ok(js_sys::Uint8Array::from(output.as_slice()))
            }
            ExportSessionStateV1::Failed(failure) => Err(refused_session_js_error(failure)),
            ExportSessionStateV1::Ready | ExportSessionStateV1::Running => {
                Err(refused_session_js_error(&ExportSessionFailureV1::new(
                    ExportSessionRefusalReasonV1::InvalidRequest,
                    "output bytes are only readable after a successful run",
                )))
            }
        }
    }
}

impl PoietraExportSessionV1 {
    async fn create_admitted(
        snapshot_json: &[u8],
        asset_metadata_json: &[u8],
        asset_bytes: &js_sys::Array,
        profile_json: &[u8],
    ) -> Result<Self, ExportSessionFailureV1> {
        let profile = parse_export_profile_json_v1(profile_json).map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidProfile,
                error.to_string(),
            )
        })?;
        let bundle = parse_scene_ir_bundle_json_v1(snapshot_json).map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidSnapshot,
                error.to_string(),
            )
        })?;
        let copied_asset_bytes =
            crate::canvas::copy_asset_byte_arrays(asset_bytes).map_err(|error| {
                ExportSessionFailureV1::new(ExportSessionRefusalReasonV1::InvalidSnapshot, error)
            })?;
        let assets = CanvasPngAssetRegistryV1::default()
            .prepare_candidate(&bundle.assets, asset_metadata_json, &copied_asset_bytes)
            .map_err(|error| {
                ExportSessionFailureV1::new(
                    ExportSessionRefusalReasonV1::InvalidSnapshot,
                    error.to_string(),
                )
            })?;
        let evaluator = EngineSessionV1::new(bundle).map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidSnapshot,
                error.to_string(),
            )
        })?;
        let scene_duration = evaluator.scene().duration;
        if scene_duration > f64::from(profile.max_duration_seconds) {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::DurationExceeded,
                format!(
                    "the validated Scene runs {scene_duration} seconds; the profile declares at most {}",
                    profile.max_duration_seconds
                ),
            ));
        }
        let scene_revision_hash = evaluator.scene().source.revision_hash().to_owned();
        let export_profile_hash = export_profile_hash_v1(&profile).map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidProfile,
                format!("could not canonicalize the export profile: {error}"),
            )
        })?;
        let provenance = export_provenance_payload_v1(&scene_revision_hash, &export_profile_hash)
            .map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::SerializationFailed,
                format!("could not serialize the provenance payload: {error}"),
            )
        })?;

        if !video_encoder_constructor_available() {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::ApiUnavailable,
                "VideoEncoder is unavailable in this scope",
            ));
        }
        let (device, queue) = acquire_export_gpu("poietra export session device v1")
            .await
            .map_err(|error| {
                ExportSessionFailureV1::new(ExportSessionRefusalReasonV1::GpuUnavailable, error)
            })?;

        let width_px = profile.resolution.width_px();
        let height_px = profile.resolution.height_px();
        let frames_per_second = frames_per_second_u32(&profile);
        let bitrate = export_session_bitrate_v1(profile.resolution, profile.frame_rate);
        let (codec, encoder_config) =
            prove_ladder_codec(width_px, height_px, frames_per_second, bitrate).await?;

        Ok(Self {
            assets,
            codec,
            device,
            encoder_config,
            evaluator,
            export_profile_hash,
            profile,
            provenance,
            queue,
            scene_revision_hash,
            state: ExportSessionStateV1::Ready,
        })
    }

    /// Streams every chunk collected so far into the muxer, asserting the
    /// timestamp truth of the proven AVC configuration chunk by chunk.
    fn drain_chunks_into_mux(
        &self,
        harness: &EncoderHarnessV1,
        drive: &mut MuxDriveStateV1,
        frame_count: u64,
        frames_per_second: u32,
    ) -> Result<(), ExportSessionFailureV1> {
        for chunk in take_collected_chunks_v1(&harness.shared) {
            if drive.mux.is_none() {
                self.begin_mux(harness, drive, &chunk, frame_count)?;
            }
            append_chunk(drive, &chunk, frames_per_second)?;
        }
        Ok(())
    }

    fn begin_mux(
        &self,
        harness: &EncoderHarnessV1,
        drive: &mut MuxDriveStateV1,
        first_chunk: &CollectedChunkV1,
        frame_count: u64,
    ) -> Result<(), ExportSessionFailureV1> {
        if !first_chunk.key_frame {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NoKeyFrame,
                "the first encoded chunk was not a key frame",
            ));
        }
        let decoder_config = collected_decoder_config_v1(&harness.shared).ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NoDecoderConfig,
                "the first chunk metadata carried no decoderConfig.description",
            )
        })?;
        let color = resolve_export_colr_v1(&decoder_config.color_space).map_err(|detail| {
            ExportSessionFailureV1::new(ExportSessionRefusalReasonV1::ColorUnrepresentable, detail)
        })?;
        let video = VideoParametersV1 {
            width_px: mux_dimension(self.profile.resolution.width_px())?,
            height_px: mux_dimension(self.profile.resolution.height_px())?,
            timescale: NonZeroU32::new(EXPORT_MUX_TIMESCALE_HZ_V1).ok_or_else(|| {
                ExportSessionFailureV1::new(
                    ExportSessionRefusalReasonV1::MuxFailed,
                    "the export timescale constant is zero",
                )
            })?,
            frames_per_second: NonZeroU32::new(frames_per_second_u32(&self.profile)).ok_or_else(
                || {
                    ExportSessionFailureV1::new(
                        ExportSessionRefusalReasonV1::MuxFailed,
                        "the profile frame rate is zero",
                    )
                },
            )?,
        };
        let max_sample_count = u32::try_from(frame_count)
            .ok()
            .and_then(NonZeroU32::new)
            .ok_or_else(|| {
                ExportSessionFailureV1::new(
                    ExportSessionRefusalReasonV1::MuxFailed,
                    format!("the {frame_count}-frame grid is outside the mux sample bound"),
                )
            })?;
        let sink = BoundedExportSinkV1 {
            buffer: Vec::new(),
            exceeded: Rc::clone(&drive.output_bound_exceeded),
            max_output_bytes: self.profile.max_output_bytes,
        };
        let mux = ExportMuxSessionV1::begin(
            ExportMuxConfigV1 {
                decoder_configuration: decoder_config.description,
                video,
                color: ColorParametersV1 {
                    primaries: color.primaries,
                    transfer: color.transfer,
                    matrix: color.matrix,
                    full_range: color.full_range,
                },
                provenance: self.provenance.clone(),
                max_sample_count,
            },
            sink,
        )
        .map_err(|error| mux_failure(&error, drive.output_bound_exceeded.get()))?;
        drive.color = Some(color);
        drive.mux = Some(mux);
        Ok(())
    }

    async fn run_export(
        &self,
        progress: Option<&js_sys::Function>,
    ) -> Result<(Vec<u8>, ExportSessionResultV1), ExportSessionFailureV1> {
        let width_px = self.profile.resolution.width_px();
        let height_px = self.profile.resolution.height_px();
        let frames_per_second = frames_per_second_u32(&self.profile);

        let harness =
            EncoderHarnessV1::create(&self.encoder_config).map_err(ExportSessionFailureV1::from)?;
        let outcome = self
            .drive_frames(&harness, progress, width_px, height_px, frames_per_second)
            .await;
        // The harness closes on drop, but close before surfacing the outcome
        // so no callback can fire into a session that already failed.
        if outcome.is_err() {
            harness.close_quietly();
        }
        outcome
    }

    async fn drive_frames(
        &self,
        harness: &EncoderHarnessV1,
        progress: Option<&js_sys::Function>,
        width_px: u32,
        height_px: u32,
        frames_per_second: u32,
    ) -> Result<(Vec<u8>, ExportSessionResultV1), ExportSessionFailureV1> {
        let mut frame_session = ExportFrameSequenceSessionV1::new(
            &self.device,
            &self.queue,
            self.evaluator.scene(),
            ExportFrameSequenceParamsV1 {
                fps: frames_per_second,
                height_px,
                width_px,
            },
            &self.assets,
            |request: ExportFrameRequestV1| {
                // Export sampling fits the camera window to the closed ladder
                // viewport (sub-pixel widening on the 854x480 rung), exactly
                // like the legacy accepted server profile.
                self.evaluator
                    .sample_export_render_packet(SampleEngineSessionOptionsV1 {
                        evidence: &[],
                        packet_id: &format!("packet:export-{}", request.frame_index),
                        sample_time: request.requested_time,
                        viewport: request.viewport,
                    })
            },
        )
        .map_err(|error| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::RenderFailed,
                error.to_string(),
            )
        })?;
        let frame_count = frame_session.frame_count();

        let mut drive = MuxDriveStateV1 {
            chunks_muxed: 0,
            color: None,
            key_frame_count: 0,
            last_muxed_timestamp_microseconds: None,
            mux: None,
            muxed_media_bytes: 0,
            output_bound_exceeded: Rc::new(Cell::new(false)),
        };
        let mut frames_encoded: u64 = 0;
        let mut last_key_frame_timestamp: Option<u64> = None;

        loop {
            let (frame_index, rgba) = match frame_session.next_frame().await {
                None => break,
                Some(Err(error)) => {
                    return Err(ExportSessionFailureV1::new(
                        ExportSessionRefusalReasonV1::RenderFailed,
                        error.to_string(),
                    ));
                }
                Some(Ok(frame)) => (frame.frame_index, frame.rgba.to_vec()),
            };
            encode_export_frame(
                harness,
                rgba,
                frame_index,
                ExportFrameGeometryV1 {
                    frames_per_second,
                    height_px,
                    width_px,
                },
                &mut last_key_frame_timestamp,
            )
            .await?;
            frames_encoded += 1;
            self.drain_chunks_into_mux(harness, &mut drive, frame_count, frames_per_second)?;
            report_progress(progress, &drive, frame_count, frames_encoded)?;
        }

        if frames_encoded != frame_count {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::RenderFailed,
                format!("the frame sequence yielded {frames_encoded} of {frame_count} frames"),
            ));
        }
        harness
            .flush_bounded(EXPORT_ENCODER_FLUSH_TIMEOUT_MILLISECONDS_V1)
            .await
            .map_err(ExportSessionFailureV1::from)?;
        if let Some(failure) = read_encoder_failure(&harness.shared) {
            return Err(failure.into());
        }
        self.drain_chunks_into_mux(harness, &mut drive, frame_count, frames_per_second)?;
        self.settle_finished_export(drive, frame_count)
    }

    /// Verifies the settled chunk accounting and finalizes the container.
    fn settle_finished_export(
        &self,
        mut drive: MuxDriveStateV1,
        frame_count: u64,
    ) -> Result<(Vec<u8>, ExportSessionResultV1), ExportSessionFailureV1> {
        if drive.chunks_muxed != frame_count {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::ChunkCountMismatch,
                format!(
                    "the encoder settled with {} chunks for the {frame_count}-frame grid",
                    drive.chunks_muxed
                ),
            ));
        }
        let mux = drive.mux.take().ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NoChunk,
                "no chunk ever reached the muxer",
            )
        })?;
        let color = drive.color.ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NoDecoderConfig,
                "the mux session retained no colour evidence",
            )
        })?;
        let sink = mux
            .finish()
            .map_err(|error| mux_failure(&error, drive.output_bound_exceeded.get()))?;
        let output = sink.buffer;
        let result = ExportSessionResultV1::Finished {
            chunk_count: drive.chunks_muxed,
            codec: self.codec.clone(),
            color,
            export_profile_hash: self.export_profile_hash.clone(),
            frame_count,
            key_frame_count: drive.key_frame_count,
            output_byte_length: u64::try_from(output.len()).unwrap_or(u64::MAX),
            scene_revision_hash: self.scene_revision_hash.clone(),
        };
        Ok((output, result))
    }
}

/// Closed per-frame geometry handed to the encode step.
#[derive(Clone, Copy, Debug)]
struct ExportFrameGeometryV1 {
    frames_per_second: u32,
    height_px: u32,
    width_px: u32,
}

/// Encodes one exported tight-RGBA frame at its canonical grid timestamp,
/// waiting for encoder queue capacity first and applying the key-frame
/// cadence.
async fn encode_export_frame(
    harness: &EncoderHarnessV1,
    mut rgba: Vec<u8>,
    frame_index: u64,
    geometry: ExportFrameGeometryV1,
    last_key_frame_timestamp: &mut Option<u64>,
) -> Result<(), ExportSessionFailureV1> {
    let timestamp = frame_timestamp_microseconds_v1(frame_index, geometry.frames_per_second)
        .ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidFrame,
                "the frame timestamp left the JavaScript-safe microsecond range",
            )
        })?;
    let duration = frame_duration_microseconds_v1(frame_index, geometry.frames_per_second)
        .ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::InvalidFrame,
                "the frame duration left the JavaScript-safe microsecond range",
            )
        })?;
    harness
        .await_enqueue_capacity()
        .await
        .map_err(ExportSessionFailureV1::from)?;
    let key_frame = key_frame_required_v1(*last_key_frame_timestamp, timestamp);
    let video_frame = rgba_video_frame(
        &mut rgba,
        geometry.width_px,
        geometry.height_px,
        timestamp,
        duration,
    )
    .map_err(ExportSessionFailureV1::from)?;
    harness
        .encode_and_close_frame(&video_frame, key_frame)
        .map_err(|failure| ExportSessionFailureV1::from(harness.prefer_shared_failure(failure)))?;
    if key_frame {
        *last_key_frame_timestamp = Some(timestamp);
    }
    Ok(())
}

/// Asserts the timestamp truth of one encoded chunk and appends it to the
/// container.
fn append_chunk(
    drive: &mut MuxDriveStateV1,
    chunk: &CollectedChunkV1,
    frames_per_second: u32,
) -> Result<(), ExportSessionFailureV1> {
    let timestamp = chunk.timestamp_microseconds;
    if let Some(last) = drive.last_muxed_timestamp_microseconds {
        if timestamp <= last {
            return Err(ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NonMonotonicChunkTimestamps,
                format!(
                    "the proven AVC configuration emitted chunk {} at {timestamp} us after {last} us",
                    drive.chunks_muxed
                ),
            ));
        }
    }
    let expected = frame_timestamp_microseconds_v1(drive.chunks_muxed, frames_per_second)
        .ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::ChunkTimestampMismatch,
                "the canonical chunk timestamp left the JavaScript-safe range",
            )
        })?;
    if timestamp != expected {
        return Err(ExportSessionFailureV1::new(
            ExportSessionRefusalReasonV1::ChunkTimestampMismatch,
            format!(
                "chunk {} reported {timestamp} us instead of the canonical {expected} us",
                drive.chunks_muxed
            ),
        ));
    }
    let mux = drive.mux.as_mut().ok_or_else(|| {
        ExportSessionFailureV1::new(
            ExportSessionRefusalReasonV1::MuxFailed,
            "a chunk arrived before the mux session began",
        )
    })?;
    mux.append_sample(EncodedSampleV1 {
        bytes: &chunk.bytes,
        timestamp_us: timestamp,
        duration_us: chunk.duration_microseconds.unwrap_or(0),
        is_key: chunk.key_frame,
    })
    .map_err(|error| mux_failure(&error, drive.output_bound_exceeded.get()))?;
    drive.chunks_muxed += 1;
    drive.last_muxed_timestamp_microseconds = Some(timestamp);
    drive.muxed_media_bytes = drive
        .muxed_media_bytes
        .saturating_add(u64::try_from(chunk.bytes.len()).unwrap_or(u64::MAX));
    if chunk.key_frame {
        drive.key_frame_count += 1;
    }
    Ok(())
}

/// Calls the progress callback with one bounded JSON envelope; a literal
/// `false` return — or a callback that throws — cancels the session.
fn report_progress(
    progress: Option<&js_sys::Function>,
    drive: &MuxDriveStateV1,
    frame_count: u64,
    frames_encoded: u64,
) -> Result<(), ExportSessionFailureV1> {
    let Some(progress) = progress else {
        return Ok(());
    };
    let envelope = export_session_response(ExportSessionResultV1::Progress {
        chunks_muxed: drive.chunks_muxed,
        frame_count,
        frames_encoded,
        muxed_media_bytes: drive.muxed_media_bytes,
    });
    let payload = js_sys::Uint8Array::from(envelope.as_slice());
    match progress.call1(&JsValue::UNDEFINED, &payload) {
        Ok(value) if value == JsValue::FALSE => Err(ExportSessionFailureV1::new(
            ExportSessionRefusalReasonV1::Cancelled,
            format!("the progress callback cancelled after frame {frames_encoded}"),
        )),
        Ok(_) => Ok(()),
        Err(_) => Err(ExportSessionFailureV1::new(
            ExportSessionRefusalReasonV1::Cancelled,
            format!("the progress callback threw after frame {frames_encoded}"),
        )),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the closed ExportFrameRateV1 values are the integers 30 and 60"
)]
fn frames_per_second_u32(profile: &ExportProfileV1) -> u32 {
    profile.frame_rate.frames_per_second() as u32
}

fn mux_dimension(pixels: u32) -> Result<NonZeroU16, ExportSessionFailureV1> {
    u16::try_from(pixels)
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or_else(|| {
            ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::MuxFailed,
                format!("the {pixels}px export dimension is outside the mux track range"),
            )
        })
}
