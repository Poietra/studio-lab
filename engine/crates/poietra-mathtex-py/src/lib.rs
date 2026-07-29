//! Python ABI for Poietra's hermetic `MathTex` outline compiler.
//!
//! The extension accepts source parts as Python strings and returns one bounded
//! UTF-8 JSON response. It exposes no filesystem, font-selection, SVG, or
//! subprocess surface to the Python snapshot producer.

use ::poietra_mathtex_outline::{
    MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1, MATHTEX_OUTLINE_VERSION_V1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    compile_mathtex_outline_v1 as compile_outline_core_v1,
};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde::Serialize;

/// Python extension handshake version.
pub const POIETRA_MATHTEX_OUTLINE_PY_ABI_VERSION_V1: u32 = 1;
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

/// Returns the exact ABI version before any outline request is compiled.
#[pyfunction]
fn abi_version() -> u32 {
    POIETRA_MATHTEX_OUTLINE_PY_ABI_VERSION_V1
}

/// Compiles bounded source parts into the shared outline response envelope.
#[pyfunction]
fn compile_mathtex_outline_v1(py: Python<'_>, tex_parts: Vec<String>) -> Bound<'_, PyBytes> {
    PyBytes::new(py, &compile_response_json_v1(tex_parts))
}

/// Hermetic `MathTex` outline module consumed by the fast-manim snapshot profile.
#[pymodule]
fn poietra_mathtex_outline(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(abi_version, module)?)?;
    module.add_function(wrap_pyfunction!(compile_mathtex_outline_v1, module)?)?;
    Ok(())
}
