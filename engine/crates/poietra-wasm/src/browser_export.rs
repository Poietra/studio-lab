//! One fail-closed browser export composition: Scene IR -> WebGPU frames ->
//! `WebCodecs` H.264 -> progressive MP4.

use std::num::{NonZeroU16, NonZeroU32};

use poietra_eval::{EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1};
use poietra_export_mux::{
    ColorParametersV1, EncodedAudioSampleV1, EncodedSampleV1, ExportMuxConfigV1, ExportMuxErrorV1,
    ExportMuxSessionV1, OPUS_SAMPLE_RATE, OpusParametersV1, VideoParametersV1,
};
use poietra_render_wgpu::{
    ExportFrameRequestV1, ExportFrameSequenceParamsV1, ExportFrameSequenceSessionV1,
};
use poietra_scene_ir::{
    ExportFrameRateV1, ExportProfileV1, export_profile_hash_v1, parse_export_profile_json_v1,
    parse_scene_ir_bundle_json_v1,
};
use wasm_bindgen::prelude::*;

use crate::POIETRA_ENGINE_ABI_VERSION;
use crate::audio_encoder::{FinishedOpusOutput, encode_opus};
use crate::audio_wav::{PcmWav, parse_pcm_wav};
use crate::bounded_writer::BoundedWriter;
use crate::browser_export_protocol::{
    BROWSER_EXPORT_CANCELLED_REASON_V1, BrowserExportProgressV1,
    browser_export_progress_envelope_v1,
};
use crate::canvas_assets::{CanvasPngAssetRegistryV1, copy_asset_byte_arrays};
use crate::export_encoder::{EncoderFailureV1, PoietraExportEncoderSessionV1};
use crate::export_encoder_protocol::{
    ExportEncoderRefusalReasonV1, ExportEncoderSessionConfigV1, H264_CODEC_LADDER_V1,
    frame_duration_microseconds_v1, frame_timestamp_microseconds_v1,
    verify_export_chunk_timestamp_v1,
};
use crate::export_verify::ExportProvenanceV1;
use crate::fragment_material_registry::parse_fragment_material_registry_v1;
use crate::scene_post_effect_registry::parse_scene_post_effect_registry_v1;

const BROWSER_EXPORT_REFUSED_ERROR_NAME: &str = "PoietraBrowserMp4ExportRefused";
const MP4_TIMESCALE_V1: u32 = 1_000_000;

fn refused(reason: &str, message: impl std::fmt::Display) -> JsValue {
    let error = js_sys::Error::new(&format!("{reason}: {message}"));
    error.set_name(BROWSER_EXPORT_REFUSED_ERROR_NAME);
    error.into()
}

fn profile_fps(profile: &ExportProfileV1) -> u32 {
    match profile.frame_rate {
        ExportFrameRateV1::Fps30 => 30,
        ExportFrameRateV1::Fps60 => 60,
    }
}

/// Deterministic H.264 bitrate selected from the closed profile ladder. It is
/// deliberately not a UI setting: resolution and frame rate remain the only
/// profile choices that affect this policy.
fn profile_bitrate(profile: &ExportProfileV1) -> u32 {
    let base = match (
        profile.resolution.width_px(),
        profile.resolution.height_px(),
    ) {
        (854, 480) => 2_000_000,
        (1280, 720) => 4_000_000,
        (1920, 1080) => 8_000_000,
        _ => unreachable!("ExportProfileV1 has a closed resolution ladder"),
    };
    if profile_fps(profile) == 60 {
        base + base / 2
    } else {
        base
    }
}

async fn create_encoder(
    profile: &ExportProfileV1,
) -> Result<PoietraExportEncoderSessionV1, EncoderFailureV1> {
    let mut last_unsupported = None;
    for codec in H264_CODEC_LADDER_V1 {
        let config = ExportEncoderSessionConfigV1 {
            bitrate: profile_bitrate(profile),
            codec: codec.to_owned(),
            frames_per_second: profile_fps(profile),
            height_px: profile.resolution.height_px(),
            width_px: profile.resolution.width_px(),
        };
        match PoietraExportEncoderSessionV1::create_config(config).await {
            Ok(session) => return Ok(session),
            Err(failure) if failure.reason == ExportEncoderRefusalReasonV1::UnsupportedCodec => {
                last_unsupported = Some(failure);
            }
            Err(failure) => return Err(failure),
        }
    }
    Err(last_unsupported.expect("the codec ladder is non-empty"))
}

fn color_parameters(
    evidence: &crate::export_encoder_protocol::ExportEncoderColorSpaceEvidenceV1,
) -> Result<ColorParametersV1, JsValue> {
    let primaries = match evidence.primaries.as_deref() {
        Some("bt709") => 1,
        Some("bt470bg") => 5,
        Some("smpte170m") => 6,
        Some("bt2020") => 9,
        Some("smpte432") => 12,
        _ => return Err(refused_color_evidence(evidence)),
    };
    let transfer = match evidence.transfer.as_deref() {
        Some("bt709") => 1,
        Some("smpte170m") => 6,
        Some("linear") => 8,
        Some("iec61966-2-1") => 13,
        Some("pq") => 16,
        Some("hlg") => 18,
        _ => return Err(refused_color_evidence(evidence)),
    };
    let matrix = match evidence.matrix.as_deref() {
        Some("rgb") => 0,
        Some("bt709") => 1,
        Some("bt470bg") => 5,
        Some("smpte170m") => 6,
        Some("bt2020-ncl") => 9,
        _ => return Err(refused_color_evidence(evidence)),
    };
    let Some(full_range) = evidence.full_range else {
        return Err(refused_color_evidence(evidence));
    };
    Ok(ColorParametersV1 {
        primaries,
        transfer,
        matrix,
        full_range,
    })
}

fn refused_color_evidence(
    evidence: &crate::export_encoder_protocol::ExportEncoderColorSpaceEvidenceV1,
) -> JsValue {
    refused(
        "color-evidence-rejected",
        format!("WebCodecs returned unknown or incomplete color evidence {evidence:?}"),
    )
}

fn mux_error(error: ExportMuxErrorV1) -> JsValue {
    if matches!(error, ExportMuxErrorV1::Io(_)) {
        refused("output-limit-exceeded", error)
    } else {
        refused("mux-failed", error)
    }
}

/// Reports one bounded JSON progress envelope through the optional callback.
///
/// Returning the literal `false` — or throwing — cancels the export
/// fail-closed with the named `cancelled` refusal: everything collected so
/// far is discarded and no bytes ever cross the JavaScript boundary.
fn report_progress(
    progress: Option<&js_sys::Function>,
    report: BrowserExportProgressV1,
) -> Result<(), JsValue> {
    let Some(progress) = progress else {
        return Ok(());
    };
    let envelope = browser_export_progress_envelope_v1(report);
    let payload = js_sys::Uint8Array::from(envelope.as_slice());
    match progress.call1(&JsValue::UNDEFINED, &payload) {
        Ok(value) if value == JsValue::FALSE => Err(refused(
            BROWSER_EXPORT_CANCELLED_REASON_V1,
            format!(
                "the export was cancelled after frame {} of {}",
                report.frames_encoded, report.frame_count
            ),
        )),
        Ok(_) => Ok(()),
        Err(_) => Err(refused(
            BROWSER_EXPORT_CANCELLED_REASON_V1,
            format!(
                "the progress callback threw after frame {} of {}",
                report.frames_encoded, report.frame_count
            ),
        )),
    }
}

/// Exports one validated canonical Scene bundle as a complete MP4 byte array.
///
/// No bytes cross the JavaScript boundary until rendering, encoding and mux
/// finalization have all succeeded. Any stage rejects with a named refusal;
/// there is no renderer, codec or partial-file fallback.
///
/// The optional `progress` callback receives one bounded JSON envelope per
/// encoded frame (`poietra.browser-export-progress`); returning the literal
/// `false` — or throwing — cancels the export fail-closed with the named
/// `cancelled` refusal and discards everything collected.
///
/// # Errors
///
/// Returns a named `PoietraBrowserMp4ExportRefused` JavaScript error when the
/// Scene, assets, GPU, encoder evidence, output bound, or muxing fails, or
/// when the progress callback cancels the export.
#[allow(
    clippy::too_many_lines,
    reason = "the composition stays linear so every fail-closed stage is visible in one place"
)]
#[wasm_bindgen(js_name = exportSceneMp4V1)]
pub async fn export_scene_mp4_v1(
    snapshot_json: &[u8],
    profile_json: &[u8],
    asset_metadata_json: &[u8],
    asset_bytes: &js_sys::Array,
    progress: Option<js_sys::Function>,
    fragment_material_registry_json: &[u8],
    scene_post_effect_registry_json: &[u8],
) -> Result<js_sys::Uint8Array, JsValue> {
    export_scene_mp4(
        snapshot_json,
        profile_json,
        asset_metadata_json,
        asset_bytes,
        fragment_material_registry_json,
        scene_post_effect_registry_json,
        None,
        progress,
    )
    .await
}

/// Exports the same canonical Scene as [`export_scene_mp4_v1`] with one
/// local-only PCM WAV encoded to an Opus MP4 track. Invalid or unsupported
/// WAV input is rejected explicitly; audio is never omitted silently.
///
/// # Errors
///
/// Returns a named `PoietraBrowserMp4ExportRefused` JavaScript error when
/// WAV admission, Opus encoding, rendering, video encoding, or muxing fails.
#[wasm_bindgen(js_name = exportSceneMp4WithWavV1)]
#[allow(
    clippy::too_many_arguments,
    reason = "the stable export ABI carries two independent project shader registries"
)]
pub async fn export_scene_mp4_with_wav_v1(
    snapshot_json: &[u8],
    profile_json: &[u8],
    asset_metadata_json: &[u8],
    asset_bytes: &js_sys::Array,
    wav_bytes: &[u8],
    progress: Option<js_sys::Function>,
    fragment_material_registry_json: &[u8],
    scene_post_effect_registry_json: &[u8],
) -> Result<js_sys::Uint8Array, JsValue> {
    export_scene_mp4(
        snapshot_json,
        profile_json,
        asset_metadata_json,
        asset_bytes,
        fragment_material_registry_json,
        scene_post_effect_registry_json,
        Some(wav_bytes),
        progress,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "the composition stays linear so every fail-closed stage is visible in one place"
)]
async fn export_scene_mp4(
    snapshot_json: &[u8],
    profile_json: &[u8],
    asset_metadata_json: &[u8],
    asset_bytes: &js_sys::Array,
    fragment_material_registry_json: &[u8],
    scene_post_effect_registry_json: &[u8],
    wav_bytes: Option<&[u8]>,
    progress: Option<js_sys::Function>,
) -> Result<js_sys::Uint8Array, JsValue> {
    let wav = wav_bytes
        .map(parse_pcm_wav)
        .transpose()
        .map_err(|error| refused(error.wire_name(), error))?;
    let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)
        .map_err(|error| refused("invalid-scene", error))?;
    let profile = parse_export_profile_json_v1(profile_json)
        .map_err(|error| refused("invalid-profile", error))?;
    if bundle.scene.duration > f64::from(profile.max_duration_seconds) {
        return Err(refused(
            "scene-too-long",
            format!(
                "Scene duration {} exceeds the profile limit of {} seconds",
                bundle.scene.duration, profile.max_duration_seconds
            ),
        ));
    }
    let fragment_materials = parse_fragment_material_registry_v1(fragment_material_registry_json)
        .map_err(|error| refused("invalid-scene", error))?;
    let scene_post_effect_sources =
        parse_scene_post_effect_registry_v1(scene_post_effect_registry_json)
            .map_err(|error| refused("invalid-scene", error))?;

    let transferred =
        copy_asset_byte_arrays(asset_bytes).map_err(|error| refused("asset-rejected", error))?;
    let assets = CanvasPngAssetRegistryV1::default()
        .prepare_candidate(&bundle.assets, asset_metadata_json, &transferred)
        .map_err(|error| refused("asset-rejected", error))?;
    let profile_hash =
        export_profile_hash_v1(&profile).map_err(|error| refused("invalid-profile", error))?;
    let scene_id = bundle.scene.scene_id.clone();
    let scene_revision_hash = bundle.scene.source.revision_hash().to_owned();
    let evaluator =
        EngineSessionV1::new(bundle).map_err(|error| refused("invalid-scene", error))?;

    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(instance_descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|error| refused("gpu-unavailable", error))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("poietra browser MP4 export device"),
            ..wgpu::DeviceDescriptor::default()
        })
        .await
        .map_err(|error| refused("gpu-unavailable", error))?;

    let fps = profile_fps(&profile);
    let mut sequence = ExportFrameSequenceSessionV1::<EvaluationError, _>::new_with_shader_sources(
        &device,
        &queue,
        evaluator.scene(),
        ExportFrameSequenceParamsV1 {
            fps,
            height_px: profile.resolution.height_px(),
            width_px: profile.resolution.width_px(),
        },
        &assets,
        |request: ExportFrameRequestV1| {
            let packet_id = format!("packet:browser-export-{}", request.frame_index);
            // Export sampling fits the camera window to the closed ladder
            // viewport (sub-pixel widening on the 854x480 rung, exactly like
            // the legacy accepted Manim profile); the packet aspect gate
            // itself stays strict for every consumer.
            evaluator.sample_export_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: &packet_id,
                sample_time: request.requested_time,
                viewport: request.viewport,
            })
        },
        &fragment_materials,
        scene_post_effect_sources.as_ref(),
    )
    .await
    .map_err(|error| refused("render-failed", error))?;
    let frame_count = sequence.frame_count();
    let mut video_encoder = create_encoder(&profile).await.map_err(|failure| {
        refused(
            failure.reason.wire_name(),
            format!("WebCodecs encoder refused the export: {}", failure.message),
        )
    })?;

    let mut frames_encoded: u64 = 0;
    while let Some(frame) = sequence.next_frame().await {
        let frame = frame.map_err(|error| refused("render-failed", error))?;
        let timestamp = frame_timestamp_microseconds_v1(frame.frame_index, fps)
            .ok_or_else(|| refused("invalid-timestamp", "frame timestamp overflowed"))?;
        video_encoder
            .push_frame_for_export(frame.rgba.to_vec(), timestamp)
            .await
            .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
        frames_encoded += 1;
        report_progress(
            progress.as_ref(),
            BrowserExportProgressV1 {
                encoded_media_bytes: video_encoder.collected_media_bytes(),
                frame_count,
                frames_encoded,
            },
        )?;
    }
    video_encoder
        .finish_for_export()
        .await
        .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
    // The bounded flush may have waited many seconds; honor a cancellation
    // that arrived meanwhile before any muxing work begins.
    report_progress(
        progress.as_ref(),
        BrowserExportProgressV1 {
            encoded_media_bytes: video_encoder.collected_media_bytes(),
            frame_count,
            frames_encoded,
        },
    )?;
    let encoded_output = video_encoder
        .take_finished_output()
        .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
    let audio_output = encode_audio(wav, frame_count, fps).await?;
    let color = color_parameters(&encoded_output.color_space)?;
    let video_sample_count = u32::try_from(frame_count)
        .map_err(|_| refused("mux-failed", "frame count exceeds the MP4 sample bound"))?;
    let max_sample_count = audio_output
        .as_ref()
        .map_or(Ok(video_sample_count), |audio| {
            u32::try_from(audio.chunks.len())
                .map(|audio_count| video_sample_count.max(audio_count))
                .map_err(|_| {
                    refused(
                        "mux-failed",
                        "audio sample count exceeds the MP4 sample bound",
                    )
                })
        })?;
    let max_sample_count = NonZeroU32::new(max_sample_count)
        .ok_or_else(|| refused("mux-failed", "an empty Scene cannot be exported"))?;
    let provenance = serde_json::to_vec(&ExportProvenanceV1 {
        engine_abi_version: POIETRA_ENGINE_ABI_VERSION,
        export_profile_hash: profile_hash,
        scene_id,
        scene_revision_hash,
    })
    .map_err(|error| refused("mux-failed", error))?;
    let output_limit = usize::try_from(profile.max_output_bytes)
        .map_err(|_| refused("invalid-profile", "maxOutputBytes is not addressable"))?;
    let width_px = u16::try_from(profile.resolution.width_px())
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or_else(|| refused("invalid-profile", "resolution width is not a non-zero u16"))?;
    let height_px = u16::try_from(profile.resolution.height_px())
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or_else(|| refused("invalid-profile", "resolution height is not a non-zero u16"))?;
    let timescale = NonZeroU32::new(MP4_TIMESCALE_V1)
        .ok_or_else(|| refused("mux-failed", "MP4 timescale is zero"))?;
    let frames_per_second =
        NonZeroU32::new(fps).ok_or_else(|| refused("invalid-profile", "frame rate is zero"))?;
    let sink = BoundedWriter::new(output_limit);
    let mux_config = ExportMuxConfigV1 {
        decoder_configuration: encoded_output.decoder_configuration,
        video: VideoParametersV1 {
            width_px,
            height_px,
            timescale,
            frames_per_second,
        },
        color,
        provenance,
        max_sample_count,
    };
    let mut mux = match audio_output.as_ref() {
        Some(audio) => ExportMuxSessionV1::begin_with_opus(
            mux_config,
            OpusParametersV1 {
                channels: audio.channels,
                sample_rate: OPUS_SAMPLE_RATE,
                pre_skip: audio.pre_skip,
                output_gain: audio.output_gain,
                channel_mapping_family: audio.channel_mapping_family,
            },
            sink,
        ),
        None => ExportMuxSessionV1::begin(mux_config, sink),
    }
    .map_err(mux_error)?;
    let mut previous_timestamp_microseconds = None;
    for (index, chunk) in encoded_output.chunks.iter().enumerate() {
        let frame_index =
            u64::try_from(index).map_err(|_| refused("mux-failed", "sample index overflowed"))?;
        // The proven AVC configuration's *output* timestamps are asserted —
        // strictly monotonic and exactly on the canonical grid — rather than
        // trusted to echo the submitted frames (PR #730 review requirement).
        verify_export_chunk_timestamp_v1(
            frame_index,
            chunk.timestamp_microseconds,
            previous_timestamp_microseconds,
            fps,
        )
        .map_err(|violation| refused(violation.refusal_wire_name(), violation))?;
        previous_timestamp_microseconds = Some(chunk.timestamp_microseconds);
        let duration = chunk.duration_microseconds.unwrap_or_else(|| {
            frame_duration_microseconds_v1(frame_index, fps).unwrap_or_default()
        });
        mux.append_sample(EncodedSampleV1 {
            bytes: &chunk.bytes,
            timestamp_us: chunk.timestamp_microseconds,
            duration_us: duration,
            is_key: chunk.key_frame,
        })
        .map_err(mux_error)?;
    }
    if let Some(audio) = audio_output {
        for chunk in audio.chunks {
            mux.append_audio_sample(EncodedAudioSampleV1 {
                bytes: &chunk.bytes,
                duration_samples: chunk.duration_samples,
            })
            .map_err(mux_error)?;
        }
    }
    let sink = mux.finish().map_err(mux_error)?;
    Ok(js_sys::Uint8Array::from(sink.into_bytes().as_slice()))
}

async fn encode_audio(
    wav: Option<PcmWav>,
    frame_count: u64,
    frames_per_second: u32,
) -> Result<Option<FinishedOpusOutput>, JsValue> {
    let Some(wav) = wav else {
        return Ok(None);
    };
    let pcm = wav
        .fit_to_video(frame_count, frames_per_second)
        .map_err(|error| refused(error.wire_name(), error))?;
    encode_opus(&pcm)
        .await
        .map(Some)
        .map_err(|failure| refused(failure.reason.wire_name(), failure.message))
}
