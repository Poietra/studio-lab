//! One fail-closed browser export composition: Scene IR -> WebGPU frames ->
//! `WebCodecs` H.264 -> progressive MP4.

use std::num::{NonZeroU16, NonZeroU32};

use poietra_eval::{EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1};
use poietra_export_mux::{
    ColorParametersV1, EncodedSampleV1, ExportMuxConfigV1, ExportMuxErrorV1, ExportMuxSessionV1,
    VideoParametersV1,
};
use poietra_render_wgpu::{
    ExportFrameRequestV1, ExportFrameSequenceParamsV1, ExportFrameSequenceSessionV1,
};
use poietra_scene_ir::{
    ExportFrameRateV1, ExportProfileV1, export_profile_hash_v1, parse_export_profile_json_v1,
    parse_scene_ir_bundle_json_v1,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::POIETRA_ENGINE_ABI_VERSION;
use crate::bounded_writer::BoundedWriter;
use crate::canvas_assets::{CanvasPngAssetRegistryV1, copy_asset_byte_arrays};
use crate::export_encoder::{EncoderFailureV1, PoietraExportEncoderSessionV1};
use crate::export_encoder_protocol::{
    ExportEncoderRefusalReasonV1, ExportEncoderSessionConfigV1, H264_CODEC_LADDER_V1,
    frame_duration_microseconds_v1, frame_timestamp_microseconds_v1,
    verify_export_chunk_timestamp_v1,
};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProvenanceV1<'a> {
    engine_abi_version: u32,
    export_profile_hash: &'a str,
    scene_id: &'a str,
    scene_revision_hash: &'a str,
}

fn mux_error(error: ExportMuxErrorV1) -> JsValue {
    if matches!(error, ExportMuxErrorV1::Io(_)) {
        refused("output-limit-exceeded", error)
    } else {
        refused("mux-failed", error)
    }
}

/// Exports one validated canonical Scene bundle as a complete MP4 byte array.
///
/// No bytes cross the JavaScript boundary until rendering, encoding and mux
/// finalization have all succeeded. Any stage rejects with a named refusal;
/// there is no renderer, codec or partial-file fallback.
///
/// # Errors
///
/// Returns a named `PoietraBrowserMp4ExportRefused` JavaScript error when the
/// Scene, assets, GPU, encoder evidence, output bound, or muxing fails.
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
) -> Result<js_sys::Uint8Array, JsValue> {
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
    let mut sequence = ExportFrameSequenceSessionV1::<EvaluationError, _>::new(
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
    )
    .map_err(|error| refused("render-failed", error))?;
    let frame_count = sequence.frame_count();
    let mut video_encoder = create_encoder(&profile).await.map_err(|failure| {
        refused(
            failure.reason.wire_name(),
            format!("WebCodecs encoder refused the export: {}", failure.message),
        )
    })?;

    while let Some(frame) = sequence.next_frame().await {
        let frame = frame.map_err(|error| refused("render-failed", error))?;
        let timestamp = frame_timestamp_microseconds_v1(frame.frame_index, fps)
            .ok_or_else(|| refused("invalid-timestamp", "frame timestamp overflowed"))?;
        video_encoder
            .push_frame_for_export(frame.rgba.to_vec(), timestamp)
            .await
            .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
    }
    video_encoder
        .finish_for_export()
        .await
        .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
    let encoded_output = video_encoder
        .take_finished_output()
        .map_err(|failure| refused(failure.reason.wire_name(), failure.message))?;
    let color = color_parameters(&encoded_output.color_space)?;
    let max_sample_count = NonZeroU32::new(
        u32::try_from(frame_count)
            .map_err(|_| refused("mux-failed", "frame count exceeds the MP4 sample bound"))?,
    )
    .ok_or_else(|| refused("mux-failed", "an empty Scene cannot be exported"))?;
    let provenance = serde_json::to_vec(&ExportProvenanceV1 {
        engine_abi_version: POIETRA_ENGINE_ABI_VERSION,
        export_profile_hash: &profile_hash,
        scene_id: &scene_id,
        scene_revision_hash: &scene_revision_hash,
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
    let mut mux = ExportMuxSessionV1::begin(
        ExportMuxConfigV1 {
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
        },
        sink,
    )
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
    let sink = mux.finish().map_err(mux_error)?;
    Ok(js_sys::Uint8Array::from(sink.into_bytes().as_slice()))
}
