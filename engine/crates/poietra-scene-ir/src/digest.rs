use serde::Serialize;
use sha2::{Digest, Sha256};

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
