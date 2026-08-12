use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1,
    SceneIrBundleV1, SceneSourceV1,
};

use crate::{EngineSessionV1, EvaluationError};

const ROTATION_NOOP_EPSILON_V1: f64 = 1e-12;

/// One profile-free Studio command that rotates a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct RotateSceneEntityCommandV1 {
    pub angle_radians: f64,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub pivot: PointV1,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio command that translates a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct MoveSceneEntityCommandV1 {
    pub delta: PointV1,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio command that uniformly scales a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct UniformScaleSceneEntityCommandV1 {
    pub entity_id: String,
    pub expected_base_revision: String,
    pub factor: f64,
    pub next_revision: String,
    pub pivot: PointV1,
    pub provenance: ProvenanceRecordV1,
}

#[derive(Debug, thiserror::Error)]
pub enum RotateSceneEntityErrorV1 {
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
pub enum MoveSceneEntityErrorV1 {
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
pub enum UniformScaleSceneEntityErrorV1 {
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

fn rotation_is_noop(angle_radians: f64) -> bool {
    let normalized = angle_radians.sin().atan2(angle_radians.cos());
    normalized.abs() <= ROTATION_NOOP_EPSILON_V1
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
    pub fn rotate_scene_entity_v1(
        &mut self,
        command: RotateSceneEntityCommandV1,
    ) -> Result<SceneIrBundleV1, RotateSceneEntityErrorV1> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(RotateSceneEntityErrorV1::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(RotateSceneEntityErrorV1::RevisionDidNotAdvance);
        }
        if !command.angle_radians.is_finite() || rotation_is_noop(command.angle_radians) {
            return Err(RotateSceneEntityErrorV1::InvalidAngle);
        }
        if !command.pivot.x.is_finite() || !command.pivot.y.is_finite() {
            return Err(RotateSceneEntityErrorV1::InvalidPivot);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(RotateSceneEntityErrorV1::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(RotateSceneEntityErrorV1::ProvenanceConflict(
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
            return Err(RotateSceneEntityErrorV1::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| RotateSceneEntityErrorV1::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(RotateSceneEntityErrorV1::TargetIsNotRoot(command.entity_id));
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
    pub fn move_scene_entity_v1(
        &mut self,
        command: MoveSceneEntityCommandV1,
    ) -> Result<SceneIrBundleV1, MoveSceneEntityErrorV1> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(MoveSceneEntityErrorV1::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(MoveSceneEntityErrorV1::RevisionDidNotAdvance);
        }
        if !command.delta.x.is_finite()
            || !command.delta.y.is_finite()
            || (command.delta.x == 0.0 && command.delta.y == 0.0)
        {
            return Err(MoveSceneEntityErrorV1::InvalidDelta);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(MoveSceneEntityErrorV1::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(MoveSceneEntityErrorV1::ProvenanceConflict(
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
            return Err(MoveSceneEntityErrorV1::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| MoveSceneEntityErrorV1::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(MoveSceneEntityErrorV1::TargetIsNotRoot(command.entity_id));
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
    pub fn uniform_scale_scene_entity_v1(
        &mut self,
        command: UniformScaleSceneEntityCommandV1,
    ) -> Result<SceneIrBundleV1, UniformScaleSceneEntityErrorV1> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(UniformScaleSceneEntityErrorV1::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(UniformScaleSceneEntityErrorV1::RevisionDidNotAdvance);
        }
        if !command.factor.is_finite() || command.factor <= 0.0 || command.factor == 1.0 {
            return Err(UniformScaleSceneEntityErrorV1::InvalidFactor);
        }
        if !command.pivot.x.is_finite() || !command.pivot.y.is_finite() {
            return Err(UniformScaleSceneEntityErrorV1::InvalidPivot);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(UniformScaleSceneEntityErrorV1::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(UniformScaleSceneEntityErrorV1::ProvenanceConflict(
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
            return Err(
                UniformScaleSceneEntityErrorV1::AnimatedTransformUnsupported(command.entity_id),
            );
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| {
                UniformScaleSceneEntityErrorV1::TargetMissing(command.entity_id.clone())
            })?;
        if target.parent_id.is_some() {
            return Err(UniformScaleSceneEntityErrorV1::TargetIsNotRoot(
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

    fn command() -> RotateSceneEntityCommandV1 {
        RotateSceneEntityCommandV1 {
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

    fn move_command() -> MoveSceneEntityCommandV1 {
        MoveSceneEntityCommandV1 {
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

    fn move_command_for(bundle: &SceneIrBundleV1, entity_id: &str) -> MoveSceneEntityCommandV1 {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        MoveSceneEntityCommandV1 {
            entity_id: entity_id.to_owned(),
            expected_base_revision,
            next_revision,
            ..move_command()
        }
    }

    fn rejected_move(
        bundle: SceneIrBundleV1,
        command: MoveSceneEntityCommandV1,
    ) -> MoveSceneEntityErrorV1 {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.move_scene_entity_v1(command).unwrap_err();
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
    ) -> UniformScaleSceneEntityCommandV1 {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        UniformScaleSceneEntityCommandV1 {
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
        command: UniformScaleSceneEntityCommandV1,
    ) -> UniformScaleSceneEntityErrorV1 {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.uniform_scale_scene_entity_v1(command).unwrap_err();
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

        let result = session.rotate_scene_entity_v1(command()).unwrap();
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

        let result = session.move_scene_entity_v1(move_command()).unwrap();
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

        let result = session
            .uniform_scale_scene_entity_v1(command.clone())
            .unwrap();
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
                UniformScaleSceneEntityErrorV1::AnimatedTransformUnsupported(id)
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
            MoveSceneEntityErrorV1::TargetIsNotRoot(id) if id == "asymmetric-child"
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let bundle = fixture_bundle(fixture);
            let command = move_command_for(&bundle, entity_id);
            assert!(matches!(
                rejected_move(bundle, command),
                MoveSceneEntityErrorV1::AnimatedTransformUnsupported(id) if id == entity_id
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
                session.rotate_scene_entity_v1(command),
                Err(RotateSceneEntityErrorV1::AnimatedTransformUnsupported(target))
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

            assert!(session.rotate_scene_entity_v1(command).is_err());
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }
}
