//! Browser-facing retained Poietra Engine session.
//!
//! The JavaScript worker installs one validated Scene snapshot, then sends only
//! bounded playhead requests. Each response contains a `RenderPacket` rather than
//! cloning the Scene and manifest across the worker boundary.

mod protocol;

use wasm_bindgen::prelude::*;

pub use protocol::{
    EngineWorkerSessionV1, MAX_SAMPLE_REQUEST_JSON_BYTES_V1, MAX_WORKER_RESPONSE_JSON_BYTES_V1,
};

/// JavaScript/WASM module handshake version, independent of Scene IR revisions.
pub const POIETRA_ENGINE_ABI_VERSION_V1: u32 = 1;

/// Returns the worker ABI version before a session is constructed.
#[must_use]
#[wasm_bindgen(js_name = poietraEngineAbiVersion)]
pub fn poietra_engine_abi_version() -> u32 {
    POIETRA_ENGINE_ABI_VERSION_V1
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
    fn exported_abi_version_is_v1() {
        assert_eq!(poietra_engine_abi_version(), 1);
    }
}
