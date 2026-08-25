//! Strict, renderer-neutral v1 wire contracts shared by Poietra evaluators and renderers.
//!
//! Serde rejects unknown fields and non-v1 literal/tag values. Call the public validation
//! helpers after deserialization to enforce numeric, resource, hierarchy, capability, digest,
//! and cross-document integrity rules.

mod digest;
mod export_profile;
mod integrity;
mod model;
mod validate;

use std::error::Error;
use std::fmt;

use serde::de::DeserializeOwned;

pub use digest::{
    canonical_asset_manifest_v1, canonical_export_profile_v1, digest_asset_manifest_v1,
    export_profile_hash_v1, validate_asset_manifest_digest_v1,
};
pub use export_profile::*;
pub use integrity::{
    validate_engine_frame_v1, validate_render_packet_bundle_v1,
    validate_render_packet_for_validated_scene_v1, validate_scene_ir_bundle_v1,
    validate_scene_ir_with_assets_v1,
};
pub use model::*;
pub use validate::{
    MAX_ASSETS_V1, MAX_CHANNELS_V1, MAX_COORDINATE_V1, MAX_DRAWS_V1, MAX_ENCODED_ASSET_BYTES_V1,
    MAX_ENTITIES_V1, MAX_EXPORT_DURATION_SECONDS_V1, MAX_EXPORT_OUTPUT_BYTES_V1,
    MAX_IMAGE_PIXELS_V1, MAX_KEYFRAMES_V1, MAX_STROKE_DASH_WORLD_V1, MAX_TOTAL_IMAGE_PIXELS_V1,
    MAX_TOTAL_PATH_SEGMENTS_V1, MAX_VALIDATION_ISSUES_V1, MAX_VIEWPORT_PIXELS_V1,
    MIN_AFFINE_DETERMINANT_V1, MIN_STROKE_DASH_WORLD_V1, RENDER_ASPECT_RELATIVE_TOLERANCE_V1,
    ValidationErrors, ValidationIssue, affine_transform_is_singular_v1, validate_asset_manifest_v1,
    validate_cubic_path_v1, validate_export_profile_v1, validate_render_packet_v1,
    validate_scene_ir_v1,
};

/// Hard limit for one untrusted JSON contract envelope at the native/WASM boundary.
///
/// Asset bytes are resolved out of band and must never be embedded in these documents.
/// The 8 MiB ceiling leaves envelope headroom above the 5 MiB initial Scene snapshot budget.
pub const MAX_CONTRACT_JSON_BYTES_V1: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum ContractJsonError {
    InputTooLarge {
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    Json(serde_json::Error),
    Validation(ValidationErrors),
}

impl fmt::Display for ContractJsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                maximum_bytes,
            } => write!(
                formatter,
                "contract JSON contains {actual_bytes} bytes; maximum is {maximum_bytes}"
            ),
            Self::Json(error) => write!(formatter, "invalid contract JSON: {error}"),
            Self::Validation(error) => write!(formatter, "contract validation failed: {error}"),
        }
    }
}

impl Error for ContractJsonError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InputTooLarge { .. } => None,
            Self::Json(error) => Some(error),
            Self::Validation(error) => Some(error),
        }
    }
}

fn parse_validated<T>(
    json: &[u8],
    validate: impl FnOnce(&T) -> Result<(), ValidationErrors>,
) -> Result<T, ContractJsonError>
where
    T: DeserializeOwned,
{
    if json.len() > MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(ContractJsonError::InputTooLarge {
            actual_bytes: json.len(),
            maximum_bytes: MAX_CONTRACT_JSON_BYTES_V1,
        });
    }
    let value = serde_json::from_slice(json).map_err(ContractJsonError::Json)?;
    validate(&value).map_err(ContractJsonError::Validation)?;
    Ok(value)
}

/// Parses and fully verifies an asset manifest JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for malformed JSON, unknown fields, invalid structure, or a
/// mismatched canonical digest.
pub fn parse_asset_manifest_json_v1(json: &[u8]) -> Result<AssetManifestV1, ContractJsonError> {
    parse_validated(json, |manifest| {
        validate_asset_manifest_v1(manifest)?;
        validate_asset_manifest_digest_v1(manifest)
    })
}

/// Parses and structurally validates a Scene IR JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for malformed JSON, unknown fields, or invalid Scene IR.
pub fn parse_scene_ir_json_v1(json: &[u8]) -> Result<SceneIrV1, ContractJsonError> {
    parse_validated(json, validate_scene_ir_v1)
}

/// Parses and structurally validates an export profile JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for malformed JSON, unknown fields, open enum
/// values, or declared bounds outside the v1 ceilings.
pub fn parse_export_profile_json_v1(json: &[u8]) -> Result<ExportProfileV1, ContractJsonError> {
    parse_validated(json, validate_export_profile_v1)
}

/// Parses and structurally validates a render packet JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for malformed JSON, unknown fields, or an invalid packet.
pub fn parse_render_packet_json_v1(json: &[u8]) -> Result<RenderPacketV1, ContractJsonError> {
    parse_validated(json, validate_render_packet_v1)
}

/// Parses and fully verifies a Scene IR bundle JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for JSON, structural, digest, or asset-reference violations.
pub fn parse_scene_ir_bundle_json_v1(json: &[u8]) -> Result<SceneIrBundleV1, ContractJsonError> {
    parse_validated(json, validate_scene_ir_bundle_v1)
}

/// Parses and fully verifies a render packet bundle JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for JSON, structural, digest, or asset-reference violations.
pub fn parse_render_packet_bundle_json_v1(
    json: &[u8],
) -> Result<RenderPacketBundleV1, ContractJsonError> {
    parse_validated(json, validate_render_packet_bundle_v1)
}

/// Parses and fully verifies a sampled engine frame JSON document.
///
/// # Errors
///
/// Returns [`ContractJsonError`] for JSON, structural, digest, or cross-document violations.
pub fn parse_engine_frame_json_v1(json: &[u8]) -> Result<EngineFrameV1, ContractJsonError> {
    parse_validated(json, validate_engine_frame_v1)
}
