use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use poietra_render_wgpu::{DecodedPngAssetResolverV1, DecodedPngAssetV1, decode_verified_png_v1};
use poietra_scene_ir::{
    AssetManifestV1, MAX_ASSETS_V1, MAX_ENCODED_ASSET_BYTES_V1, MAX_TOTAL_IMAGE_PIXELS_V1,
    PngAssetV1,
};

const MAX_ASSET_METADATA_JSON_BYTES_V1: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
struct RegisteredPngAssetV1 {
    byte_length: u64,
    decoded: Arc<DecodedPngAssetV1>,
}

/// Immutable, lifetime-bounded PNG authority for one retained canvas session.
#[derive(Clone, Debug, Default)]
pub(crate) struct CanvasPngAssetRegistryV1 {
    by_digest: BTreeMap<String, RegisteredPngAssetV1>,
    decoded_pixels: u64,
    encoded_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CanvasPngAssetRegistryErrorV1 {
    #[error("PNG transfer metadata exceeds {MAX_ASSET_METADATA_JSON_BYTES_V1} bytes")]
    MetadataTooLarge,
    #[error("PNG transfer metadata is invalid: {0}")]
    InvalidMetadata(#[from] serde_json::Error),
    #[error("PNG transfer metadata and byte array counts differ")]
    CountMismatch,
    #[error("PNG transfer contains more than {MAX_ASSETS_V1} assets")]
    TooManyTransfers,
    #[error("PNG digest {0} was transferred more than once")]
    DuplicateTransfer(String),
    #[error("PNG transfer metadata for {0} is stale or absent from the candidate manifest")]
    StaleMetadata(String),
    #[error("PNG digest {0} was resent after it became immutable")]
    AlreadyRegistered(String),
    #[error("PNG asset {0} could not be verified: {1}")]
    Decode(String, String),
    #[error("PNG bytes for manifest asset {0} are missing")]
    Missing(String),
    #[error("PNG digest {0} has conflicting immutable metadata")]
    MetadataConflict(String),
    #[error("the retained PNG registry exceeds its immutable resource limits")]
    RegistryLimit,
}

impl CanvasPngAssetRegistryV1 {
    /// Builds a complete candidate without changing the installed registry.
    pub(crate) fn prepare_candidate(
        &self,
        manifest: &AssetManifestV1,
        metadata_json: &[u8],
        byte_arrays: &[Vec<u8>],
    ) -> Result<Self, CanvasPngAssetRegistryErrorV1> {
        if metadata_json.len() > MAX_ASSET_METADATA_JSON_BYTES_V1 {
            return Err(CanvasPngAssetRegistryErrorV1::MetadataTooLarge);
        }
        let metadata: Vec<PngAssetV1> = serde_json::from_slice(metadata_json)?;
        if metadata.len() != byte_arrays.len() {
            return Err(CanvasPngAssetRegistryErrorV1::CountMismatch);
        }
        if metadata.len() > MAX_ASSETS_V1 {
            return Err(CanvasPngAssetRegistryErrorV1::TooManyTransfers);
        }

        let manifest_by_id: BTreeMap<&str, &PngAssetV1> = manifest
            .assets
            .iter()
            .map(|asset| (asset.id.as_str(), asset))
            .collect();
        let mut candidate = self.clone();
        let mut transferred_digests = BTreeSet::<&str>::new();
        for (asset, bytes) in metadata.iter().zip(byte_arrays) {
            if !transferred_digests.insert(asset.sha256.as_str()) {
                return Err(CanvasPngAssetRegistryErrorV1::DuplicateTransfer(
                    asset.sha256.clone(),
                ));
            }
            if manifest_by_id.get(asset.id.as_str()).copied() != Some(asset) {
                return Err(CanvasPngAssetRegistryErrorV1::StaleMetadata(
                    asset.id.clone(),
                ));
            }
            if candidate.by_digest.contains_key(&asset.sha256) {
                return Err(CanvasPngAssetRegistryErrorV1::AlreadyRegistered(
                    asset.sha256.clone(),
                ));
            }
            let decoded = decode_verified_png_v1(asset, bytes).map_err(|error| {
                CanvasPngAssetRegistryErrorV1::Decode(asset.id.clone(), error.to_string())
            })?;
            candidate.encoded_bytes = candidate
                .encoded_bytes
                .checked_add(asset.byte_length)
                .ok_or(CanvasPngAssetRegistryErrorV1::RegistryLimit)?;
            candidate.decoded_pixels = candidate
                .decoded_pixels
                .checked_add(u64::from(asset.pixel_width) * u64::from(asset.pixel_height))
                .ok_or(CanvasPngAssetRegistryErrorV1::RegistryLimit)?;
            candidate.by_digest.insert(
                asset.sha256.clone(),
                RegisteredPngAssetV1 {
                    byte_length: asset.byte_length,
                    decoded: Arc::new(decoded),
                },
            );
        }

        for asset in &manifest.assets {
            let Some(registered) = candidate.by_digest.get(&asset.sha256) else {
                return Err(CanvasPngAssetRegistryErrorV1::Missing(asset.id.clone()));
            };
            if registered.byte_length != asset.byte_length
                || registered.decoded.width() != asset.pixel_width
                || registered.decoded.height() != asset.pixel_height
            {
                return Err(CanvasPngAssetRegistryErrorV1::MetadataConflict(
                    asset.sha256.clone(),
                ));
            }
        }
        if candidate.by_digest.len() > MAX_ASSETS_V1
            || candidate.encoded_bytes > MAX_ENCODED_ASSET_BYTES_V1
            || candidate.decoded_pixels > MAX_TOTAL_IMAGE_PIXELS_V1
        {
            return Err(CanvasPngAssetRegistryErrorV1::RegistryLimit);
        }
        Ok(candidate)
    }

    pub(crate) fn get(&self, digest: &str) -> Option<Arc<DecodedPngAssetV1>> {
        self.by_digest
            .get(digest)
            .map(|asset| Arc::clone(&asset.decoded))
    }
}

impl DecodedPngAssetResolverV1 for CanvasPngAssetRegistryV1 {
    fn resolve_png_asset_v1(&self, sha256: &str) -> Option<Arc<DecodedPngAssetV1>> {
        self.get(sha256)
    }
}

#[cfg(test)]
mod tests {
    use png::{BitDepth, ColorType, Encoder};
    use poietra_scene_ir::{
        AssetAlphaModeV1, AssetColorSpaceV1, AssetManifestSchemaV1, ContractVersionV1,
        PngAssetKindV1, PngMediaTypeV1,
    };
    use sha2::{Digest, Sha256};

    use super::*;

    fn png(pixel: [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&pixel).unwrap();
        writer.finish().unwrap();
        bytes
    }

    fn asset(id: &str, bytes: &[u8]) -> PngAssetV1 {
        PngAssetV1 {
            alpha_mode: AssetAlphaModeV1::Straight,
            byte_length: u64::try_from(bytes.len()).unwrap(),
            color_space: AssetColorSpaceV1::Srgb,
            id: id.to_owned(),
            kind: PngAssetKindV1::PngImage,
            media_type: PngMediaTypeV1::ImagePng,
            pixel_height: 1,
            pixel_width: 1,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    fn manifest(asset: PngAssetV1) -> AssetManifestV1 {
        AssetManifestV1 {
            assets: vec![asset],
            manifest_digest: "0".repeat(64),
            manifest_id: "manifest:test".to_owned(),
            schema: AssetManifestSchemaV1::AssetManifest,
            version: ContractVersionV1,
        }
    }

    #[test]
    fn candidate_is_atomic_and_reuses_a_digest_without_retransfer() {
        let bytes = png([10, 20, 30, 255]);
        let first_asset = asset("asset:first", &bytes);
        let metadata = serde_json::to_vec(&vec![first_asset.clone()]).unwrap();
        let registry = CanvasPngAssetRegistryV1::default();
        let candidate = registry
            .prepare_candidate(
                &manifest(first_asset.clone()),
                &metadata,
                std::slice::from_ref(&bytes),
            )
            .unwrap();
        assert!(registry.get(&first_asset.sha256).is_none());
        assert!(
            candidate
                .resolve_png_asset_v1(&first_asset.sha256)
                .is_some()
        );

        let second_asset = asset("asset:second", &bytes);
        let reused = candidate
            .prepare_candidate(&manifest(second_asset), b"[]", &[])
            .unwrap();
        assert_eq!(reused.by_digest.len(), 1);

        let replacement_bytes = png([40, 50, 60, 255]);
        let replacement_asset = asset("asset:first", &replacement_bytes);
        let replacement_metadata = serde_json::to_vec(&vec![replacement_asset.clone()]).unwrap();
        let advanced = reused
            .prepare_candidate(
                &manifest(replacement_asset),
                &replacement_metadata,
                &[replacement_bytes],
            )
            .unwrap();
        assert_eq!(advanced.by_digest.len(), 2);
    }

    #[test]
    fn rejects_missing_stale_and_duplicate_transfers_without_mutation() {
        let bytes = png([10, 20, 30, 255]);
        let first_asset = asset("asset:first", &bytes);
        let metadata = serde_json::to_vec(&vec![first_asset.clone()]).unwrap();
        let registry = CanvasPngAssetRegistryV1::default();
        assert!(matches!(
            registry.prepare_candidate(&manifest(first_asset.clone()), b"[]", &[]),
            Err(CanvasPngAssetRegistryErrorV1::Missing(_))
        ));
        assert!(matches!(
            registry.prepare_candidate(
                &manifest(first_asset.clone()),
                &serde_json::to_vec(&vec![first_asset.clone(), first_asset.clone()]).unwrap(),
                &[bytes.clone(), bytes.clone()],
            ),
            Err(CanvasPngAssetRegistryErrorV1::DuplicateTransfer(_))
        ));
        let candidate = registry
            .prepare_candidate(&manifest(first_asset.clone()), &metadata, &[bytes])
            .unwrap();
        assert_eq!(candidate.by_digest.len(), 1);
    }

    #[test]
    fn bounds_decoded_pixels_retained_across_replacements() {
        let bytes = png([10, 20, 30, 255]);
        let first_asset = asset("asset:first", &bytes);
        let metadata = serde_json::to_vec(&vec![first_asset.clone()]).unwrap();
        let registry = CanvasPngAssetRegistryV1 {
            decoded_pixels: MAX_TOTAL_IMAGE_PIXELS_V1,
            ..CanvasPngAssetRegistryV1::default()
        };

        assert!(matches!(
            registry.prepare_candidate(&manifest(first_asset), &metadata, &[bytes]),
            Err(CanvasPngAssetRegistryErrorV1::RegistryLimit)
        ));
        assert!(registry.by_digest.is_empty());
    }
}
