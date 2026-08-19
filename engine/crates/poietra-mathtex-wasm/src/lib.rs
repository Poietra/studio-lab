//! Browser ABI for the hermetic `MathTex` outline compiler.
//!
//! The module accepts and returns bounded JSON bytes. It deliberately exposes
//! no filesystem, URL, font-selection, or SVG surface to JavaScript.

use poietra_mathtex_outline::{
    MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1, MATHTEX_OUTLINE_VERSION_V1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1, SEGMENTED_TEX_OUTLINE_VERSION_V1,
    SegmentedTexOutlineRequestV1, SegmentedTexOutlineResultV1,
    SegmentedTexOutlineUnsupportedCodeV1, TEXT_OUTLINE_RESPONSE_SCHEMA_V1, TEXT_OUTLINE_VERSION_V1,
    TextOutlineRequestV1, TextOutlineResultV1, TextOutlineUnsupportedCodeV1,
    compile_mathtex_outline_v1, compile_segmented_tex_outline_v1, compile_text_outline_v1,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// JavaScript/WASM module handshake version.
pub const POIETRA_MATHTEX_OUTLINE_ABI_VERSION_V1: u32 = 1;
/// Independent sibling ABI version for ordered Tex/MathTex fragments.
pub const POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION_V1: u32 = 1;
/// Independent sibling ABI version for bounded plain text.
pub const POIETRA_TEXT_OUTLINE_ABI_VERSION: u32 = 2;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SegmentedTexOutlineResponseV1 {
    result: SegmentedTexOutlineResultV1,
    schema: &'static str,
    version: u32,
}

impl SegmentedTexOutlineResponseV1 {
    fn new(result: SegmentedTexOutlineResultV1) -> Self {
        Self {
            result,
            schema: SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1,
            version: SEGMENTED_TEX_OUTLINE_VERSION_V1,
        }
    }

    fn unsupported(code: SegmentedTexOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self::new(SegmentedTexOutlineResultV1::unsupported(code, message))
    }
}

fn serialize_segmented_boundary(
    code: SegmentedTexOutlineUnsupportedCodeV1,
    message: &'static str,
) -> Vec<u8> {
    serde_json::to_vec(&SegmentedTexOutlineResponseV1::unsupported(code, message)).unwrap_or_else(
        |_| {
            br#"{"result":{"kind":"unsupported","code":"internal-failure","message":"Segmented Tex outline response serialization failed"},"schema":"poietra.segmented-tex-outline-response","version":1}"#.to_vec()
        },
    )
}

fn serialize_segmented_response(result: SegmentedTexOutlineResultV1) -> Vec<u8> {
    match serde_json::to_vec(&SegmentedTexOutlineResponseV1::new(result)) {
        Ok(bytes) if bytes.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1 => bytes,
        Ok(_) => serialize_segmented_boundary(
            SegmentedTexOutlineUnsupportedCodeV1::ResponseTooLarge,
            "Segmented Tex outline response exceeds the transfer limit",
        ),
        Err(_) => serialize_segmented_boundary(
            SegmentedTexOutlineUnsupportedCodeV1::InternalFailure,
            "Segmented Tex outline response could not be serialized",
        ),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextOutlineResponseV1 {
    result: TextOutlineResultV1,
    schema: &'static str,
    version: u32,
}

impl TextOutlineResponseV1 {
    fn new(result: TextOutlineResultV1) -> Self {
        Self {
            result,
            schema: TEXT_OUTLINE_RESPONSE_SCHEMA_V1,
            version: TEXT_OUTLINE_VERSION_V1,
        }
    }

    fn unsupported(code: TextOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self::new(TextOutlineResultV1::unsupported(code, message))
    }
}

fn serialize_text_boundary(code: TextOutlineUnsupportedCodeV1, message: &'static str) -> Vec<u8> {
    serde_json::to_vec(&TextOutlineResponseV1::unsupported(code, message)).unwrap_or_else(|_| {
        br#"{"result":{"kind":"unsupported","code":"internal-failure","message":"Text outline response serialization failed"},"schema":"poietra.text-outline-response","version":1}"#.to_vec()
    })
}

fn serialize_text_response(result: TextOutlineResultV1) -> Vec<u8> {
    match serde_json::to_vec(&TextOutlineResponseV1::new(result)) {
        Ok(bytes) if bytes.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1 => bytes,
        Ok(_) => serialize_text_boundary(
            TextOutlineUnsupportedCodeV1::ResponseTooLarge,
            "Text outline response exceeds the transfer limit",
        ),
        Err(_) => serialize_text_boundary(
            TextOutlineUnsupportedCodeV1::InternalFailure,
            "Text outline response could not be serialized",
        ),
    }
}

/// Returns the exact ABI version before any outline request is compiled.
#[must_use]
#[wasm_bindgen(js_name = poietraMathTexOutlineAbiVersion)]
pub fn poietra_mathtex_outline_abi_version() -> u32 {
    POIETRA_MATHTEX_OUTLINE_ABI_VERSION_V1
}

/// Returns the independent segmented-outline ABI version.
#[must_use]
#[wasm_bindgen(js_name = poietraSegmentedTexOutlineAbiVersion)]
pub fn poietra_segmented_tex_outline_abi_version() -> u32 {
    POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION_V1
}

/// Returns the independent plain-text outline ABI version.
#[must_use]
#[wasm_bindgen(js_name = poietraTextOutlineAbiVersion)]
pub fn poietra_text_outline_abi_version() -> u32 {
    POIETRA_TEXT_OUTLINE_ABI_VERSION
}

/// Compiles one bounded, versioned `MathTex` request into a bounded response.
///
/// Malformed and oversized requests are represented as structured unsupported
/// responses so JavaScript can report unsupported WebGPU content explicitly.
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

/// Compiles one bounded literal Tex/MathTex request into ordered fragments.
#[must_use]
#[wasm_bindgen(js_name = compileSegmentedTexOutlineV1)]
pub fn compile_segmented_tex_outline_json_v1(request_json: &[u8]) -> Vec<u8> {
    if request_json.len() > MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1 {
        return serialize_segmented_boundary(
            SegmentedTexOutlineUnsupportedCodeV1::RequestTooLarge,
            "Segmented Tex outline request exceeds the transfer limit",
        );
    }
    let Ok(request) = serde_json::from_slice::<SegmentedTexOutlineRequestV1>(request_json) else {
        return serialize_segmented_boundary(
            SegmentedTexOutlineUnsupportedCodeV1::InvalidRequest,
            "Segmented Tex outline request does not match the v1 contract",
        );
    };
    serialize_segmented_response(compile_segmented_tex_outline_v1(&request))
}

/// Compiles one bounded Unicode text block with the embedded deterministic faces.
#[must_use]
#[wasm_bindgen(js_name = compileTextOutlineV1)]
pub fn compile_text_outline_json_v1(request_json: &[u8]) -> Vec<u8> {
    if request_json.len() > MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1 {
        return serialize_text_boundary(
            TextOutlineUnsupportedCodeV1::RequestTooLarge,
            "Text outline request exceeds the transfer limit",
        );
    }
    let Ok(request) = serde_json::from_slice::<TextOutlineRequestV1>(request_json) else {
        return serialize_text_boundary(
            TextOutlineUnsupportedCodeV1::InvalidRequest,
            "Text outline request does not match the v1 contract",
        );
    };
    serialize_text_response(compile_text_outline_v1(&request))
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
        assert_eq!(poietra_segmented_tex_outline_abi_version(), 1);
        assert_eq!(poietra_text_outline_abi_version(), 2);
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

    #[test]
    fn segmented_boundary_returns_structured_failures() {
        let malformed = compile_segmented_tex_outline_json_v1(br#"{"source":"x"}"#);
        assert!(malformed.len() <= MAX_MATHTEX_OUTLINE_RESPONSE_JSON_BYTES_V1);
        assert_eq!(decode(&malformed)["result"]["kind"], "unsupported");
        assert_eq!(decode(&malformed)["result"]["code"], "invalid-request");

        let oversized = compile_segmented_tex_outline_json_v1(&vec![
            b'x';
            MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1
                + 1
        ]);
        assert_eq!(decode(&oversized)["result"]["code"], "request-too-large");
    }

    #[test]
    fn text_boundary_compiles_ascii_and_japanese_blocks_without_changing_mathtex_contract() {
        let response = compile_text_outline_json_v1(
            br#"{"layout":{"alignment":"left","lineHeight":1.2},"schema":"poietra.text-outline-request","version":1,"text":"Hello AV"}"#,
        );
        let decoded = decode(&response);
        assert_eq!(decoded["schema"], "poietra.text-outline-response");
        assert_eq!(decoded["version"], 1);
        assert_eq!(decoded["result"]["kind"], "compiled");
        assert_eq!(decoded["result"]["fillRule"], "nonzero");
        assert_eq!(decoded["result"]["bounds"]["bottom"], -0.5);
        assert_eq!(decoded["result"]["bounds"]["top"], 0.5);
        assert!(
            decoded["result"]["path"]["subpaths"]
                .as_array()
                .is_some_and(|paths| !paths.is_empty())
        );

        let japanese = compile_text_outline_json_v1(
            "{\"layout\":{\"alignment\":\"right\",\"lineHeight\":1.8},\"schema\":\"poietra.text-outline-request\",\"version\":1,\"text\":\"日本語で動画を作る\\nこんにちは\"}"
                .as_bytes(),
        );
        assert_eq!(decode(&japanese)["result"]["kind"], "compiled");

        let mathtex = compile_mathtex_outline_json_v1(
            br#"{"schema":"poietra.mathtex-outline-request","version":1,"texParts":["E = mc^2"]}"#,
        );
        assert_eq!(
            decode(&mathtex)["schema"],
            "poietra.mathtex-outline-response"
        );
        assert_eq!(decode(&mathtex)["result"]["kind"], "compiled");
    }

    #[test]
    fn text_boundary_accepts_crlf_and_rejects_controls_and_oversized_json() {
        let malformed = compile_text_outline_json_v1(br#"{"text":"Hello"}"#);
        assert_eq!(decode(&malformed)["result"]["code"], "invalid-request");

        let crlf = compile_text_outline_json_v1(
            br#"{"layout":{"alignment":"left","lineHeight":1.2},"schema":"poietra.text-outline-request","version":1,"text":"a\r\nb"}"#,
        );
        assert_eq!(decode(&crlf)["result"]["kind"], "compiled");

        let control = compile_text_outline_json_v1(
            br#"{"layout":{"alignment":"left","lineHeight":1.2},"schema":"poietra.text-outline-request","version":1,"text":"a\tb"}"#,
        );
        assert_eq!(decode(&control)["result"]["code"], "character-unsupported");

        let oversized = compile_text_outline_json_v1(&vec![
            b'x';
            MAX_MATHTEX_OUTLINE_REQUEST_JSON_BYTES_V1
                + 1
        ]);
        assert_eq!(decode(&oversized)["result"]["code"], "request-too-large");
    }
}
