use std::collections::{BTreeMap, BTreeSet};

use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, CubicPathV1, EasingV1, FidelityV1, FillRuleV1,
    FillStyleV1, IntervalV1, KeyframeV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1,
    RgbaColorV1, SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1, SceneGeometryV1,
    SceneIrBundleV1, SceneSourceV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
};
use serde::{Deserialize, Serialize};

use crate::{EngineSessionV1, EvaluationError};

mod bound_entity;
mod creation;
mod identity;
mod math_tex_transform;
mod motion;
mod presence;
mod timeline;
mod transform;

pub use bound_entity::{
    ApplyStudioBoundEntityEditCommand, ApplyStudioBoundEntityEditError,
    StudioBoundEntityAnchorSource, StudioBoundEntityEditCandidate,
    StudioBoundEntityEditCapabilities, StudioBoundEntityEditInput, StudioBoundEntityEditPhase,
    StudioBoundEntityEditResult, StudioBoundEntityExecution, StudioBoundEntityOperation,
    StudioBoundEntityProjection, StudioBoundEntityProjectionMutation,
    StudioBoundEntityScheduleMode,
};
pub use creation::{
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError, CreateSceneEntitiesError,
    ProjectStudioCreationEditError, StudioCreationEditInput, StudioCreationEntitySpec,
    StudioCreationOperation, StudioCreationOperationKind, StudioCreationProjectedMutation,
    StudioCreationProjectedMutationKind, StudioCreationProjection, StudioProjectedCreationEntity,
    project_studio_creation_edits,
};
use identity::resolve_static_root_binding;
pub use identity::{
    StaticRootMotionProjectionEntityIdentity, StaticRootTransformSourceBinding,
    StaticRootTransformStudioEntity, StudioMathTexTransformEntityIdentity,
    StudioMathTexTransformProjectionEntityIdentity, StudioMathTexTransformSourceBinding,
    StudioMotionEntityIdentity, StudioMotionProjectionEntityIdentity, StudioMotionSourceBinding,
};
pub use math_tex_transform::{
    ApplyStudioMathTexTransformEditCommand, ApplyStudioMathTexTransformEditError,
    StudioMathTexTransformEditInput, StudioMathTexTransformOperation,
    StudioMathTexTransformOutline, StudioMathTexTransformProjectedReplacement,
    StudioMathTexTransformProjection, StudioMathTexTransformStrategy,
    project_studio_math_tex_transform_edits,
};
pub use motion::{
    ApplyStudioMotionEditCommand, ApplyStudioMotionEditError, ProjectStudioMotionEditError,
    StudioMotionEasing, StudioMotionEditInput, StudioMotionOperation, StudioMotionProjection,
    StudioMotionProjectionInsertion, StudioProjectedMotion,
};
use motion::{
    CreateSceneMotionCommand, PlannedSceneMotion, StudioMotionProjectionTarget,
    append_planned_scene_motions, one_projection_lifetime, plan_studio_motion_edits,
    project_standalone_motion_edits, project_studio_motion_plan,
    validate_create_scene_motion_command,
};
pub use presence::{
    ApplyStudioPersistentRemoveError, StudioPersistentRemoveProjection,
    StudioPersistentRemoveProjectionEntry,
};
use presence::{PersistentSceneRemoval, apply_persistent_scene_removals};
pub use timeline::{
    ApplyStudioTimelineEditCommand, ApplyStudioTimelineEditError, StudioTimelineEditInput,
    StudioTimelineEditProjection, StudioTimelineEditTransform, StudioTimelineEventKind,
    StudioTimelineOperation, StudioTimelineProjection, StudioTimelinePurpose,
    StudioTimelineWaitReduction, project_studio_timeline_edits,
};
use timeline::{SceneTimelineInsertion, insert_scene_time, shift_interval_for_insertion};
#[cfg(test)]
use transform::scene_entity_world_center;
#[allow(
    unused_imports,
    reason = "preserve the existing authoring API while the primitive methods remain crate-private"
)]
pub use transform::{
    RotateSceneEntityCommand, RotateSceneEntityError, ScaleAboutPivot,
    SetSubtreeVectorPaintAlphaCommand, SetSubtreeVectorPaintAlphaError,
    TransformSceneEntityAtTimeCommand,
};
pub use transform::{
    SceneEntityAxisFactors, TransformSceneEntityCommand, TransformSceneEntityError,
    TransformSceneEntityExpectedBaseline, TransformSceneEntityIntent,
};
use transform::{
    apply_world_axis_scale, fit_cubic_path_to_local_height_and_center, has_animated_transform,
    resolve_transform_intent, scene_entity_local_bounds,
};

const TIMELINE_ANCHOR_EPSILON: f64 = 0.0005;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioStaticRootMutation {
    Position {
        entity_id: String,
        interval: IntervalV1,
        value: PointV1,
    },
    UniformScale {
        #[serde(skip_serializing_if = "Option::is_none")]
        easing: Option<StudioProjectionEasing>,
        entity_id: String,
        from: f64,
        interval: IntervalV1,
        to: f64,
    },
    Resize {
        entity_id: String,
        from_dimensions: StudioAuthoringDimensions,
        from_position: PointV1,
        interval: IntervalV1,
        to_dimensions: StudioAuthoringDimensions,
        to_position: PointV1,
    },
    MathTexContent {
        content: StudioMathTexContent,
        entity_id: String,
        interval: IntervalV1,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioProjectionEasing {
    Linear,
    ManimSmooth,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStaticRootProjectedMutation {
    #[serde(flatten)]
    pub mutation: StudioStaticRootMutation,
    pub operation_id: String,
    pub transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStaticRootProjection {
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub mutations: Vec<StudioStaticRootProjectedMutation>,
    pub projected_duration: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioAuthoringEditResult {
    pub bundle: SceneIrBundleV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_projection: Option<StudioCreationProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math_tex_transform_projection: Option<StudioMathTexTransformProjection>,
    pub persistent_remove_projection: StudioPersistentRemoveProjection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion_projection: Option<StudioMotionProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_root_projection: Option<StudioStaticRootProjection>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioAuthoringOrigin {
    DirectManipulation,
    Fixture,
    RemoteModel,
    StudioDefault,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SceneEditExecution {
    Parallel,
    Sequence,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SceneEditScheduleMode {
    DependencyDag,
    Parallel,
    Sequence,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SceneEditAnchorSource {
    Absolute { seconds: Option<f64> },
    Playhead { reference_seconds: Option<f64> },
    Unsupported,
}

/// One closed motion-bearing Studio batch accepted by the snapshot-free projector.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioMotionProjectionBatch {
    Standalone {
        programs: Vec<StudioMotionEditInput>,
        studio_entities: Vec<StudioMotionProjectionEntityIdentity>,
    },
    StaticRoot {
        programs: Vec<StaticRootTransformEditInput>,
        studio_entities: Vec<StaticRootMotionProjectionEntityIdentity>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStudioMotionEditCommand {
    pub base_duration: f64,
    pub batch: StudioMotionProjectionBatch,
}

/// Canonical editable content carried by one static `MathTex` replacement.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexContent {
    pub display_lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub tex_parts: Vec<String>,
}

pub type StaticRootTransformOrigin = StudioAuthoringOrigin;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioAuthoringEntityKind {
    Circle,
    Image,
    Line,
    MathTex,
    Other,
    Rectangle,
}

pub type StaticRootTransformEntityKind = StudioAuthoringEntityKind;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringSize {
    pub height: f64,
    pub width: f64,
}

pub type StaticRootTransformSize = StudioAuthoringSize;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringDimensions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
}

pub type StaticRootTransformDimensions = StudioAuthoringDimensions;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StaticRootTransformOperationKind {
    Position {
        position: Option<PointV1>,
    },
    UniformScale {
        control_present: bool,
        from: Option<f64>,
        relative_factor: Option<f64>,
        to: Option<f64>,
    },
    Resize {
        from_dimensions: StaticRootTransformDimensions,
        from_position: PointV1,
        from_scale: f64,
        shape: StaticRootTransformEntityKind,
        to_dimensions: StaticRootTransformDimensions,
        to_position: PointV1,
    },
    PersistentRemove {
        persistent: bool,
    },
    CreateMotion {
        control_offset: PointV1,
        delta: PointV1,
        easing: StudioMotionEasing,
        target_entity_ids: Vec<String>,
    },
    MathTexContent {
        content: StudioMathTexContent,
    },
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticRootTransformOperation {
    pub depends_on: Vec<String>,
    pub entity_id: Option<String>,
    pub id: String,
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub kind: StaticRootTransformOperationKind,
    pub origin: StaticRootTransformOrigin,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootTransformEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: SceneEditAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StaticRootTransformOperation>,
    pub origin: StaticRootTransformOrigin,
    pub requested_execution: SceneEditExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: SceneEditScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStaticRootTransformEditCommand {
    pub expected_base_revision: String,
    pub frame: StaticRootTransformSize,
    pub math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    pub next_revision: String,
    pub programs: Vec<StaticRootTransformEditInput>,
    pub source_runtime_bindings: Vec<StaticRootTransformSourceBinding>,
    pub studio_entities: Vec<StaticRootTransformStudioEntity>,
    pub viewport: StaticRootTransformSize,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationMathTexOutline {
    pub entity_id: String,
    pub path: CubicPathV1,
    pub tex_parts: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStaticRootTransformEditError {
    #[error("the normalized Studio edit does not authorize one imported-root static edit batch")]
    Unsupported,
    #[error(transparent)]
    Transform(#[from] TransformSceneEntityError),
    #[error(transparent)]
    PersistentRemove(#[from] ApplyStudioPersistentRemoveError),
    #[error("the edited Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

fn close_transform_baseline_value(left: f64, right: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= 1.0e-9 * left.abs().max(right.abs()).max(1.0)
}

fn studio_authoring_point_is_finite(point: &PointV1) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

fn studio_authoring_size_is_positive(size: StudioAuthoringSize) -> bool {
    size.width.is_finite() && size.width > 0.0 && size.height.is_finite() && size.height > 0.0
}

fn studio_authoring_shape_size(
    kind: StudioAuthoringEntityKind,
    dimensions: StudioAuthoringDimensions,
) -> Option<StudioAuthoringSize> {
    match (kind, dimensions.radius, dimensions.width, dimensions.height) {
        (StaticRootTransformEntityKind::Circle, Some(radius), None, None)
            if radius.is_finite() && radius > 0.0 =>
        {
            Some(StudioAuthoringSize {
                height: radius * 2.0,
                width: radius * 2.0,
            })
        }
        (StaticRootTransformEntityKind::Rectangle, None, Some(width), Some(height))
            if width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0 =>
        {
            Some(StudioAuthoringSize { height, width })
        }
        _ => None,
    }
}

fn studio_point_to_scene_point(
    point: &PointV1,
    frame: StudioAuthoringSize,
    viewport: StudioAuthoringSize,
    camera_center: &PointV1,
) -> PointV1 {
    PointV1 {
        x: camera_center.x + (point.x / viewport.width - 0.5) * frame.width,
        y: camera_center.y + (0.5 - point.y / viewport.height) * frame.height,
    }
}

fn studio_vector_to_scene_vector(
    vector: &PointV1,
    frame: StudioAuthoringSize,
    viewport: StudioAuthoringSize,
) -> PointV1 {
    PointV1 {
        x: vector.x / viewport.width * frame.width,
        y: -vector.y / viewport.height * frame.height,
    }
}

#[derive(Clone, Copy)]
struct SceneEditOperationFacts<'a> {
    depends_on: &'a [String],
    id: &'a str,
}

fn scene_edit_source_seconds(
    source: &SceneEditAnchorSource,
    captured_playhead: f64,
) -> Option<f64> {
    if !captured_playhead.is_finite() || captured_playhead < 0.0 {
        return None;
    }
    match source {
        SceneEditAnchorSource::Absolute {
            seconds: Some(seconds),
        } if seconds.is_finite() && *seconds >= 0.0 => Some(*seconds),
        SceneEditAnchorSource::Playhead {
            reference_seconds: Some(reference_seconds),
        } if reference_seconds.is_finite()
            && *reference_seconds >= 0.0
            && (*reference_seconds - captured_playhead).abs() < 0.001 =>
        {
            Some(*reference_seconds)
        }
        SceneEditAnchorSource::Absolute { seconds: None }
        | SceneEditAnchorSource::Playhead {
            reference_seconds: None,
        }
        | SceneEditAnchorSource::Unsupported
        | SceneEditAnchorSource::Absolute { .. }
        | SceneEditAnchorSource::Playhead { .. } => None,
    }
}

fn scene_edit_anchor_is_closed(
    source: &SceneEditAnchorSource,
    captured_playhead: f64,
    resolved_seconds: f64,
    scene_duration: f64,
) -> bool {
    scene_edit_source_seconds(source, captured_playhead).is_some_and(|source_seconds| {
        resolved_seconds.is_finite()
            && resolved_seconds >= 0.0
            && resolved_seconds <= scene_duration + TIMELINE_ANCHOR_EPSILON
            && studio_timeline_semantic_values_match(source_seconds, resolved_seconds)
    })
}

fn scene_edit_structure_is_closed(
    operations: &[SceneEditOperationFacts<'_>],
    requested_execution: SceneEditExecution,
    schedule_edge_count: usize,
    schedule_mode: SceneEditScheduleMode,
    schedule_order: &[String],
    derived_edges: &[(&str, &str)],
) -> bool {
    if operations.is_empty() || operations.len() != schedule_order.len() {
        return false;
    }
    let operation_ids = operations
        .iter()
        .map(|operation| operation.id)
        .collect::<BTreeSet<_>>();
    let scheduled_ids = schedule_order
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if operation_ids.len() != operations.len()
        || operation_ids.iter().any(|id| id.is_empty())
        || scheduled_ids.len() != schedule_order.len()
        || operation_ids != scheduled_ids
    {
        return false;
    }

    let mut explicit_edges = BTreeSet::new();
    for operation in operations {
        let mut dependencies = BTreeSet::new();
        for dependency in operation.depends_on {
            if dependency == operation.id
                || !operation_ids.contains(dependency.as_str())
                || !dependencies.insert(dependency.as_str())
            {
                return false;
            }
            explicit_edges.insert((dependency.as_str(), operation.id));
        }
    }
    if requested_execution == SceneEditExecution::Sequence {
        for pair in operations.windows(2) {
            explicit_edges.insert((pair[0].id, pair[1].id));
        }
    }

    let mut semantic_edges = BTreeSet::new();
    for (from, to) in derived_edges {
        if from == to || !operation_ids.contains(from) || !operation_ids.contains(to) {
            return false;
        }
        semantic_edges.insert((*from, *to));
    }
    let expected_edge_count = explicit_edges.len() + semantic_edges.len();
    let expected_mode = match requested_execution {
        SceneEditExecution::Sequence => SceneEditScheduleMode::Sequence,
        SceneEditExecution::Parallel if expected_edge_count == 0 => SceneEditScheduleMode::Parallel,
        SceneEditExecution::Parallel => SceneEditScheduleMode::DependencyDag,
    };
    if schedule_edge_count != expected_edge_count || schedule_mode != expected_mode {
        return false;
    }

    explicit_edges
        .iter()
        .chain(semantic_edges.iter())
        .all(|(from, to)| {
            schedule_order.iter().position(|id| id == from)
                < schedule_order.iter().position(|id| id == to)
        })
}

fn studio_math_tex_content_is_canonical(content: &StudioMathTexContent) -> bool {
    !content.display_lines.is_empty()
        && !content.tex_parts.is_empty()
        && content.tex_parts.iter().all(|part| !part.trim().is_empty())
}

fn static_root_transform_edit_input_is_closed(program: &StaticRootTransformEditInput) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| SceneEditOperationFacts {
            depends_on: &operation.depends_on,
            id: &operation.id,
        })
        .collect::<Vec<_>>();
    (1..=16).contains(&program.intent_count)
        && scene_edit_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &[],
        )
}

fn static_root_motion_edit_input(
    program: &StaticRootTransformEditInput,
) -> Option<StudioMotionEditInput> {
    let operations = program
        .operations
        .iter()
        .map(|operation| {
            let StaticRootTransformOperationKind::CreateMotion {
                control_offset,
                delta,
                easing,
                target_entity_ids,
            } = &operation.kind
            else {
                return None;
            };
            if operation.entity_id.is_some() {
                return None;
            }
            Some(StudioMotionOperation::CreateMotion {
                control_offset: control_offset.clone(),
                delta: delta.clone(),
                depends_on: operation.depends_on.clone(),
                easing: *easing,
                id: operation.id.clone(),
                interval: operation.interval.clone(),
                origin: operation.origin,
                target_entity_ids: target_entity_ids.clone(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(StudioMotionEditInput {
        anchor_captured_playhead: program.anchor_captured_playhead,
        anchor_resolved_seconds: program.anchor_resolved_seconds,
        anchor_source: program.anchor_source.clone(),
        intent_count: program.intent_count,
        lowering_supported: program.lowering_supported,
        operations,
        origin: program.origin,
        requested_execution: program.requested_execution,
        schedule_edge_count: program.schedule_edge_count,
        schedule_mode: program.schedule_mode,
        schedule_order: program.schedule_order.clone(),
        transaction_id: program.transaction_id.clone(),
    })
}

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "exact zero and normalized scale are closed Studio authority facts; the bounded family admission stays atomic"
)]
fn project_static_root_motion_edits(
    base_duration: f64,
    programs: &[StaticRootTransformEditInput],
    studio_entities: &[StaticRootMotionProjectionEntityIdentity],
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    let operation_count = programs
        .iter()
        .map(|program| program.operations.len())
        .sum::<usize>();
    if !base_duration.is_finite()
        || base_duration <= 0.0
        || programs.is_empty()
        || operation_count == 0
        || operation_count > 16
        || programs.iter().any(|program| {
            !program.lowering_supported
                || program.transaction_id.is_empty()
                || !scene_edit_anchor_is_closed(
                    &program.anchor_source,
                    program.anchor_captured_playhead,
                    program.anchor_resolved_seconds,
                    base_duration,
                )
                || !static_root_transform_edit_input_is_closed(program)
                || program
                    .operations
                    .iter()
                    .any(|operation| operation.origin != program.origin)
        })
    {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }

    let mut ordered = (0..programs.len()).collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        programs[*left]
            .anchor_resolved_seconds
            .total_cmp(&programs[*right].anchor_resolved_seconds)
            .then(left.cmp(right))
    });
    let mut static_indexes = Vec::new();
    let mut motion_programs = Vec::new();
    let mut reached_motion = false;
    for index in ordered {
        let program = &programs[index];
        let motion_count = program
            .operations
            .iter()
            .filter(|operation| {
                matches!(
                    operation.kind,
                    StaticRootTransformOperationKind::CreateMotion { .. }
                )
            })
            .count();
        if motion_count > 0 {
            if motion_count != program.operations.len() {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            reached_motion = true;
            motion_programs.push(
                static_root_motion_edit_input(program)
                    .ok_or(ProjectStudioMotionEditError::Unsupported)?,
            );
        } else {
            if reached_motion {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            static_indexes.push(index);
        }
    }
    if motion_programs.is_empty() || static_indexes.is_empty() {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }

    let mut operation_ids = BTreeSet::new();
    let mut transformed_entity_id: Option<String> = None;
    let mut transform_count = 0_usize;
    let mut position: Option<PointV1> = None;
    let mut uniform_scale_from: Option<f64> = None;
    let mut resize: Option<(
        StudioAuthoringEntityKind,
        StudioAuthoringDimensions,
        PointV1,
        f64,
        StudioAuthoringDimensions,
        PointV1,
    )> = None;
    for index in static_indexes {
        let program = &programs[index];
        for scheduled_id in &program.schedule_order {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *scheduled_id)
                .ok_or(ProjectStudioMotionEditError::Unsupported)?;
            let entity_id = operation
                .entity_id
                .as_deref()
                .filter(|entity_id| !entity_id.is_empty())
                .ok_or(ProjectStudioMotionEditError::Unsupported)?;
            if operation.id.is_empty()
                || !operation_ids.insert(operation.id.as_str())
                || !studio_timeline_semantic_values_match(program.anchor_resolved_seconds, 0.0)
                || !studio_timeline_semantic_values_match(operation.interval.start, 0.0)
                || !studio_timeline_semantic_values_match(operation.interval.end, 0.0)
                || transformed_entity_id
                    .as_deref()
                    .is_some_and(|expected| expected != entity_id)
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            transformed_entity_id.get_or_insert_with(|| entity_id.to_owned());
            transform_count += 1;
            match &operation.kind {
                StaticRootTransformOperationKind::Position {
                    position: Some(target),
                } if matches!(
                    operation.origin,
                    StudioAuthoringOrigin::DirectManipulation
                        | StudioAuthoringOrigin::StudioDefault
                ) && studio_authoring_point_is_finite(target)
                    && position.replace(target.clone()).is_none() => {}
                StaticRootTransformOperationKind::UniformScale {
                    control_present,
                    from: Some(from),
                    relative_factor: Some(factor),
                    to: Some(to),
                } if operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && !*control_present
                    && factor.is_finite()
                    && *factor > 0.0
                    && *factor != 1.0
                    && from.is_finite()
                    && *from > 0.0
                    && to.is_finite()
                    && *to > 0.0
                    && close_transform_baseline_value(*to / *from, *factor)
                    && uniform_scale_from.replace(*from).is_none() => {}
                StaticRootTransformOperationKind::Resize {
                    from_dimensions,
                    from_position,
                    from_scale,
                    shape,
                    to_dimensions,
                    to_position,
                } if matches!(
                    *shape,
                    StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle
                ) && matches!(
                    operation.origin,
                    StudioAuthoringOrigin::DirectManipulation
                        | StudioAuthoringOrigin::StudioDefault
                ) && studio_authoring_point_is_finite(from_position)
                    && studio_authoring_point_is_finite(to_position)
                    && from_scale.is_finite()
                    && *from_scale > 0.0
                    && resize
                        .replace((
                            *shape,
                            *from_dimensions,
                            from_position.clone(),
                            *from_scale,
                            *to_dimensions,
                            to_position.clone(),
                        ))
                        .is_none() => {}
                StaticRootTransformOperationKind::Position { .. }
                | StaticRootTransformOperationKind::UniformScale { .. }
                | StaticRootTransformOperationKind::Resize { .. }
                | StaticRootTransformOperationKind::PersistentRemove { .. }
                | StaticRootTransformOperationKind::CreateMotion { .. }
                | StaticRootTransformOperationKind::MathTexContent { .. }
                | StaticRootTransformOperationKind::Unsupported => {
                    return Err(ProjectStudioMotionEditError::Unsupported);
                }
            }
        }
    }
    if transform_count == 0
        || transform_count > 2
        || resize.is_some() && transform_count != 1
        || resize.is_none() && position.is_none() && uniform_scale_from.is_none()
    {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }

    let plan = plan_studio_motion_edits(base_duration, &motion_programs)?;
    if plan
        .motions
        .iter()
        .any(|motion| !operation_ids.insert(motion.operation_id.as_str()))
    {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }
    let target_ids = plan
        .motions
        .iter()
        .flat_map(|motion| motion.target_entity_ids.iter())
        .chain(transformed_entity_id.iter())
        .collect::<BTreeSet<_>>();
    let mut targets = BTreeMap::new();
    for target_id in target_ids {
        let mut matching = studio_entities.iter().filter(|entity| {
            entity.identity.object_graph_key == *target_id && entity.identity.id == *target_id
        });
        let entity = matching
            .next()
            .filter(|entity| {
                !entity.identity.provisional
                    && entity.identity.transaction_id.is_none()
                    && entity
                        .identity
                        .source_identity
                        .as_deref()
                        .is_some_and(|identity| !identity.is_empty())
            })
            .filter(|_| matching.next().is_none())
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let lifetime = one_projection_lifetime(&entity.lifetime)
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let mut target_position = entity
            .identity
            .position
            .as_ref()
            .filter(|position| studio_authoring_point_is_finite(position))
            .cloned()
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        if transformed_entity_id.as_deref() == Some(target_id.as_str()) {
            if let Some((
                shape,
                from_dimensions,
                from_position,
                from_scale,
                to_dimensions,
                to_position,
            )) = &resize
            {
                if entity.identity.kind != *shape
                    || entity.identity.dimensions != *from_dimensions
                    || entity
                        .identity
                        .scale
                        .is_none_or(|scale| !close_transform_baseline_value(scale, *from_scale))
                    || !close_transform_baseline_value(target_position.x, from_position.x)
                    || !close_transform_baseline_value(target_position.y, from_position.y)
                    || studio_authoring_shape_size(*shape, *to_dimensions).is_none()
                {
                    return Err(ProjectStudioMotionEditError::Unsupported);
                }
                target_position.clone_from(to_position);
            } else {
                if uniform_scale_from.is_some_and(|from| {
                    entity
                        .identity
                        .scale
                        .is_none_or(|scale| !close_transform_baseline_value(scale, from))
                }) {
                    return Err(ProjectStudioMotionEditError::Unsupported);
                }
                if let Some(target) = &position {
                    target_position.clone_from(target);
                }
            }
        }
        targets.insert(
            target_id.clone(),
            StudioMotionProjectionTarget {
                lifetime,
                position: target_position,
            },
        );
    }
    project_studio_motion_plan(&plan, targets)
}

/// Projects one exact supported motion-bearing Studio batch without a Scene snapshot.
///
/// # Errors
///
/// Returns `Unsupported` when the complete normalized batch or logical entity facts are outside
/// the closed motion subset.
pub fn project_studio_motion_edit(
    command: &ProjectStudioMotionEditCommand,
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    match &command.batch {
        StudioMotionProjectionBatch::Standalone {
            programs,
            studio_entities,
        } => project_standalone_motion_edits(command.base_duration, programs, studio_entities),
        StudioMotionProjectionBatch::StaticRoot {
            programs,
            studio_entities,
        } => project_static_root_motion_edits(command.base_duration, programs, studio_entities),
    }
}

fn static_transform_geometry_matches(
    kind: StaticRootTransformEntityKind,
    entity: &SceneEntityV1,
) -> bool {
    match kind {
        StaticRootTransformEntityKind::Circle => {
            matches!(
                entity.geometry,
                SceneGeometryV1::Circle { .. } | SceneGeometryV1::CubicPath { .. }
            ) && matches!(entity.appearance, SceneAppearanceV1::Vector { .. })
        }
        StaticRootTransformEntityKind::Rectangle => {
            matches!(
                entity.geometry,
                SceneGeometryV1::Rectangle { .. } | SceneGeometryV1::CubicPath { .. }
            ) && matches!(entity.appearance, SceneAppearanceV1::Vector { .. })
        }
        StaticRootTransformEntityKind::Image => {
            matches!(entity.geometry, SceneGeometryV1::Image { .. })
                && matches!(entity.appearance, SceneAppearanceV1::Image { .. })
        }
        StaticRootTransformEntityKind::Line => {
            matches!(
                entity.geometry,
                SceneGeometryV1::Line { .. } | SceneGeometryV1::CubicPath { .. }
            ) && matches!(entity.appearance, SceneAppearanceV1::Vector { .. })
        }
        StaticRootTransformEntityKind::MathTex => {
            matches!(entity.geometry, SceneGeometryV1::CubicPath { .. })
                && matches!(entity.appearance, SceneAppearanceV1::Vector { .. })
        }
        StaticRootTransformEntityKind::Other => true,
    }
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

fn studio_timeline_semantic_values_match(left: f64, right: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= 1e-9 * left.abs().max(right.abs()).max(1.0)
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

impl EngineSessionV1 {
    /// Applies the exact one-operation `MathTex` content family admitted by the static-root API.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "zero-duration admission and the single plan-before-commit path are one closed authoring contract"
    )]
    fn apply_static_root_math_tex_content_edit(
        &mut self,
        command: ApplyStaticRootTransformEditCommand,
    ) -> Result<StudioAuthoringEditResult, ApplyStaticRootTransformEditError> {
        let ApplyStaticRootTransformEditCommand {
            expected_base_revision,
            frame,
            math_tex_outlines,
            next_revision,
            programs,
            source_runtime_bindings,
            studio_entities,
            viewport,
        } = command;
        let scene = self.scene();
        if scene.source.revision_hash() != expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision.into());
        }
        if next_revision == expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance.into());
        }
        let provenance_id = format!("studio-static-math-tex-content:{next_revision}");
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.len() != 1
            || math_tex_outlines.len() != 1
            || scene
                .provenance
                .iter()
                .any(|record| record.id == provenance_id)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let program = &programs[0];
        if !program.lowering_supported
            || program.origin != StudioAuthoringOrigin::StudioDefault
            || program.transaction_id.is_empty()
            || program.intent_count != 1
            || program.operations.len() != 1
            || program.requested_execution != SceneEditExecution::Parallel
            || !static_root_transform_edit_input_is_closed(program)
            || !scene_edit_anchor_is_closed(
                &program.anchor_source,
                program.anchor_captured_playhead,
                program.anchor_resolved_seconds,
                scene.duration,
            )
            || !studio_timeline_semantic_values_match(program.anchor_resolved_seconds, 0.0)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let operation = &program.operations[0];
        let StaticRootTransformOperationKind::MathTexContent { content } = &operation.kind else {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        };
        let entity_id = operation
            .entity_id
            .as_deref()
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if entity_id.is_empty()
            || operation.id.is_empty()
            || operation.origin != program.origin
            || !studio_math_tex_content_is_canonical(content)
            || !studio_timeline_semantic_values_match(operation.interval.start, 0.0)
            || !studio_timeline_semantic_values_match(operation.interval.end, 0.0)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let (studio_entity, source) = resolve_static_root_binding(
            scene,
            &studio_entities,
            &source_runtime_bindings,
            entity_id,
        )
        .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let mut matching_outlines = math_tex_outlines.iter().filter(|outline| {
            outline.entity_id == entity_id && outline.tex_parts == content.tex_parts
        });
        let outline = matching_outlines
            .next()
            .filter(|_| matching_outlines.next().is_none())
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let source_index = scene
            .entities
            .iter()
            .position(|entity| entity.id == source.id)
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let source_lifetime = source
            .lifetimes
            .first()
            .filter(|_| source.lifetimes.len() == 1)
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if studio_entity.kind != StaticRootTransformEntityKind::MathTex
            || source.parent_id.is_some()
            || !matches!(source.geometry, SceneGeometryV1::CubicPath { .. })
            || !matches!(&source.appearance, SceneAppearanceV1::Vector { .. })
            || scene
                .animation_channels
                .iter()
                .any(|channel| channel.entity_id() == Some(source.id.as_str()))
            || source_lifetime.start > 0.0
            || source_lifetime.end <= 0.0
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let source_bounds = scene_entity_local_bounds(source)
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let fitted_path = fit_cubic_path_to_local_height_and_center(&outline.path, &source_bounds)
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        candidate.scene.entities[source_index].geometry =
            SceneGeometryV1::CubicPath { path: fitted_path };
        provenance_id.clone_into(&mut candidate.scene.entities[source_index].provenance_id);
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec![
                "Studio MathTex content replacement uses one correlated compiled outline."
                    .to_owned(),
            ],
            id: provenance_id,
            origin: ProvenanceOriginV1::StudioEditProgram,
        });
        if matches!(candidate.scene.fidelity, FidelityV1::Exact {}) {
            candidate.scene.fidelity = FidelityV1::Approximate {
                evidence: vec![
                    "Studio MathTex content replacement uses a browser-compiled outline."
                        .to_owned(),
                ],
            };
        }
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };
        let result = StudioAuthoringEditResult {
            bundle: candidate.clone(),
            creation_projection: None,
            math_tex_transform_projection: None,
            motion_projection: None,
            persistent_remove_projection: StudioPersistentRemoveProjection::default(),
            static_root_projection: Some(StudioStaticRootProjection {
                insertions: vec![],
                mutations: vec![StudioStaticRootProjectedMutation {
                    mutation: StudioStaticRootMutation::MathTexContent {
                        content: content.clone(),
                        entity_id: entity_id.to_owned(),
                        interval: operation.interval.clone(),
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                }],
                projected_duration: candidate.scene.duration,
            }),
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Applies the one closed Magic Edit sequence that animates a uniform scale and then removes
    /// the same imported root.
    ///
    /// The sequence inserts its authored duration into the source timeline. The affine animation,
    /// persistent removal, and Studio projection are committed together so no caller can observe a
    /// scaled-but-not-removed intermediate revision.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the narrow scale/remove admission and its single atomic candidate stay together"
    )]
    fn apply_animated_scale_then_remove_edit(
        &mut self,
        command: ApplyStaticRootTransformEditCommand,
    ) -> Result<StudioAuthoringEditResult, ApplyStaticRootTransformEditError> {
        let ApplyStaticRootTransformEditCommand {
            expected_base_revision,
            frame,
            math_tex_outlines,
            next_revision,
            programs,
            source_runtime_bindings,
            studio_entities,
            viewport,
        } = command;
        let scene = self.scene();
        if scene.source.revision_hash() != expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision.into());
        }
        if next_revision == expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance.into());
        }
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || !math_tex_outlines.is_empty()
            || programs.len() != 1
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let program = &programs[0];
        if !program.lowering_supported
            || program.transaction_id.is_empty()
            || program.intent_count != 2
            || program.operations.len() != 2
            || program.origin != StudioAuthoringOrigin::RemoteModel
            || program.requested_execution != SceneEditExecution::Sequence
            || program.schedule_mode != SceneEditScheduleMode::Sequence
            || !scene_edit_anchor_is_closed(
                &program.anchor_source,
                program.anchor_captured_playhead,
                program.anchor_resolved_seconds,
                scene.duration,
            )
            || !static_root_transform_edit_input_is_closed(program)
            || program
                .operations
                .iter()
                .any(|operation| operation.origin != program.origin)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let mut scheduled = program.schedule_order.iter().filter_map(|operation_id| {
            program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
        });
        let scale_operation = scheduled
            .next()
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let remove_operation = scheduled
            .next()
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if scheduled.next().is_some()
            || scale_operation.id.is_empty()
            || remove_operation.id.is_empty()
            || scale_operation.id == remove_operation.id
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let StaticRootTransformOperationKind::UniformScale {
            control_present: false,
            from: Some(from),
            relative_factor: Some(relative_factor),
            to: Some(to),
        } = &scale_operation.kind
        else {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        };
        let StaticRootTransformOperationKind::PersistentRemove { persistent: true } =
            &remove_operation.kind
        else {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        };
        let (from, relative_factor, to) = (*from, *relative_factor, *to);
        let studio_entity_id = scale_operation
            .entity_id
            .as_deref()
            .filter(|entity_id| !entity_id.is_empty())
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if remove_operation.entity_id.as_deref() != Some(studio_entity_id)
            || !from.is_finite()
            || from <= 0.0
            || !to.is_finite()
            || to <= 0.0
            || !relative_factor.is_finite()
            || relative_factor <= 0.0
            || relative_factor == 1.0
            || !close_transform_baseline_value(to / from, relative_factor)
            || !studio_timeline_semantic_values_match(
                scale_operation.interval.start,
                program.anchor_resolved_seconds,
            )
            || scale_operation.interval.end <= scale_operation.interval.start
            || !studio_timeline_semantic_values_match(
                scale_operation.interval.end,
                remove_operation.interval.start,
            )
            || remove_operation.interval.end <= remove_operation.interval.start
            || remove_operation.interval.end > scene.duration
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let insertion = SceneTimelineInsertion {
            at: program.anchor_resolved_seconds,
            duration: remove_operation.interval.end - program.anchor_resolved_seconds,
        };
        if !insertion.duration.is_finite()
            || insertion.duration <= 0.0
            || !(scene.duration + insertion.duration).is_finite()
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let (studio_entity, runtime_entity) = resolve_static_root_binding(
            scene,
            &studio_entities,
            &source_runtime_bindings,
            studio_entity_id,
        )
        .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if !matches!(
            studio_entity.kind,
            StaticRootTransformEntityKind::Circle
                | StaticRootTransformEntityKind::Image
                | StaticRootTransformEntityKind::MathTex
                | StaticRootTransformEntityKind::Rectangle
        ) || studio_entity
            .scale
            .is_none_or(|scale| !close_transform_baseline_value(scale, from))
            || runtime_entity.parent_id.is_some()
            || !static_transform_geometry_matches(studio_entity.kind, runtime_entity)
            || has_animated_transform(scene, &runtime_entity.id)
            || !runtime_entity
                .lifetimes
                .iter()
                .any(|lifetime| insertion.at >= lifetime.start && insertion.at < lifetime.end)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let expected_baseline = if matches!(
            studio_entity.kind,
            StaticRootTransformEntityKind::Circle | StaticRootTransformEntityKind::Rectangle
        ) {
            let semantic_position = studio_entity
                .position
                .as_ref()
                .filter(|position| studio_authoring_point_is_finite(position))
                .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
            let size = studio_authoring_shape_size(studio_entity.kind, studio_entity.dimensions)
                .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
            TransformSceneEntityExpectedBaseline::WorldSize {
                height: size.height * from,
                width: size.width * from,
                world_center: studio_point_to_scene_point(
                    semantic_position,
                    frame,
                    viewport,
                    &scene.camera.view.center,
                ),
            }
        } else if studio_entity.kind == StaticRootTransformEntityKind::MathTex {
            TransformSceneEntityExpectedBaseline::CurrentUniformAffine
        } else {
            TransformSceneEntityExpectedBaseline::CurrentCenter
        };
        let (_, scale) = resolve_transform_intent(
            runtime_entity,
            TransformSceneEntityIntent::FromBaseline {
                expected_baseline,
                scale: Some(SceneEntityAxisFactors {
                    x_factor: relative_factor,
                    y_factor: relative_factor,
                }),
                target_center: None,
            },
        )?;
        let scale = scale.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let runtime_entity_id = runtime_entity.id.clone();
        let mut transformed = runtime_entity.transform.clone();
        apply_world_axis_scale(
            &mut transformed,
            scale.x_factor,
            scale.y_factor,
            &scale.pivot,
        );

        let provenance_id = format!("studio-animated-scale-remove:{next_revision}");
        if scene
            .provenance
            .iter()
            .any(|record| record.id == provenance_id)
        {
            return Err(
                TransformSceneEntityError::ProvenanceConflict(provenance_id.clone()).into(),
            );
        }
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        insert_scene_time(&mut candidate.scene, &insertion);
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == runtime_entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(runtime_entity_id.clone()))?;
        provenance_id.clone_into(&mut target.provenance_id);
        let channel_id = unused_channel_id(&candidate.scene, "studio-animated-scale-remove");
        candidate
            .scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: runtime_entity_id.clone(),
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: scale_operation.interval.start,
                        easing_to_next: Some(EasingV1::ManimSmooth {}),
                        value: runtime_entity.transform.clone(),
                    },
                    KeyframeV1 {
                        at: scale_operation.interval.end,
                        easing_to_next: None,
                        value: transformed,
                    },
                ],
                provenance_id: provenance_id.clone(),
            });
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec![
                format!("authorized operation {}", scale_operation.id),
                format!("authorized operation {}", remove_operation.id),
            ],
            id: provenance_id.clone(),
            origin: ProvenanceOriginV1::StudioEditProgram,
        });
        let persistent_remove_projection = apply_persistent_scene_removals(
            &mut candidate.scene,
            &[PersistentSceneRemoval {
                entity_id: runtime_entity_id,
                interval: remove_operation.interval.clone(),
                operation_id: remove_operation.id.clone(),
                studio_entity_id: studio_entity_id.to_owned(),
                transaction_id: program.transaction_id.clone(),
            }],
            &provenance_id,
        )?;
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };
        let static_root_projection = StudioStaticRootProjection {
            insertions: vec![StudioMotionProjectionInsertion {
                at: insertion.at,
                duration: insertion.duration,
                transaction_id: program.transaction_id.clone(),
            }],
            mutations: vec![StudioStaticRootProjectedMutation {
                mutation: StudioStaticRootMutation::UniformScale {
                    easing: Some(StudioProjectionEasing::ManimSmooth),
                    entity_id: studio_entity_id.to_owned(),
                    from,
                    interval: scale_operation.interval.clone(),
                    to,
                },
                operation_id: scale_operation.id.clone(),
                transaction_id: program.transaction_id.clone(),
            }],
            projected_duration: candidate.scene.duration,
        };
        let result = StudioAuthoringEditResult {
            bundle: candidate.clone(),
            creation_projection: None,
            math_tex_transform_projection: None,
            motion_projection: None,
            persistent_remove_projection,
            static_root_projection: Some(static_root_projection),
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Applies the closed imported-root static edit subset.
    ///
    /// The caller serializes every edit operation, including unsupported ones. This method is
    /// therefore the sole authority for operation admission, identity resolution, geometry
    /// baseline verification, and atomic mutation.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the complete normalized edit is outside the closed subset, or a
    /// concrete mutation error when the installed Scene rejects it.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact t=0 and identity factors define the closed authoring subset; keeping its one admission path contiguous prevents split authority"
    )]
    pub fn apply_static_root_transform_edit(
        &mut self,
        command: ApplyStaticRootTransformEditCommand,
    ) -> Result<StudioAuthoringEditResult, ApplyStaticRootTransformEditError> {
        if command.programs.iter().any(|program| {
            program.operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StaticRootTransformOperationKind::MathTexContent { .. }
                )
            })
        }) {
            return self.apply_static_root_math_tex_content_edit(command);
        }
        if command.programs.len() == 1
            && command.programs[0].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StaticRootTransformOperationKind::UniformScale { .. }
                )
            })
            && command.programs[0].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StaticRootTransformOperationKind::PersistentRemove { .. }
                )
            })
        {
            return self.apply_animated_scale_then_remove_edit(command);
        }
        let ApplyStaticRootTransformEditCommand {
            expected_base_revision,
            frame,
            math_tex_outlines,
            next_revision,
            programs,
            source_runtime_bindings,
            studio_entities,
            viewport,
        } = command;
        let scene = self.scene();
        let operation_count = programs
            .iter()
            .map(|program| program.operations.len())
            .sum::<usize>();
        if !matches!(
            &scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.is_empty()
            || !math_tex_outlines.is_empty()
            || operation_count == 0
            || operation_count > 16
            || programs.iter().any(|program| {
                !program.lowering_supported
                    || program.transaction_id.is_empty()
                    || !scene_edit_anchor_is_closed(
                        &program.anchor_source,
                        program.anchor_captured_playhead,
                        program.anchor_resolved_seconds,
                        scene.duration,
                    )
                    || !static_root_transform_edit_input_is_closed(program)
                    || program
                        .operations
                        .iter()
                        .any(|operation| operation.origin != program.origin)
            })
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        if scene.source.revision_hash() != expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision.into());
        }
        if next_revision == expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance.into());
        }

        let mut entity_id: Option<String> = None;
        let mut operation_ids = BTreeSet::new();
        let mut ordered_operation_ids = Vec::with_capacity(operation_count);
        let mut position: Option<PointV1> = None;
        let mut removals = Vec::new();
        let mut transform_operation_count = 0_usize;
        let mut uniform_scale: Option<f64> = None;
        let mut uniform_scale_from: Option<f64> = None;
        let mut resize: Option<(
            StaticRootTransformEntityKind,
            StaticRootTransformDimensions,
            PointV1,
            f64,
            StaticRootTransformDimensions,
            PointV1,
        )> = None;
        let mut static_root_mutations = Vec::with_capacity(operation_count);
        let mut ordered_program_indexes = (0..programs.len()).collect::<Vec<_>>();
        ordered_program_indexes.sort_by(|left, right| {
            programs[*left]
                .anchor_resolved_seconds
                .total_cmp(&programs[*right].anchor_resolved_seconds)
                .then_with(|| left.cmp(right))
        });
        let mut static_program_indexes = Vec::new();
        let mut motion_programs = Vec::new();
        let mut reached_motion_suffix = false;
        for program_index in ordered_program_indexes {
            let program = &programs[program_index];
            let motion_operation_count = program
                .operations
                .iter()
                .filter(|operation| {
                    matches!(
                        operation.kind,
                        StaticRootTransformOperationKind::CreateMotion { .. }
                    )
                })
                .count();
            if motion_operation_count > 0 {
                if motion_operation_count != program.operations.len() {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                reached_motion_suffix = true;
                motion_programs.push(
                    static_root_motion_edit_input(program)
                        .ok_or(ApplyStaticRootTransformEditError::Unsupported)?,
                );
            } else {
                if reached_motion_suffix {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                static_program_indexes.push(program_index);
            }
        }
        if !motion_programs.is_empty() && static_program_indexes.is_empty() {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        for program_index in static_program_indexes {
            let program = &programs[program_index];
            let contains_removal = program.operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StaticRootTransformOperationKind::PersistentRemove { .. }
                )
            });
            if contains_removal
                && !program.operations.iter().all(|operation| {
                    matches!(
                        operation.kind,
                        StaticRootTransformOperationKind::PersistentRemove { .. }
                    )
                })
            {
                return Err(ApplyStaticRootTransformEditError::Unsupported);
            }
            for scheduled_id in &program.schedule_order {
                let operation = program
                    .operations
                    .iter()
                    .find(|operation| operation.id == *scheduled_id)
                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                if operation.id.is_empty() || !operation_ids.insert(operation.id.clone()) {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                ordered_operation_ids.push(operation.id.clone());
                if contains_removal {
                    match operation.kind {
                        StaticRootTransformOperationKind::PersistentRemove { persistent: true }
                            if matches!(
                                operation.origin,
                                StaticRootTransformOrigin::DirectManipulation
                                    | StaticRootTransformOrigin::StudioDefault
                            ) && operation
                                .entity_id
                                .as_deref()
                                .is_some_and(|entity_id| !entity_id.is_empty())
                                && studio_timeline_semantic_values_match(
                                    operation.interval.start,
                                    program.anchor_resolved_seconds,
                                )
                                && operation.interval.end >= operation.interval.start =>
                        {
                            let entity_id = operation
                                .entity_id
                                .as_ref()
                                .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                            removals.push(PersistentSceneRemoval {
                                entity_id: entity_id.clone(),
                                interval: operation.interval.clone(),
                                operation_id: operation.id.clone(),
                                studio_entity_id: entity_id.clone(),
                                transaction_id: program.transaction_id.clone(),
                            });
                        }
                        StaticRootTransformOperationKind::PersistentRemove { .. }
                        | StaticRootTransformOperationKind::Position { .. }
                        | StaticRootTransformOperationKind::UniformScale { .. }
                        | StaticRootTransformOperationKind::Resize { .. }
                        | StaticRootTransformOperationKind::CreateMotion { .. }
                        | StaticRootTransformOperationKind::MathTexContent { .. }
                        | StaticRootTransformOperationKind::Unsupported => {
                            return Err(ApplyStaticRootTransformEditError::Unsupported);
                        }
                    }
                    continue;
                }
                let operation_entity_id = operation
                    .entity_id
                    .as_deref()
                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                if !studio_timeline_semantic_values_match(program.anchor_resolved_seconds, 0.0)
                    || !studio_timeline_semantic_values_match(operation.interval.start, 0.0)
                    || !studio_timeline_semantic_values_match(operation.interval.end, 0.0)
                    || entity_id
                        .as_ref()
                        .is_some_and(|expected| expected != operation_entity_id)
                {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                transform_operation_count += 1;
                entity_id.get_or_insert_with(|| operation_entity_id.to_owned());
                match &operation.kind {
                    StaticRootTransformOperationKind::Position {
                        position: Some(target),
                    } if matches!(
                        operation.origin,
                        StaticRootTransformOrigin::DirectManipulation
                            | StaticRootTransformOrigin::StudioDefault
                    ) && studio_authoring_point_is_finite(target)
                        && position.replace(target.clone()).is_none() =>
                    {
                        static_root_mutations.push(StudioStaticRootProjectedMutation {
                            mutation: StudioStaticRootMutation::Position {
                                entity_id: operation_entity_id.to_owned(),
                                interval: operation.interval.clone(),
                                value: target.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        });
                    }
                    StaticRootTransformOperationKind::UniformScale {
                        control_present,
                        from: Some(from),
                        relative_factor: Some(factor),
                        to: Some(to),
                    } if operation.origin == StaticRootTransformOrigin::DirectManipulation
                        && !*control_present
                        && factor.is_finite()
                        && *factor > 0.0
                        && *factor != 1.0
                        && from.is_finite()
                        && *from > 0.0
                        && to.is_finite()
                        && *to > 0.0
                        && close_transform_baseline_value(*to / *from, *factor)
                        && uniform_scale.replace(*factor).is_none() =>
                    {
                        uniform_scale_from = Some(*from);
                        static_root_mutations.push(StudioStaticRootProjectedMutation {
                            mutation: StudioStaticRootMutation::UniformScale {
                                easing: None,
                                entity_id: operation_entity_id.to_owned(),
                                from: *from,
                                interval: operation.interval.clone(),
                                to: *to,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        });
                    }
                    StaticRootTransformOperationKind::Resize {
                        from_dimensions,
                        from_position,
                        from_scale,
                        shape,
                        to_dimensions,
                        to_position,
                    } if matches!(
                        operation.origin,
                        StaticRootTransformOrigin::DirectManipulation
                            | StaticRootTransformOrigin::StudioDefault
                    ) && matches!(
                        *shape,
                        StaticRootTransformEntityKind::Circle
                            | StaticRootTransformEntityKind::Rectangle
                    ) && from_scale.is_finite()
                        && *from_scale > 0.0
                        && studio_authoring_point_is_finite(from_position)
                        && studio_authoring_point_is_finite(to_position)
                        && resize
                            .replace((
                                *shape,
                                *from_dimensions,
                                from_position.clone(),
                                *from_scale,
                                *to_dimensions,
                                to_position.clone(),
                            ))
                            .is_none() =>
                    {
                        static_root_mutations.push(StudioStaticRootProjectedMutation {
                            mutation: StudioStaticRootMutation::Resize {
                                entity_id: operation_entity_id.to_owned(),
                                from_dimensions: *from_dimensions,
                                from_position: from_position.clone(),
                                interval: operation.interval.clone(),
                                to_dimensions: *to_dimensions,
                                to_position: to_position.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        });
                    }
                    StaticRootTransformOperationKind::Position { .. }
                    | StaticRootTransformOperationKind::UniformScale { .. }
                    | StaticRootTransformOperationKind::Resize { .. }
                    | StaticRootTransformOperationKind::PersistentRemove { .. }
                    | StaticRootTransformOperationKind::CreateMotion { .. }
                    | StaticRootTransformOperationKind::MathTexContent { .. }
                    | StaticRootTransformOperationKind::Unsupported => {
                        return Err(ApplyStaticRootTransformEditError::Unsupported);
                    }
                }
            }
        }
        let has_motion_suffix = !motion_programs.is_empty();
        if transform_operation_count > 2
            || (resize.is_some()
                && (position.is_some()
                    || uniform_scale.is_some()
                    || transform_operation_count != 1))
            || (transform_operation_count > 0
                && resize.is_none()
                && position.is_none()
                && uniform_scale.is_none())
            || (transform_operation_count > 0 && !scene.animation_channels.is_empty())
            || (has_motion_suffix && (transform_operation_count == 0 || !removals.is_empty()))
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let transformed_studio_position = resize
            .as_ref()
            .map(|(_, _, _, _, _, to_position)| to_position.clone())
            .or_else(|| position.clone());
        let transformed_studio_entity_id = entity_id.clone();
        let transform = if let Some(entity_id) = entity_id {
            let (studio_entity, runtime_entity) = resolve_static_root_binding(
                scene,
                &studio_entities,
                &source_runtime_bindings,
                &entity_id,
            )
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
            let semantic_position = studio_entity
                .position
                .as_ref()
                .filter(|position| studio_authoring_point_is_finite(position));
            let semantic_scale = studio_entity
                .scale
                .filter(|scale| scale.is_finite() && *scale > 0.0);
            let primitive_size =
                studio_authoring_shape_size(studio_entity.kind, studio_entity.dimensions);
            let primitive_transform = matches!(
                studio_entity.kind,
                StaticRootTransformEntityKind::Circle | StaticRootTransformEntityKind::Rectangle
            ) && (uniform_scale.is_some() || resize.is_some());
            if !matches!(
                studio_entity.kind,
                StaticRootTransformEntityKind::Image | StaticRootTransformEntityKind::MathTex
            ) && semantic_position.is_none()
                || primitive_transform && (semantic_scale.is_none() || primitive_size.is_none())
                || uniform_scale.is_some()
                    && !matches!(
                        studio_entity.kind,
                        StaticRootTransformEntityKind::Circle
                            | StaticRootTransformEntityKind::Image
                            | StaticRootTransformEntityKind::MathTex
                            | StaticRootTransformEntityKind::Rectangle
                    )
                || uniform_scale_from.is_some_and(|from| {
                    semantic_scale.is_none_or(|scale| !close_transform_baseline_value(from, scale))
                })
                || resize
                    .as_ref()
                    .is_some_and(|(shape, ..)| *shape != studio_entity.kind)
            {
                return Err(ApplyStaticRootTransformEditError::Unsupported);
            }
            if runtime_entity.parent_id.is_some()
                || !static_transform_geometry_matches(studio_entity.kind, runtime_entity)
            {
                return Err(ApplyStaticRootTransformEditError::Unsupported);
            }

            let intent = if let Some((
                shape,
                from_dimensions,
                from_position,
                from_scale,
                to_dimensions,
                to_position,
            )) = resize
            {
                let from_size = studio_authoring_shape_size(shape, from_dimensions)
                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                let to_size = studio_authoring_shape_size(shape, to_dimensions)
                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                let semantic_position =
                    semantic_position.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                let semantic_scale =
                    semantic_scale.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                let primitive_size =
                    primitive_size.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                if !close_transform_baseline_value(from_size.width, primitive_size.width)
                    || !close_transform_baseline_value(from_size.height, primitive_size.height)
                    || !close_transform_baseline_value(from_scale, semantic_scale)
                    || !close_transform_baseline_value(from_position.x, semantic_position.x)
                    || !close_transform_baseline_value(from_position.y, semantic_position.y)
                {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                let world_center = studio_point_to_scene_point(
                    semantic_position,
                    frame,
                    viewport,
                    &scene.camera.view.center,
                );
                TransformSceneEntityIntent::FromBaseline {
                    expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize {
                        height: primitive_size.height * semantic_scale,
                        width: primitive_size.width * semantic_scale,
                        world_center,
                    },
                    scale: Some(SceneEntityAxisFactors {
                        x_factor: to_size.width / from_size.width,
                        y_factor: to_size.height / from_size.height,
                    }),
                    target_center: Some(studio_point_to_scene_point(
                        &to_position,
                        frame,
                        viewport,
                        &scene.camera.view.center,
                    )),
                }
            } else if !primitive_transform
                && !matches!(
                    studio_entity.kind,
                    StaticRootTransformEntityKind::Image | StaticRootTransformEntityKind::MathTex
                )
            {
                let target = position.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                let baseline = studio_point_to_scene_point(
                    semantic_position.ok_or(ApplyStaticRootTransformEditError::Unsupported)?,
                    frame,
                    viewport,
                    &scene.camera.view.center,
                );
                let target = studio_point_to_scene_point(
                    &target,
                    frame,
                    viewport,
                    &scene.camera.view.center,
                );
                TransformSceneEntityIntent::Relative {
                    delta: PointV1 {
                        x: target.x - baseline.x,
                        y: target.y - baseline.y,
                    },
                    scale: None,
                }
            } else {
                TransformSceneEntityIntent::FromBaseline {
                    expected_baseline: if primitive_transform {
                        let size =
                            primitive_size.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                        let scale =
                            semantic_scale.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                        TransformSceneEntityExpectedBaseline::WorldSize {
                            height: size.height * scale,
                            width: size.width * scale,
                            world_center: studio_point_to_scene_point(
                                semantic_position
                                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?,
                                frame,
                                viewport,
                                &scene.camera.view.center,
                            ),
                        }
                    } else if uniform_scale.is_some()
                        && studio_entity.kind == StaticRootTransformEntityKind::MathTex
                    {
                        TransformSceneEntityExpectedBaseline::CurrentUniformAffine
                    } else {
                        TransformSceneEntityExpectedBaseline::CurrentCenter
                    },
                    scale: uniform_scale.map(|factor| SceneEntityAxisFactors {
                        x_factor: factor,
                        y_factor: factor,
                    }),
                    target_center: position.map(|target| {
                        studio_point_to_scene_point(
                            &target,
                            frame,
                            viewport,
                            &scene.camera.view.center,
                        )
                    }),
                }
            };
            Some((runtime_entity.id.clone(), intent))
        } else {
            None
        };
        let mut resolved_removals = Vec::with_capacity(removals.len());
        for mut removal in removals {
            let (_, runtime_entity) = resolve_static_root_binding(
                scene,
                &studio_entities,
                &source_runtime_bindings,
                &removal.entity_id,
            )
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
            removal.entity_id.clone_from(&runtime_entity.id);
            resolved_removals.push(removal);
        }
        let provenance_id = if transform_operation_count > 0 {
            format!("studio-static-transform:{next_revision}")
        } else {
            format!("studio-persistent-remove:{next_revision}")
        };
        let motion_plan = if motion_programs.is_empty() {
            None
        } else {
            Some(
                plan_studio_motion_edits(scene.duration, &motion_programs)
                    .map_err(|_| ApplyStaticRootTransformEditError::Unsupported)?,
            )
        };
        let mut planned_motions = Vec::new();
        let mut projection_targets = BTreeMap::new();
        let mut parallel_runtime_targets: Vec<(String, f64, String)> = Vec::new();
        if let Some(plan) = &motion_plan {
            for motion in &plan.motions {
                if !operation_ids.insert(motion.operation_id.clone()) {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
                ordered_operation_ids.push(motion.operation_id.clone());
                let mut runtime_entity_ids = Vec::with_capacity(motion.target_entity_ids.len());
                for studio_entity_id in &motion.target_entity_ids {
                    let (studio_entity, runtime_entity) = resolve_static_root_binding(
                        scene,
                        &studio_entities,
                        &source_runtime_bindings,
                        studio_entity_id,
                    )
                    .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                    let mut projected_position = studio_entity
                        .position
                        .as_ref()
                        .filter(|position| studio_authoring_point_is_finite(position))
                        .cloned()
                        .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                    if transformed_studio_entity_id.as_deref() == Some(studio_entity_id.as_str())
                        && let Some(position) = &transformed_studio_position
                    {
                        projected_position.clone_from(position);
                    }
                    let lifetime = one_projection_lifetime(&runtime_entity.lifetimes)
                        .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
                    projection_targets
                        .entry(studio_entity_id.clone())
                        .or_insert(StudioMotionProjectionTarget {
                            lifetime,
                            position: projected_position,
                        });
                    runtime_entity_ids.push(runtime_entity.id.clone());
                }
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
                            return Err(ApplyStaticRootTransformEditError::Unsupported);
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
                )
                .map_err(|_| ApplyStaticRootTransformEditError::Unsupported)?;
                planned_motions.push(PlannedSceneMotion {
                    control_offset,
                    delta,
                    easing: motion.easing,
                    interval: motion.interval.clone(),
                    target_entity_ids: runtime_entity_ids,
                });
            }
        }
        let motion_projection = motion_plan
            .as_ref()
            .map(|plan| project_studio_motion_plan(plan, projection_targets))
            .transpose()
            .map_err(|_| ApplyStaticRootTransformEditError::Unsupported)?;
        let mut evidence = vec!["Studio static imported-root edit".to_owned()];
        evidence.extend(
            ordered_operation_ids
                .into_iter()
                .map(|operation_id| format!("authorized operation {operation_id}")),
        );
        let provenance = ProvenanceRecordV1 {
            evidence,
            id: provenance_id,
            origin: ProvenanceOriginV1::StudioEditProgram,
        };
        if scene
            .provenance
            .iter()
            .any(|record| record.id == provenance.id)
        {
            return Err(
                TransformSceneEntityError::ProvenanceConflict(provenance.id.clone()).into(),
            );
        }
        let base_bundle = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        let mut candidate = if let Some((runtime_entity_id, intent)) = transform {
            let mut candidate_session = EngineSessionV1::new(base_bundle)?;
            candidate_session.transform_scene_entity(TransformSceneEntityCommand {
                entity_id: runtime_entity_id,
                expected_base_revision: expected_base_revision.clone(),
                intent,
                next_revision: next_revision.clone(),
                provenance: provenance.clone(),
            })?
        } else {
            let mut candidate = base_bundle;
            candidate.scene.provenance.push(provenance.clone());
            candidate.scene.source = SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: next_revision,
            };
            candidate
        };
        if let Some(plan) = &motion_plan {
            for insertion in &plan.timeline_insertions {
                insert_scene_time(&mut candidate.scene, insertion);
            }
        }
        append_planned_scene_motions(&mut candidate.scene, &planned_motions, &provenance.id)
            .map_err(|_| ApplyStaticRootTransformEditError::Unsupported)?;
        let persistent_remove_projection = if resolved_removals.is_empty() {
            StudioPersistentRemoveProjection::default()
        } else {
            apply_persistent_scene_removals(
                &mut candidate.scene,
                &resolved_removals,
                &provenance.id,
            )?
        };
        let static_root_projection =
            (transform_operation_count > 0).then_some(StudioStaticRootProjection {
                insertions: vec![],
                mutations: static_root_mutations,
                projected_duration: candidate.scene.duration,
            });
        let result = StudioAuthoringEditResult {
            bundle: candidate.clone(),
            creation_projection: None,
            math_tex_transform_projection: None,
            motion_projection,
            persistent_remove_projection,
            static_root_projection,
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::math_tex_transform::tests::{
        math_tex_fixture_path, static_imported_math_tex_bundle,
    };
    use poietra_scene_ir::{
        RuntimeTraceVersionV1, SceneIrBundleV1, SceneSourceV1, SnapshotProfileVersionV1,
        parse_scene_ir_bundle_json_v1,
    };

    use super::*;

    pub(super) const BASE_REVISION: &str =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    pub(super) const NEXT_REVISION: &str =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    pub(super) fn fixture_bundle(name: &str) -> SceneIrBundleV1 {
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

    pub(super) fn imported_bundle() -> SceneIrBundleV1 {
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

    pub(super) fn static_imported_bundle() -> SceneIrBundleV1 {
        let mut bundle = fixture_bundle("shared-circle-opacity.json");
        bundle.scene.animation_channels.clear();
        bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::ManimCairoSrgb;
        bundle.scene.required_capabilities = vec![SceneCapabilityV1::ShapePrimitives];
        bundle.scene.state_sampling.frame_rate = None;
        bundle.scene.state_sampling.retains_terminal_state = true;
        bundle.scene.source = SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            snapshot_hash: BASE_REVISION.to_owned(),
            snapshot_version: SnapshotProfileVersionV1::V1,
            source_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .to_owned(),
        };
        bundle
    }

    fn static_root_math_tex_content_command() -> ApplyStaticRootTransformEditCommand {
        let content = StudioMathTexContent {
            display_lines: vec!["F = ma".to_owned()],
            label: Some("force".to_owned()),
            tex_parts: vec!["F = ma".to_owned()],
        };
        ApplyStaticRootTransformEditCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            frame: StaticRootTransformSize {
                height: 9.0,
                width: 16.0,
            },
            math_tex_outlines: vec![StudioCreationMathTexOutline {
                entity_id: "source:formula".to_owned(),
                path: math_tex_fixture_path("real-mathtex-morph-v5.json"),
                tex_parts: content.tex_parts.clone(),
            }],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StaticRootTransformEditInput {
                anchor_captured_playhead: 0.0,
                anchor_resolved_seconds: 0.0,
                anchor_source: SceneEditAnchorSource::Playhead {
                    reference_seconds: Some(0.0),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![StaticRootTransformOperation {
                    depends_on: vec![],
                    entity_id: Some("source:formula".to_owned()),
                    id: "set-formula-content".to_owned(),
                    interval: IntervalV1 {
                        end: 0.0,
                        start: 0.0,
                    },
                    kind: StaticRootTransformOperationKind::MathTexContent { content },
                    origin: StudioAuthoringOrigin::StudioDefault,
                }],
                origin: StudioAuthoringOrigin::StudioDefault,
                requested_execution: SceneEditExecution::Parallel,
                schedule_edge_count: 0,
                schedule_mode: SceneEditScheduleMode::Parallel,
                schedule_order: vec!["set-formula-content".to_owned()],
                transaction_id: "set-formula-content".to_owned(),
            }],
            source_runtime_bindings: vec![StaticRootTransformSourceBinding {
                runtime_entity_id: "later".to_owned(),
                source_identity_key: "formula".to_owned(),
                source_name: "formula".to_owned(),
            }],
            studio_entities: vec![StaticRootTransformStudioEntity {
                dimensions: StaticRootTransformDimensions::default(),
                id: "source:formula".to_owned(),
                kind: StaticRootTransformEntityKind::MathTex,
                object_graph_key: "source:formula".to_owned(),
                position: None,
                provisional: false,
                scale: Some(1.75),
                source_identity: Some("formula".to_owned()),
                transaction_id: None,
            }],
            viewport: StaticRootTransformSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn static_root_position_command() -> ApplyStaticRootTransformEditCommand {
        ApplyStaticRootTransformEditCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            frame: StaticRootTransformSize {
                height: 9.0,
                width: 16.0,
            },
            math_tex_outlines: vec![],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StaticRootTransformEditInput {
                anchor_captured_playhead: 0.0,
                anchor_resolved_seconds: 0.0,
                anchor_source: SceneEditAnchorSource::Playhead {
                    reference_seconds: Some(0.0),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![StaticRootTransformOperation {
                    depends_on: vec![],
                    entity_id: Some("source:circle".to_owned()),
                    id: "move-circle".to_owned(),
                    interval: IntervalV1 {
                        end: 0.0,
                        start: 0.0,
                    },
                    kind: StaticRootTransformOperationKind::Position {
                        position: Some(PointV1 { x: 400.0, y: 180.0 }),
                    },
                    origin: StaticRootTransformOrigin::DirectManipulation,
                }],
                origin: StaticRootTransformOrigin::DirectManipulation,
                requested_execution: SceneEditExecution::Parallel,
                schedule_edge_count: 0,
                schedule_mode: SceneEditScheduleMode::Parallel,
                schedule_order: vec!["move-circle".to_owned()],
                transaction_id: "move-circle".to_owned(),
            }],
            source_runtime_bindings: vec![StaticRootTransformSourceBinding {
                source_identity_key: "circle".to_owned(),
                runtime_entity_id: "later".to_owned(),
                source_name: "circle".to_owned(),
            }],
            studio_entities: vec![StaticRootTransformStudioEntity {
                dimensions: StaticRootTransformDimensions {
                    height: None,
                    radius: Some(0.5),
                    width: None,
                },
                object_graph_key: "source:circle".to_owned(),
                id: "source:circle".to_owned(),
                kind: StaticRootTransformEntityKind::Circle,
                position: Some(PointV1 { x: 360.0, y: 180.0 }),
                provisional: false,
                scale: Some(1.0),
                source_identity: Some("circle".to_owned()),
                transaction_id: None,
            }],
            viewport: StaticRootTransformSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn animated_scale_then_remove_command() -> ApplyStaticRootTransformEditCommand {
        let mut command = static_root_position_command();
        command.programs = vec![StaticRootTransformEditInput {
            anchor_captured_playhead: 0.5,
            anchor_resolved_seconds: 0.5,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(0.5),
            },
            intent_count: 2,
            lowering_supported: true,
            operations: vec![
                StaticRootTransformOperation {
                    depends_on: vec![],
                    entity_id: Some("source:circle".to_owned()),
                    id: "magic-scale-circle".to_owned(),
                    interval: IntervalV1 {
                        end: 1.0,
                        start: 0.5,
                    },
                    kind: StaticRootTransformOperationKind::UniformScale {
                        control_present: false,
                        from: Some(1.0),
                        relative_factor: Some(1.5),
                        to: Some(1.5),
                    },
                    origin: StaticRootTransformOrigin::RemoteModel,
                },
                StaticRootTransformOperation {
                    depends_on: vec![],
                    entity_id: Some("source:circle".to_owned()),
                    id: "magic-remove-circle".to_owned(),
                    interval: IntervalV1 {
                        end: 1.4,
                        start: 1.0,
                    },
                    kind: StaticRootTransformOperationKind::PersistentRemove { persistent: true },
                    origin: StaticRootTransformOrigin::RemoteModel,
                },
            ],
            origin: StaticRootTransformOrigin::RemoteModel,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count: 1,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: vec![
                "magic-scale-circle".to_owned(),
                "magic-remove-circle".to_owned(),
            ],
            transaction_id: "magic-scale-remove".to_owned(),
        }];
        command
    }

    fn static_root_motion_edit_input(
        target_entity_ids: Vec<String>,
    ) -> StaticRootTransformEditInput {
        StaticRootTransformEditInput {
            anchor_captured_playhead: 0.5,
            anchor_resolved_seconds: 0.5,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(0.5),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StaticRootTransformOperation {
                depends_on: vec![],
                entity_id: None,
                id: "move-imported-root".to_owned(),
                interval: IntervalV1 {
                    end: 1.5,
                    start: 0.5,
                },
                kind: StaticRootTransformOperationKind::CreateMotion {
                    control_offset: PointV1 { x: 0.0, y: -160.0 },
                    delta: PointV1 { x: 240.0, y: -80.0 },
                    easing: StudioMotionEasing::Smooth,
                    target_entity_ids,
                },
                origin: StaticRootTransformOrigin::DirectManipulation,
            }],
            origin: StaticRootTransformOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: vec!["move-imported-root".to_owned()],
            transaction_id: "move-imported-root".to_owned(),
        }
    }

    fn static_persistent_remove_edit_input(
        targets: &[(&str, &str)],
        start: f64,
        end: f64,
    ) -> StaticRootTransformEditInput {
        StaticRootTransformEditInput {
            anchor_captured_playhead: start,
            anchor_resolved_seconds: start,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(start),
            },
            intent_count: targets.len(),
            lowering_supported: true,
            operations: targets
                .iter()
                .map(|(operation_id, entity_id)| StaticRootTransformOperation {
                    depends_on: vec![],
                    entity_id: Some((*entity_id).to_owned()),
                    id: (*operation_id).to_owned(),
                    interval: IntervalV1 { end, start },
                    kind: StaticRootTransformOperationKind::PersistentRemove { persistent: true },
                    origin: StaticRootTransformOrigin::DirectManipulation,
                })
                .collect(),
            origin: StaticRootTransformOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: targets
                .iter()
                .map(|(operation_id, _)| (*operation_id).to_owned())
                .collect(),
            transaction_id: "persistent-remove".to_owned(),
        }
    }

    #[test]
    fn applies_one_normalized_static_root_position_through_existing_transform_authority() {
        let mut session = EngineSessionV1::new(static_imported_bundle()).unwrap();

        let result = session
            .apply_static_root_transform_edit(static_root_position_command())
            .unwrap();
        let result = result.bundle;

        let moved = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert!((moved.transform.tx - 1.0).abs() < f64::EPSILON);
        assert!(moved.transform.ty.abs() < f64::EPSILON);
        assert_eq!(
            moved.provenance_id,
            format!("studio-static-transform:{NEXT_REVISION}")
        );
        assert_eq!(result.scene.source.revision_hash(), NEXT_REVISION);
        assert_eq!(
            result.scene.compositing,
            poietra_scene_ir::RenderCompositingV1::ManimCairoSrgb
        );
        assert_eq!(result.scene.state_sampling.frame_rate, None);
        assert!(result.scene.state_sampling.retains_terminal_state);
    }

    #[test]
    fn applies_one_normalized_circle_resize_from_the_installed_geometry_baseline() {
        let mut command = static_root_position_command();
        command.programs[0].operations[0].kind = StaticRootTransformOperationKind::Resize {
            from_dimensions: StaticRootTransformDimensions {
                height: None,
                radius: Some(0.5),
                width: None,
            },
            from_position: PointV1 { x: 360.0, y: 180.0 },
            from_scale: 1.0,
            shape: StaticRootTransformEntityKind::Circle,
            to_dimensions: StaticRootTransformDimensions {
                height: None,
                radius: Some(1.0),
                width: None,
            },
            to_position: PointV1 { x: 400.0, y: 180.0 },
        };
        let mut session = EngineSessionV1::new(static_imported_bundle()).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();
        assert_eq!(
            result.static_root_projection,
            Some(StudioStaticRootProjection {
                insertions: vec![],
                mutations: vec![StudioStaticRootProjectedMutation {
                    mutation: StudioStaticRootMutation::Resize {
                        entity_id: "source:circle".to_owned(),
                        from_dimensions: StaticRootTransformDimensions {
                            height: None,
                            radius: Some(0.5),
                            width: None,
                        },
                        from_position: PointV1 { x: 360.0, y: 180.0 },
                        interval: IntervalV1 {
                            end: 0.0,
                            start: 0.0,
                        },
                        to_dimensions: StaticRootTransformDimensions {
                            height: None,
                            radius: Some(1.0),
                            width: None,
                        },
                        to_position: PointV1 { x: 400.0, y: 180.0 },
                    },
                    operation_id: "move-circle".to_owned(),
                    transaction_id: "move-circle".to_owned(),
                }],
                projected_duration: result.bundle.scene.duration,
            })
        );
        assert_eq!(
            serde_json::to_value(&result).unwrap()["staticRootProjection"]["mutations"][0]["fromDimensions"],
            serde_json::json!({ "radius": 0.5 })
        );
        let result = result.bundle;
        let resized = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert!((resized.transform.m11 - 2.0).abs() < f64::EPSILON);
        assert!((resized.transform.m22 - 2.0).abs() < f64::EPSILON);
        assert!(resized.transform.tx.abs() < f64::EPSILON);
        assert!(resized.transform.ty.abs() < f64::EPSILON);
    }

    #[test]
    fn applies_move_or_resize_then_motion_without_a_visual_center_jump() {
        let moved = static_root_position_command();
        let mut resized = static_root_position_command();
        resized.programs[0].operations[0].kind = StaticRootTransformOperationKind::Resize {
            from_dimensions: StaticRootTransformDimensions {
                height: None,
                radius: Some(0.5),
                width: None,
            },
            from_position: PointV1 { x: 360.0, y: 180.0 },
            from_scale: 1.0,
            shape: StaticRootTransformEntityKind::Circle,
            to_dimensions: StaticRootTransformDimensions {
                height: None,
                radius: Some(1.0),
                width: None,
            },
            to_position: PointV1 { x: 400.0, y: 180.0 },
        };

        for (mut command, path_start_x, local_center_scale) in
            [(moved, 1.0, 1.0), (resized, 0.0, 2.0)]
        {
            command.programs.push(static_root_motion_edit_input(vec![
                "source:circle".to_owned(),
            ]));
            let mut session = EngineSessionV1::new(static_imported_bundle()).unwrap();

            let result = session.apply_static_root_transform_edit(command).unwrap();
            assert!(result.static_root_projection.is_some());
            assert!(result.motion_projection.is_some());
            assert!((result.bundle.scene.duration - 3.0).abs() < f64::EPSILON);
            let path = result
                .bundle
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
            assert!((path.subpaths[0].start.x - path_start_x).abs() < f64::EPSILON);

            for (time, expected_center) in [
                (0.5, PointV1 { x: 2.0, y: 0.0 }),
                (1.0, PointV1 { x: 5.0, y: 3.0 }),
                (1.5, PointV1 { x: 8.0, y: 2.0 }),
            ] {
                let packet = session
                    .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                        evidence: &[],
                        packet_id: "static-then-motion-sample",
                        sample_time: time,
                        viewport: poietra_scene_ir::ViewportV1 {
                            height_px: 900,
                            width_px: 1600,
                        },
                    })
                    .unwrap();
                let poietra_scene_ir::RenderDrawV1::Path { transform, .. } = packet
                    .draws
                    .iter()
                    .find(|draw| draw.entity_id() == "later")
                    .unwrap()
                else {
                    panic!("motion target must remain a path draw");
                };
                let sampled_center = PointV1 {
                    x: transform.tx + local_center_scale,
                    y: transform.ty,
                };
                assert!(
                    (sampled_center.x - expected_center.x).abs() < 1e-10,
                    "time={time}"
                );
                assert!(
                    (sampled_center.y - expected_center.y).abs() < 1e-10,
                    "time={time}"
                );
            }
            assert_eq!(session.scene(), &result.bundle.scene);
        }
    }

    #[test]
    fn static_then_motion_can_target_a_different_imported_root() {
        let mut command = static_root_position_command();
        command.programs.push(static_root_motion_edit_input(vec![
            "source:earlier".to_owned(),
        ]));
        let mut earlier = command.studio_entities[0].clone();
        earlier.dimensions.radius = Some(1.0);
        earlier.id = "source:earlier".to_owned();
        earlier.object_graph_key = earlier.id.clone();
        earlier.position = Some(PointV1 { x: 280.0, y: 180.0 });
        earlier.source_identity = Some("earlier".to_owned());
        command.studio_entities.push(earlier);
        command
            .source_runtime_bindings
            .push(StaticRootTransformSourceBinding {
                source_identity_key: "earlier".to_owned(),
                runtime_entity_id: "earlier".to_owned(),
                source_name: "earlier".to_owned(),
            });
        let mut session = EngineSessionV1::new(static_imported_bundle()).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();
        let path = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id, path, ..
                } if entity_id == "earlier" => Some(path),
                _ => None,
            })
            .unwrap();

        assert_eq!(path.subpaths[0].start, PointV1 { x: 0.0, y: 0.0 });
        assert_eq!(path.subpaths[0].segments[0].end, PointV1 { x: 6.0, y: 2.0 });
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .all(|channel| {
                    !matches!(
                        channel,
                        AnimationChannelV1::MotionPath { entity_id, .. } if entity_id == "later"
                    )
                })
        );
    }

    #[test]
    fn rejects_invalid_static_then_motion_suffixes_atomically() {
        let bundle = static_imported_bundle();
        let valid = || {
            let mut command = static_root_position_command();
            command.programs.push(static_root_motion_edit_input(vec![
                "source:circle".to_owned(),
            ]));
            command
        };

        let mut unknown_target = valid();
        let StaticRootTransformOperationKind::CreateMotion {
            target_entity_ids, ..
        } = &mut unknown_target.programs[1].operations[0].kind
        else {
            unreachable!();
        };
        target_entity_ids[0] = "source:missing".to_owned();

        let mut motion_then_static = valid();
        let mut later_static = motion_then_static.programs[0].clone();
        later_static.anchor_captured_playhead = 1.75;
        later_static.anchor_resolved_seconds = 1.75;
        later_static.anchor_source = SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.75),
        };
        later_static.operations[0].id = "late-static".to_owned();
        later_static.operations[0].interval = IntervalV1 {
            end: 1.75,
            start: 1.75,
        };
        later_static.schedule_order = vec!["late-static".to_owned()];
        motion_then_static.programs.push(later_static);

        let mut mixed_program = valid();
        let mut static_operation = mixed_program.programs[0].operations[0].clone();
        static_operation.id = "mixed-static".to_owned();
        let mixed = &mut mixed_program.programs[1];
        mixed.operations.push(static_operation);
        mixed.intent_count = 2;
        mixed.schedule_edge_count = 1;
        mixed.schedule_order.push("mixed-static".to_owned());

        let mut remove_then_motion = valid();
        remove_then_motion.programs[0] =
            static_persistent_remove_edit_input(&[("remove-root", "source:circle")], 0.0, 0.0);

        for command in [
            unknown_target,
            motion_then_static,
            mixed_program,
            remove_then_motion,
        ] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(matches!(
                session.apply_static_root_transform_edit(command),
                Err(ApplyStaticRootTransformEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn applies_one_normalized_mathtex_move_and_uniform_scale_atomically() {
        let mut bundle = fixture_bundle("mathtex-nested-radical-fraction.json");
        bundle.scene.animation_channels.clear();
        bundle.scene.required_capabilities = vec![SceneCapabilityV1::CubicPathGeometry];
        bundle.scene.source = SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            snapshot_hash: BASE_REVISION.to_owned(),
            snapshot_version: SnapshotProfileVersionV1::V1,
            source_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .to_owned(),
        };
        let runtime_entity_id = bundle.scene.entities[0].id.clone();
        let mut command = static_root_position_command();
        command.frame = StaticRootTransformSize {
            height: bundle.scene.camera.view.frame_height,
            width: bundle.scene.camera.view.frame_width,
        };
        command.programs[0].operations[0].entity_id = Some("source:formula".to_owned());
        let mut scale = command.programs[0].operations[0].clone();
        scale.id = "scale-formula".to_owned();
        scale.kind = StaticRootTransformOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        };
        command.programs[0].operations.push(scale);
        command.programs[0].intent_count = 2;
        command.programs[0].requested_execution = SceneEditExecution::Sequence;
        command.programs[0].schedule_edge_count = 1;
        command.programs[0].schedule_mode = SceneEditScheduleMode::Sequence;
        command.programs[0]
            .schedule_order
            .push("scale-formula".to_owned());
        command.source_runtime_bindings = vec![StaticRootTransformSourceBinding {
            source_identity_key: "formula".to_owned(),
            runtime_entity_id: runtime_entity_id.clone(),
            source_name: "formula".to_owned(),
        }];
        command.studio_entities = vec![StaticRootTransformStudioEntity {
            dimensions: StaticRootTransformDimensions {
                height: None,
                radius: None,
                width: None,
            },
            object_graph_key: "source:formula".to_owned(),
            id: "source:formula".to_owned(),
            kind: StaticRootTransformEntityKind::MathTex,
            position: None,
            provisional: false,
            scale: Some(1.0),
            source_identity: Some("formula".to_owned()),
            transaction_id: None,
        }];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();
        let projected_duration = result.bundle.scene.duration;
        assert_eq!(
            serde_json::to_value(&result).unwrap()["staticRootProjection"],
            serde_json::json!({
                "insertions": [],
                "mutations": [
                    {
                        "entityId": "source:formula",
                        "interval": { "end": 0.0, "start": 0.0 },
                        "kind": "position",
                        "operationId": "move-circle",
                        "transactionId": "move-circle",
                        "value": { "x": 400.0, "y": 180.0 },
                    },
                    {
                        "entityId": "source:formula",
                        "from": 1.0,
                        "interval": { "end": 0.0, "start": 0.0 },
                        "kind": "uniform-scale",
                        "operationId": "scale-formula",
                        "to": 1.5,
                        "transactionId": "move-circle",
                    },
                ],
                "projectedDuration": projected_duration,
            })
        );
        let result = result.bundle;
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == runtime_entity_id)
            .unwrap();
        assert!((transformed.transform.m11 - 1.5).abs() < f64::EPSILON);
        assert!((transformed.transform.m22 - 1.5).abs() < f64::EPSILON);
        let center = scene_entity_world_center(
            transformed,
            &scene_entity_local_bounds(transformed).unwrap(),
        );
        assert!((center.x - result.scene.camera.view.frame_width / 8.0).abs() < f64::EPSILON);
        assert!(center.y.abs() < f64::EPSILON);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the closed command stores these literal fade endpoints and opacity values"
    )]
    fn persistently_removes_multiple_imported_roots_with_nonzero_fades() {
        let bundle = static_imported_bundle();
        let mut command = static_root_position_command();
        command.programs = vec![static_persistent_remove_edit_input(
            &[
                ("remove-later", "source:circle"),
                ("remove-earlier", "source:earlier"),
            ],
            1.0,
            1.5,
        )];
        let mut earlier = command.studio_entities[0].clone();
        earlier.dimensions.radius = Some(1.0);
        earlier.id = "source:earlier".to_owned();
        earlier.object_graph_key = earlier.id.clone();
        earlier.position = Some(PointV1 { x: 280.0, y: 180.0 });
        earlier.source_identity = Some("earlier".to_owned());
        command.studio_entities.push(earlier);
        command
            .source_runtime_bindings
            .push(StaticRootTransformSourceBinding {
                source_identity_key: "earlier".to_owned(),
                runtime_entity_id: "earlier".to_owned(),
                source_name: "earlier".to_owned(),
            });
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();

        assert!(result.static_root_projection.is_none());
        assert_eq!(result.persistent_remove_projection.removals.len(), 2);
        for entity_id in ["later", "earlier"] {
            let entity = result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == entity_id)
                .unwrap();
            assert_eq!(entity.lifetimes.last().unwrap().end, 1.5);
            assert!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .any(|channel| {
                        matches!(
                            channel,
                            AnimationChannelV1::Opacity {
                                entity_id: channel_entity_id,
                                keyframes,
                                ..
                            } if channel_entity_id == entity_id
                                && keyframes[0].at == 1.0
                                && keyframes[0].value == 1.0
                                && keyframes[1].at == 1.5
                                && keyframes[1].value == 0.0
                        )
                    })
            );
        }
        assert_eq!(
            result.bundle.scene.provenance.last().unwrap().id,
            format!("studio-persistent-remove:{NEXT_REVISION}")
        );
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn applies_imported_move_then_persistent_remove_as_one_complete_batch() {
        let mut command = static_root_position_command();
        command.programs.push(static_persistent_remove_edit_input(
            &[("remove-later", "source:circle")],
            1.0,
            1.5,
        ));
        let mut session = EngineSessionV1::new(static_imported_bundle()).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();
        let moved = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!((moved.transform.tx - 1.0).abs() < f64::EPSILON);
        assert!(moved.transform.ty.abs() < f64::EPSILON);
        assert!((moved.lifetimes.last().unwrap().end - 1.5).abs() < f64::EPSILON);
        assert!(matches!(
            result
                .static_root_projection
                .as_ref()
                .map(|projection| projection.mutations.as_slice()),
            Some([StudioStaticRootProjectedMutation {
                mutation: StudioStaticRootMutation::Position { .. },
                ..
            }])
        ));
        assert_eq!(result.persistent_remove_projection.removals.len(), 1);
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn applies_magic_animated_scale_then_remove_as_one_atomic_timeline_insertion() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .apply_static_root_transform_edit(animated_scale_then_remove_command())
            .unwrap();

        assert!((result.bundle.scene.duration - (base_duration + 0.9)).abs() < 1e-12);
        assert_eq!(
            result.static_root_projection,
            Some(StudioStaticRootProjection {
                insertions: vec![StudioMotionProjectionInsertion {
                    at: 0.5,
                    duration: 1.4 - 0.5,
                    transaction_id: "magic-scale-remove".to_owned(),
                }],
                mutations: vec![StudioStaticRootProjectedMutation {
                    mutation: StudioStaticRootMutation::UniformScale {
                        easing: Some(StudioProjectionEasing::ManimSmooth),
                        entity_id: "source:circle".to_owned(),
                        from: 1.0,
                        interval: IntervalV1 {
                            end: 1.0,
                            start: 0.5,
                        },
                        to: 1.5,
                    },
                    operation_id: "magic-scale-circle".to_owned(),
                    transaction_id: "magic-scale-remove".to_owned(),
                }],
                projected_duration: base_duration + (1.4 - 0.5),
            })
        );
        let removal = &result.persistent_remove_projection.removals[0];
        assert_eq!(removal.studio_entity_id, "source:circle");
        assert_eq!(removal.scene_entity_id, "later");
        assert_eq!(
            removal.fade_interval,
            Some(IntervalV1 {
                end: 1.4,
                start: 1.0,
            })
        );
        assert!((removal.resulting_lifetime_end - 1.4).abs() < 1e-12);

        let transform_keyframes = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "later" => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert!((transform_keyframes[0].at - 0.5).abs() < 1e-12);
        assert_eq!(
            transform_keyframes[0].easing_to_next,
            Some(EasingV1::ManimSmooth {})
        );
        assert!((transform_keyframes[0].value.m11 - 1.0).abs() < 1e-12);
        assert!((transform_keyframes[1].at - 1.0).abs() < 1e-12);
        assert!((transform_keyframes[1].value.m11 - 1.5).abs() < 1e-12);

        for (time, expected_scale) in [
            (0.5, 1.0),
            (0.625, 1.035_051_858_272_554),
            (0.75, 1.25),
            (1.0, 1.5),
        ] {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "magic-scale-remove-sample",
                    sample_time: time,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            let poietra_scene_ir::RenderDrawV1::Path { transform, .. } = packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            else {
                panic!("scaled target must remain a path draw");
            };
            assert!((transform.m11 - expected_scale).abs() < 1e-12);
            assert!((transform.m22 - expected_scale).abs() < 1e-12);
        }
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn rejects_invalid_magic_scale_remove_without_mutating_the_session() {
        let bundle = static_imported_bundle();
        let mut missing = animated_scale_then_remove_command();
        missing.programs[0].operations[0].entity_id = Some("source:missing".to_owned());
        missing.programs[0].operations[1].entity_id = Some("source:missing".to_owned());
        let mut reversed = animated_scale_then_remove_command();
        reversed.programs[0].schedule_order.reverse();
        let mut stale = animated_scale_then_remove_command();
        stale.expected_base_revision = "f".repeat(64);

        for command in [missing, reversed, stale] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(session.apply_static_root_transform_edit(command).is_err());
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn rejects_open_static_edits_without_mutating_the_session() {
        let bundle = static_imported_bundle();
        let mut unsupported = static_root_position_command();
        unsupported.programs[0].operations[0].kind = StaticRootTransformOperationKind::Unsupported;
        let mut missing_dependency = static_root_position_command();
        missing_dependency.programs[0].operations[0].depends_on =
            vec!["missing-operation".to_owned()];
        let mut nonzero_transform = static_root_position_command();
        nonzero_transform.programs[0].anchor_captured_playhead = 0.5;
        nonzero_transform.programs[0].anchor_resolved_seconds = 0.5;
        nonzero_transform.programs[0].anchor_source = SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.5),
        };
        nonzero_transform.programs[0].operations[0].interval = IntervalV1 {
            end: 0.5,
            start: 0.5,
        };
        let mut unknown_remove = static_root_position_command();
        unknown_remove.programs = vec![static_persistent_remove_edit_input(
            &[("remove-missing", "source:missing")],
            1.0,
            1.5,
        )];
        let mut stale_scale = static_root_position_command();
        stale_scale.programs[0].operations[0].kind =
            StaticRootTransformOperationKind::UniformScale {
                control_present: false,
                from: Some(1.0),
                relative_factor: Some(2.0),
                to: Some(2.0),
            };
        stale_scale.studio_entities[0].scale = Some(3.0);

        for command in [
            unsupported,
            missing_dependency,
            nonzero_transform,
            unknown_remove,
            stale_scale,
        ] {
            let expected_scene = bundle.scene.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
            let error = session
                .apply_static_root_transform_edit(command)
                .unwrap_err();

            assert!(matches!(
                error,
                ApplyStaticRootTransformEditError::Unsupported
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the edit must preserve the exact source z-index and zero-duration correlation"
    )]
    fn math_tex_content_replaces_one_identity_and_preserves_local_height_and_center() {
        let bundle = static_imported_math_tex_bundle();
        let entity_count_before = bundle.scene.entities.len();
        let source_before = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .clone();
        let bounds_before = scene_entity_local_bounds(&source_before).unwrap();
        let command = static_root_math_tex_content_command();
        let expected_content = match &command.programs[0].operations[0].kind {
            StaticRootTransformOperationKind::MathTexContent { content } => content.clone(),
            _ => unreachable!(),
        };
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();

        assert_eq!(result.bundle.scene.entities.len(), entity_count_before);
        assert!(result.bundle.scene.animation_channels.is_empty());
        let source_after = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(source_after.id, source_before.id);
        assert_eq!(source_after.appearance, source_before.appearance);
        assert_eq!(source_after.lifetimes, source_before.lifetimes);
        assert_eq!(source_after.parent_id, source_before.parent_id);
        assert_eq!(source_after.scene_order, source_before.scene_order);
        assert_eq!(source_after.source_z_index, source_before.source_z_index);
        assert_eq!(source_after.transform, source_before.transform);
        assert_ne!(source_after.geometry, source_before.geometry);
        let bounds_after = scene_entity_local_bounds(source_after).unwrap();
        assert!(
            (bounds_after.top - bounds_after.bottom - (bounds_before.top - bounds_before.bottom))
                .abs()
                < 1e-10
        );
        assert!(
            (bounds_after.left.midpoint(bounds_after.right)
                - bounds_before.left.midpoint(bounds_before.right))
            .abs()
                < 1e-10
        );
        assert!(
            (bounds_after.bottom.midpoint(bounds_after.top)
                - bounds_before.bottom.midpoint(bounds_before.top))
            .abs()
                < 1e-10
        );
        assert_eq!(session.scene(), &result.bundle.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);
        assert!(matches!(
            result.bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. } if revision_hash == NEXT_REVISION
        ));
        let projection = result.static_root_projection.unwrap();
        assert_eq!(projection.mutations.len(), 1);
        assert!(matches!(
            &projection.mutations[0],
            StudioStaticRootProjectedMutation {
                mutation: StudioStaticRootMutation::MathTexContent { content, entity_id, interval },
                operation_id,
                transaction_id,
            } if *content == expected_content
                && entity_id == "source:formula"
                && interval.start == 0.0
                && interval.end == 0.0
                && operation_id == "set-formula-content"
                && transaction_id == "set-formula-content"
        ));
    }

    #[test]
    fn math_tex_content_accepts_unrelated_animation_and_preserves_vector_appearance() {
        let mut bundle = static_imported_math_tex_bundle();
        let styled_appearance = studio_shape_appearance();
        bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap()
            .appearance = styled_appearance.clone();
        bundle.scene.animation_channels = fixture_bundle("shared-circle-opacity.json")
            .scene
            .animation_channels;
        bundle
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::OpacityAnimation);
        bundle.scene.required_capabilities.sort();
        bundle.scene.required_capabilities.dedup();
        let expected_channels = bundle.scene.animation_channels.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .apply_static_root_transform_edit(static_root_math_tex_content_command())
            .unwrap();

        assert_eq!(result.bundle.scene.animation_channels, expected_channels);
        assert_eq!(
            result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "later")
                .unwrap()
                .appearance,
            styled_appearance
        );
    }

    #[test]
    fn rejected_math_tex_content_edits_preserve_the_retained_scene() {
        let mut missing_outline = static_root_math_tex_content_command();
        missing_outline.math_tex_outlines.clear();

        let mut mismatched_outline = static_root_math_tex_content_command();
        mismatched_outline.math_tex_outlines[0].tex_parts = vec!["not F = ma".to_owned()];

        let mut stale_binding = static_root_math_tex_content_command();
        stale_binding.source_runtime_bindings[0].runtime_entity_id = "missing".to_owned();

        let mut wrong_type = static_root_math_tex_content_command();
        wrong_type.studio_entities[0].kind = StaticRootTransformEntityKind::Other;

        let mut nonzero_interval = static_root_math_tex_content_command();
        nonzero_interval.programs[0].operations[0].interval.end = 0.25;

        let mut mixed_family = static_root_math_tex_content_command();
        mixed_family.programs[0]
            .operations
            .push(StaticRootTransformOperation {
                depends_on: vec![],
                entity_id: Some("source:formula".to_owned()),
                id: "move-formula".to_owned(),
                interval: IntervalV1 {
                    end: 0.0,
                    start: 0.0,
                },
                kind: StaticRootTransformOperationKind::Position {
                    position: Some(PointV1 { x: 0.0, y: 0.0 }),
                },
                origin: StudioAuthoringOrigin::StudioDefault,
            });

        let mut nested_bundle = static_imported_math_tex_bundle();
        nested_bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap()
            .parent_id = Some("earlier".to_owned());

        let mut target_animated_bundle = static_imported_math_tex_bundle();
        let mut target_channel = fixture_bundle("shared-circle-opacity.json")
            .scene
            .animation_channels
            .remove(0);
        let AnimationChannelV1::Opacity { entity_id, .. } = &mut target_channel else {
            panic!("fixture must contain an opacity channel");
        };
        *entity_id = "later".to_owned();
        target_animated_bundle.scene.animation_channels = vec![target_channel];
        target_animated_bundle
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::OpacityAnimation);
        target_animated_bundle.scene.required_capabilities.sort();
        target_animated_bundle.scene.required_capabilities.dedup();

        let cases = vec![
            (static_imported_math_tex_bundle(), missing_outline),
            (static_imported_math_tex_bundle(), mismatched_outline),
            (static_imported_math_tex_bundle(), stale_binding),
            (static_imported_math_tex_bundle(), wrong_type),
            (static_imported_math_tex_bundle(), nonzero_interval),
            (static_imported_math_tex_bundle(), mixed_family),
            (nested_bundle, static_root_math_tex_content_command()),
            (
                target_animated_bundle,
                static_root_math_tex_content_command(),
            ),
        ];
        for (bundle, command) in cases {
            let mut session = EngineSessionV1::new(bundle).unwrap();
            let before = session.scene().clone();
            assert!(matches!(
                session.apply_static_root_transform_edit(command),
                Err(ApplyStaticRootTransformEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &before);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }

        let mut stale_revision = static_root_math_tex_content_command();
        stale_revision.expected_base_revision = "stale".to_owned();
        let mut session = EngineSessionV1::new(static_imported_math_tex_bundle()).unwrap();
        let before = session.scene().clone();
        assert!(matches!(
            session.apply_static_root_transform_edit(stale_revision),
            Err(ApplyStaticRootTransformEditError::Transform(
                TransformSceneEntityError::StaleBaseRevision
            ))
        ));
        assert_eq!(session.scene(), &before);
    }

    #[test]
    fn static_root_motion_projector_uses_the_preceding_position_and_only_real_insertions() {
        let bundle = static_imported_bundle();
        let mut command = static_root_position_command();
        command.programs.push(static_root_motion_edit_input(vec![
            "source:circle".to_owned(),
        ]));
        let projection = project_studio_motion_edit(&ProjectStudioMotionEditCommand {
            base_duration: bundle.scene.duration,
            batch: StudioMotionProjectionBatch::StaticRoot {
                programs: command.programs,
                studio_entities: vec![StaticRootMotionProjectionEntityIdentity {
                    identity: command.studio_entities[0].clone(),
                    lifetime: vec![IntervalV1 {
                        end: bundle.scene.duration,
                        start: 0.0,
                    }],
                }],
            },
        })
        .unwrap();

        assert_eq!(projection.insertions.len(), 1);
        assert_eq!(
            projection.insertions[0].transaction_id,
            "move-imported-root"
        );
        assert_eq!(projection.motions[0].from, PointV1 { x: 400.0, y: 180.0 });
        assert_eq!(projection.motions[0].to, PointV1 { x: 640.0, y: 100.0 });
    }
}
