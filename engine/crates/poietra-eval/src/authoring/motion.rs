use std::collections::{BTreeMap, BTreeSet};

use poietra_geometry::manim_cubic_chord_length_v1;
use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, CubicPathV1, CubicSegmentV1, CubicSubpathV1, EasingV1,
    IntervalV1, KeyframeV1, MotionPathParameterizationV1, PointV1, ProvenanceOriginV1,
    ProvenanceRecordV1, SceneCapabilityV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::{Deserialize, Serialize};

use crate::{EngineSessionV1, EvaluationError};

use super::identity::{
    StudioMotionEntityIdentity, StudioMotionProjectionEntityIdentity, StudioMotionSourceBinding,
    resolve_studio_motion_targets,
};
use super::timeline::{SceneTimelineInsertion, insert_scene_time, shift_interval_for_insertion};
use super::transform::has_animated_transform;
use super::{
    SceneEditAnchorSource, SceneEditExecution, SceneEditOperationFacts, SceneEditScheduleMode,
    StudioAuthoringOrigin, StudioAuthoringSize, StudioProjectionEasing, TIMELINE_ANCHOR_EPSILON,
    scene_edit_anchor_is_closed, scene_edit_structure_is_closed, studio_authoring_point_is_finite,
    studio_authoring_size_is_positive, studio_vector_to_scene_vector, unused_channel_id,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionProjectionInsertion {
    pub at: f64,
    pub duration: f64,
    pub transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectedMotion {
    pub control: PointV1,
    pub control_offset: PointV1,
    pub delta: PointV1,
    pub easing: StudioProjectionEasing,
    pub from: PointV1,
    pub interval: IntervalV1,
    pub operation_id: String,
    pub source_interval: IntervalV1,
    pub target_entity_id: String,
    pub to: PointV1,
    pub transaction_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StudioMotionEasing {
    Linear,
    Smooth,
}

/// One normalized motion segment projected in Studio coordinates.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionProjection {
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub motions: Vec<StudioProjectedMotion>,
    pub projected_duration: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct CreateSceneMotionCommand {
    pub(super) control_offset: PointV1,
    pub(super) delta: PointV1,
    pub(super) easing: StudioMotionEasing,
    pub(super) expected_base_revision: String,
    pub(super) interval: IntervalV1,
    pub(super) next_revision: String,
    pub(super) provenance: ProvenanceRecordV1,
    pub(super) target_entity_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PlannedSceneMotion {
    pub(super) control_offset: PointV1,
    pub(super) delta: PointV1,
    pub(super) easing: StudioMotionEasing,
    pub(super) interval: IntervalV1,
    pub(super) target_entity_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PlannedStudioMotion {
    pub(super) base_interval: IntervalV1,
    pub(super) control_offset: PointV1,
    pub(super) delta: PointV1,
    pub(super) easing: StudioMotionEasing,
    pub(super) interval: IntervalV1,
    pub(super) operation_id: String,
    pub(super) parallel: bool,
    pub(super) target_entity_ids: Vec<String>,
    pub(super) transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct StudioMotionPlan {
    pub(super) insertions: Vec<StudioMotionProjectionInsertion>,
    pub(super) motions: Vec<PlannedStudioMotion>,
    pub(super) projected_duration: f64,
    pub(super) timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedEntityMotionSegment {
    easing: StudioMotionEasing,
    interval: IntervalV1,
    segment: CubicSegmentV1,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedEntityMotionPath {
    current: PointV1,
    segments: Vec<PlannedEntityMotionSegment>,
    start: PointV1,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioMotionOperation {
    CreateMotion {
        control_offset: PointV1,
        delta: PointV1,
        depends_on: Vec<String>,
        easing: StudioMotionEasing,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        target_entity_ids: Vec<String>,
    },
    Unsupported {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioMotionOperation {
    fn depends_on(&self) -> &[String] {
        match self {
            Self::CreateMotion { depends_on, .. } | Self::Unsupported { depends_on, .. } => {
                depends_on
            }
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::CreateMotion { id, .. } | Self::Unsupported { id, .. } => id,
        }
    }

    fn interval(&self) -> &IntervalV1 {
        match self {
            Self::CreateMotion { interval, .. } | Self::Unsupported { interval, .. } => interval,
        }
    }

    fn origin(&self) -> StudioAuthoringOrigin {
        match self {
            Self::CreateMotion { origin, .. } | Self::Unsupported { origin, .. } => *origin,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: SceneEditAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioMotionOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: SceneEditExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: SceneEditScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioMotionEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub next_revision: String,
    pub programs: Vec<StudioMotionEditInput>,
    pub source_runtime_bindings: Vec<StudioMotionSourceBinding>,
    pub studio_entities: Vec<StudioMotionEntityIdentity>,
    pub viewport: StudioAuthoringSize,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioMotionEditError {
    #[error("the normalized Studio Programs do not authorize one imported Scene motion")]
    Unsupported,
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the motion command must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the motion interval must be finite, non-negative, non-empty, and inside the Scene")]
    InvalidInterval,
    #[error("motion points must be finite and the delta or control offset must be non-zero")]
    InvalidMotion,
    #[error("a motion command must contain at least one target")]
    EmptyTargets,
    #[error("the motion command contains a duplicate target: {0}")]
    DuplicateTarget(String),
    #[error("the motion target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space motion currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the motion target is not active for the complete interval: {0}")]
    TargetInactive(String),
    #[error("world-space motion does not support an already animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the motion provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the authored motion Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectStudioMotionEditError {
    #[error("the normalized Studio Programs do not authorize one motion-bearing batch")]
    Unsupported,
}

fn studio_motion_edit_input_is_closed(program: &StudioMotionEditInput) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| SceneEditOperationFacts {
            depends_on: operation.depends_on(),
            id: operation.id(),
        })
        .collect::<Vec<_>>();
    program.intent_count == program.operations.len()
        && program.operations.iter().all(|operation| {
            matches!(operation, StudioMotionOperation::CreateMotion { .. })
                && operation.origin() == program.origin
        })
        && scene_edit_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &[],
        )
}

fn closed_studio_motion_operations(
    program: &StudioMotionEditInput,
    scene_duration: f64,
) -> Option<Vec<&StudioMotionOperation>> {
    let mut operations = program
        .schedule_order
        .iter()
        .map(|operation_id| {
            program
                .operations
                .iter()
                .find(|operation| operation.id() == operation_id)
        })
        .collect::<Option<Vec<_>>>()?;
    if !program.lowering_supported
        || program.transaction_id.is_empty()
        || !scene_edit_anchor_is_closed(
            &program.anchor_source,
            program.anchor_captured_playhead,
            program.anchor_resolved_seconds,
            scene_duration,
        )
        || !studio_motion_edit_input_is_closed(program)
        || operations.iter().any(|operation| {
            !operation.interval().start.is_finite() || !operation.interval().end.is_finite()
        })
    {
        return None;
    }

    if program.requested_execution == SceneEditExecution::Parallel {
        operations.sort_by(|left, right| left.interval().start.total_cmp(&right.interval().start));
    }
    let first = *operations.first()?;
    if (program.anchor_resolved_seconds - first.interval().start).abs() > TIMELINE_ANCHOR_EPSILON {
        return None;
    }

    match program.requested_execution {
        SceneEditExecution::Sequence => {
            if operations.windows(2).any(|pair| {
                pair[1].interval().start < pair[0].interval().end - TIMELINE_ANCHOR_EPSILON
            }) {
                return None;
            }
        }
        SceneEditExecution::Parallel => {
            let StudioMotionOperation::CreateMotion {
                easing, interval, ..
            } = first
            else {
                return None;
            };
            if program.schedule_mode != SceneEditScheduleMode::Parallel {
                return None;
            }
            let mut bucket_start = interval.start;
            let mut bucket_end = interval.end;
            let mut bucket_easing = *easing;
            for operation in operations.iter().skip(1) {
                let StudioMotionOperation::CreateMotion {
                    easing: candidate_easing,
                    interval: candidate_interval,
                    ..
                } = operation
                else {
                    return None;
                };
                if (candidate_interval.start - bucket_start).abs() <= TIMELINE_ANCHOR_EPSILON {
                    if *candidate_easing != bucket_easing
                        || (candidate_interval.end - bucket_end).abs() > TIMELINE_ANCHOR_EPSILON
                    {
                        return None;
                    }
                    bucket_end = bucket_end.max(candidate_interval.end);
                } else {
                    if candidate_interval.start < bucket_end - TIMELINE_ANCHOR_EPSILON {
                        return None;
                    }
                    bucket_start = candidate_interval.start;
                    bucket_end = candidate_interval.end;
                    bucket_easing = *candidate_easing;
                }
            }
        }
    }
    Some(operations)
}

#[allow(
    clippy::too_many_lines,
    reason = "one bounded motion scheduler keeps full apply and snapshot-free projection on the same admission path"
)]
pub(super) fn plan_studio_motion_edits(
    base_duration: f64,
    programs: &[StudioMotionEditInput],
) -> Result<StudioMotionPlan, ProjectStudioMotionEditError> {
    if !base_duration.is_finite() || base_duration <= 0.0 || programs.is_empty() {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }
    let mut ordered_programs = (0..programs.len()).collect::<Vec<_>>();
    ordered_programs.sort_by(|left, right| {
        programs[*left]
            .anchor_resolved_seconds
            .total_cmp(&programs[*right].anchor_resolved_seconds)
            .then(left.cmp(right))
    });
    let mut operation_ids = BTreeSet::new();
    let mut resolved_offset = 0.0;
    let mut projected_duration = base_duration;
    let mut motions = Vec::new();
    let mut insertions = Vec::with_capacity(programs.len());
    let mut timeline_insertions = Vec::with_capacity(programs.len());

    for program_index in ordered_programs {
        let program = &programs[program_index];
        let operations = closed_studio_motion_operations(program, base_duration)
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let mut maximum_end = program.anchor_resolved_seconds;
        let mut parallel_bucket_start: Option<f64> = None;
        let mut parallel_targets = BTreeSet::new();
        for operation in operations {
            if !operation_ids.insert(operation.id()) {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            let StudioMotionOperation::CreateMotion {
                control_offset,
                delta,
                easing,
                interval,
                target_entity_ids,
                ..
            } = operation
            else {
                return Err(ProjectStudioMotionEditError::Unsupported);
            };
            let mut operation_targets = BTreeSet::new();
            if target_entity_ids.is_empty()
                || target_entity_ids
                    .iter()
                    .any(|target| target.is_empty() || !operation_targets.insert(target.as_str()))
                || !studio_authoring_point_is_finite(control_offset)
                || !studio_authoring_point_is_finite(delta)
                || (control_offset.x == 0.0
                    && control_offset.y == 0.0
                    && delta.x == 0.0
                    && delta.y == 0.0)
                || interval.start < 0.0
                || interval.start >= interval.end
                || interval.end > base_duration + TIMELINE_ANCHOR_EPSILON
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            if program.requested_execution == SceneEditExecution::Parallel {
                if parallel_bucket_start.is_none_or(|bucket_start| {
                    (interval.start - bucket_start).abs() > TIMELINE_ANCHOR_EPSILON
                }) {
                    parallel_bucket_start = Some(interval.start);
                    parallel_targets.clear();
                }
                if target_entity_ids
                    .iter()
                    .any(|target| !parallel_targets.insert(target.as_str()))
                {
                    return Err(ProjectStudioMotionEditError::Unsupported);
                }
            }
            maximum_end = maximum_end.max(interval.end);
            motions.push(PlannedStudioMotion {
                base_interval: interval.clone(),
                control_offset: control_offset.clone(),
                delta: delta.clone(),
                easing: *easing,
                interval: IntervalV1 {
                    end: interval.end + resolved_offset,
                    start: interval.start + resolved_offset,
                },
                operation_id: operation.id().to_owned(),
                parallel: program.requested_execution == SceneEditExecution::Parallel,
                target_entity_ids: target_entity_ids.clone(),
                transaction_id: program.transaction_id.clone(),
            });
        }
        let duration = maximum_end - program.anchor_resolved_seconds;
        let at = program.anchor_resolved_seconds + resolved_offset;
        if !duration.is_finite()
            || duration <= 0.0
            || !at.is_finite()
            || at > projected_duration + TIMELINE_ANCHOR_EPSILON
        {
            return Err(ProjectStudioMotionEditError::Unsupported);
        }
        insertions.push(StudioMotionProjectionInsertion {
            at,
            duration,
            transaction_id: program.transaction_id.clone(),
        });
        timeline_insertions.push(SceneTimelineInsertion { at, duration });
        resolved_offset += duration;
        projected_duration += duration;
    }

    Ok(StudioMotionPlan {
        insertions,
        motions,
        projected_duration,
        timeline_insertions,
    })
}

#[derive(Clone, Debug)]
pub(super) struct StudioMotionProjectionTarget {
    pub(super) lifetime: IntervalV1,
    pub(super) position: PointV1,
}

pub(super) fn project_studio_motion_plan(
    plan: &StudioMotionPlan,
    mut targets: BTreeMap<String, StudioMotionProjectionTarget>,
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    for target in targets.values_mut() {
        for insertion in &plan.timeline_insertions {
            shift_interval_for_insertion(&mut target.lifetime, insertion);
        }
    }
    let mut motions = Vec::new();
    for motion in &plan.motions {
        for target_entity_id in &motion.target_entity_ids {
            let target = targets
                .get_mut(target_entity_id)
                .ok_or(ProjectStudioMotionEditError::Unsupported)?;
            if motion.interval.start < target.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || motion.interval.end > target.lifetime.end + TIMELINE_ANCHOR_EPSILON
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            let from = target.position.clone();
            let to = PointV1 {
                x: from.x + motion.delta.x,
                y: from.y + motion.delta.y,
            };
            let control = PointV1 {
                x: from.x + motion.delta.x / 2.0 + motion.control_offset.x,
                y: from.y + motion.delta.y / 2.0 + motion.control_offset.y,
            };
            if !studio_authoring_point_is_finite(&from)
                || !studio_authoring_point_is_finite(&to)
                || !studio_authoring_point_is_finite(&control)
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            target.position.clone_from(&to);
            motions.push(StudioProjectedMotion {
                control,
                control_offset: motion.control_offset.clone(),
                delta: motion.delta.clone(),
                easing: projected_motion_easing(motion.easing),
                from,
                interval: motion.interval.clone(),
                operation_id: motion.operation_id.clone(),
                source_interval: motion.base_interval.clone(),
                target_entity_id: target_entity_id.clone(),
                to,
                transaction_id: motion.transaction_id.clone(),
            });
        }
    }
    Ok(StudioMotionProjection {
        insertions: plan.insertions.clone(),
        motions,
        projected_duration: plan.projected_duration,
    })
}

pub(super) fn one_projection_lifetime(lifetimes: &[IntervalV1]) -> Option<IntervalV1> {
    lifetimes
        .first()
        .filter(|lifetime| {
            lifetimes.len() == 1
                && lifetime.start.is_finite()
                && lifetime.end.is_finite()
                && lifetime.start < lifetime.end
        })
        .cloned()
}

pub(super) fn project_standalone_motion_edits(
    base_duration: f64,
    programs: &[StudioMotionEditInput],
    studio_entities: &[StudioMotionProjectionEntityIdentity],
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    let plan = plan_studio_motion_edits(base_duration, programs)?;
    let target_ids = plan
        .motions
        .iter()
        .flat_map(|motion| motion.target_entity_ids.iter())
        .collect::<BTreeSet<_>>();
    let mut targets = BTreeMap::new();
    for target_id in target_ids {
        let mut matching = studio_entities
            .iter()
            .filter(|entity| entity.identity.object_graph_key == *target_id);
        let entity = matching
            .next()
            .filter(|entity| {
                !entity.identity.provisional
                    && entity
                        .identity
                        .source_identity
                        .as_deref()
                        .is_some_and(|identity| !identity.is_empty())
            })
            .filter(|_| matching.next().is_none())
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let position = entity.position.clone();
        if !studio_authoring_point_is_finite(&position) {
            return Err(ProjectStudioMotionEditError::Unsupported);
        }
        let lifetime = one_projection_lifetime(&entity.lifetime)
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        targets.insert(
            target_id.clone(),
            StudioMotionProjectionTarget { lifetime, position },
        );
    }
    project_studio_motion_plan(&plan, targets)
}

fn quadratic_motion_segment(
    start: &PointV1,
    delta: &PointV1,
    control_offset: &PointV1,
) -> CubicSegmentV1 {
    let control_offset_x = 2.0 * control_offset.x / 3.0;
    let control_offset_y = 2.0 * control_offset.y / 3.0;
    CubicSegmentV1 {
        control1: PointV1 {
            x: start.x + delta.x / 3.0 + control_offset_x,
            y: start.y + delta.y / 3.0 + control_offset_y,
        },
        control2: PointV1 {
            x: start.x + 2.0 * delta.x / 3.0 + control_offset_x,
            y: start.y + 2.0 * delta.y / 3.0 + control_offset_y,
        },
        end: PointV1 {
            x: start.x + delta.x,
            y: start.y + delta.y,
        },
    }
}

fn motion_easing(easing: StudioMotionEasing) -> EasingV1 {
    match easing {
        StudioMotionEasing::Linear => EasingV1::Linear {},
        StudioMotionEasing::Smooth => EasingV1::ManimSmooth {},
    }
}

pub(super) fn projected_motion_easing(easing: StudioMotionEasing) -> StudioProjectionEasing {
    match easing {
        StudioMotionEasing::Linear => StudioProjectionEasing::Linear,
        StudioMotionEasing::Smooth => StudioProjectionEasing::ManimSmooth,
    }
}

pub(super) fn authored_motion_easing(easing: StudioProjectionEasing) -> StudioMotionEasing {
    match easing {
        StudioProjectionEasing::Linear => StudioMotionEasing::Linear,
        StudioProjectionEasing::ManimSmooth => StudioMotionEasing::Smooth,
    }
}

fn stitched_motion_keyframes(
    start: &PointV1,
    segments: &[PlannedEntityMotionSegment],
) -> Result<Vec<KeyframeV1<f64>>, ApplyStudioMotionEditError> {
    let lengths = segments
        .iter()
        .scan(start.clone(), |segment_start, planned| {
            let length = manim_cubic_chord_length_v1(segment_start, &planned.segment);
            *segment_start = planned.segment.end.clone();
            Some(length)
        })
        .collect::<Vec<_>>();
    let total_length = lengths.iter().sum::<f64>();
    if !total_length.is_finite() || total_length <= 0.0 {
        return Err(ApplyStudioMotionEditError::InvalidMotion);
    }

    let mut cumulative_length = 0.0;
    let mut keyframes: Vec<KeyframeV1<f64>> = Vec::with_capacity(segments.len() * 2);
    for (index, (planned, length)) in segments.iter().zip(lengths).enumerate() {
        let start_progress = cumulative_length / total_length;
        if let Some(previous) = keyframes.last_mut() {
            if planned.interval.start < previous.at - TIMELINE_ANCHOR_EPSILON {
                return Err(ApplyStudioMotionEditError::InvalidInterval);
            }
            if planned.interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: planned.interval.start,
                    easing_to_next: Some(motion_easing(planned.easing)),
                    value: start_progress,
                });
            } else {
                previous.easing_to_next = Some(motion_easing(planned.easing));
            }
        } else {
            keyframes.push(KeyframeV1 {
                at: planned.interval.start,
                easing_to_next: Some(motion_easing(planned.easing)),
                value: 0.0,
            });
        }
        cumulative_length += length;
        keyframes.push(KeyframeV1 {
            at: planned.interval.end,
            easing_to_next: None,
            value: if index + 1 == segments.len() {
                1.0
            } else {
                cumulative_length / total_length
            },
        });
    }
    Ok(keyframes)
}

pub(super) fn append_planned_scene_motions(
    scene: &mut poietra_scene_ir::SceneIrV1,
    motions: &[PlannedSceneMotion],
    provenance_id: &str,
) -> Result<(), ApplyStudioMotionEditError> {
    if motions.is_empty() {
        return Ok(());
    }
    let mut entity_order = Vec::new();
    let mut entity_paths = BTreeMap::<String, PlannedEntityMotionPath>::new();
    for motion in motions {
        for entity_id in &motion.target_entity_ids {
            if !entity_paths.contains_key(entity_id) {
                let entity = scene
                    .entities
                    .iter()
                    .find(|entity| entity.id == *entity_id)
                    .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
                let start = PointV1 {
                    x: entity.transform.tx,
                    y: entity.transform.ty,
                };
                entity_order.push(entity_id.clone());
                entity_paths.insert(
                    entity_id.clone(),
                    PlannedEntityMotionPath {
                        current: start.clone(),
                        segments: Vec::new(),
                        start,
                    },
                );
            }
            let path = entity_paths
                .get_mut(entity_id)
                .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
            let segment =
                quadratic_motion_segment(&path.current, &motion.delta, &motion.control_offset);
            path.current = segment.end.clone();
            path.segments.push(PlannedEntityMotionSegment {
                easing: motion.easing,
                interval: motion.interval.clone(),
                segment,
            });
        }
    }

    for entity_id in entity_order {
        let path = entity_paths
            .remove(&entity_id)
            .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
        let channel_id = unused_channel_id(scene, "studio-motion");
        scene
            .animation_channels
            .push(AnimationChannelV1::MotionPath {
                entity_id,
                id: channel_id,
                keyframes: stitched_motion_keyframes(&path.start, &path.segments)?,
                orient_to_path: false,
                parameterization: Some(MotionPathParameterizationV1::ManimPointFromProportionV1),
                path: CubicPathV1 {
                    subpaths: vec![CubicSubpathV1 {
                        closed: false,
                        segments: path
                            .segments
                            .into_iter()
                            .map(|planned| planned.segment)
                            .collect(),
                        start: path.start,
                    }],
                },
                provenance_id: provenance_id.to_owned(),
            });
    }
    let mut capabilities = scene
        .required_capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    capabilities.insert(SceneCapabilityV1::MotionPathAnimation);
    scene.required_capabilities = capabilities.into_iter().collect();
    Ok(())
}

#[allow(
    clippy::float_cmp,
    reason = "exact zero distinguishes a visible motion command from a no-op"
)]
pub(super) fn validate_create_scene_motion_command(
    scene: &poietra_scene_ir::SceneIrV1,
    command: &CreateSceneMotionCommand,
) -> Result<Vec<(String, PointV1)>, ApplyStudioMotionEditError> {
    if scene.source.revision_hash() != command.expected_base_revision {
        return Err(ApplyStudioMotionEditError::StaleBaseRevision);
    }
    if command.next_revision == command.expected_base_revision {
        return Err(ApplyStudioMotionEditError::RevisionDidNotAdvance);
    }
    if !command.interval.start.is_finite()
        || !command.interval.end.is_finite()
        || command.interval.start < 0.0
        || command.interval.start >= command.interval.end
        || command.interval.end > scene.duration
    {
        return Err(ApplyStudioMotionEditError::InvalidInterval);
    }
    if !command.delta.x.is_finite()
        || !command.delta.y.is_finite()
        || !command.control_offset.x.is_finite()
        || !command.control_offset.y.is_finite()
        || (command.delta.x == 0.0
            && command.delta.y == 0.0
            && command.control_offset.x == 0.0
            && command.control_offset.y == 0.0)
    {
        return Err(ApplyStudioMotionEditError::InvalidMotion);
    }
    if command.target_entity_ids.is_empty() {
        return Err(ApplyStudioMotionEditError::EmptyTargets);
    }
    let mut unique_targets = BTreeSet::new();
    for entity_id in &command.target_entity_ids {
        if !unique_targets.insert(entity_id.as_str()) {
            return Err(ApplyStudioMotionEditError::DuplicateTarget(
                entity_id.clone(),
            ));
        }
    }
    if scene
        .provenance
        .iter()
        .any(|record| record.id == command.provenance.id)
    {
        return Err(ApplyStudioMotionEditError::ProvenanceConflict(
            command.provenance.id.clone(),
        ));
    }

    let mut target_starts = Vec::with_capacity(command.target_entity_ids.len());
    for entity_id in &command.target_entity_ids {
        let target = scene
            .entities
            .iter()
            .find(|entity| entity.id == *entity_id)
            .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(ApplyStudioMotionEditError::TargetIsNotRoot(
                entity_id.clone(),
            ));
        }
        if !target.lifetimes.iter().any(|lifetime| {
            command.interval.start >= lifetime.start && command.interval.end <= lifetime.end
        }) {
            return Err(ApplyStudioMotionEditError::TargetInactive(
                entity_id.clone(),
            ));
        }
        if has_animated_transform(scene, entity_id) {
            return Err(ApplyStudioMotionEditError::AnimatedTransformUnsupported(
                entity_id.clone(),
            ));
        }
        target_starts.push((
            entity_id.clone(),
            PointV1 {
                x: target.transform.tx,
                y: target.transform.ty,
            },
        ));
    }
    Ok(target_starts)
}

impl EngineSessionV1 {
    /// Authorizes complete normalized Studio motion edits and applies them atomically.
    ///
    /// The caller sends every edit and operation. This method owns closed-subset admission,
    /// Studio-to-runtime identity resolution, viewport conversion, and provenance construction.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized edit is outside the imported static motion
    /// subset, or a concrete motion mutation error. Every failure preserves the installed Scene.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "frame dimensions are exact normalized authority facts; closed batch admission stays contiguous before the single commit"
    )]
    pub fn apply_studio_motion_edit(
        &mut self,
        command: ApplyStudioMotionEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let ApplyStudioMotionEditCommand {
            expected_base_revision,
            frame,
            next_revision,
            programs,
            source_runtime_bindings,
            studio_entities,
            viewport,
        } = command;
        let scene = self.scene();
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !scene.animation_channels.is_empty()
            || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.is_empty()
        {
            return Err(ApplyStudioMotionEditError::Unsupported);
        }

        let plan = plan_studio_motion_edits(scene.duration, &programs)
            .map_err(|_| ApplyStudioMotionEditError::Unsupported)?;
        let mut planned_motions = Vec::with_capacity(plan.motions.len());
        let mut parallel_runtime_targets: Vec<(String, f64, String)> = Vec::new();
        let provenance_id = format!("studio-motion:{next_revision}");
        for motion in &plan.motions {
            let runtime_entity_ids = resolve_studio_motion_targets(
                &motion.target_entity_ids,
                &studio_entities,
                &source_runtime_bindings,
            )
            .ok_or(ApplyStudioMotionEditError::Unsupported)?;
            if motion.parallel {
                for runtime_entity_id in &runtime_entity_ids {
                    if parallel_runtime_targets
                        .iter()
                        .any(|(transaction_id, start, target)| {
                            transaction_id == &motion.transaction_id
                                && (*start - motion.base_interval.start).abs()
                                    <= TIMELINE_ANCHOR_EPSILON
                                && target == runtime_entity_id
                        })
                    {
                        return Err(ApplyStudioMotionEditError::Unsupported);
                    }
                    parallel_runtime_targets.push((
                        motion.transaction_id.clone(),
                        motion.base_interval.start,
                        runtime_entity_id.clone(),
                    ));
                }
            }
            let control_offset =
                studio_vector_to_scene_vector(&motion.control_offset, frame, viewport);
            let delta = studio_vector_to_scene_vector(&motion.delta, frame, viewport);
            validate_create_scene_motion_command(
                scene,
                &CreateSceneMotionCommand {
                    control_offset: control_offset.clone(),
                    delta: delta.clone(),
                    easing: motion.easing,
                    expected_base_revision: expected_base_revision.clone(),
                    interval: motion.base_interval.clone(),
                    next_revision: next_revision.clone(),
                    provenance: ProvenanceRecordV1 {
                        evidence: vec![],
                        id: provenance_id.clone(),
                        origin: ProvenanceOriginV1::StudioEditProgram,
                    },
                    target_entity_ids: runtime_entity_ids.clone(),
                },
            )?;
            planned_motions.push(PlannedSceneMotion {
                control_offset,
                delta,
                easing: motion.easing,
                interval: motion.interval.clone(),
                target_entity_ids: runtime_entity_ids,
            });
        }

        self.commit_scene_motions(
            &planned_motions,
            &plan.timeline_insertions,
            &ProvenanceRecordV1 {
                evidence: plan
                    .motions
                    .iter()
                    .map(|motion| format!("authorized operation {}", motion.operation_id))
                    .collect(),
                id: provenance_id,
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            next_revision,
        )
    }

    /// Atomically adds one quadratic world-space motion to one or more root entities.
    #[cfg(test)]
    fn create_scene_motion(
        &mut self,
        command: CreateSceneMotionCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let scene = self.scene();
        validate_create_scene_motion_command(scene, &command)?;
        let duration = command.interval.end - command.interval.start;
        self.commit_scene_motions(
            &[PlannedSceneMotion {
                control_offset: command.control_offset,
                delta: command.delta,
                easing: command.easing,
                interval: command.interval.clone(),
                target_entity_ids: command.target_entity_ids,
            }],
            &[SceneTimelineInsertion {
                at: command.interval.start,
                duration,
            }],
            &command.provenance,
            command.next_revision,
        )
    }

    fn commit_scene_motions(
        &mut self,
        motions: &[PlannedSceneMotion],
        timeline_insertions: &[SceneTimelineInsertion],
        provenance: &ProvenanceRecordV1,
        next_revision: String,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let scene = self.scene();
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        for insertion in timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        candidate.scene.provenance.push(provenance.clone());
        append_planned_scene_motions(&mut candidate.scene, motions, &provenance.id)?;
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{
        NEXT_REVISION, fixture_bundle, imported_bundle, static_imported_bundle,
    };
    use super::super::{
        ProjectStudioMotionEditCommand, StudioMotionProjectionBatch, project_studio_motion_edit,
    };
    use super::*;

    fn motion_command(bundle: &SceneIrBundleV1) -> CreateSceneMotionCommand {
        CreateSceneMotionCommand {
            control_offset: PointV1 { x: 0.0, y: 4.0 },
            delta: PointV1 { x: 6.0, y: 2.0 },
            easing: StudioMotionEasing::Smooth,
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            interval: IntervalV1 {
                end: 1.5,
                start: 0.5,
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio motion".to_owned()],
                id: "studio-motion-authoring".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            target_entity_ids: vec!["later".to_owned(), "stroke".to_owned()],
        }
    }

    fn studio_motion_edit_command(bundle: &SceneIrBundleV1) -> ApplyStudioMotionEditCommand {
        ApplyStudioMotionEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: 9.0,
                width: 16.0,
            },
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StudioMotionEditInput {
                anchor_captured_playhead: 0.5,
                anchor_resolved_seconds: 0.5,
                anchor_source: SceneEditAnchorSource::Playhead {
                    reference_seconds: Some(0.5),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![StudioMotionOperation::CreateMotion {
                    control_offset: PointV1 { x: 0.0, y: -160.0 },
                    delta: PointV1 { x: 240.0, y: -80.0 },
                    depends_on: vec![],
                    easing: StudioMotionEasing::Smooth,
                    id: "create-motion".to_owned(),
                    interval: IntervalV1 {
                        end: 1.5,
                        start: 0.5,
                    },
                    origin: StudioAuthoringOrigin::DirectManipulation,
                    target_entity_ids: vec!["source:later".to_owned(), "source:stroke".to_owned()],
                }],
                origin: StudioAuthoringOrigin::DirectManipulation,
                requested_execution: SceneEditExecution::Sequence,
                schedule_edge_count: 0,
                schedule_mode: SceneEditScheduleMode::Sequence,
                schedule_order: vec!["create-motion".to_owned()],
                transaction_id: "create-motion".to_owned(),
            }],
            source_runtime_bindings: vec![
                StudioMotionSourceBinding {
                    runtime_entity_id: "later".to_owned(),
                    source_identity_key: "later-source".to_owned(),
                    source_name: "later-source".to_owned(),
                },
                StudioMotionSourceBinding {
                    runtime_entity_id: "stroke".to_owned(),
                    source_identity_key: "stroke-source".to_owned(),
                    source_name: "stroke-source".to_owned(),
                },
            ],
            studio_entities: vec![
                StudioMotionEntityIdentity {
                    object_graph_key: "source:later".to_owned(),
                    provisional: false,
                    source_identity: Some("later-source".to_owned()),
                },
                StudioMotionEntityIdentity {
                    object_graph_key: "source:stroke".to_owned(),
                    provisional: false,
                    source_identity: Some("stroke-source".to_owned()),
                },
            ],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn two_motion_sequence_command(bundle: &SceneIrBundleV1) -> ApplyStudioMotionEditCommand {
        let mut command = studio_motion_edit_command(bundle);
        let program = &mut command.programs[0];
        let StudioMotionOperation::CreateMotion {
            interval,
            target_entity_ids,
            ..
        } = &mut program.operations[0]
        else {
            unreachable!();
        };
        interval.end = 1.0;
        *target_entity_ids = vec!["source:later".to_owned()];
        program
            .operations
            .push(StudioMotionOperation::CreateMotion {
                control_offset: PointV1 { x: 80.0, y: 0.0 },
                delta: PointV1 { x: 0.0, y: -120.0 },
                depends_on: vec!["create-motion".to_owned()],
                easing: StudioMotionEasing::Linear,
                id: "create-motion-second".to_owned(),
                interval: IntervalV1 {
                    end: 1.75,
                    start: 1.25,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
                target_entity_ids: vec!["source:later".to_owned()],
            });
        program.intent_count = 2;
        program.schedule_edge_count = 1;
        program.schedule_order = vec![
            "create-motion".to_owned(),
            "create-motion-second".to_owned(),
        ];
        command
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the test builder names each independent normalized motion fact"
    )]
    fn studio_motion_edit_input(
        template: &StudioMotionEditInput,
        transaction_id: &str,
        anchor: f64,
        end: f64,
        target_entity_ids: Vec<String>,
        delta: PointV1,
        control_offset: PointV1,
        easing: StudioMotionEasing,
    ) -> StudioMotionEditInput {
        let operation_id = format!("{transaction_id}-motion");
        StudioMotionEditInput {
            anchor_captured_playhead: anchor,
            anchor_resolved_seconds: anchor,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(anchor),
            },
            operations: vec![StudioMotionOperation::CreateMotion {
                control_offset,
                delta,
                depends_on: vec![],
                easing,
                id: operation_id.clone(),
                interval: IntervalV1 { end, start: anchor },
                origin: template.origin,
                target_entity_ids,
            }],
            schedule_order: vec![operation_id],
            transaction_id: transaction_id.to_owned(),
            ..template.clone()
        }
    }

    fn rejected_motion(
        bundle: SceneIrBundleV1,
        command: CreateSceneMotionCommand,
    ) -> ApplyStudioMotionEditError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.create_scene_motion(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn rejected_studio_motion(
        bundle: SceneIrBundleV1,
        command: ApplyStudioMotionEditCommand,
    ) -> ApplyStudioMotionEditError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.apply_studio_motion_edit(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    #[test]
    fn applies_one_complete_studio_motion_through_canonical_identity_and_coordinates() {
        let bundle = static_imported_bundle();
        let ir_scene_id = bundle.scene.scene_id.clone();
        assert_ne!(ir_scene_id, "scene.py#CircleScene");
        let command = studio_motion_edit_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();

        assert_eq!(result.scene.scene_id, ir_scene_id);
        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);
        assert_eq!(
            result.scene.provenance.last().unwrap().id,
            format!("studio-motion:{NEXT_REVISION}")
        );
        let path = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id, path, ..
                } if entity_id == "later" => Some(path),
                _ => None,
            })
            .unwrap();
        let subpath = &path.subpaths[0];
        let segment = &subpath.segments[0];
        assert_eq!(subpath.start, PointV1 { x: 0.0, y: 0.0 });
        assert!((segment.control1.x - 2.0).abs() < 1e-12);
        assert!((segment.control1.y - 10.0 / 3.0).abs() < 1e-12);
        assert!((segment.control2.x - 4.0).abs() < 1e-12);
        assert!((segment.control2.y - 4.0).abs() < 1e-12);
        assert_eq!(segment.end, PointV1 { x: 6.0, y: 2.0 });
    }

    #[test]
    fn applies_two_sequenced_motions_in_one_edit_with_one_timeline_insertion() {
        let bundle = static_imported_bundle();
        let command = two_motion_sequence_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let (keyframes, path) = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } if entity_id == "later" => Some((keyframes, path)),
                _ => None,
            })
            .unwrap();

        assert!((result.scene.duration - 3.25).abs() < f64::EPSILON);
        assert_eq!(path.subpaths[0].segments.len(), 2);
        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.25, 1.75]
        );
        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "multi-motion-program-sample",
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
                _ => panic!("motion target must remain a path draw"),
            }
        };
        for (time, expected) in [
            (0.5, PointV1 { x: 0.0, y: 0.0 }),
            (0.75, PointV1 { x: 3.0, y: 3.0 }),
            (1.0, PointV1 { x: 6.0, y: 2.0 }),
            (1.125, PointV1 { x: 6.0, y: 2.0 }),
            (1.5, PointV1 { x: 7.0, y: 3.5 }),
            (1.75, PointV1 { x: 6.0, y: 5.0 }),
        ] {
            let sampled = sampled_transform(time);
            assert!((sampled.tx - expected.x).abs() < 1e-10, "time={time}");
            assert!((sampled.ty - expected.y).abs() < 1e-10, "time={time}");
        }
    }

    #[test]
    fn applies_parallel_motion_buckets_in_time_order_with_one_timeline_insertion() {
        let bundle = static_imported_bundle();
        let mut command = two_motion_sequence_command(&bundle);
        let program = &mut command.programs[0];
        let StudioMotionOperation::CreateMotion { depends_on, .. } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        program
            .operations
            .push(StudioMotionOperation::CreateMotion {
                control_offset: PointV1 { x: 0.0, y: 0.0 },
                delta: PointV1 { x: 0.0, y: -80.0 },
                depends_on: vec![],
                easing: StudioMotionEasing::Smooth,
                id: "create-motion-parallel".to_owned(),
                interval: IntervalV1 {
                    end: 1.0,
                    start: 0.5,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
                target_entity_ids: vec!["source:stroke".to_owned()],
            });
        program.intent_count = 3;
        program.requested_execution = SceneEditExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = SceneEditScheduleMode::Parallel;
        program.schedule_order = vec![
            "create-motion-second".to_owned(),
            "create-motion-parallel".to_owned(),
            "create-motion".to_owned(),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let later = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } if entity_id == "later" => Some((keyframes, path)),
                _ => None,
            })
            .unwrap();
        let stroke_keyframes = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "stroke" => Some(keyframes),
                _ => None,
            })
            .unwrap();

        assert!((result.scene.duration - 3.25).abs() < f64::EPSILON);
        assert_eq!(later.1.subpaths[0].segments.len(), 2);
        assert_eq!(
            later
                .0
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.25, 1.75]
        );
        assert_eq!(
            stroke_keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0]
        );
    }

    #[test]
    fn rejects_ambiguous_or_invalid_second_motion_in_one_edit_atomically() {
        let bundle = static_imported_bundle();
        let sequence = two_motion_sequence_command(&bundle);

        let mut overlapping_sequence = sequence.clone();
        let StudioMotionOperation::CreateMotion { interval, .. } =
            &mut overlapping_sequence.programs[0].operations[1]
        else {
            unreachable!();
        };
        interval.start = 0.75;

        let mut overlapping_parallel_buckets = overlapping_sequence.clone();
        let program = &mut overlapping_parallel_buckets.programs[0];
        let StudioMotionOperation::CreateMotion { depends_on, .. } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        program.requested_execution = SceneEditExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = SceneEditScheduleMode::Parallel;
        program.schedule_order.reverse();

        let mut invalid_target = sequence.clone();
        let StudioMotionOperation::CreateMotion {
            target_entity_ids, ..
        } = &mut invalid_target.programs[0].operations[1]
        else {
            unreachable!();
        };
        *target_entity_ids = vec!["source:missing".to_owned()];

        let mut overlapping_parallel = sequence;
        let program = &mut overlapping_parallel.programs[0];
        let StudioMotionOperation::CreateMotion {
            depends_on,
            easing,
            interval,
            ..
        } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        *easing = StudioMotionEasing::Smooth;
        *interval = IntervalV1 {
            end: 1.0,
            start: 0.5,
        };
        program.requested_execution = SceneEditExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = SceneEditScheduleMode::Parallel;

        for command in [
            overlapping_sequence,
            overlapping_parallel_buckets,
            invalid_target,
            overlapping_parallel,
        ] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(matches!(
                session.apply_studio_motion_edit(command),
                Err(ApplyStudioMotionEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn stitches_same_anchor_motions_for_one_entity_and_samples_each_curve() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_edit_input(
                &template,
                "first",
                0.5,
                1.0,
                vec!["source:later".to_owned()],
                PointV1 { x: 240.0, y: -80.0 },
                PointV1 { x: 0.0, y: -160.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_edit_input(
                &template,
                "second",
                0.5,
                1.0,
                vec!["source:later".to_owned()],
                PointV1 { x: 0.0, y: -120.0 },
                PointV1 { x: 80.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let motions = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } => Some((entity_id, keyframes, path)),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(motions.len(), 1);
        let (entity_id, keyframes, path) = motions[0];
        assert_eq!(entity_id, "later");
        assert_eq!(path.subpaths[0].segments.len(), 2);
        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.5]
        );
        assert!(matches!(
            keyframes[0].easing_to_next,
            Some(EasingV1::ManimSmooth {})
        ));
        assert!(matches!(
            keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        ));
        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);

        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "stitched-motion-sample",
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
                _ => panic!("motion target must remain a path draw"),
            }
        };
        for (time, expected) in [
            (0.5, PointV1 { x: 0.0, y: 0.0 }),
            (0.75, PointV1 { x: 3.0, y: 3.0 }),
            (1.0, PointV1 { x: 6.0, y: 2.0 }),
            (1.25, PointV1 { x: 7.0, y: 3.5 }),
            (1.5, PointV1 { x: 6.0, y: 5.0 }),
        ] {
            let sampled = sampled_transform(time);
            assert!((sampled.tx - expected.x).abs() < 1e-10, "time={time}");
            assert!((sampled.ty - expected.y).abs() < 1e-10, "time={time}");
        }
    }

    #[test]
    fn orders_distinct_root_motions_by_source_anchor_and_rebases_the_later_interval() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_edit_input(
                &template,
                "later-anchor",
                1.0,
                1.5,
                vec!["source:stroke".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
            studio_motion_edit_input(
                &template,
                "earlier-anchor",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let motions = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } => Some((entity_id.as_str(), keyframes, path)),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);
        assert_eq!(motions.len(), 2);
        assert_eq!(motions[0].0, "later");
        assert_eq!(
            motions[0]
                .1
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.25, 0.75]
        );
        assert_eq!(motions[0].2.subpaths[0].segments.len(), 1);
        assert_eq!(motions[1].0, "stroke");
        assert_eq!(
            motions[1]
                .1
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![1.5, 2.0]
        );
        assert_eq!(motions[1].2.subpaths[0].segments.len(), 1);
    }

    #[test]
    fn keeps_a_stationary_keyframe_across_gaps_between_motions() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_edit_input(
                &template,
                "before-gap",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_edit_input(
                &template,
                "after-gap",
                1.25,
                1.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let keyframes = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath { keyframes, .. } => Some(keyframes),
                _ => None,
            })
            .unwrap();

        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.25, 0.75, 1.75, 2.25]
        );
        assert!((keyframes[1].value - keyframes[2].value).abs() < f64::EPSILON);
        assert!(matches!(
            keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        ));
        assert!(matches!(
            keyframes[2].easing_to_next,
            Some(EasingV1::Linear {})
        ));
    }

    #[test]
    fn rejects_a_later_invalid_or_duplicate_motion_without_mutating_the_scene() {
        let bundle = static_imported_bundle();
        let mut valid = studio_motion_edit_command(&bundle);
        let template = valid.programs[0].clone();
        valid.programs = vec![
            studio_motion_edit_input(
                &template,
                "first-valid",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_edit_input(
                &template,
                "second-valid",
                1.0,
                1.5,
                vec!["source:stroke".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut invalid_target = valid.clone();
        let StudioMotionOperation::CreateMotion {
            target_entity_ids, ..
        } = &mut invalid_target.programs[1].operations[0]
        else {
            unreachable!();
        };
        *target_entity_ids = vec!["source:missing".to_owned()];

        let mut duplicate_id = valid;
        let first_id = duplicate_id.programs[0].operations[0].id().to_owned();
        let StudioMotionOperation::CreateMotion { id, .. } =
            &mut duplicate_id.programs[1].operations[0]
        else {
            unreachable!();
        };
        *id = first_id.clone();
        duplicate_id.programs[1].schedule_order = vec![first_id];

        for command in [invalid_target, duplicate_id] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(matches!(
                session.apply_studio_motion_edit(command),
                Err(ApplyStudioMotionEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn rejected_studio_motion_facts_preserve_the_retained_scene() {
        let bundle = static_imported_bundle();
        let mut rejected = Vec::new();

        let mut wrong_anchor = studio_motion_edit_command(&bundle);
        wrong_anchor.programs[0].anchor_resolved_seconds += 0.25;
        rejected.push(wrong_anchor);

        let mut wrong_schedule = studio_motion_edit_command(&bundle);
        wrong_schedule.programs[0].schedule_order[0] = "foreign".to_owned();
        rejected.push(wrong_schedule);

        let mut missing_dependency = studio_motion_edit_command(&bundle);
        let StudioMotionOperation::CreateMotion { depends_on, .. } =
            &mut missing_dependency.programs[0].operations[0]
        else {
            unreachable!();
        };
        *depends_on = vec!["missing-operation".to_owned()];
        rejected.push(missing_dependency);

        let mut mixed = studio_motion_edit_command(&bundle);
        mixed.programs[0]
            .operations
            .push(StudioMotionOperation::Unsupported {
                depends_on: vec![],
                id: "unsupported".to_owned(),
                interval: IntervalV1 {
                    end: 0.5,
                    start: 0.5,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        mixed.programs[0]
            .schedule_order
            .push("unsupported".to_owned());
        mixed.programs[0].schedule_edge_count = 1;
        rejected.push(mixed);

        let mut wrong_binding = studio_motion_edit_command(&bundle);
        wrong_binding.source_runtime_bindings[0].source_name = "other-source".to_owned();
        rejected.push(wrong_binding);

        for command in rejected {
            assert!(matches!(
                rejected_studio_motion(bundle.clone(), command),
                ApplyStudioMotionEditError::Unsupported
            ));
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact authored values and sampled endpoints verify the complete atomic motion"
    )]
    fn creates_one_quadratic_motion_channel_per_root_and_samples_it() {
        let bundle = imported_bundle();
        let command = motion_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.create_scene_motion(command.clone()).unwrap();
        let motion_channels: Vec<_> = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                } => Some((
                    entity_id,
                    id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                )),
                _ => None,
            })
            .collect();

        assert_eq!(motion_channels.len(), 2);
        for (index, (entity_id, id, keyframes, orient, parameterization, path, provenance)) in
            motion_channels.into_iter().enumerate()
        {
            assert_eq!(entity_id, &command.target_entity_ids[index]);
            assert_eq!(
                id,
                if index == 0 {
                    "studio-motion"
                } else {
                    "studio-motion-1"
                }
            );
            assert_eq!(keyframes[0].at, 0.5);
            assert_eq!(keyframes[0].value, 0.0);
            assert!(matches!(
                keyframes[0].easing_to_next,
                Some(EasingV1::ManimSmooth {})
            ));
            assert_eq!(keyframes[1].at, 1.5);
            assert_eq!(keyframes[1].value, 1.0);
            assert!(!orient);
            assert_eq!(
                *parameterization,
                Some(MotionPathParameterizationV1::ManimPointFromProportionV1)
            );
            assert_eq!(provenance, &command.provenance.id);
            let subpath = &path.subpaths[0];
            let segment = &subpath.segments[0];
            let start = if index == 0 {
                PointV1 { x: 3.0, y: -2.0 }
            } else {
                PointV1 { x: 0.0, y: 0.0 }
            };
            assert_eq!(subpath.start, start);
            assert!((segment.control1.x - (start.x + 2.0)).abs() < 1e-12);
            assert!((segment.control1.y - (start.y + 10.0 / 3.0)).abs() < 1e-12);
            assert!((segment.control2.x - (start.x + 4.0)).abs() < 1e-12);
            assert!((segment.control2.y - (start.y + 4.0)).abs() < 1e-12);
            assert_eq!(
                segment.end,
                PointV1 {
                    x: start.x + 6.0,
                    y: start.y + 2.0,
                }
            );
        }
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::MotionPathAnimation)
        );
        assert_eq!(result.scene.duration, 3.0);
        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "later")
                .unwrap()
                .lifetimes[0]
                .end,
            3.0
        );
        assert!(matches!(
            &result.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if keyframes[0].at == 0.0 && keyframes[1].at == 3.0
        ));
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(session.retained_index_stats().build_count, 2);

        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "authored-motion-sample",
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
                _ => panic!("motion target must remain a path draw"),
            }
        };
        assert_eq!(
            (sampled_transform(0.25).tx, sampled_transform(0.25).ty),
            (3.0, -2.0)
        );
        assert_eq!(
            (sampled_transform(0.5).tx, sampled_transform(0.5).ty),
            (3.0, -2.0)
        );
        let midpoint = sampled_transform(1.0);
        assert!((midpoint.tx - 6.0).abs() < 1e-12);
        assert!((midpoint.ty - 1.0).abs() < 1e-12);
        assert_eq!(
            (sampled_transform(1.5).tx, sampled_transform(1.5).ty),
            (9.0, 0.0)
        );
    }

    #[test]
    fn rejected_motion_commands_preserve_the_retained_scene() {
        let bundle = imported_bundle();

        let mut duplicate = motion_command(&bundle);
        duplicate.target_entity_ids = vec!["later".to_owned(), "later".to_owned()];
        assert!(matches!(
            rejected_motion(bundle.clone(), duplicate),
            ApplyStudioMotionEditError::DuplicateTarget(id) if id == "later"
        ));

        let mut no_op = motion_command(&bundle);
        no_op.delta = PointV1 { x: 0.0, y: 0.0 };
        no_op.control_offset = PointV1 { x: 0.0, y: 0.0 };
        assert!(matches!(
            rejected_motion(bundle.clone(), no_op),
            ApplyStudioMotionEditError::InvalidMotion
        ));

        let mut inactive_bundle = bundle.clone();
        inactive_bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap()
            .lifetimes[0]
            .end = 1.0;
        let inactive = motion_command(&inactive_bundle);
        assert!(matches!(
            rejected_motion(inactive_bundle, inactive),
            ApplyStudioMotionEditError::TargetInactive(id) if id == "later"
        ));

        let animated = fixture_bundle("manim-motion-path.json");
        let mut already_animated = motion_command(&animated);
        already_animated.target_entity_ids = vec!["mover".to_owned()];
        assert!(matches!(
            rejected_motion(animated, already_animated),
            ApplyStudioMotionEditError::AnimatedTransformUnsupported(id) if id == "mover"
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
        let mut nested_target = motion_command(&nested);
        nested_target.interval = IntervalV1 {
            start: 0.0,
            end: 1.0,
        };
        nested_target.target_entity_ids = vec![child_id.clone()];
        assert!(matches!(
            rejected_motion(nested, nested_target),
            ApplyStudioMotionEditError::TargetIsNotRoot(id) if id == child_id
        ));
    }

    #[test]
    fn motion_projector_expands_multi_target_and_accumulates_sequential_segments() {
        let bundle = static_imported_bundle();
        let command = two_motion_sequence_command(&bundle);
        let projection = project_studio_motion_edit(&ProjectStudioMotionEditCommand {
            base_duration: bundle.scene.duration,
            batch: StudioMotionProjectionBatch::Standalone {
                programs: command.programs,
                studio_entities: vec![
                    StudioMotionProjectionEntityIdentity {
                        identity: command.studio_entities[0].clone(),
                        lifetime: vec![IntervalV1 {
                            end: bundle.scene.duration,
                            start: 0.0,
                        }],
                        position: PointV1 { x: 320.0, y: 180.0 },
                    },
                    StudioMotionProjectionEntityIdentity {
                        identity: command.studio_entities[1].clone(),
                        lifetime: vec![IntervalV1 {
                            end: bundle.scene.duration,
                            start: 0.0,
                        }],
                        position: PointV1 { x: 100.0, y: 80.0 },
                    },
                ],
            },
        })
        .unwrap();

        assert_eq!(projection.insertions.len(), 1);
        assert_eq!(projection.motions.len(), 2);
        assert_eq!(projection.motions[0].from, PointV1 { x: 320.0, y: 180.0 });
        assert_eq!(projection.motions[0].to, PointV1 { x: 560.0, y: 100.0 });
        assert_eq!(
            projection
                .motions
                .iter()
                .map(|motion| motion.easing)
                .collect::<Vec<_>>(),
            vec![
                StudioProjectionEasing::ManimSmooth,
                StudioProjectionEasing::Linear,
            ]
        );
        assert_eq!(projection.motions[1].from, projection.motions[0].to);
        assert_eq!(projection.motions[1].to, PointV1 { x: 560.0, y: -20.0 });
    }
}
