//! Pure contract types for the browser MP4 export progress envelope (#723).
//!
//! Everything here is browser-independent so it can be unit tested on native
//! targets: the bounded JSON progress envelope the export loop reports and the
//! stable wire name of the user-intent cancellation refusal. The wasm32-only
//! `browser_export` module owns the actual export composition and callback.

use serde::Serialize;

use crate::bounded_writer::BoundedWriter;

/// Progress envelopes carry three bounded counters only; MP4 bytes never
/// travel through JSON. Mirrored by the TypeScript worker protocol.
pub const MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1: usize = 16 * 1024;

/// Stable wire name of the user-intent cancellation refusal. It prefixes the
/// named `PoietraBrowserMp4ExportRefused` rejection exactly like every other
/// fail-closed reason, and the session discards everything it collected.
pub(crate) const BROWSER_EXPORT_CANCELLED_REASON_V1: &str = "cancelled";

#[derive(Clone, Copy, Debug, Serialize)]
enum BrowserExportProgressSchemaV1 {
    #[serde(rename = "poietra.browser-export-progress")]
    BrowserExportProgress,
}

/// One in-flight progress report from the export loop: frames encoded out of
/// the total sampling grid, plus the encoded media bytes retained so far.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserExportProgressV1 {
    pub(crate) encoded_media_bytes: u64,
    pub(crate) frame_count: u64,
    pub(crate) frames_encoded: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserExportProgressResultV1 {
    encoded_media_bytes: u64,
    frame_count: u64,
    frames_encoded: u64,
    kind: BrowserExportProgressKindV1,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum BrowserExportProgressKindV1 {
    #[serde(rename = "progress")]
    Progress,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserExportProgressEnvelopeV1 {
    result: BrowserExportProgressResultV1,
    schema: BrowserExportProgressSchemaV1,
    version: poietra_scene_ir::ContractVersionV1,
}

/// Serializes one progress report within the response bound.
///
/// Three bounded integers cannot overflow the limit; the deterministic
/// `format!` fallback keeps the same envelope shape (and the same truthful
/// counters) even if serde serialization were ever to fail.
pub(crate) fn browser_export_progress_envelope_v1(progress: BrowserExportProgressV1) -> Vec<u8> {
    let envelope = BrowserExportProgressEnvelopeV1 {
        result: BrowserExportProgressResultV1 {
            encoded_media_bytes: progress.encoded_media_bytes,
            frame_count: progress.frame_count,
            frames_encoded: progress.frames_encoded,
            kind: BrowserExportProgressKindV1::Progress,
        },
        schema: BrowserExportProgressSchemaV1::BrowserExportProgress,
        version: poietra_scene_ir::ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &envelope).is_ok() {
        return writer.into_bytes();
    }
    let BrowserExportProgressV1 {
        encoded_media_bytes,
        frame_count,
        frames_encoded,
    } = progress;
    format!(
        r#"{{"result":{{"encodedMediaBytes":{encoded_media_bytes},"frameCount":{frame_count},"framesEncoded":{frames_encoded},"kind":"progress"}},"schema":"poietra.browser-export-progress","version":1}}"#
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn progress_envelope_is_versioned_bounded_camel_case_json() {
        let envelope = browser_export_progress_envelope_v1(BrowserExportProgressV1 {
            encoded_media_bytes: 4_096,
            frame_count: 60,
            frames_encoded: 30,
        });
        assert!(envelope.len() <= MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&envelope).unwrap();
        assert_eq!(value["schema"], "poietra.browser-export-progress");
        assert_eq!(value["version"], 1);
        assert_eq!(value["result"]["kind"], "progress");
        assert_eq!(value["result"]["encodedMediaBytes"], 4_096);
        assert_eq!(value["result"]["frameCount"], 60);
        assert_eq!(value["result"]["framesEncoded"], 30);
    }

    #[test]
    fn progress_envelope_stays_bounded_at_the_integer_extremes() {
        let envelope = browser_export_progress_envelope_v1(BrowserExportProgressV1 {
            encoded_media_bytes: u64::MAX,
            frame_count: u64::MAX,
            frames_encoded: u64::MAX,
        });
        assert!(envelope.len() <= MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1);
        let value: Value = serde_json::from_slice(&envelope).unwrap();
        assert_eq!(value["result"]["frameCount"], u64::MAX);
    }

    #[test]
    fn fallback_serialization_reports_the_same_truthful_envelope() {
        let progress = BrowserExportProgressV1 {
            encoded_media_bytes: 7,
            frame_count: 2,
            frames_encoded: 1,
        };
        let serde_bytes = browser_export_progress_envelope_v1(progress);
        let fallback =
            r#"{"result":{"encodedMediaBytes":7,"frameCount":2,"framesEncoded":1,"kind":"progress"},"schema":"poietra.browser-export-progress","version":1}"#.to_string();
        let serde_value: Value = serde_json::from_slice(&serde_bytes).unwrap();
        let fallback_value: Value = serde_json::from_str(&fallback).unwrap();
        assert_eq!(serde_value, fallback_value);
    }

    #[test]
    fn cancellation_reason_wire_name_is_stable() {
        assert_eq!(BROWSER_EXPORT_CANCELLED_REASON_V1, "cancelled");
    }
}
