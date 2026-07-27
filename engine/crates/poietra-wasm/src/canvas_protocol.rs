use poietra_scene_ir::{ContractVersionV1, ViewportV1};
use serde::Serialize;

use crate::bounded_writer::BoundedWriter;
use crate::protocol::{SamplePacketErrorCodeV1, SamplePacketErrorV1, SampleRequestCorrelationV1};

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
        packet_id: String,
        sample_time: f64,
        suboptimal: bool,
        viewport: ViewportV1,
    },
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

fn response(
    result: CanvasRenderResultV1,
    fallback_correlation: Option<&SampleRequestCorrelationV1>,
) -> Vec<u8> {
    let response = CanvasRenderResponseV1 {
        result,
        schema: CanvasRenderResponseSchemaV1::CanvasRenderResponse,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return writer.into_bytes();
    }

    let code = if writer.overflowed() {
        CanvasRenderErrorCodeV1::ResponseTooLarge
    } else {
        CanvasRenderErrorCodeV1::SerializationFailed
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
        packet_id: correlation.packet_id.clone(),
        sample_time: correlation.sample_time,
        suboptimal,
        viewport: correlation.viewport.clone(),
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
    use serde_json::Value;
    use serde_json::json;

    use crate::protocol::EngineWorkerSessionV1;

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
