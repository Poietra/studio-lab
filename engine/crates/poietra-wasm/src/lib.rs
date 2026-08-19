//! Browser-facing retained Poietra Engine session.
//!
//! The JavaScript worker installs one validated Scene snapshot, then sends only
//! bounded playhead requests. The legacy sampling handle returns a `RenderPacket`;
//! the canvas handle keeps that packet in Rust and returns presentation metadata.

#[cfg(target_arch = "wasm32")]
mod audio_encoder;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod audio_encoder_protocol;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod audio_wav;
mod authoring;
mod bounded_writer;
#[cfg(target_arch = "wasm32")]
mod browser_export;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod browser_export_protocol;
#[cfg(target_arch = "wasm32")]
mod canvas;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_assets;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_protocol;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_telemetry;
#[cfg(target_arch = "wasm32")]
mod export_encoder;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod export_encoder_protocol;
mod export_verify;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod fragment_material_registry;
// Test-only browser proof for the offscreen async export readback (#718);
// superseded by the #721 export contract.
#[cfg(target_arch = "wasm32")]
mod export_readback_proof;
mod protocol;

use wasm_bindgen::prelude::*;

pub use authoring::{
    apply_static_root_transform_edit_v1, apply_studio_bound_entity_edit_v1,
    apply_studio_creation_edit_v1, apply_studio_fragment_materials_v1,
    apply_studio_math_tex_transform_edit_v1, apply_studio_motion_edit_v1,
    apply_studio_timeline_edit_v1, project_studio_creation_edit_v1,
    project_studio_math_tex_transform_v1, project_studio_motion_edit_v1,
    project_studio_timeline_v1,
};

pub use browser_export_protocol::MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1;
pub use canvas_protocol::MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1;
pub use canvas_telemetry::{
    MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES_V1, MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES_V1,
    POIETRA_CANVAS_TELEMETRY_ABI_VERSION_V4,
};
pub use export_encoder_protocol::{
    MAX_EXPORT_ENCODER_REQUEST_JSON_BYTES_V1, MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1,
    POIETRA_EXPORT_ENCODER_ABI_VERSION_V1,
};
pub use export_verify::{
    ExportProvenanceV1, MAX_EXPORT_VERIFY_RESPONSE_JSON_BYTES_V1,
    POIETRA_EXPORT_VERIFY_ABI_VERSION_V1, verify_export_mp4_v1,
};
pub use protocol::{
    EngineWorkerSessionV1, MAX_SAMPLE_REQUEST_JSON_BYTES_V1, MAX_WORKER_RESPONSE_JSON_BYTES_V1,
};

#[cfg(target_arch = "wasm32")]
pub use browser_export::{export_scene_mp4_v1, export_scene_mp4_with_wav_v1};
#[cfg(target_arch = "wasm32")]
pub use canvas::PoietraCanvasEngineV1;
#[cfg(target_arch = "wasm32")]
pub use export_encoder::{PoietraExportEncoderSessionV1, probe_export_encoder_h264_v1};

/// JavaScript/WASM module handshake version, independent of Scene IR revisions.
pub const POIETRA_ENGINE_ABI_VERSION: u32 = 33;
/// `OffscreenCanvas` render ABI version, independent of worker packet sampling.
pub const POIETRA_CANVAS_ABI_VERSION: u32 = 7;

/// Returns the worker ABI version before a session is constructed.
#[must_use]
#[wasm_bindgen(js_name = poietraEngineAbiVersion)]
pub fn poietra_engine_abi_version() -> u32 {
    POIETRA_ENGINE_ABI_VERSION
}

/// Returns the `OffscreenCanvas` ABI version before WebGPU initialization.
#[must_use]
#[wasm_bindgen(js_name = poietraCanvasAbiVersion)]
pub fn poietra_canvas_abi_version() -> u32 {
    POIETRA_CANVAS_ABI_VERSION
}

/// Returns the opt-in stage telemetry ABI version, independent of the base
/// canvas ABI so normal rendering never depends on telemetry support.
#[must_use]
#[wasm_bindgen(js_name = poietraCanvasTelemetryAbiVersion)]
pub fn poietra_canvas_telemetry_abi_version() -> u32 {
    POIETRA_CANVAS_TELEMETRY_ABI_VERSION_V4
}

/// Returns the `WebCodecs` export encoder ABI version, independent of the base
/// engine ABI so rendering never depends on encoder support.
#[must_use]
#[wasm_bindgen(js_name = poietraExportEncoderAbiVersion)]
pub fn poietra_export_encoder_abi_version() -> u32 {
    POIETRA_EXPORT_ENCODER_ABI_VERSION_V1
}

/// Returns the export MP4 verification ABI version.
#[must_use]
#[wasm_bindgen(js_name = poietraExportVerifyAbiVersion)]
pub fn poietra_export_verify_abi_version() -> u32 {
    POIETRA_EXPORT_VERIFY_ABI_VERSION_V1
}

/// Validates one complete Scene IR bundle with the canonical Rust contract.
///
/// # Errors
///
/// Returns a JavaScript error when the JSON or any Scene invariant is invalid.
#[wasm_bindgen(js_name = validateSceneIrBundleV1)]
pub fn validate_scene_ir_bundle_v1(snapshot_json: &[u8]) -> Result<(), JsValue> {
    poietra_scene_ir::parse_scene_ir_bundle_json_v1(snapshot_json)
        .map(drop)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Compiles one bounded Vulkan GLSL 450 fragment source to canonical WGSL.
///
/// # Errors
///
/// Returns a line/column diagnostic when parsing, validation, or the fixed
/// fragment-material ABI check fails.
#[wasm_bindgen(js_name = compileFragmentMaterialGlsl)]
pub fn compile_fragment_material_glsl(source: &str, entry_point: &str) -> Result<String, JsValue> {
    poietra_render_wgpu::compile_fragment_material_glsl(source, entry_point)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Opaque WASM handle owned by one dedicated browser worker.
#[wasm_bindgen]
#[derive(Debug)]
pub struct PoietraEngineSessionV1 {
    inner: EngineWorkerSessionV1,
}

#[wasm_bindgen]
impl PoietraEngineSessionV1 {
    /// Installs and validates a complete Scene IR bundle once.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the snapshot is malformed or invalid.
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot_json: &[u8]) -> Result<Self, JsValue> {
        EngineWorkerSessionV1::from_snapshot_json(snapshot_json)
            .map(|inner| Self { inner })
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Atomically replaces the retained snapshot.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error and preserves the current snapshot on failure.
    #[wasm_bindgen(js_name = replaceSnapshot)]
    pub fn replace_snapshot(&mut self, snapshot_json: &[u8]) -> Result<(), JsValue> {
        self.inner
            .replace_snapshot_json(snapshot_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Samples one bounded request into a versioned JSON `RenderPacket` response.
    #[must_use]
    pub fn sample(&self, request_json: &[u8]) -> Vec<u8> {
        self.inner.sample_json(request_json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_abi_versions_are_explicit() {
        assert_eq!(poietra_engine_abi_version(), 33);
        assert_eq!(poietra_canvas_abi_version(), 7);
        assert_eq!(poietra_canvas_telemetry_abi_version(), 4);
        assert_eq!(poietra_export_encoder_abi_version(), 1);
        assert_eq!(poietra_export_verify_abi_version(), 1);
    }
}
