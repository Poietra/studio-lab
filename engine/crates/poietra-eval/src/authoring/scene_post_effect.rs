use std::collections::BTreeSet;

use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, KeyframeV1, MAX_FRAGMENT_MATERIAL_PARAMETERS_V1,
    MAX_SCENE_POST_EFFECTS_V1, PROJECT_SCENE_POST_EFFECT_SHADER_ID, ProvenanceOriginV1,
    ProvenanceRecordV1, RGB_SPLIT_POST_EFFECT_SHADER_ID, RGB_SPLIT_POST_EFFECT_SHADER_REVISION,
    SceneAppearanceV1, SceneCapabilityV1, SceneGeometryV1, SceneIrBundleV1, SceneIrV1,
    ScenePostEffectV1, SceneSourceV1,
};
use serde::Deserialize;

use super::creation::property_easing;
use super::{StudioPropertyEasing, TIMELINE_ANCHOR_EPSILON};
use crate::{EngineSessionV1, EvaluationError};

/// Maximum number of editable markers retained for one Scene post-effect scalar.
pub const MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES: usize = 32;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioScenePostEffectParameterKeyframe {
    pub easing: StudioPropertyEasing,
    pub time: f64,
    pub value: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioScenePostEffectParameterTrack {
    pub keyframes: Vec<StudioScenePostEffectParameterKeyframe>,
    pub parameter_index: u32,
    pub revision: u32,
    pub shader_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioScenePostEffectCommand {
    pub effects: Vec<ScenePostEffectV1>,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub parameter_tracks: Vec<StudioScenePostEffectParameterTrack>,
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
    #[error("the Studio Scene post-effect parameter tracks contain a duplicate target")]
    DuplicateParameterTrack,
    #[error("the Studio Scene post-effect parameter track target is unknown")]
    UnknownParameterTrackTarget,
    #[error(
        "a Studio Scene post-effect parameter track must contain between 2 and {MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES} valid ordered markers"
    )]
    InvalidParameterTrack,
    #[error("the Studio Scene post-effect parameter track baseline is stale")]
    StaleParameterTrackBaseline,
    #[error(transparent)]
    InvalidScene(#[from] EvaluationError),
}

fn studio_effect_is_supported(effect: &ScenePostEffectV1) -> bool {
    let builtin = effect.shader_id == RGB_SPLIT_POST_EFFECT_SHADER_ID
        && effect.revision == RGB_SPLIT_POST_EFFECT_SHADER_REVISION
        && effect.texture.is_none();
    let project = effect.shader_id == PROJECT_SCENE_POST_EFFECT_SHADER_ID && effect.revision > 0;
    builtin || project
}

fn scene_uses_png(scene: &SceneIrV1) -> bool {
    scene.post_effects.iter().any(|effect| effect.texture.is_some())
        || scene.entities.iter().any(|entity| {
            matches!(entity.geometry, SceneGeometryV1::Image { .. })
                || matches!(
                    &entity.appearance,
                    SceneAppearanceV1::Vector { fill, stroke, .. }
                        if fill.as_ref().and_then(|fill| fill.fragment_material.as_ref()).is_some_and(|material| material.texture.is_some())
                            || stroke.as_ref().and_then(|stroke| stroke.fragment_material.as_ref()).is_some_and(|material| material.texture.is_some())
                )
        })
}

fn scene_post_effect_parameter_channels(
    effects: &[ScenePostEffectV1],
    tracks: &[StudioScenePostEffectParameterTrack],
    provenance_id: &str,
    revision: &str,
    duration: f64,
) -> Result<Vec<AnimationChannelV1>, ApplyStudioScenePostEffectError> {
    if tracks.len() > MAX_SCENE_POST_EFFECTS_V1.saturating_mul(MAX_FRAGMENT_MATERIAL_PARAMETERS_V1)
    {
        return Err(ApplyStudioScenePostEffectError::InvalidParameterTrack);
    }
    let mut targets = BTreeSet::new();
    let mut channels = Vec::with_capacity(tracks.len());
    for (track_index, track) in tracks.iter().enumerate() {
        if !targets.insert((
            track.shader_id.as_str(),
            track.revision,
            track.parameter_index,
        )) {
            return Err(ApplyStudioScenePostEffectError::DuplicateParameterTrack);
        }
        let effect = effects
            .iter()
            .find(|effect| effect.shader_id == track.shader_id && effect.revision == track.revision)
            .ok_or(ApplyStudioScenePostEffectError::UnknownParameterTrackTarget)?;
        let parameter_index = usize::try_from(track.parameter_index)
            .ok()
            .filter(|parameter_index| *parameter_index < effect.parameters.len())
            .ok_or(ApplyStudioScenePostEffectError::UnknownParameterTrackTarget)?;
        if track.keyframes.len() < 2
            || track.keyframes.len() > MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES
            || track.keyframes.iter().enumerate().any(|(index, keyframe)| {
                !keyframe.time.is_finite()
                    || keyframe.time < 0.0
                    || keyframe.time > duration
                    || !keyframe.value.is_finite()
                    || keyframe.value < f64::from(f32::MIN)
                    || keyframe.value > f64::from(f32::MAX)
                    || (index > 0 && track.keyframes[index - 1].time >= keyframe.time)
            })
        {
            return Err(ApplyStudioScenePostEffectError::InvalidParameterTrack);
        }
        if (track.keyframes[0].value - effect.parameters[parameter_index]).abs()
            > TIMELINE_ANCHOR_EPSILON
        {
            return Err(ApplyStudioScenePostEffectError::StaleParameterTrackBaseline);
        }
        let baseline = effect.parameters[parameter_index];
        let final_index = track.keyframes.len() - 1;
        let keyframes = track
            .keyframes
            .iter()
            .enumerate()
            .map(|(index, keyframe)| KeyframeV1 {
                at: keyframe.time,
                easing_to_next: (index != final_index).then(|| property_easing(keyframe.easing)),
                value: if index == 0 { baseline } else { keyframe.value },
            })
            .collect();
        channels.push(AnimationChannelV1::ScenePostEffectParameter {
            id: format!("studio-scene-post-effect-parameter:{revision}:{track_index}"),
            keyframes,
            parameter_index: track.parameter_index,
            provenance_id: provenance_id.to_owned(),
            revision: track.revision,
            shader_id: track.shader_id.clone(),
        });
    }
    Ok(channels)
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
        let parameter_channels = scene_post_effect_parameter_channels(
            &candidate.scene.post_effects,
            &command.parameter_tracks,
            &provenance_id,
            &command.next_revision,
            candidate.scene.duration,
        )?;
        candidate.scene.animation_channels.retain(|channel| {
            !matches!(channel, AnimationChannelV1::ScenePostEffectParameter { .. })
        });
        candidate
            .scene
            .animation_channels
            .extend(parameter_channels);
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
        if scene_uses_png(&candidate.scene) {
            capabilities.insert(SceneCapabilityV1::PngImage);
        } else {
            capabilities.remove(&SceneCapabilityV1::PngImage);
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
    use crate::SampleEngineSessionOptionsV1;
    use poietra_scene_ir::ViewportV1;

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
            texture: None,
        }
    }

    fn parameter_track(
        parameter_index: u32,
        keyframes: &[(f64, f64)],
    ) -> StudioScenePostEffectParameterTrack {
        StudioScenePostEffectParameterTrack {
            keyframes: keyframes
                .iter()
                .map(|(time, value)| StudioScenePostEffectParameterKeyframe {
                    easing: StudioPropertyEasing::Linear,
                    time: *time,
                    value: *value,
                })
                .collect(),
            parameter_index,
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
                parameter_tracks: Vec::new(),
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
                parameter_tracks: Vec::new(),
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
                texture: None,
            }],
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            parameter_tracks: Vec::new(),
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
            texture: None,
        };
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![effect.clone()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: Vec::new(),
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
                parameter_tracks: Vec::new(),
            }),
            Err(ApplyStudioScenePostEffectError::TooManyEffects)
        ));
        assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);

        assert!(matches!(
            session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split(), rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: Vec::new(),
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
            texture: None,
        };
        let effects = vec![project, rgb_split()];
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: effects.clone(),
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: Vec::new(),
            })
            .unwrap();
        assert_eq!(applied.scene.post_effects, effects);
    }

    #[test]
    fn installs_and_samples_one_scene_post_effect_parameter_track() {
        let mut session = session();
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: vec![parameter_track(0, &[(0.0, 6.0), (2.0, 10.0)])],
            })
            .unwrap();
        assert!(matches!(
            applied.scene.animation_channels.last(),
            Some(AnimationChannelV1::ScenePostEffectParameter {
                parameter_index: 0,
                revision: RGB_SPLIT_POST_EFFECT_SHADER_REVISION,
                shader_id,
                ..
            }) if shader_id == RGB_SPLIT_POST_EFFECT_SHADER_ID
        ));

        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "packet:animated-scene-post-effect",
                sample_time: 1.0,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert_eq!(packet.post_effects[0].parameters, vec![8.0, 2.0, 0.5, 0.0]);
    }

    #[test]
    fn installs_and_samples_multiple_scene_post_effect_parameter_tracks() {
        let mut session = session();
        session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: vec![
                    parameter_track(0, &[(0.0, 6.0), (2.0, 10.0)]),
                    parameter_track(1, &[(0.0, 2.0), (2.0, 6.0)]),
                ],
            })
            .unwrap();

        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "packet:multiple-animated-scene-post-effect-parameters",
                sample_time: 1.0,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert_eq!(packet.post_effects[0].parameters, vec![8.0, 4.0, 0.5, 0.0]);
    }

    #[test]
    fn empty_parameter_tracks_remove_the_previous_animation_atomically() {
        let mut session = session();
        session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split()],
                expected_base_revision: BASE_REVISION.to_owned(),
                next_revision: NEXT_REVISION.to_owned(),
                parameter_tracks: vec![parameter_track(0, &[(0.0, 6.0), (2.0, 10.0)])],
            })
            .unwrap();
        let final_revision = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let applied = session
            .apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                effects: vec![rgb_split()],
                expected_base_revision: NEXT_REVISION.to_owned(),
                next_revision: final_revision.to_owned(),
                parameter_tracks: Vec::new(),
            })
            .unwrap();
        assert!(!applied.scene.animation_channels.iter().any(|channel| {
            matches!(channel, AnimationChannelV1::ScenePostEffectParameter { .. })
        }));
    }

    #[test]
    fn rejects_invalid_parameter_tracks_without_mutating_the_session() {
        let cases = [
            (
                parameter_track(0, &[(0.0, 6.0)]),
                ApplyStudioScenePostEffectError::InvalidParameterTrack,
            ),
            (
                parameter_track(0, &[(0.0, 7.0), (2.0, 10.0)]),
                ApplyStudioScenePostEffectError::StaleParameterTrackBaseline,
            ),
            (
                parameter_track(0, &[(1.0, 6.0), (0.5, 10.0)]),
                ApplyStudioScenePostEffectError::InvalidParameterTrack,
            ),
            (
                parameter_track(4, &[(0.0, 0.0), (2.0, 1.0)]),
                ApplyStudioScenePostEffectError::UnknownParameterTrackTarget,
            ),
        ];
        for (track, expected) in cases {
            let mut session = session();
            let result =
                session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
                    effects: vec![rgb_split()],
                    expected_base_revision: BASE_REVISION.to_owned(),
                    next_revision: NEXT_REVISION.to_owned(),
                    parameter_tracks: vec![track],
                });
            assert_eq!(
                std::mem::discriminant(&result.unwrap_err()),
                std::mem::discriminant(&expected)
            );
            assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);
            assert!(!session.scene().animation_channels.iter().any(|channel| {
                matches!(channel, AnimationChannelV1::ScenePostEffectParameter { .. })
            }));
        }
    }

    #[test]
    fn rejects_duplicate_parameter_targets_without_mutating_the_session() {
        let mut session = session();
        let track = parameter_track(0, &[(0.0, 6.0), (2.0, 10.0)]);
        let result = session.apply_studio_scene_post_effect(ApplyStudioScenePostEffectCommand {
            effects: vec![rgb_split()],
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            parameter_tracks: vec![track.clone(), track],
        });
        assert!(matches!(
            result,
            Err(ApplyStudioScenePostEffectError::DuplicateParameterTrack)
        ));
        assert_eq!(session.scene().source.revision_hash(), BASE_REVISION);
    }
}
