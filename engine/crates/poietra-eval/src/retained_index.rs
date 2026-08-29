use std::cmp::Ordering;
use std::collections::HashMap;
use std::mem::size_of;

use poietra_scene_ir::{AnimationChannelV1, MAX_FRAGMENT_MATERIAL_PARAMETERS_V1, SceneIrV1};

/// Hard ceiling for snapshot-derived evaluator indices retained beside one Scene.
///
/// The accounting includes owned identifier bytes, conservatively rounded hash
/// buckets, and every vector allocation in the index. Allocator bookkeeping and
/// the already-owned Scene are deliberately outside this index-only ceiling.
pub const MAX_RETAINED_SCENE_INDEX_BYTES_V1: usize = 8 * 1024 * 1024;

const HASH_CONTROL_GROUP_BYTES: usize = 16;
const HASH_CONTROL_BYTES_PER_BUCKET: usize = 1;

/// A validated Scene could not be indexed within the retained-session policy.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RetainedSceneIndexErrorV1 {
    #[error("retained Scene index byte accounting overflowed")]
    ByteAccountingOverflow,
    #[error(
        "retained Scene index requires {required_bytes} accounted bytes; maximum is {maximum_bytes}"
    )]
    ByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error("retained Scene index allocation failed")]
    AllocationFailed,
    #[error("validated Scene index is internally inconsistent: {0}")]
    Inconsistent(&'static str),
}

/// Bounded install-time evidence for one retained evaluator index.
///
/// Sampling reads this evidence but never mutates it. `build_count` advances
/// only when a complete replacement snapshot and all of its indices commit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetainedSceneIndexStatsV1 {
    pub(crate) accounted_bytes: usize,
    pub(crate) build_count: u64,
    pub(crate) channel_entries: usize,
    pub(crate) entity_entries: usize,
    pub(crate) hierarchy_entries: usize,
    pub(crate) paint_order_entries: usize,
}

impl RetainedSceneIndexStatsV1 {
    #[must_use]
    pub const fn accounted_bytes(self) -> usize {
        self.accounted_bytes
    }

    #[must_use]
    pub const fn build_count(self) -> u64 {
        self.build_count
    }

    #[must_use]
    pub const fn channel_entries(self) -> usize {
        self.channel_entries
    }

    #[must_use]
    pub const fn entity_entries(self) -> usize {
        self.entity_entries
    }

    #[must_use]
    pub const fn hierarchy_entries(self) -> usize {
        self.hierarchy_entries
    }

    #[must_use]
    pub const fn paint_order_entries(self) -> usize {
        self.paint_order_entries
    }
}

#[derive(Debug)]
struct ChannelPositionsV1 {
    affine: Vec<Option<usize>>,
    camera: Option<usize>,
    fragment_material_parameters: Vec<[Option<usize>; MAX_FRAGMENT_MATERIAL_PARAMETERS_V1]>,
    motion: Vec<Option<usize>>,
    opacity: Vec<Option<usize>>,
    path_morph: Vec<Option<usize>>,
    path_trim: Vec<Option<usize>>,
    scene_post_effect_parameters: Vec<ScenePostEffectParameterChannelPositionV1>,
    vector_appearance: Vec<Option<usize>>,
}

#[derive(Clone, Copy, Debug)]
struct ScenePostEffectParameterChannelPositionV1 {
    channel: usize,
    effect: usize,
    parameter: usize,
}

impl ChannelPositionsV1 {
    fn empty(entity_count: usize) -> Self {
        Self {
            affine: vec![None; entity_count],
            camera: None,
            fragment_material_parameters: vec![
                [None; MAX_FRAGMENT_MATERIAL_PARAMETERS_V1];
                entity_count
            ],
            motion: vec![None; entity_count],
            opacity: vec![None; entity_count],
            path_morph: vec![None; entity_count],
            path_trim: vec![None; entity_count],
            scene_post_effect_parameters: Vec::new(),
            vector_appearance: vec![None; entity_count],
        }
    }

    fn accounted_bytes(&self) -> Result<usize, RetainedSceneIndexErrorV1> {
        let mut bytes = 0usize;
        for capacity in [
            self.affine.capacity(),
            self.motion.capacity(),
            self.opacity.capacity(),
            self.path_morph.capacity(),
            self.path_trim.capacity(),
            self.vector_appearance.capacity(),
        ] {
            bytes = checked_add(bytes, checked_mul(capacity, size_of::<Option<usize>>())?)?;
        }
        bytes = checked_add(
            bytes,
            checked_mul(
                self.fragment_material_parameters.capacity(),
                size_of::<[Option<usize>; MAX_FRAGMENT_MATERIAL_PARAMETERS_V1]>(),
            )?,
        )?;
        checked_add(
            bytes,
            checked_mul(
                self.scene_post_effect_parameters.capacity(),
                size_of::<ScenePostEffectParameterChannelPositionV1>(),
            )?,
        )
    }

    fn entries(&self) -> usize {
        self.affine.iter().flatten().count()
            + self
                .fragment_material_parameters
                .iter()
                .flat_map(|slots| slots.iter())
                .flatten()
                .count()
            + self.motion.iter().flatten().count()
            + self.opacity.iter().flatten().count()
            + self.path_morph.iter().flatten().count()
            + self.path_trim.iter().flatten().count()
            + self.scene_post_effect_parameters.len()
            + self.vector_appearance.iter().flatten().count()
            + usize::from(self.camera.is_some())
    }
}

/// Immutable, snapshot-derived lookup data shared by every playhead sample.
#[derive(Debug)]
pub(crate) struct RetainedSceneIndexV1 {
    accounted_bytes: usize,
    channels: ChannelPositionsV1,
    entity_by_id: HashMap<String, usize>,
    hierarchy_order: Vec<usize>,
    parent_by_entity: Vec<Option<usize>>,
    stable_paint_order: Vec<usize>,
}

impl RetainedSceneIndexV1 {
    pub(crate) fn build(scene: &SceneIrV1) -> Result<Self, RetainedSceneIndexErrorV1> {
        Self::build_with_limit(scene, MAX_RETAINED_SCENE_INDEX_BYTES_V1)
    }

    pub(crate) fn build_with_limit(
        scene: &SceneIrV1,
        maximum_bytes: usize,
    ) -> Result<Self, RetainedSceneIndexErrorV1> {
        let preflight_bytes = preflight_accounted_bytes(scene)?;
        enforce_limit(preflight_bytes, maximum_bytes)?;
        let entity_by_id = build_entity_lookup(scene)?;
        let parent_by_entity = build_parent_indices(scene, &entity_by_id)?;
        let hierarchy_order = hierarchy_order(&parent_by_entity)?;
        let stable_paint_order = build_stable_paint_order(scene)?;
        let channels = build_channel_positions(scene, &entity_by_id)?;
        let mut output = Self {
            accounted_bytes: 0,
            channels,
            entity_by_id,
            hierarchy_order,
            parent_by_entity,
            stable_paint_order,
        };
        output.accounted_bytes = output.calculate_accounted_bytes()?;
        enforce_limit(output.accounted_bytes, maximum_bytes)?;
        Ok(output)
    }

    pub(crate) const fn accounted_bytes(&self) -> usize {
        self.accounted_bytes
    }

    pub(crate) fn affine_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels.affine.get(entity_index).copied().flatten()
    }

    pub(crate) const fn camera_channel(&self) -> Option<usize> {
        self.channels.camera
    }

    pub(crate) fn channel_entries(&self) -> usize {
        self.channels.entries()
    }

    pub(crate) fn entity_entries(&self) -> usize {
        self.entity_by_id.len()
    }

    pub(crate) fn hierarchy_order(&self) -> &[usize] {
        &self.hierarchy_order
    }

    pub(crate) fn fragment_material_parameter_channels(
        &self,
        entity_index: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        self.channels
            .fragment_material_parameters
            .get(entity_index)
            .into_iter()
            .flat_map(|slots| slots.iter())
            .copied()
            .flatten()
    }

    pub(crate) fn motion_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels.motion.get(entity_index).copied().flatten()
    }

    pub(crate) fn opacity_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels.opacity.get(entity_index).copied().flatten()
    }

    pub(crate) fn parent(&self, entity_index: usize) -> Option<usize> {
        self.parent_by_entity.get(entity_index).copied().flatten()
    }

    pub(crate) fn path_morph_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels
            .path_morph
            .get(entity_index)
            .copied()
            .flatten()
    }

    pub(crate) fn path_trim_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels.path_trim.get(entity_index).copied().flatten()
    }

    pub(crate) fn scene_post_effect_parameter_channel(
        &self,
        effect_index: usize,
        parameter_index: usize,
    ) -> Option<usize> {
        self.channels
            .scene_post_effect_parameters
            .iter()
            .find(|position| {
                position.effect == effect_index && position.parameter == parameter_index
            })
            .map(|position| position.channel)
    }

    pub(crate) fn vector_appearance_channel(&self, entity_index: usize) -> Option<usize> {
        self.channels
            .vector_appearance
            .get(entity_index)
            .copied()
            .flatten()
    }

    pub(crate) fn stable_paint_order(&self) -> &[usize] {
        &self.stable_paint_order
    }

    fn calculate_accounted_bytes(&self) -> Result<usize, RetainedSceneIndexErrorV1> {
        let mut bytes = size_of::<Self>();
        bytes = checked_add(bytes, hash_map_accounted_bytes(&self.entity_by_id)?)?;
        bytes = checked_add(bytes, self.channels.accounted_bytes()?)?;
        bytes = checked_add(bytes, vector_bytes(&self.hierarchy_order)?)?;
        bytes = checked_add(bytes, vector_bytes(&self.parent_by_entity)?)?;
        checked_add(bytes, vector_bytes(&self.stable_paint_order)?)
    }
}

fn build_entity_lookup(
    scene: &SceneIrV1,
) -> Result<HashMap<String, usize>, RetainedSceneIndexErrorV1> {
    let mut entity_by_id = HashMap::new();
    entity_by_id
        .try_reserve(scene.entities.len())
        .map_err(|_| RetainedSceneIndexErrorV1::AllocationFailed)?;
    for (entity_index, entity) in scene.entities.iter().enumerate() {
        if entity_by_id
            .insert(entity.id.clone(), entity_index)
            .is_some()
        {
            return Err(RetainedSceneIndexErrorV1::Inconsistent(
                "duplicate entity ID reached index construction",
            ));
        }
    }
    Ok(entity_by_id)
}

fn build_parent_indices(
    scene: &SceneIrV1,
    entity_by_id: &HashMap<String, usize>,
) -> Result<Vec<Option<usize>>, RetainedSceneIndexErrorV1> {
    let mut parents = Vec::new();
    parents
        .try_reserve_exact(scene.entities.len())
        .map_err(|_| RetainedSceneIndexErrorV1::AllocationFailed)?;
    for entity in &scene.entities {
        let parent = entity
            .parent_id
            .as_ref()
            .map(|parent_id| {
                entity_by_id
                    .get(parent_id)
                    .copied()
                    .ok_or(RetainedSceneIndexErrorV1::Inconsistent(
                        "unknown parent reached index construction",
                    ))
            })
            .transpose()?;
        parents.push(parent);
    }
    Ok(parents)
}

fn build_stable_paint_order(scene: &SceneIrV1) -> Result<Vec<usize>, RetainedSceneIndexErrorV1> {
    let mut order = Vec::new();
    order
        .try_reserve_exact(scene.entities.len())
        .map_err(|_| RetainedSceneIndexErrorV1::AllocationFailed)?;
    order.extend(0..scene.entities.len());
    // Match the evaluator's historical comparator exactly. In particular,
    // `-0.0` and `+0.0` compare equal and fall through to scene order.
    order.sort_by(|left, right| {
        let left = &scene.entities[*left];
        let right = &scene.entities[*right];
        left.source_z_index
            .partial_cmp(&right.source_z_index)
            .unwrap_or(Ordering::Equal)
            .then(left.scene_order.cmp(&right.scene_order))
    });
    Ok(order)
}

fn build_channel_positions(
    scene: &SceneIrV1,
    entity_by_id: &HashMap<String, usize>,
) -> Result<ChannelPositionsV1, RetainedSceneIndexErrorV1> {
    let mut channels = ChannelPositionsV1::empty(scene.entities.len());
    let scene_post_effect_parameter_count = scene
        .animation_channels
        .iter()
        .filter(|channel| matches!(channel, AnimationChannelV1::ScenePostEffectParameter { .. }))
        .count();
    channels
        .scene_post_effect_parameters
        .try_reserve_exact(scene_post_effect_parameter_count)
        .map_err(|_| RetainedSceneIndexErrorV1::AllocationFailed)?;
    for (channel_index, channel) in scene.animation_channels.iter().enumerate() {
        let entity_index = channel
            .entity_id()
            .map(|entity_id| {
                entity_by_id
                    .get(entity_id)
                    .copied()
                    .ok_or(RetainedSceneIndexErrorV1::Inconsistent(
                        "unknown animation target reached index construction",
                    ))
            })
            .transpose()?;
        install_channel_position(&mut channels, scene, channel, channel_index, entity_index)?;
    }
    Ok(channels)
}

fn install_channel_position(
    channels: &mut ChannelPositionsV1,
    scene: &SceneIrV1,
    channel: &AnimationChannelV1,
    channel_index: usize,
    entity_index: Option<usize>,
) -> Result<(), RetainedSceneIndexErrorV1> {
    let entity_index = || {
        entity_index.ok_or(RetainedSceneIndexErrorV1::Inconsistent(
            "entity animation channel has no target",
        ))
    };
    let slot = match channel {
        AnimationChannelV1::AffineTransform { .. } | AnimationChannelV1::Rotation { .. } => {
            &mut channels.affine[entity_index()?]
        }
        AnimationChannelV1::MotionPath { .. } => &mut channels.motion[entity_index()?],
        AnimationChannelV1::Opacity { .. } => &mut channels.opacity[entity_index()?],
        AnimationChannelV1::PathMorph { .. } => &mut channels.path_morph[entity_index()?],
        AnimationChannelV1::PathTrim { .. } => &mut channels.path_trim[entity_index()?],
        AnimationChannelV1::VectorAppearance { .. } => {
            &mut channels.vector_appearance[entity_index()?]
        }
        AnimationChannelV1::FragmentMaterialParameter {
            parameter_index, ..
        } => {
            let parameter_index = usize::try_from(*parameter_index).map_err(|_| {
                RetainedSceneIndexErrorV1::Inconsistent(
                    "invalid fragment-material parameter index reached index construction",
                )
            })?;
            if parameter_index >= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "unknown fragment-material parameter reached index construction",
                ));
            }
            &mut channels.fragment_material_parameters[entity_index()?][parameter_index]
        }
        AnimationChannelV1::Camera { .. } => {
            if channels.camera.replace(channel_index).is_some() {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "duplicate camera channel reached index construction",
                ));
            }
            return Ok(());
        }
        AnimationChannelV1::ScenePostEffectParameter {
            parameter_index,
            revision,
            shader_id,
            ..
        } => {
            let effect_index = scene
                .post_effects
                .iter()
                .position(|effect| effect.shader_id == *shader_id && effect.revision == *revision)
                .ok_or(RetainedSceneIndexErrorV1::Inconsistent(
                    "unknown Scene post-effect animation target reached index construction",
                ))?;
            let parameter_index = usize::try_from(*parameter_index).map_err(|_| {
                RetainedSceneIndexErrorV1::Inconsistent(
                    "invalid Scene post-effect parameter index reached index construction",
                )
            })?;
            if parameter_index >= scene.post_effects[effect_index].parameters.len() {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "unknown Scene post-effect parameter reached index construction",
                ));
            }
            if channels
                .scene_post_effect_parameters
                .iter()
                .any(|position| {
                    position.effect == effect_index && position.parameter == parameter_index
                })
            {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "duplicate Scene post-effect parameter target reached index construction",
                ));
            }
            channels
                .scene_post_effect_parameters
                .push(ScenePostEffectParameterChannelPositionV1 {
                    channel: channel_index,
                    effect: effect_index,
                    parameter: parameter_index,
                });
            return Ok(());
        }
    };
    if slot.replace(channel_index).is_some() {
        return Err(RetainedSceneIndexErrorV1::Inconsistent(
            "duplicate animation target reached index construction",
        ));
    }
    Ok(())
}

fn hierarchy_order(
    parent_by_entity: &[Option<usize>],
) -> Result<Vec<usize>, RetainedSceneIndexErrorV1> {
    let entity_count = parent_by_entity.len();
    let mut depths: Vec<Option<usize>> = vec![None; entity_count];
    let mut states = vec![0u8; entity_count];
    for start in 0..entity_count {
        if states[start] == 2 {
            continue;
        }
        let mut chain = Vec::new();
        let mut current = Some(start);
        while let Some(entity_index) = current {
            if entity_index >= entity_count {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "parent index is outside the entity table",
                ));
            }
            if depths[entity_index].is_some() {
                break;
            }
            if states[entity_index] == 1 {
                return Err(RetainedSceneIndexErrorV1::Inconsistent(
                    "hierarchy cycle reached index construction",
                ));
            }
            states[entity_index] = 1;
            chain.push(entity_index);
            current = parent_by_entity[entity_index];
        }
        let mut depth =
            current
                .and_then(|index| depths[index])
                .map_or(Ok(0usize), |parent_depth| {
                    parent_depth
                        .checked_add(1)
                        .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)
                })?;
        while let Some(entity_index) = chain.pop() {
            depths[entity_index] = Some(depth);
            states[entity_index] = 2;
            depth = depth
                .checked_add(1)
                .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)?;
        }
    }

    let mut order = Vec::new();
    order
        .try_reserve_exact(entity_count)
        .map_err(|_| RetainedSceneIndexErrorV1::AllocationFailed)?;
    order.extend(0..entity_count);
    order.sort_by_key(|entity_index| depths[*entity_index]);
    Ok(order)
}

fn preflight_accounted_bytes(scene: &SceneIrV1) -> Result<usize, RetainedSceneIndexErrorV1> {
    let entity_count = scene.entities.len();
    let mut bytes = size_of::<RetainedSceneIndexV1>();
    bytes = checked_add(
        bytes,
        hash_table_bytes(hash_bucket_slots_for_length(entity_count)?)?,
    )?;
    for entity in &scene.entities {
        bytes = checked_add(bytes, entity.id.len())?;
    }

    let option_vector = checked_mul(entity_count, size_of::<Option<usize>>())?;
    // Six single-channel entity vectors and one parent vector.
    bytes = checked_add(bytes, checked_mul(option_vector, 7)?)?;
    bytes = checked_add(
        bytes,
        checked_mul(
            entity_count,
            size_of::<[Option<usize>; MAX_FRAGMENT_MATERIAL_PARAMETERS_V1]>(),
        )?,
    )?;
    let scene_post_effect_parameter_channels = scene
        .animation_channels
        .iter()
        .filter(|channel| matches!(channel, AnimationChannelV1::ScenePostEffectParameter { .. }))
        .count();
    bytes = checked_add(
        bytes,
        checked_mul(
            scene_post_effect_parameter_channels,
            size_of::<ScenePostEffectParameterChannelPositionV1>(),
        )?,
    )?;
    let index_vector = checked_mul(entity_count, size_of::<usize>())?;
    // Hierarchy order and stable paint order.
    checked_add(bytes, checked_mul(index_vector, 2)?)
}

fn hash_map_accounted_bytes(
    map: &HashMap<String, usize>,
) -> Result<usize, RetainedSceneIndexErrorV1> {
    let mut bytes = hash_table_bytes(hash_bucket_slots_for_capacity(map.capacity())?)?;
    for key in map.keys() {
        bytes = checked_add(bytes, key.capacity())?;
    }
    Ok(bytes)
}

fn hash_bucket_slots_for_length(length: usize) -> Result<usize, RetainedSceneIndexErrorV1> {
    if length == 0 {
        return Ok(0);
    }
    let minimum_slots = checked_add(checked_mul(length, 8)?, 6)? / 7;
    minimum_slots
        .checked_next_power_of_two()
        .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)
}

fn hash_bucket_slots_for_capacity(capacity: usize) -> Result<usize, RetainedSceneIndexErrorV1> {
    if capacity == 0 {
        return Ok(0);
    }
    capacity
        .checked_next_power_of_two()
        .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)
}

fn hash_table_bytes(bucket_slots: usize) -> Result<usize, RetainedSceneIndexErrorV1> {
    if bucket_slots == 0 {
        return Ok(0);
    }
    let entries = checked_mul(bucket_slots, size_of::<(String, usize)>())?;
    let controls = checked_add(
        checked_mul(bucket_slots, HASH_CONTROL_BYTES_PER_BUCKET)?,
        HASH_CONTROL_GROUP_BYTES,
    )?;
    checked_add(entries, controls)
}

fn vector_bytes<T>(values: &Vec<T>) -> Result<usize, RetainedSceneIndexErrorV1> {
    checked_mul(values.capacity(), size_of::<T>())
}

fn checked_add(left: usize, right: usize) -> Result<usize, RetainedSceneIndexErrorV1> {
    left.checked_add(right)
        .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)
}

fn checked_mul(left: usize, right: usize) -> Result<usize, RetainedSceneIndexErrorV1> {
    left.checked_mul(right)
        .ok_or(RetainedSceneIndexErrorV1::ByteAccountingOverflow)
}

fn enforce_limit(
    required_bytes: usize,
    maximum_bytes: usize,
) -> Result<(), RetainedSceneIndexErrorV1> {
    if required_bytes > maximum_bytes {
        return Err(RetainedSceneIndexErrorV1::ByteLimitExceeded {
            maximum_bytes,
            required_bytes,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use poietra_scene_ir::SceneIrBundleV1;
    use serde_json::Value;

    use super::*;

    fn fixture_scene() -> SceneIrV1 {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/shared-circle-opacity.json");
        let fixture: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        serde_json::from_value::<SceneIrBundleV1>(serde_json::json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap()
        .scene
    }

    #[test]
    fn accounted_bytes_are_hard_bounded_with_checked_post_allocation_evidence() {
        let scene = fixture_scene();
        let index = RetainedSceneIndexV1::build(&scene).unwrap();
        let required_bytes = index.accounted_bytes();
        assert!(required_bytes <= MAX_RETAINED_SCENE_INDEX_BYTES_V1);

        assert!(matches!(
            RetainedSceneIndexV1::build_with_limit(&scene, required_bytes - 1),
            Err(RetainedSceneIndexErrorV1::ByteLimitExceeded {
                maximum_bytes,
                required_bytes: actual,
            }) if maximum_bytes == required_bytes - 1 && actual == required_bytes
        ));
    }
}
