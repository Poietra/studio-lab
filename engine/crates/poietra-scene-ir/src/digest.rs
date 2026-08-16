use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::export_profile::{
    ExportCodecTierV1, ExportColorContractVersionV1, ExportFrameRateV1, ExportProfileSchemaV1,
    ExportProfileV1, ExportResolutionV1,
};
use crate::model::{
    AssetAlphaModeV1, AssetColorSpaceV1, AssetManifestSchemaV1, AssetManifestV1, ContractVersionV1,
    PngAssetKindV1, PngMediaTypeV1,
};
use crate::validate::{ValidationErrors, ValidationIssue};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPngAssetV1<'a> {
    alpha_mode: AssetAlphaModeV1,
    byte_length: u64,
    color_space: AssetColorSpaceV1,
    id: &'a str,
    kind: PngAssetKindV1,
    media_type: PngMediaTypeV1,
    pixel_height: u32,
    pixel_width: u32,
    sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalAssetManifestV1<'a> {
    assets: Vec<CanonicalPngAssetV1<'a>>,
    manifest_id: &'a str,
    schema: AssetManifestSchemaV1,
    version: ContractVersionV1,
}

fn canonical_metadata(manifest: &AssetManifestV1) -> CanonicalAssetManifestV1<'_> {
    CanonicalAssetManifestV1 {
        assets: manifest
            .assets
            .iter()
            .map(|asset| CanonicalPngAssetV1 {
                alpha_mode: asset.alpha_mode,
                byte_length: asset.byte_length,
                color_space: asset.color_space,
                id: &asset.id,
                kind: asset.kind,
                media_type: asset.media_type,
                pixel_height: asset.pixel_height,
                pixel_width: asset.pixel_width,
                sha256: &asset.sha256,
            })
            .collect(),
        manifest_id: &manifest.manifest_id,
        schema: manifest.schema,
        version: manifest.version,
    }
}

/// Returns the byte-for-byte canonical metadata JSON used by the TypeScript v1 contract.
///
/// # Errors
///
/// Returns a serialization error if canonical metadata cannot be represented as JSON.
pub fn canonical_asset_manifest_v1(
    manifest: &AssetManifestV1,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&canonical_metadata(manifest))
}

/// Computes the lower-case SHA-256 digest over canonical manifest metadata.
///
/// # Errors
///
/// Returns a serialization error if canonical metadata cannot be represented as JSON.
pub fn digest_asset_manifest_v1(manifest: &AssetManifestV1) -> Result<String, serde_json::Error> {
    let canonical = canonical_asset_manifest_v1(manifest)?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalExportProfileV1 {
    codec: ExportCodecTierV1,
    color_contract_version: ExportColorContractVersionV1,
    frame_rate: ExportFrameRateV1,
    max_duration_seconds: u32,
    max_output_bytes: u64,
    resolution: ExportResolutionV1,
    schema: ExportProfileSchemaV1,
    version: ContractVersionV1,
}

fn canonical_profile(profile: &ExportProfileV1) -> CanonicalExportProfileV1 {
    CanonicalExportProfileV1 {
        codec: profile.codec,
        color_contract_version: profile.color_contract_version,
        frame_rate: profile.frame_rate,
        max_duration_seconds: profile.max_duration_seconds,
        max_output_bytes: profile.max_output_bytes,
        resolution: profile.resolution,
        schema: profile.schema,
        version: profile.version,
    }
}

/// Returns the byte-for-byte canonical profile JSON shared with the TypeScript v1 contract.
///
/// # Errors
///
/// Returns a serialization error if the canonical profile cannot be represented as JSON.
pub fn canonical_export_profile_v1(profile: &ExportProfileV1) -> Result<String, serde_json::Error> {
    serde_json::to_string(&canonical_profile(profile))
}

/// Computes the lower-case SHA-256 digest over the canonical export profile.
///
/// Unlike the asset manifest, an export profile does not embed its own digest;
/// this value names a profile in publication lineage (for example an
/// `export_profile_digest` column).
///
/// # Errors
///
/// Returns a serialization error if the canonical profile cannot be represented as JSON.
pub fn digest_export_profile_v1(profile: &ExportProfileV1) -> Result<String, serde_json::Error> {
    let canonical = canonical_export_profile_v1(profile)?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

/// Verifies that `manifestDigest` matches the canonical metadata digest.
///
/// # Errors
///
/// Returns validation issues when the digest is stale or canonical serialization fails.
pub fn validate_asset_manifest_digest_v1(
    manifest: &AssetManifestV1,
) -> Result<(), ValidationErrors> {
    match digest_asset_manifest_v1(manifest) {
        Ok(digest) if digest == manifest.manifest_digest => Ok(()),
        Ok(_) => Err(ValidationErrors::new(vec![ValidationIssue {
            path: "$.manifestDigest".to_owned(),
            message: "does not match canonical manifest metadata".to_owned(),
        }])),
        Err(error) => Err(ValidationErrors::new(vec![ValidationIssue {
            path: "$".to_owned(),
            message: format!("could not serialize canonical manifest metadata: {error}"),
        }])),
    }
}
