//! Browser ABI for the hermetic `MathTex` outline compiler.
//!
//! The module accepts and returns bounded JSON bytes. It deliberately exposes
//! no filesystem, URL, font-selection, or SVG surface to JavaScript.

use poietra_mathtex_outline::{
    MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1, MATHTEX_OUTLINE_VERSION_V1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1, compile_mathtex_outline_v1,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// JavaScript/WASM module handshake version.
pub const POIETRA_MATHTEX_OUTLINE_ABI_VERSION_V1: u32 = 1;
/// Upper bound for one JSON compilation request crossing the WASM boundary.
pub const MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1: usize = 16 * 1024;
/// Upper bound for one JSON compilation response crossing the WASM boundary.
pub const MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MathTexOutlineResponseV1 {
    result: MathTexOutlineResultV1,
    schema: &'static str,
    version: u32,
}

impl MathTexOutlineResponseV1 {
    fn new(result: MathTexOutlineResultV1) -> Self {
        Self {
            result,
            schema: MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1,
            version: MATHTEX_OUTLINE_VERSION_V1,
        }
    }

    fn unsupported(code: MathTexOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self::new(MathTexOutlineResultV1::unsupported(code, message))
    }
}

fn serialize_boundary(code: MathTexOutlineUnsupportedCodeV1, message: &'static str) -> Vec<u8> {
    serde_json::to_vec(&MathTexOutlineResponseV1::unsupported(code, message)).unwrap_or_else(|_| {
        br#"{"result":{"kind":"unsupported","code":"internal-failure","message":"MathTex outline response serialization failed"},"schema":"poietra.mathtex-outline-response","version":1}"#.to_vec()
    })
}

fn serialize_response(result: MathTexOutlineResultV1) -> Vec<u8> {
    match serde_json::to_vec(&MathTexOutlineResponseV1::new(result)) {
        Ok(bytes) if bytes.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1 => bytes,
        Ok(_) => serialize_boundary(
            MathTexOutlineUnsupportedCodeV1::ResponseTooLarge,
            "MathTex outline response exceeds the transfer limit",
        ),
        Err(_) => serialize_boundary(
            MathTexOutlineUnsupportedCodeV1::InternalFailure,
            "MathTex outline response could not be serialized",
        ),
    }
}

/// Returns the exact ABI version before any outline request is compiled.
#[must_use]
#[wasm_bindgen(js_name = poietraMathTexOutlineAbiVersion)]
pub fn poietra_mathtex_outline_abi_version() -> u32 {
    POIETRA_MATHTEX_OUTLINE_ABI_VERSION_V1
}

/// Compiles one bounded, versioned `MathTex` request into a bounded response.
///
/// Malformed and oversized requests are represented as structured unsupported
/// responses so JavaScript can keep the semantic preview authoritative.
#[must_use]
#[wasm_bindgen(js_name = compileMathTexOutlineV1)]
pub fn compile_mathtex_outline_json_v1(request_json: &[u8]) -> Vec<u8> {
    if request_json.len() > MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1 {
        return serialize_boundary(
            MathTexOutlineUnsupportedCodeV1::RequestTooLarge,
            "MathTex outline request exceeds the transfer limit",
        );
    }
    let Ok(request) = serde_json::from_slice::<MathTexOutlineRequestV1>(request_json) else {
        return serialize_boundary(
            MathTexOutlineUnsupportedCodeV1::InvalidRequest,
            "MathTex outline request does not match the v1 contract",
        );
    };
    serialize_response(compile_mathtex_outline_v1(&request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn decode(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).expect("wrapper response must be JSON")
    }

    #[test]
    fn exported_abi_version_is_explicit() {
        assert_eq!(poietra_mathtex_outline_abi_version(), 1);
    }

    #[test]
    fn malformed_and_oversized_requests_remain_bounded_unsupported_responses() {
        let malformed = compile_mathtex_outline_json_v1(br#"{"texParts":[]}"#);
        assert!(malformed.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1);
        assert_eq!(decode(&malformed)["result"]["kind"], "unsupported");
        assert_eq!(decode(&malformed)["result"]["code"], "invalid-request");

        let oversized = compile_mathtex_outline_json_v1(&vec![
            b'x';
            MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1
                + 1
        ]);
        assert!(oversized.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1);
        assert_eq!(decode(&oversized)["result"]["kind"], "unsupported");
        assert_eq!(decode(&oversized)["result"]["code"], "request-too-large");
    }
}
