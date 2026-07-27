use std::collections::{HashMap, HashSet};

use crate::digest::validate_asset_manifest_digest_v1;
use crate::model::{
    AssetManifestReferenceV1, AssetManifestV1, AssetReferenceV1, EngineFrameV1, PngAssetV1,
    RenderDrawV1, RenderPacketBundleV1, RenderPacketV1, SceneAppearanceV1, SceneEntityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneIrV1,
};
use crate::validate::{
    ValidationErrors, ValidationIssue, push_validation_issue, validate_asset_manifest_v1,
    validate_render_packet_v1, validate_scene_ir_v1,
};

fn collect_at(
    issues: &mut Vec<ValidationIssue>,
    result: Result<(), ValidationErrors>,
    prefix: &str,
) {
    if let Err(errors) = result {
        for mut issue in errors.issues().iter().cloned() {
            issue.path = if issue.path == "$" {
                prefix.to_owned()
            } else if let Some(suffix) = issue.path.strip_prefix('$') {
                format!("{prefix}{suffix}")
            } else {
                format!("{prefix}.{}", issue.path)
            };
            push_validation_issue(issues, issue.path, issue.message);
        }
    }
}

fn finish(issues: Vec<ValidationIssue>) -> Result<(), ValidationErrors> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ValidationErrors::new(issues))
    }
}

fn issue(issues: &mut Vec<ValidationIssue>, path: impl Into<String>, message: impl Into<String>) {
    push_validation_issue(issues, path, message);
}

fn validate_manifest_reference(
    reference: &AssetManifestReferenceV1,
    manifest: &AssetManifestV1,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    if reference.manifest_id != manifest.manifest_id
        || reference.manifest_digest != manifest.manifest_digest
    {
        issue(issues, path, "asset manifest reference is stale");
    }
}

fn asset_index(manifest: &AssetManifestV1) -> HashMap<&str, &PngAssetV1> {
    manifest
        .assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect()
}

fn validate_asset_reference(
    reference: &AssetReferenceV1,
    assets: &HashMap<&str, &PngAssetV1>,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    match assets.get(reference.asset_id.as_str()) {
        None => issue(
            issues,
            path,
            format!("missing asset {}", reference.asset_id),
        ),
        Some(asset) if asset.sha256 != reference.sha256 => issue(
            issues,
            path,
            format!("stale asset reference {}", reference.asset_id),
        ),
        Some(_) => {}
    }
}

fn validate_scene_assets(
    scene: &SceneIrV1,
    manifest: &AssetManifestV1,
    scene_prefix: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    validate_manifest_reference(
        &scene.asset_manifest,
        manifest,
        &format!("{scene_prefix}.assetManifest"),
        issues,
    );
    let assets = asset_index(manifest);
    for (index, entity) in scene.entities.iter().enumerate() {
        if let SceneGeometryV1::Image { asset, .. } = &entity.geometry {
            validate_asset_reference(
                asset,
                &assets,
                &format!("{scene_prefix}.entities[{index}].geometry.asset"),
                issues,
            );
        }
    }
}

fn validate_packet_assets(
    packet: &RenderPacketV1,
    manifest: &AssetManifestV1,
    packet_prefix: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    validate_manifest_reference(
        &packet.asset_manifest,
        manifest,
        &format!("{packet_prefix}.assetManifest"),
        issues,
    );
    let assets = asset_index(manifest);
    for (index, draw) in packet.draws.iter().enumerate() {
        if let RenderDrawV1::Image { asset, .. } = draw {
            validate_asset_reference(
                asset,
                &assets,
                &format!("{packet_prefix}.draws[{index}].asset"),
                issues,
            );
        }
    }
}

/// Validates structural rules, the manifest digest, and every scene asset reference.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_scene_ir_with_assets_v1(
    scene: &SceneIrV1,
    assets: &AssetManifestV1,
) -> Result<(), ValidationErrors> {
    let mut issues = Vec::new();
    collect_at(&mut issues, validate_asset_manifest_v1(assets), "$.assets");
    collect_at(
        &mut issues,
        validate_asset_manifest_digest_v1(assets),
        "$.assets",
    );
    collect_at(&mut issues, validate_scene_ir_v1(scene), "$.scene");
    validate_scene_assets(scene, assets, "$.scene", &mut issues);
    finish(issues)
}

/// Validates structural rules, the manifest digest, and every scene asset reference.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_scene_ir_bundle_v1(bundle: &SceneIrBundleV1) -> Result<(), ValidationErrors> {
    validate_scene_ir_with_assets_v1(&bundle.scene, &bundle.assets)
}

/// Validates structural rules, the manifest digest, and every packet asset reference.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_render_packet_bundle_v1(
    bundle: &RenderPacketBundleV1,
) -> Result<(), ValidationErrors> {
    let mut issues = Vec::new();
    collect_at(
        &mut issues,
        validate_asset_manifest_v1(&bundle.assets),
        "$.assets",
    );
    collect_at(
        &mut issues,
        validate_asset_manifest_digest_v1(&bundle.assets),
        "$.assets",
    );
    collect_at(
        &mut issues,
        validate_render_packet_v1(&bundle.packet),
        "$.packet",
    );
    validate_packet_assets(&bundle.packet, &bundle.assets, "$.packet", &mut issues);
    finish(issues)
}

fn entity_is_active(entity: &SceneEntityV1, sample_time: f64) -> bool {
    entity
        .lifetimes
        .iter()
        .any(|lifetime| sample_time >= lifetime.start && sample_time < lifetime.end)
}

#[allow(clippy::too_many_lines, clippy::float_cmp)]
fn validate_render_packet_for_scene(
    packet: &RenderPacketV1,
    scene: &SceneIrV1,
    assets: &AssetManifestV1,
    validate_source_bundle: bool,
) -> Result<(), ValidationErrors> {
    let mut issues = Vec::new();
    if validate_source_bundle {
        collect_at(&mut issues, validate_asset_manifest_v1(assets), "$.assets");
        collect_at(
            &mut issues,
            validate_asset_manifest_digest_v1(assets),
            "$.assets",
        );
        collect_at(&mut issues, validate_scene_ir_v1(scene), "$.scene");
        validate_scene_assets(scene, assets, "$.scene", &mut issues);
    }
    collect_at(&mut issues, validate_render_packet_v1(packet), "$.packet");
    validate_packet_assets(packet, assets, "$.packet", &mut issues);

    if packet.scene_id != scene.scene_id {
        issue(
            &mut issues,
            "$.packet.sceneId",
            "packet scene ID does not match scene IR",
        );
    }
    if packet.scene_duration != scene.duration {
        issue(
            &mut issues,
            "$.packet.sceneDuration",
            "packet scene duration does not match scene IR",
        );
    }
    if packet.scene_revision_hash != scene.source.revision_hash() {
        issue(
            &mut issues,
            "$.packet.sceneRevisionHash",
            "packet scene revision does not match scene source evidence",
        );
    }

    let entities: HashMap<&str, &SceneEntityV1> = scene
        .entities
        .iter()
        .map(|entity| (entity.id.as_str(), entity))
        .collect();
    let mut drawn_entities = HashSet::new();
    for (index, draw) in packet.draws.iter().enumerate() {
        let path = format!("$.packet.draws[{index}]");
        let Some(entity) = entities.get(draw.entity_id()) else {
            issue(
                &mut issues,
                format!("{path}.entityId"),
                format!("draw references unknown entity {}", draw.entity_id()),
            );
            continue;
        };
        if !drawn_entities.insert(draw.entity_id()) {
            issue(
                &mut issues,
                format!("{path}.entityId"),
                format!("entity {} has more than one draw", draw.entity_id()),
            );
        }
        if !entity_is_active(entity, packet.sample_time) {
            issue(
                &mut issues,
                format!("{path}.entityId"),
                format!("draw entity {} is outside its lifetime", draw.entity_id()),
            );
        }
        if draw.source_z_index() != entity.source_z_index {
            issue(
                &mut issues,
                format!("{path}.sourceZIndex"),
                format!(
                    "draw entity {} has stale source z-index evidence",
                    draw.entity_id()
                ),
            );
        }

        match (draw, &entity.geometry, &entity.appearance) {
            (RenderDrawV1::Path { .. }, SceneGeometryV1::Image { .. }, _)
            | (RenderDrawV1::Image { .. }, _, SceneAppearanceV1::Vector { .. }) => {
                issue(
                    &mut issues,
                    format!("{path}.kind"),
                    format!("draw kind does not match entity {}", draw.entity_id()),
                );
            }
            (
                RenderDrawV1::Path { fill, stroke, .. },
                _,
                SceneAppearanceV1::Vector {
                    fill: entity_fill,
                    stroke: entity_stroke,
                    ..
                },
            ) => {
                if fill != entity_fill || stroke != entity_stroke {
                    issue(
                        &mut issues,
                        path.clone(),
                        format!("path paint does not match entity {}", draw.entity_id()),
                    );
                }
            }
            (
                RenderDrawV1::Image {
                    asset,
                    local_rect,
                    sampler,
                    ..
                },
                SceneGeometryV1::Image {
                    asset: entity_asset,
                    local_rect: entity_local_rect,
                    sampler: entity_sampler,
                },
                SceneAppearanceV1::Image { .. },
            ) => {
                if asset != entity_asset
                    || local_rect != entity_local_rect
                    || sampler != entity_sampler
                {
                    issue(
                        &mut issues,
                        path.clone(),
                        format!("image draw does not match entity {}", draw.entity_id()),
                    );
                }
            }
            (RenderDrawV1::Image { .. } | RenderDrawV1::Path { .. }, _, _) => {
                issue(
                    &mut issues,
                    format!("{path}.kind"),
                    format!("draw kind does not match entity {}", draw.entity_id()),
                );
            }
        }
    }

    for entity in &scene.entities {
        if entity_is_active(entity, packet.sample_time)
            && !drawn_entities.contains(entity.id.as_str())
        {
            issue(
                &mut issues,
                "$.packet.draws",
                format!("active entity {} is missing from the packet", entity.id),
            );
        }
    }

    for index in 1..packet.draws.len() {
        let previous = entities.get(packet.draws[index - 1].entity_id());
        let current = entities.get(packet.draws[index].entity_id());
        if let (Some(previous), Some(current)) = (previous, current) {
            if previous.source_z_index > current.source_z_index
                || (previous.source_z_index == current.source_z_index
                    && previous.scene_order > current.scene_order)
            {
                issue(
                    &mut issues,
                    format!("$.packet.draws[{index}].paintOrder"),
                    "packet draw order does not match scene z-index and scene order",
                );
            }
        }
    }
    finish(issues)
}

/// Validates an evaluated packet against a Scene and manifest that already passed
/// [`validate_scene_ir_with_assets_v1`]. The packet and all cross-document links
/// are still checked in full, without rescanning immutable Scene geometry.
///
/// # Errors
///
/// Returns all detected packet or cross-document contract violations.
pub fn validate_render_packet_for_validated_scene_v1(
    packet: &RenderPacketV1,
    scene: &SceneIrV1,
    assets: &AssetManifestV1,
) -> Result<(), ValidationErrors> {
    validate_render_packet_for_scene(packet, scene, assets, false)
}

/// Validates a complete sampled frame, including scene/packet linkage and active draw integrity.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_engine_frame_v1(frame: &EngineFrameV1) -> Result<(), ValidationErrors> {
    validate_render_packet_for_scene(&frame.packet, &frame.scene, &frame.assets, true)
}
