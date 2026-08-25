use std::collections::BTreeSet;

use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, FragmentMaterialV1, KeyframeV1, ProvenanceOriginV1,
    ProvenanceRecordV1, RenderCompositingV1, SceneAppearanceV1, SceneCapabilityV1, SceneIrBundleV1,
    SceneSourceV1, VectorAppearanceValueV1,
};
use serde::Deserialize;

use crate::{EngineSessionV1, EvaluationError};

#[derive(Clone, Copy)]
enum FragmentMaterialPaintTarget {
    Fill,
    Stroke,
}

fn fragment_material_paint_target(
    entity: &poietra_scene_ir::SceneEntityV1,
) -> Option<FragmentMaterialPaintTarget> {
    let SceneAppearanceV1::Vector { fill, stroke, .. } = &entity.appearance else {
        return None;
    };
    if fill.is_some() {
        return Some(FragmentMaterialPaintTarget::Fill);
    }
    if stroke.is_none() {
        return None;
    }
    match &entity.geometry {
        poietra_scene_ir::SceneGeometryV1::Line { .. } => Some(FragmentMaterialPaintTarget::Stroke),
        poietra_scene_ir::SceneGeometryV1::CubicPath { path }
            if !path.subpaths.is_empty() && path.subpaths.iter().all(|subpath| !subpath.closed) =>
        {
            Some(FragmentMaterialPaintTarget::Stroke)
        }
        poietra_scene_ir::SceneGeometryV1::Circle { .. }
        | poietra_scene_ir::SceneGeometryV1::Rectangle { .. }
        | poietra_scene_ir::SceneGeometryV1::CubicPath { .. }
        | poietra_scene_ir::SceneGeometryV1::Group {}
        | poietra_scene_ir::SceneGeometryV1::Image { .. } => None,
    }
}

fn fragment_material_capability_flags(scene: &poietra_scene_ir::SceneIrV1) -> (bool, bool) {
    let mut has_fragment_material = false;
    let mut has_png_image = scene.entities.iter().any(|entity| {
        matches!(
            entity.geometry,
            poietra_scene_ir::SceneGeometryV1::Image { .. }
        )
    });
    let mut inspect = |material: &FragmentMaterialV1| {
        has_fragment_material = true;
        has_png_image |= material.texture.is_some();
    };
    for entity in &scene.entities {
        if let SceneAppearanceV1::Vector { fill, stroke, .. } = &entity.appearance {
            if let Some(material) = fill
                .as_ref()
                .and_then(|fill| fill.fragment_material.as_ref())
            {
                inspect(material);
            }
            if let Some(material) = stroke
                .as_ref()
                .and_then(|stroke| stroke.fragment_material.as_ref())
            {
                inspect(material);
            }
        }
    }
    for channel in &scene.animation_channels {
        let poietra_scene_ir::AnimationChannelV1::VectorAppearance { keyframes, .. } = channel
        else {
            continue;
        };
        for keyframe in keyframes {
            for material in [
                keyframe
                    .value
                    .fill
                    .as_ref()
                    .and_then(|fill| fill.fragment_material.as_ref()),
                keyframe
                    .value
                    .stroke
                    .as_ref()
                    .and_then(|stroke| stroke.fragment_material.as_ref()),
            ]
            .into_iter()
            .flatten()
            {
                inspect(material);
            }
        }
    }
    (has_fragment_material, has_png_image)
}

fn fragment_materials_share_animation_identity(
    left: &FragmentMaterialV1,
    right: &FragmentMaterialV1,
) -> bool {
    left.shader_id == right.shader_id
        && left.revision == right.revision
        && left.texture == right.texture
        && left.parameters.len() == right.parameters.len()
}

fn fragment_material_at_keyframe(
    keyframe: &KeyframeV1<VectorAppearanceValueV1>,
    target: FragmentMaterialPaintTarget,
) -> Option<&FragmentMaterialV1> {
    match target {
        FragmentMaterialPaintTarget::Fill => keyframe
            .value
            .fill
            .as_ref()
            .and_then(|fill| fill.fragment_material.as_ref()),
        FragmentMaterialPaintTarget::Stroke => keyframe
            .value
            .stroke
            .as_ref()
            .and_then(|stroke| stroke.fragment_material.as_ref()),
    }
}

fn apply_fragment_material_to_appearance_keyframes(
    keyframes: &mut [KeyframeV1<VectorAppearanceValueV1>],
    material: Option<&FragmentMaterialV1>,
    target: FragmentMaterialPaintTarget,
) -> bool {
    let preserves_parameter_animation = material.is_some_and(|material| {
        keyframes
            .first()
            .and_then(|keyframe| fragment_material_at_keyframe(keyframe, target))
            == Some(material)
            && keyframes.iter().all(|keyframe| {
                fragment_material_at_keyframe(keyframe, target).is_some_and(|candidate| {
                    fragment_materials_share_animation_identity(candidate, material)
                })
            })
    });
    if preserves_parameter_animation {
        return false;
    }

    let mut changed = false;
    for keyframe in keyframes {
        let target_material = match target {
            FragmentMaterialPaintTarget::Fill => keyframe
                .value
                .fill
                .as_mut()
                .map(|fill| &mut fill.fragment_material),
            FragmentMaterialPaintTarget::Stroke => keyframe
                .value
                .stroke
                .as_mut()
                .map(|stroke| &mut stroke.fragment_material),
        };
        let Some(target_material) = target_material else {
            continue;
        };
        if target_material.as_ref() != material {
            *target_material = material.cloned();
            changed = true;
        }
    }
    changed
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioFragmentMaterialAssignment {
    pub entity_id: String,
    pub material: Option<FragmentMaterialV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioFragmentMaterialsCommand {
    pub assignments: Vec<StudioFragmentMaterialAssignment>,
    pub expected_base_revision: String,
    pub next_revision: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioFragmentMaterialsError {
    #[error("fragment materials require linear-light compositing")]
    LinearLightRequired,
    #[error("the fragment-material base revision is stale")]
    StaleBaseRevision,
    #[error("the fragment-material revision must advance")]
    RevisionDidNotAdvance,
    #[error("fragment-material assignments must name distinct supported vector paints")]
    UnsupportedTarget,
    #[error(transparent)]
    InvalidScene(#[from] EvaluationError),
}

fn fragment_material_assignment_targets(
    scene: &poietra_scene_ir::SceneIrV1,
    assignments: &[StudioFragmentMaterialAssignment],
) -> Result<Vec<FragmentMaterialPaintTarget>, ApplyStudioFragmentMaterialsError> {
    let mut target_ids = BTreeSet::new();
    assignments
        .iter()
        .map(|assignment| {
            if !target_ids.insert(assignment.entity_id.as_str()) {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            }
            scene
                .entities
                .iter()
                .find(|entity| entity.id == assignment.entity_id)
                .and_then(fragment_material_paint_target)
                .ok_or(ApplyStudioFragmentMaterialsError::UnsupportedTarget)
        })
        .collect()
}

impl EngineSessionV1 {
    /// Applies project-local material references without admitting WGSL source into Scene IR.
    ///
    /// Every target is checked before the candidate replaces the retained snapshot, so a failed
    /// assignment preserves the complete previous Scene.
    ///
    /// # Errors
    ///
    /// Rejects stale revisions, non-linear compositing, unsupported targets, and invalid results.
    pub fn apply_studio_fragment_materials(
        &mut self,
        command: ApplyStudioFragmentMaterialsCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioFragmentMaterialsError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(ApplyStudioFragmentMaterialsError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(ApplyStudioFragmentMaterialsError::RevisionDidNotAdvance);
        }
        if self.scene().compositing != RenderCompositingV1::LinearLight {
            return Err(ApplyStudioFragmentMaterialsError::LinearLightRequired);
        }
        let targets = fragment_material_assignment_targets(self.scene(), &command.assignments)?;

        let provenance_id = format!("studio-fragment-material:{}", command.next_revision);
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        for (assignment, target) in command.assignments.into_iter().zip(targets) {
            let Some(entity) = candidate
                .scene
                .entities
                .iter_mut()
                .find(|entity| entity.id == assignment.entity_id)
            else {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            };
            let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut entity.appearance else {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            };
            match target {
                FragmentMaterialPaintTarget::Fill => fill
                    .as_mut()
                    .ok_or(ApplyStudioFragmentMaterialsError::UnsupportedTarget)?
                    .fragment_material
                    .clone_from(&assignment.material),
                FragmentMaterialPaintTarget::Stroke => stroke
                    .as_mut()
                    .ok_or(ApplyStudioFragmentMaterialsError::UnsupportedTarget)?
                    .fragment_material
                    .clone_from(&assignment.material),
            }
            entity.provenance_id.clone_from(&provenance_id);
            for channel in &mut candidate.scene.animation_channels {
                let AnimationChannelV1::VectorAppearance {
                    entity_id,
                    keyframes,
                    provenance_id: channel_provenance_id,
                    ..
                } = channel
                else {
                    continue;
                };
                if *entity_id == assignment.entity_id
                    && apply_fragment_material_to_appearance_keyframes(
                        keyframes,
                        assignment.material.as_ref(),
                        target,
                    )
                {
                    channel_provenance_id.clone_from(&provenance_id);
                }
            }
        }
        let (has_fragment_material, has_png_image) =
            fragment_material_capability_flags(&candidate.scene);
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if has_fragment_material {
            capabilities.insert(SceneCapabilityV1::FragmentMaterial);
        } else {
            capabilities.remove(&SceneCapabilityV1::FragmentMaterial);
        }
        if has_png_image {
            capabilities.insert(SceneCapabilityV1::PngImage);
        } else {
            capabilities.remove(&SceneCapabilityV1::PngImage);
        }
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec![
                "Studio assigned a project-local fragment material reference.".to_owned(),
            ],
            id: provenance_id,
            origin: ProvenanceOriginV1::StudioEditProgram,
        });
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };
        self.replace_snapshot(candidate.clone())?;
        Ok(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{BASE_REVISION, NEXT_REVISION, imported_bundle};
    use super::*;

    fn assignment() -> StudioFragmentMaterialAssignment {
        StudioFragmentMaterialAssignment {
            entity_id: "later".to_owned(),
            material: Some(FragmentMaterialV1 {
                parameters: vec![0.5, 8.0],
                revision: 1,
                shader_id: "project-studio-fragment".to_owned(),
                texture: None,
            }),
        }
    }

    #[test]
    fn assigns_one_fill_atomically_and_rejects_non_linear_scenes() {
        let mut session = EngineSessionV1::new(imported_bundle()).unwrap();
        let bundle = session
            .apply_studio_fragment_materials(ApplyStudioFragmentMaterialsCommand {
                assignments: vec![assignment()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            })
            .unwrap();
        assert!(
            bundle
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::FragmentMaterial)
        );
        assert!(matches!(
            &bundle.scene.entities.iter().find(|entity| entity.id == "later").unwrap().appearance,
            SceneAppearanceV1::Vector { fill: Some(fill), .. }
                if fill.fragment_material.as_ref().is_some_and(|material| material.shader_id == "project-studio-fragment")
        ));

        let mut non_linear = imported_bundle();
        non_linear.scene.compositing = RenderCompositingV1::ManimCairoSrgb;
        let mut non_linear_session = EngineSessionV1::new(non_linear).unwrap();
        assert!(matches!(
            non_linear_session.apply_studio_fragment_materials(
                ApplyStudioFragmentMaterialsCommand {
                    assignments: vec![assignment()],
                    expected_base_revision: BASE_REVISION.to_owned(),
                    next_revision: NEXT_REVISION.to_owned(),
                }
            ),
            Err(ApplyStudioFragmentMaterialsError::LinearLightRequired)
        ));
        assert_eq!(
            non_linear_session.scene().source.revision_hash(),
            BASE_REVISION
        );
    }

    #[test]
    fn assigns_one_material_to_fillless_line_and_open_pen_strokes() {
        let line = poietra_scene_ir::SceneGeometryV1::Line {
            end: poietra_scene_ir::PointV1 { x: 2.0, y: 0.0 },
            start: poietra_scene_ir::PointV1 { x: -2.0, y: 0.0 },
        };
        let open_pen = poietra_scene_ir::SceneGeometryV1::CubicPath {
            path: poietra_scene_ir::CubicPathV1 {
                subpaths: vec![poietra_scene_ir::CubicSubpathV1 {
                    closed: false,
                    segments: vec![
                        poietra_scene_ir::CubicSegmentV1 {
                            control1: poietra_scene_ir::PointV1 { x: -1.0, y: 1.0 },
                            control2: poietra_scene_ir::PointV1 { x: 0.0, y: 1.0 },
                            end: poietra_scene_ir::PointV1 { x: 0.5, y: 0.0 },
                        },
                        poietra_scene_ir::CubicSegmentV1 {
                            control1: poietra_scene_ir::PointV1 { x: 1.0, y: -1.0 },
                            control2: poietra_scene_ir::PointV1 { x: 1.5, y: -1.0 },
                            end: poietra_scene_ir::PointV1 { x: 2.0, y: 0.0 },
                        },
                    ],
                    start: poietra_scene_ir::PointV1 { x: -2.0, y: 0.0 },
                }],
            },
        };

        for geometry in [line, open_pen] {
            let mut input = imported_bundle();
            let target = input
                .scene
                .entities
                .iter_mut()
                .find(|entity| entity.id == "later")
                .unwrap();
            target.geometry = geometry;
            target.appearance = SceneAppearanceV1::Vector {
                fill: None,
                opacity: 1.0,
                stroke: Some(poietra_scene_ir::StrokeStyleV1 {
                    cap: poietra_scene_ir::StrokeCapV1::Round,
                    color: poietra_scene_ir::RgbaColorV1 {
                        alpha: 1.0,
                        blue: 1.0,
                        green: 1.0,
                        red: 1.0,
                    },
                    dash_length_world: None,
                    fragment_material: None,
                    gap_length_world: None,
                    join: poietra_scene_ir::StrokeJoinV1::Round,
                    miter_limit: 4.0,
                    width_world: 0.2,
                }),
            };
            if matches!(
                target.geometry,
                poietra_scene_ir::SceneGeometryV1::CubicPath { .. }
            ) {
                input
                    .scene
                    .required_capabilities
                    .push(SceneCapabilityV1::CubicPathGeometry);
                input.scene.required_capabilities.sort_unstable();
                input.scene.required_capabilities.dedup();
            }

            let mut session = EngineSessionV1::new(input).unwrap();
            let bundle = session
                .apply_studio_fragment_materials(ApplyStudioFragmentMaterialsCommand {
                    assignments: vec![assignment()],
                    expected_base_revision: BASE_REVISION.to_owned(),
                    next_revision: NEXT_REVISION.to_owned(),
                })
                .unwrap();
            let SceneAppearanceV1::Vector { fill, stroke, .. } = &bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "later")
                .unwrap()
                .appearance
            else {
                unreachable!()
            };
            assert!(fill.is_none());
            assert!(
                stroke
                    .as_ref()
                    .and_then(|stroke| stroke.fragment_material.as_ref())
                    .is_some_and(|material| material.shader_id == "project-studio-fragment")
            );
        }
    }

    #[test]
    fn assigns_the_same_material_to_existing_appearance_keyframes() {
        let mut input = imported_bundle();
        let target = input
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        let SceneAppearanceV1::Vector { fill, stroke, .. } = &target.appearance else {
            panic!("the fixture target must have vector appearance");
        };
        let mut first_fill = fill.clone().unwrap();
        first_fill.color.alpha = 0.4;
        let mut last_fill = fill.clone().unwrap();
        last_fill.color.alpha = 0.8;
        input
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::VectorAppearanceAnimation);
        input
            .scene
            .animation_channels
            .push(AnimationChannelV1::VectorAppearance {
                entity_id: "later".to_owned(),
                id: "appearance:later".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(poietra_scene_ir::EasingV1::Linear {}),
                        value: VectorAppearanceValueV1 {
                            fill: Some(first_fill),
                            stroke: stroke.clone(),
                        },
                    },
                    KeyframeV1 {
                        at: input.scene.duration,
                        easing_to_next: None,
                        value: VectorAppearanceValueV1 {
                            fill: Some(last_fill),
                            stroke: stroke.clone(),
                        },
                    },
                ],
                provenance_id: target.provenance_id.clone(),
            });

        let mut session = EngineSessionV1::new(input).unwrap();
        let bundle = session
            .apply_studio_fragment_materials(ApplyStudioFragmentMaterialsCommand {
                assignments: vec![assignment()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            })
            .unwrap();

        let material = assignment().material.unwrap();
        let appearance_material = bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::VectorAppearance {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "later" => Some(
                    keyframes
                        .iter()
                        .map(|keyframe| {
                            keyframe
                                .value
                                .fill
                                .as_ref()
                                .and_then(|fill| fill.fragment_material.as_ref())
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .unwrap();
        assert!(
            appearance_material
                .into_iter()
                .all(|candidate| candidate == Some(&material))
        );
    }
}
