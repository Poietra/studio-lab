use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1,
    SceneAppearanceV1, SceneGeometryV1, SceneIrBundleV1, SceneSourceV1,
};

use crate::{EngineSessionV1, EvaluationError};

const ROTATION_NOOP_EPSILON: f64 = 1e-12;

/// One profile-free Studio command that rotates a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct RotateSceneEntityCommand {
    pub angle_radians: f64,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub pivot: PointV1,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio command that translates a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct MoveSceneEntityCommand {
    pub delta: PointV1,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio command that uniformly scales a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct UniformScaleSceneEntityCommand {
    pub entity_id: String,
    pub expected_base_revision: String,
    pub factor: f64,
    pub next_revision: String,
    pub pivot: PointV1,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio command that sets vector-paint alpha in one root subtree.
#[derive(Clone, Debug, PartialEq)]
pub struct SetSubtreeVectorPaintAlphaCommand {
    pub alpha: f64,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
    pub root_entity_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RotateSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the rotation must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the rotation angle must be finite and non-zero")]
    InvalidAngle,
    #[error("the world-space rotation pivot must be finite")]
    InvalidPivot,
    #[error("the rotation target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space rotation currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("world-space rotation does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the rotation provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the rotation provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the rotated Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum MoveSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the move must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the world-space move delta must be finite and non-zero")]
    InvalidDelta,
    #[error("the move target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space move currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("world-space move does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the move provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the move provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the moved Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum UniformScaleSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the uniform scale must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the uniform scale factor must be finite, positive, and non-identity")]
    InvalidFactor,
    #[error("the world-space uniform scale pivot must be finite")]
    InvalidPivot,
    #[error("the uniform scale target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space uniform scale currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("world-space uniform scale does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the uniform scale provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the uniform scale provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the uniformly scaled Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum SetSubtreeVectorPaintAlphaError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the vector-paint alpha edit must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the vector-paint alpha must be finite and between zero and one")]
    InvalidAlpha,
    #[error("the vector-paint alpha root does not exist: {0}")]
    TargetMissing(String),
    #[error("the vector-paint alpha target must be a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the vector-paint alpha subtree contains an unsupported entity: {0}")]
    UnsupportedSubtreeEntity(String),
    #[error("the vector-paint alpha subtree contains animated paint: {0}")]
    AnimatedPaintUnsupported(String),
    #[error("the vector-paint alpha provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the vector-paint alpha provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the vector-paint alpha edit did not change any paint")]
    NoPaintChanged,
    #[error("the vector-paint alpha Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

fn rotation_is_noop(angle_radians: f64) -> bool {
    let normalized = angle_radians.sin().atan2(angle_radians.cos());
    normalized.abs() <= ROTATION_NOOP_EPSILON
}

impl EngineSessionV1 {
    /// Atomically rotates one root entity about a world-space pivot.
    ///
    /// The command is deliberately independent of source profiles, viewport coordinates, and
    /// Manim bindings. Integration code must authorize and lower those concerns before calling
    /// this method.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    pub fn rotate_scene_entity(
        &mut self,
        command: RotateSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, RotateSceneEntityError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(RotateSceneEntityError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(RotateSceneEntityError::RevisionDidNotAdvance);
        }
        if !command.angle_radians.is_finite() || rotation_is_noop(command.angle_radians) {
            return Err(RotateSceneEntityError::InvalidAngle);
        }
        if !command.pivot.x.is_finite() || !command.pivot.y.is_finite() {
            return Err(RotateSceneEntityError::InvalidPivot);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(RotateSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(RotateSceneEntityError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if candidate.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, .. }
                    | AnimationChannelV1::MotionPath { entity_id, .. }
                    if entity_id == &command.entity_id
            )
        }) {
            return Err(RotateSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| RotateSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(RotateSceneEntityError::TargetIsNotRoot(command.entity_id));
        }

        let cosine = command.angle_radians.cos();
        let sine = command.angle_radians.sin();
        let transform = &target.transform;
        target.transform = poietra_scene_ir::AffineTransformV1 {
            m11: cosine * transform.m11 - sine * transform.m21,
            m12: cosine * transform.m12 - sine * transform.m22,
            m21: sine * transform.m11 + cosine * transform.m21,
            m22: sine * transform.m12 + cosine * transform.m22,
            tx: command.pivot.x + cosine * (transform.tx - command.pivot.x)
                - sine * (transform.ty - command.pivot.y),
            ty: command.pivot.y
                + sine * (transform.tx - command.pivot.x)
                + cosine * (transform.ty - command.pivot.y),
        };
        target.provenance_id.clone_from(&command.provenance.id);
        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically translates one root entity by a world-space delta.
    ///
    /// The command is deliberately independent of source profiles, viewport coordinates, and
    /// Manim bindings. Integration code must authorize and lower those concerns before calling
    /// this method.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    pub fn move_scene_entity(
        &mut self,
        command: MoveSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, MoveSceneEntityError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(MoveSceneEntityError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(MoveSceneEntityError::RevisionDidNotAdvance);
        }
        if !command.delta.x.is_finite()
            || !command.delta.y.is_finite()
            || (command.delta.x == 0.0 && command.delta.y == 0.0)
        {
            return Err(MoveSceneEntityError::InvalidDelta);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(MoveSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(MoveSceneEntityError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if candidate.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, .. }
                    | AnimationChannelV1::MotionPath { entity_id, .. }
                    if entity_id == &command.entity_id
            )
        }) {
            return Err(MoveSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| MoveSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(MoveSceneEntityError::TargetIsNotRoot(command.entity_id));
        }
        target.transform.tx += command.delta.x;
        target.transform.ty += command.delta.y;
        target.provenance_id.clone_from(&command.provenance.id);
        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically scales one root entity uniformly about a world-space pivot.
    ///
    /// The command is deliberately independent of source profiles, viewport coordinates, and
    /// Manim bindings. Integration code must authorize and lower those concerns before calling
    /// this method.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        reason = "exact identity is the profile-free command boundary"
    )]
    pub fn uniform_scale_scene_entity(
        &mut self,
        command: UniformScaleSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, UniformScaleSceneEntityError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(UniformScaleSceneEntityError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(UniformScaleSceneEntityError::RevisionDidNotAdvance);
        }
        if !command.factor.is_finite() || command.factor <= 0.0 || command.factor == 1.0 {
            return Err(UniformScaleSceneEntityError::InvalidFactor);
        }
        if !command.pivot.x.is_finite() || !command.pivot.y.is_finite() {
            return Err(UniformScaleSceneEntityError::InvalidPivot);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(UniformScaleSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(UniformScaleSceneEntityError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if candidate.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, .. }
                    | AnimationChannelV1::MotionPath { entity_id, .. }
                    if entity_id == &command.entity_id
            )
        }) {
            return Err(UniformScaleSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| {
                UniformScaleSceneEntityError::TargetMissing(command.entity_id.clone())
            })?;
        if target.parent_id.is_some() {
            return Err(UniformScaleSceneEntityError::TargetIsNotRoot(
                command.entity_id,
            ));
        }
        let transform = &target.transform;
        target.transform = poietra_scene_ir::AffineTransformV1 {
            m11: command.factor * transform.m11,
            m12: command.factor * transform.m12,
            m21: command.factor * transform.m21,
            m22: command.factor * transform.m22,
            tx: command.pivot.x + command.factor * (transform.tx - command.pivot.x),
            ty: command.pivot.y + command.factor * (transform.ty - command.pivot.y),
        };
        target.provenance_id.clone_from(&command.provenance.id);
        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically sets every static vector-paint alpha in one root subtree.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the atomic subtree command keeps validation and candidate mutation together; an exact stored alpha match defines its no-op"
    )]
    pub fn set_subtree_vector_paint_alpha(
        &mut self,
        command: SetSubtreeVectorPaintAlphaCommand,
    ) -> Result<SceneIrBundleV1, SetSubtreeVectorPaintAlphaError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(SetSubtreeVectorPaintAlphaError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(SetSubtreeVectorPaintAlphaError::RevisionDidNotAdvance);
        }
        if !command.alpha.is_finite() || !(0.0..=1.0).contains(&command.alpha) {
            return Err(SetSubtreeVectorPaintAlphaError::InvalidAlpha);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(SetSubtreeVectorPaintAlphaError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(SetSubtreeVectorPaintAlphaError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let entity_indexes = candidate
            .scene
            .entities
            .iter()
            .enumerate()
            .map(|(index, entity)| (entity.id.as_str(), index))
            .collect::<std::collections::HashMap<_, _>>();
        let root_index = *entity_indexes
            .get(command.root_entity_id.as_str())
            .ok_or_else(|| {
                SetSubtreeVectorPaintAlphaError::TargetMissing(command.root_entity_id.clone())
            })?;
        if candidate.scene.entities[root_index].parent_id.is_some() {
            return Err(SetSubtreeVectorPaintAlphaError::TargetIsNotRoot(
                command.root_entity_id,
            ));
        }

        let mut children = vec![Vec::new(); candidate.scene.entities.len()];
        for (entity_index, entity) in candidate.scene.entities.iter().enumerate() {
            if let Some(parent_id) = entity.parent_id.as_deref() {
                let Some(&parent_index) = entity_indexes.get(parent_id) else {
                    return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                        entity.id.clone(),
                    ));
                };
                children[parent_index].push(entity_index);
            }
        }
        let mut subtree = vec![false; candidate.scene.entities.len()];
        let mut pending = vec![root_index];
        while let Some(entity_index) = pending.pop() {
            if subtree[entity_index] {
                continue;
            }
            subtree[entity_index] = true;
            pending.extend(children[entity_index].iter().copied());
        }

        for channel in &candidate.scene.animation_channels {
            let (AnimationChannelV1::Opacity { entity_id, .. }
            | AnimationChannelV1::VectorAppearance { entity_id, .. }) = channel
            else {
                continue;
            };
            let Some(&entity_index) = entity_indexes.get(entity_id.as_str()) else {
                return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                    entity_id.clone(),
                ));
            };
            if subtree[entity_index] {
                return Err(SetSubtreeVectorPaintAlphaError::AnimatedPaintUnsupported(
                    entity_id.clone(),
                ));
            }
        }
        drop(entity_indexes);

        let mut changed_entities = 0usize;
        for (entity_index, entity) in candidate.scene.entities.iter_mut().enumerate() {
            if !subtree[entity_index] {
                continue;
            }
            match (&entity.geometry, &mut entity.appearance) {
                (SceneGeometryV1::Group {}, SceneAppearanceV1::Group { .. }) => {}
                (
                    SceneGeometryV1::Circle { .. }
                    | SceneGeometryV1::Rectangle { .. }
                    | SceneGeometryV1::Line { .. }
                    | SceneGeometryV1::CubicPath { .. },
                    SceneAppearanceV1::Vector { fill, stroke, .. },
                ) if fill.is_some() || stroke.is_some() => {
                    let fill_changed = fill
                        .as_ref()
                        .is_some_and(|paint| paint.color.alpha != command.alpha);
                    let stroke_changed = stroke
                        .as_ref()
                        .is_some_and(|paint| paint.color.alpha != command.alpha);
                    if let Some(fill) = fill {
                        fill.color.alpha = command.alpha;
                    }
                    if let Some(stroke) = stroke {
                        stroke.color.alpha = command.alpha;
                    }
                    if fill_changed || stroke_changed {
                        changed_entities += 1;
                        entity.provenance_id.clone_from(&command.provenance.id);
                    }
                }
                _ => {
                    return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                        entity.id.clone(),
                    ));
                }
            }
        }
        if changed_entities == 0 {
            return Err(SetSubtreeVectorPaintAlphaError::NoPaintChanged);
        }

        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };
        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use poietra_scene_ir::{
        RuntimeTraceVersionV1, SceneIrBundleV1, SceneSourceV1, parse_scene_ir_bundle_json_v1,
    };

    use super::*;

    const BASE_REVISION: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const NEXT_REVISION: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn fixture_bundle(name: &str) -> SceneIrBundleV1 {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1")
            .join(name);
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        parse_scene_ir_bundle_json_v1(
            &serde_json::to_vec(&serde_json::json!({
                "assets": fixture["assets"],
                "scene": fixture["scene"],
            }))
            .unwrap(),
        )
        .unwrap()
    }

    fn imported_bundle() -> SceneIrBundleV1 {
        let mut bundle = fixture_bundle("shared-circle-opacity.json");
        bundle.scene.source = SceneSourceV1::ImportedManimRuntimeTrace {
            runtime_config_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            source_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .to_owned(),
            trace_digest: BASE_REVISION.to_owned(),
            trace_version: RuntimeTraceVersionV1::V3,
        };
        let target = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        target.transform.tx = 3.0;
        target.transform.ty = -2.0;
        bundle
    }

    fn command() -> RotateSceneEntityCommand {
        RotateSceneEntityCommand {
            angle_radians: std::f64::consts::FRAC_PI_2,
            entity_id: "later".to_owned(),
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            pivot: PointV1 { x: 1.0, y: -0.5 },
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio rotation".to_owned()],
                id: "studio-rotation".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn move_command() -> MoveSceneEntityCommand {
        MoveSceneEntityCommand {
            delta: PointV1 { x: -1.25, y: 4.0 },
            entity_id: "later".to_owned(),
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio move".to_owned()],
                id: "studio-move".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn move_command_for(bundle: &SceneIrBundleV1, entity_id: &str) -> MoveSceneEntityCommand {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        MoveSceneEntityCommand {
            entity_id: entity_id.to_owned(),
            expected_base_revision,
            next_revision,
            ..move_command()
        }
    }

    fn rejected_move(
        bundle: SceneIrBundleV1,
        command: MoveSceneEntityCommand,
    ) -> MoveSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.move_scene_entity(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn real_line_joints_bundle() -> SceneIrBundleV1 {
        let mut bundle = fixture_bundle("real-line-joints-v10.json");
        let root = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.parent_id.is_none())
            .unwrap();
        root.transform = poietra_scene_ir::AffineTransformV1 {
            m11: 1.25,
            m12: 0.5,
            m21: -0.25,
            m22: 0.75,
            tx: 3.0,
            ty: -2.0,
        };
        bundle
    }

    fn uniform_scale_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> UniformScaleSceneEntityCommand {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        UniformScaleSceneEntityCommand {
            entity_id: entity_id.to_owned(),
            expected_base_revision,
            factor: 1.5,
            next_revision,
            pivot: PointV1 { x: 1.0, y: -0.5 },
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio uniform scale".to_owned()],
                id: "studio-uniform-scale".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn rejected_uniform_scale(
        bundle: SceneIrBundleV1,
        command: UniformScaleSceneEntityCommand,
    ) -> UniformScaleSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.uniform_scale_scene_entity(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn paint_alpha_command_for(
        bundle: &SceneIrBundleV1,
        root_entity_id: &str,
    ) -> SetSubtreeVectorPaintAlphaCommand {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        SetSubtreeVectorPaintAlphaCommand {
            alpha: 0.25,
            expected_base_revision,
            next_revision,
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio subtree paint alpha".to_owned()],
                id: "studio-subtree-paint-alpha".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            root_entity_id: root_entity_id.to_owned(),
        }
    }

    fn rejected_paint_alpha(
        bundle: SceneIrBundleV1,
        command: SetSubtreeVectorPaintAlphaCommand,
    ) -> SetSubtreeVectorPaintAlphaError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.set_subtree_vector_paint_alpha(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    #[test]
    fn rotates_an_imported_root_and_returns_the_installed_bundle() {
        let bundle = imported_bundle();
        let untouched = bundle.scene.entities[1..].to_vec();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.rotate_scene_entity(command()).unwrap();
        let rotated = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!(rotated.transform.m11.abs() < 1e-12);
        assert!((rotated.transform.m12 + 1.0).abs() < 1e-12);
        assert!((rotated.transform.m21 - 1.0).abs() < 1e-12);
        assert!(rotated.transform.m22.abs() < 1e-12);
        assert!((rotated.transform.tx - 2.5).abs() < 1e-12);
        assert!((rotated.transform.ty - 1.5).abs() < 1e-12);
        assert_eq!(rotated.provenance_id, "studio-rotation");
        assert_eq!(result.scene.entities[1..], untouched);
        assert_eq!(result.scene.provenance.last(), Some(&command().provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: NEXT_REVISION.to_owned(),
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &result.assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn moves_an_imported_root_by_one_world_delta() {
        let bundle = imported_bundle();
        let original = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .clone();
        let untouched = bundle.scene.entities[1..].to_vec();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.move_scene_entity(move_command()).unwrap();
        let moved = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert_eq!(
            moved.transform,
            poietra_scene_ir::AffineTransformV1 {
                tx: 1.75,
                ty: 2.0,
                ..original.transform
            }
        );
        assert_eq!(moved.provenance_id, "studio-move");
        assert_eq!(result.scene.entities[1..], untouched);
        assert_eq!(
            result.scene.provenance.last(),
            Some(&move_command().provenance)
        );
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: NEXT_REVISION.to_owned(),
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &result.assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn uniformly_scales_a_real_top_level_group_about_a_world_pivot() {
        let bundle = real_line_joints_bundle();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .clone();
        let children = bundle
            .scene
            .entities
            .iter()
            .filter(|entity| entity.parent_id.as_deref() == Some(root.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let command = uniform_scale_command_for(&bundle, &root.id);
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.uniform_scale_scene_entity(command.clone()).unwrap();
        let scaled = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == root.id)
            .unwrap();

        assert_eq!(
            scaled.transform,
            poietra_scene_ir::AffineTransformV1 {
                m11: 1.875,
                m12: 0.75,
                m21: -0.375,
                m22: 1.125,
                tx: 4.0,
                ty: -2.75,
            }
        );
        assert_eq!(scaled.provenance_id, "studio-uniform-scale");
        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .filter(|entity| entity.parent_id.as_deref() == Some(root.id.as_str()))
                .cloned()
                .collect::<Vec<_>>(),
            children
        );
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: command.next_revision,
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn sets_all_three_real_line_joints_stroke_alphas_without_changing_other_child_state() {
        let bundle = real_line_joints_bundle();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .clone();
        let original_children = bundle.scene.entities[1..].to_vec();
        let command = paint_alpha_command_for(&bundle, &root.id);
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .set_subtree_vector_paint_alpha(command.clone())
            .unwrap();

        assert_eq!(result.scene.entities[0], root);
        for (changed, original) in result.scene.entities[1..].iter().zip(original_children) {
            let mut expected = original;
            let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut expected.appearance else {
                panic!("the real LineJoints leaves must remain vector paint");
            };
            assert!(fill.is_none());
            stroke
                .as_mut()
                .expect("the real LineJoints leaves must retain their strokes")
                .color
                .alpha = command.alpha;
            expected.provenance_id.clone_from(&command.provenance.id);
            assert_eq!(changed, &expected);
        }
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: command.next_revision,
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn paint_alpha_provenance_marks_only_vector_entities_whose_paint_changed() {
        let mut bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        let unchanged_id = bundle.scene.entities[1].id.clone();
        let unchanged_provenance = bundle.scene.entities[1].provenance_id.clone();
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut bundle.scene.entities[1].appearance
        else {
            panic!("the real LineJoints first leaf must retain its stroke");
        };
        stroke.color.alpha = 0.25;
        let command = paint_alpha_command_for(&bundle, &root_id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .set_subtree_vector_paint_alpha(command.clone())
            .unwrap();

        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == unchanged_id)
                .unwrap()
                .provenance_id,
            unchanged_provenance
        );
        assert!(
            result.scene.entities[2..]
                .iter()
                .all(|entity| entity.provenance_id == command.provenance.id)
        );
    }

    #[test]
    fn every_rejected_paint_alpha_preserves_the_real_retained_scene() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        let child_id = bundle.scene.entities[1].id.clone();
        let command = paint_alpha_command_for(&bundle, &root_id);
        let mut rejected = Vec::new();

        let mut stale = command.clone();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = command.clone();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = command.clone();
        unchanged_revision.next_revision = unchanged_revision.expected_base_revision.clone();
        rejected.push(unchanged_revision);

        let mut missing = command.clone();
        missing.root_entity_id = "missing".to_owned();
        rejected.push(missing);

        for alpha in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            let mut invalid_alpha = command.clone();
            invalid_alpha.alpha = alpha;
            rejected.push(invalid_alpha);
        }

        let mut wrong_origin = command.clone();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = command.clone();
        duplicate_provenance.provenance.id = bundle.scene.provenance[0].id.clone();
        rejected.push(duplicate_provenance);

        let mut child_target = command.clone();
        child_target.root_entity_id = child_id;
        rejected.push(child_target);

        let mut no_op = command;
        no_op.alpha = 1.0;
        rejected.push(no_op);

        for command in rejected {
            let _error = rejected_paint_alpha(real_line_joints_bundle(), command);
        }

        let image_bundle = fixture_bundle("png-alpha-edge-camera.json");
        let image_id = image_bundle.scene.entities[0].id.clone();
        let image_command = paint_alpha_command_for(&image_bundle, &image_id);
        assert!(matches!(
            rejected_paint_alpha(image_bundle, image_command),
            SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(id) if id == image_id
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("vector-appearance-square-circle.json", "shape"),
        ] {
            let animated_bundle = fixture_bundle(fixture);
            let command = paint_alpha_command_for(&animated_bundle, entity_id);
            assert!(matches!(
                rejected_paint_alpha(animated_bundle, command),
                SetSubtreeVectorPaintAlphaError::AnimatedPaintUnsupported(id)
                    if id == entity_id
            ));
        }
    }

    #[test]
    fn every_rejected_uniform_scale_preserves_the_real_retained_scene() {
        let bundle = real_line_joints_bundle();
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
        let command = uniform_scale_command_for(&bundle, &root_id);
        let mut rejected = Vec::new();

        let mut stale = command.clone();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = command.clone();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = command.clone();
        unchanged_revision.next_revision = unchanged_revision.expected_base_revision.clone();
        rejected.push(unchanged_revision);

        let mut missing = command.clone();
        missing.entity_id = "missing".to_owned();
        rejected.push(missing);

        for factor in [f64::NAN, f64::INFINITY, -1.0, 0.0, 1.0] {
            let mut invalid_factor = command.clone();
            invalid_factor.factor = factor;
            rejected.push(invalid_factor);
        }

        let mut invalid_pivot = command.clone();
        invalid_pivot.pivot.x = f64::NAN;
        rejected.push(invalid_pivot);

        let mut wrong_origin = command.clone();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = command.clone();
        duplicate_provenance.provenance.id = bundle.scene.provenance[0].id.clone();
        rejected.push(duplicate_provenance);

        let mut child_target = command.clone();
        child_target.entity_id = child_id;
        rejected.push(child_target);

        let mut overflowing = command;
        overflowing.factor = f64::MAX;
        rejected.push(overflowing);

        for command in rejected {
            let _error = rejected_uniform_scale(real_line_joints_bundle(), command);
        }

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let animated_bundle = fixture_bundle(fixture);
            let command = uniform_scale_command_for(&animated_bundle, entity_id);
            assert!(matches!(
                rejected_uniform_scale(animated_bundle, command),
                UniformScaleSceneEntityError::AnimatedTransformUnsupported(id)
                    if id == entity_id
            ));
        }
    }

    #[test]
    fn every_rejected_move_preserves_the_retained_scene() {
        let mut rejected = Vec::new();

        let mut stale = move_command();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = move_command();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = move_command();
        unchanged_revision.next_revision = BASE_REVISION.to_owned();
        rejected.push(unchanged_revision);

        let mut missing = move_command();
        missing.entity_id = "missing".to_owned();
        rejected.push(missing);

        let mut invalid_delta = move_command();
        invalid_delta.delta.x = f64::NAN;
        rejected.push(invalid_delta);

        let mut zero_delta = move_command();
        zero_delta.delta = PointV1 { x: 0.0, y: -0.0 };
        rejected.push(zero_delta);

        let mut wrong_origin = move_command();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = move_command();
        duplicate_provenance.provenance.id = "fixture".to_owned();
        rejected.push(duplicate_provenance);

        for command in rejected {
            let _error = rejected_move(imported_bundle(), command);
        }

        let child_bundle = fixture_bundle("dynamic-affine-camera.json");
        let child_command = move_command_for(&child_bundle, "asymmetric-child");
        assert!(matches!(
            rejected_move(child_bundle, child_command),
            MoveSceneEntityError::TargetIsNotRoot(id) if id == "asymmetric-child"
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let bundle = fixture_bundle(fixture);
            let command = move_command_for(&bundle, entity_id);
            assert!(matches!(
                rejected_move(bundle, command),
                MoveSceneEntityError::AnimatedTransformUnsupported(id) if id == entity_id
            ));
        }
    }

    #[test]
    fn animated_transform_targets_are_rejected_without_mutation() {
        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let bundle = fixture_bundle(fixture);
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle).unwrap();
            let mut command = command();
            command.entity_id = entity_id.to_owned();
            command.expected_base_revision = session.scene().source.revision_hash().to_owned();

            assert!(matches!(
                session.rotate_scene_entity(command),
                Err(RotateSceneEntityError::AnimatedTransformUnsupported(target))
                    if target == entity_id
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn every_rejected_rotation_preserves_the_retained_scene() {
        let mut rejected = Vec::new();

        let mut stale = command();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = command();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = command();
        unchanged_revision.next_revision = BASE_REVISION.to_owned();
        rejected.push(unchanged_revision);

        let mut missing = command();
        missing.entity_id = "missing".to_owned();
        rejected.push(missing);

        let mut invalid_pivot = command();
        invalid_pivot.pivot.x = f64::NAN;
        rejected.push(invalid_pivot);

        let mut zero_angle = command();
        zero_angle.angle_radians = 0.0;
        rejected.push(zero_angle);

        let mut full_turn = command();
        full_turn.angle_radians = std::f64::consts::TAU;
        rejected.push(full_turn);

        let mut wrong_origin = command();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = command();
        duplicate_provenance.provenance.id = "fixture".to_owned();
        rejected.push(duplicate_provenance);

        for command in rejected {
            let bundle = imported_bundle();
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle).unwrap();

            assert!(session.rotate_scene_entity(command).is_err());
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }
}
