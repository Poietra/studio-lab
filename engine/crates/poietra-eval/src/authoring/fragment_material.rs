use std::collections::BTreeSet;

use poietra_scene_ir::{
    ContractVersionV1, FragmentMaterialV1, ProvenanceOriginV1, ProvenanceRecordV1,
    RenderCompositingV1, SceneAppearanceV1, SceneCapabilityV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::Deserialize;

use crate::{EngineSessionV1, EvaluationError};

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
        if let SceneAppearanceV1::Vector {
            fill: Some(fill), ..
        } = &entity.appearance
            && let Some(material) = &fill.fragment_material
        {
            inspect(material);
        }
    }
    for channel in &scene.animation_channels {
        let poietra_scene_ir::AnimationChannelV1::VectorAppearance { keyframes, .. } = channel
        else {
            continue;
        };
        for keyframe in keyframes {
            if let Some(material) = keyframe
                .value
                .fill
                .as_ref()
                .and_then(|fill| fill.fragment_material.as_ref())
            {
                inspect(material);
            }
        }
    }
    (has_fragment_material, has_png_image)
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
    #[error("fragment-material assignments must name distinct existing vector fills")]
    UnsupportedTarget,
    #[error(transparent)]
    InvalidScene(#[from] EvaluationError),
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
        let mut target_ids = BTreeSet::new();
        for assignment in &command.assignments {
            if !target_ids.insert(assignment.entity_id.as_str())
                || !self.scene().entities.iter().any(|entity| {
                    entity.id == assignment.entity_id
                        && matches!(
                            entity.appearance,
                            SceneAppearanceV1::Vector { fill: Some(_), .. }
                        )
                })
            {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            }
        }

        let provenance_id = format!("studio-fragment-material:{}", command.next_revision);
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        for assignment in command.assignments {
            let Some(entity) = candidate
                .scene
                .entities
                .iter_mut()
                .find(|entity| entity.id == assignment.entity_id)
            else {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            };
            let SceneAppearanceV1::Vector {
                fill: Some(fill), ..
            } = &mut entity.appearance
            else {
                return Err(ApplyStudioFragmentMaterialsError::UnsupportedTarget);
            };
            fill.fragment_material = assignment.material;
            entity.provenance_id.clone_from(&provenance_id);
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
}
