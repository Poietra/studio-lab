//! Pure contract types for the `WebCodecs` H.264 export encoder binding.
//!
//! Everything here is browser-independent so it can be unit tested on native
//! targets: request parsing, closed refusal reasons, bounded JSON responses,
//! and the key-frame cadence rule. The wasm32-only `export_encoder` module
//! owns the actual `WebCodecs` calls.

use poietra_scene_ir::ContractVersionV1;
use serde::{Deserialize, Serialize};

use crate::bounded_writer::BoundedWriter;

/// Export encoder ABI version, independent of the base engine and canvas ABIs
/// so adopting the encoder never forces a lockstep worker upgrade.
pub const POIETRA_EXPORT_ENCODER_ABI_VERSION_V1: u32 = 1;

/// Export encoder acknowledgements carry status and evidence only; encoded
/// chunk bytes always travel as `Uint8Array` transfers outside this bound.
pub const MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1: usize = 16 * 1024;

/// Session requests are tiny closed configuration objects.
pub const MAX_EXPORT_ENCODER_REQUEST_JSON_BYTES_V1: usize = 4 * 1024;

pub(crate) const MAX_EXPORT_ENCODER_ERROR_MESSAGE_UTF16_UNITS_V1: usize = 2_048;

/// Maximum encoder queue depth after a frame is submitted. Frames are never
/// dropped; a full queue must drain before the next submission.
pub(crate) const MAX_ENCODE_QUEUE_DEPTH_V1: u32 = 8;

/// Forced key-frame cadence in microseconds (2 seconds).
pub(crate) const KEY_FRAME_INTERVAL_MICROSECONDS_V1: u64 = 2_000_000;

/// Largest integer microsecond value JavaScript can represent exactly.
const MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_V1: u64 = 9_007_199_254_740_991;
const MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_NUMBER_V1: f64 = 9_007_199_254_740_991.0;

/// Upper bound for one probe attempt or one backpressure wait.
pub(crate) const EXPORT_ENCODER_WAIT_TIMEOUT_MILLISECONDS_V1: f64 = 10_000.0;

/// Upper bound for the terminal flush of a session.
pub(crate) const EXPORT_ENCODER_FLUSH_TIMEOUT_MILLISECONDS_V1: f64 = 30_000.0;

/// H.264 codec strings probed in order; the first fully proven entry wins.
/// High profile level 4.2 covers the closed 1080p60 export profile; lower
/// levels remain fallbacks for smaller exports.
pub(crate) const H264_CODEC_LADDER_V1: [&str; 3] = ["avc1.64002A", "avc1.640028", "avc1.42E01F"];

/// AVC in-browser maximum frame size in pixels (`WebCodecs` AVC registration).
pub(crate) const MAX_H264_FRAME_PIXELS_V1: u32 = 9_437_184;

pub(crate) const MIN_EXPORT_DIMENSION_PX_V1: u32 = 2;
pub(crate) const MAX_EXPORT_DIMENSION_PX_V1: u32 = 4_096;
pub(crate) const MIN_EXPORT_FRAMES_PER_SECOND_V1: u32 = 1;
pub(crate) const MAX_EXPORT_FRAMES_PER_SECOND_V1: u32 = 120;
pub(crate) const MIN_EXPORT_BITRATE_V1: u32 = 100_000;
pub(crate) const MAX_EXPORT_BITRATE_V1: u32 = 100_000_000;

/// Retained encoded output bounds; exceeding either fails the session closed.
pub(crate) const MAX_ENCODED_CHUNKS_V1: usize = 65_536;
pub(crate) const MAX_TOTAL_ENCODED_BYTES_V1: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize)]
enum ExportEncoderSessionRequestSchemaV1 {
    #[serde(rename = "poietra.export-encoder-session-request")]
    ExportEncoderSessionRequest,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum ExportEncoderResponseSchemaV1 {
    #[serde(rename = "poietra.export-encoder-response")]
    ExportEncoderResponse,
}

/// Closed set of fail-closed refusal reasons. Any ambiguity maps to a refusal;
/// the encoder never reports partial success.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum ExportEncoderRefusalReasonV1 {
    /// `VideoEncoder` (or the timer needed to bound waits) is missing.
    #[serde(rename = "api-unavailable")]
    ApiUnavailable,
    /// Retained chunk count or byte total would exceed the declared bounds.
    #[serde(rename = "capacity-exceeded")]
    CapacityExceeded,
    /// The encoder error callback fired, or construct/configure/encode threw.
    #[serde(rename = "encoder-error")]
    EncoderError,
    /// A `VideoFrame` could not be constructed from the supplied buffer.
    #[serde(rename = "invalid-frame")]
    InvalidFrame,
    /// The request JSON violated the closed session contract.
    #[serde(rename = "invalid-request")]
    InvalidRequest,
    /// Encoding completed without producing the expected chunks.
    #[serde(rename = "no-chunk")]
    NoChunk,
    /// The first chunk's metadata carried no usable `decoderConfig.description`.
    #[serde(rename = "no-decoder-config")]
    NoDecoderConfig,
    /// The first encoded chunk was not a key frame.
    #[serde(rename = "no-key-frame")]
    NoKeyFrame,
    #[serde(rename = "response-too-large")]
    ResponseTooLarge,
    #[serde(rename = "serialization-failed")]
    SerializationFailed,
    /// The session already finished or failed; it accepts nothing further.
    #[serde(rename = "session-closed")]
    SessionClosed,
    /// A bounded wait (probe attempt, backpressure, or flush) expired.
    #[serde(rename = "timeout")]
    Timeout,
    /// `isConfigSupported` denied the configuration on every ladder entry.
    #[serde(rename = "unsupported-codec")]
    UnsupportedCodec,
}

impl ExportEncoderRefusalReasonV1 {
    /// Stable wire name, also used as the machine-readable prefix of named
    /// JavaScript rejection errors.
    pub(crate) const fn wire_name(self) -> &'static str {
        match self {
            Self::ApiUnavailable => "api-unavailable",
            Self::CapacityExceeded => "capacity-exceeded",
            Self::EncoderError => "encoder-error",
            Self::InvalidFrame => "invalid-frame",
            Self::InvalidRequest => "invalid-request",
            Self::NoChunk => "no-chunk",
            Self::NoDecoderConfig => "no-decoder-config",
            Self::NoKeyFrame => "no-key-frame",
            Self::ResponseTooLarge => "response-too-large",
            Self::SerializationFailed => "serialization-failed",
            Self::SessionClosed => "session-closed",
            Self::Timeout => "timeout",
            Self::UnsupportedCodec => "unsupported-codec",
        }
    }
}

/// Validated session configuration decoded from one bounded JSON request.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExportEncoderSessionConfigV1 {
    pub(crate) bitrate: u32,
    pub(crate) codec: String,
    pub(crate) frames_per_second: u32,
    pub(crate) height_px: u32,
    pub(crate) width_px: u32,
}

impl ExportEncoderSessionConfigV1 {
    pub(crate) fn tight_rgba_byte_length(&self) -> Option<usize> {
        let pixels = u64::from(self.width_px).checked_mul(u64::from(self.height_px))?;
        usize::try_from(pixels.checked_mul(4)?).ok()
    }
}

/// Canonical constant-frame-rate timestamp: `floor(frame_index * 1_000_000 / fps)`.
/// The result is directly usable as the muxer's `u64` microsecond timestamp.
pub(crate) fn frame_timestamp_microseconds_v1(frame_index: u64, fps: u32) -> Option<u64> {
    if fps == 0 {
        return None;
    }
    frame_index
        .checked_mul(1_000_000)?
        .checked_div(u64::from(fps))
        .filter(|timestamp| *timestamp <= MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_V1)
}

/// Integer duration between adjacent canonical constant-frame-rate timestamps.
pub(crate) fn frame_duration_microseconds_v1(frame_index: u64, fps: u32) -> Option<u64> {
    let timestamp = frame_timestamp_microseconds_v1(frame_index, fps)?;
    frame_timestamp_microseconds_v1(frame_index.checked_add(1)?, fps)?.checked_sub(timestamp)
}

/// Admits only non-negative integer microseconds that round-trip through a
/// JavaScript `number`; `WebIDL` must never silently truncate encoder timing.
pub(crate) fn admit_javascript_safe_microseconds_v1(value: f64) -> Option<u64> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || value > MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_NUMBER_V1
    {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value as u64)
}

/// Whether submitting one more frame keeps the encoder queue within its cap.
pub(crate) const fn encoder_queue_has_capacity_v1(queue_depth: u32) -> bool {
    queue_depth < MAX_ENCODE_QUEUE_DEPTH_V1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportEncoderSessionRequestJsonV1 {
    bitrate: u32,
    codec: String,
    frames_per_second: u32,
    height_px: u32,
    #[serde(rename = "schema")]
    _schema: ExportEncoderSessionRequestSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    width_px: u32,
}

/// Parses and validates one bounded session request, fail-closed.
pub(crate) fn parse_export_encoder_session_request_v1(
    request_json: &[u8],
) -> Result<ExportEncoderSessionConfigV1, String> {
    if request_json.len() > MAX_EXPORT_ENCODER_REQUEST_JSON_BYTES_V1 {
        return Err(format!(
            "the session request exceeds the {MAX_EXPORT_ENCODER_REQUEST_JSON_BYTES_V1}-byte limit"
        ));
    }
    let request: ExportEncoderSessionRequestJsonV1 =
        serde_json::from_slice(request_json).map_err(|error| error.to_string())?;
    let config = ExportEncoderSessionConfigV1 {
        bitrate: request.bitrate,
        codec: request.codec,
        frames_per_second: request.frames_per_second,
        height_px: request.height_px,
        width_px: request.width_px,
    };
    validate_export_encoder_session_config_v1(&config)?;
    Ok(config)
}

fn validate_export_encoder_session_config_v1(
    config: &ExportEncoderSessionConfigV1,
) -> Result<(), String> {
    if !H264_CODEC_LADDER_V1.contains(&config.codec.as_str()) {
        return Err(format!(
            "codec {:?} is outside the closed H.264 ladder {H264_CODEC_LADDER_V1:?}",
            config.codec
        ));
    }
    for (name, value) in [("widthPx", config.width_px), ("heightPx", config.height_px)] {
        if !(MIN_EXPORT_DIMENSION_PX_V1..=MAX_EXPORT_DIMENSION_PX_V1).contains(&value) {
            return Err(format!(
                "{name} must be within {MIN_EXPORT_DIMENSION_PX_V1}..={MAX_EXPORT_DIMENSION_PX_V1}"
            ));
        }
        if value % 2 != 0 {
            return Err(format!("{name} must be even for 4:2:0 H.264 encoding"));
        }
    }
    let pixels = u64::from(config.width_px) * u64::from(config.height_px);
    if pixels > u64::from(MAX_H264_FRAME_PIXELS_V1) {
        return Err(format!(
            "the frame exceeds the {MAX_H264_FRAME_PIXELS_V1}-pixel AVC limit"
        ));
    }
    if !(MIN_EXPORT_FRAMES_PER_SECOND_V1..=MAX_EXPORT_FRAMES_PER_SECOND_V1)
        .contains(&config.frames_per_second)
    {
        return Err(format!(
            "framesPerSecond must be within {MIN_EXPORT_FRAMES_PER_SECOND_V1}..={MAX_EXPORT_FRAMES_PER_SECOND_V1}"
        ));
    }
    if !(MIN_EXPORT_BITRATE_V1..=MAX_EXPORT_BITRATE_V1).contains(&config.bitrate) {
        return Err(format!(
            "bitrate must be within {MIN_EXPORT_BITRATE_V1}..={MAX_EXPORT_BITRATE_V1}"
        ));
    }
    Ok(())
}

/// Whether the frame at `timestamp_microseconds` must be encoded as a key
/// frame under the fixed 2-second cadence. The first frame is always a key
/// frame.
pub(crate) fn key_frame_required_v1(
    last_key_frame_timestamp_microseconds: Option<u64>,
    timestamp_microseconds: u64,
) -> bool {
    match last_key_frame_timestamp_microseconds {
        None => true,
        Some(last) => {
            timestamp_microseconds.saturating_sub(last) >= KEY_FRAME_INTERVAL_MICROSECONDS_V1
        }
    }
}

/// Colour-space values read back from the first chunk's
/// `decoderConfig.colorSpace`; every member is optional because the metadata
/// arrives as a plain JS object whose members a browser may omit.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportEncoderColorSpaceEvidenceV1 {
    pub(crate) full_range: Option<bool>,
    pub(crate) matrix: Option<String>,
    pub(crate) primaries: Option<String>,
    pub(crate) transfer: Option<String>,
}

/// First-chunk `decoderConfig` evidence surfaced through the bounded JSON ABI;
/// the raw description bytes travel separately as a `Uint8Array`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportEncoderDecoderConfigEvidenceV1 {
    pub(crate) color_space: ExportEncoderColorSpaceEvidenceV1,
    pub(crate) description_byte_length: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ExportEncoderResultV1 {
    /// One pushed frame was accepted by the encoder queue.
    Accepted { frame_index: u64, key_frame: bool },
    /// Bounded metadata for one retained chunk; bytes travel separately.
    Chunk {
        byte_length: u32,
        duration_microseconds: Option<u64>,
        index: u32,
        key_frame: bool,
        timestamp_microseconds: u64,
    },
    /// The session flushed completely; nothing partial is ever reported.
    Finished {
        chunk_count: u32,
        decoder_config: ExportEncoderDecoderConfigEvidenceV1,
        key_frame_count: u32,
        total_byte_length: u64,
    },
    Refused {
        message: String,
        reason: ExportEncoderRefusalReasonV1,
    },
    /// The probe fully proved this codec with a real two-frame encode.
    Supported { codec: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportEncoderResponseV1 {
    result: ExportEncoderResultV1,
    schema: ExportEncoderResponseSchemaV1,
    version: ContractVersionV1,
}

pub(crate) fn export_encoder_refusal_result(
    reason: ExportEncoderRefusalReasonV1,
    message: &str,
) -> ExportEncoderResultV1 {
    let message = crate::canvas_protocol::truncate_utf16(
        message,
        MAX_EXPORT_ENCODER_ERROR_MESSAGE_UTF16_UNITS_V1,
    );
    let message = if message.is_empty() {
        "export encoding failed".to_owned()
    } else {
        message
    };
    ExportEncoderResultV1::Refused { message, reason }
}

/// Serializes one result within the response bound, falling back to a bounded
/// refusal (and finally a fixed literal) exactly like the canvas protocol.
pub(crate) fn export_encoder_response(result: ExportEncoderResultV1) -> Vec<u8> {
    let reason = match try_export_encoder_response(result) {
        Ok(response) => return response,
        Err(reason) => reason,
    };
    let fallback = ExportEncoderResponseV1 {
        result: export_encoder_refusal_result(
            reason,
            "the export encoder response could not be serialized within the v1 limit",
        ),
        schema: ExportEncoderResponseSchemaV1::ExportEncoderResponse,
        version: ContractVersionV1,
    };
    serde_json::to_vec(&fallback).unwrap_or_else(|_| {
        br#"{"result":{"kind":"refused","message":"export encoder response serialization failed","reason":"serialization-failed"},"schema":"poietra.export-encoder-response","version":1}"#.to_vec()
    })
}

fn try_export_encoder_response(
    result: ExportEncoderResultV1,
) -> Result<Vec<u8>, ExportEncoderRefusalReasonV1> {
    let response = ExportEncoderResponseV1 {
        result,
        schema: ExportEncoderResponseSchemaV1::ExportEncoderResponse,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return Ok(writer.into_bytes());
    }
    Err(if writer.overflowed() {
        ExportEncoderRefusalReasonV1::ResponseTooLarge
    } else {
        ExportEncoderRefusalReasonV1::SerializationFailed
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn valid_request() -> Value {
        json!({
            "bitrate": 4_000_000,
            "codec": "avc1.640028",
            "framesPerSecond": 30,
            "heightPx": 480,
            "schema": "poietra.export-encoder-session-request",
            "version": 1,
            "widthPx": 854,
        })
    }

    fn parse(value: &Value) -> Result<ExportEncoderSessionConfigV1, String> {
        parse_export_encoder_session_request_v1(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn valid_session_request_parses_into_the_exact_config() {
        let config = parse(&valid_request()).unwrap();
        assert_eq!(
            config,
            ExportEncoderSessionConfigV1 {
                bitrate: 4_000_000,
                codec: "avc1.640028".to_owned(),
                frames_per_second: 30,
                height_px: 480,
                width_px: 854,
            }
        );
        assert_eq!(config.tight_rgba_byte_length(), Some(854 * 480 * 4));
        assert_eq!(frame_duration_microseconds_v1(0, 30), Some(33_333));
    }

    #[test]
    fn high_profile_level_4_2_admits_the_1080p60_export_rung() {
        let mut request = valid_request();
        request["codec"] = json!("avc1.64002A");
        request["framesPerSecond"] = json!(60);
        request["heightPx"] = json!(1_080);
        request["widthPx"] = json!(1_920);
        let config = parse(&request).unwrap();
        assert_eq!(config.codec, "avc1.64002A");
        assert_eq!(config.frames_per_second, 60);
        assert_eq!((config.width_px, config.height_px), (1_920, 1_080));
    }

    #[test]
    fn session_request_rejects_unknown_fields_and_wrong_schema() {
        let mut unknown = valid_request();
        unknown["latencyMode"] = json!("quality");
        assert!(parse(&unknown).unwrap_err().contains("latencyMode"));

        let mut schema = valid_request();
        schema["schema"] = json!("poietra.some-other-request");
        assert!(!parse(&schema).unwrap_err().is_empty());
    }

    #[test]
    fn session_request_rejects_out_of_contract_values() {
        for (field, value, fragment) in [
            ("codec", json!("vp09.00.10.08"), "closed H.264 ladder"),
            ("codec", json!("avc1.4D0028"), "closed H.264 ladder"),
            ("widthPx", json!(853), "even"),
            ("heightPx", json!(0), "within"),
            ("widthPx", json!(8_192), "within"),
            ("framesPerSecond", json!(0), "framesPerSecond"),
            ("framesPerSecond", json!(240), "framesPerSecond"),
            ("bitrate", json!(1), "bitrate"),
            ("bitrate", json!(200_000_000), "bitrate"),
        ] {
            let mut request = valid_request();
            request[field] = value;
            let error = parse(&request).unwrap_err();
            assert!(error.contains(fragment), "{field}: {error}");
        }
    }

    #[test]
    fn oversized_session_request_is_rejected_before_parsing() {
        let mut request = serde_json::to_vec(&valid_request()).unwrap();
        request.resize(MAX_EXPORT_ENCODER_REQUEST_JSON_BYTES_V1 + 1, b' ');
        let error = parse_export_encoder_session_request_v1(&request).unwrap_err();
        assert!(error.contains("byte limit") || error.contains("-byte limit"));
    }

    #[test]
    fn key_frame_cadence_starts_keyed_and_repeats_every_two_seconds() {
        assert!(key_frame_required_v1(None, 0));
        assert!(!key_frame_required_v1(Some(0), 1_999_999));
        assert!(key_frame_required_v1(Some(0), 2_000_000));
        assert!(key_frame_required_v1(Some(2_000_000), 4_000_000));
        assert!(!key_frame_required_v1(Some(2_000_000), 3_999_999));
    }

    #[test]
    fn frame_timestamps_are_integer_microseconds_at_30_and_60_fps() {
        let timestamps = |fps| {
            (0..10)
                .map(|frame_index| frame_timestamp_microseconds_v1(frame_index, fps).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            timestamps(30),
            [
                0, 33_333, 66_666, 100_000, 133_333, 166_666, 200_000, 233_333, 266_666, 300_000
            ]
        );
        assert_eq!(
            timestamps(60),
            [
                0, 16_666, 33_333, 50_000, 66_666, 83_333, 100_000, 116_666, 133_333, 150_000
            ]
        );
        assert_eq!(
            admit_javascript_safe_microseconds_v1(33_333.0),
            Some(33_333)
        );
        assert_eq!(admit_javascript_safe_microseconds_v1(33_333.5), None);
        assert_eq!(admit_javascript_safe_microseconds_v1(f64::NAN), None);
        assert_eq!(
            admit_javascript_safe_microseconds_v1(
                MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_NUMBER_V1
            ),
            Some(MAX_JAVASCRIPT_SAFE_INTEGER_MICROSECONDS_V1)
        );
    }

    #[test]
    fn queue_capacity_stops_before_the_eight_frame_cap() {
        assert!(encoder_queue_has_capacity_v1(7));
        assert!(!encoder_queue_has_capacity_v1(8));
        assert!(!encoder_queue_has_capacity_v1(9));
    }

    #[test]
    fn all_refusal_reasons_have_the_expected_wire_names() {
        let cases = [
            (
                ExportEncoderRefusalReasonV1::ApiUnavailable,
                "api-unavailable",
            ),
            (
                ExportEncoderRefusalReasonV1::CapacityExceeded,
                "capacity-exceeded",
            ),
            (ExportEncoderRefusalReasonV1::EncoderError, "encoder-error"),
            (ExportEncoderRefusalReasonV1::InvalidFrame, "invalid-frame"),
            (
                ExportEncoderRefusalReasonV1::InvalidRequest,
                "invalid-request",
            ),
            (ExportEncoderRefusalReasonV1::NoChunk, "no-chunk"),
            (
                ExportEncoderRefusalReasonV1::NoDecoderConfig,
                "no-decoder-config",
            ),
            (ExportEncoderRefusalReasonV1::NoKeyFrame, "no-key-frame"),
            (
                ExportEncoderRefusalReasonV1::ResponseTooLarge,
                "response-too-large",
            ),
            (
                ExportEncoderRefusalReasonV1::SerializationFailed,
                "serialization-failed",
            ),
            (
                ExportEncoderRefusalReasonV1::SessionClosed,
                "session-closed",
            ),
            (ExportEncoderRefusalReasonV1::Timeout, "timeout"),
            (
                ExportEncoderRefusalReasonV1::UnsupportedCodec,
                "unsupported-codec",
            ),
        ];
        for (reason, expected) in cases {
            assert_eq!(serde_json::to_value(reason).unwrap(), expected);
            assert_eq!(reason.wire_name(), expected);
        }
    }

    #[test]
    fn responses_serialize_with_schema_version_and_bounded_size() {
        for result in [
            ExportEncoderResultV1::Supported {
                codec: "avc1.640028".to_owned(),
            },
            ExportEncoderResultV1::Accepted {
                frame_index: 9,
                key_frame: true,
            },
            ExportEncoderResultV1::Chunk {
                byte_length: 1_024,
                duration_microseconds: Some(33_333),
                index: 3,
                key_frame: false,
                timestamp_microseconds: 100_000,
            },
            ExportEncoderResultV1::Finished {
                chunk_count: 10,
                decoder_config: ExportEncoderDecoderConfigEvidenceV1 {
                    color_space: ExportEncoderColorSpaceEvidenceV1 {
                        full_range: Some(false),
                        matrix: Some("bt709".to_owned()),
                        primaries: Some("bt709".to_owned()),
                        transfer: Some("iec61966-2-1".to_owned()),
                    },
                    description_byte_length: 34,
                },
                key_frame_count: 1,
                total_byte_length: 123_456,
            },
            export_encoder_refusal_result(
                ExportEncoderRefusalReasonV1::UnsupportedCodec,
                "no ladder entry passed the two-frame proof",
            ),
        ] {
            let response = export_encoder_response(result);
            assert!(response.len() <= MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1);
            let value: Value = serde_json::from_slice(&response).unwrap();
            assert_eq!(value["schema"], "poietra.export-encoder-response");
            assert_eq!(value["version"], 1);
            assert!(value["result"]["kind"].is_string());
        }
    }

    #[test]
    fn finished_response_reports_decoder_config_evidence_fields() {
        let response = export_encoder_response(ExportEncoderResultV1::Finished {
            chunk_count: 2,
            decoder_config: ExportEncoderDecoderConfigEvidenceV1 {
                color_space: ExportEncoderColorSpaceEvidenceV1::default(),
                description_byte_length: 34,
            },
            key_frame_count: 1,
            total_byte_length: 4_096,
        });
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["result"]["kind"], "finished");
        assert_eq!(
            value["result"]["decoderConfig"]["descriptionByteLength"],
            34
        );
        assert_eq!(
            value["result"]["decoderConfig"]["colorSpace"]["matrix"],
            Value::Null
        );
        assert_eq!(value["result"]["chunkCount"], 2);
    }

    #[test]
    fn oversized_refusal_message_is_truncated_within_the_bound() {
        let response = export_encoder_response(export_encoder_refusal_result(
            ExportEncoderRefusalReasonV1::EncoderError,
            &"🦀".repeat(MAX_EXPORT_ENCODER_ERROR_MESSAGE_UTF16_UNITS_V1),
        ));
        assert!(response.len() <= MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(
            value["result"]["message"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            MAX_EXPORT_ENCODER_ERROR_MESSAGE_UTF16_UNITS_V1
        );
    }

    #[test]
    fn empty_refusal_message_uses_a_nonempty_wire_fallback() {
        let response = export_encoder_response(export_encoder_refusal_result(
            ExportEncoderRefusalReasonV1::NoChunk,
            "",
        ));
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["result"]["message"], "export encoding failed");
    }

    #[test]
    fn ladder_and_bounds_are_the_declared_closed_contract() {
        assert_eq!(
            H264_CODEC_LADDER_V1,
            ["avc1.64002A", "avc1.640028", "avc1.42E01F"]
        );
        assert_eq!(MAX_ENCODE_QUEUE_DEPTH_V1, 8);
        assert_eq!(KEY_FRAME_INTERVAL_MICROSECONDS_V1, 2_000_000);
        assert_eq!(MAX_TOTAL_ENCODED_BYTES_V1, 134_217_728);
    }
}
