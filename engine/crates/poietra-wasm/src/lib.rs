//! Browser-facing retained Poietra Engine session.
//!
//! The JavaScript worker installs one validated Scene snapshot, then sends only
//! bounded playhead requests. The legacy sampling handle returns a `RenderPacket`;
//! the canvas handle keeps that packet in Rust and returns presentation metadata.

mod authoring;
mod bounded_writer;
#[cfg(target_arch = "wasm32")]
mod canvas;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_assets;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_protocol;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod canvas_telemetry;
mod protocol;

use wasm_bindgen::prelude::*;

pub use authoring::{
    create_scene_entities_v1, create_scene_motion_v1, rotate_scene_entity_v1,
    set_subtree_vector_paint_alpha_v1, transform_scene_entity_at_time_v1,
    transform_scene_entity_v1,
};

pub use canvas_protocol::MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES_V1;
pub use canvas_telemetry::{
    MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES_V1, MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES_V1,
    POIETRA_CANVAS_TELEMETRY_ABI_VERSION_V4,
};
pub use protocol::{
    EngineWorkerSessionV1, MAX_SAMPLE_REQUEST_JSON_BYTES_V1, MAX_WORKER_RESPONSE_JSON_BYTES_V1,
};

#[cfg(target_arch = "wasm32")]
pub use canvas::PoietraCanvasEngineV1;

/// JavaScript/WASM module handshake version, independent of Scene IR revisions.
pub const POIETRA_ENGINE_ABI_VERSION: u32 = 6;
/// `OffscreenCanvas` render ABI version, independent of worker packet sampling.
pub const POIETRA_CANVAS_ABI_VERSION_V4: u32 = 4;

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
    POIETRA_CANVAS_ABI_VERSION_V4
}

/// Returns the opt-in stage telemetry ABI version, independent of the base
/// canvas ABI so normal rendering never depends on telemetry support.
#[must_use]
#[wasm_bindgen(js_name = poietraCanvasTelemetryAbiVersion)]
pub fn poietra_canvas_telemetry_abi_version() -> u32 {
    POIETRA_CANVAS_TELEMETRY_ABI_VERSION_V4
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
        assert_eq!(poietra_engine_abi_version(), 6);
        assert_eq!(poietra_canvas_abi_version(), 4);
        assert_eq!(poietra_canvas_telemetry_abi_version(), 4);
    }
}
