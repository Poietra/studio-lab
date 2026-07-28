use std::collections::BTreeSet;

use poietra_eval::{EngineSessionV1, EvaluationError, SampleEngineSessionOptionsV1};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, MAX_VIEWPORT_PIXELS_V1, RenderPacketV1, ViewportV1,
    parse_scene_ir_bundle_json_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::bounded_writer::BoundedWriter;
#[cfg(target_arch = "wasm32")]
use crate::scene_delta::{SceneDeltaErrorV1, apply_scene_delta_json};

/// Playhead requests should remain small compared with the retained snapshot.
/// The envelope still accommodates every contract-valid evidence array.
pub const MAX_SAMPLE_REQUEST_JSON_BYTES_V1: usize = 256 * 1024;
/// Prevents a pathological lowered packet from exceeding the shared contract envelope.
pub const MAX_WORKER_RESPONSE_JSON_BYTES_V1: usize = poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1;

const MAX_EVIDENCE_ENTRIES_V1: usize = 64;
const MAX_EVIDENCE_UTF16_UNITS_V1: usize = 500;
const MAX_ID_UTF16_UNITS_V1: usize = 240;
pub(crate) const MAX_INTERACTION_ENTITY_IDS_V1: usize = 128;

#[derive(Debug, thiserror::Error)]
pub enum WorkerSessionError {
    #[error("invalid Scene snapshot: {0}")]
    Contract(#[from] ContractJsonError),
    #[error(transparent)]
    Evaluation(#[from] EvaluationError),
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum SampleRequestSchemaV1 {
    #[serde(rename = "poietra.engine-sample-request")]
    EngineSampleRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SampleRequestV1 {
    evidence: Vec<String>,
    #[serde(default)]
    interaction_entity_ids: RawInteractionEntityIdsV1,
    packet_id: String,
    sample_time: f64,
    #[serde(rename = "schema")]
    _schema: SampleRequestSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: ViewportV1,
}

/// Distinguishes an omitted opt-in field from an explicitly malformed value.
///
/// The interaction request is advisory metadata: decoding it leniently keeps a
/// bad hit-target request from turning an otherwise renderable pixel frame into
/// an error. The enclosing sample request remains strict for every core field.
#[derive(Debug, Default)]
struct RawInteractionEntityIdsV1(Option<Box<RawValue>>);

impl<'de> Deserialize<'de> for RawInteractionEntityIdsV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Box::<RawValue>::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

/// Correlation copied from one syntactically decoded sample request.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SampleRequestCorrelationV1 {
    pub(crate) packet_id: String,
    pub(crate) sample_time: f64,
    pub(crate) viewport: ViewportV1,
}

/// Typed result used by renderers without a JSON round-trip through the worker response.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SampledRenderPacketV1 {
    pub(crate) correlation: SampleRequestCorrelationV1,
    pub(crate) interaction: SampledInteractionRequestV1,
    pub(crate) packet: RenderPacketV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SampledInteractionEntityV1 {
    pub(crate) active: bool,
    pub(crate) entity_id: Option<String>,
    pub(crate) known: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SampledInteractionRequestV1 {
    /// No interaction metadata was requested. The response must preserve the
    /// pre-extension wire shape by omitting the interaction field.
    Disabled,
    /// The metadata envelope itself was unusable (for example, not an array or
    /// over the fixed cap). Pixel evaluation still proceeds normally.
    Unavailable,
    /// One entry per requested position. `entity_id: None` marks a malformed or
    /// duplicate item without retaining an attacker-controlled oversized value.
    Available(Vec<SampledInteractionEntityV1>),
}

enum NormalizedInteractionRequestV1 {
    Disabled,
    Unavailable,
    Available(Vec<Option<String>>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SamplePacketErrorCodeV1 {
    EvaluationFailed,
    InvalidRequest,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SamplePacketErrorV1 {
    pub(crate) code: SamplePacketErrorCodeV1,
    pub(crate) correlation: Option<SampleRequestCorrelationV1>,
    pub(crate) message: String,
}

impl SamplePacketErrorV1 {
    fn without_correlation(code: SamplePacketErrorCodeV1, message: impl Into<String>) -> Self {
        Self {
            code,
            correlation: None,
            message: message.into(),
        }
    }

    fn with_correlation(
        code: SamplePacketErrorCodeV1,
        message: impl Into<String>,
        correlation: SampleRequestCorrelationV1,
    ) -> Self {
        Self {
            code,
            correlation: Some(correlation),
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
enum WorkerResponseSchemaV1 {
    #[serde(rename = "poietra.engine-worker-response")]
    EngineWorkerResponse,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum WorkerErrorCodeV1 {
    #[serde(rename = "evaluation-failed")]
    EvaluationFailed,
    #[serde(rename = "invalid-request")]
    InvalidRequest,
    #[serde(rename = "response-too-large")]
    ResponseTooLarge,
    #[serde(rename = "serialization-failed")]
    SerializationFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerResponseV1 {
    result: WorkerResultV1,
    schema: WorkerResponseSchemaV1,
    version: ContractVersionV1,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum WorkerResultV1 {
    Error {
        code: WorkerErrorCodeV1,
        message: String,
    },
    Ready {
        packet: Box<RenderPacketV1>,
    },
}

impl WorkerResponseV1 {
    fn ready(packet: RenderPacketV1) -> Self {
        Self {
            result: WorkerResultV1::Ready {
                packet: Box::new(packet),
            },
            schema: WorkerResponseSchemaV1::EngineWorkerResponse,
            version: ContractVersionV1,
        }
    }

    fn error(code: WorkerErrorCodeV1, message: impl Into<String>) -> Self {
        Self {
            result: WorkerResultV1::Error {
                code,
                message: message.into(),
            },
            schema: WorkerResponseSchemaV1::EngineWorkerResponse,
            version: ContractVersionV1,
        }
    }
}

fn serialize_response(response: &WorkerResponseV1) -> Vec<u8> {
    let mut writer = BoundedWriter::new(MAX_WORKER_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, response).is_ok() {
        return writer.into_bytes();
    }
    let fallback = if writer.overflowed() {
        WorkerResponseV1::error(
            WorkerErrorCodeV1::ResponseTooLarge,
            "RenderPacket response exceeds the worker transfer limit",
        )
    } else {
        WorkerResponseV1::error(
            WorkerErrorCodeV1::SerializationFailed,
            "RenderPacket response could not be serialized",
        )
    };
    serde_json::to_vec(&fallback).unwrap_or_else(|_| {
        br#"{"result":{"kind":"error","code":"serialization-failed","message":"Engine response serialization failed"},"schema":"poietra.engine-worker-response","version":1}"#.to_vec()
    })
}

fn portable_id(value: &str) -> bool {
    portable_id_with_hash_policy(value, false)
}

fn portable_source_identity(value: &str) -> bool {
    portable_id_with_hash_policy(value, true)
}

fn portable_id_with_hash_policy(value: &str, allow_hash: bool) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
                || (allow_hash && byte == b'#')
        })
}

fn validate_bounded_unpadded_text(value: &str, maximum: usize) -> bool {
    let length = value.encode_utf16().count();
    length > 0
        && length <= maximum
        && value.trim() == value
        && !value.chars().any(|character| character.is_ascii_control())
}

fn validate_request(request: &SampleRequestV1) -> Result<(), &'static str> {
    if !validate_bounded_unpadded_text(&request.packet_id, MAX_ID_UTF16_UNITS_V1)
        || !portable_id(&request.packet_id)
    {
        return Err("packetId must use the bounded portable ASCII identifier subset");
    }
    if request.evidence.len() > MAX_EVIDENCE_ENTRIES_V1
        || request
            .evidence
            .iter()
            .any(|value| !validate_bounded_unpadded_text(value, MAX_EVIDENCE_UTF16_UNITS_V1))
    {
        return Err("evidence must contain at most 64 bounded unpadded entries");
    }
    if !request.sample_time.is_finite() || request.sample_time < 0.0 {
        return Err("sampleTime must be finite and non-negative");
    }
    let viewport_pixels =
        u64::from(request.viewport.width_px) * u64::from(request.viewport.height_px);
    if request.viewport.width_px == 0
        || request.viewport.height_px == 0
        || request.viewport.width_px > 16_384
        || request.viewport.height_px > 16_384
        || viewport_pixels > MAX_VIEWPORT_PIXELS_V1
    {
        return Err("viewport exceeds the v1 dimensions or pixel limit");
    }
    Ok(())
}

fn normalize_interaction_request(
    raw: &RawInteractionEntityIdsV1,
) -> NormalizedInteractionRequestV1 {
    let Some(value) = raw.0.as_deref() else {
        return NormalizedInteractionRequestV1::Disabled;
    };
    let Ok(values) = serde_json::from_str::<Vec<Box<RawValue>>>(value.get()) else {
        return NormalizedInteractionRequestV1::Unavailable;
    };
    if values.len() > MAX_INTERACTION_ENTITY_IDS_V1 {
        return NormalizedInteractionRequestV1::Unavailable;
    }

    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    let mut entries = values
        .iter()
        .map(|value| {
            let value = serde_json::from_str::<String>(value.get()).ok()?;
            if !validate_bounded_unpadded_text(&value, MAX_ID_UTF16_UNITS_V1)
                || !portable_source_identity(&value)
            {
                return None;
            }
            if !seen.insert(value.clone()) {
                duplicates.insert(value.clone());
            }
            Some(value)
        })
        .collect::<Vec<_>>();
    for entry in &mut entries {
        if entry
            .as_ref()
            .is_some_and(|entity_id| duplicates.contains(entity_id))
        {
            *entry = None;
        }
    }
    NormalizedInteractionRequestV1::Available(entries)
}

fn sample_interaction_request(
    request: NormalizedInteractionRequestV1,
    session: &EngineSessionV1,
    sample_time: f64,
) -> SampledInteractionRequestV1 {
    let entries = match request {
        NormalizedInteractionRequestV1::Disabled => {
            return SampledInteractionRequestV1::Disabled;
        }
        NormalizedInteractionRequestV1::Unavailable => {
            return SampledInteractionRequestV1::Unavailable;
        }
        NormalizedInteractionRequestV1::Available(entries) => entries,
    };
    let requested = entries
        .iter()
        .filter_map(|entity_id| entity_id.as_deref())
        .collect::<BTreeSet<_>>();
    let mut known = BTreeSet::new();
    let mut active = BTreeSet::new();
    for entity in &session.scene().entities {
        if !requested.contains(entity.id.as_str()) {
            continue;
        }
        known.insert(entity.id.as_str());
        if entity
            .lifetimes
            .iter()
            .any(|lifetime| sample_time >= lifetime.start && sample_time < lifetime.end)
        {
            active.insert(entity.id.as_str());
        }
    }
    SampledInteractionRequestV1::Available(
        entries
            .iter()
            .map(|entity_id| {
                let is_known = entity_id
                    .as_deref()
                    .is_some_and(|entity_id| known.contains(entity_id));
                let is_active = entity_id
                    .as_deref()
                    .is_some_and(|entity_id| active.contains(entity_id));
                SampledInteractionEntityV1 {
                    active: is_active,
                    entity_id: entity_id.clone(),
                    known: is_known,
                }
            })
            .collect(),
    )
}

/// Native core behind the exported WASM handle.
#[derive(Debug)]
pub struct EngineWorkerSessionV1 {
    session: EngineSessionV1,
}

impl EngineWorkerSessionV1 {
    /// Parses and retains one bounded Scene snapshot.
    ///
    /// # Errors
    ///
    /// Returns a contract or semantic validation error without retaining partial state.
    pub fn from_snapshot_json(snapshot_json: &[u8]) -> Result<Self, WorkerSessionError> {
        let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)?;
        Ok(Self {
            session: EngineSessionV1::new(bundle)?,
        })
    }

    /// Atomically validates and installs a new complete snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error and preserves the current snapshot on failure.
    pub fn replace_snapshot_json(
        &mut self,
        snapshot_json: &[u8],
    ) -> Result<(), WorkerSessionError> {
        let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)?;
        self.session.replace_snapshot(bundle)?;
        Ok(())
    }

    /// Atomically applies one bounded Studio-only Scene delta.
    ///
    /// # Errors
    ///
    /// Returns an error and preserves the retained Scene and index on failure.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn apply_scene_delta_json(
        &mut self,
        delta_json: &[u8],
        expected_base_revision: &str,
        expected_next_revision: &str,
    ) -> Result<Vec<u8>, SceneDeltaErrorV1> {
        apply_scene_delta_json(
            &mut self.session,
            delta_json,
            expected_base_revision,
            expected_next_revision,
        )
    }

    /// Parses, validates, and evaluates one bounded request into a typed packet.
    ///
    /// The worker response and canvas renderer both use this path so the canvas
    /// renderer never serializes and reparses an intermediate `RenderPacket`.
    pub(crate) fn sample_packet_json(
        &self,
        request_json: &[u8],
    ) -> Result<SampledRenderPacketV1, SamplePacketErrorV1> {
        if request_json.len() > MAX_SAMPLE_REQUEST_JSON_BYTES_V1 {
            return Err(SamplePacketErrorV1::without_correlation(
                SamplePacketErrorCodeV1::InvalidRequest,
                format!(
                    "sample request contains {} bytes; maximum is {MAX_SAMPLE_REQUEST_JSON_BYTES_V1}",
                    request_json.len()
                ),
            ));
        }
        let request: SampleRequestV1 = serde_json::from_slice(request_json).map_err(|error| {
            SamplePacketErrorV1::without_correlation(
                SamplePacketErrorCodeV1::InvalidRequest,
                format!("invalid sample request JSON: {error}"),
            )
        })?;
        if let Err(message) = validate_request(&request) {
            return Err(SamplePacketErrorV1::without_correlation(
                SamplePacketErrorCodeV1::InvalidRequest,
                message,
            ));
        }
        let interaction_request = normalize_interaction_request(&request.interaction_entity_ids);
        let correlation = SampleRequestCorrelationV1 {
            packet_id: request.packet_id.clone(),
            sample_time: request.sample_time,
            viewport: request.viewport.clone(),
        };
        let packet = self
            .session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &request.evidence,
                packet_id: &request.packet_id,
                sample_time: request.sample_time,
                viewport: request.viewport,
            })
            .map_err(|error| {
                let code = if matches!(error, EvaluationError::InvalidInput(_)) {
                    SamplePacketErrorCodeV1::InvalidRequest
                } else {
                    SamplePacketErrorCodeV1::EvaluationFailed
                };
                SamplePacketErrorV1::with_correlation(code, error.to_string(), correlation.clone())
            })?;
        let interaction =
            sample_interaction_request(interaction_request, &self.session, packet.sample_time);
        Ok(SampledRenderPacketV1 {
            correlation,
            interaction,
            packet,
        })
    }

    /// Evaluates one small playhead request and always returns a versioned response.
    #[must_use]
    pub fn sample_json(&self, request_json: &[u8]) -> Vec<u8> {
        match self.sample_packet_json(request_json) {
            Ok(sampled) => serialize_response(&WorkerResponseV1::ready(sampled.packet)),
            Err(error) => {
                let code = match error.code {
                    SamplePacketErrorCodeV1::EvaluationFailed => {
                        WorkerErrorCodeV1::EvaluationFailed
                    }
                    SamplePacketErrorCodeV1::InvalidRequest => WorkerErrorCodeV1::InvalidRequest,
                };
                serialize_response(&WorkerResponseV1::error(code, error.message))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_sample_time_preserves_the_javascript_binary64_value() {
        let request: SampleRequestV1 = serde_json::from_slice(
            br#"{"evidence":[],"packetId":"frame:roundtrip","sampleTime":2.2661000000000002,"schema":"poietra.engine-sample-request","version":1,"viewport":{"heightPx":1080,"widthPx":1920}}"#,
        )
        .unwrap();

        assert_eq!(
            request.sample_time.to_bits(),
            2.266_100_000_000_000_2_f64.to_bits()
        );
    }
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/shared-circle-opacity.json");
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn snapshot(fixture: &Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap()
    }

    fn sample_request() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "evidence": ["Poietra WASM protocol fixture v1"],
            "packetId": "wasm:midpoint",
            "sampleTime": 1,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 },
        }))
        .unwrap()
    }

    fn sample_request_with_interaction(interaction_entity_ids: &Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "evidence": ["Poietra WASM protocol fixture v1"],
            "interactionEntityIds": interaction_entity_ids,
            "packetId": "wasm:interaction",
            "sampleTime": 1,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 },
        }))
        .unwrap()
    }

    #[test]
    fn retained_session_returns_only_the_sampled_packet() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let response: Value =
            serde_json::from_slice(&session.sample_json(&sample_request())).unwrap();
        assert_eq!(response["schema"], "poietra.engine-worker-response");
        assert_eq!(response["result"]["kind"], "ready");
        assert_eq!(
            response["result"]["packet"]["draws"][0]["entityId"],
            "earlier"
        );
        assert!(response["result"].get("scene").is_none());
        assert!(response["result"].get("assets").is_none());
    }

    #[test]
    fn typed_sample_path_preserves_request_correlation_without_json_round_trip() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let sampled = session.sample_packet_json(&sample_request()).unwrap();

        assert_eq!(sampled.correlation.packet_id, "wasm:midpoint");
        assert!((sampled.correlation.sample_time - 1.0).abs() < f64::EPSILON);
        assert_eq!(sampled.correlation.viewport.width_px, 160);
        assert_eq!(sampled.packet.packet_id, sampled.correlation.packet_id);
        assert!(
            (sampled.packet.sample_time - sampled.correlation.sample_time).abs() < f64::EPSILON
        );
        assert_eq!(sampled.packet.viewport, sampled.correlation.viewport);
        assert_eq!(sampled.interaction, SampledInteractionRequestV1::Disabled);
    }

    #[test]
    fn interaction_items_are_verified_without_rejecting_the_pixel_sample() {
        let mut fixture = fixture();
        fixture["scene"]["entities"][0]["lifetimes"][0]["end"] = json!(0.5);
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let request = sample_request_with_interaction(&json!([
            "earlier",
            "later",
            "missing",
            "earlier",
            "bad id!",
            7,
            "source#missing"
        ]));

        let sampled = session.sample_packet_json(&request).unwrap();
        assert_eq!(sampled.packet.draws[0].entity_id(), "earlier");
        let SampledInteractionRequestV1::Available(entries) = sampled.interaction else {
            panic!("bounded interaction request must remain available");
        };
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[0].entity_id, None);
        assert!(!entries[0].known);
        assert!(!entries[0].active);
        assert_eq!(
            entries[1],
            SampledInteractionEntityV1 {
                active: false,
                entity_id: Some("later".to_owned()),
                known: true,
            }
        );
        assert_eq!(entries[2].entity_id.as_deref(), Some("missing"));
        assert!(!entries[2].known);
        assert_eq!(entries[3].entity_id, None);
        assert_eq!(entries[4].entity_id, None);
        assert_eq!(entries[5].entity_id, None);
        assert_eq!(entries[6].entity_id.as_deref(), Some("source#missing"));
    }

    #[test]
    fn malformed_or_oversized_interaction_envelopes_do_not_fail_pixel_sampling() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let exactly_maximum = (0..MAX_INTERACTION_ENTITY_IDS_V1)
            .map(|index| format!("missing:{index}"))
            .collect::<Vec<_>>();
        let sampled = session
            .sample_packet_json(&sample_request_with_interaction(&json!(exactly_maximum)))
            .unwrap();
        assert!(matches!(
            sampled.interaction,
            SampledInteractionRequestV1::Available(ref entries)
                if entries.len() == MAX_INTERACTION_ENTITY_IDS_V1
        ));

        let oversized = (0..=MAX_INTERACTION_ENTITY_IDS_V1)
            .map(|index| format!("missing:{index}"))
            .collect::<Vec<_>>();
        for metadata in [json!(oversized), json!({ "not": "an array" }), Value::Null] {
            let sampled = session
                .sample_packet_json(&sample_request_with_interaction(&metadata))
                .unwrap();
            assert_eq!(
                sampled.interaction,
                SampledInteractionRequestV1::Unavailable
            );
            assert!(!sampled.packet.draws.is_empty());
        }
    }

    #[test]
    fn out_of_range_interaction_number_degrades_only_that_entry() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let request = br#"{
            "evidence":["Poietra WASM protocol fixture v1"],
            "interactionEntityIds":["earlier",1e400,"later"],
            "packetId":"wasm:interaction",
            "sampleTime":1,
            "schema":"poietra.engine-sample-request",
            "version":1,
            "viewport":{"heightPx":90,"widthPx":160}
        }"#;

        let sampled = session.sample_packet_json(request).unwrap();
        let SampledInteractionRequestV1::Available(entries) = sampled.interaction else {
            panic!("a malformed optional item must not reject pixel sampling");
        };
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].entity_id.as_deref(), Some("earlier"));
        assert!(entries[0].known && entries[0].active);
        assert_eq!(entries[1].entity_id, None);
        assert_eq!(entries[2].entity_id.as_deref(), Some("later"));
        assert!(entries[2].known && entries[2].active);
        assert!(!sampled.packet.draws.is_empty());
    }

    #[test]
    fn structurally_invalid_request_never_becomes_response_correlation() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let invalid = serde_json::to_vec(&json!({
            "evidence": [],
            "packetId": " padded ",
            "sampleTime": -1,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 0, "widthPx": 160 },
        }))
        .unwrap();

        let error = session.sample_packet_json(&invalid).unwrap_err();
        assert_eq!(error.code, SamplePacketErrorCodeV1::InvalidRequest);
        assert!(error.correlation.is_none());
    }

    #[test]
    fn malformed_or_oversized_sample_requests_fail_closed() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let malformed: Value =
            serde_json::from_slice(&session.sample_json(br#"{"schema":"future","version":1}"#))
                .unwrap();
        assert_eq!(malformed["result"]["code"], "invalid-request");

        let oversized = vec![b' '; MAX_SAMPLE_REQUEST_JSON_BYTES_V1 + 1];
        let rejected: Value = serde_json::from_slice(&session.sample_json(&oversized)).unwrap();
        assert_eq!(rejected["result"]["code"], "invalid-request");
    }

    #[test]
    fn contract_valid_maximum_evidence_fits_the_sample_envelope() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let request = serde_json::to_vec(&json!({
            "evidence": vec!["€".repeat(MAX_EVIDENCE_UTF16_UNITS_V1); MAX_EVIDENCE_ENTRIES_V1],
            "packetId": "wasm:maximum-evidence",
            "sampleTime": 1,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 },
        }))
        .unwrap();
        assert!(request.len() > 64 * 1024);
        assert!(request.len() <= MAX_SAMPLE_REQUEST_JSON_BYTES_V1);

        let response: Value = serde_json::from_slice(&session.sample_json(&request)).unwrap();
        assert_eq!(response["result"]["kind"], "ready");
    }

    #[test]
    fn invalid_playhead_is_classified_as_an_invalid_request() {
        let fixture = fixture();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let request = serde_json::to_vec(&json!({
            "evidence": [],
            "packetId": "wasm:outside-duration",
            "sampleTime": 3,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 },
        }))
        .unwrap();

        let response: Value = serde_json::from_slice(&session.sample_json(&request)).unwrap();
        assert_eq!(response["result"]["code"], "invalid-request");
    }

    #[test]
    fn invalid_snapshot_replacement_preserves_the_current_scene() {
        let fixture = fixture();
        let mut session = EngineWorkerSessionV1::from_snapshot_json(&snapshot(&fixture)).unwrap();
        let mut invalid = snapshot(&fixture);
        invalid.extend_from_slice(&vec![b' '; poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1]);
        assert!(session.replace_snapshot_json(&invalid).is_err());

        let response: Value =
            serde_json::from_slice(&session.sample_json(&sample_request())).unwrap();
        assert_eq!(response["result"]["kind"], "ready");
    }
}
