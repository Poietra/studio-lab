//! Pure contract types for the composed browser MP4 export session (#722).
//!
//! Everything here is browser-independent so it can be unit tested on native
//! targets: the closed refusal vocabulary, the bounded JSON response envelope,
//! the deterministic bitrate policy, the measured-`colorSpace` → `colr` (nclx)
//! resolution, and the canonical provenance payload. The wasm32-only
//! `export_session` module owns the WebGPU/`WebCodecs`/muxer composition.

use poietra_scene_ir::{ContractVersionV1, ExportFrameRateV1, ExportResolutionV1};
use serde::Serialize;

use crate::bounded_writer::BoundedWriter;
use crate::export_encoder_protocol::{
    ExportEncoderColorSpaceEvidenceV1, ExportEncoderRefusalReasonV1,
};

/// Export session ABI version, independent of the base engine, canvas, and
/// export-encoder ABIs so adopting the composed session never forces a
/// lockstep worker upgrade (#734 precedent).
pub const POIETRA_EXPORT_SESSION_ABI_VERSION_V1: u32 = 1;

/// Export session acknowledgements carry status and evidence only; the muxed
/// MP4 bytes always travel as one `Uint8Array` transfer outside this bound.
pub const MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES_V1: usize = 16 * 1024;

pub(crate) const MAX_EXPORT_SESSION_ERROR_MESSAGE_UTF16_UNITS_V1: usize = 2_048;

/// The version string of this engine build, recorded in export provenance.
pub(crate) const ENGINE_VERSION_V1: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, Serialize)]
enum ExportSessionResponseSchemaV1 {
    #[serde(rename = "poietra.export-session-response")]
    ExportSessionResponse,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum ExportProvenanceSchemaV1 {
    #[serde(rename = "poietra.export-provenance")]
    ExportProvenance,
}

/// Closed set of fail-closed export session refusal reasons. Encoder-stage
/// failures reuse the export-encoder wire vocabulary verbatim; the remaining
/// names cover admission, rendering, timestamp-truth, muxing, and output
/// bounds. Any ambiguity maps to a refusal; the session never reports partial
/// success and never leaves a partial file.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum ExportSessionRefusalReasonV1 {
    /// A `WebCodecs`/timer capability required to run is missing.
    #[serde(rename = "api-unavailable")]
    ApiUnavailable,
    /// The progress callback asked the session to stop; everything collected
    /// so far was discarded.
    #[serde(rename = "cancelled")]
    Cancelled,
    /// Encoder output would exceed the declared retention bounds.
    #[serde(rename = "capacity-exceeded")]
    CapacityExceeded,
    /// The encoder settled with a chunk count that does not match the frame
    /// grid, so the movie would silently drop or invent frames.
    #[serde(rename = "chunk-count-mismatch")]
    ChunkCountMismatch,
    /// A chunk's timestamp left the canonical `floor(i * 1e6 / fps)` grid.
    #[serde(rename = "chunk-timestamp-mismatch")]
    ChunkTimestampMismatch,
    /// The measured `decoderConfig.colorSpace` reported a value outside the
    /// closed ISO/IEC 23091-2 mapping, so a truthful `colr` box cannot be
    /// written.
    #[serde(rename = "color-unrepresentable")]
    ColorUnrepresentable,
    /// The validated Scene runs longer than the profile's declared bound.
    #[serde(rename = "duration-exceeded")]
    DurationExceeded,
    /// The encoder error callback fired, or construct/configure/encode threw.
    #[serde(rename = "encoder-error")]
    EncoderError,
    /// No WebGPU adapter/device could be acquired for offscreen export.
    #[serde(rename = "gpu-unavailable")]
    GpuUnavailable,
    /// A `VideoFrame` could not be constructed from an exported frame.
    #[serde(rename = "invalid-frame")]
    InvalidFrame,
    /// The export profile JSON violated the closed v1 contract.
    #[serde(rename = "invalid-profile")]
    InvalidProfile,
    /// A session request violated the closed contract.
    #[serde(rename = "invalid-request")]
    InvalidRequest,
    /// The Scene bundle or its asset transfer failed validation.
    #[serde(rename = "invalid-snapshot")]
    InvalidSnapshot,
    /// The muxer rejected the container operation.
    #[serde(rename = "mux-failed")]
    MuxFailed,
    /// Encoding completed without producing the expected chunks.
    #[serde(rename = "no-chunk")]
    NoChunk,
    /// The first chunk carried no usable `decoderConfig.description`.
    #[serde(rename = "no-decoder-config")]
    NoDecoderConfig,
    /// The first encoded chunk was not a key frame.
    #[serde(rename = "no-key-frame")]
    NoKeyFrame,
    /// The proven AVC configuration emitted chunks whose timestamps are not
    /// strictly increasing (PR #730 review requirement: this is asserted from
    /// real encoder output, never assumed).
    #[serde(rename = "non-monotonic-chunk-timestamps")]
    NonMonotonicChunkTimestamps,
    /// The finalized container would exceed the profile's declared byte bound.
    #[serde(rename = "output-too-large")]
    OutputTooLarge,
    /// The offscreen frame sequence failed to render a frame truthfully.
    #[serde(rename = "render-failed")]
    RenderFailed,
    #[serde(rename = "response-too-large")]
    ResponseTooLarge,
    #[serde(rename = "serialization-failed")]
    SerializationFailed,
    /// The session already ran; it accepts nothing further.
    #[serde(rename = "session-closed")]
    SessionClosed,
    /// A bounded wait expired.
    #[serde(rename = "timeout")]
    Timeout,
    /// No ladder codec passed the exact-configuration encode proof.
    #[serde(rename = "unsupported-codec")]
    UnsupportedCodec,
}

impl ExportSessionRefusalReasonV1 {
    /// Stable wire name, also used as the machine-readable prefix of named
    /// JavaScript rejection errors.
    pub(crate) const fn wire_name(self) -> &'static str {
        match self {
            Self::ApiUnavailable => "api-unavailable",
            Self::Cancelled => "cancelled",
            Self::CapacityExceeded => "capacity-exceeded",
            Self::ChunkCountMismatch => "chunk-count-mismatch",
            Self::ChunkTimestampMismatch => "chunk-timestamp-mismatch",
            Self::ColorUnrepresentable => "color-unrepresentable",
            Self::DurationExceeded => "duration-exceeded",
            Self::EncoderError => "encoder-error",
            Self::GpuUnavailable => "gpu-unavailable",
            Self::InvalidFrame => "invalid-frame",
            Self::InvalidProfile => "invalid-profile",
            Self::InvalidRequest => "invalid-request",
            Self::InvalidSnapshot => "invalid-snapshot",
            Self::MuxFailed => "mux-failed",
            Self::NoChunk => "no-chunk",
            Self::NoDecoderConfig => "no-decoder-config",
            Self::NoKeyFrame => "no-key-frame",
            Self::NonMonotonicChunkTimestamps => "non-monotonic-chunk-timestamps",
            Self::OutputTooLarge => "output-too-large",
            Self::RenderFailed => "render-failed",
            Self::ResponseTooLarge => "response-too-large",
            Self::SerializationFailed => "serialization-failed",
            Self::SessionClosed => "session-closed",
            Self::Timeout => "timeout",
            Self::UnsupportedCodec => "unsupported-codec",
        }
    }
}

/// Encoder-stage failures keep their stable export-encoder wire names.
impl From<ExportEncoderRefusalReasonV1> for ExportSessionRefusalReasonV1 {
    fn from(reason: ExportEncoderRefusalReasonV1) -> Self {
        match reason {
            ExportEncoderRefusalReasonV1::ApiUnavailable => Self::ApiUnavailable,
            ExportEncoderRefusalReasonV1::CapacityExceeded => Self::CapacityExceeded,
            ExportEncoderRefusalReasonV1::EncoderError => Self::EncoderError,
            ExportEncoderRefusalReasonV1::InvalidFrame => Self::InvalidFrame,
            ExportEncoderRefusalReasonV1::InvalidRequest => Self::InvalidRequest,
            ExportEncoderRefusalReasonV1::NoChunk => Self::NoChunk,
            ExportEncoderRefusalReasonV1::NoDecoderConfig => Self::NoDecoderConfig,
            ExportEncoderRefusalReasonV1::NoKeyFrame => Self::NoKeyFrame,
            ExportEncoderRefusalReasonV1::ResponseTooLarge => Self::ResponseTooLarge,
            ExportEncoderRefusalReasonV1::SerializationFailed => Self::SerializationFailed,
            ExportEncoderRefusalReasonV1::SessionClosed => Self::SessionClosed,
            ExportEncoderRefusalReasonV1::Timeout => Self::Timeout,
            ExportEncoderRefusalReasonV1::UnsupportedCodec => Self::UnsupportedCodec,
        }
    }
}

/// One export session failure: a closed reason plus its bounded detail.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExportSessionFailureV1 {
    pub(crate) message: String,
    pub(crate) reason: ExportSessionRefusalReasonV1,
}

impl ExportSessionFailureV1 {
    pub(crate) fn new(reason: ExportSessionRefusalReasonV1, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason,
        }
    }
}

/// Which authority supplied the numeric `colr` (nclx) values.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum ExportColrSourceV1 {
    /// Every member came from the first chunk's `decoderConfig.colorSpace`.
    #[serde(rename = "measured")]
    Measured,
    /// Some members were measured; absent members fell back to the requested
    /// export colour tag.
    #[serde(rename = "mixed")]
    Mixed,
    /// The encoder reported no `colorSpace` members; the requested export
    /// colour tag was recorded.
    #[serde(rename = "requested")]
    Requested,
}

/// The numeric ISO/IEC 23091-2 values written into the `colr` box, plus which
/// authority supplied them.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportSessionColorEvidenceV1 {
    pub(crate) full_range: bool,
    pub(crate) matrix: u16,
    pub(crate) primaries: u16,
    pub(crate) source: ExportColrSourceV1,
    pub(crate) transfer: u16,
}

/// Requested export colour tag as nclx code points: primaries bt709 (1),
/// transfer iec61966-2-1 (13), matrix bt709 (1), limited range. This mirrors
/// the explicit `VideoFrame` tagging in the encoder binding exactly.
pub(crate) const REQUESTED_COLR_PRIMARIES_V1: u16 = 1;
pub(crate) const REQUESTED_COLR_TRANSFER_V1: u16 = 13;
pub(crate) const REQUESTED_COLR_MATRIX_V1: u16 = 1;
pub(crate) const REQUESTED_COLR_FULL_RANGE_V1: bool = false;

fn colr_primaries_code(name: &str) -> Option<u16> {
    match name {
        "bt709" => Some(1),
        "bt470bg" => Some(5),
        "smpte170m" => Some(6),
        "bt2020" => Some(9),
        "smpte432" => Some(12),
        _ => None,
    }
}

fn colr_transfer_code(name: &str) -> Option<u16> {
    match name {
        "bt709" => Some(1),
        "smpte170m" => Some(6),
        "linear" => Some(8),
        "iec61966-2-1" => Some(13),
        "pq" => Some(16),
        "hlg" => Some(18),
        _ => None,
    }
}

fn colr_matrix_code(name: &str) -> Option<u16> {
    match name {
        "rgb" => Some(0),
        "bt709" => Some(1),
        "bt470bg" => Some(5),
        "smpte170m" => Some(6),
        "bt2020-ncl" => Some(9),
        _ => None,
    }
}

/// Resolves the `colr` (nclx) values from first-chunk `decoderConfig`
/// evidence: measured members win, absent members fall back to the requested
/// export colour tag, and the outcome records which authority supplied the
/// values.
///
/// # Errors
///
/// Fails closed with a detail message when a measured member is outside the
/// closed name → code-point mapping; recording a guessed colour would be a
/// lie in the container.
pub(crate) fn resolve_export_colr_v1(
    evidence: &ExportEncoderColorSpaceEvidenceV1,
) -> Result<ExportSessionColorEvidenceV1, String> {
    let mut measured_members = 0_u8;
    let mut absent_members = 0_u8;
    let mut resolve_name = |member: &str,
                            value: Option<&str>,
                            fallback: u16,
                            map: fn(&str) -> Option<u16>|
     -> Result<u16, String> {
        match value {
            None => {
                absent_members += 1;
                Ok(fallback)
            }
            Some(name) => {
                measured_members += 1;
                map(name).ok_or_else(|| {
                    format!(
                        "decoderConfig.colorSpace.{member} reported the unmappable value {name:?}"
                    )
                })
            }
        }
    };
    let primaries = resolve_name(
        "primaries",
        evidence.primaries.as_deref(),
        REQUESTED_COLR_PRIMARIES_V1,
        colr_primaries_code,
    )?;
    let transfer = resolve_name(
        "transfer",
        evidence.transfer.as_deref(),
        REQUESTED_COLR_TRANSFER_V1,
        colr_transfer_code,
    )?;
    let matrix = resolve_name(
        "matrix",
        evidence.matrix.as_deref(),
        REQUESTED_COLR_MATRIX_V1,
        colr_matrix_code,
    )?;
    let full_range = match evidence.full_range {
        None => {
            absent_members += 1;
            REQUESTED_COLR_FULL_RANGE_V1
        }
        Some(value) => {
            measured_members += 1;
            value
        }
    };
    let source = if absent_members == 0 {
        ExportColrSourceV1::Measured
    } else if measured_members == 0 {
        ExportColrSourceV1::Requested
    } else {
        ExportColrSourceV1::Mixed
    };
    Ok(ExportSessionColorEvidenceV1 {
        full_range,
        matrix,
        primaries,
        source,
        transfer,
    })
}

/// Deterministic closed v1 bitrate policy for the H.264 encoder, keyed by the
/// profile's resolution rung and frame rate. Every value stays inside the
/// encoder contract's bitrate bounds.
#[must_use]
pub(crate) const fn export_session_bitrate_v1(
    resolution: ExportResolutionV1,
    frame_rate: ExportFrameRateV1,
) -> u32 {
    match (resolution, frame_rate) {
        (ExportResolutionV1::Sd854x480, ExportFrameRateV1::Fps30) => 2_500_000,
        (ExportResolutionV1::Sd854x480, ExportFrameRateV1::Fps60) => 4_000_000,
        (ExportResolutionV1::Hd1280x720, ExportFrameRateV1::Fps30) => 5_000_000,
        (ExportResolutionV1::Hd1280x720, ExportFrameRateV1::Fps60) => 7_500_000,
        (ExportResolutionV1::FullHd1920x1080, ExportFrameRateV1::Fps30) => 8_000_000,
        (ExportResolutionV1::FullHd1920x1080, ExportFrameRateV1::Fps60) => 12_000_000,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportProvenancePayloadV1<'a> {
    engine_abi_version: u32,
    engine_version: &'static str,
    export_profile_hash: &'a str,
    scene_revision_hash: &'a str,
    schema: ExportProvenanceSchemaV1,
    version: ContractVersionV1,
}

/// Canonical provenance payload written into the muxer's labeled `uuid` box:
/// the Scene revision hash, this engine build's version and ABI version, and
/// the canonical `exportProfileHash`, as alphabetical camelCase JSON.
///
/// # Errors
///
/// Returns a serialization detail when the canonical payload cannot be
/// represented as JSON.
pub(crate) fn export_provenance_payload_v1(
    scene_revision_hash: &str,
    export_profile_hash: &str,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&ExportProvenancePayloadV1 {
        engine_abi_version: crate::POIETRA_ENGINE_ABI_VERSION,
        engine_version: ENGINE_VERSION_V1,
        export_profile_hash,
        scene_revision_hash,
        schema: ExportProvenanceSchemaV1::ExportProvenance,
        version: ContractVersionV1,
    })
    .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ExportSessionResultV1 {
    /// The finalized MP4 is retained in the session and readable exactly once
    /// through the separate byte transfer; nothing partial is ever reported.
    Finished {
        chunk_count: u64,
        codec: String,
        color: ExportSessionColorEvidenceV1,
        export_profile_hash: String,
        frame_count: u64,
        key_frame_count: u64,
        output_byte_length: u64,
        scene_revision_hash: String,
    },
    /// One frame finished rendering and encoding; arrived chunks are muxed.
    Progress {
        chunks_muxed: u64,
        frame_count: u64,
        frames_encoded: u64,
        muxed_media_bytes: u64,
    },
    Refused {
        message: String,
        reason: ExportSessionRefusalReasonV1,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportSessionResponseV1 {
    result: ExportSessionResultV1,
    schema: ExportSessionResponseSchemaV1,
    version: ContractVersionV1,
}

pub(crate) fn export_session_refusal_result(
    failure: &ExportSessionFailureV1,
) -> ExportSessionResultV1 {
    let message = crate::canvas_protocol::truncate_utf16(
        &failure.message,
        MAX_EXPORT_SESSION_ERROR_MESSAGE_UTF16_UNITS_V1,
    );
    let message = if message.is_empty() {
        "the export session failed".to_owned()
    } else {
        message
    };
    ExportSessionResultV1::Refused {
        message,
        reason: failure.reason,
    }
}

/// Serializes one result within the response bound, falling back to a bounded
/// refusal (and finally a fixed literal) exactly like the canvas and encoder
/// protocols.
pub(crate) fn export_session_response(result: ExportSessionResultV1) -> Vec<u8> {
    let reason = match try_export_session_response(result) {
        Ok(response) => return response,
        Err(reason) => reason,
    };
    let fallback = ExportSessionResponseV1 {
        result: export_session_refusal_result(&ExportSessionFailureV1::new(
            reason,
            "the export session response could not be serialized within the v1 limit",
        )),
        schema: ExportSessionResponseSchemaV1::ExportSessionResponse,
        version: ContractVersionV1,
    };
    serde_json::to_vec(&fallback).unwrap_or_else(|_| {
        br#"{"result":{"kind":"refused","message":"export session response serialization failed","reason":"serialization-failed"},"schema":"poietra.export-session-response","version":1}"#.to_vec()
    })
}

fn try_export_session_response(
    result: ExportSessionResultV1,
) -> Result<Vec<u8>, ExportSessionRefusalReasonV1> {
    let response = ExportSessionResponseV1 {
        result,
        schema: ExportSessionResponseSchemaV1::ExportSessionResponse,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return Ok(writer.into_bytes());
    }
    Err(if writer.overflowed() {
        ExportSessionRefusalReasonV1::ResponseTooLarge
    } else {
        ExportSessionRefusalReasonV1::SerializationFailed
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn evidence(
        primaries: Option<&str>,
        transfer: Option<&str>,
        matrix: Option<&str>,
        full_range: Option<bool>,
    ) -> ExportEncoderColorSpaceEvidenceV1 {
        ExportEncoderColorSpaceEvidenceV1 {
            full_range,
            matrix: matrix.map(str::to_owned),
            primaries: primaries.map(str::to_owned),
            transfer: transfer.map(str::to_owned),
        }
    }

    #[test]
    fn fully_measured_color_space_resolves_to_measured_code_points() {
        let resolved = resolve_export_colr_v1(&evidence(
            Some("bt709"),
            Some("iec61966-2-1"),
            Some("bt709"),
            Some(false),
        ))
        .unwrap();
        assert_eq!(
            resolved,
            ExportSessionColorEvidenceV1 {
                full_range: false,
                matrix: 1,
                primaries: 1,
                source: ExportColrSourceV1::Measured,
                transfer: 13,
            }
        );
    }

    #[test]
    fn bt601_measurements_are_recorded_not_overwritten() {
        let resolved = resolve_export_colr_v1(&evidence(
            Some("smpte170m"),
            Some("smpte170m"),
            Some("smpte170m"),
            Some(true),
        ))
        .unwrap();
        assert_eq!(
            resolved,
            ExportSessionColorEvidenceV1 {
                full_range: true,
                matrix: 6,
                primaries: 6,
                source: ExportColrSourceV1::Measured,
                transfer: 6,
            }
        );
    }

    #[test]
    fn absent_color_space_falls_back_to_the_requested_tag() {
        let resolved = resolve_export_colr_v1(&evidence(None, None, None, None)).unwrap();
        assert_eq!(
            resolved,
            ExportSessionColorEvidenceV1 {
                full_range: REQUESTED_COLR_FULL_RANGE_V1,
                matrix: REQUESTED_COLR_MATRIX_V1,
                primaries: REQUESTED_COLR_PRIMARIES_V1,
                source: ExportColrSourceV1::Requested,
                transfer: REQUESTED_COLR_TRANSFER_V1,
            }
        );
    }

    #[test]
    fn partially_measured_color_space_is_reported_as_mixed() {
        let resolved =
            resolve_export_colr_v1(&evidence(None, None, Some("bt470bg"), None)).unwrap();
        assert_eq!(resolved.matrix, 5);
        assert_eq!(resolved.primaries, REQUESTED_COLR_PRIMARIES_V1);
        assert_eq!(resolved.source, ExportColrSourceV1::Mixed);
    }

    #[test]
    fn unmappable_measured_members_fail_closed_with_the_member_name() {
        let error = resolve_export_colr_v1(&evidence(Some("weird-lab"), None, None, None))
            .expect_err("an unmappable primaries name must refuse");
        assert!(error.contains("primaries"));
        assert!(error.contains("weird-lab"));
        assert!(
            resolve_export_colr_v1(&evidence(None, Some("gamma22"), None, None)).is_err(),
            "an unmappable transfer name must refuse"
        );
        assert!(
            resolve_export_colr_v1(&evidence(None, None, Some("ycgco"), None)).is_err(),
            "an unmappable matrix name must refuse"
        );
    }

    #[test]
    fn bitrate_policy_covers_the_closed_ladder_within_encoder_bounds() {
        let rungs = [
            ExportResolutionV1::Sd854x480,
            ExportResolutionV1::Hd1280x720,
            ExportResolutionV1::FullHd1920x1080,
        ];
        let mut previous = 0;
        for resolution in rungs {
            for frame_rate in [ExportFrameRateV1::Fps30, ExportFrameRateV1::Fps60] {
                let bitrate = export_session_bitrate_v1(resolution, frame_rate);
                assert!((100_000..=100_000_000).contains(&bitrate));
                assert!(
                    bitrate > previous,
                    "the policy must increase monotonically along the ladder"
                );
                previous = bitrate;
            }
        }
    }

    #[test]
    fn provenance_payload_is_canonical_alphabetical_json() {
        let payload = export_provenance_payload_v1(&"a".repeat(64), &"b".repeat(64)).unwrap();
        let value: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["schema"], "poietra.export-provenance");
        assert_eq!(value["version"], 1);
        assert_eq!(value["engineAbiVersion"], crate::POIETRA_ENGINE_ABI_VERSION);
        assert_eq!(value["engineVersion"], ENGINE_VERSION_V1);
        assert_eq!(value["exportProfileHash"], "b".repeat(64));
        assert_eq!(value["sceneRevisionHash"], "a".repeat(64));
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(
            keys, sorted,
            "provenance keys must serialize alphabetically"
        );
    }

    #[test]
    fn encoder_reasons_map_onto_their_stable_wire_names() {
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
        for (encoder_reason, expected) in cases {
            let session_reason: ExportSessionRefusalReasonV1 = encoder_reason.into();
            assert_eq!(session_reason.wire_name(), expected);
            assert_eq!(serde_json::to_value(session_reason).unwrap(), expected);
        }
    }

    #[test]
    fn session_only_reasons_have_the_expected_wire_names() {
        let cases = [
            (ExportSessionRefusalReasonV1::Cancelled, "cancelled"),
            (
                ExportSessionRefusalReasonV1::ChunkCountMismatch,
                "chunk-count-mismatch",
            ),
            (
                ExportSessionRefusalReasonV1::ChunkTimestampMismatch,
                "chunk-timestamp-mismatch",
            ),
            (
                ExportSessionRefusalReasonV1::ColorUnrepresentable,
                "color-unrepresentable",
            ),
            (
                ExportSessionRefusalReasonV1::DurationExceeded,
                "duration-exceeded",
            ),
            (
                ExportSessionRefusalReasonV1::GpuUnavailable,
                "gpu-unavailable",
            ),
            (
                ExportSessionRefusalReasonV1::InvalidProfile,
                "invalid-profile",
            ),
            (
                ExportSessionRefusalReasonV1::InvalidSnapshot,
                "invalid-snapshot",
            ),
            (ExportSessionRefusalReasonV1::MuxFailed, "mux-failed"),
            (
                ExportSessionRefusalReasonV1::NonMonotonicChunkTimestamps,
                "non-monotonic-chunk-timestamps",
            ),
            (
                ExportSessionRefusalReasonV1::OutputTooLarge,
                "output-too-large",
            ),
            (ExportSessionRefusalReasonV1::RenderFailed, "render-failed"),
        ];
        for (reason, expected) in cases {
            assert_eq!(reason.wire_name(), expected);
            assert_eq!(serde_json::to_value(reason).unwrap(), expected);
        }
    }

    #[test]
    fn responses_serialize_with_schema_version_and_bounded_size() {
        for result in [
            ExportSessionResultV1::Progress {
                chunks_muxed: 3,
                frame_count: 60,
                frames_encoded: 4,
                muxed_media_bytes: 12_345,
            },
            ExportSessionResultV1::Finished {
                chunk_count: 60,
                codec: "avc1.640028".to_owned(),
                color: ExportSessionColorEvidenceV1 {
                    full_range: false,
                    matrix: 1,
                    primaries: 1,
                    source: ExportColrSourceV1::Measured,
                    transfer: 13,
                },
                export_profile_hash: "b".repeat(64),
                frame_count: 60,
                key_frame_count: 1,
                output_byte_length: 1_048_576,
                scene_revision_hash: "a".repeat(64),
            },
            export_session_refusal_result(&ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::NonMonotonicChunkTimestamps,
                "chunk 5 reported 100 us after 200 us",
            )),
        ] {
            let response = export_session_response(result);
            assert!(response.len() <= MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES_V1);
            let value: Value = serde_json::from_slice(&response).unwrap();
            assert_eq!(value["schema"], "poietra.export-session-response");
            assert_eq!(value["version"], 1);
            assert!(value["result"]["kind"].is_string());
        }
    }

    #[test]
    fn finished_response_reports_the_colr_authority() {
        let response = export_session_response(ExportSessionResultV1::Finished {
            chunk_count: 2,
            codec: "avc1.42E01F".to_owned(),
            color: ExportSessionColorEvidenceV1 {
                full_range: false,
                matrix: 1,
                primaries: 1,
                source: ExportColrSourceV1::Requested,
                transfer: 13,
            },
            export_profile_hash: "b".repeat(64),
            frame_count: 2,
            key_frame_count: 1,
            output_byte_length: 4_096,
            scene_revision_hash: "a".repeat(64),
        });
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["result"]["kind"], "finished");
        assert_eq!(value["result"]["color"]["source"], "requested");
        assert_eq!(value["result"]["color"]["primaries"], 1);
        assert_eq!(value["result"]["color"]["fullRange"], false);
    }

    #[test]
    fn oversized_refusal_message_is_truncated_within_the_bound() {
        let response =
            export_session_response(export_session_refusal_result(&ExportSessionFailureV1::new(
                ExportSessionRefusalReasonV1::MuxFailed,
                "🦀".repeat(MAX_EXPORT_SESSION_ERROR_MESSAGE_UTF16_UNITS_V1),
            )));
        assert!(response.len() <= MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(
            value["result"]["message"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            MAX_EXPORT_SESSION_ERROR_MESSAGE_UTF16_UNITS_V1
        );
    }

    #[test]
    fn empty_refusal_message_uses_a_nonempty_wire_fallback() {
        let response = export_session_response(export_session_refusal_result(
            &ExportSessionFailureV1::new(ExportSessionRefusalReasonV1::Cancelled, ""),
        ));
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["result"]["message"], "the export session failed");
    }
}
