use poietra_scene_ir::{IntervalV1, PointV1, SceneEntityV1};
use serde::Deserialize;

use super::{
    StaticRootTransformDimensions, StaticRootTransformEntityKind, StudioAuthoringEntityKind,
};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionEntityIdentity {
    pub object_graph_key: String,
    pub provisional: bool,
    pub source_identity: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionProjectionEntityIdentity {
    #[serde(flatten)]
    pub identity: StudioMotionEntityIdentity,
    pub lifetime: Vec<IntervalV1>,
    pub position: PointV1,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionSourceBinding {
    pub runtime_entity_id: String,
    pub source_identity_key: String,
    pub source_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexTransformEntityIdentity {
    pub object_graph_key: String,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: StudioAuthoringEntityKind,
}

/// Logical Studio entity facts used to authorize a `MathTex` transform without a Scene snapshot.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexTransformProjectionEntityIdentity {
    pub lifetime: Vec<IntervalV1>,
    pub object_graph_key: String,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: StudioAuthoringEntityKind,
}

pub type StudioMathTexTransformSourceBinding = StudioMotionSourceBinding;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootTransformStudioEntity {
    pub dimensions: StaticRootTransformDimensions,
    pub object_graph_key: String,
    pub id: String,
    pub kind: StaticRootTransformEntityKind,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    pub transaction_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootMotionProjectionEntityIdentity {
    #[serde(flatten)]
    pub identity: StaticRootTransformStudioEntity,
    pub lifetime: Vec<IntervalV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootTransformSourceBinding {
    pub source_identity_key: String,
    pub runtime_entity_id: String,
    pub source_name: String,
}

pub(super) fn studio_math_tex_transform_identity_is_closed(
    provisional: bool,
    entity_type: StudioAuthoringEntityKind,
    scale: Option<f64>,
    source_identity: Option<&str>,
) -> bool {
    !provisional
        && entity_type == StudioAuthoringEntityKind::MathTex
        && scale == Some(1.0)
        && source_identity.is_some_and(|identity| !identity.is_empty())
}

pub(super) fn resolve_studio_motion_targets(
    target_entity_ids: &[String],
    studio_entities: &[StudioMotionEntityIdentity],
    source_runtime_bindings: &[StudioMotionSourceBinding],
) -> Option<Vec<String>> {
    let mut runtime_entity_ids = Vec::with_capacity(target_entity_ids.len());
    for studio_entity_id in target_entity_ids {
        let mut matching_entities = studio_entities
            .iter()
            .filter(|entity| entity.object_graph_key == *studio_entity_id);
        let entity = matching_entities
            .next()
            .filter(|entity| !entity.provisional && entity.source_identity.is_some())?;
        if matching_entities.next().is_some() {
            return None;
        }
        let source_identity = entity.source_identity.as_deref()?;
        let mut matching_bindings = source_runtime_bindings
            .iter()
            .filter(|binding| binding.source_identity_key == source_identity);
        let binding = matching_bindings
            .next()
            .filter(|binding| binding.source_name == source_identity)?;
        if matching_bindings.next().is_some() {
            return None;
        }
        runtime_entity_ids.push(binding.runtime_entity_id.clone());
    }
    Some(runtime_entity_ids)
}

#[allow(
    clippy::float_cmp,
    reason = "exact one is the normalized known-scale authority fact"
)]
pub(super) fn resolve_imported_math_tex_transform_source(
    studio_entity_id: &str,
    studio_entities: &[StudioMathTexTransformEntityIdentity],
    source_runtime_bindings: &[StudioMathTexTransformSourceBinding],
) -> Option<(String, Option<PointV1>)> {
    let mut matching_entities = studio_entities
        .iter()
        .filter(|entity| entity.object_graph_key == studio_entity_id);
    let entity = matching_entities.next().filter(|entity| {
        studio_math_tex_transform_identity_is_closed(
            entity.provisional,
            entity.entity_type,
            entity.scale,
            entity.source_identity.as_deref(),
        )
    })?;
    if matching_entities.next().is_some() {
        return None;
    }
    let source_identity = entity.source_identity.as_deref()?;
    let mut matching_bindings = source_runtime_bindings
        .iter()
        .filter(|binding| binding.source_identity_key == source_identity);
    let binding = matching_bindings
        .next()
        .filter(|binding| binding.source_name == source_identity)?;
    if matching_bindings.next().is_some()
        || source_runtime_bindings
            .iter()
            .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
            .count()
            != 1
    {
        return None;
    }
    Some((binding.runtime_entity_id.clone(), entity.position.clone()))
}

pub(super) fn resolve_static_root_binding<'a>(
    scene: &'a poietra_scene_ir::SceneIrV1,
    studio_entities: &'a [StaticRootTransformStudioEntity],
    source_runtime_bindings: &'a [StaticRootTransformSourceBinding],
    studio_entity_id: &str,
) -> Option<(&'a StaticRootTransformStudioEntity, &'a SceneEntityV1)> {
    let mut matching_studio_entities = studio_entities.iter().filter(|entity| {
        entity.object_graph_key == studio_entity_id && entity.id == studio_entity_id
    });
    let studio_entity = matching_studio_entities.next().filter(|entity| {
        !entity.provisional && entity.transaction_id.is_none() && entity.source_identity.is_some()
    })?;
    if matching_studio_entities.next().is_some() {
        return None;
    }
    let source_identity = studio_entity.source_identity.as_deref()?;
    let mut matching_bindings = source_runtime_bindings
        .iter()
        .filter(|binding| binding.source_identity_key == source_identity);
    let binding = matching_bindings
        .next()
        .filter(|binding| binding.source_name == source_identity)?;
    if matching_bindings.next().is_some()
        || source_runtime_bindings
            .iter()
            .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
            .count()
            != 1
    {
        return None;
    }
    let runtime_entity = scene
        .entities
        .iter()
        .find(|entity| entity.id == binding.runtime_entity_id)?;
    Some((studio_entity, runtime_entity))
}
