use poietra_scene_ir::{ContractVersionV1, ViewportV1};
use serde::Serialize;

use crate::bounded_writer::BoundedWriter;
use crate::protocol::{
    SamplePacketErrorCodeV1, SamplePacketErrorV1, SampleRequestCorrelationV1,
    SampledInteractionRequestV1,
};

/// Canvas acknowledgements are deliberately much smaller than `RenderPacket` responses.
pub const MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1: usize = 16 * 1024;

const MAX_CANVAS_ERROR_MESSAGE_UTF16_UNITS_V1: usize = 2_048;

#[derive(Clone, Copy, Debug, Serialize)]
enum CanvasRenderResponseSchemaV1 {
    #[serde(rename = "poietra.canvas-render-response")]
    CanvasRenderResponse,
}

/// Stable failure codes consumed by the browser worker fallback policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum CanvasRenderErrorCodeV1 {
    #[serde(rename = "device-lost")]
    DeviceLost,
    #[serde(rename = "evaluation-failed")]
    EvaluationFailed,
    #[serde(rename = "gpu-internal")]
    GpuInternal,
    #[serde(rename = "gpu-out-of-memory")]
    GpuOutOfMemory,
    #[serde(rename = "gpu-validation")]
    GpuValidation,
    #[serde(rename = "invalid-request")]
    InvalidRequest,
    #[serde(rename = "response-too-large")]
    ResponseTooLarge,
    #[serde(rename = "serialization-failed")]
    SerializationFailed,
    #[serde(rename = "surface-lost")]
    SurfaceLost,
    #[serde(rename = "surface-occluded")]
    SurfaceOccluded,
    #[serde(rename = "surface-outdated")]
    SurfaceOutdated,
    #[serde(rename = "surface-timeout")]
    SurfaceTimeout,
    #[serde(rename = "surface-validation")]
    SurfaceValidation,
    #[serde(rename = "unsupported-frame")]
    UnsupportedFrame,
}

pub(crate) fn gpu_error_code_from_js_class_name(class_name: &str) -> CanvasRenderErrorCodeV1 {
    match class_name {
        "GPUOutOfMemoryError" => CanvasRenderErrorCodeV1::GpuOutOfMemory,
        "GPUValidationError" => CanvasRenderErrorCodeV1::GpuValidation,
        _ => CanvasRenderErrorCodeV1::GpuInternal,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanvasRenderResponseV1 {
    result: CanvasRenderResultV1,
    schema: CanvasRenderResponseSchemaV1,
    version: ContractVersionV1,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) enum CanvasInteractionSpaceV1 {
    #[serde(rename = "clip-v1")]
    ClipV1,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum CanvasInteractionEntryV1 {
    Present { bounds: [f32; 4] },
    Inactive,
    Empty,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum CanvasInteractionMetadataV1 {
    Available {
        entries: Vec<CanvasInteractionEntryV1>,
        space: CanvasInteractionSpaceV1,
    },
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CanvasRenderResultV1 {
    Error {
        code: CanvasRenderErrorCodeV1,
        message: String,
        packet_id: Option<String>,
        sample_time: Option<f64>,
        viewport: Option<ViewportV1>,
    },
    Presented {
        #[serde(skip_serializing_if = "Option::is_none")]
        interaction: Option<CanvasInteractionMetadataV1>,
        packet_id: String,
        sample_time: f64,
        suboptimal: bool,
        viewport: ViewportV1,
    },
}

#[derive(Clone, Copy, Debug)]
enum ResponseSerializationFailureV1 {
    ResponseTooLarge,
    SerializationFailed,
}

pub(crate) fn truncate_utf16(value: &str, maximum: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|character| {
            let next = used + character.len_utf16();
            if next > maximum {
                return false;
            }
            used = next;
            true
        })
        .collect()
}

fn try_response(result: CanvasRenderResultV1) -> Result<Vec<u8>, ResponseSerializationFailureV1> {
    let response = CanvasRenderResponseV1 {
        result,
        schema: CanvasRenderResponseSchemaV1::CanvasRenderResponse,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return Ok(writer.into_bytes());
    }

    Err(if writer.overflowed() {
        ResponseSerializationFailureV1::ResponseTooLarge
    } else {
        ResponseSerializationFailureV1::SerializationFailed
    })
}

fn response(
    result: CanvasRenderResultV1,
    fallback_correlation: Option<&SampleRequestCorrelationV1>,
) -> Vec<u8> {
    let failure = match try_response(result) {
        Ok(response) => return response,
        Err(failure) => failure,
    };

    let code = match failure {
        ResponseSerializationFailureV1::ResponseTooLarge => {
            CanvasRenderErrorCodeV1::ResponseTooLarge
        }
        ResponseSerializationFailureV1::SerializationFailed => {
            CanvasRenderErrorCodeV1::SerializationFailed
        }
    };
    let fallback = CanvasRenderResponseV1 {
        result: CanvasRenderResultV1::Error {
            code,
            message: "Canvas response could not be serialized within the v1 limit".to_owned(),
            packet_id: fallback_correlation.map(|value| value.packet_id.clone()),
            sample_time: fallback_correlation.map(|value| value.sample_time),
            viewport: fallback_correlation.map(|value| value.viewport.clone()),
        },
        schema: CanvasRenderResponseSchemaV1::CanvasRenderResponse,
        version: ContractVersionV1,
    };
    serde_json::to_vec(&fallback).unwrap_or_else(|_| {
        br#"{"result":{"kind":"error","code":"serialization-failed","message":"Canvas response serialization failed","packetId":null,"sampleTime":null,"viewport":null},"schema":"poietra.canvas-render-response","version":1}"#.to_vec()
    })
}

pub(crate) fn presented_result(
    correlation: &SampleRequestCorrelationV1,
    suboptimal: bool,
) -> CanvasRenderResultV1 {
    CanvasRenderResultV1::Presented {
        interaction: None,
        packet_id: correlation.packet_id.clone(),
        sample_time: correlation.sample_time,
        suboptimal,
        viewport: correlation.viewport.clone(),
    }
}

fn presented_result_with_interaction(
    correlation: &SampleRequestCorrelationV1,
    suboptimal: bool,
    interaction: CanvasInteractionMetadataV1,
) -> CanvasRenderResultV1 {
    CanvasRenderResultV1::Presented {
        interaction: Some(interaction),
        packet_id: correlation.packet_id.clone(),
        sample_time: correlation.sample_time,
        suboptimal,
        viewport: correlation.viewport.clone(),
    }
}

pub(crate) fn interaction_metadata(
    request: &SampledInteractionRequestV1,
    mut bounds_for_entity: impl FnMut(&str) -> Option<[f32; 4]>,
) -> Option<CanvasInteractionMetadataV1> {
    match request {
        SampledInteractionRequestV1::Disabled => None,
        SampledInteractionRequestV1::Unavailable => Some(CanvasInteractionMetadataV1::Unavailable),
        SampledInteractionRequestV1::Available(requested) => {
            let entries = requested
                .iter()
                .map(|requested| {
                    let Some(entity_id) = requested.entity_id.as_deref() else {
                        return CanvasInteractionEntryV1::Unavailable;
                    };
                    if !requested.known {
                        return CanvasInteractionEntryV1::Unavailable;
                    }
                    if !requested.active {
                        return CanvasInteractionEntryV1::Inactive;
                    }
                    let Some(bounds) = bounds_for_entity(entity_id) else {
                        return CanvasInteractionEntryV1::Empty;
                    };
                    if bounds.iter().all(|value| value.is_finite())
                        && bounds[0] <= bounds[2]
                        && bounds[1] <= bounds[3]
                    {
                        CanvasInteractionEntryV1::Present { bounds }
                    } else {
                        CanvasInteractionEntryV1::Unavailable
                    }
                })
                .collect();
            Some(CanvasInteractionMetadataV1::Available {
                entries,
                space: CanvasInteractionSpaceV1::ClipV1,
            })
        }
    }
}

pub(crate) fn error_result(
    code: CanvasRenderErrorCodeV1,
    message: &str,
    correlation: Option<&SampleRequestCorrelationV1>,
) -> CanvasRenderResultV1 {
    let message = truncate_utf16(message, MAX_CANVAS_ERROR_MESSAGE_UTF16_UNITS_V1);
    let message = if message.is_empty() {
        "Canvas rendering failed".to_owned()
    } else {
        message
    };
    CanvasRenderResultV1::Error {
        code,
        message,
        packet_id: correlation.map(|value| value.packet_id.clone()),
        sample_time: correlation.map(|value| value.sample_time),
        viewport: correlation.map(|value| value.viewport.clone()),
    }
}

pub(crate) fn presented_response(
    correlation: &SampleRequestCorrelationV1,
    suboptimal: bool,
) -> Vec<u8> {
    response(presented_result(correlation, suboptimal), Some(correlation))
}

/// Serializes an opt-in interaction acknowledgement without letting advisory
/// metadata reverse an already successful pixel presentation. If the enriched
/// response cannot fit, the same `presented` acknowledgement is retried without
/// the optional field.
pub(crate) fn presented_response_with_interaction(
    correlation: &SampleRequestCorrelationV1,
    suboptimal: bool,
    interaction: Option<CanvasInteractionMetadataV1>,
) -> Vec<u8> {
    let Some(interaction) = interaction else {
        return presented_response(correlation, suboptimal);
    };
    match try_response(presented_result_with_interaction(
        correlation,
        suboptimal,
        interaction,
    )) {
        Ok(response) => response,
        Err(_) => presented_response(correlation, suboptimal),
    }
}

pub(crate) fn error_response(
    code: CanvasRenderErrorCodeV1,
    message: &str,
    correlation: Option<&SampleRequestCorrelationV1>,
) -> Vec<u8> {
    response(error_result(code, message, correlation), correlation)
}

pub(crate) fn sample_error_code(code: SamplePacketErrorCodeV1) -> CanvasRenderErrorCodeV1 {
    match code {
        SamplePacketErrorCodeV1::EvaluationFailed => CanvasRenderErrorCodeV1::EvaluationFailed,
        SamplePacketErrorCodeV1::InvalidRequest => CanvasRenderErrorCodeV1::InvalidRequest,
    }
}

pub(crate) fn sample_error_response(error: &SamplePacketErrorV1) -> Vec<u8> {
    error_response(
        sample_error_code(error.code),
        &error.message,
        error.correlation.as_ref(),
    )
}

pub(crate) fn surface_configuration_required(
    configured: Option<&ViewportV1>,
    requested: &ViewportV1,
    force: bool,
) -> bool {
    force || configured != Some(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use poietra_scene_ir::{RenderDrawV1, RenderEmptyReasonV1};
    use serde_json::Value;
    use serde_json::json;

    use crate::protocol::{
        EngineWorkerSessionV1, MAX_INTERACTION_ENTITY_IDS_V1, SampledInteractionEntityV1,
    };

    fn fixture_session() -> EngineWorkerSessionV1 {
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../fixtures/engine-v1/shared-circle-opacity.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let snapshot = serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap();
        EngineWorkerSessionV1::from_snapshot_json(&snapshot).unwrap()
    }

    fn correlation() -> SampleRequestCorrelationV1 {
        SampleRequestCorrelationV1 {
            packet_id: "canvas:frame-7".to_owned(),
            sample_time: 1.25,
            viewport: ViewportV1 {
                height_px: 720,
                width_px: 1_280,
            },
        }
    }

    #[test]
    fn presented_response_contains_only_bounded_frame_correlation() {
        let response = presented_response(&correlation(), true);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
        assert_eq!(value["schema"], "poietra.canvas-render-response");
        assert_eq!(value["version"], 1);
        assert_eq!(value["result"]["kind"], "presented");
        assert_eq!(value["result"]["packetId"], "canvas:frame-7");
        assert_eq!(value["result"]["sampleTime"], 1.25);
        assert_eq!(value["result"]["viewport"]["widthPx"], 1_280);
        assert_eq!(value["result"]["suboptimal"], true);
        assert!(value["result"].get("packet").is_none());
        assert!(value["result"].get("interaction").is_none());
    }

    #[test]
    fn interaction_entries_preserve_request_order_and_explicit_statuses() {
        let request = SampledInteractionRequestV1::Available(vec![
            SampledInteractionEntityV1 {
                active: true,
                entity_id: Some("present".to_owned()),
                known: true,
            },
            SampledInteractionEntityV1 {
                active: false,
                entity_id: Some("inactive".to_owned()),
                known: true,
            },
            SampledInteractionEntityV1 {
                active: false,
                entity_id: Some("unknown".to_owned()),
                known: false,
            },
            SampledInteractionEntityV1 {
                active: false,
                entity_id: None,
                known: false,
            },
            SampledInteractionEntityV1 {
                active: true,
                entity_id: Some("empty".to_owned()),
                known: true,
            },
            SampledInteractionEntityV1 {
                active: true,
                entity_id: Some("invalid-bounds".to_owned()),
                known: true,
            },
        ]);
        let metadata = interaction_metadata(&request, |entity_id| match entity_id {
            "present" => Some([-0.75, -0.5, 0.25, 0.5]),
            "invalid-bounds" => Some([f32::NAN, 0.0, 1.0, 1.0]),
            _ => None,
        });
        let response = presented_response_with_interaction(&correlation(), false, metadata);
        let value: Value = serde_json::from_slice(&response).unwrap();
        let interaction = &value["result"]["interaction"];

        assert_eq!(interaction["status"], "available");
        assert_eq!(interaction["space"], "clip-v1");
        assert_eq!(interaction["entries"][0]["status"], "present");
        assert_eq!(
            interaction["entries"][0]["bounds"],
            json!([-0.75, -0.5, 0.25, 0.5])
        );
        assert_eq!(interaction["entries"][1]["status"], "inactive");
        assert_eq!(interaction["entries"][2]["status"], "unavailable");
        assert_eq!(interaction["entries"][3]["status"], "unavailable");
        assert_eq!(interaction["entries"][4]["status"], "empty");
        assert_eq!(interaction["entries"][5]["status"], "unavailable");
    }

    #[test]
    fn sampled_zero_trim_reports_empty_while_lifetime_and_other_bounds_survive() {
        let mut fixture: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../fixtures/engine-v1/generic-stroke-topology.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let channels = fixture["scene"]["animationChannels"]
            .as_array_mut()
            .unwrap();
        let trim = channels
            .iter_mut()
            .find(|channel| channel["kind"] == "path-trim" && channel["entityId"] == "curve")
            .unwrap();
        trim["keyframes"][0]["value"] = json!(0);
        let entities = fixture["scene"]["entities"].as_array_mut().unwrap();
        let inactive = entities
            .iter_mut()
            .find(|entity| entity["id"] == "joined")
            .unwrap();
        inactive["lifetimes"] = json!([{ "end": 1, "start": 0.5 }]);
        let snapshot = serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap();
        let session = EngineWorkerSessionV1::from_snapshot_json(&snapshot).unwrap();
        let request = serde_json::to_vec(&json!({
            "evidence": [],
            "interactionEntityIds": ["curve", "joined", "combined"],
            "packetId": "canvas:zero-trim",
            "sampleTime": 0,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 900, "widthPx": 1600 },
        }))
        .unwrap();

        let sampled = session.sample_packet_json(&request).unwrap();
        assert!(matches!(
            sampled.packet.draws.first(),
            Some(RenderDrawV1::Empty {
                reason: RenderEmptyReasonV1::PathTrimZero,
                ..
            })
        ));
        let interaction = interaction_metadata(&sampled.interaction, |entity_id| {
            (entity_id == "combined").then_some([-0.5, -0.5, 0.5, 0.5])
        });
        let response =
            presented_response_with_interaction(&sampled.correlation, false, interaction);
        let value: Value = serde_json::from_slice(&response).unwrap();
        let entries = &value["result"]["interaction"]["entries"];
        assert_eq!(entries[0]["status"], "empty");
        assert_eq!(entries[1]["status"], "inactive");
        assert_eq!(entries[2]["status"], "present");
    }

    #[test]
    fn maximum_interaction_response_fits_the_canvas_acknowledgement_budget() {
        let requested = (0..MAX_INTERACTION_ENTITY_IDS_V1)
            .map(|index| SampledInteractionEntityV1 {
                active: true,
                entity_id: Some(format!("entity:{index}")),
                known: true,
            })
            .collect();
        let metadata =
            interaction_metadata(&SampledInteractionRequestV1::Available(requested), |_| {
                Some([-f32::MAX, -f32::MAX, f32::MAX, f32::MAX])
            });
        let maximum_correlation = SampleRequestCorrelationV1 {
            packet_id: "p".repeat(240),
            sample_time: f64::MAX,
            viewport: ViewportV1 {
                height_px: 16_384,
                width_px: 16_384,
            },
        };
        let response = presented_response_with_interaction(&maximum_correlation, false, metadata);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
        assert_eq!(value["result"]["kind"], "presented");
        assert_eq!(value["result"]["interaction"]["status"], "available");
        assert_eq!(
            value["result"]["interaction"]["entries"]
                .as_array()
                .unwrap()
                .len(),
            MAX_INTERACTION_ENTITY_IDS_V1
        );
        assert!(!String::from_utf8(response).unwrap().contains("entity:127"));
    }

    #[test]
    fn oversized_optional_metadata_falls_back_to_the_presented_pixel_ack() {
        let interaction = CanvasInteractionMetadataV1::Available {
            entries: vec![
                CanvasInteractionEntryV1::Present {
                    bounds: [-1.0, -1.0, 1.0, 1.0],
                };
                10_000
            ],
            space: CanvasInteractionSpaceV1::ClipV1,
        };
        let response =
            presented_response_with_interaction(&correlation(), false, Some(interaction));
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
        assert_eq!(value["result"]["kind"], "presented");
        assert!(value["result"].get("interaction").is_none());
    }

    #[test]
    fn unusable_interaction_envelope_is_reported_without_failing_presentation() {
        let metadata = interaction_metadata(&SampledInteractionRequestV1::Unavailable, |_| None);
        let response = presented_response_with_interaction(&correlation(), false, metadata);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(value["result"]["kind"], "presented");
        assert_eq!(value["result"]["interaction"]["status"], "unavailable");
    }

    #[test]
    fn error_response_has_explicit_nullable_correlation_and_truncated_message() {
        let response = error_response(
            CanvasRenderErrorCodeV1::InvalidRequest,
            &"🦀".repeat(MAX_CANVAS_ERROR_MESSAGE_UTF16_UNITS_V1),
            None,
        );
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
        assert_eq!(value["result"]["kind"], "error");
        assert_eq!(value["result"]["code"], "invalid-request");
        assert_eq!(value["result"]["packetId"], Value::Null);
        assert_eq!(value["result"]["sampleTime"], Value::Null);
        assert_eq!(value["result"]["viewport"], Value::Null);
        assert_eq!(
            value["result"]["message"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            MAX_CANVAS_ERROR_MESSAGE_UTF16_UNITS_V1
        );
    }

    #[test]
    fn all_stable_error_codes_have_the_expected_wire_names() {
        let cases = [
            (CanvasRenderErrorCodeV1::DeviceLost, "device-lost"),
            (
                CanvasRenderErrorCodeV1::EvaluationFailed,
                "evaluation-failed",
            ),
            (CanvasRenderErrorCodeV1::GpuInternal, "gpu-internal"),
            (CanvasRenderErrorCodeV1::GpuOutOfMemory, "gpu-out-of-memory"),
            (CanvasRenderErrorCodeV1::GpuValidation, "gpu-validation"),
            (CanvasRenderErrorCodeV1::InvalidRequest, "invalid-request"),
            (
                CanvasRenderErrorCodeV1::ResponseTooLarge,
                "response-too-large",
            ),
            (
                CanvasRenderErrorCodeV1::SerializationFailed,
                "serialization-failed",
            ),
            (CanvasRenderErrorCodeV1::SurfaceLost, "surface-lost"),
            (CanvasRenderErrorCodeV1::SurfaceOccluded, "surface-occluded"),
            (CanvasRenderErrorCodeV1::SurfaceOutdated, "surface-outdated"),
            (CanvasRenderErrorCodeV1::SurfaceTimeout, "surface-timeout"),
            (
                CanvasRenderErrorCodeV1::SurfaceValidation,
                "surface-validation",
            ),
            (
                CanvasRenderErrorCodeV1::UnsupportedFrame,
                "unsupported-frame",
            ),
        ];

        for (code, expected) in cases {
            assert_eq!(serde_json::to_value(code).unwrap(), expected);
        }
    }

    #[test]
    fn browser_gpu_error_constructor_names_map_without_an_error_name_property() {
        assert_eq!(
            gpu_error_code_from_js_class_name("GPUValidationError"),
            CanvasRenderErrorCodeV1::GpuValidation
        );
        assert_eq!(
            gpu_error_code_from_js_class_name("GPUOutOfMemoryError"),
            CanvasRenderErrorCodeV1::GpuOutOfMemory
        );
        assert_eq!(
            gpu_error_code_from_js_class_name("GPUInternalError"),
            CanvasRenderErrorCodeV1::GpuInternal
        );
        assert_eq!(
            gpu_error_code_from_js_class_name("UnexpectedGpuError"),
            CanvasRenderErrorCodeV1::GpuInternal
        );
    }

    #[test]
    fn typed_error_response_preserves_available_request_correlation() {
        let correlation = correlation();
        let response = error_response(
            CanvasRenderErrorCodeV1::UnsupportedFrame,
            "curved stroke rendering is outside the bounded paint slice",
            Some(&correlation),
        );
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(value["result"]["packetId"], correlation.packet_id);
        assert_eq!(value["result"]["sampleTime"], correlation.sample_time);
        assert_eq!(
            value["result"]["viewport"]["heightPx"],
            correlation.viewport.height_px
        );
    }

    #[test]
    fn empty_error_message_uses_a_nonempty_wire_fallback() {
        let response = error_response(CanvasRenderErrorCodeV1::GpuInternal, "", None);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(value["result"]["message"], "Canvas rendering failed");
    }

    #[test]
    fn invalid_direct_request_returns_a_strict_bounded_uncorrelated_error() {
        let invalid = serde_json::to_vec(&json!({
            "evidence": [],
            "packetId": "not portable!",
            "sampleTime": -1,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 0, "widthPx": 160 },
        }))
        .unwrap();
        let error = fixture_session().sample_packet_json(&invalid).unwrap_err();
        let response = sample_error_response(&error);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
        assert_eq!(value["schema"], "poietra.canvas-render-response");
        assert_eq!(value["result"]["kind"], "error");
        assert_eq!(value["result"]["code"], "invalid-request");
        assert_eq!(value["result"]["packetId"], Value::Null);
        assert_eq!(value["result"]["sampleTime"], Value::Null);
        assert_eq!(value["result"]["viewport"], Value::Null);
    }

    #[test]
    fn warm_surface_configuration_is_a_noop_unless_forced_or_resized() {
        let configured = correlation().viewport;
        assert!(!surface_configuration_required(
            Some(&configured),
            &configured,
            false
        ));
        assert!(surface_configuration_required(
            Some(&configured),
            &configured,
            true
        ));
        assert!(surface_configuration_required(
            Some(&configured),
            &ViewportV1 {
                height_px: 720,
                width_px: 1_281,
            },
            false
        ));
    }
}
