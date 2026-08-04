//! Python ABI for Poietra's hermetic `MathTex` outline compiler.
//!
//! The extension accepts source parts as Python strings and returns one bounded
//! UTF-8 JSON response. It exposes no filesystem, font-selection, SVG, or
//! subprocess surface to the Python snapshot producer.

use ::poietra_mathtex_outline::{
    MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1, MATHTEX_OUTLINE_VERSION_V1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1, SEGMENTED_TEX_OUTLINE_VERSION_V1,
    SegmentedTexOutlineRequestV1, SegmentedTexOutlineResultV1,
    SegmentedTexOutlineUnsupportedCodeV1, compile_mathtex_outline_v1 as compile_outline_core_v1,
    compile_segmented_tex_outline_v1 as compile_segmented_outline_core_v1,
};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde::Serialize;

/// Python extension handshake version.
pub const POIETRA_MATHTEX_OUTLINE_PY_ABI_VERSION_V1: u32 = 1;
/// Independent Python ABI version for ordered Tex/MathTex fragments.
pub const POIETRA_SEGMENTED_TEX_OUTLINE_PY_ABI_VERSION_V1: u32 = 1;
/// Maximum request accepted by the segmented JSON bridge.
pub const MAX_SEGMENTED_TEX_OUTLINE_PY_REQUEST_JSON_BYTES_V1: usize = 16 * 1024;
/// Maximum encoded response accepted by the snapshot-producer boundary.
pub const MAX_MATHTEX_OUTLINE_PY_RESPONSE_JSON_BYTES_V1: usize = 1024 * 1024;

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

fn compile_response_json_v1(tex_parts: Vec<String>) -> Vec<u8> {
    let result = compile_outline_core_v1(&MathTexOutlineRequestV1::new(tex_parts));
    match serde_json::to_vec(&MathTexOutlineResponseV1::new(result)) {
        Ok(bytes) if bytes.len() <= MAX_MATHTEX_OUTLINE_PY_RESPONSE_JSON_BYTES_V1 => bytes,
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

fn compile_segmented_response_json_v1(request_json: &[u8]) -> Vec<u8> {
    if request_json.len() > MAX_SEGMENTED_TEX_OUTLINE_PY_REQUEST_JSON_BYTES_V1 {
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
    let response = SegmentedTexOutlineResponseV1::new(compile_segmented_outline_core_v1(&request));
    match serde_json::to_vec(&response) {
        Ok(bytes) if bytes.len() <= MAX_MATHTEX_OUTLINE_PY_RESPONSE_JSON_BYTES_V1 => bytes,
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

/// Returns the exact ABI version before any outline request is compiled.
#[pyfunction]
fn abi_version() -> u32 {
    POIETRA_MATHTEX_OUTLINE_PY_ABI_VERSION_V1
}

/// Returns the independent segmented-outline Python ABI version.
#[pyfunction]
fn segmented_abi_version() -> u32 {
    POIETRA_SEGMENTED_TEX_OUTLINE_PY_ABI_VERSION_V1
}

/// Compiles bounded source parts into the shared outline response envelope.
#[pyfunction]
fn compile_mathtex_outline_v1(py: Python<'_>, tex_parts: Vec<String>) -> Bound<'_, PyBytes> {
    PyBytes::new(py, &compile_response_json_v1(tex_parts))
}

/// Compiles one bounded segmented request encoded as UTF-8 JSON bytes.
#[pyfunction]
fn compile_segmented_tex_outline_v1<'py>(
    py: Python<'py>,
    request_json: &[u8],
) -> Bound<'py, PyBytes> {
    PyBytes::new(py, &compile_segmented_response_json_v1(request_json))
}

/// Hermetic `MathTex` outline module consumed by the fast-manim snapshot profile.
#[pymodule]
fn poietra_mathtex_outline(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(abi_version, module)?)?;
    module.add_function(wrap_pyfunction!(compile_mathtex_outline_v1, module)?)?;
    module.add_function(wrap_pyfunction!(segmented_abi_version, module)?)?;
    module.add_function(wrap_pyfunction!(compile_segmented_tex_outline_v1, module)?)?;
    Ok(())
}
