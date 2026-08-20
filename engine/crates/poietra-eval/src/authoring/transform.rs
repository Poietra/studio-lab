use std::collections::BTreeSet;

use poietra_geometry::rotate_affine_transform_v1;
use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, CubicPathV1, EasingV1, KeyframeV1, PointV1,
    ProvenanceOriginV1, ProvenanceRecordV1, SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneSourceV1,
};

use crate::{EngineSessionV1, EvaluationError};

use super::{close_transform_baseline_value, unused_channel_id};

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

/// One optional positive axis scale within an atomic world-space transform.
#[derive(Clone, Debug, PartialEq)]
pub struct ScaleAboutPivot {
    pub pivot: PointV1,
    pub x_factor: f64,
    pub y_factor: f64,
}

/// Positive axis factors requested by a Studio transform.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneEntityAxisFactors {
    pub x_factor: f64,
    pub y_factor: f64,
}

/// Studio semantic baseline that must still match the installed Scene geometry.
#[derive(Clone, Debug, PartialEq)]
pub enum TransformSceneEntityExpectedBaseline {
    CurrentCenter,
    CurrentUniformAffine,
    WorldSize {
        height: f64,
        width: f64,
        world_center: PointV1,
    },
}

/// One profile-free transform intent resolved by the canonical Scene core.
#[derive(Clone, Debug, PartialEq)]
pub enum TransformSceneEntityIntent {
    Relative {
        delta: PointV1,
        scale: Option<ScaleAboutPivot>,
    },
    FromBaseline {
        expected_baseline: TransformSceneEntityExpectedBaseline,
        scale: Option<SceneEntityAxisFactors>,
        target_center: Option<PointV1>,
    },
}

/// One profile-free Studio command that atomically transforms an authorized entity.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSceneEntityCommand {
    pub entity_id: String,
    pub expected_base_revision: String,
    pub intent: TransformSceneEntityIntent,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio transform that becomes active at an exact Scene time.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSceneEntityAtTimeCommand {
    pub at: f64,
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
    #[error(
        "axis scale factors must be finite and positive; relative factors must not both be identity"
    )]
    InvalidFactor,
    #[error("the optional world-space scale pivot must be finite")]
    InvalidPivot,
    #[error("the transform must contain a non-zero translation or an axis scale")]
    NoOp,
    #[error("the timed transform anchor must be finite, non-negative, and before Scene end")]
    InvalidAnchor,
    #[error("the timed transform scale must be uniform")]
    NonUniformFactor,
    #[error("the transform target does not exist: {0}")]
    TargetMissing(String),
    #[error("this world-space transform requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the timed transform target is not active at its anchor: {0}")]
    TargetInactive(String),
    #[error("world-space transform does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("world-space transform requires identity, transform-static ancestors: {0}")]
    TransformedAncestorUnsupported(String),
    #[error("the transform target geometry has no supported local bounds")]
    BaselineUnavailable,
    #[error("the expected transform baseline is invalid or does not match the installed Scene")]
    BaselineMismatch,
    #[error("the target center must be finite")]
    InvalidTargetCenter,
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

pub(super) fn rotation_is_noop(angle_radians: f64) -> bool {
    let normalized = angle_radians.sin().atan2(angle_radians.cos());
    normalized.abs() <= ROTATION_NOOP_EPSILON
}

pub(super) fn apply_world_translation(
    transform: &mut poietra_scene_ir::AffineTransformV1,
    delta: &PointV1,
) {
    transform.tx += delta.x;
    transform.ty += delta.y;
}

pub(super) fn apply_world_axis_scale(
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

pub(super) fn apply_world_rotation(
    transform: &mut poietra_scene_ir::AffineTransformV1,
    angle_radians: f64,
    pivot: &PointV1,
) {
    *transform = rotate_affine_transform_v1(transform, angle_radians, pivot);
}

#[allow(
    clippy::float_cmp,
    reason = "exact stored paint alpha determines whether the canonical static mutation changed state"
)]
pub(super) fn set_vector_paint_alpha(
    appearance: &mut SceneAppearanceV1,
    alpha: f64,
) -> Option<bool> {
    let SceneAppearanceV1::Vector { fill, stroke, .. } = appearance else {
        return None;
    };
    if fill.is_none() && stroke.is_none() {
        return None;
    }
    let changed = fill
        .as_ref()
        .is_some_and(|paint| paint.color.alpha != alpha)
        || stroke
            .as_ref()
            .is_some_and(|paint| paint.color.alpha != alpha);
    if let Some(fill) = fill {
        fill.color.alpha = alpha;
    }
    if let Some(stroke) = stroke {
        stroke.color.alpha = alpha;
    }
    Some(changed)
}

pub(super) fn has_animated_transform(scene: &poietra_scene_ir::SceneIrV1, entity_id: &str) -> bool {
    scene.animation_channels.iter().any(|channel| {
        matches!(
            channel,
            AnimationChannelV1::AffineTransform { entity_id: animated_id, .. }
                | AnimationChannelV1::Rotation { entity_id: animated_id, .. }
                | AnimationChannelV1::MotionPath { entity_id: animated_id, .. }
                if animated_id == entity_id
        )
    })
}

#[derive(Clone, Copy)]
pub(super) struct SceneEntityLocalBounds {
    pub(super) bottom: f64,
    pub(super) left: f64,
    pub(super) right: f64,
    pub(super) top: f64,
}

fn cubic_path_local_bounds(path: &CubicPathV1) -> Option<SceneEntityLocalBounds> {
    let first = path.subpaths.first()?;
    let mut bounds = SceneEntityLocalBounds {
        bottom: first.start.y,
        left: first.start.x,
        right: first.start.x,
        top: first.start.y,
    };
    for subpath in &path.subpaths {
        for point in std::iter::once(&subpath.start).chain(
            subpath
                .segments
                .iter()
                .flat_map(|segment| [&segment.control1, &segment.control2, &segment.end]),
        ) {
            bounds.bottom = bounds.bottom.min(point.y);
            bounds.left = bounds.left.min(point.x);
            bounds.right = bounds.right.max(point.x);
            bounds.top = bounds.top.max(point.y);
        }
    }
    Some(bounds)
}

pub(super) fn scene_entity_local_bounds(entity: &SceneEntityV1) -> Option<SceneEntityLocalBounds> {
    match &entity.geometry {
        SceneGeometryV1::Circle { center, radius } => Some(SceneEntityLocalBounds {
            bottom: center.y - radius,
            left: center.x - radius,
            right: center.x + radius,
            top: center.y + radius,
        }),
        SceneGeometryV1::Rectangle {
            center,
            height,
            width,
            ..
        } => Some(SceneEntityLocalBounds {
            bottom: center.y - height / 2.0,
            left: center.x - width / 2.0,
            right: center.x + width / 2.0,
            top: center.y + height / 2.0,
        }),
        SceneGeometryV1::Image { local_rect, .. } => Some(SceneEntityLocalBounds {
            bottom: local_rect.bottom,
            left: local_rect.left,
            right: local_rect.right,
            top: local_rect.top,
        }),
        SceneGeometryV1::CubicPath { path } => cubic_path_local_bounds(path),
        SceneGeometryV1::Group {} | SceneGeometryV1::Line { .. } => None,
    }
}

pub(super) fn fit_cubic_path_to_local_height_and_center(
    path: &CubicPathV1,
    source_bounds: &SceneEntityLocalBounds,
) -> Option<CubicPathV1> {
    let outline_bounds = cubic_path_local_bounds(path)?;
    let source_height = source_bounds.top - source_bounds.bottom;
    let outline_height = outline_bounds.top - outline_bounds.bottom;
    if !source_height.is_finite()
        || !outline_height.is_finite()
        || source_height <= 0.0
        || outline_height <= 0.0
    {
        return None;
    }
    let scale = source_height / outline_height;
    let source_center = PointV1 {
        x: source_bounds.left.midpoint(source_bounds.right),
        y: source_bounds.bottom.midpoint(source_bounds.top),
    };
    let outline_center = PointV1 {
        x: outline_bounds.left.midpoint(outline_bounds.right),
        y: outline_bounds.bottom.midpoint(outline_bounds.top),
    };
    if !scale.is_finite()
        || !source_center.x.is_finite()
        || !source_center.y.is_finite()
        || !outline_center.x.is_finite()
        || !outline_center.y.is_finite()
    {
        return None;
    }
    let transform = |point: &mut PointV1| {
        point.x = source_center.x + (point.x - outline_center.x) * scale;
        point.y = source_center.y + (point.y - outline_center.y) * scale;
    };
    let mut fitted = path.clone();
    for subpath in &mut fitted.subpaths {
        transform(&mut subpath.start);
        for segment in &mut subpath.segments {
            transform(&mut segment.control1);
            transform(&mut segment.control2);
            transform(&mut segment.end);
        }
    }
    Some(fitted)
}

fn transform_is_uniform(left: f64, right: f64) -> bool {
    (left - right).abs() <= f64::EPSILON * left.abs().max(right.abs()).max(1.0) * 32.0
}

pub(super) fn scene_entity_world_center(
    entity: &SceneEntityV1,
    bounds: &SceneEntityLocalBounds,
) -> PointV1 {
    let local_x = bounds.left.midpoint(bounds.right);
    let local_y = bounds.bottom.midpoint(bounds.top);
    PointV1 {
        x: entity.transform.m11 * local_x + entity.transform.m12 * local_y + entity.transform.tx,
        y: entity.transform.m21 * local_x + entity.transform.m22 * local_y + entity.transform.ty,
    }
}

fn positive_axis_aligned_transform(entity: &SceneEntityV1) -> bool {
    entity.transform.m11 > 0.0
        && entity.transform.m12 == 0.0
        && entity.transform.m21 == 0.0
        && entity.transform.m22 > 0.0
}

fn transform_baseline_matches(
    entity: &SceneEntityV1,
    expected: &TransformSceneEntityExpectedBaseline,
    bounds: &SceneEntityLocalBounds,
    actual_center: &PointV1,
) -> bool {
    if matches!(
        expected,
        TransformSceneEntityExpectedBaseline::CurrentCenter
    ) {
        return true;
    }
    if matches!(
        expected,
        TransformSceneEntityExpectedBaseline::CurrentUniformAffine
    ) {
        return positive_axis_aligned_transform(entity)
            && transform_is_uniform(entity.transform.m11, entity.transform.m22);
    }
    let expected_center = match expected {
        TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. } => world_center,
        TransformSceneEntityExpectedBaseline::CurrentCenter
        | TransformSceneEntityExpectedBaseline::CurrentUniformAffine => unreachable!(),
    };
    if !expected_center.x.is_finite()
        || !expected_center.y.is_finite()
        || !close_transform_baseline_value(expected_center.x, actual_center.x)
        || !close_transform_baseline_value(expected_center.y, actual_center.y)
    {
        return false;
    }
    match expected {
        TransformSceneEntityExpectedBaseline::CurrentCenter
        | TransformSceneEntityExpectedBaseline::CurrentUniformAffine => unreachable!(),
        TransformSceneEntityExpectedBaseline::WorldSize { height, width, .. } => {
            width.is_finite()
                && height.is_finite()
                && *width > 0.0
                && *height > 0.0
                && matches!(
                    &entity.geometry,
                    SceneGeometryV1::Circle { .. }
                        | SceneGeometryV1::Rectangle { .. }
                        | SceneGeometryV1::CubicPath { .. }
                )
                && positive_axis_aligned_transform(entity)
                && close_transform_baseline_value(
                    *width,
                    (bounds.right - bounds.left) * entity.transform.m11,
                )
                && close_transform_baseline_value(
                    *height,
                    (bounds.top - bounds.bottom) * entity.transform.m22,
                )
        }
    }
}

#[allow(
    clippy::float_cmp,
    reason = "exact identity defines whether a transform intent contributes an effect"
)]
pub(super) fn resolve_transform_intent(
    target: &SceneEntityV1,
    intent: TransformSceneEntityIntent,
) -> Result<(PointV1, Option<ScaleAboutPivot>), TransformSceneEntityError> {
    match intent {
        TransformSceneEntityIntent::Relative { delta, scale } => {
            if !delta.x.is_finite() || !delta.y.is_finite() {
                return Err(TransformSceneEntityError::InvalidDelta);
            }
            if let Some(scale) = &scale {
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
            } else if delta.x == 0.0 && delta.y == 0.0 {
                return Err(TransformSceneEntityError::NoOp);
            }
            Ok((delta, scale))
        }
        TransformSceneEntityIntent::FromBaseline {
            expected_baseline,
            scale,
            target_center,
        } => {
            if target_center
                .as_ref()
                .is_some_and(|center| !center.x.is_finite() || !center.y.is_finite())
            {
                return Err(TransformSceneEntityError::InvalidTargetCenter);
            }
            if scale.as_ref().is_some_and(|scale| {
                !scale.x_factor.is_finite()
                    || scale.x_factor <= 0.0
                    || !scale.y_factor.is_finite()
                    || scale.y_factor <= 0.0
            }) {
                return Err(TransformSceneEntityError::InvalidFactor);
            }
            if target.parent_id.is_some() {
                return Err(TransformSceneEntityError::TargetIsNotRoot(
                    target.id.clone(),
                ));
            }
            let bounds = scene_entity_local_bounds(target)
                .ok_or(TransformSceneEntityError::BaselineUnavailable)?;
            let actual_center = scene_entity_world_center(target, &bounds);
            if !transform_baseline_matches(target, &expected_baseline, &bounds, &actual_center) {
                return Err(TransformSceneEntityError::BaselineMismatch);
            }
            let delta =
                target_center
                    .as_ref()
                    .map_or(PointV1 { x: 0.0, y: 0.0 }, |target_center| PointV1 {
                        x: target_center.x - actual_center.x,
                        y: target_center.y - actual_center.y,
                    });
            let scale = scale.and_then(|scale| {
                (scale.x_factor != 1.0 || scale.y_factor != 1.0).then_some(ScaleAboutPivot {
                    pivot: actual_center,
                    x_factor: scale.x_factor,
                    y_factor: scale.y_factor,
                })
            });
            if scale.is_none() && delta.x == 0.0 && delta.y == 0.0 {
                return Err(TransformSceneEntityError::NoOp);
            }
            Ok((delta, scale))
        }
    }
}

#[allow(
    clippy::float_cmp,
    reason = "exact equality defines uniform and identity scale in the authoring command"
)]
fn validate_timed_transform_command(
    scene: &poietra_scene_ir::SceneIrV1,
    command: &TransformSceneEntityAtTimeCommand,
) -> Result<(), TransformSceneEntityError> {
    if scene.source.revision_hash() != command.expected_base_revision {
        return Err(TransformSceneEntityError::StaleBaseRevision);
    }
    if command.next_revision == command.expected_base_revision {
        return Err(TransformSceneEntityError::RevisionDidNotAdvance);
    }
    if !command.at.is_finite() || command.at < 0.0 || command.at >= scene.duration {
        return Err(TransformSceneEntityError::InvalidAnchor);
    }
    if !command.delta.x.is_finite() || !command.delta.y.is_finite() {
        return Err(TransformSceneEntityError::InvalidDelta);
    }
    if let Some(scale) = &command.scale {
        if !scale.x_factor.is_finite()
            || scale.x_factor <= 0.0
            || !scale.y_factor.is_finite()
            || scale.y_factor <= 0.0
            || scale.x_factor == 1.0
        {
            return Err(TransformSceneEntityError::InvalidFactor);
        }
        if scale.x_factor != scale.y_factor {
            return Err(TransformSceneEntityError::NonUniformFactor);
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
    if scene
        .provenance
        .iter()
        .any(|record| record.id == command.provenance.id)
    {
        return Err(TransformSceneEntityError::ProvenanceConflict(
            command.provenance.id.clone(),
        ));
    }
    Ok(())
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
    pub(super) fn rotate_scene_entity(
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

        apply_world_rotation(&mut target.transform, command.angle_radians, &command.pivot);
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

    /// Atomically resolves and applies one world-space transform intent to one entity.
    ///
    /// Relative transforms use their explicit pivot. Baseline transforms first verify the
    /// installed static root geometry, derive its world center, and use that center as the scale
    /// pivot. Both intents then share one mutation and whole-bundle validation path.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        reason = "exact identity defines whether the optional scale is a valid command"
    )]
    pub(super) fn transform_scene_entity(
        &mut self,
        command: TransformSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, TransformSceneEntityError> {
        let TransformSceneEntityCommand {
            entity_id,
            expected_base_revision,
            intent,
            next_revision,
            provenance,
        } = command;
        if self.scene().source.revision_hash() != expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision);
        }
        if next_revision == expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance);
        }
        if provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(TransformSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == provenance.id)
        {
            return Err(TransformSceneEntityError::ProvenanceConflict(provenance.id));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if has_animated_transform(&candidate.scene, &entity_id) {
            return Err(TransformSceneEntityError::AnimatedTransformUnsupported(
                entity_id,
            ));
        }
        let target_index = candidate
            .scene
            .entities
            .iter()
            .position(|entity| entity.id == entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(entity_id.clone()))?;

        let (delta, scale) =
            resolve_transform_intent(&candidate.scene.entities[target_index], intent)?;

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
        if let Some(scale) = &scale {
            apply_world_axis_scale(
                &mut target.transform,
                scale.x_factor,
                scale.y_factor,
                &scale.pivot,
            );
        }
        apply_world_translation(&mut target.transform, &delta);
        target.provenance_id.clone_from(&provenance.id);
        candidate.scene.provenance.push(provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically applies a root transform from one exact Scene time onward.
    ///
    /// The target's static transform and every existing animation channel remain unchanged. A
    /// new affine channel uses the static transform before `at` and the transformed value from
    /// `at` onward. Uniform scale is applied about its world-space pivot before translation.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    pub(super) fn transform_scene_entity_at_time(
        &mut self,
        command: TransformSceneEntityAtTimeCommand,
    ) -> Result<SceneIrBundleV1, TransformSceneEntityError> {
        validate_timed_transform_command(self.scene(), &command)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let target = candidate
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(TransformSceneEntityError::TargetIsNotRoot(
                command.entity_id,
            ));
        }
        if !target
            .lifetimes
            .iter()
            .any(|lifetime| command.at >= lifetime.start && command.at < lifetime.end)
        {
            return Err(TransformSceneEntityError::TargetInactive(command.entity_id));
        }
        if has_animated_transform(&candidate.scene, &command.entity_id) {
            return Err(TransformSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }

        let mut transformed = target.transform.clone();
        if let Some(scale) = &command.scale {
            apply_world_axis_scale(
                &mut transformed,
                scale.x_factor,
                scale.y_factor,
                &scale.pivot,
            );
        }
        apply_world_translation(&mut transformed, &command.delta);
        let channel_id = unused_channel_id(&candidate.scene, "studio-transform-at-time");
        candidate
            .scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: command.entity_id,
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: command.at,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: transformed.clone(),
                    },
                    KeyframeV1 {
                        at: candidate.scene.duration,
                        easing_to_next: None,
                        value: transformed,
                    },
                ],
                provenance_id: command.provenance.id.clone(),
            });
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
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
    pub(super) fn set_subtree_vector_paint_alpha(
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
                    appearance,
                ) => {
                    let changed =
                        set_vector_paint_alpha(appearance, command.alpha).ok_or_else(|| {
                            SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                                entity.id.clone(),
                            )
                        })?;
                    if changed {
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
    use poietra_scene_ir::AffineTransformV1;

    use super::super::tests::{BASE_REVISION, NEXT_REVISION, fixture_bundle, imported_bundle};
    use super::*;

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
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            intent: TransformSceneEntityIntent::Relative {
                delta: PointV1 { x: 2.0, y: -1.0 },
                scale: Some(ScaleAboutPivot {
                    pivot: PointV1 { x: 1.0, y: -0.5 },
                    x_factor: 1.5,
                    y_factor: 1.5,
                }),
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio atomic transform".to_owned()],
                id: "studio-atomic-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn baseline_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        TransformSceneEntityCommand {
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            intent: TransformSceneEntityIntent::FromBaseline {
                expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize {
                    height: 1.0,
                    width: 1.0,
                    world_center: PointV1 { x: 4.0, y: -2.0 },
                },
                scale: Some(SceneEntityAxisFactors {
                    x_factor: 1.5,
                    y_factor: 1.5,
                }),
                target_center: Some(PointV1 { x: 6.0, y: -3.0 }),
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["verified Studio transform baseline".to_owned()],
                id: "studio-baseline-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn current_uniform_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        let mut command = baseline_transform_command_for(bundle, entity_id);
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline, ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *expected_baseline = TransformSceneEntityExpectedBaseline::CurrentUniformAffine;
        command
    }

    fn timed_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityAtTimeCommand {
        TransformSceneEntityAtTimeCommand {
            at: 1.0,
            delta: PointV1 { x: 2.0, y: -1.0 },
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio endpoint transform".to_owned()],
                id: "studio-endpoint-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            scale: Some(ScaleAboutPivot {
                pivot: PointV1 { x: 1.0, y: -0.5 },
                x_factor: 1.5,
                y_factor: 1.5,
            }),
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

    fn rejected_timed_transform(
        bundle: SceneIrBundleV1,
        command: TransformSceneEntityAtTimeCommand,
    ) -> TransformSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.transform_scene_entity_at_time(command).unwrap_err();
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
            command.intent = TransformSceneEntityIntent::Relative {
                delta,
                scale: factors.map(|(x_factor, y_factor)| ScaleAboutPivot {
                    pivot: PointV1 { x: 1.0, y: -0.5 },
                    x_factor,
                    y_factor,
                }),
            };
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
        reason = "the command applies exact finite factors around its derived center"
    )]
    fn baseline_transform_verifies_world_size_and_uses_the_derived_center() {
        let bundle = imported_bundle();
        let target_id = "later";
        let command = baseline_transform_command_for(&bundle, target_id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command.clone()).unwrap();
        let target = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == target_id)
            .unwrap();

        assert_eq!(target.transform.m11, 1.5);
        assert_eq!(target.transform.m22, 1.5);
        assert_eq!(target.transform.tx, 4.5);
        assert_eq!(target.transform.ty, -3.0);
        assert_eq!(target.provenance_id, command.provenance.id);
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "scale-only authoring must retain the exact installed translation"
    )]
    fn scale_only_transform_uses_actual_center_when_expected_center_is_within_tolerance() {
        let mut bundle = imported_bundle();
        let target = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        let SceneGeometryV1::Circle { center, .. } = &mut target.geometry else {
            panic!("fixture target must be a Circle");
        };
        *center = PointV1 { x: 0.0, y: 0.0 };
        let mut command = baseline_transform_command_for(&bundle, "later");
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. },
            target_center,
            ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *target_center = None;
        *world_center = PointV1 {
            x: 3.0 + 1.0e-10,
            y: -2.0,
        };
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(transformed.transform.m11, 1.5);
        assert_eq!(transformed.transform.m22, 1.5);
        assert_eq!(transformed.transform.tx, 3.0);
        assert_eq!(transformed.transform.ty, -2.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the current center produces one exact world-space translation"
    )]
    fn current_center_baseline_transforms_an_image_from_its_installed_geometry_center() {
        let mut bundle = fixture_bundle("png-alpha-edge-camera.json");
        bundle.scene.animation_channels.clear();
        bundle.scene.required_capabilities.retain(|capability| {
            !matches!(
                capability,
                SceneCapabilityV1::AffineTransformAnimation | SceneCapabilityV1::CameraAnimation
            )
        });
        let target_id = bundle.scene.entities[0].id.clone();
        let mut command = baseline_transform_command_for(&bundle, &target_id);
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline, ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *expected_baseline = TransformSceneEntityExpectedBaseline::CurrentCenter;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == target_id)
            .unwrap();

        assert!(matches!(
            transformed.geometry,
            SceneGeometryV1::Image { .. }
        ));
        assert_eq!(transformed.transform.m11, 3.0);
        assert_eq!(transformed.transform.m22, 3.0);
        assert_eq!(transformed.transform.tx, 6.0);
        assert_eq!(transformed.transform.ty, -3.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the current baseline applies exact finite factors around its derived center"
    )]
    fn current_uniform_baseline_derives_the_transform_and_rejects_non_uniform_affines() {
        let bundle = imported_bundle();
        let command = current_uniform_transform_command_for(&bundle, "later");
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(transformed.transform.m11, 1.5);
        assert_eq!(transformed.transform.m22, 1.5);
        assert_eq!(transformed.transform.tx, 4.5);
        assert_eq!(transformed.transform.ty, -3.0);

        for [m11, m12, m21, m22] in [
            [0.0, -1.0, 1.0, 0.0],
            [1.0, 0.25, 0.0, 1.0],
            [1.0, 0.0, 0.0, 1.25],
            [-1.0, 0.0, 0.0, -1.0],
        ] {
            let mut bundle = imported_bundle();
            bundle
                .scene
                .entities
                .iter_mut()
                .find(|entity| entity.id == "later")
                .unwrap()
                .transform = AffineTransformV1 {
                m11,
                m12,
                m21,
                m22,
                tx: 3.0,
                ty: -2.0,
            };
            let expected = bundle.scene.clone();
            let command = current_uniform_transform_command_for(&bundle, "later");
            let mut session = EngineSessionV1::new(bundle).unwrap();
            assert!(matches!(
                session.transform_scene_entity(command),
                Err(TransformSceneEntityError::BaselineMismatch)
            ));
            assert_eq!(session.scene(), &expected);
        }
    }

    #[test]
    fn baseline_transform_supports_image_centers_and_world_sizes() {
        let mut rectangle = imported_bundle().scene.entities[0].clone();
        rectangle.geometry = SceneGeometryV1::Rectangle {
            center: PointV1 { x: 1.0, y: 2.0 },
            corner_radius: 0.0,
            height: 4.0,
            width: 6.0,
        };
        rectangle.transform = AffineTransformV1 {
            m11: 2.0,
            m12: 0.0,
            m21: 0.0,
            m22: 3.0,
            tx: -1.0,
            ty: 1.0,
        };
        let rectangle_bounds = scene_entity_local_bounds(&rectangle).unwrap();
        let rectangle_center = scene_entity_world_center(&rectangle, &rectangle_bounds);
        assert!(transform_baseline_matches(
            &rectangle,
            &TransformSceneEntityExpectedBaseline::WorldSize {
                height: 12.0,
                width: 12.0,
                world_center: rectangle_center.clone(),
            },
            &rectangle_bounds,
            &rectangle_center,
        ));

        let image_bundle = fixture_bundle("png-alpha-edge-camera.json");
        let image = &image_bundle.scene.entities[0];
        let image_bounds = scene_entity_local_bounds(image).unwrap();
        let image_center = scene_entity_world_center(image, &image_bounds);
        assert!(transform_baseline_matches(
            image,
            &TransformSceneEntityExpectedBaseline::CurrentCenter,
            &image_bounds,
            &image_center,
        ));

        assert!(!transform_is_uniform(1.5, 1.5 + 1.0e-10));

        let mut drifted = baseline_transform_command_for(&imported_bundle(), "later");
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. },
            ..
        } = &mut drifted.intent
        else {
            unreachable!();
        };
        world_center.x += 0.01;
        let bundle = imported_bundle();
        let expected = bundle.scene.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        assert!(matches!(
            session.transform_scene_entity(drifted),
            Err(TransformSceneEntityError::BaselineMismatch)
        ));
        assert_eq!(session.scene(), &expected);
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
        let TransformSceneEntityIntent::Relative { delta, scale } = &mut command.intent else {
            unreachable!();
        };
        *scale = None;
        let mut expected = target.clone();
        expected.transform.tx += delta.x;
        expected.transform.ty += delta.y;
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
    #[allow(
        clippy::float_cmp,
        reason = "the endpoint command stores and samples exact affine values"
    )]
    fn timed_root_transform_is_inactive_before_its_anchor_and_preserves_existing_channels() {
        let bundle = imported_bundle();
        let original_channels = bundle.scene.animation_channels.clone();
        let original_target = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .clone();
        let command = timed_transform_command_for(&bundle, &original_target.id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .transform_scene_entity_at_time(command.clone())
            .unwrap();

        assert_eq!(
            &result.scene.animation_channels[..original_channels.len()],
            original_channels
        );
        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == original_target.id)
                .unwrap(),
            &original_target
        );
        assert!(matches!(
            result.scene.animation_channels.last(),
            Some(AnimationChannelV1::AffineTransform {
                entity_id,
                keyframes,
                provenance_id,
                ..
            }) if entity_id == "later"
                && provenance_id == &command.provenance.id
                && keyframes[0].at == 1.0
                && keyframes[0].value.m11 == 1.5
                && keyframes[0].value.m22 == 1.5
                && keyframes[0].value.tx == 6.0
                && keyframes[0].value.ty == -3.75
                && keyframes[1].at == 2.0
                && keyframes[1].value == keyframes[0].value
        ));
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::AffineTransformAnimation)
        );

        let sample_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "timed-transform-sample",
                    sample_time: time,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            match packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("the endpoint target must remain a path draw"),
            }
        };
        let before = sample_transform(0.999_999);
        assert_eq!(
            (before.m11, before.m22, before.tx, before.ty),
            (1.0, 1.0, 3.0, -2.0)
        );
        let at = sample_transform(1.0);
        assert_eq!((at.m11, at.m22, at.tx, at.ty), (1.5, 1.5, 6.0, -3.75));
        assert_eq!(sample_transform(1.5), at);
    }

    #[test]
    fn invalid_or_ambiguous_timed_transforms_preserve_the_retained_scene() {
        let bundle = imported_bundle();
        let mut non_uniform = timed_transform_command_for(&bundle, "later");
        non_uniform.scale.as_mut().unwrap().y_factor = 1.25;
        assert!(matches!(
            rejected_timed_transform(bundle.clone(), non_uniform),
            TransformSceneEntityError::NonUniformFactor
        ));

        let mut at_scene_end = timed_transform_command_for(&bundle, "later");
        at_scene_end.at = bundle.scene.duration;
        assert!(matches!(
            rejected_timed_transform(bundle.clone(), at_scene_end),
            TransformSceneEntityError::InvalidAnchor
        ));

        let mut animated = bundle.clone();
        animated
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::AffineTransformAnimation);
        animated.scene.required_capabilities.sort_unstable();
        let target_transform = animated
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .transform
            .clone();
        animated
            .scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: "later".to_owned(),
                id: "existing-root-transform".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.25,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: target_transform.clone(),
                    },
                    KeyframeV1 {
                        at: 0.75,
                        easing_to_next: None,
                        value: target_transform,
                    },
                ],
                provenance_id: animated.scene.provenance[0].id.clone(),
            });
        let animated_command = timed_transform_command_for(&animated, "later");
        assert!(matches!(
            rejected_timed_transform(animated, animated_command),
            TransformSceneEntityError::AnimatedTransformUnsupported(id) if id == "later"
        ));

        let nested = fixture_bundle("real-line-joints-v10.json");
        let child_id = nested
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_some())
            .unwrap()
            .id
            .clone();
        let mut nested_command = timed_transform_command_for(&nested, &child_id);
        nested_command.at = 0.5;
        assert!(matches!(
            rejected_timed_transform(nested, nested_command),
            TransformSceneEntityError::TargetIsNotRoot(id) if id == child_id
        ));
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
        no_op.intent = TransformSceneEntityIntent::Relative {
            delta: PointV1 { x: 0.0, y: 0.0 },
            scale: None,
        };
        assert!(matches!(
            rejected_transform(bundle.clone(), no_op),
            TransformSceneEntityError::NoOp
        ));

        let mut invalid_delta = command.clone();
        let TransformSceneEntityIntent::Relative { delta, .. } = &mut invalid_delta.intent else {
            unreachable!();
        };
        delta.x = f64::NAN;
        assert!(matches!(
            rejected_transform(bundle.clone(), invalid_delta),
            TransformSceneEntityError::InvalidDelta
        ));

        let mut identity_scale = command.clone();
        let TransformSceneEntityIntent::Relative { scale, .. } = &mut identity_scale.intent else {
            unreachable!();
        };
        let identity = scale.as_mut().unwrap();
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

        let mut bundle = imported_bundle();
        let entity_id = "later";
        let provenance_id = bundle.scene.provenance[0].id.clone();
        bundle
            .scene
            .animation_channels
            .push(AnimationChannelV1::Rotation {
                entity_id: entity_id.to_owned(),
                id: "rotation-track".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.5,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: 0.0,
                    },
                    KeyframeV1 {
                        at: 1.0,
                        easing_to_next: None,
                        value: std::f64::consts::FRAC_PI_2,
                    },
                ],
                pivot: PointV1 { x: 3.0, y: -2.0 },
                provenance_id,
            });
        if !bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::AffineTransformAnimation)
        {
            bundle
                .scene
                .required_capabilities
                .push(SceneCapabilityV1::AffineTransformAnimation);
            bundle.scene.required_capabilities.sort_unstable();
        }
        let expected_scene = bundle.scene.clone();
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
