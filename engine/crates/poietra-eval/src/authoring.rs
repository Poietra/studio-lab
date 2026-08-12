use std::collections::BTreeSet;

use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, ContractVersionV1, CubicPathV1, EasingV1, FidelityV1,
    FillRuleV1, FillStyleV1, IntervalV1, KeyframeV1, PointV1, ProvenanceOriginV1,
    ProvenanceRecordV1, RgbaColorV1, SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneSourceV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
};

use crate::{EngineSessionV1, EvaluationError};

const ROTATION_NOOP_EPSILON: f64 = 1e-12;
const TIMELINE_ANCHOR_EPSILON: f64 = 0.0005;

/// Geometry accepted by the atomic Studio entity-creation command.
#[derive(Clone, Debug, PartialEq)]
pub enum CreateSceneEntityGeometry {
    Circle { radius: f64 },
    Rectangle { height: f64, width: f64 },
    MathTex { path: CubicPathV1 },
}

/// Optional fade-in attached to one newly created entity.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateSceneEntityFadeIn {
    pub end: f64,
}

/// One absolute Studio transform that becomes active at an exact Scene time.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateSceneEntityInstantTransform {
    pub at: f64,
    pub position: PointV1,
    pub scale_x: f64,
    pub scale_y: f64,
}

/// One entity within an atomic Studio creation batch.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateSceneEntity {
    pub fade_in: Option<CreateSceneEntityFadeIn>,
    pub geometry: CreateSceneEntityGeometry,
    pub id: String,
    pub lifetime: IntervalV1,
    pub position: PointV1,
    pub scale: f64,
    pub instant_transform: Option<CreateSceneEntityInstantTransform>,
}

/// One insertion into the existing Scene timeline before created entities are appended.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateSceneTimelineInsertion {
    pub at: f64,
    pub duration: f64,
}

/// One profile-free Studio command that atomically creates supported entities.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateSceneEntitiesCommand {
    pub entities: Vec<CreateSceneEntity>,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
    pub timeline_insertions: Vec<CreateSceneTimelineInsertion>,
}

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

/// One optional positive axis scale within an atomic world-space transform.
#[derive(Clone, Debug, PartialEq)]
pub struct ScaleAboutPivot {
    pub pivot: PointV1,
    pub x_factor: f64,
    pub y_factor: f64,
}

/// One profile-free Studio command that atomically transforms an authorized entity.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSceneEntityCommand {
    pub delta: PointV1,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
    pub scale: Option<ScaleAboutPivot>,
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
pub enum CreateSceneEntitiesError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("entity creation must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the timeline insertion must be finite, non-negative, and start inside the base Scene")]
    InvalidTimelineInsertion,
    #[error("an entity creation command must contain at least one entity")]
    EmptyBatch,
    #[error("the entity creation provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("created entity fade-in must end inside its lifetime")]
    InvalidFade,
    #[error("a created entity instant transform must be finite, positive, and inside its lifetime")]
    InvalidInstantTransform,
    #[error("the Scene containing the created entities failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
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
pub enum TransformSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the transform must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the world-space translation delta must be finite")]
    InvalidDelta,
    #[error("the optional axis scale factors must be finite, positive, and not both identity")]
    InvalidFactor,
    #[error("the optional world-space scale pivot must be finite")]
    InvalidPivot,
    #[error("the transform must contain a non-zero translation or an axis scale")]
    NoOp,
    #[error("the transform target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space transform does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("world-space transform requires identity, transform-static ancestors: {0}")]
    TransformedAncestorUnsupported(String),
    #[error("the transform provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the transform provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the transformed Scene failed whole-bundle verification: {0}")]
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

fn apply_world_translation(transform: &mut poietra_scene_ir::AffineTransformV1, delta: &PointV1) {
    transform.tx += delta.x;
    transform.ty += delta.y;
}

fn apply_world_axis_scale(
    transform: &mut poietra_scene_ir::AffineTransformV1,
    x_factor: f64,
    y_factor: f64,
    pivot: &PointV1,
) {
    *transform = poietra_scene_ir::AffineTransformV1 {
        m11: x_factor * transform.m11,
        m12: x_factor * transform.m12,
        m21: y_factor * transform.m21,
        m22: y_factor * transform.m22,
        tx: pivot.x + x_factor * (transform.tx - pivot.x),
        ty: pivot.y + y_factor * (transform.ty - pivot.y),
    };
}

fn has_animated_transform(scene: &poietra_scene_ir::SceneIrV1, entity_id: &str) -> bool {
    scene.animation_channels.iter().any(|channel| {
        matches!(
            channel,
            AnimationChannelV1::AffineTransform { entity_id: animated_id, .. }
                | AnimationChannelV1::MotionPath { entity_id: animated_id, .. }
                if animated_id == entity_id
        )
    })
}

fn studio_white() -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: 1.0,
        blue: 1.0,
        green: 1.0,
        red: 1.0,
    }
}

fn studio_shape_appearance() -> SceneAppearanceV1 {
    SceneAppearanceV1::Vector {
        fill: None,
        opacity: 1.0,
        stroke: Some(StrokeStyleV1 {
            cap: StrokeCapV1::Butt,
            color: studio_white(),
            join: StrokeJoinV1::Miter,
            miter_limit: 10.0,
            width_world: 0.04,
        }),
    }
}

fn studio_math_tex_appearance() -> SceneAppearanceV1 {
    SceneAppearanceV1::Vector {
        fill: Some(FillStyleV1 {
            color: studio_white(),
            rule: FillRuleV1::NonZero,
        }),
        opacity: 1.0,
        stroke: None,
    }
}

fn created_geometry_and_appearance(
    geometry: CreateSceneEntityGeometry,
) -> (SceneGeometryV1, SceneAppearanceV1, SceneCapabilityV1) {
    match geometry {
        CreateSceneEntityGeometry::Circle { radius } => (
            SceneGeometryV1::Circle {
                center: PointV1 { x: 0.0, y: 0.0 },
                radius,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::Rectangle { height, width } => (
            SceneGeometryV1::Rectangle {
                center: PointV1 { x: 0.0, y: 0.0 },
                corner_radius: 0.0,
                height,
                width,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::MathTex { path } => (
            SceneGeometryV1::CubicPath { path },
            studio_math_tex_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
    }
}

fn shift_interval_for_insertion(
    interval: &mut IntervalV1,
    insertion: &CreateSceneTimelineInsertion,
) {
    if interval.start >= insertion.at - TIMELINE_ANCHOR_EPSILON {
        interval.start += insertion.duration;
        interval.end += insertion.duration;
    } else if interval.end > insertion.at {
        interval.end += insertion.duration;
    }
}

fn shift_keyframes_for_insertion<T>(
    keyframes: &mut [KeyframeV1<T>],
    insertion: &CreateSceneTimelineInsertion,
) {
    for keyframe in keyframes {
        if keyframe.at >= insertion.at - TIMELINE_ANCHOR_EPSILON {
            keyframe.at += insertion.duration;
        }
    }
}

fn insert_scene_time(
    scene: &mut poietra_scene_ir::SceneIrV1,
    insertion: &CreateSceneTimelineInsertion,
) {
    for entity in &mut scene.entities {
        for lifetime in &mut entity.lifetimes {
            shift_interval_for_insertion(lifetime, insertion);
        }
    }
    for channel in &mut scene.animation_channels {
        match channel {
            AnimationChannelV1::AffineTransform { keyframes, .. } => {
                shift_keyframes_for_insertion(keyframes, insertion);
            }
            AnimationChannelV1::Opacity { keyframes, .. }
            | AnimationChannelV1::PathTrim { keyframes, .. }
            | AnimationChannelV1::MotionPath { keyframes, .. } => {
                shift_keyframes_for_insertion(keyframes, insertion);
            }
            AnimationChannelV1::PathMorph { keyframes, .. } => {
                shift_keyframes_for_insertion(keyframes, insertion);
            }
            AnimationChannelV1::VectorAppearance { keyframes, .. } => {
                shift_keyframes_for_insertion(keyframes, insertion);
            }
            AnimationChannelV1::Camera { keyframes, .. } => {
                shift_keyframes_for_insertion(keyframes, insertion);
            }
        }
    }
    scene.duration += insertion.duration;
}

fn validate_create_scene_entities_command(
    session: &EngineSessionV1,
    command: &CreateSceneEntitiesCommand,
) -> Result<(), CreateSceneEntitiesError> {
    if session.scene().source.revision_hash() != command.expected_base_revision {
        return Err(CreateSceneEntitiesError::StaleBaseRevision);
    }
    if command.next_revision == command.expected_base_revision {
        return Err(CreateSceneEntitiesError::RevisionDidNotAdvance);
    }
    let mut duration = session.scene().duration;
    for insertion in &command.timeline_insertions {
        if !insertion.at.is_finite()
            || insertion.at < 0.0
            || insertion.at > duration
            || !insertion.duration.is_finite()
            || insertion.duration < 0.0
            || !(duration + insertion.duration).is_finite()
        {
            return Err(CreateSceneEntitiesError::InvalidTimelineInsertion);
        }
        duration += insertion.duration;
    }
    if command.entities.is_empty() {
        return Err(CreateSceneEntitiesError::EmptyBatch);
    }
    if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
        return Err(CreateSceneEntitiesError::InvalidProvenanceOrigin);
    }
    for entity in &command.entities {
        if let Some(fade) = &entity.fade_in
            && (!fade.end.is_finite()
                || fade.end <= entity.lifetime.start
                || fade.end > entity.lifetime.end)
        {
            return Err(CreateSceneEntitiesError::InvalidFade);
        }
        if let Some(step) = &entity.instant_transform
            && (!step.at.is_finite()
                || step.at <= entity.lifetime.start
                || step.at >= entity.lifetime.end
                || !step.position.x.is_finite()
                || !step.position.y.is_finite()
                || !step.scale_x.is_finite()
                || step.scale_x <= 0.0
                || !step.scale_y.is_finite()
                || step.scale_y <= 0.0)
        {
            return Err(CreateSceneEntitiesError::InvalidInstantTransform);
        }
    }
    Ok(())
}

fn unused_channel_id(scene: &poietra_scene_ir::SceneIrV1, prefix: &str) -> String {
    let mut candidate = prefix.to_owned();
    let mut suffix = 1_u32;
    while scene
        .animation_channels
        .iter()
        .any(|channel| channel.id() == candidate)
    {
        candidate = format!("{prefix}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn append_created_entity(
    scene: &mut poietra_scene_ir::SceneIrV1,
    entity: CreateSceneEntity,
    provenance_id: &str,
    scene_order: u32,
    source_z_index: f64,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) {
    let (geometry, appearance, capability) = created_geometry_and_appearance(entity.geometry);
    capabilities.insert(capability);
    let created_id = entity.id;
    let lifetime = entity.lifetime;
    let base_transform = AffineTransformV1 {
        m11: entity.scale,
        m12: 0.0,
        m21: 0.0,
        m22: entity.scale,
        tx: entity.position.x,
        ty: entity.position.y,
    };
    scene.entities.push(SceneEntityV1 {
        appearance,
        geometry,
        id: created_id.clone(),
        lifetimes: vec![lifetime.clone()],
        parent_id: None,
        provenance_id: provenance_id.to_owned(),
        scene_order,
        source_z_index,
        transform: base_transform,
    });
    if let Some(fade) = entity.fade_in {
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        let channel_id_prefix = format!("studio-opacity-{scene_order}");
        let channel_id = unused_channel_id(scene, &channel_id_prefix);
        scene.animation_channels.push(AnimationChannelV1::Opacity {
            entity_id: created_id.clone(),
            id: channel_id,
            keyframes: vec![
                KeyframeV1 {
                    at: lifetime.start,
                    easing_to_next: Some(EasingV1::Smooth {}),
                    value: 0.0,
                },
                KeyframeV1 {
                    at: fade.end,
                    easing_to_next: None,
                    value: 1.0,
                },
            ],
            provenance_id: provenance_id.to_owned(),
        });
    }
    if let Some(step) = entity.instant_transform {
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let value = AffineTransformV1 {
            m11: step.scale_x,
            m12: 0.0,
            m21: 0.0,
            m22: step.scale_y,
            tx: step.position.x,
            ty: step.position.y,
        };
        let keyframes = vec![
            KeyframeV1 {
                at: step.at,
                easing_to_next: Some(EasingV1::Linear {}),
                value: value.clone(),
            },
            KeyframeV1 {
                at: lifetime.end,
                easing_to_next: None,
                value,
            },
        ];
        let channel_id = unused_channel_id(scene, &format!("studio-transform-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: created_id,
                id: channel_id,
                keyframes,
                provenance_id: provenance_id.to_owned(),
            });
    }
}

impl EngineSessionV1 {
    /// Atomically appends one batch of Studio-created vector entities.
    ///
    /// Geometry inputs are local-space authoring facts. This method owns their default Manim
    /// paint, world transform, paint order, optional fade channel, capabilities, provenance,
    /// Scene duration, and revision replacement.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene, assets, and retained index.
    pub fn create_scene_entities(
        &mut self,
        command: CreateSceneEntitiesCommand,
    ) -> Result<SceneIrBundleV1, CreateSceneEntitiesError> {
        validate_create_scene_entities_command(self, &command)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let creates_math_tex = command
            .entities
            .iter()
            .any(|entity| matches!(&entity.geometry, CreateSceneEntityGeometry::MathTex { .. }));
        for insertion in &command.timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        if creates_math_tex && matches!(candidate.scene.fidelity, FidelityV1::Exact {}) {
            candidate.scene.fidelity = FidelityV1::Approximate {
                evidence: vec![
                    "Studio MathTex uses a browser-compiled outline without exact Manim parity evidence."
                        .to_owned(),
                ],
            };
        }
        candidate.scene.provenance.push(command.provenance.clone());

        let first_scene_order = candidate
            .scene
            .entities
            .iter()
            .map(|entity| entity.scene_order)
            .max()
            .map_or(0, |maximum| maximum + 1);
        let mut source_z_index = candidate
            .scene
            .entities
            .iter()
            .map(|entity| entity.source_z_index)
            .fold(-1.0_f64, f64::max)
            + 1.0;
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();

        for (scene_order, entity) in (first_scene_order..).zip(command.entities) {
            append_created_entity(
                &mut candidate.scene,
                entity,
                &command.provenance.id,
                scene_order,
                source_z_index,
                &mut capabilities,
            );
            source_z_index += 1.0;
        }
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

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
        if has_animated_transform(&candidate.scene, &command.entity_id) {
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

    /// Atomically applies a world-space translation and optional axis scale to one entity.
    ///
    /// Axis scale is applied about its pivot before the world-space translation. The command
    /// is independent of source profiles, viewport coordinates, and Manim bindings.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        reason = "exact identity defines whether the optional scale is a valid command"
    )]
    pub fn transform_scene_entity(
        &mut self,
        command: TransformSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, TransformSceneEntityError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance);
        }
        if !command.delta.x.is_finite() || !command.delta.y.is_finite() {
            return Err(TransformSceneEntityError::InvalidDelta);
        }
        if let Some(scale) = &command.scale {
            if !scale.x_factor.is_finite()
                || scale.x_factor <= 0.0
                || !scale.y_factor.is_finite()
                || scale.y_factor <= 0.0
                || (scale.x_factor == 1.0 && scale.y_factor == 1.0)
            {
                return Err(TransformSceneEntityError::InvalidFactor);
            }
            if !scale.pivot.x.is_finite() || !scale.pivot.y.is_finite() {
                return Err(TransformSceneEntityError::InvalidPivot);
            }
        } else if command.delta.x == 0.0 && command.delta.y == 0.0 {
            return Err(TransformSceneEntityError::NoOp);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(TransformSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(TransformSceneEntityError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if has_animated_transform(&candidate.scene, &command.entity_id) {
            return Err(TransformSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target_index = candidate
            .scene
            .entities
            .iter()
            .position(|entity| entity.id == command.entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        let target = &candidate.scene.entities[target_index];
        let mut parent_id = target.parent_id.as_deref();
        while let Some(id) = parent_id {
            let Some(parent) = candidate
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == id)
            else {
                return Err(TransformSceneEntityError::TransformedAncestorUnsupported(
                    id.to_owned(),
                ));
            };
            if parent.transform != poietra_scene_ir::AffineTransformV1::identity()
                || has_animated_transform(&candidate.scene, id)
            {
                return Err(TransformSceneEntityError::TransformedAncestorUnsupported(
                    id.to_owned(),
                ));
            }
            parent_id = parent.parent_id.as_deref();
        }
        let target = &mut candidate.scene.entities[target_index];
        if let Some(scale) = &command.scale {
            apply_world_axis_scale(
                &mut target.transform,
                scale.x_factor,
                scale.y_factor,
                &scale.pivot,
            );
        }
        apply_world_translation(&mut target.transform, &command.delta);
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

    fn transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        TransformSceneEntityCommand {
            delta: PointV1 { x: 2.0, y: -1.0 },
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio atomic transform".to_owned()],
                id: "studio-atomic-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            scale: Some(ScaleAboutPivot {
                pivot: PointV1 { x: 1.0, y: -0.5 },
                x_factor: 1.5,
                y_factor: 1.5,
            }),
        }
    }

    fn create_command(bundle: &SceneIrBundleV1) -> CreateSceneEntitiesCommand {
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle("mathtex-nested-radical-fraction.json")
                .scene
                .entities
                .remove(0)
                .geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        CreateSceneEntitiesCommand {
            entities: vec![
                CreateSceneEntity {
                    fade_in: None,
                    geometry: CreateSceneEntityGeometry::Circle { radius: 0.75 },
                    id: "tx:create/entity:circle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: 2.0, y: -1.0 },
                    scale: 1.25,
                    instant_transform: None,
                },
                CreateSceneEntity {
                    fade_in: Some(CreateSceneEntityFadeIn { end: 0.9 }),
                    geometry: CreateSceneEntityGeometry::Rectangle {
                        height: 2.0,
                        width: 3.0,
                    },
                    id: "tx:create/entity:rectangle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: -2.0, y: 1.0 },
                    scale: 0.5,
                    instant_transform: Some(CreateSceneEntityInstantTransform {
                        at: 1.25,
                        position: PointV1 { x: -1.0, y: 0.5 },
                        scale_x: 0.75,
                        scale_y: 1.0,
                    }),
                },
                CreateSceneEntity {
                    fade_in: None,
                    geometry: CreateSceneEntityGeometry::MathTex { path },
                    id: "tx:create/entity:mathtex".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: 0.0, y: 1.5 },
                    scale: 2.0,
                    instant_transform: None,
                },
            ],
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio creation batch".to_owned()],
                id: "studio-create".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            timeline_insertions: vec![
                CreateSceneTimelineInsertion {
                    at: 0.5,
                    duration: 0.25,
                },
                CreateSceneTimelineInsertion {
                    at: 0.75,
                    duration: 0.25,
                },
            ],
        }
    }

    fn rejected_transform(
        bundle: SceneIrBundleV1,
        command: TransformSceneEntityCommand,
    ) -> TransformSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.transform_scene_entity(command).unwrap_err();
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
    #[allow(
        clippy::float_cmp,
        reason = "these operations produce exact finite products"
    )]
    fn atomic_transform_supports_move_scale_and_their_composition() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        for (delta, factors, expected) in [
            (
                PointV1 { x: 2.0, y: -1.0 },
                None,
                [1.25, 0.5, -0.25, 0.75, 5.0, -3.0],
            ),
            (
                PointV1 { x: 0.0, y: 0.0 },
                Some((1.5, 1.5)),
                [1.875, 0.75, -0.375, 1.125, 4.0, -2.75],
            ),
            (
                PointV1 { x: 0.0, y: 0.0 },
                Some((2.0, 0.5)),
                [2.5, 1.0, -0.125, 0.375, 5.0, -1.25],
            ),
            (
                PointV1 { x: 2.0, y: -1.0 },
                Some((1.5, 1.5)),
                [1.875, 0.75, -0.375, 1.125, 6.0, -3.75],
            ),
        ] {
            let mut command = transform_command_for(&bundle, &root_id);
            command.delta = delta;
            command.scale = factors.map(|(x_factor, y_factor)| ScaleAboutPivot {
                pivot: PointV1 { x: 1.0, y: -0.5 },
                x_factor,
                y_factor,
            });
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            let result = session.transform_scene_entity(command.clone()).unwrap();
            let transformed = result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == root_id)
                .unwrap();

            assert_eq!(
                [
                    transformed.transform.m11,
                    transformed.transform.m12,
                    transformed.transform.m21,
                    transformed.transform.m22,
                    transformed.transform.tx,
                    transformed.transform.ty,
                ],
                expected
            );
            assert_eq!(transformed.provenance_id, command.provenance.id);
            assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
            assert_eq!(session.scene(), &result.scene);
            assert_eq!(session.retained_index_stats().build_count, 2);
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the command produces exact stored authoring values; one end-to-end assertion covers the atomic batch"
    )]
    fn creates_entities_after_applying_timeline_insertions_in_order() {
        let mut bundle = imported_bundle();
        let AnimationChannelV1::Opacity { id, .. } = &mut bundle.scene.animation_channels[0] else {
            panic!("imported fixture must contain an opacity channel");
        };
        *id = "studio-opacity-4".to_owned();
        let original_entities = bundle.scene.entities.clone();
        let original_assets = bundle.assets.clone();
        let command = create_command(&bundle);
        let first_scene_order = bundle
            .scene
            .entities
            .iter()
            .map(|entity| entity.scene_order)
            .max()
            .unwrap()
            + 1;
        let first_source_z = bundle
            .scene
            .entities
            .iter()
            .map(|entity| entity.source_z_index)
            .fold(-1.0_f64, f64::max)
            + 1.0;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.create_scene_entities(command.clone()).unwrap();

        assert_eq!(result.assets, original_assets);
        for (actual, original) in result.scene.entities[..original_entities.len()]
            .iter()
            .zip(&original_entities)
        {
            let mut expected = original.clone();
            expected.lifetimes = vec![IntervalV1 {
                end: 2.5,
                start: 0.0,
            }];
            assert_eq!(actual, &expected);
        }
        assert_eq!(result.scene.duration, 2.5);
        assert!(matches!(
            &result.scene.fidelity,
            FidelityV1::Approximate { evidence } if !evidence.is_empty()
        ));
        assert!(matches!(
            &result.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if keyframes[0].at == 0.0 && keyframes[1].at == 2.5
        ));
        let created = &result.scene.entities[original_entities.len()..];
        assert_eq!(created.len(), 3);
        assert_eq!(
            created[0].lifetimes,
            vec![command.entities[0].lifetime.clone()]
        );
        assert!(matches!(
            created[0].geometry,
            SceneGeometryV1::Circle { radius: 0.75, .. }
        ));
        assert!(matches!(
            created[1].geometry,
            SceneGeometryV1::Rectangle {
                height: 2.0,
                width: 3.0,
                corner_radius: 0.0,
                ..
            }
        ));
        assert!(matches!(
            created[2].geometry,
            SceneGeometryV1::CubicPath { .. }
        ));
        for (entity, (expected_order, expected_z)) in created.iter().zip([
            (first_scene_order, first_source_z),
            (first_scene_order + 1, first_source_z + 1.0),
            (first_scene_order + 2, first_source_z + 2.0),
        ]) {
            assert_eq!(entity.parent_id, None);
            assert_eq!(entity.provenance_id, command.provenance.id);
            assert_eq!(entity.scene_order, expected_order);
            assert_eq!(entity.source_z_index, expected_z);
        }
        assert_eq!(created[0].transform.m11, 1.25);
        assert_eq!(created[0].transform.tx, 2.0);
        assert_eq!(created[0].transform.ty, -1.0);
        assert!(matches!(
            created[0].appearance,
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            }
        ));
        assert!(matches!(
            created[2].appearance,
            SceneAppearanceV1::Vector {
                fill: Some(_),
                stroke: None,
                ..
            }
        ));
        assert!(
            result
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::Opacity {
                        entity_id,
                        id,
                        keyframes,
                        provenance_id,
                        ..
                    } if entity_id == "tx:create/entity:rectangle"
                        && id == "studio-opacity-4-1"
                        && keyframes[0].at == 0.5
                        && keyframes[0].value == 0.0
                        && keyframes[1].at == 0.9
                        && keyframes[1].value == 1.0
                        && provenance_id == "studio-create"
                ))
        );
        assert!(
            result
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::AffineTransform {
                        entity_id,
                        keyframes,
                        ..
                    } if entity_id == "tx:create/entity:rectangle"
                        && keyframes[0].at == 1.25
                        && keyframes[0].value.tx == -1.0
                        && keyframes[0].value.m11 == 0.75
                        && keyframes[0].value.m22 == 1.0
                        && keyframes[1].at == 2.5
                        && keyframes[1].value == keyframes[0].value
                ))
        );
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::CubicPathGeometry)
        );
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::OpacityAnimation)
        );
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::AffineTransformAnimation)
        );
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: NEXT_REVISION.to_owned(),
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);

        let sample_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "instant-transform-sample",
                    sample_time: time,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            let draw = packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == "tx:create/entity:rectangle")
                .unwrap();
            match draw {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("created rectangle must remain a path draw"),
            }
        };
        let before = sample_transform(1.249_999);
        assert_eq!(
            (before.m11, before.m22, before.tx, before.ty),
            (0.5, 0.5, -2.0, 1.0)
        );
        let at = sample_transform(1.25);
        assert_eq!((at.m11, at.m22, at.tx, at.ty), (0.75, 1.0, -1.0, 0.5));
        assert_eq!(sample_transform(2.0), at);
    }

    #[test]
    fn invalid_timeline_insertion_preserves_the_retained_scene() {
        let bundle = imported_bundle();
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut command = create_command(&bundle);
        command.timeline_insertions[0].duration = f64::INFINITY;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.create_scene_entities(command),
            Err(CreateSceneEntitiesError::InvalidTimelineInsertion)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    fn invalid_instant_transform_preserves_the_retained_scene() {
        let bundle = imported_bundle();
        let expected_scene = bundle.scene.clone();
        let mut command = create_command(&bundle);
        let lifetime_start = command.entities[1].lifetime.start;
        command.entities[1].instant_transform.as_mut().unwrap().at = lifetime_start;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.create_scene_entities(command),
            Err(CreateSceneEntitiesError::InvalidInstantTransform)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    fn atomic_transform_updates_one_authorized_nested_entity_only() {
        let bundle = fixture_bundle("real-line-joints-v10.json");
        let target = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_some())
            .unwrap()
            .clone();
        let mut command = transform_command_for(&bundle, &target.id);
        command.scale = None;
        let mut expected = target.clone();
        expected.transform.tx += command.delta.x;
        expected.transform.ty += command.delta.y;
        expected.provenance_id.clone_from(&command.provenance.id);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        let result = session.transform_scene_entity(command).unwrap();

        for (actual, before) in result.scene.entities.iter().zip(&bundle.scene.entities) {
            assert_eq!(
                actual,
                if actual.id == target.id {
                    &expected
                } else {
                    before
                }
            );
        }
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
    fn rejected_atomic_transforms_preserve_the_retained_scene() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        let command = transform_command_for(&bundle, &root_id);

        let mut stale = command.clone();
        stale.expected_base_revision = "f".repeat(64);
        assert!(matches!(
            rejected_transform(bundle.clone(), stale),
            TransformSceneEntityError::StaleBaseRevision
        ));

        let mut no_op = command.clone();
        no_op.delta = PointV1 { x: 0.0, y: 0.0 };
        no_op.scale = None;
        assert!(matches!(
            rejected_transform(bundle.clone(), no_op),
            TransformSceneEntityError::NoOp
        ));

        let mut invalid_delta = command.clone();
        invalid_delta.delta.x = f64::NAN;
        assert!(matches!(
            rejected_transform(bundle.clone(), invalid_delta),
            TransformSceneEntityError::InvalidDelta
        ));

        let mut identity_scale = command.clone();
        let identity = identity_scale.scale.as_mut().unwrap();
        identity.x_factor = 1.0;
        identity.y_factor = 1.0;
        assert!(matches!(
            rejected_transform(bundle.clone(), identity_scale),
            TransformSceneEntityError::InvalidFactor
        ));

        let child_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.as_deref() == Some(root_id.as_str()))
            .unwrap()
            .id
            .clone();
        let ancestor_transformed = transform_command_for(&bundle, &child_id);
        assert!(matches!(
            rejected_transform(bundle, ancestor_transformed),
            TransformSceneEntityError::TransformedAncestorUnsupported(id) if id == root_id
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let animated = fixture_bundle(fixture);
            let command = transform_command_for(&animated, entity_id);
            assert!(matches!(
                rejected_transform(animated, command),
                TransformSceneEntityError::AnimatedTransformUnsupported(id) if id == entity_id
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
