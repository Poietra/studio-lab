//! Pen-backed Studio path-motion projection and Scene IR materialization.

use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, CubicPathV1, CubicSegmentV1, CubicSubpathV1, IntervalV1,
    KeyframeV1, MotionPathParameterizationV1, PointV1, SceneCapabilityV1, SceneGeometryV1,
    SceneIrV1,
};
use serde::Serialize;

use super::super::motion::{motion_easing, projected_motion_easing};
use super::super::{StudioAuthoringSize, StudioProjectionEasing};
use super::{
    CreateSceneEntitiesError, MAX_STUDIO_CUBIC_BEZIER_SEGMENTS, PlannedStudioCreationEntity,
    ProjectStudioCreationEditError, StudioMotionEasing, TIMELINE_ANCHOR_EPSILON,
    studio_authoring_point_is_finite, studio_authoring_size_is_positive,
    studio_point_to_scene_point, unused_channel_id,
};

#[derive(Clone, Debug, PartialEq)]
pub struct StudioCreationSpatialContext {
    pub camera_center: PointV1,
    pub frame: StudioAuthoringSize,
    pub viewport: StudioAuthoringSize,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PlannedStudioPathMotion {
    pub(super) easing: StudioMotionEasing,
    pub(super) interval: IntervalV1,
    pub(super) operation_id: String,
    pub(super) path_entity_id: String,
    pub(super) source_interval: IntervalV1,
    pub(super) target_entity_id: String,
    pub(super) transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct CreateScenePathMotion {
    pub(super) easing: StudioMotionEasing,
    pub(super) interval: IntervalV1,
    pub(super) path_entity_id: String,
    pub(super) pixel_size_world: PointV1,
    pub(super) target_entity_id: String,
}

/// One exact Pen-backed motion projected by the Rust creation authority.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectedPathMotion {
    pub easing: StudioProjectionEasing,
    pub from: PointV1,
    pub interval: IntervalV1,
    pub operation_id: String,
    pub path: CubicSubpathV1,
    pub path_entity_id: String,
    pub source_interval: IntervalV1,
    pub target_entity_id: String,
    pub to: PointV1,
    pub transaction_id: String,
}

pub(super) fn path_to_world(
    path: &CubicSubpathV1,
    transform: &AffineTransformV1,
) -> CubicSubpathV1 {
    let point_to_world = |point: &PointV1| PointV1 {
        x: transform.m11 * point.x + transform.m12 * point.y + transform.tx,
        y: transform.m21 * point.x + transform.m22 * point.y + transform.ty,
    };
    CubicSubpathV1 {
        closed: path.closed,
        segments: path
            .segments
            .iter()
            .map(|segment| CubicSegmentV1 {
                control1: point_to_world(&segment.control1),
                control2: point_to_world(&segment.control2),
                end: point_to_world(&segment.end),
            })
            .collect(),
        start: point_to_world(&path.start),
    }
}

fn planned_path_transform(
    state: &PlannedStudioCreationEntity,
    context: &StudioCreationSpatialContext,
) -> AffineTransformV1 {
    let position = studio_point_to_scene_point(
        &state.position,
        context.frame,
        context.viewport,
        &context.camera_center,
    );
    let (sin, cos) = state.current_rotation.sin_cos();
    AffineTransformV1 {
        m11: state.scale * cos,
        m12: -state.scale * sin,
        m21: state.scale * sin,
        m22: state.scale * cos,
        tx: position.x,
        ty: position.y,
    }
}

fn scene_point_to_studio_point(point: &PointV1, context: &StudioCreationSpatialContext) -> PointV1 {
    PointV1 {
        x: ((point.x - context.camera_center.x) / context.frame.width + 0.5)
            * context.viewport.width,
        y: (0.5 - (point.y - context.camera_center.y) / context.frame.height)
            * context.viewport.height,
    }
}

fn scene_path_to_studio_path(
    path: &CubicSubpathV1,
    context: &StudioCreationSpatialContext,
) -> CubicSubpathV1 {
    CubicSubpathV1 {
        closed: path.closed,
        segments: path
            .segments
            .iter()
            .map(|segment| CubicSegmentV1 {
                control1: scene_point_to_studio_point(&segment.control1, context),
                control2: scene_point_to_studio_point(&segment.control2, context),
                end: scene_point_to_studio_point(&segment.end, context),
            })
            .collect(),
        start: scene_point_to_studio_point(&path.start, context),
    }
}

fn starts_within_one_pixel(target: &PointV1, path_start: &PointV1, pixel_size: &PointV1) -> bool {
    pixel_size.x.is_finite()
        && pixel_size.x > 0.0
        && pixel_size.y.is_finite()
        && pixel_size.y > 0.0
        && ((target.x - path_start.x) / pixel_size.x)
            .hypot((target.y - path_start.y) / pixel_size.y)
            <= 1.0 + TIMELINE_ANCHOR_EPSILON
}

pub(super) fn project_studio_path_motions(
    entities: &[PlannedStudioCreationEntity],
    motions: &[PlannedStudioPathMotion],
    spatial_context: Option<StudioCreationSpatialContext>,
) -> Result<Vec<StudioProjectedPathMotion>, ProjectStudioCreationEditError> {
    if motions.is_empty() {
        return Ok(Vec::new());
    }
    let context = spatial_context.ok_or(ProjectStudioCreationEditError::Unsupported)?;
    if !studio_authoring_size_is_positive(context.frame)
        || !studio_authoring_size_is_positive(context.viewport)
        || !studio_authoring_point_is_finite(&context.camera_center)
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let pixel_size = PointV1 {
        x: context.frame.width / context.viewport.width,
        y: context.frame.height / context.viewport.height,
    };
    motions
        .iter()
        .map(|motion| {
            let path_state = entities
                .iter()
                .find(|state| state.spec.id == motion.path_entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let target_state = entities
                .iter()
                .find(|state| state.spec.id == motion.target_entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let local_path = path_state
                .current_cubic_bezier_path
                .as_ref()
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let world_path =
                path_to_world(local_path, &planned_path_transform(path_state, &context));
            let target_world = studio_point_to_scene_point(
                &target_state.position,
                context.frame,
                context.viewport,
                &context.camera_center,
            );
            if !starts_within_one_pixel(&target_world, &world_path.start, &pixel_size) {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let path_end = world_path
                .segments
                .last()
                .map(|segment| &segment.end)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let path_start = scene_point_to_studio_point(&world_path.start, &context);
            Ok(StudioProjectedPathMotion {
                easing: projected_motion_easing(motion.easing),
                from: path_start,
                interval: motion.interval.clone(),
                operation_id: motion.operation_id.clone(),
                path: scene_path_to_studio_path(&world_path, &context),
                path_entity_id: motion.path_entity_id.clone(),
                source_interval: motion.source_interval.clone(),
                target_entity_id: motion.target_entity_id.clone(),
                to: scene_point_to_studio_point(path_end, &context),
                transaction_id: motion.transaction_id.clone(),
            })
        })
        .collect()
}

pub(super) fn append_studio_path_motions(
    scene: &mut SceneIrV1,
    motions: &[CreateScenePathMotion],
    provenance_id: &str,
) -> Result<(), CreateSceneEntitiesError> {
    for motion in motions {
        let path_entity = scene
            .entities
            .iter()
            .find(|entity| entity.id == motion.path_entity_id)
            .ok_or(CreateSceneEntitiesError::InvalidPathMotion)?;
        let target_entity = scene
            .entities
            .iter()
            .find(|entity| entity.id == motion.target_entity_id)
            .ok_or(CreateSceneEntitiesError::InvalidPathMotion)?;
        let SceneGeometryV1::CubicPath { path } = &path_entity.geometry else {
            return Err(CreateSceneEntitiesError::InvalidPathMotion);
        };
        let local_path = path
            .subpaths
            .first()
            .filter(|subpath| {
                path.subpaths.len() == 1
                    && !subpath.closed
                    && (2..=MAX_STUDIO_CUBIC_BEZIER_SEGMENTS).contains(&subpath.segments.len())
            })
            .ok_or(CreateSceneEntitiesError::InvalidPathMotion)?;
        let world_path = path_to_world(local_path, &path_entity.transform);
        let target_center = PointV1 {
            x: target_entity.transform.tx,
            y: target_entity.transform.ty,
        };
        let lifetimes_cover_motion = [path_entity, target_entity].iter().all(|entity| {
            entity.parent_id.is_none()
                && entity.lifetimes.iter().any(|lifetime| {
                    lifetime.start <= motion.interval.start + TIMELINE_ANCHOR_EPSILON
                        && lifetime.end + TIMELINE_ANCHOR_EPSILON >= motion.interval.end
                })
        });
        let has_transform_conflict = scene.animation_channels.iter().any(|channel| {
            channel.entity_id().is_some_and(|entity_id| {
                (entity_id == motion.path_entity_id || entity_id == motion.target_entity_id)
                    && matches!(
                        channel,
                        AnimationChannelV1::AffineTransform { .. }
                            | AnimationChannelV1::Rotation { .. }
                            | AnimationChannelV1::MotionPath { .. }
                            | AnimationChannelV1::PathMorph { .. }
                    )
            })
        });
        if motion.path_entity_id == motion.target_entity_id
            || motion.interval.start < 0.0
            || !motion.interval.start.is_finite()
            || !motion.interval.end.is_finite()
            || motion.interval.end <= motion.interval.start
            || motion.interval.end > scene.duration + TIMELINE_ANCHOR_EPSILON
            || !starts_within_one_pixel(&target_center, &world_path.start, &motion.pixel_size_world)
            || !lifetimes_cover_motion
            || has_transform_conflict
        {
            return Err(CreateSceneEntitiesError::InvalidPathMotion);
        }
        let channel_id = unused_channel_id(scene, "studio-path-motion");
        scene
            .animation_channels
            .push(AnimationChannelV1::MotionPath {
                entity_id: motion.target_entity_id.clone(),
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: motion.interval.start,
                        easing_to_next: Some(motion_easing(motion.easing)),
                        value: 0.0,
                    },
                    KeyframeV1 {
                        at: motion.interval.end,
                        easing_to_next: None,
                        value: 1.0,
                    },
                ],
                orient_to_path: false,
                parameterization: Some(MotionPathParameterizationV1::ManimPointFromProportionV1),
                path: CubicPathV1 {
                    subpaths: vec![world_path],
                },
                provenance_id: provenance_id.to_owned(),
            });
        if !scene
            .required_capabilities
            .contains(&SceneCapabilityV1::MotionPathAnimation)
        {
            scene
                .required_capabilities
                .push(SceneCapabilityV1::MotionPathAnimation);
            scene.required_capabilities.sort_unstable();
        }
    }
    Ok(())
}
