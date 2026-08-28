//! Bounded JSON ABI for verifying finished client-export MP4 bytes.
//!
//! Everything here is browser-independent so it can be unit tested on native
//! targets: the shared producer/verifier provenance contract, the closed
//! refusal codes, and the bounded JSON response envelope. The structural
//! container verification itself lives in `poietra-export-mux`.

use poietra_export_mux::{ExportMp4StructureV1, ExportMp4VerifyErrorV1};
use poietra_scene_ir::ContractVersionV1;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::bounded_writer::BoundedWriter;

/// Export MP4 verification ABI version, independent of the base engine,
/// canvas, and encoder ABIs so adopting verification never forces a lockstep
/// worker upgrade.
pub const POIETRA_EXPORT_VERIFY_ABI_VERSION_V1: u32 = 1;

/// Upper bound for one JSON verification response crossing the WASM boundary.
pub const MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1: usize = 96 * 1024;

const MAX_EXPORT_VERIFY_ERROR_MESSAGE_UTF16_UNITS_V1: usize = 2_048;

/// Longest admissible portable-ASCII `sceneId`, matching Scene IR.
const MAX_PROVENANCE_SCENE_ID_CHARS_V1: usize = 240;

/// Exact length of the two provenance hash fields, in lowercase hexadecimal
/// characters.
const PROVENANCE_HASH_CHARS_V1: usize = 64;

/// The provenance identity a browser export embeds as the payload of the
/// labeled `uuid` box and [`verify_export_mp4_v1`] parses back out. This is
/// the single shared producer/verifier contract: the export lane serializes
/// exactly this struct, so any drift fails verification instead of shipping
/// silently.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProvenanceV1 {
    /// Engine ABI version of the module that produced the export.
    pub engine_abi_version: u32,
    /// Canonical export profile hash, 64 lowercase hexadecimal characters.
    pub export_profile_hash: String,
    /// Portable-ASCII identifier of the exported Scene.
    pub scene_id: String,
    /// Scene revision hash, 64 lowercase hexadecimal characters.
    pub scene_revision_hash: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum ExportVerifyResponseSchemaV1 {
    #[serde(rename = "poietra.export-mp4-verification")]
    ExportMp4Verification,
}

/// Closed set of fail-closed refusal codes. Any ambiguity maps to a refusal;
/// verification never reports partial success.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
enum ExportVerifyRefusalCodeV1 {
    #[serde(rename = "input-too-large")]
    InputTooLarge,
    #[serde(rename = "malformed-container")]
    MalformedContainer,
    #[serde(rename = "layout-mismatch")]
    LayoutMismatch,
    #[serde(rename = "provenance-missing")]
    ProvenanceMissing,
    #[serde(rename = "provenance-too-large")]
    ProvenanceTooLarge,
    /// The provenance payload is present but is not the typed v1 contract.
    #[serde(rename = "provenance-invalid")]
    ProvenanceInvalid,
    #[serde(rename = "track-mismatch")]
    TrackMismatch,
    #[serde(rename = "keyframe-first-missing")]
    KeyframeFirstMissing,
    #[serde(rename = "color-parameters-missing")]
    ColorParametersMissing,
    #[serde(rename = "sample-table-mismatch")]
    SampleTableMismatch,
    #[serde(rename = "duration-exceeded")]
    DurationExceeded,
    #[serde(rename = "resolution-unsupported")]
    ResolutionUnsupported,
    /// The response itself could not be serialized within the v1 bound.
    #[serde(rename = "internal-failure")]
    InternalFailure,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportVerifiedColorV1 {
    primaries: u16,
    transfer: u16,
    matrix: u16,
    full_range: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportVerifiedStructureV1 {
    width_px: u16,
    height_px: u16,
    timescale: u32,
    frame_rate: u32,
    duration_ticks: u64,
    sample_count: u64,
    sync_sample_count: u64,
    color: ExportVerifiedColorV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<ExportVerifiedAudioV1>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportVerifiedAudioV1 {
    channels: u8,
    sample_rate: u32,
    pre_skip: u16,
    output_gain: i16,
    sample_count: u64,
    encoded_duration_samples: u64,
    end_trim_samples: u64,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ExportVerifyResultV1 {
    /// Every structural check passed and the provenance is the v1 contract.
    Verified {
        structure: ExportVerifiedStructureV1,
        provenance: ExportProvenanceV1,
    },
    Refused {
        code: ExportVerifyRefusalCodeV1,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportVerifyResponseV1 {
    result: ExportVerifyResultV1,
    schema: ExportVerifyResponseSchemaV1,
    version: ContractVersionV1,
}

fn refusal_code_for(error: &ExportMp4VerifyErrorV1) -> ExportVerifyRefusalCodeV1 {
    match error {
        ExportMp4VerifyErrorV1::InputTooLarge { .. } => ExportVerifyRefusalCodeV1::InputTooLarge,
        ExportMp4VerifyErrorV1::MalformedContainer { .. } => {
            ExportVerifyRefusalCodeV1::MalformedContainer
        }
        ExportMp4VerifyErrorV1::LayoutMismatch { .. } => ExportVerifyRefusalCodeV1::LayoutMismatch,
        ExportMp4VerifyErrorV1::ProvenanceMissing => ExportVerifyRefusalCodeV1::ProvenanceMissing,
        ExportMp4VerifyErrorV1::ProvenanceTooLarge { .. } => {
            ExportVerifyRefusalCodeV1::ProvenanceTooLarge
        }
        ExportMp4VerifyErrorV1::TrackMismatch { .. } => ExportVerifyRefusalCodeV1::TrackMismatch,
        ExportMp4VerifyErrorV1::KeyframeFirstMissing => {
            ExportVerifyRefusalCodeV1::KeyframeFirstMissing
        }
        ExportMp4VerifyErrorV1::ColorParametersMissing => {
            ExportVerifyRefusalCodeV1::ColorParametersMissing
        }
        ExportMp4VerifyErrorV1::SampleTableMismatch { .. } => {
            ExportVerifyRefusalCodeV1::SampleTableMismatch
        }
        ExportMp4VerifyErrorV1::DurationExceeded { .. } => {
            ExportVerifyRefusalCodeV1::DurationExceeded
        }
        ExportMp4VerifyErrorV1::ResolutionUnsupported { .. } => {
            ExportVerifyRefusalCodeV1::ResolutionUnsupported
        }
    }
}

fn refusal(code: ExportVerifyRefusalCodeV1, message: &str) -> ExportVerifyResultV1 {
    let message = crate::canvas_protocol::truncate_utf16(
        message,
        MAX_EXPORT_VERIFY_ERROR_MESSAGE_UTF16_UNITS_V1,
    );
    let message = if message.is_empty() {
        "export MP4 verification failed".to_owned()
    } else {
        message
    };
    ExportVerifyResultV1::Refused { code, message }
}

fn is_provenance_hash(value: &str) -> bool {
    value.len() == PROVENANCE_HASH_CHARS_V1
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_provenance_scene_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.len() <= MAX_PROVENANCE_SCENE_ID_CHARS_V1
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'#' | b'-')
        })
}

/// Parses and bounds the opaque provenance payload as the typed v1 contract.
/// The bounds also make the echoed response trivially fit its byte limit.
fn validate_provenance_payload(payload: &[u8]) -> Result<ExportProvenanceV1, String> {
    let provenance: ExportProvenanceV1 = serde_json::from_slice(payload)
        .map_err(|error| format!("the provenance payload is not the v1 JSON contract: {error}"))?;
    if provenance.engine_abi_version != crate::POIETRA_ENGINE_ABI_VERSION {
        return Err(format!(
            "engineAbiVersion {} does not match verifier ABI {}",
            provenance.engine_abi_version,
            crate::POIETRA_ENGINE_ABI_VERSION
        ));
    }
    if !is_provenance_scene_id(&provenance.scene_id) {
        return Err(format!(
            "sceneId must use the portable ASCII identity subset within \
             {MAX_PROVENANCE_SCENE_ID_CHARS_V1} bytes"
        ));
    }
    for (name, value) in [
        ("exportProfileHash", &provenance.export_profile_hash),
        ("sceneRevisionHash", &provenance.scene_revision_hash),
    ] {
        if !is_provenance_hash(value) {
            return Err(format!(
                "{name} must be exactly {PROVENANCE_HASH_CHARS_V1} lowercase hexadecimal characters"
            ));
        }
    }
    Ok(provenance)
}

fn verified_structure(structure: &ExportMp4StructureV1) -> ExportVerifiedStructureV1 {
    ExportVerifiedStructureV1 {
        width_px: structure.width_px,
        height_px: structure.height_px,
        timescale: structure.timescale,
        frame_rate: structure.frame_rate,
        duration_ticks: structure.duration_ticks,
        sample_count: structure.sample_count,
        sync_sample_count: structure.sync_sample_count,
        color: ExportVerifiedColorV1 {
            primaries: structure.color.primaries,
            transfer: structure.color.transfer,
            matrix: structure.color.matrix,
            full_range: structure.color.full_range,
        },
        audio: structure.audio.as_ref().map(|audio| ExportVerifiedAudioV1 {
            channels: audio.channels,
            sample_rate: audio.sample_rate,
            pre_skip: audio.pre_skip,
            output_gain: audio.output_gain,
            sample_count: audio.sample_count,
            encoded_duration_samples: audio.encoded_duration_samples,
            end_trim_samples: audio.end_trim_samples,
        }),
    }
}

fn verify_result(mp4_bytes: &[u8]) -> ExportVerifyResultV1 {
    let structure = match poietra_export_mux::verify_export_mp4_v1(mp4_bytes) {
        Ok(structure) => structure,
        Err(error) => return refusal(refusal_code_for(&error), &error.to_string()),
    };
    let provenance = match validate_provenance_payload(&structure.provenance) {
        Ok(provenance) => provenance,
        Err(message) => return refusal(ExportVerifyRefusalCodeV1::ProvenanceInvalid, &message),
    };
    ExportVerifyResultV1::Verified {
        structure: verified_structure(&structure),
        provenance,
    }
}

/// Serializes one result within the response bound, falling back to a bounded
/// refusal (and finally a fixed literal) exactly like the encoder protocol.
fn export_verify_response(result: ExportVerifyResultV1) -> Vec<u8> {
    let code = match try_export_verify_response(result) {
        Ok(response) => return response,
        Err(code) => code,
    };
    let fallback = ExportVerifyResponseV1 {
        result: refusal(
            code,
            "the export MP4 verification response could not be serialized within the v1 limit",
        ),
        schema: ExportVerifyResponseSchemaV1::ExportMp4Verification,
        version: ContractVersionV1,
    };
    serde_json::to_vec(&fallback).unwrap_or_else(|_| {
        br#"{"result":{"kind":"refused","code":"internal-failure","message":"export MP4 verification response serialization failed"},"schema":"poietra.export-mp4-verification","version":1}"#.to_vec()
    })
}

fn try_export_verify_response(
    result: ExportVerifyResultV1,
) -> Result<Vec<u8>, ExportVerifyRefusalCodeV1> {
    let response = ExportVerifyResponseV1 {
        result,
        schema: ExportVerifyResponseSchemaV1::ExportMp4Verification,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return Ok(writer.into_bytes());
    }
    Err(ExportVerifyRefusalCodeV1::InternalFailure)
}

/// Verifies one candidate client-export MP4 against the closed v1 structure
/// contract and returns a bounded JSON verification response. The function
/// never throws: every failure is a `refused` result under a closed code.
#[must_use]
#[wasm_bindgen(js_name = verifyExportMp4V1)]
pub fn verify_export_mp4_v1(mp4_bytes: &[u8]) -> Vec<u8> {
    export_verify_response(verify_result(mp4_bytes))
}

#[cfg(test)]
mod tests {
    use std::num::{NonZeroU16, NonZeroU32};

    use poietra_export_mux::{
        ColorParametersV1, EncodedAudioSampleV1, EncodedSampleV1, ExportMuxConfigV1,
        ExportMuxSessionV1, MAX_PROVENANCE_BYTES_V1, MAX_VERIFIED_EXPORT_MP4_BYTES_V1,
        OPUS_SAMPLE_RATE, OpusParametersV1, PROVENANCE_UUID_V1, VideoParametersV1,
    };
    use serde_json::Value;

    use super::*;

    /// Raw `avcC` body bytes matching the session tests' synthetic decoder
    /// configuration (High profile level 3.1, one SPS, one PPS).
    const SYNTHETIC_AVCC: [u8; 23] = [
        0x01, 0x64, 0x00, 0x1F, 0xFF, 0xE1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1F, 0xAC, 0xD9, 0x40,
        0x50, 0x01, 0x00, 0x04, 0x68, 0xEB, 0xE3, 0xCB,
    ];

    fn fixture_provenance() -> ExportProvenanceV1 {
        ExportProvenanceV1 {
            engine_abi_version: crate::POIETRA_ENGINE_ABI_VERSION,
            export_profile_hash: "a".repeat(64),
            scene_id: "fixture-scene".to_owned(),
            scene_revision_hash: "b".repeat(64),
        }
    }

    fn mux_export(width_px: u16, height_px: u16, provenance: Vec<u8>) -> Vec<u8> {
        let config = ExportMuxConfigV1 {
            decoder_configuration: SYNTHETIC_AVCC.to_vec(),
            video: VideoParametersV1 {
                width_px: NonZeroU16::new(width_px).unwrap(),
                height_px: NonZeroU16::new(height_px).unwrap(),
                timescale: NonZeroU32::new(1_000_000).unwrap(),
                frames_per_second: NonZeroU32::new(30).unwrap(),
            },
            color: ColorParametersV1 {
                primaries: 1,
                transfer: 13,
                matrix: 1,
                full_range: false,
            },
            provenance,
            max_sample_count: NonZeroU32::new(16).unwrap(),
        };
        let mut session = ExportMuxSessionV1::begin(config, Vec::new()).unwrap();
        for (payload, timestamp_us, duration_us, is_key) in [
            (avcc_sample(0x65, 119), 0, 33_333, true),
            (avcc_sample(0x41, 89), 33_333, 33_333, false),
            (avcc_sample(0x65, 149), 66_666, 33_334, true),
        ] {
            session
                .append_sample(EncodedSampleV1 {
                    bytes: &payload,
                    timestamp_us,
                    duration_us,
                    is_key,
                })
                .unwrap();
        }
        session.finish().unwrap()
    }

    fn avcc_sample(nal_header: u8, body_bytes: usize) -> Vec<u8> {
        let nal_length = u32::try_from(body_bytes + 1).unwrap();
        let mut bytes = nal_length.to_be_bytes().to_vec();
        bytes.push(nal_header);
        bytes.resize(bytes.len() + body_bytes, 0x80);
        bytes
    }

    fn valid_export() -> Vec<u8> {
        mux_export(854, 480, serde_json::to_vec(&fixture_provenance()).unwrap())
    }

    fn valid_export_with_audio() -> Vec<u8> {
        let provenance = serde_json::to_vec(&fixture_provenance()).unwrap();
        let config = ExportMuxConfigV1 {
            decoder_configuration: SYNTHETIC_AVCC.to_vec(),
            video: VideoParametersV1 {
                width_px: NonZeroU16::new(854).unwrap(),
                height_px: NonZeroU16::new(480).unwrap(),
                timescale: NonZeroU32::new(1_000_000).unwrap(),
                frames_per_second: NonZeroU32::new(30).unwrap(),
            },
            color: ColorParametersV1 {
                primaries: 1,
                transfer: 13,
                matrix: 1,
                full_range: false,
            },
            provenance,
            max_sample_count: NonZeroU32::new(16).unwrap(),
        };
        let mut session = ExportMuxSessionV1::begin_with_opus(
            config,
            OpusParametersV1 {
                channels: 2,
                sample_rate: OPUS_SAMPLE_RATE,
                pre_skip: 312,
                output_gain: -2,
                channel_mapping_family: 0,
            },
            Vec::new(),
        )
        .unwrap();
        for (payload, timestamp_us, duration_us, is_key) in [
            (avcc_sample(0x65, 119), 0, 33_333, true),
            (avcc_sample(0x41, 89), 33_333, 33_333, false),
            (avcc_sample(0x65, 149), 66_666, 33_334, true),
        ] {
            session
                .append_sample(EncodedSampleV1 {
                    bytes: &payload,
                    timestamp_us,
                    duration_us,
                    is_key,
                })
                .unwrap();
        }
        for packet in 0_u8..6 {
            session
                .append_audio_sample(EncodedAudioSampleV1 {
                    bytes: &[0xF8, 0xFF, packet],
                    duration_samples: NonZeroU32::new(960).unwrap(),
                })
                .unwrap();
        }
        session.finish().unwrap()
    }

    fn response_value(mp4_bytes: &[u8]) -> Value {
        let response = verify_export_mp4_v1(mp4_bytes);
        assert!(response.len() <= MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["schema"], "poietra.export-mp4-verification");
        assert_eq!(value["version"], 1);
        value
    }

    fn refusal_code(mp4_bytes: &[u8]) -> String {
        let value = response_value(mp4_bytes);
        assert_eq!(value["result"]["kind"], "refused", "{value}");
        assert!(value["result"]["message"].is_string());
        value["result"]["code"].as_str().unwrap().to_owned()
    }

    fn find(haystack: &[u8], needle: &[u8]) -> usize {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
            .expect("the pattern must occur in the muxed bytes")
    }

    /// Pins the canonical compact serialization the browser export lane
    /// embeds; the `write_client_export_fixture` example hand-writes exactly
    /// these bytes because `poietra-export-mux` has no serde dependency.
    #[test]
    fn fixture_provenance_serializes_to_the_canonical_compact_json() {
        let expected = format!(
            "{{\"engineAbiVersion\":40,\"exportProfileHash\":\"{}\",\
             \"sceneId\":\"fixture-scene\",\"sceneRevisionHash\":\"{}\"}}",
            "a".repeat(64),
            "b".repeat(64)
        );
        assert_eq!(
            serde_json::to_vec(&fixture_provenance()).unwrap(),
            expected.into_bytes()
        );
    }

    #[test]
    fn verified_response_reports_the_structure_and_echoes_the_provenance() {
        let value = response_value(&valid_export());
        assert_eq!(value["result"]["kind"], "verified", "{value}");
        let structure = &value["result"]["structure"];
        assert_eq!(structure["widthPx"], 854);
        assert_eq!(structure["heightPx"], 480);
        assert_eq!(structure["timescale"], 1_000_000);
        assert_eq!(structure["frameRate"], 30);
        assert_eq!(structure["durationTicks"], 100_000);
        assert_eq!(structure["sampleCount"], 3);
        assert_eq!(structure["syncSampleCount"], 2);
        assert_eq!(structure["color"]["primaries"], 1);
        assert_eq!(structure["color"]["transfer"], 13);
        assert_eq!(structure["color"]["matrix"], 1);
        assert_eq!(structure["color"]["fullRange"], false);
        assert!(structure.get("audio").is_none());
        let echoed: ExportProvenanceV1 =
            serde_json::from_value(value["result"]["provenance"].clone()).unwrap();
        assert_eq!(echoed, fixture_provenance());
    }

    #[test]
    fn verified_response_reports_optional_opus_audio() {
        let value = response_value(&valid_export_with_audio());
        assert_eq!(value["result"]["kind"], "verified", "{value}");
        let audio = &value["result"]["structure"]["audio"];
        assert_eq!(audio["channels"], 2);
        assert_eq!(audio["sampleRate"], 48_000);
        assert_eq!(audio["preSkip"], 312);
        assert_eq!(audio["outputGain"], -2);
        assert_eq!(audio["sampleCount"], 6);
        assert_eq!(audio["encodedDurationSamples"], 5_760);
        assert_eq!(audio["endTrimSamples"], 648);
    }

    #[test]
    fn oversized_input_is_refused_before_decoding() {
        assert_eq!(
            refusal_code(&vec![0u8; MAX_VERIFIED_EXPORT_MP4_BYTES_V1 + 1]),
            "input-too-large"
        );
    }

    #[test]
    fn garbage_and_trailing_bytes_are_refused_as_malformed() {
        assert_eq!(refusal_code(b"not an mp4 container"), "malformed-container");
        let mut trailing = valid_export();
        trailing.extend_from_slice(b"tail");
        assert_eq!(refusal_code(&trailing), "malformed-container");
    }

    #[test]
    fn an_atom_after_moov_is_refused_as_layout_mismatch() {
        let mut bytes = valid_export();
        bytes.extend_from_slice(&[0, 0, 0, 8, b'f', b'r', b'e', b'e']);
        assert_eq!(refusal_code(&bytes), "layout-mismatch");
    }

    #[test]
    fn a_mislabeled_provenance_box_is_refused_as_missing() {
        let mut bytes = valid_export();
        let offset = find(&bytes, &PROVENANCE_UUID_V1);
        bytes[offset] = b'X';
        assert_eq!(refusal_code(&bytes), "provenance-missing");
    }

    #[test]
    fn an_oversized_provenance_payload_is_refused() {
        let bytes = valid_export();
        let ftyp_size =
            usize::try_from(u32::from_be_bytes(bytes[0..4].try_into().unwrap())).unwrap();
        let uuid_size = usize::try_from(u32::from_be_bytes(
            bytes[ftyp_size..ftyp_size + 4].try_into().unwrap(),
        ))
        .unwrap();
        let payload_len = MAX_PROVENANCE_BYTES_V1 + 1;
        let mut oversized_uuid = Vec::with_capacity(8 + PROVENANCE_UUID_V1.len() + payload_len);
        oversized_uuid.extend_from_slice(
            &u32::try_from(8 + PROVENANCE_UUID_V1.len() + payload_len)
                .unwrap()
                .to_be_bytes(),
        );
        oversized_uuid.extend_from_slice(b"uuid");
        oversized_uuid.extend_from_slice(&PROVENANCE_UUID_V1);
        oversized_uuid.extend(vec![0xAA; payload_len]);
        let mut spliced = bytes[..ftyp_size].to_vec();
        spliced.extend_from_slice(&oversized_uuid);
        spliced.extend_from_slice(&bytes[ftyp_size + uuid_size..]);
        assert_eq!(refusal_code(&spliced), "provenance-too-large");
    }

    #[test]
    fn a_non_video_handler_is_refused_as_track_mismatch() {
        let mut bytes = valid_export();
        let offset = find(&bytes, b"vide");
        bytes[offset..offset + 4].copy_from_slice(b"soun");
        assert_eq!(refusal_code(&bytes), "track-mismatch");
    }

    #[test]
    fn a_late_first_sync_sample_is_refused() {
        let mut bytes = valid_export();
        // stss layout: fourcc, version+flags, entry count, first entry.
        let offset = find(&bytes, b"stss") + 12;
        bytes[offset..offset + 4].copy_from_slice(&2u32.to_be_bytes());
        assert_eq!(refusal_code(&bytes), "keyframe-first-missing");
    }

    #[test]
    fn a_removed_colr_box_is_refused() {
        let mut bytes = valid_export();
        // Renaming the box to `free` removes it without resizing anything.
        let offset = find(&bytes, b"colr");
        bytes[offset..offset + 4].copy_from_slice(b"free");
        assert_eq!(refusal_code(&bytes), "malformed-container");
    }

    #[test]
    fn a_multi_sample_chunk_table_is_refused() {
        let mut bytes = valid_export();
        // stsc layout: fourcc, version+flags, entry count, first chunk,
        // samples per chunk.
        let offset = find(&bytes, b"stsc") + 16;
        bytes[offset..offset + 4].copy_from_slice(&2u32.to_be_bytes());
        assert_eq!(refusal_code(&bytes), "sample-table-mismatch");
    }

    #[test]
    fn a_movie_beyond_the_duration_bound_is_refused() {
        const SAMPLE_COUNT: u32 = 27_001;
        let config_provenance = serde_json::to_vec(&fixture_provenance()).unwrap();
        let config = ExportMuxConfigV1 {
            decoder_configuration: SYNTHETIC_AVCC.to_vec(),
            video: VideoParametersV1 {
                width_px: NonZeroU16::new(854).unwrap(),
                height_px: NonZeroU16::new(480).unwrap(),
                timescale: NonZeroU32::new(1_000_000).unwrap(),
                frames_per_second: NonZeroU32::new(30).unwrap(),
            },
            color: ColorParametersV1 {
                primaries: 1,
                transfer: 13,
                matrix: 1,
                full_range: false,
            },
            provenance: config_provenance,
            max_sample_count: NonZeroU32::new(SAMPLE_COUNT).unwrap(),
        };
        let mut session = ExportMuxSessionV1::begin(config, Vec::new()).unwrap();
        let idr = avcc_sample(0x65, 1);
        let non_idr = avcc_sample(0x41, 1);
        for index in 0..SAMPLE_COUNT {
            let index = u64::from(index);
            let timestamp_us = index * 1_000_000 / 30;
            let next_timestamp_us = (index + 1) * 1_000_000 / 30;
            session
                .append_sample(EncodedSampleV1 {
                    bytes: if index == 0 { &idr } else { &non_idr },
                    timestamp_us,
                    duration_us: next_timestamp_us - timestamp_us,
                    is_key: index == 0,
                })
                .unwrap();
        }
        assert_eq!(
            refusal_code(&session.finish().unwrap()),
            "duration-exceeded"
        );
    }

    #[test]
    fn an_off_ladder_resolution_is_refused() {
        let bytes = mux_export(100, 100, serde_json::to_vec(&fixture_provenance()).unwrap());
        assert_eq!(refusal_code(&bytes), "resolution-unsupported");
    }

    #[test]
    fn out_of_contract_provenance_payloads_are_refused_as_invalid() {
        let mut oversized_scene_id = fixture_provenance();
        oversized_scene_id.scene_id = "s".repeat(MAX_PROVENANCE_SCENE_ID_CHARS_V1 + 1);
        let mut uppercase_hash = fixture_provenance();
        uppercase_hash.export_profile_hash = "A".repeat(64);
        let mut short_hash = fixture_provenance();
        short_hash.scene_revision_hash = "b".repeat(63);
        let mut wrong_abi = fixture_provenance();
        wrong_abi.engine_abi_version = 26;
        let mut empty_scene_id = fixture_provenance();
        empty_scene_id.scene_id.clear();
        let mut payloads = vec![
            b"not json".to_vec(),
            br#"{"engineAbiVersion":27}"#.to_vec(),
            br#"{"engineAbiVersion":27,"exportProfileHash":"a","sceneId":"s","sceneRevisionHash":"b","extra":1}"#.to_vec(),
        ];
        for provenance in [
            oversized_scene_id,
            uppercase_hash,
            short_hash,
            wrong_abi,
            empty_scene_id,
        ] {
            payloads.push(serde_json::to_vec(&provenance).unwrap());
        }
        for payload in payloads {
            assert_eq!(
                refusal_code(&mux_export(854, 480, payload)),
                "provenance-invalid"
            );
        }
    }

    #[test]
    fn a_maximal_provenance_still_fits_the_response_bound() {
        let mut provenance = fixture_provenance();
        provenance.scene_id = "s".repeat(MAX_PROVENANCE_SCENE_ID_CHARS_V1);
        let value = response_value(&mux_export(
            854,
            480,
            serde_json::to_vec(&provenance).unwrap(),
        ));
        assert_eq!(value["result"]["kind"], "verified");
    }

    #[test]
    fn an_unserializable_result_degrades_to_a_bounded_internal_failure() {
        let response = export_verify_response(ExportVerifyResultV1::Refused {
            code: ExportVerifyRefusalCodeV1::MalformedContainer,
            message: "x".repeat(MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1 + 1),
        });
        assert!(response.len() <= MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["result"]["kind"], "refused");
        assert_eq!(value["result"]["code"], "internal-failure");
    }

    #[test]
    fn refusal_messages_are_truncated_within_the_message_bound() {
        let ExportVerifyResultV1::Refused { message, .. } = refusal(
            ExportVerifyRefusalCodeV1::MalformedContainer,
            &"\u{1F980}".repeat(MAX_EXPORT_VERIFY_ERROR_MESSAGE_UTF16_UNITS_V1),
        ) else {
            panic!("refusal must build a refused result");
        };
        assert_eq!(
            message.encode_utf16().count(),
            MAX_EXPORT_VERIFY_ERROR_MESSAGE_UTF16_UNITS_V1
        );
        let ExportVerifyResultV1::Refused { message, .. } =
            refusal(ExportVerifyRefusalCodeV1::MalformedContainer, "")
        else {
            panic!("refusal must build a refused result");
        };
        assert_eq!(message, "export MP4 verification failed");
    }
}
