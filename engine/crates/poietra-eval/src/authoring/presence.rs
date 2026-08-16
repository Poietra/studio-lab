use std::collections::BTreeSet;

use poietra_scene_ir::{AnimationChannelV1, EasingV1, IntervalV1, KeyframeV1, SceneCapabilityV1};
use serde::Serialize;

use super::{
    TIMELINE_ANCHOR_EPSILON, close_transform_baseline_value, studio_timeline_semantic_values_match,
    unused_channel_id,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PersistentSceneRemoval {
    pub(super) entity_id: String,
    pub(super) interval: IntervalV1,
    pub(super) operation_id: String,
    pub(super) studio_entity_id: String,
    pub(super) transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersistentRemoveProjectionEntry {
    pub affected_scene_entity_ids: Vec<String>,
    pub fade_interval: Option<IntervalV1>,
    pub operation_id: String,
    pub removed_at: f64,
    pub resulting_lifetime_end: f64,
    pub scene_entity_id: String,
    pub studio_entity_id: String,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersistentRemoveProjection {
    pub removals: Vec<StudioPersistentRemoveProjectionEntry>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioPersistentRemoveError {
    #[error("a persistent remove command must contain at least one target")]
    EmptyBatch,
    #[error("a persistent remove interval must be finite and inside the Scene")]
    InvalidInterval,
    #[error("a persistent remove command contains a duplicate target: {0}")]
    DuplicateTarget(String),
    #[error("persistent remove targets overlap in one Scene subtree: {0} and {1}")]
    OverlappingTargets(String, String),
    #[error("the persistent remove target does not exist: {0}")]
    TargetMissing(String),
    #[error("persistent remove currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the persistent remove target is not active for the complete interval: {0}")]
    TargetInactive(String),
    #[error("the persistent remove target already has overlapping opacity animation: {0}")]
    OpacityAnimationConflict(String),
}

#[derive(Clone, Debug)]
struct PlannedPersistentSceneRemoval {
    affected_entities: Vec<(usize, Vec<IntervalV1>)>,
    affected_entity_ids: Vec<String>,
    opacity_channel_index: Option<usize>,
    removal: PersistentSceneRemoval,
    root_entity_index: usize,
}

#[allow(
    clippy::too_many_lines,
    reason = "one plan pass must validate every subtree before the separate mutation pass begins"
)]
fn plan_persistent_scene_removals(
    scene: &poietra_scene_ir::SceneIrV1,
    removals: &[PersistentSceneRemoval],
) -> Result<Vec<PlannedPersistentSceneRemoval>, ApplyStudioPersistentRemoveError> {
    if removals.is_empty() {
        return Err(ApplyStudioPersistentRemoveError::EmptyBatch);
    }
    let entity_indexes = scene
        .entities
        .iter()
        .enumerate()
        .map(|(index, entity)| (entity.id.as_str(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let mut children = vec![Vec::new(); scene.entities.len()];
    for (entity_index, entity) in scene.entities.iter().enumerate() {
        if let Some(parent_id) = entity.parent_id.as_deref() {
            let Some(&parent_index) = entity_indexes.get(parent_id) else {
                return Err(ApplyStudioPersistentRemoveError::TargetMissing(
                    parent_id.to_owned(),
                ));
            };
            children[parent_index].push(entity_index);
        }
    }
    let mut selected_targets = std::collections::BTreeMap::<usize, &str>::new();
    for removal in removals {
        let entity_index = entity_indexes
            .get(removal.entity_id.as_str())
            .copied()
            .ok_or_else(|| {
                ApplyStudioPersistentRemoveError::TargetMissing(removal.entity_id.clone())
            })?;
        if selected_targets
            .insert(entity_index, removal.entity_id.as_str())
            .is_some()
        {
            return Err(ApplyStudioPersistentRemoveError::DuplicateTarget(
                removal.entity_id.clone(),
            ));
        }
    }
    for (&entity_index, &target_id) in &selected_targets {
        let mut parent_id = scene.entities[entity_index].parent_id.as_deref();
        while let Some(id) = parent_id {
            let parent_index = entity_indexes
                .get(id)
                .copied()
                .ok_or_else(|| ApplyStudioPersistentRemoveError::TargetMissing(id.to_owned()))?;
            if let Some(ancestor_target) = selected_targets.get(&parent_index) {
                return Err(ApplyStudioPersistentRemoveError::OverlappingTargets(
                    (*ancestor_target).to_owned(),
                    target_id.to_owned(),
                ));
            }
            parent_id = scene.entities[parent_index].parent_id.as_deref();
        }
    }
    let mut planned = Vec::with_capacity(removals.len());
    for removal in removals {
        if !removal.interval.start.is_finite()
            || !removal.interval.end.is_finite()
            || removal.interval.start < 0.0
            || removal.interval.start > removal.interval.end
            || removal.interval.end > scene.duration
        {
            return Err(ApplyStudioPersistentRemoveError::InvalidInterval);
        }
        let entity_index = entity_indexes
            .get(removal.entity_id.as_str())
            .copied()
            .ok_or_else(|| {
                ApplyStudioPersistentRemoveError::TargetMissing(removal.entity_id.clone())
            })?;
        let mut affected_entity_indexes = Vec::new();
        let mut pending = vec![entity_index];
        while let Some(affected_index) = pending.pop() {
            affected_entity_indexes.push(affected_index);
            pending.extend(children[affected_index].iter().copied());
        }
        affected_entity_indexes.sort_unstable();
        if scene.entities[entity_index].parent_id.is_some() {
            return Err(ApplyStudioPersistentRemoveError::TargetIsNotRoot(
                removal.entity_id.clone(),
            ));
        }
        let root = &scene.entities[entity_index];
        if !root.lifetimes.iter().any(|lifetime| {
            removal.interval.start >= lifetime.start
                && removal.interval.start < lifetime.end
                && removal.interval.end > lifetime.start
                && removal.interval.end <= lifetime.end
        }) {
            return Err(ApplyStudioPersistentRemoveError::TargetInactive(
                root.id.clone(),
            ));
        }
        let affected_entity_ids = affected_entity_indexes
            .iter()
            .map(|&affected_index| scene.entities[affected_index].id.clone())
            .collect();
        let affected_entities = affected_entity_indexes
            .into_iter()
            .map(|affected_index| {
                let retained_lifetimes = scene.entities[affected_index]
                    .lifetimes
                    .iter()
                    .filter_map(|lifetime| {
                        if lifetime.start >= removal.interval.end {
                            return None;
                        }
                        Some(IntervalV1 {
                            end: lifetime.end.min(removal.interval.end),
                            start: lifetime.start,
                        })
                    })
                    .filter(|lifetime| lifetime.start < lifetime.end)
                    .collect();
                (affected_index, retained_lifetimes)
            })
            .collect();
        let opacity_channels = scene
            .animation_channels
            .iter()
            .enumerate()
            .filter_map(|(index, channel)| match channel {
                AnimationChannelV1::Opacity { entity_id, .. }
                    if entity_id == &removal.entity_id =>
                {
                    Some(index)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if opacity_channels.len() > 1 {
            return Err(ApplyStudioPersistentRemoveError::OpacityAnimationConflict(
                removal.entity_id.clone(),
            ));
        }
        let opacity_channel_index = opacity_channels.first().copied();
        if removal.interval.end > removal.interval.start
            && let Some(channel_index) = opacity_channel_index
        {
            let AnimationChannelV1::Opacity { keyframes, .. } =
                &scene.animation_channels[channel_index]
            else {
                unreachable!();
            };
            let compatible = keyframes.last().is_some_and(|last| {
                last.easing_to_next.is_none()
                    && last.at <= removal.interval.start + TIMELINE_ANCHOR_EPSILON
                    && close_transform_baseline_value(last.value, 1.0)
            });
            if !compatible {
                return Err(ApplyStudioPersistentRemoveError::OpacityAnimationConflict(
                    removal.entity_id.clone(),
                ));
            }
        }
        planned.push(PlannedPersistentSceneRemoval {
            affected_entities,
            affected_entity_ids,
            opacity_channel_index,
            removal: removal.clone(),
            root_entity_index: entity_index,
        });
    }
    Ok(planned)
}

fn remove_scene_entities(
    scene: &mut poietra_scene_ir::SceneIrV1,
    removed_entity_ids: &BTreeSet<String>,
) {
    scene.animation_channels.retain(|channel| {
        channel
            .entity_id()
            .is_none_or(|entity_id| !removed_entity_ids.contains(entity_id))
    });
    scene
        .entities
        .retain(|entity| !removed_entity_ids.contains(&entity.id));
}

pub(super) fn apply_persistent_scene_removals(
    scene: &mut poietra_scene_ir::SceneIrV1,
    removals: &[PersistentSceneRemoval],
    provenance_id: &str,
) -> Result<StudioPersistentRemoveProjection, ApplyStudioPersistentRemoveError> {
    let planned = plan_persistent_scene_removals(scene, removals)?;
    let mut removed_entity_ids = BTreeSet::new();
    for removal in &planned {
        for (entity_index, retained_lifetimes) in &removal.affected_entities {
            if retained_lifetimes.is_empty() {
                removed_entity_ids.insert(scene.entities[*entity_index].id.clone());
                continue;
            }
            let affected = &mut scene.entities[*entity_index];
            affected.lifetimes.clone_from(retained_lifetimes);
            provenance_id.clone_into(&mut affected.provenance_id);
        }
    }
    for removal in &planned {
        if removal.removal.interval.start >= removal.removal.interval.end {
            continue;
        }
        if let Some(channel_index) = removal.opacity_channel_index {
            let AnimationChannelV1::Opacity { keyframes, .. } =
                &mut scene.animation_channels[channel_index]
            else {
                unreachable!();
            };
            let last = keyframes
                .last_mut()
                .expect("persistent remove plan has a keyframe");
            if studio_timeline_semantic_values_match(last.at, removal.removal.interval.start) {
                last.at = removal.removal.interval.start;
                last.easing_to_next = Some(EasingV1::Smooth {});
            } else {
                last.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: removal.removal.interval.start,
                    easing_to_next: Some(EasingV1::Smooth {}),
                    value: 1.0,
                });
            }
            keyframes.push(KeyframeV1 {
                at: removal.removal.interval.end,
                easing_to_next: None,
                value: 0.0,
            });
        } else {
            let channel_id = unused_channel_id(
                scene,
                &format!("studio-persistent-remove-{}", removal.root_entity_index),
            );
            let entity_id = scene.entities[removal.root_entity_index].id.clone();
            scene.animation_channels.push(AnimationChannelV1::Opacity {
                entity_id,
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: removal.removal.interval.start,
                        easing_to_next: Some(EasingV1::Smooth {}),
                        value: 1.0,
                    },
                    KeyframeV1 {
                        at: removal.removal.interval.end,
                        easing_to_next: None,
                        value: 0.0,
                    },
                ],
                provenance_id: provenance_id.to_owned(),
            });
        }
    }
    if !removed_entity_ids.is_empty() {
        remove_scene_entities(scene, &removed_entity_ids);
    }
    if planned
        .iter()
        .any(|removal| removal.removal.interval.start < removal.removal.interval.end)
    {
        let mut capabilities = scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        scene.required_capabilities = capabilities.into_iter().collect();
    }
    Ok(StudioPersistentRemoveProjection {
        removals: planned
            .into_iter()
            .map(|planned| StudioPersistentRemoveProjectionEntry {
                affected_scene_entity_ids: planned.affected_entity_ids,
                fade_interval: (planned.removal.interval.start < planned.removal.interval.end)
                    .then_some(planned.removal.interval.clone()),
                operation_id: planned.removal.operation_id,
                removed_at: planned.removal.interval.end,
                resulting_lifetime_end: planned.removal.interval.end,
                scene_entity_id: planned.removal.entity_id,
                studio_entity_id: planned.removal.studio_entity_id,
                transaction_id: planned.removal.transaction_id,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use poietra_scene_ir::{AnimationChannelV1, SceneIrBundleV1};

    use crate::EngineSessionV1;

    use super::super::tests::{fixture_bundle, static_imported_bundle};
    use super::*;

    #[test]
    fn zero_duration_persistent_remove_drops_every_future_lifetime() {
        let mut scene = static_imported_bundle().scene;
        let target = scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        target.lifetimes = vec![
            IntervalV1 {
                start: 0.0,
                end: 0.5,
            },
            IntervalV1 {
                start: 1.0,
                end: 1.5,
            },
            IntervalV1 {
                start: 1.75,
                end: 2.0,
            },
        ];

        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[PersistentSceneRemoval {
                entity_id: "later".to_owned(),
                interval: IntervalV1 {
                    start: 1.2,
                    end: 1.2,
                },
                operation_id: "remove-later".to_owned(),
                studio_entity_id: "source:circle".to_owned(),
                transaction_id: "remove-later".to_owned(),
            }],
            "remove-provenance",
        )
        .unwrap();

        let target = scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(
            target.lifetimes,
            vec![
                IntervalV1 {
                    start: 0.0,
                    end: 0.5,
                },
                IntervalV1 {
                    start: 1.0,
                    end: 1.2,
                },
            ]
        );
        assert!(scene.animation_channels.is_empty());
        assert_eq!(projection.removals[0].fade_interval, None);
        assert!((projection.removals[0].removed_at - 1.2).abs() < 1e-9);
    }

    #[test]
    fn persistent_remove_owns_a_complete_subtree_and_rejects_overlapping_targets_atomically() {
        let bundle = fixture_bundle("real-line-joints-v10.json");
        let root_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        let child_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.as_deref() == Some(root_id.as_str()))
            .unwrap()
            .id
            .clone();
        let removal = |entity_id: &str, operation_id: &str| PersistentSceneRemoval {
            entity_id: entity_id.to_owned(),
            interval: IntervalV1 {
                start: 0.5,
                end: 0.75,
            },
            operation_id: operation_id.to_owned(),
            studio_entity_id: entity_id.to_owned(),
            transaction_id: "remove-subtree".to_owned(),
        };
        let mut rejected = bundle.scene.clone();
        let expected = rejected.clone();

        let error = apply_persistent_scene_removals(
            &mut rejected,
            &[
                removal(&child_id, "remove-child"),
                removal(&root_id, "remove-root"),
            ],
            "remove-provenance",
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ApplyStudioPersistentRemoveError::OverlappingTargets(_, _)
        ));
        assert_eq!(rejected, expected);

        let mut rejected_child = expected.clone();
        let error = apply_persistent_scene_removals(
            &mut rejected_child,
            &[removal(&child_id, "remove-child")],
            "remove-provenance",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ApplyStudioPersistentRemoveError::TargetIsNotRoot(id) if id == child_id
        ));
        assert_eq!(rejected_child, expected);

        let mut scene = bundle.scene;
        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[removal(&root_id, "remove-root")],
            "remove-provenance",
        )
        .unwrap();
        assert_eq!(projection.removals[0].affected_scene_entity_ids.len(), 4);
        assert!(
            scene
                .entities
                .iter()
                .all(|entity| (entity.lifetimes.last().unwrap().end - 0.75).abs() < 1e-9)
        );
        assert_eq!(
            scene
                .animation_channels
                .iter()
                .filter(|channel| matches!(channel, AnimationChannelV1::Opacity { .. }))
                .count(),
            1
        );
        assert!(scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::Opacity { entity_id, .. } if entity_id == &root_id
            )
        }));
    }

    #[test]
    fn persistent_remove_preserves_past_child_history_and_drops_future_only_children() {
        let mut bundle = fixture_bundle("real-line-joints-v10.json");
        let root_id = bundle.scene.entities[0].id.clone();
        let past_child_id = bundle.scene.entities[1].id.clone();
        let short_child_id = bundle.scene.entities[2].id.clone();
        let future_child_id = bundle.scene.entities[3].id.clone();
        bundle.scene.entities[1].lifetimes = vec![IntervalV1 {
            end: 0.25,
            start: 0.0,
        }];
        bundle.scene.entities[2].lifetimes = vec![IntervalV1 {
            end: 0.6,
            start: 0.0,
        }];
        bundle.scene.entities[3].lifetimes = vec![IntervalV1 {
            end: 1.0,
            start: 0.8,
        }];
        let provenance_id = bundle.scene.provenance[0].id.clone();
        let mut scene = bundle.scene;

        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[PersistentSceneRemoval {
                entity_id: root_id.clone(),
                interval: IntervalV1 {
                    end: 0.75,
                    start: 0.5,
                },
                operation_id: "remove-root".to_owned(),
                studio_entity_id: "source:root".to_owned(),
                transaction_id: "remove-subtree".to_owned(),
            }],
            &provenance_id,
        )
        .unwrap();

        assert_eq!(
            projection.removals[0].affected_scene_entity_ids,
            vec![
                root_id.clone(),
                past_child_id.clone(),
                short_child_id.clone(),
                future_child_id.clone(),
            ]
        );
        assert_eq!(
            scene
                .entities
                .iter()
                .find(|entity| entity.id == past_child_id)
                .unwrap()
                .lifetimes,
            vec![IntervalV1 {
                end: 0.25,
                start: 0.0,
            }]
        );
        assert_eq!(
            scene
                .entities
                .iter()
                .find(|entity| entity.id == short_child_id)
                .unwrap()
                .lifetimes,
            vec![IntervalV1 {
                end: 0.6,
                start: 0.0,
            }]
        );
        assert!(
            scene
                .entities
                .iter()
                .all(|entity| entity.id != future_child_id)
        );
        EngineSessionV1::new(SceneIrBundleV1 {
            assets: bundle.assets,
            scene,
        })
        .unwrap();
    }
}
