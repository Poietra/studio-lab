use std::collections::BTreeSet;

use poietra_scene_ir::{
    ContractVersionV1, MAX_SCENE_POST_EFFECTS_V1, PROJECT_SCENE_POST_EFFECT_SHADER_ID,
    ProvenanceOriginV1, ProvenanceRecordV1, RGB_SPLIT_POST_EFFECT_SHADER_ID,
    RGB_SPLIT_POST_EFFECT_SHADER_REVISION, SceneCapabilityV1, SceneIrBundleV1, ScenePostEffectV1,
    SceneSourceV1,
};
use serde::Deserialize;

use crate::{EngineSessionV1, EvaluationError};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioScenePostEffectCommand {
    pub effects: Vec<ScenePostEffectV1>,
    pub expected_base_revision: String,
    pub next_revision: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioScenePostEffectError {
    #[error("the Scene post-effect base revision is stale")]
    StaleBaseRevision,
    #[error("the Scene post-effect revision must advance")]
    RevisionDidNotAdvance,
    #[error("the Studio Scene post effect is unsupported")]
    UnsupportedEffect,
    #[error(
        "the Studio Scene post-effect stack accepts at most {MAX_SCENE_POST_EFFECTS_V1} passes"
    )]
    TooManyEffects,
    #[error("the Studio Scene post-effect stack contains a duplicate shader identity")]
    DuplicateEffect,
    #[error(transparent)]
    InvalidScene(#[from] EvaluationError),
}

fn studio_effect_is_supported(effect: &ScenePostEffectV1) -> bool {
    (effect.shader_id == RGB_SPLIT_POST_EFFECT_SHADER_ID
        && effect.revision == RGB_SPLIT_POST_EFFECT_SHADER_REVISION)
        || (effect.shader_id == PROJECT_SCENE_POST_EFFECT_SHADER_ID && effect.revision > 0)
}

impl EngineSessionV1 {
    /// Atomically replaces the bounded ordered Scene-wide post-effect stack.
    ///
    /// Shader source and GPU resources remain renderer-owned. The complete
    /// candidate is validated before it replaces the retained Scene.
    ///
    /// # Errors
    ///
    /// Rejects stale revisions, unknown effect identities, and invalid results.
    pub fn apply_studio_scene_post_effect(
        &mut self,
        command: ApplyStudioScenePostEffectCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioScenePostEffectError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(ApplyStudioScenePostEffectError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(ApplyStudioScenePostEffectError::RevisionDidNotAdvance);
        }
        if command.effects.len() > MAX_SCENE_POST_EFFECTS_V1 {
            return Err(ApplyStudioScenePostEffectError::TooManyEffects);
        }
        if command
            .effects
            .iter()
            .any(|effect| !studio_effect_is_supported(effect))
        {
            return Err(ApplyStudioScenePostEffectError::UnsupportedEffect);
        }
        if command.effects.iter().enumerate().any(|(index, effect)| {
            command.effects[..index].iter().any(|earlier| {
                earlier.shader_id == effect.shader_id && earlier.revision == effect.revision
            })
        }) {
            return Err(ApplyStudioScenePostEffectError::DuplicateEffect);
        }

        let provenance_id = format!("studio-scene-post-effect:{}", command.next_revision);
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        candidate.scene.post_effects = command.effects;
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if candidate.scene.post_effects.is_empty() {
            capabilities.remove(&SceneCapabilityV1::ScenePostEffect);
        } else {
            capabilities.insert(SceneCapabilityV1::ScenePostEffect);
        }
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec!["Studio set the Scene-wide post-effect stack.".to_owned()],
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
    use super::super::tests::fixture_bundle;
    use super::*;

    const BASE_REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NEXT_REVISION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn session() -> EngineSessionV1 {
        let mut bundle = fixture_bundle("shared-circle-opacity.json");
        bundle.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: BASE_REVISION.to_owned(),
        };
        EngineSessionV1::new(bundle).unwrap()
    }

    fn rgb_split() -> ScenePostEffectV1 {
        ScenePostEffectV1 {
            parameters: vec![6.0, 2.0, 0.5, 0.0],
            revision: RGB_SPLIT_POST_EFFECT_SHADER_REVISION,
            shader_id: RGB_SPLIT_POST_EFFECT_SHADER_ID.to_owned(),
        }
    }

    #[test]
    fn atomically_replaces_and_removes_the_bounded_scene_post_effect_stack() {
        let mut session = session();
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            })
            .unwrap();
        assert_eq!(applied.scene.post_effects, vec![rgb_split()]);
        assert!(
            applied
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::ScenePostEffect)
        );

        let removed = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: Vec::new(),
                expected_base_revision: NEXT_REVISION.to_owned(),
                next_revision: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_owned(),
            })
            .unwrap();
        assert!(removed.scene.post_effects.is_empty());
        assert!(
            !removed
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::ScenePostEffect)
        );
    }

    #[test]
    fn rejects_unknown_effect_without_mutating_the_session() {
        let mut session = session();
        let result = session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
            effects: vec![ScenePostEffectV1 {
                parameters: vec![],
                revision: 1,
                shader_id: "unknown".to_owned(),
            }],
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
        });
        assert!(matches!(
            result,
            Err(ApplyStudioScenePostEffectError::UnsupportedEffect)
        ));
        assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);
        assert!(session.scene().post_effects.is_empty());
    }

    #[test]
    fn accepts_the_single_project_scene_post_effect_identity() {
        let mut session = session();
        let effect = ScenePostEffectV1 {
            parameters: vec![1.0, 2.0],
            revision: 7,
            shader_id: PROJECT_SCENE_POST_EFFECT_SHADER_ID.to_owned(),
        };
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![effect.clone()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            })
            .unwrap();
        assert_eq!(applied.scene.post_effects, vec![effect]);
    }

    #[test]
    fn rejects_an_oversized_or_duplicate_stack_without_mutating_the_session() {
        let mut session = session();
        let too_many = vec![rgb_split(); MAX_SCENE_POST_EFFECTS_V1 + 1];
        assert!(matches!(
            session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: too_many,
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            }),
            Err(ApplyStudioScenePostEffectError::TooManyEffects)
        ));
        assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);

        assert!(matches!(
            session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split(), rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            }),
            Err(ApplyStudioScenePostEffectError::DuplicateEffect)
        ));
        assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);
    }

    #[test]
    fn preserves_the_declared_stack_order() {
        let mut session = session();
        let project = ScenePostEffectV1 {
            parameters: vec![1.0, 2.0],
            revision: 7,
            shader_id: PROJECT_SCENE_POST_EFFECT_SHADER_ID.to_owned(),
        };
        let effects = vec![project, rgb_split()];
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: effects.clone(),
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
            })
            .unwrap();
        assert_eq!(applied.scene.post_effects, effects);
    }
}
