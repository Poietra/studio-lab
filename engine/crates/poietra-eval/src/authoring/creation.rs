use std::collections::{BTreeMap, BTreeSet};

use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, AssetReferenceV1, ContractVersionV1, CubicPathV1,
    CubicSegmentV1, CubicSubpathV1, EasingV1, FidelityV1, FillRuleV1, FillStyleV1,
    FragmentMaterialV1, ImageLocalRectV1, ImageSamplerV1, IntervalV1, KeyframeV1, PointV1,
    ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1, SceneAppearanceV1, SceneCapabilityV1,
    SceneEntityV1, SceneGeometryV1, SceneIrBundleV1, SceneSourceV1, VectorAppearanceValueV1,
};
use serde::{Deserialize, Serialize};
use unicode_normalization::is_nfc;

use crate::{EngineSessionV1, EvaluationError};

use super::motion::{
    ApplyStudioMotionEditError, PlannedSceneMotion, PlannedStudioMotion, StudioMotionEasing,
    StudioMotionPlan, StudioMotionProjection, StudioMotionProjectionInsertion,
    StudioMotionProjectionTarget, StudioProjectedMotion, append_planned_scene_motions,
    authored_motion_easing, project_studio_motion_plan,
};
use super::presence::{PersistentSceneRemoval, apply_persistent_scene_removals};
use super::timeline::{SceneTimelineInsertion, insert_scene_time, shift_interval_for_insertion};
use super::transform::{apply_world_rotation, rotation_is_noop, set_vector_paint_alpha};
use super::{
    ApplyStudioPersistentRemoveError, SceneEditAnchorSource, SceneEditExecution,
    SceneEditOperationFacts, SceneEditScheduleMode, StudioAuthoringDimensions,
    StudioAuthoringEditResult, StudioAuthoringEntityKind, StudioAuthoringOrigin,
    StudioAuthoringSize, StudioCreationMathTexOutline, StudioCreationTextOutline,
    StudioPersistentRemoveProjection, StudioPersistentRemoveProjectionEntry, StudioTextContent,
    StudioTextLayout, TIMELINE_ANCHOR_EPSILON, close_transform_baseline_value,
    scene_edit_anchor_is_closed, scene_edit_structure_is_closed, studio_arrow_appearance,
    studio_authoring_point_is_finite, studio_authoring_shape_size,
    studio_authoring_size_is_positive, studio_math_tex_appearance, studio_point_to_scene_point,
    studio_shape_appearance, studio_timeline_semantic_values_match, studio_vector_to_scene_vector,
    unused_channel_id,
};

#[derive(Clone, Debug, PartialEq)]
enum CreateSceneEntityGeometry {
    Arrow,
    Circle {
        radius: f64,
    },
    Image {
        asset: AssetReferenceV1,
        local_rect: ImageLocalRectV1,
        sampler: ImageSamplerV1,
    },
    Line,
    Rectangle {
        height: f64,
        width: f64,
    },
    CubicOutline {
        path: CubicPathV1,
    },
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityFadeIn {
    end: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityInstantTransform {
    at: f64,
    position: PointV1,
    rotation: f64,
    scale_x: f64,
    scale_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntity {
    appearance_at: Option<f64>,
    fade_in: Option<CreateSceneEntityFadeIn>,
    fill_color: Option<RgbaColorV1>,
    geometry: CreateSceneEntityGeometry,
    id: String,
    lifetime: IntervalV1,
    material_parameter_keyframes: Vec<KeyframeV1<FragmentMaterialV1>>,
    opacity_keyframes: Vec<KeyframeV1<f64>>,
    paint_opacity: f64,
    position: PointV1,
    rotation: f64,
    rotation_keyframes: Vec<KeyframeV1<f64>>,
    scale: f64,
    uniform_scale_keyframes: Vec<KeyframeV1<f64>>,
    source_z_index: Option<f64>,
    stroke_color: Option<RgbaColorV1>,
    instant_transform: Option<CreateSceneEntityInstantTransform>,
    visible: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntitiesCommand {
    entities: Vec<CreateSceneEntity>,
    expected_base_revision: String,
    groups: Vec<PlannedStudioLogicalGroup>,
    motions: Vec<PlannedSceneMotion>,
    next_revision: String,
    persistent_removals: Vec<PersistentSceneRemoval>,
    provenance: ProvenanceRecordV1,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

/// One Studio-owned entity created by an admitted creation edit.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectedCreationEntity {
    pub created_lifetime: IntervalV1,
    pub entity_id: String,
    pub initial_dimensions: StudioAuthoringDimensions,
    pub initial_rotation: f64,
    pub initial_scale: f64,
    pub kind: StudioAuthoringEntityKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<StudioCreationImageSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<StudioTextLayout>,
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tex_parts: Option<Vec<String>>,
    pub transaction_id: String,
}

/// One closed PNG placement carried by a Studio Image creation Program.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationImageSpec {
    pub asset: AssetReferenceV1,
    pub local_rect: ImageLocalRectV1,
    pub sampler: ImageSamplerV1,
}

/// One exact property mutation resolved by the shared creation planner.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioCreationProjectedMutationKind {
    Position {
        value: PointV1,
    },
    FadeIn {
        from: f64,
        to: f64,
    },
    UniformScale {
        from: f64,
        to: f64,
    },
    UniformScaleKeyframes {
        easing: EasingV1,
        from: f64,
        to: f64,
    },
    Rotation {
        from: f64,
        to: f64,
    },
    RotationKeyframes {
        easing: EasingV1,
        from: f64,
        to: f64,
    },
    Opacity {
        value: f64,
    },
    SourceZIndex {
        source_z_index: f64,
    },
    Visibility {
        visible: bool,
    },
    OpacityKeyframes {
        easing: EasingV1,
        from: f64,
        to: f64,
    },
    MaterialParameterKeyframes {
        easing: EasingV1,
        from: f64,
        name: String,
        parameter_index: usize,
        to: f64,
    },
    FillColor {
        value: String,
    },
    StrokeColor {
        value: String,
    },
    Resize {
        from_dimensions: StudioAuthoringDimensions,
        from_position: PointV1,
        to_dimensions: StudioAuthoringDimensions,
        to_position: PointV1,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioCreationProjectedMutation {
    pub entity_id: String,
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub kind: StudioCreationProjectedMutationKind,
    pub operation_id: String,
    pub transaction_id: String,
}

/// Complete snapshot-free projection of one admitted Studio creation batch.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioCreationProjection {
    pub entities: Vec<StudioProjectedCreationEntity>,
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub motions: Vec<StudioProjectedMotion>,
    pub mutations: Vec<StudioCreationProjectedMutation>,
    pub projected_duration: f64,
    pub removals: Vec<StudioPersistentRemoveProjectionEntry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEntitySpec {
    pub dimensions: StudioAuthoringDimensions,
    pub id: String,
    #[serde(default)]
    pub image: Option<StudioCreationImageSpec>,
    pub kind: StudioAuthoringEntityKind,
    #[serde(default)]
    pub layout: Option<StudioTextLayout>,
    pub lifetime_end: Option<f64>,
    pub lifetime_start: f64,
    pub text: Option<String>,
    pub tex_parts: Option<Vec<String>>,
}

/// Easing presets admitted for scalar Studio property tracks.
///
/// Motion-path authoring deliberately keeps its smaller [`StudioMotionEasing`]
/// contract; the additional CSS-compatible presets apply only to property keyframes.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioPropertyEasing {
    Linear,
    Smooth,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioCreationOperationKind {
    Create {
        entity: StudioCreationEntitySpec,
    },
    Position {
        position: Option<PointV1>,
    },
    FadeIn {
        persistent: bool,
    },
    UniformScale {
        control_present: bool,
        from: Option<f64>,
        relative_factor: Option<f64>,
        to: Option<f64>,
    },
    UniformScaleKeyframes {
        easing: StudioPropertyEasing,
        from: Option<f64>,
        to: Option<f64>,
    },
    RotationKeyframes {
        easing: StudioPropertyEasing,
        from: Option<f64>,
        to: Option<f64>,
    },
    Rotation {
        control_present: bool,
        from: Option<f64>,
        relative_delta: Option<f64>,
        to: Option<f64>,
    },
    Opacity {
        alpha: Option<f64>,
    },
    SourceZIndex {
        #[serde(default)]
        document_static: bool,
        #[serde(default)]
        from_source_z_index: Option<f64>,
        source_z_index: Option<f64>,
    },
    Visibility {
        visible: Option<bool>,
    },
    OpacityKeyframes {
        easing: StudioPropertyEasing,
        from: Option<f64>,
        to: Option<f64>,
    },
    MaterialParameterKeyframes {
        easing: StudioPropertyEasing,
        from: Option<f64>,
        material: FragmentMaterialV1,
        name: String,
        parameter_index: usize,
        to: Option<f64>,
    },
    FillColor {
        color: Option<String>,
    },
    StrokeColor {
        color: Option<String>,
    },
    Resize {
        from_dimensions: StudioAuthoringDimensions,
        from_position: PointV1,
        from_scale: f64,
        shape: StudioAuthoringEntityKind,
        to_dimensions: StudioAuthoringDimensions,
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
    Group {
        child_entity_ids: Vec<String>,
        group_id: String,
    },
    Ungroup {
        group_id: String,
    },
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioCreationOperation {
    pub depends_on: Vec<String>,
    pub entity_id: Option<String>,
    pub id: String,
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub kind: StudioCreationOperationKind,
    pub origin: StudioAuthoringOrigin,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: SceneEditAnchorSource,
    pub intent_count: usize,
    /// Host-side Manim export metadata; canonical Scene admission does not depend on it.
    pub lowering_supported: bool,
    pub operations: Vec<StudioCreationOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: SceneEditExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: SceneEditScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioCreationEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    pub next_revision: String,
    pub programs: Vec<StudioCreationEditInput>,
    #[serde(default)]
    pub text_outlines: Vec<StudioCreationTextOutline>,
    pub viewport: StudioAuthoringSize,
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
    #[error("a created entity appearance edit must be finite, timed, and supported")]
    InvalidAppearanceEdit,
    #[error(
        "Studio grouping requires visible contiguous Studio-created root leaves without rotation keyframes"
    )]
    InvalidHierarchy,
    #[error(transparent)]
    Motion(#[from] ApplyStudioMotionEditError),
    #[error(transparent)]
    PersistentRemove(#[from] ApplyStudioPersistentRemoveError),
    #[error("the Scene containing the created entities failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectStudioCreationEditError {
    #[error("the normalized Studio Programs do not authorize one creation batch")]
    Unsupported,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioCreationEditError {
    #[error("the normalized Studio edit does not authorize one entity-creation batch")]
    Unsupported,
    #[error(transparent)]
    Create(#[from] CreateSceneEntitiesError),
}

fn studio_creation_edit_input_is_closed(program: &StudioCreationEditInput) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| SceneEditOperationFacts {
            depends_on: &operation.depends_on,
            id: &operation.id,
        })
        .collect::<Vec<_>>();
    let producers = program
        .operations
        .iter()
        .filter_map(|operation| match &operation.kind {
            StudioCreationOperationKind::Create { entity } => {
                Some((entity.id.as_str(), operation.id.as_str()))
            }
            StudioCreationOperationKind::Position { .. }
            | StudioCreationOperationKind::FadeIn { .. }
            | StudioCreationOperationKind::UniformScale { .. }
            | StudioCreationOperationKind::Rotation { .. }
            | StudioCreationOperationKind::Opacity { .. }
            | StudioCreationOperationKind::SourceZIndex { .. }
            | StudioCreationOperationKind::Visibility { .. }
            | StudioCreationOperationKind::OpacityKeyframes { .. }
            | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
            | StudioCreationOperationKind::UniformScaleKeyframes { .. }
            | StudioCreationOperationKind::RotationKeyframes { .. }
            | StudioCreationOperationKind::FillColor { .. }
            | StudioCreationOperationKind::StrokeColor { .. }
            | StudioCreationOperationKind::Resize { .. }
            | StudioCreationOperationKind::PersistentRemove { .. }
            | StudioCreationOperationKind::CreateMotion { .. }
            | StudioCreationOperationKind::Group { .. }
            | StudioCreationOperationKind::Ungroup { .. }
            | StudioCreationOperationKind::Unsupported => None,
        })
        .collect::<Vec<_>>();
    let identity_edges = program
        .operations
        .iter()
        .filter_map(|operation| {
            let entity_id = operation.entity_id.as_deref()?;
            let (_, producer_id) = producers
                .iter()
                .find(|(produced_id, _)| *produced_id == entity_id)?;
            (*producer_id != operation.id).then_some((*producer_id, operation.id.as_str()))
        })
        .collect::<Vec<_>>();
    (1..=16).contains(&program.intent_count)
        && program
            .operations
            .iter()
            .all(|operation| operation.origin == program.origin)
        && scene_edit_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &identity_edges,
        )
}

fn closed_studio_creation_motion_operations(
    program: &StudioCreationEditInput,
    scene_duration: f64,
) -> Option<Vec<&StudioCreationOperation>> {
    let mut operations = program
        .schedule_order
        .iter()
        .map(|operation_id| {
            program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
        })
        .collect::<Option<Vec<_>>>()?;
    if !studio_creation_edit_input_is_closed(program)
        || operations.iter().any(|operation| {
            operation.entity_id.is_some()
                || !matches!(
                    operation.kind,
                    StudioCreationOperationKind::CreateMotion { .. }
                )
                || !operation.interval.start.is_finite()
                || !operation.interval.end.is_finite()
                || operation.interval.start < 0.0
                || operation.interval.start >= operation.interval.end
                || operation.interval.end > scene_duration + TIMELINE_ANCHOR_EPSILON
        })
    {
        return None;
    }

    if program.requested_execution == SceneEditExecution::Parallel {
        operations.sort_by(|left, right| left.interval.start.total_cmp(&right.interval.start));
    }
    let first = *operations.first()?;
    if (program.anchor_resolved_seconds - first.interval.start).abs() > TIMELINE_ANCHOR_EPSILON {
        return None;
    }

    match program.requested_execution {
        SceneEditExecution::Sequence => {
            if operations
                .windows(2)
                .any(|pair| pair[1].interval.start < pair[0].interval.end - TIMELINE_ANCHOR_EPSILON)
            {
                return None;
            }
        }
        SceneEditExecution::Parallel => {
            let StudioCreationOperationKind::CreateMotion { easing, .. } = &first.kind else {
                return None;
            };
            if program.schedule_mode != SceneEditScheduleMode::Parallel {
                return None;
            }
            let mut bucket_start = first.interval.start;
            let mut bucket_end = first.interval.end;
            let mut bucket_easing = *easing;
            for operation in operations.iter().skip(1) {
                let StudioCreationOperationKind::CreateMotion {
                    easing: candidate_easing,
                    ..
                } = &operation.kind
                else {
                    return None;
                };
                if (operation.interval.start - bucket_start).abs() <= TIMELINE_ANCHOR_EPSILON {
                    if *candidate_easing != bucket_easing
                        || (operation.interval.end - bucket_end).abs() > TIMELINE_ANCHOR_EPSILON
                    {
                        return None;
                    }
                    bucket_end = bucket_end.max(operation.interval.end);
                } else {
                    if operation.interval.start < bucket_end - TIMELINE_ANCHOR_EPSILON {
                        return None;
                    }
                    bucket_start = operation.interval.start;
                    bucket_end = operation.interval.end;
                    bucket_easing = *candidate_easing;
                }
            }
        }
    }
    Some(operations)
}

struct PlannedStudioCreationEntity {
    appearance_at: Option<f64>,
    create_operation_id: String,
    creation_transaction_id: String,
    creation_program_rank: usize,
    current_dimensions: StudioAuthoringDimensions,
    current_text_content: Option<StudioTextContent>,
    fill_color_override: Option<String>,
    current_opacity: f64,
    current_rotation: f64,
    stroke_color_override: Option<String>,
    fade_interval: Option<IntervalV1>,
    initial_dimensions: StudioAuthoringDimensions,
    initial_position: PointV1,
    instant_at: Option<f64>,
    instant_rotation: f64,
    has_position_or_resize_instant: bool,
    kind: StudioAuthoringEntityKind,
    lifetime: IntervalV1,
    material_parameter_keyframes: Vec<KeyframeV1<FragmentMaterialV1>>,
    opacity_keyframes: Vec<KeyframeV1<f64>>,
    persistent_removal: Option<PersistentSceneRemoval>,
    position: PointV1,
    rotation_keyframes: Vec<KeyframeV1<f64>>,
    scale: f64,
    uniform_scale_keyframes: Vec<KeyframeV1<f64>>,
    source_z_index: Option<f64>,
    spec: StudioCreationEntitySpec,
    visible: bool,
}

struct StudioCreationTimelinePlan {
    insertions: Vec<StudioMotionProjectionInsertion>,
    offsets: Vec<f64>,
    ordered_programs: Vec<usize>,
    projected_duration: f64,
    ranked_insertions: Vec<(usize, SceneTimelineInsertion)>,
    ranks: Vec<usize>,
}

fn studio_creation_insertion_duration(program: &StudioCreationEditInput) -> f64 {
    let creates_entity = program
        .operations
        .iter()
        .any(|operation| matches!(operation.kind, StudioCreationOperationKind::Create { .. }));
    let maximum_end = program
        .operations
        .iter()
        .filter(|operation| {
            if creates_entity {
                matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
            } else {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::CreateMotion { .. }
                )
            }
        })
        .map(|operation| operation.interval.end)
        .fold(program.anchor_resolved_seconds, f64::max);
    maximum_end - program.anchor_resolved_seconds
}

fn plan_studio_creation_timeline(
    base_duration: f64,
    programs: &[StudioCreationEditInput],
) -> Result<StudioCreationTimelinePlan, ProjectStudioCreationEditError> {
    if !base_duration.is_finite()
        || base_duration <= 0.0
        || programs.is_empty()
        || programs.iter().any(|program| {
            program.transaction_id.is_empty()
                || !scene_edit_anchor_is_closed(
                    &program.anchor_source,
                    program.anchor_captured_playhead,
                    program.anchor_resolved_seconds,
                    base_duration,
                )
                || !studio_creation_edit_input_is_closed(program)
        })
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let mut transaction_ids = BTreeSet::new();
    if programs
        .iter()
        .any(|program| !transaction_ids.insert(program.transaction_id.as_str()))
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let mut operation_ids = BTreeSet::new();
    if programs
        .iter()
        .flat_map(|program| &program.operations)
        .any(|operation| {
            operation.id.is_empty()
                || !operation.interval.start.is_finite()
                || !operation.interval.end.is_finite()
                || operation.interval.end < operation.interval.start
                || !operation_ids.insert(operation.id.as_str())
        })
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }

    let mut ordered_programs = (0..programs.len()).collect::<Vec<_>>();
    ordered_programs.sort_by(|left, right| {
        programs[*left]
            .anchor_resolved_seconds
            .total_cmp(&programs[*right].anchor_resolved_seconds)
            .then(left.cmp(right))
    });
    let mut offsets = vec![0.0; programs.len()];
    let mut ranks = vec![0; programs.len()];
    let mut insertions = Vec::new();
    let mut ranked_insertions = Vec::new();
    let mut resolved_offset = 0.0;
    let mut projected_duration = base_duration;
    for (rank, program_index) in ordered_programs.iter().copied().enumerate() {
        let program = &programs[program_index];
        let insertion_duration = studio_creation_insertion_duration(program);
        let at = program.anchor_resolved_seconds + resolved_offset;
        if !insertion_duration.is_finite()
            || insertion_duration < 0.0
            || !at.is_finite()
            || at > projected_duration + TIMELINE_ANCHOR_EPSILON
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        offsets[program_index] = resolved_offset;
        ranks[program_index] = rank;
        if insertion_duration > 0.0 {
            let insertion = SceneTimelineInsertion {
                at,
                duration: insertion_duration,
            };
            insertions.push(StudioMotionProjectionInsertion {
                at,
                duration: insertion_duration,
                transaction_id: program.transaction_id.clone(),
            });
            ranked_insertions.push((rank, insertion));
            resolved_offset += insertion_duration;
            projected_duration += insertion_duration;
        }
    }
    Ok(StudioCreationTimelinePlan {
        insertions,
        offsets,
        ordered_programs,
        projected_duration,
        ranked_insertions,
        ranks,
    })
}

fn shift_studio_creation_time(
    mut at: f64,
    program_rank: usize,
    ranked_insertions: &[(usize, SceneTimelineInsertion)],
) -> f64 {
    for (rank, insertion) in ranked_insertions {
        if *rank > program_rank && at >= insertion.at - TIMELINE_ANCHOR_EPSILON {
            at += insertion.duration;
        }
    }
    at
}

struct StudioCreationPlan {
    entities: Vec<PlannedStudioCreationEntity>,
    groups: Vec<PlannedStudioLogicalGroup>,
    motion_projection: StudioMotionProjection,
    mutations: Vec<StudioCreationProjectedMutation>,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioLogicalGroup {
    child_entity_ids: Vec<String>,
    group_id: String,
    lifetimes: Vec<IntervalV1>,
}

impl StudioCreationPlan {
    fn projection(&self) -> StudioCreationProjection {
        let entities = self
            .entities
            .iter()
            .map(|state| {
                let initial_text = studio_creation_spec_text_content(&state.spec);
                StudioProjectedCreationEntity {
                    created_lifetime: state.lifetime.clone(),
                    entity_id: state.spec.id.clone(),
                    initial_dimensions: state.initial_dimensions,
                    initial_rotation: 0.0,
                    initial_scale: 1.0,
                    kind: state.kind,
                    image: state.spec.image.clone(),
                    layout: initial_text.as_ref().and_then(|content| {
                        (content.layout != StudioTextLayout::default()).then_some(content.layout)
                    }),
                    operation_id: state.create_operation_id.clone(),
                    text: initial_text.map(|content| content.text),
                    tex_parts: state.spec.tex_parts.clone(),
                    transaction_id: state.creation_transaction_id.clone(),
                }
            })
            .collect();
        let removals = self
            .entities
            .iter()
            .filter_map(|state| state.persistent_removal.as_ref())
            .map(|removal| StudioPersistentRemoveProjectionEntry {
                affected_scene_entity_ids: vec![removal.entity_id.clone()],
                fade_interval: (removal.interval.start < removal.interval.end)
                    .then_some(removal.interval.clone()),
                operation_id: removal.operation_id.clone(),
                removed_at: removal.interval.end,
                resulting_lifetime_end: removal.interval.end,
                scene_entity_id: removal.entity_id.clone(),
                studio_entity_id: removal.studio_entity_id.clone(),
                transaction_id: removal.transaction_id.clone(),
            })
            .collect();
        StudioCreationProjection {
            entities,
            insertions: self.motion_projection.insertions.clone(),
            motions: self.motion_projection.motions.clone(),
            mutations: self.mutations.clone(),
            projected_duration: self.motion_projection.projected_duration,
            removals,
        }
    }
}

fn studio_creation_motion_is_compatible(
    state: &PlannedStudioCreationEntity,
    motion_interval: &IntervalV1,
) -> bool {
    let fade_end = state.fade_interval.as_ref().map(|interval| interval.end);
    !state.has_position_or_resize_instant
        && motion_interval.start >= state.lifetime.start - TIMELINE_ANCHOR_EPSILON
        && motion_interval.end <= state.lifetime.end + TIMELINE_ANCHOR_EPSILON
        && fade_end.is_none_or(|end| motion_interval.start >= end - TIMELINE_ANCHOR_EPSILON)
        && state
            .instant_at
            .is_none_or(|at| at >= motion_interval.end - TIMELINE_ANCHOR_EPSILON)
        && state.persistent_removal.as_ref().is_none_or(|removal| {
            removal.interval.start >= motion_interval.end - TIMELINE_ANCHOR_EPSILON
                && state
                    .instant_at
                    .is_none_or(|at| removal.interval.start >= at - TIMELINE_ANCHOR_EPSILON)
                && fade_end
                    .is_none_or(|end| removal.interval.start >= end - TIMELINE_ANCHOR_EPSILON)
        })
}

fn studio_creation_text_is_canonical(text: &str) -> bool {
    let lines = text.split('\n').collect::<Vec<_>>();
    !text.is_empty()
        && text.chars().count() <= 256
        && lines.len() <= 8
        && lines.iter().all(|line| line.chars().count() <= 128)
        && text
            .chars()
            .all(|character| character == '\n' || !character.is_control())
        && is_nfc(text)
        && !text.trim().is_empty()
}

fn studio_text_content_is_canonical(content: &StudioTextContent) -> bool {
    studio_creation_text_is_canonical(&content.text)
        && content.layout.font_size.is_finite()
        && content.layout.font_size > 0.0
        && content.layout.line_height.is_finite()
        && content.layout.line_height > 0.0
}

fn studio_creation_spec_text_content(spec: &StudioCreationEntitySpec) -> Option<StudioTextContent> {
    spec.text.as_ref().map(|text| StudioTextContent {
        layout: spec.layout.unwrap_or_default(),
        text: text.clone(),
    })
}

struct PlannedStudioGroupRotation {
    angle_radians: f64,
    entity_ids: BTreeSet<String>,
}

struct PlannedStudioGroupLayerOrder {
    entity_ids: BTreeSet<String>,
}

fn property_easing(easing: StudioPropertyEasing) -> EasingV1 {
    match easing {
        StudioPropertyEasing::Linear => EasingV1::Linear {},
        StudioPropertyEasing::Smooth => EasingV1::ManimSmooth {},
        StudioPropertyEasing::EaseIn => EasingV1::CubicBezier {
            x1: 0.42,
            x2: 1.0,
            y1: 0.0,
            y2: 1.0,
        },
        StudioPropertyEasing::EaseOut => EasingV1::CubicBezier {
            x1: 0.0,
            x2: 0.58,
            y1: 0.0,
            y2: 1.0,
        },
        StudioPropertyEasing::EaseInOut => EasingV1::CubicBezier {
            x1: 0.42,
            x2: 0.58,
            y1: 0.0,
            y2: 1.0,
        },
    }
}

fn closed_studio_uniform_scale_track(
    program: &StudioCreationEditInput,
) -> Option<(&str, Vec<&StudioCreationOperation>)> {
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != SceneEditExecution::Sequence
        || program.schedule_mode != SceneEditScheduleMode::Sequence
        || program.operations.is_empty()
    {
        return None;
    }
    let operations = program
        .schedule_order
        .iter()
        .filter_map(|operation_id| {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)?;
            matches!(
                operation.kind,
                StudioCreationOperationKind::UniformScaleKeyframes { .. }
            )
            .then_some(operation)
        })
        .collect::<Vec<_>>();
    let entity_id = operations.first()?.entity_id.as_deref()?;
    if operations.first()?.interval.start + TIMELINE_ANCHOR_EPSILON
        < program.anchor_resolved_seconds
    {
        return None;
    }
    for (index, operation) in operations.iter().enumerate() {
        let StudioCreationOperationKind::UniformScaleKeyframes {
            easing: _,
            from: Some(from),
            to: Some(to),
        } = &operation.kind
        else {
            return None;
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.as_deref() != Some(entity_id)
            || !from.is_finite()
            || *from <= 0.0
            || !to.is_finite()
            || *to <= 0.0
        {
            return None;
        }
        if operations.len() == 1 && interval_is_exact_point(&operation.interval) {
            if !close_transform_baseline_value(*from, *to) {
                return None;
            }
            continue;
        }
        if operation.interval.end <= operation.interval.start + TIMELINE_ANCHOR_EPSILON {
            return None;
        }
        if let Some(previous) = index.checked_sub(1).and_then(|prior| operations.get(prior)) {
            let StudioCreationOperationKind::UniformScaleKeyframes {
                to: Some(previous_to),
                ..
            } = &previous.kind
            else {
                return None;
            };
            if !studio_timeline_semantic_values_match(
                previous.interval.end,
                operation.interval.start,
            ) || !close_transform_baseline_value(*previous_to, *from)
            {
                return None;
            }
        }
    }
    Some((entity_id, operations))
}

fn closed_studio_rotation_track(
    program: &StudioCreationEditInput,
) -> Option<(&str, Vec<&StudioCreationOperation>)> {
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != SceneEditExecution::Sequence
        || program.schedule_mode != SceneEditScheduleMode::Sequence
        || program.operations.is_empty()
    {
        return None;
    }
    let operations = program
        .schedule_order
        .iter()
        .filter_map(|operation_id| {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)?;
            matches!(
                operation.kind,
                StudioCreationOperationKind::RotationKeyframes { .. }
            )
            .then_some(operation)
        })
        .collect::<Vec<_>>();
    let entity_id = operations.first()?.entity_id.as_deref()?;
    if operations.first()?.interval.start + TIMELINE_ANCHOR_EPSILON
        < program.anchor_resolved_seconds
    {
        return None;
    }
    for (index, operation) in operations.iter().enumerate() {
        let StudioCreationOperationKind::RotationKeyframes {
            easing: _,
            from: Some(from),
            to: Some(to),
        } = &operation.kind
        else {
            return None;
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.as_deref() != Some(entity_id)
            || !from.is_finite()
            || !to.is_finite()
        {
            return None;
        }
        if operations.len() == 1 && interval_is_exact_point(&operation.interval) {
            if !close_transform_baseline_value(*from, *to) {
                return None;
            }
            continue;
        }
        if operation.interval.end <= operation.interval.start + TIMELINE_ANCHOR_EPSILON {
            return None;
        }
        if let Some(previous) = index.checked_sub(1).and_then(|prior| operations.get(prior)) {
            let StudioCreationOperationKind::RotationKeyframes {
                to: Some(previous_to),
                ..
            } = &previous.kind
            else {
                return None;
            };
            if !studio_timeline_semantic_values_match(
                previous.interval.end,
                operation.interval.start,
            ) || !close_transform_baseline_value(*previous_to, *from)
            {
                return None;
            }
        }
    }
    Some((entity_id, operations))
}

fn interval_is_exact_point(interval: &IntervalV1) -> bool {
    interval.start.to_bits() == interval.end.to_bits()
}

fn closed_studio_opacity_track(
    program: &StudioCreationEditInput,
) -> Option<(&str, Vec<&StudioCreationOperation>)> {
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != SceneEditExecution::Sequence
        || program.schedule_mode != SceneEditScheduleMode::Sequence
        || program.operations.is_empty()
    {
        return None;
    }
    let operations = program
        .schedule_order
        .iter()
        .filter_map(|operation_id| {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)?;
            matches!(
                operation.kind,
                StudioCreationOperationKind::OpacityKeyframes { .. }
            )
            .then_some(operation)
        })
        .collect::<Vec<_>>();
    let entity_id = operations.first()?.entity_id.as_deref()?;
    if operations.first()?.interval.start + TIMELINE_ANCHOR_EPSILON
        < program.anchor_resolved_seconds
    {
        return None;
    }
    for (index, operation) in operations.iter().enumerate() {
        let StudioCreationOperationKind::OpacityKeyframes {
            easing: _,
            from: Some(from),
            to: Some(to),
        } = &operation.kind
        else {
            return None;
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.as_deref() != Some(entity_id)
            || !from.is_finite()
            || !(0.0..=1.0).contains(from)
            || !to.is_finite()
            || !(0.0..=1.0).contains(to)
        {
            return None;
        }
        if operations.len() == 1 && interval_is_exact_point(&operation.interval) {
            if !close_transform_baseline_value(*from, *to) {
                return None;
            }
            continue;
        }
        if operation.interval.end <= operation.interval.start + TIMELINE_ANCHOR_EPSILON {
            return None;
        }
        if let Some(previous) = index.checked_sub(1).and_then(|prior| operations.get(prior)) {
            let StudioCreationOperationKind::OpacityKeyframes {
                to: Some(previous_to),
                ..
            } = &previous.kind
            else {
                return None;
            };
            if !studio_timeline_semantic_values_match(
                previous.interval.end,
                operation.interval.start,
            ) || !close_transform_baseline_value(*previous_to, *from)
            {
                return None;
            }
        }
    }
    Some((entity_id, operations))
}

fn closed_studio_material_parameter_track(
    program: &StudioCreationEditInput,
) -> Option<(&str, Vec<&StudioCreationOperation>)> {
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != SceneEditExecution::Sequence
        || program.schedule_mode != SceneEditScheduleMode::Sequence
        || program.operations.is_empty()
    {
        return None;
    }
    let operations = program
        .schedule_order
        .iter()
        .filter_map(|operation_id| {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)?;
            matches!(
                operation.kind,
                StudioCreationOperationKind::MaterialParameterKeyframes { .. }
            )
            .then_some(operation)
        })
        .collect::<Vec<_>>();
    let first = *operations.first()?;
    let entity_id = first.entity_id.as_deref()?;
    let StudioCreationOperationKind::MaterialParameterKeyframes {
        from: Some(first_from),
        material: first_material,
        name: first_name,
        parameter_index: first_parameter_index,
        ..
    } = &first.kind
    else {
        return None;
    };
    if first.interval.start + TIMELINE_ANCHOR_EPSILON < program.anchor_resolved_seconds
        || first_material.parameters.get(*first_parameter_index) != Some(first_from)
        || first_name.is_empty()
    {
        return None;
    }
    for (index, operation) in operations.iter().enumerate() {
        let StudioCreationOperationKind::MaterialParameterKeyframes {
            from: Some(from),
            material,
            name,
            parameter_index,
            to: Some(to),
            ..
        } = &operation.kind
        else {
            return None;
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.as_deref() != Some(entity_id)
            || material != first_material
            || name != first_name
            || parameter_index != first_parameter_index
            || !from.is_finite()
            || !to.is_finite()
        {
            return None;
        }
        if operations.len() == 1 && interval_is_exact_point(&operation.interval) {
            if !close_transform_baseline_value(*from, *to) {
                return None;
            }
            continue;
        }
        if operation.interval.end <= operation.interval.start + TIMELINE_ANCHOR_EPSILON {
            return None;
        }
        if let Some(previous) = index.checked_sub(1).and_then(|prior| operations.get(prior)) {
            let StudioCreationOperationKind::MaterialParameterKeyframes {
                to: Some(previous_to),
                ..
            } = &previous.kind
            else {
                return None;
            };
            if !studio_timeline_semantic_values_match(
                previous.interval.end,
                operation.interval.start,
            ) || !close_transform_baseline_value(*previous_to, *from)
            {
                return None;
            }
        }
    }
    Some((entity_id, operations))
}

fn closed_studio_group_rotation(
    program: &StudioCreationEditInput,
    entities: &[PlannedStudioCreationEntity],
) -> Option<PlannedStudioGroupRotation> {
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != SceneEditExecution::Parallel
        || program.schedule_mode != SceneEditScheduleMode::Parallel
        || program.schedule_edge_count != 0
        || program.operations.len() < 4
        || program.operations.len() % 2 != 0
    {
        return None;
    }
    let mut positions = BTreeMap::<String, PointV1>::new();
    let mut rotations = BTreeMap::<String, f64>::new();
    for operation in &program.operations {
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            )
            || !studio_timeline_semantic_values_match(
                operation.interval.end,
                program.anchor_resolved_seconds,
            )
        {
            return None;
        }
        let entity_id = operation.entity_id.as_ref()?;
        match &operation.kind {
            StudioCreationOperationKind::Position {
                position: Some(position),
            } if studio_authoring_point_is_finite(position) => {
                if positions
                    .insert(entity_id.clone(), position.clone())
                    .is_some()
                {
                    return None;
                }
            }
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(from),
                relative_delta: Some(relative_delta),
                to: Some(to),
            } if close_transform_baseline_value(*from, 0.0)
                && relative_delta.is_finite()
                && !rotation_is_noop(*relative_delta)
                && close_transform_baseline_value(*to, *relative_delta) =>
            {
                if rotations
                    .insert(entity_id.clone(), *relative_delta)
                    .is_some()
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    if positions.len() < 2 || positions.keys().ne(rotations.keys()) {
        return None;
    }
    let angle_radians = *rotations.first_key_value()?.1;
    if rotations
        .values()
        .any(|candidate| !close_transform_baseline_value(*candidate, angle_radians))
    {
        return None;
    }
    let first_id = positions.first_key_value()?.0;
    let first_state = entities.iter().find(|state| state.spec.id == *first_id)?;
    let first_target = positions.get(first_id)?;
    let cosine = angle_radians.cos();
    let sine = angle_radians.sin();
    for (entity_id, target) in &positions {
        let state = entities.iter().find(|state| state.spec.id == *entity_id)?;
        // A prior rigid group transform is retained in `instant_rotation` at
        // the same authoring anchor. It may receive another rigid delta; a
        // standalone appearance rotation still uses a different channel and
        // remains outside this closed composition.
        if !rotation_is_noop(state.current_rotation) || state.persistent_removal.is_some() {
            return None;
        }
        let from_x = state.position.x - first_state.position.x;
        let from_y = state.position.y - first_state.position.y;
        let expected_x = cosine * from_x + sine * from_y;
        let expected_y = -sine * from_x + cosine * from_y;
        if !close_transform_baseline_value(target.x - first_target.x, expected_x)
            || !close_transform_baseline_value(target.y - first_target.y, expected_y)
        {
            return None;
        }
    }
    Some(PlannedStudioGroupRotation {
        angle_radians,
        entity_ids: positions.into_keys().collect(),
    })
}

#[allow(
    clippy::too_many_lines,
    reason = "one closed planner owns logical-group history and paint-order admission"
)]
fn closed_studio_group_layer_order(
    program_index: usize,
    programs: &[StudioCreationEditInput],
    timeline: &StudioCreationTimelinePlan,
    entities: &[PlannedStudioCreationEntity],
    base_source_z_index_start: Option<f64>,
    base_scene_paint_order: Option<&[(f64, u32)]>,
) -> Option<PlannedStudioGroupLayerOrder> {
    let program = programs.get(program_index)?;
    if program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.intent_count != 1
        || program.requested_execution != SceneEditExecution::Parallel
        || program.schedule_mode != SceneEditScheduleMode::Parallel
        || program.schedule_edge_count != 0
        || !(2..=64).contains(&program.operations.len())
        || program.schedule_order.len() != program.operations.len()
    {
        return None;
    }
    let mut targets = BTreeMap::<String, (f64, f64)>::new();
    for operation in &program.operations {
        let entity_id = operation.entity_id.as_ref()?;
        let StudioCreationOperationKind::SourceZIndex {
            document_static: true,
            from_source_z_index: Some(from_source_z_index),
            source_z_index: Some(source_z_index),
        } = operation.kind
        else {
            return None;
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || !from_source_z_index.is_finite()
            || !source_z_index.is_finite()
            || !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            )
            || !studio_timeline_semantic_values_match(
                operation.interval.end,
                program.anchor_resolved_seconds,
            )
            || targets
                .insert(entity_id.clone(), (from_source_z_index, source_z_index))
                .is_some()
        {
            return None;
        }
    }
    if program.schedule_order.iter().collect::<BTreeSet<_>>()
        != program
            .operations
            .iter()
            .map(|operation| &operation.id)
            .collect()
    {
        return None;
    }

    let mut active_groups = BTreeMap::<String, Vec<String>>::new();
    let mut parent_by_child = BTreeMap::<String, String>::new();
    let mut reached_program = false;
    for candidate_index in &timeline.ordered_programs {
        if *candidate_index == program_index {
            reached_program = true;
            break;
        }
        let candidate = programs.get(*candidate_index)?;
        let hierarchy_operations = candidate
            .operations
            .iter()
            .filter(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Group { .. }
                        | StudioCreationOperationKind::Ungroup { .. }
                )
            })
            .collect::<Vec<_>>();
        if hierarchy_operations.is_empty() {
            continue;
        }
        if hierarchy_operations.len() != 1 || candidate.operations.len() != 1 {
            return None;
        }
        match &hierarchy_operations[0].kind {
            StudioCreationOperationKind::Group {
                child_entity_ids,
                group_id,
            } => {
                let children = child_entity_ids.iter().cloned().collect::<BTreeSet<_>>();
                if children.len() != child_entity_ids.len()
                    || children.len() < 2
                    || active_groups.contains_key(group_id)
                    || children
                        .iter()
                        .any(|child_id| parent_by_child.contains_key(child_id))
                {
                    return None;
                }
                for child_id in child_entity_ids {
                    parent_by_child.insert(child_id.clone(), group_id.clone());
                }
                active_groups.insert(group_id.clone(), child_entity_ids.clone());
            }
            StudioCreationOperationKind::Ungroup { group_id } => {
                let children = active_groups.remove(group_id)?;
                for child_id in children {
                    if parent_by_child.remove(&child_id).as_deref() != Some(group_id.as_str()) {
                        return None;
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    if !reached_program {
        return None;
    }
    let target_ids = targets.keys().cloned().collect::<BTreeSet<_>>();
    if !active_groups
        .values()
        .any(|children| children.iter().cloned().collect::<BTreeSet<_>>() == target_ids)
    {
        return None;
    }
    // Projection does not know the imported Scene's z-index baseline. Apply does,
    // so enforce the paint-block invariant there without duplicating the UI's
    // adjacent-block planner in the domain core.
    if let Some(base_scene_paint_order) = base_scene_paint_order {
        let group_is_one_paint_block = |projected: bool| {
            let first_created_scene_order = base_scene_paint_order
                .iter()
                .map(|(_, scene_order)| *scene_order)
                .max()
                .map_or(Some(0), |scene_order| scene_order.checked_add(1))?;
            let mut paint_order = base_scene_paint_order
                .iter()
                .map(|(source_z_index, scene_order)| Some((*scene_order, *source_z_index, false)))
                .chain(entities.iter().enumerate().map(|(index, state)| {
                    let fallback_index = u32::try_from(index).ok().map(f64::from)?;
                    let scene_order =
                        first_created_scene_order.checked_add(u32::try_from(index).ok()?)?;
                    let current = state.source_z_index.or_else(|| {
                        base_source_z_index_start.map(|start| start + fallback_index)
                    })?;
                    let source_z_index = if projected {
                        targets
                            .get(&state.spec.id)
                            .map_or(current, |(_, target)| *target)
                    } else {
                        current
                    };
                    Some((
                        scene_order,
                        source_z_index,
                        target_ids.contains(&state.spec.id),
                    ))
                }))
                .collect::<Option<Vec<_>>>()?;
            paint_order
                .sort_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
            let indexes = paint_order
                .iter()
                .enumerate()
                .filter_map(|(index, (_, _, target))| target.then_some(index))
                .collect::<Vec<_>>();
            (indexes.len() == target_ids.len()
                && indexes.windows(2).all(|pair| pair[1] == pair[0] + 1))
            .then_some(())
        };
        group_is_one_paint_block(false)?;
        group_is_one_paint_block(true)?;
    }
    let (_, (first_from, first_to)) = targets.first_key_value()?;
    let delta = first_to - first_from;
    if targets
        .values()
        .any(|(from, to)| !close_transform_baseline_value(to - from, delta))
    {
        let mut from_order = targets
            .iter()
            .map(|(entity_id, (from, _))| (entity_id, *from))
            .collect::<Vec<_>>();
        from_order.sort_by(|left, right| left.1.total_cmp(&right.1));
        let mut to_order = targets
            .iter()
            .map(|(entity_id, (_, to))| (entity_id, *to))
            .collect::<Vec<_>>();
        to_order.sort_by(|left, right| left.1.total_cmp(&right.1));
        if from_order
            .windows(2)
            .any(|pair| close_transform_baseline_value(pair[0].1, pair[1].1))
            || to_order
                .windows(2)
                .any(|pair| close_transform_baseline_value(pair[0].1, pair[1].1))
            || from_order
                .iter()
                .map(|(entity_id, _)| *entity_id)
                .ne(to_order.iter().map(|(entity_id, _)| *entity_id))
        {
            return None;
        }
    }
    for (entity_id, (from, _)) in &targets {
        let (index, state) = entities
            .iter()
            .enumerate()
            .find(|(_, state)| state.spec.id == *entity_id)?;
        let current = state.source_z_index.or_else(|| {
            let fallback_index = u32::try_from(index).ok().map(f64::from)?;
            base_source_z_index_start.map(|start| start + fallback_index)
        });
        if current.is_some_and(|current| !close_transform_baseline_value(*from, current)) {
            return None;
        }
    }
    Some(PlannedStudioGroupLayerOrder {
        entity_ids: target_ids,
    })
}

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one creation planner owns complete batch admission, ordering, and logical state"
)]
fn plan_studio_creation_edits(
    base_duration: f64,
    programs: &[StudioCreationEditInput],
    base_source_z_index_start: Option<f64>,
    base_scene_paint_order: Option<&[(f64, u32)]>,
) -> Result<StudioCreationPlan, ProjectStudioCreationEditError> {
    let timeline = plan_studio_creation_timeline(base_duration, programs)?;
    let create_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(operation.kind, StudioCreationOperationKind::Create { .. })
            })
        })
        .collect::<Vec<_>>();
    if create_programs.is_empty() {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let opacity_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::OpacityKeyframes { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    for index in &opacity_programs {
        let program = &programs[*index];
        let Some((entity_id, _)) = closed_studio_opacity_track(program) else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let creates_target = program.operations.iter().any(|operation| {
            matches!(
                &operation.kind,
                StudioCreationOperationKind::Create { entity } if entity.id == entity_id
            )
        });
        let contains_only_creation_scaffold_or_opacity =
            program.operations.iter().all(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Create { .. }
                        | StudioCreationOperationKind::Position { .. }
                        | StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        let has_competing_appearance_or_removal =
            programs
                .iter()
                .enumerate()
                .any(|(candidate_index, candidate)| {
                    candidate_index != *index
                        && candidate.operations.iter().any(|operation| {
                            operation.entity_id.as_deref() == Some(entity_id)
                                && matches!(
                                    operation.kind,
                                    StudioCreationOperationKind::Opacity { .. }
                                        | StudioCreationOperationKind::PersistentRemove { .. }
                                )
                        })
                });
        if !creates_target
            || !contains_only_creation_scaffold_or_opacity
            || has_competing_appearance_or_removal
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let material_parameter_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    for index in &material_parameter_programs {
        let program = &programs[*index];
        let Some((entity_id, _)) = closed_studio_material_parameter_track(program) else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let creates_target = program.operations.iter().any(|operation| {
            matches!(
                &operation.kind,
                StudioCreationOperationKind::Create { entity } if entity.id == entity_id
            )
        });
        let contains_only_creation_scaffold_or_property_tracks =
            program.operations.iter().all(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Create { .. }
                        | StudioCreationOperationKind::Position { .. }
                        | StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        if !creates_target || !contains_only_creation_scaffold_or_property_tracks {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let uniform_scale_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::UniformScaleKeyframes { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    for index in &uniform_scale_programs {
        let program = &programs[*index];
        let Some((entity_id, _)) = closed_studio_uniform_scale_track(program) else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let creates_target = program.operations.iter().any(|operation| {
            matches!(
                &operation.kind,
                StudioCreationOperationKind::Create { entity } if entity.id == entity_id
            )
        });
        let contains_only_creation_scaffold_or_property_tracks =
            program.operations.iter().all(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Create { .. }
                        | StudioCreationOperationKind::Position { .. }
                        | StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        if !creates_target || !contains_only_creation_scaffold_or_property_tracks {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let rotation_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::RotationKeyframes { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    for index in &rotation_programs {
        let program = &programs[*index];
        let Some((entity_id, _)) = closed_studio_rotation_track(program) else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let creates_target = program.operations.iter().any(|operation| {
            matches!(
                &operation.kind,
                StudioCreationOperationKind::Create { entity } if entity.id == entity_id
            )
        });
        let contains_only_creation_scaffold_or_property_tracks =
            program.operations.iter().all(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Create { .. }
                        | StudioCreationOperationKind::Position { .. }
                        | StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        if !creates_target || !contains_only_creation_scaffold_or_property_tracks {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let hierarchy_programs = programs
        .iter()
        .enumerate()
        .filter_map(|(index, program)| {
            program
                .operations
                .iter()
                .any(|operation| {
                    matches!(
                        operation.kind,
                        StudioCreationOperationKind::Group { .. }
                            | StudioCreationOperationKind::Ungroup { .. }
                    )
                })
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let followup_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            !create_programs.contains(index)
                && !opacity_programs.contains(index)
                && !material_parameter_programs.contains(index)
                && !uniform_scale_programs.contains(index)
                && !rotation_programs.contains(index)
                && !hierarchy_programs.contains(index)
        })
        .collect::<Vec<_>>();

    let mut create_records = Vec::new();
    let mut created_ids = BTreeSet::new();
    for program_index in &create_programs {
        let program = &programs[*program_index];
        let program_created_ids = program
            .operations
            .iter()
            .filter_map(|operation| match &operation.kind {
                StudioCreationOperationKind::Create { entity } => Some(entity.id.as_str()),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if program
            .operations
            .iter()
            .any(|operation| match &operation.kind {
                StudioCreationOperationKind::Create { .. } => {
                    operation.entity_id.is_some()
                        || !studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
                        || !studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        )
                }
                StudioCreationOperationKind::Position { position } => {
                    operation
                        .entity_id
                        .as_deref()
                        .is_none_or(|entity_id| !program_created_ids.contains(entity_id))
                        || position
                            .as_ref()
                            .is_none_or(|position| !studio_authoring_point_is_finite(position))
                        || !studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
                        || !studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        )
                }
                StudioCreationOperationKind::FadeIn { persistent } => {
                    !persistent
                        || operation
                            .entity_id
                            .as_deref()
                            .is_none_or(|entity_id| !program_created_ids.contains(entity_id))
                        || !studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
                        || operation.interval.end <= operation.interval.start
                }
                StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. } => operation
                    .entity_id
                    .as_deref()
                    .is_none_or(|entity_id| !program_created_ids.contains(entity_id)),
                StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::Unsupported => true,
            })
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut scheduled_created_ids = BTreeSet::new();
        for operation_id in &program.schedule_order {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            match &operation.kind {
                StudioCreationOperationKind::Create { entity } => {
                    scheduled_created_ids.insert(entity.id.as_str());
                }
                StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                    if operation
                        .entity_id
                        .as_deref()
                        .is_some_and(|entity_id| scheduled_created_ids.contains(entity_id)) => {}
                StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::Unsupported => {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
            }
        }
        for operation_id in &program.schedule_order {
            let operation_index = program
                .operations
                .iter()
                .position(|operation| operation.id == *operation_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let StudioCreationOperationKind::Create { entity } =
                &program.operations[operation_index].kind
            else {
                continue;
            };
            if !created_ids.insert(entity.id.as_str())
                || !matches!(
                    entity.kind,
                    StudioAuthoringEntityKind::Arrow
                        | StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::Image
                        | StudioAuthoringEntityKind::Line
                        | StudioAuthoringEntityKind::MathTex
                        | StudioAuthoringEntityKind::Rectangle
                        | StudioAuthoringEntityKind::Text
                )
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            create_records.push((*program_index, operation_index));
        }
    }

    let mut entities = Vec::with_capacity(create_records.len());
    let mut ranked_mutations = Vec::new();
    for (program_index, operation_index) in create_records {
        let program = &programs[program_index];
        let create_operation = &program.operations[operation_index];
        let StudioCreationOperationKind::Create { entity: spec } = &create_operation.kind else {
            unreachable!();
        };
        let program_rank = timeline.ranks[program_index];
        let program_offset = timeline.offsets[program_index];
        let insertion_duration = timeline
            .ranked_insertions
            .iter()
            .find(|(rank, _)| *rank == program_rank)
            .map_or(0.0, |(_, insertion)| insertion.duration);
        let duration_after_program = base_duration
            + timeline
                .ranked_insertions
                .iter()
                .filter(|(rank, _)| *rank <= program_rank)
                .map(|(_, insertion)| insertion.duration)
                .sum::<f64>();
        let mut lifetime = IntervalV1 {
            end: spec.lifetime_end.map_or(duration_after_program, |end| {
                (end + program_offset + insertion_duration).min(duration_after_program)
            }),
            start: spec.lifetime_start + program_offset,
        };
        if !spec
            .id
            .starts_with(&format!("tx:{}/entity:", program.transaction_id))
            || !studio_timeline_semantic_values_match(
                spec.lifetime_start,
                program.anchor_resolved_seconds,
            )
            || spec
                .lifetime_end
                .is_some_and(|end| !end.is_finite() || end <= spec.lifetime_start)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        for (rank, insertion) in &timeline.ranked_insertions {
            if *rank > program_rank {
                shift_interval_for_insertion(&mut lifetime, insertion);
            }
        }
        let initial_text_content = studio_creation_spec_text_content(spec);
        let creation_payload_is_valid =
            match spec.kind {
                StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle => {
                    spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_authoring_shape_size(spec.kind, spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::Arrow | StudioAuthoringEntityKind::Line => {
                    spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && spec.dimensions == StudioAuthoringDimensions::default()
                }
                StudioAuthoringEntityKind::MathTex => {
                    spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.as_ref().is_some_and(|parts| {
                            !parts.is_empty() && parts.iter().all(|part| !part.trim().is_empty())
                        })
                }
                StudioAuthoringEntityKind::Text => {
                    spec.image.is_none()
                        && spec.tex_parts.is_none()
                        && initial_text_content
                            .as_ref()
                            .is_some_and(studio_text_content_is_canonical)
                        && spec.dimensions == StudioAuthoringDimensions::default()
                }
                StudioAuthoringEntityKind::Image => {
                    spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && spec.dimensions == StudioAuthoringDimensions::default()
                        && spec.image.as_ref().is_some_and(|image| {
                            !image.asset.asset_id.is_empty()
                                && image.asset.sha256.len() == 64
                                && image.asset.sha256.bytes().all(|byte| {
                                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                                })
                                && image.local_rect.left.is_finite()
                                && image.local_rect.right.is_finite()
                                && image.local_rect.bottom.is_finite()
                                && image.local_rect.top.is_finite()
                                && image.local_rect.right > image.local_rect.left
                                && image.local_rect.top > image.local_rect.bottom
                        })
                }
                StudioAuthoringEntityKind::Other => false,
            };
        if !lifetime.start.is_finite()
            || !lifetime.end.is_finite()
            || lifetime.end <= lifetime.start
            || !creation_payload_is_valid
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let positions = program
            .operations
            .iter()
            .filter(|operation| operation.entity_id.as_deref() == Some(spec.id.as_str()))
            .filter_map(|operation| match &operation.kind {
                StudioCreationOperationKind::Position {
                    position: Some(position),
                } => Some((operation, position)),
                _ => None,
            })
            .collect::<Vec<_>>();
        let fades = program
            .operations
            .iter()
            .filter(|operation| operation.entity_id.as_deref() == Some(spec.id.as_str()))
            .filter(|operation| {
                matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
            })
            .collect::<Vec<_>>();
        if positions.len() != 1 || fades.len() > 1 {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let (position_operation, initial_position) = positions[0];
        let position_interval = IntervalV1 {
            end: lifetime.start,
            start: lifetime.start,
        };
        let position_order = program
            .schedule_order
            .iter()
            .position(|operation_id| operation_id == &position_operation.id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        ranked_mutations.push((
            program_rank,
            position_order,
            StudioCreationProjectedMutation {
                entity_id: spec.id.clone(),
                interval: position_interval,
                kind: StudioCreationProjectedMutationKind::Position {
                    value: initial_position.clone(),
                },
                operation_id: position_operation.id.clone(),
                transaction_id: program.transaction_id.clone(),
            },
        ));
        let mut fade_interval = fades.first().map(|fade| IntervalV1 {
            end: fade.interval.end + program_offset,
            start: fade.interval.start + program_offset,
        });
        if let Some(fade) = &mut fade_interval {
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(fade, insertion);
                }
            }
        }
        if fade_interval.as_ref().is_some_and(|fade| {
            !studio_timeline_semantic_values_match(fade.start, lifetime.start)
                || fade.end > lifetime.end
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if let (Some(fade), Some(interval)) = (fades.first(), fade_interval.as_ref()) {
            let fade_order = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &fade.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                fade_order,
                StudioCreationProjectedMutation {
                    entity_id: spec.id.clone(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::FadeIn { from: 0.0, to: 1.0 },
                    operation_id: fade.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
        }
        entities.push(PlannedStudioCreationEntity {
            appearance_at: None,
            create_operation_id: create_operation.id.clone(),
            creation_program_rank: program_rank,
            creation_transaction_id: program.transaction_id.clone(),
            current_dimensions: spec.dimensions,
            current_text_content: initial_text_content,
            fill_color_override: None,
            current_opacity: 1.0,
            current_rotation: 0.0,
            stroke_color_override: None,
            fade_interval,
            has_position_or_resize_instant: false,
            initial_dimensions: spec.dimensions,
            initial_position: initial_position.clone(),
            instant_at: None,
            instant_rotation: 0.0,
            kind: spec.kind,
            lifetime,
            material_parameter_keyframes: Vec::new(),
            opacity_keyframes: Vec::new(),
            persistent_removal: None,
            position: initial_position.clone(),
            rotation_keyframes: Vec::new(),
            scale: 1.0,
            uniform_scale_keyframes: Vec::new(),
            source_z_index: None,
            spec: spec.clone(),
            visible: true,
        });
    }

    for program_index in opacity_programs {
        let program = &programs[program_index];
        let (entity_id, track_operations) = closed_studio_opacity_track(program)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        if state.creation_program_rank > program_rank
            || (state.creation_program_rank == program_rank
                && state.creation_transaction_id != program.transaction_id)
            || !state.opacity_keyframes.is_empty()
            || state.persistent_removal.is_some()
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut projected = Vec::with_capacity(track_operations.len());
        for operation in track_operations {
            let StudioCreationOperationKind::OpacityKeyframes {
                easing,
                from: Some(from),
                to: Some(to),
            } = &operation.kind
            else {
                unreachable!();
            };
            let mut interval = IntervalV1 {
                end: operation.interval.end + timeline.offsets[program_index],
                start: operation.interval.start + timeline.offsets[program_index],
            };
            if state.creation_program_rank == program_rank
                && let Some((_, insertion)) = timeline
                    .ranked_insertions
                    .iter()
                    .find(|(rank, _)| *rank == program_rank)
            {
                shift_interval_for_insertion(&mut interval, insertion);
            }
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(&mut interval, insertion);
                }
            }
            if interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| interval.start <= fade.end + TIMELINE_ANCHOR_EPSILON)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let schedule_index = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &operation.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                schedule_index,
                StudioCreationProjectedMutation {
                    entity_id: entity_id.to_owned(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::OpacityKeyframes {
                        easing: property_easing(*easing),
                        from: *from,
                        to: *to,
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
            projected.push((interval, *easing, *from, *to));
        }
        if projected.first().is_none_or(|(_, _, from, _)| {
            !close_transform_baseline_value(*from, state.current_opacity)
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut keyframes = Vec::with_capacity(projected.len() + 1);
        for (index, (interval, easing, from, to)) in projected.iter().enumerate() {
            if index == 0 {
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: (interval.end > interval.start + TIMELINE_ANCHOR_EPSILON)
                        .then(|| property_easing(*easing)),
                    value: *from,
                });
            }
            if interval.end > interval.start + TIMELINE_ANCHOR_EPSILON {
                keyframes.push(KeyframeV1 {
                    at: interval.end,
                    easing_to_next: projected
                        .get(index + 1)
                        .map(|(_, next_easing, _, _)| property_easing(*next_easing)),
                    value: *to,
                });
            }
        }
        state.opacity_keyframes = keyframes;
    }

    for program_index in material_parameter_programs {
        let program = &programs[program_index];
        let (entity_id, track_operations) = closed_studio_material_parameter_track(program)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        if state.creation_program_rank > program_rank
            || (state.creation_program_rank == program_rank
                && state.creation_transaction_id != program.transaction_id)
            || !state.material_parameter_keyframes.is_empty()
            || state.persistent_removal.is_some()
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut projected = Vec::with_capacity(track_operations.len());
        for operation in track_operations {
            let StudioCreationOperationKind::MaterialParameterKeyframes {
                easing,
                from: Some(from),
                material,
                name,
                parameter_index,
                to: Some(to),
            } = &operation.kind
            else {
                unreachable!();
            };
            let mut interval = IntervalV1 {
                end: operation.interval.end + timeline.offsets[program_index],
                start: operation.interval.start + timeline.offsets[program_index],
            };
            if state.creation_program_rank == program_rank
                && let Some((_, insertion)) = timeline
                    .ranked_insertions
                    .iter()
                    .find(|(rank, _)| *rank == program_rank)
            {
                shift_interval_for_insertion(&mut interval, insertion);
            }
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(&mut interval, insertion);
                }
            }
            if interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| interval.start <= fade.end + TIMELINE_ANCHOR_EPSILON)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let schedule_index = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &operation.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                schedule_index,
                StudioCreationProjectedMutation {
                    entity_id: entity_id.to_owned(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::MaterialParameterKeyframes {
                        easing: property_easing(*easing),
                        from: *from,
                        name: name.clone(),
                        parameter_index: *parameter_index,
                        to: *to,
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
            projected.push((
                interval,
                *easing,
                *from,
                material.clone(),
                *parameter_index,
                *to,
            ));
        }
        let mut keyframes = Vec::with_capacity(projected.len() + 1);
        for (index, (interval, easing, from, material, parameter_index, to)) in
            projected.iter().enumerate()
        {
            let mut from_material = material.clone();
            let mut to_material = material.clone();
            from_material.parameters[*parameter_index] = *from;
            to_material.parameters[*parameter_index] = *to;
            if index == 0 {
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: (interval.end > interval.start + TIMELINE_ANCHOR_EPSILON)
                        .then(|| property_easing(*easing)),
                    value: from_material,
                });
            }
            if interval.end > interval.start + TIMELINE_ANCHOR_EPSILON {
                keyframes.push(KeyframeV1 {
                    at: interval.end,
                    easing_to_next: projected
                        .get(index + 1)
                        .map(|(_, next_easing, ..)| property_easing(*next_easing)),
                    value: to_material,
                });
            }
        }
        state.material_parameter_keyframes = keyframes;
    }

    for program_index in uniform_scale_programs {
        let program = &programs[program_index];
        let (entity_id, track_operations) = closed_studio_uniform_scale_track(program)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        if state.creation_program_rank > program_rank
            || (state.creation_program_rank == program_rank
                && state.creation_transaction_id != program.transaction_id)
            || !state.uniform_scale_keyframes.is_empty()
            || state.persistent_removal.is_some()
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut projected = Vec::with_capacity(track_operations.len());
        for operation in track_operations {
            let StudioCreationOperationKind::UniformScaleKeyframes {
                easing,
                from: Some(from),
                to: Some(to),
            } = &operation.kind
            else {
                unreachable!();
            };
            let mut interval = IntervalV1 {
                end: operation.interval.end + timeline.offsets[program_index],
                start: operation.interval.start + timeline.offsets[program_index],
            };
            if state.creation_program_rank == program_rank
                && let Some((_, insertion)) = timeline
                    .ranked_insertions
                    .iter()
                    .find(|(rank, _)| *rank == program_rank)
            {
                shift_interval_for_insertion(&mut interval, insertion);
            }
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(&mut interval, insertion);
                }
            }
            if interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| interval.start <= fade.end + TIMELINE_ANCHOR_EPSILON)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let schedule_index = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &operation.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                schedule_index,
                StudioCreationProjectedMutation {
                    entity_id: entity_id.to_owned(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::UniformScaleKeyframes {
                        easing: property_easing(*easing),
                        from: *from,
                        to: *to,
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
            projected.push((interval, *easing, *from, *to));
        }
        if projected
            .first()
            .is_none_or(|(_, _, from, _)| !close_transform_baseline_value(*from, state.scale))
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut keyframes = Vec::with_capacity(projected.len() + 1);
        for (index, (interval, easing, from, to)) in projected.iter().enumerate() {
            if index == 0 {
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: (interval.end > interval.start + TIMELINE_ANCHOR_EPSILON)
                        .then(|| property_easing(*easing)),
                    value: *from,
                });
            }
            if interval.end > interval.start + TIMELINE_ANCHOR_EPSILON {
                keyframes.push(KeyframeV1 {
                    at: interval.end,
                    easing_to_next: projected
                        .get(index + 1)
                        .map(|(_, next_easing, _, _)| property_easing(*next_easing)),
                    value: *to,
                });
            }
        }
        state.uniform_scale_keyframes = keyframes;
    }

    for program_index in rotation_programs {
        let program = &programs[program_index];
        let (entity_id, track_operations) = closed_studio_rotation_track(program)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        if state.creation_program_rank > program_rank
            || (state.creation_program_rank == program_rank
                && state.creation_transaction_id != program.transaction_id)
            || !state.rotation_keyframes.is_empty()
            || !state.uniform_scale_keyframes.is_empty()
            || state.persistent_removal.is_some()
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut projected = Vec::with_capacity(track_operations.len());
        for operation in track_operations {
            let StudioCreationOperationKind::RotationKeyframes {
                easing,
                from: Some(from),
                to: Some(to),
            } = &operation.kind
            else {
                unreachable!();
            };
            let mut interval = IntervalV1 {
                end: operation.interval.end + timeline.offsets[program_index],
                start: operation.interval.start + timeline.offsets[program_index],
            };
            if state.creation_program_rank == program_rank
                && let Some((_, insertion)) = timeline
                    .ranked_insertions
                    .iter()
                    .find(|(rank, _)| *rank == program_rank)
            {
                shift_interval_for_insertion(&mut interval, insertion);
            }
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(&mut interval, insertion);
                }
            }
            if interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| interval.start <= fade.end + TIMELINE_ANCHOR_EPSILON)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let schedule_index = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &operation.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                schedule_index,
                StudioCreationProjectedMutation {
                    entity_id: entity_id.to_owned(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::RotationKeyframes {
                        easing: property_easing(*easing),
                        from: *from,
                        to: *to,
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
            projected.push((interval, *easing, *from, *to));
        }
        if projected.first().is_none_or(|(_, _, from, _)| {
            !close_transform_baseline_value(*from, state.current_rotation)
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut keyframes = Vec::with_capacity(projected.len() + 1);
        for (index, (interval, easing, from, to)) in projected.iter().enumerate() {
            if index == 0 {
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: (interval.end > interval.start + TIMELINE_ANCHOR_EPSILON)
                        .then(|| property_easing(*easing)),
                    value: *from,
                });
            }
            if interval.end > interval.start + TIMELINE_ANCHOR_EPSILON {
                keyframes.push(KeyframeV1 {
                    at: interval.end,
                    easing_to_next: projected
                        .get(index + 1)
                        .map(|(_, next_easing, _, _)| property_easing(*next_easing)),
                    value: *to,
                });
            }
        }
        state.rotation_keyframes = keyframes;
    }

    let mut planned_motions = Vec::new();
    for program_index in followup_programs {
        let program = &programs[program_index];
        let contains_motion = program.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                StudioCreationOperationKind::CreateMotion { .. }
            )
        });
        if contains_motion {
            if program.operations.iter().any(|operation| {
                !matches!(
                    operation.kind,
                    StudioCreationOperationKind::CreateMotion { .. }
                )
            }) {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let operations = closed_studio_creation_motion_operations(program, base_duration)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let mut parallel_bucket_start: Option<f64> = None;
            let mut parallel_targets = BTreeSet::new();
            for operation in operations {
                let StudioCreationOperationKind::CreateMotion {
                    control_offset,
                    delta,
                    easing,
                    target_entity_ids,
                } = &operation.kind
                else {
                    unreachable!();
                };
                if target_entity_ids.is_empty()
                    || !studio_authoring_point_is_finite(control_offset)
                    || !studio_authoring_point_is_finite(delta)
                    || (control_offset.x == 0.0
                        && control_offset.y == 0.0
                        && delta.x == 0.0
                        && delta.y == 0.0)
                {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
                if program.requested_execution == SceneEditExecution::Parallel
                    && parallel_bucket_start.is_none_or(|bucket_start| {
                        (operation.interval.start - bucket_start).abs() > TIMELINE_ANCHOR_EPSILON
                    })
                {
                    parallel_bucket_start = Some(operation.interval.start);
                    parallel_targets.clear();
                }
                let mut operation_targets = BTreeSet::new();
                for entity_id in target_entity_ids {
                    let state = entities
                        .iter()
                        .find(|state| state.spec.id == *entity_id)
                        .ok_or(ProjectStudioCreationEditError::Unsupported)?;
                    if state.creation_program_rank >= timeline.ranks[program_index]
                        || !operation_targets.insert(entity_id.as_str())
                        || (program.requested_execution == SceneEditExecution::Parallel
                            && !parallel_targets.insert(entity_id.clone()))
                    {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                }
                planned_motions.push(PlannedStudioMotion {
                    base_interval: operation.interval.clone(),
                    control_offset: control_offset.clone(),
                    delta: delta.clone(),
                    easing: *easing,
                    interval: IntervalV1 {
                        end: operation.interval.end + timeline.offsets[program_index],
                        start: operation.interval.start + timeline.offsets[program_index],
                    },
                    operation_id: operation.id.clone(),
                    parallel: program.requested_execution == SceneEditExecution::Parallel,
                    target_entity_ids: target_entity_ids.clone(),
                    transaction_id: program.transaction_id.clone(),
                });
            }
            continue;
        }

        let group_rotation = closed_studio_group_rotation(program, &entities);
        let group_layer_order = closed_studio_group_layer_order(
            program_index,
            programs,
            &timeline,
            &entities,
            base_source_z_index_start,
            base_scene_paint_order,
        );
        let contains_position = program.operations.iter().any(|operation| {
            matches!(operation.kind, StudioCreationOperationKind::Position { .. })
        });
        let contains_rotation = program.operations.iter().any(|operation| {
            matches!(operation.kind, StudioCreationOperationKind::Rotation { .. })
        });
        if contains_position && contains_rotation && group_rotation.is_none() {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let contains_persistent_remove = program.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                StudioCreationOperationKind::PersistentRemove { .. }
            )
        });
        if contains_persistent_remove
            && program.operations.iter().any(|operation| {
                !matches!(
                    operation.kind,
                    StudioCreationOperationKind::PersistentRemove { .. }
                )
            })
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        for (schedule_index, operation_id) in program.schedule_order.iter().enumerate() {
            let operation = program
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            if !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            ) {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let entity_id = operation
                .entity_id
                .as_deref()
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let state = entities
                .iter_mut()
                .find(|state| state.spec.id == entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            if state.creation_program_rank >= timeline.ranks[program_index] {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let instant_at = shift_studio_creation_time(
                program.anchor_resolved_seconds + timeline.offsets[program_index],
                timeline.ranks[program_index],
                &timeline.ranked_insertions,
            );
            let instant_interval = IntervalV1 {
                end: instant_at,
                start: instant_at,
            };
            match &operation.kind {
                StudioCreationOperationKind::Position {
                    position: Some(position),
                } if studio_timeline_semantic_values_match(
                    operation.interval.end,
                    program.anchor_resolved_seconds,
                ) && studio_authoring_point_is_finite(position) =>
                {
                    record_planned_studio_creation_instant(state, instant_at)?;
                    state.has_position_or_resize_instant = true;
                    state.position = position.clone();
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Position {
                                value: position.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::UniformScale {
                    control_present,
                    from: Some(from),
                    relative_factor: Some(relative_factor),
                    to: Some(to),
                } if !control_present
                    && from.is_finite()
                    && *from > 0.0
                    && to.is_finite()
                    && *to > 0.0
                    && relative_factor.is_finite()
                    && *relative_factor > 0.0
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    )
                    && close_transform_baseline_value(*to / *from, *relative_factor) =>
                {
                    record_planned_studio_creation_instant(state, instant_at)?;
                    let projected_from = state.scale;
                    let projected_to = state.scale * relative_factor;
                    if !projected_to.is_finite() || projected_to <= 0.0 {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    state.scale = projected_to;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::UniformScale {
                                from: projected_from,
                                to: projected_to,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Rotation {
                    control_present: _,
                    from: Some(_),
                    relative_delta: Some(relative_delta),
                    to: Some(_),
                } if group_rotation.as_ref().is_some_and(|rotation| {
                    rotation.entity_ids.contains(entity_id)
                        && close_transform_baseline_value(*relative_delta, rotation.angle_radians)
                }) =>
                {
                    record_planned_studio_creation_instant(state, instant_at)?;
                    let projected_from = state.current_rotation + state.instant_rotation;
                    let projected_to = projected_from + relative_delta;
                    if !projected_to.is_finite() {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    state.instant_rotation = projected_to - state.current_rotation;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Rotation {
                                from: projected_from,
                                to: projected_to,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Rotation {
                    control_present,
                    from: Some(from),
                    relative_delta: Some(relative_delta),
                    to: Some(to),
                } if !control_present
                    && operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && from.is_finite()
                    && to.is_finite()
                    && relative_delta.is_finite()
                    && close_transform_baseline_value(*from, 0.0)
                    && (*to - *from - *relative_delta).abs() < 0.000_001
                    && !rotation_is_noop(*relative_delta)
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    )
                    && state.instant_at.is_some()
                    && rotation_is_noop(state.current_rotation)
                    && state.persistent_removal.is_none() =>
                {
                    record_planned_studio_creation_instant(state, instant_at)?;
                    let projected_from = state.instant_rotation;
                    let projected_to = projected_from + relative_delta;
                    if !projected_to.is_finite() {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    state.instant_rotation = projected_to;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Rotation {
                                from: projected_from,
                                to: projected_to,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Rotation {
                    control_present,
                    from: Some(from),
                    relative_delta: Some(relative_delta),
                    to: Some(to),
                } if !control_present
                    && operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && from.is_finite()
                    && to.is_finite()
                    && relative_delta.is_finite()
                    && close_transform_baseline_value(*from, 0.0)
                    && (*to - *from - *relative_delta).abs() < 0.000_001
                    && !rotation_is_noop(*relative_delta)
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    )
                    && studio_timeline_semantic_values_match(
                        program.anchor_resolved_seconds,
                        state.spec.lifetime_start,
                    )
                    && state.persistent_removal.is_none() =>
                {
                    record_planned_studio_creation_appearance(state, instant_at)?;
                    let projected_from = state.current_rotation;
                    let projected_to = projected_from + relative_delta;
                    if !projected_to.is_finite() {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    state.current_rotation = projected_to;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Rotation {
                                from: projected_from,
                                to: projected_to,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Opacity { alpha: Some(alpha) }
                    if operation.origin == StudioAuthoringOrigin::DirectManipulation
                        && alpha.is_finite()
                        && (0.0..=1.0).contains(alpha)
                        && !close_transform_baseline_value(*alpha, state.current_opacity)
                        && studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        )
                        && studio_timeline_semantic_values_match(
                            program.anchor_resolved_seconds,
                            state.spec.lifetime_start,
                        )
                        && state.persistent_removal.is_none() =>
                {
                    record_planned_studio_creation_appearance(state, instant_at)?;
                    state.current_opacity = *alpha;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Opacity { value: *alpha },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::SourceZIndex {
                    document_static,
                    from_source_z_index,
                    source_z_index: Some(source_z_index),
                } if operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && source_z_index.is_finite()
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    )
                    && ((!*document_static
                        && from_source_z_index.is_none()
                        && studio_timeline_semantic_values_match(
                            program.anchor_resolved_seconds,
                            state.spec.lifetime_start,
                        ))
                        || (*document_static
                            && from_source_z_index.is_some_and(f64::is_finite)
                            && group_layer_order.as_ref().is_some_and(|order| {
                                order.entity_ids.contains(entity_id)
                                    && instant_at >= state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                                    && instant_at < state.lifetime.end
                            })))
                    && state.persistent_removal.is_none() =>
                {
                    state.source_z_index = Some(*source_z_index);
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: IntervalV1 {
                                end: state.lifetime.start,
                                start: state.lifetime.start,
                            },
                            kind: StudioCreationProjectedMutationKind::SourceZIndex {
                                source_z_index: *source_z_index,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Visibility {
                    visible: Some(visible),
                } if operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && *visible != state.visible
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    )
                    && instant_at >= state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                    && instant_at < state.lifetime.end
                    && state.persistent_removal.is_none() =>
                {
                    state.visible = *visible;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Visibility {
                                visible: *visible,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::FillColor { color: Some(color) }
                    if operation.origin == StudioAuthoringOrigin::DirectManipulation
                        && matches!(
                            state.kind,
                            StudioAuthoringEntityKind::Circle
                                | StudioAuthoringEntityKind::Rectangle
                        )
                        && canonical_studio_hex_color(color).is_some()
                        && state.fill_color_override.as_deref() != Some(color.as_str())
                        && studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        )
                        && studio_timeline_semantic_values_match(
                            program.anchor_resolved_seconds,
                            state.spec.lifetime_start,
                        )
                        && state.persistent_removal.is_none() =>
                {
                    record_planned_studio_creation_appearance(state, instant_at)?;
                    state.fill_color_override = Some(color.clone());
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::FillColor {
                                value: color.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::StrokeColor { color: Some(color) }
                    if operation.origin == StudioAuthoringOrigin::DirectManipulation
                        && matches!(
                            state.kind,
                            StudioAuthoringEntityKind::Circle
                                | StudioAuthoringEntityKind::Rectangle
                        )
                        && canonical_studio_hex_color(color).is_some()
                        && state.stroke_color_override.as_deref().unwrap_or("#ffffff") != color
                        && studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        )
                        && studio_timeline_semantic_values_match(
                            program.anchor_resolved_seconds,
                            state.spec.lifetime_start,
                        )
                        && state.persistent_removal.is_none() =>
                {
                    record_planned_studio_creation_appearance(state, instant_at)?;
                    state.stroke_color_override = Some(color.clone());
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::StrokeColor {
                                value: color.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::Resize {
                    from_dimensions,
                    from_position,
                    from_scale,
                    shape,
                    to_dimensions,
                    to_position,
                } if *shape == state.kind
                    && matches!(
                        shape,
                        StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle
                    )
                    && *from_dimensions == state.current_dimensions
                    && studio_authoring_shape_size(*shape, *from_dimensions).is_some()
                    && studio_authoring_point_is_finite(from_position)
                    && close_transform_baseline_value(from_position.x, state.position.x)
                    && close_transform_baseline_value(from_position.y, state.position.y)
                    && from_scale.is_finite()
                    && *from_scale > 0.0
                    && close_transform_baseline_value(*from_scale, state.scale)
                    && studio_authoring_shape_size(*shape, *to_dimensions).is_some()
                    && studio_authoring_point_is_finite(to_position)
                    && studio_timeline_semantic_values_match(
                        operation.interval.end,
                        program.anchor_resolved_seconds,
                    ) =>
                {
                    record_planned_studio_creation_instant(state, instant_at)?;
                    state.has_position_or_resize_instant = true;
                    state.current_dimensions = *to_dimensions;
                    state.position = to_position.clone();
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: instant_interval,
                            kind: StudioCreationProjectedMutationKind::Resize {
                                from_dimensions: *from_dimensions,
                                from_position: from_position.clone(),
                                to_dimensions: *to_dimensions,
                                to_position: to_position.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::PersistentRemove { persistent }
                    if *persistent
                        && matches!(
                            operation.origin,
                            StudioAuthoringOrigin::DirectManipulation
                                | StudioAuthoringOrigin::StudioDefault
                        )
                        && operation.interval.end.is_finite()
                        && operation.interval.end >= operation.interval.start
                        && state.persistent_removal.is_none() =>
                {
                    let mut interval = IntervalV1 {
                        end: operation.interval.end + timeline.offsets[program_index],
                        start: operation.interval.start + timeline.offsets[program_index],
                    };
                    for (rank, insertion) in &timeline.ranked_insertions {
                        if *rank > timeline.ranks[program_index] {
                            shift_interval_for_insertion(&mut interval, insertion);
                        }
                    }
                    state.persistent_removal = Some(PersistentSceneRemoval {
                        entity_id: entity_id.to_owned(),
                        interval,
                        operation_id: operation.id.clone(),
                        studio_entity_id: entity_id.to_owned(),
                        transaction_id: program.transaction_id.clone(),
                    });
                }
                StudioCreationOperationKind::Create { .. }
                | StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::Unsupported => {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
            }
        }
    }

    for state in &entities {
        if (!state.rotation_keyframes.is_empty()
            && (!state.uniform_scale_keyframes.is_empty()
                || state.instant_at.is_some()
                || !rotation_is_noop(state.current_rotation)
                || !rotation_is_noop(state.instant_rotation)))
            || (!state.uniform_scale_keyframes.is_empty()
                && (state.instant_at.is_some()
                    || !rotation_is_noop(state.current_rotation)
                    || !rotation_is_noop(state.instant_rotation)))
            || (!rotation_is_noop(state.current_rotation) && state.instant_at.is_some())
            || (!rotation_is_noop(state.instant_rotation) && state.instant_at.is_none())
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if state.appearance_at.is_some_and(|at| {
            at < state.lifetime.start
                || at >= state.lifetime.end
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| at < fade.end)
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if state
            .instant_at
            .is_some_and(|at| at <= state.lifetime.start || at >= state.lifetime.end)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if let Some(removal) = &state.persistent_removal
            && (removal.interval.start < state.lifetime.start
                || removal.interval.start >= state.lifetime.end
                || removal.interval.end <= state.lifetime.start
                || removal.interval.end > state.lifetime.end
                || state
                    .fade_interval
                    .as_ref()
                    .is_some_and(|fade| removal.interval.start < fade.end)
                || state
                    .instant_at
                    .is_some_and(|at| removal.interval.start < at))
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let mut active_groups = BTreeMap::<String, Vec<String>>::new();
    let mut parent_by_child = BTreeMap::<String, String>::new();
    for program_index in hierarchy_programs {
        let program = &programs[program_index];
        if program.origin != StudioAuthoringOrigin::DirectManipulation
            || program.requested_execution != SceneEditExecution::Parallel
            || program.schedule_mode != SceneEditScheduleMode::Parallel
            || program.schedule_edge_count != 0
            || program.intent_count != 1
            || program.operations.len() != 1
            || program.schedule_order != [program.operations[0].id.clone()]
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let operation = &program.operations[0];
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.is_some()
            || !interval_is_exact_point(&operation.interval)
            || !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            )
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        match &operation.kind {
            StudioCreationOperationKind::Group {
                child_entity_ids,
                group_id,
            } => {
                let group_at = shift_studio_creation_time(
                    program.anchor_resolved_seconds + timeline.offsets[program_index],
                    timeline.ranks[program_index],
                    &timeline.ranked_insertions,
                );
                let unique_children = child_entity_ids.iter().collect::<BTreeSet<_>>();
                if child_entity_ids.len() < 2
                    || unique_children.len() != child_entity_ids.len()
                    || !group_id.starts_with(&format!("tx:{}/entity:", program.transaction_id))
                    || active_groups.contains_key(group_id)
                {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
                for child_id in child_entity_ids {
                    let child = entities
                        .iter()
                        .find(|state| state.spec.id == *child_id)
                        .ok_or(ProjectStudioCreationEditError::Unsupported)?;
                    let visible_at_group = ranked_mutations
                        .iter()
                        .filter_map(|(rank, schedule_index, mutation)| {
                            if *rank >= timeline.ranks[program_index]
                                || mutation.entity_id != *child_id
                            {
                                return None;
                            }
                            let StudioCreationProjectedMutationKind::Visibility { visible } =
                                mutation.kind
                            else {
                                return None;
                            };
                            Some((*rank, *schedule_index, visible))
                        })
                        .max_by_key(|(rank, schedule_index, _)| (*rank, *schedule_index))
                        .is_none_or(|(_, _, visible)| visible);
                    if !visible_at_group
                        || !child.rotation_keyframes.is_empty()
                        || parent_by_child.contains_key(child_id)
                        || group_at < child.lifetime.start
                        || group_at
                            >= child
                                .persistent_removal
                                .as_ref()
                                .map_or(child.lifetime.end, |removal| removal.interval.end)
                    {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                }
                for child_id in child_entity_ids {
                    parent_by_child.insert(child_id.clone(), group_id.clone());
                }
                active_groups.insert(group_id.clone(), child_entity_ids.clone());
            }
            StudioCreationOperationKind::Ungroup { group_id } => {
                let children = active_groups
                    .remove(group_id)
                    .ok_or(ProjectStudioCreationEditError::Unsupported)?;
                for child_id in children {
                    if parent_by_child.remove(&child_id).as_deref() != Some(group_id.as_str()) {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                }
            }
            _ => return Err(ProjectStudioCreationEditError::Unsupported),
        }
    }
    let groups = active_groups
        .into_iter()
        .map(|(group_id, child_entity_ids)| {
            let mut lifetimes = child_entity_ids
                .iter()
                .map(|child_id| {
                    entities
                        .iter()
                        .find(|state| state.spec.id == *child_id)
                        .map(|state| {
                            let mut lifetime = state.lifetime.clone();
                            if let Some(removal) = &state.persistent_removal {
                                lifetime.end = removal.interval.end;
                            }
                            lifetime
                        })
                        .ok_or(ProjectStudioCreationEditError::Unsupported)
                })
                .collect::<Result<Vec<_>, _>>()?;
            lifetimes.sort_by(|left, right| left.start.total_cmp(&right.start));
            let mut union = Vec::<IntervalV1>::new();
            for lifetime in lifetimes {
                if let Some(last) = union.last_mut()
                    && lifetime.start <= last.end + TIMELINE_ANCHOR_EPSILON
                {
                    last.end = last.end.max(lifetime.end);
                } else {
                    union.push(lifetime);
                }
            }
            Ok(PlannedStudioLogicalGroup {
                child_entity_ids,
                group_id,
                lifetimes: union,
            })
        })
        .collect::<Result<Vec<_>, ProjectStudioCreationEditError>>()?;

    for motion in &planned_motions {
        for entity_id in &motion.target_entity_ids {
            let state = entities
                .iter()
                .find(|state| state.spec.id == *entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            if !rotation_is_noop(state.current_rotation)
                || !rotation_is_noop(state.instant_rotation)
                || !state.rotation_keyframes.is_empty()
                || !state.uniform_scale_keyframes.is_empty()
                || !studio_creation_motion_is_compatible(state, &motion.interval)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
        }
    }
    let targets = entities
        .iter()
        .map(|state| {
            (
                state.spec.id.clone(),
                StudioMotionProjectionTarget {
                    lifetime: state.lifetime.clone(),
                    position: state.initial_position.clone(),
                },
            )
        })
        .collect();
    let motion_projection = project_studio_motion_plan(
        &StudioMotionPlan {
            insertions: timeline.insertions,
            motions: planned_motions,
            projected_duration: timeline.projected_duration,
            timeline_insertions: Vec::new(),
        },
        targets,
    )
    .map_err(|_| ProjectStudioCreationEditError::Unsupported)?;
    ranked_mutations.sort_by_key(|(rank, schedule_index, _)| (*rank, *schedule_index));
    Ok(StudioCreationPlan {
        entities,
        groups,
        motion_projection,
        mutations: ranked_mutations
            .into_iter()
            .map(|(_, _, mutation)| mutation)
            .collect(),
        timeline_insertions: timeline
            .ranked_insertions
            .into_iter()
            .map(|(_, insertion)| insertion)
            .collect(),
    })
}

fn record_planned_studio_creation_instant(
    state: &mut PlannedStudioCreationEntity,
    instant_at: f64,
) -> Result<(), ProjectStudioCreationEditError> {
    if state
        .instant_at
        .is_some_and(|prior| (prior - instant_at).abs() > 1e-9)
        || state
            .persistent_removal
            .as_ref()
            .is_some_and(|removal| instant_at >= removal.interval.start - TIMELINE_ANCHOR_EPSILON)
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    state.instant_at = Some(instant_at);
    Ok(())
}

fn canonical_studio_hex_color(value: &str) -> Option<RgbaColorV1> {
    let bytes = value.as_bytes();
    if bytes.len() != 7
        || bytes[0] != b'#'
        || !bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    let component = |start| {
        u8::from_str_radix(&value[start..start + 2], 16)
            .ok()
            .map(|component| f64::from(component) / 255.0)
    };
    Some(RgbaColorV1 {
        alpha: 1.0,
        blue: component(5)?,
        green: component(3)?,
        red: component(1)?,
    })
}

fn record_planned_studio_creation_appearance(
    state: &mut PlannedStudioCreationEntity,
    at: f64,
) -> Result<(), ProjectStudioCreationEditError> {
    if state
        .appearance_at
        .is_some_and(|prior| (prior - at).abs() > TIMELINE_ANCHOR_EPSILON)
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    state.appearance_at = Some(at);
    Ok(())
}

/// Projects one complete supported Studio creation batch without a Scene snapshot.
///
/// # Errors
///
/// Returns `Unsupported` when the complete normalized batch is outside the closed creation subset.
pub fn project_studio_creation_edits(
    base_duration: f64,
    programs: &[StudioCreationEditInput],
) -> Result<StudioCreationProjection, ProjectStudioCreationEditError> {
    Ok(plan_studio_creation_edits(base_duration, programs, None, None)?.projection())
}

fn straight_cubic_segment(start: &PointV1, end: PointV1) -> CubicSegmentV1 {
    CubicSegmentV1 {
        control1: PointV1 {
            x: start.x + (end.x - start.x) / 3.0,
            y: start.y + (end.y - start.y) / 3.0,
        },
        control2: PointV1 {
            x: start.x + (end.x - start.x) * 2.0 / 3.0,
            y: start.y + (end.y - start.y) * 2.0 / 3.0,
        },
        end,
    }
}

fn scale_cubic_path(path: &CubicPathV1, factor: f64) -> CubicPathV1 {
    let scale = |point: &mut PointV1| {
        point.x *= factor;
        point.y *= factor;
    };
    let mut scaled = path.clone();
    for subpath in &mut scaled.subpaths {
        scale(&mut subpath.start);
        for segment in &mut subpath.segments {
            scale(&mut segment.control1);
            scale(&mut segment.control2);
            scale(&mut segment.end);
        }
    }
    scaled
}

fn studio_arrow_path() -> CubicPathV1 {
    let points = [
        PointV1 { x: -1.0, y: -0.02 },
        PointV1 { x: 0.65, y: -0.02 },
        PointV1 { x: 0.65, y: -0.175 },
        PointV1 { x: 1.0, y: 0.0 },
        PointV1 { x: 0.65, y: 0.175 },
        PointV1 { x: 0.65, y: 0.02 },
        PointV1 { x: -1.0, y: 0.02 },
    ];
    let mut segments = Vec::with_capacity(points.len() - 1);
    for pair in points.windows(2) {
        segments.push(straight_cubic_segment(&pair[0], pair[1].clone()));
    }
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: points[0].clone(),
        }],
    }
}

fn created_geometry_and_appearance(
    geometry: CreateSceneEntityGeometry,
) -> (SceneGeometryV1, SceneAppearanceV1, SceneCapabilityV1) {
    match geometry {
        CreateSceneEntityGeometry::Arrow => (
            SceneGeometryV1::CubicPath {
                path: studio_arrow_path(),
            },
            studio_arrow_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
        CreateSceneEntityGeometry::Circle { radius } => (
            SceneGeometryV1::Circle {
                center: PointV1 { x: 0.0, y: 0.0 },
                radius,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::Image {
            asset,
            local_rect,
            sampler,
        } => (
            SceneGeometryV1::Image {
                asset,
                local_rect,
                sampler,
            },
            SceneAppearanceV1::Image { opacity: 1.0 },
            SceneCapabilityV1::PngImage,
        ),
        CreateSceneEntityGeometry::Line => (
            SceneGeometryV1::Line {
                end: PointV1 { x: 1.0, y: 0.0 },
                start: PointV1 { x: -1.0, y: 0.0 },
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
        CreateSceneEntityGeometry::CubicOutline { path } => (
            SceneGeometryV1::CubicPath { path },
            studio_math_tex_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
    }
}

fn create_entity_property_keyframes_are_valid(entity: &CreateSceneEntity) -> bool {
    let opacity_is_valid = entity.opacity_keyframes.iter().all(|keyframe| {
        keyframe.at.is_finite()
            && keyframe.at >= entity.lifetime.start
            && keyframe.at <= entity.lifetime.end
            && keyframe.value.is_finite()
            && (0.0..=1.0).contains(&keyframe.value)
    }) && entity
        .opacity_keyframes
        .windows(2)
        .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON);
    let base_has_fill = matches!(
        created_geometry_and_appearance(entity.geometry.clone()).1,
        SceneAppearanceV1::Vector { fill: Some(_), .. }
    );
    let material_is_valid = entity.material_parameter_keyframes.iter().all(|keyframe| {
        keyframe.at.is_finite()
            && keyframe.at >= entity.lifetime.start
            && keyframe.at <= entity.lifetime.end
            && !keyframe.value.parameters.is_empty()
            && keyframe
                .value
                .parameters
                .iter()
                .all(|value| value.is_finite())
    }) && entity
        .material_parameter_keyframes
        .windows(2)
        .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON)
        && (entity.material_parameter_keyframes.is_empty() || base_has_fill);
    let scale_is_valid = entity.uniform_scale_keyframes.iter().all(|keyframe| {
        keyframe.at.is_finite()
            && keyframe.at >= entity.lifetime.start
            && keyframe.at <= entity.lifetime.end
            && keyframe.value.is_finite()
            && keyframe.value > 0.0
    }) && entity
        .uniform_scale_keyframes
        .windows(2)
        .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON)
        && entity
            .uniform_scale_keyframes
            .first()
            .is_none_or(|keyframe| close_transform_baseline_value(keyframe.value, entity.scale));
    let rotation_is_valid = entity.rotation_keyframes.iter().all(|keyframe| {
        keyframe.at.is_finite()
            && keyframe.at >= entity.lifetime.start
            && keyframe.at <= entity.lifetime.end
            && keyframe.value.is_finite()
    }) && entity
        .rotation_keyframes
        .windows(2)
        .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON)
        && entity
            .rotation_keyframes
            .first()
            .is_none_or(|keyframe| close_transform_baseline_value(keyframe.value, entity.rotation));
    let starts_after_fade = entity.fade_in.as_ref().is_none_or(|fade| {
        entity
            .opacity_keyframes
            .first()
            .is_none_or(|keyframe| keyframe.at > fade.end + TIMELINE_ANCHOR_EPSILON)
            && entity
                .material_parameter_keyframes
                .first()
                .is_none_or(|keyframe| keyframe.at > fade.end + TIMELINE_ANCHOR_EPSILON)
            && entity
                .uniform_scale_keyframes
                .first()
                .is_none_or(|keyframe| keyframe.at > fade.end + TIMELINE_ANCHOR_EPSILON)
            && entity
                .rotation_keyframes
                .first()
                .is_none_or(|keyframe| keyframe.at > fade.end + TIMELINE_ANCHOR_EPSILON)
    });
    opacity_is_valid
        && material_is_valid
        && rotation_is_valid
        && scale_is_valid
        && starts_after_fade
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
                || !step.rotation.is_finite()
                || !step.scale_x.is_finite()
                || step.scale_x <= 0.0
                || !step.scale_y.is_finite()
                || step.scale_y <= 0.0)
        {
            return Err(CreateSceneEntitiesError::InvalidInstantTransform);
        }
        let colors_are_valid = [&entity.fill_color, &entity.stroke_color]
            .into_iter()
            .flatten()
            .all(|color| {
                [color.red, color.green, color.blue, color.alpha]
                    .into_iter()
                    .all(|component| component.is_finite() && (0.0..=1.0).contains(&component))
                    && close_transform_baseline_value(color.alpha, entity.paint_opacity)
            });
        let has_color_override = entity.fill_color.is_some() || entity.stroke_color.is_some();
        let appearance_changed = !close_transform_baseline_value(entity.paint_opacity, 1.0)
            || !rotation_is_noop(entity.rotation)
            || has_color_override;
        let unsupported_image_paint =
            matches!(entity.geometry, CreateSceneEntityGeometry::Image { .. })
                && (!close_transform_baseline_value(entity.paint_opacity, 1.0)
                    || has_color_override);
        if !entity.paint_opacity.is_finite()
            || !(0.0..=1.0).contains(&entity.paint_opacity)
            || !entity.rotation.is_finite()
            || !colors_are_valid
            || unsupported_image_paint
            || (has_color_override
                && !matches!(
                    &entity.geometry,
                    CreateSceneEntityGeometry::Circle { .. }
                        | CreateSceneEntityGeometry::Rectangle { .. }
                ))
            || (!rotation_is_noop(entity.rotation) && entity.instant_transform.is_some())
            || (!entity.uniform_scale_keyframes.is_empty()
                && (!rotation_is_noop(entity.rotation) || entity.instant_transform.is_some()))
            || (!entity.rotation_keyframes.is_empty()
                && (!entity.uniform_scale_keyframes.is_empty()
                    || !rotation_is_noop(entity.rotation)
                    || entity.instant_transform.is_some()))
            || !create_entity_property_keyframes_are_valid(entity)
            || (!entity.material_parameter_keyframes.is_empty() && has_color_override)
            || (appearance_changed && entity.appearance_at.is_none())
            || entity.appearance_at.is_some_and(|at| {
                !at.is_finite()
                    || at < entity.lifetime.start
                    || at >= entity.lifetime.end
                    || entity.fade_in.as_ref().is_some_and(|fade| at < fade.end)
            })
        {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }
    }
    Ok(())
}

#[allow(
    clippy::too_many_lines,
    reason = "one append path keeps base entity and its three optional canonical channels together"
)]
fn append_created_entity(
    scene: &mut poietra_scene_ir::SceneIrV1,
    entity: CreateSceneEntity,
    provenance_id: &str,
    scene_order: u32,
    source_z_index: f64,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) -> Result<(), CreateSceneEntitiesError> {
    let (geometry, mut appearance, capability) = created_geometry_and_appearance(entity.geometry);
    let has_material_parameter_keyframes = !entity.material_parameter_keyframes.is_empty();
    if let Some(color) = &entity.fill_color {
        let SceneAppearanceV1::Vector { fill, .. } = &mut appearance else {
            unreachable!("Studio shape color admission requires vector appearance");
        };
        let mut transparent = color.clone();
        transparent.alpha = 0.0;
        *fill = Some(FillStyleV1 {
            color: transparent,
            fragment_material: None,
            rule: FillRuleV1::NonZero,
        });
    }
    if let Some(first) = entity.material_parameter_keyframes.first() {
        let SceneAppearanceV1::Vector {
            fill: Some(fill), ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        fill.fragment_material = Some(first.value.clone());
        set_vector_paint_alpha(&mut appearance, entity.paint_opacity)
            .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
    }
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
        appearance: appearance.clone(),
        geometry,
        id: created_id.clone(),
        lifetimes: vec![lifetime.clone()],
        parent_id: None,
        provenance_id: provenance_id.to_owned(),
        scene_order,
        source_z_index,
        transform: base_transform.clone(),
        visible: entity.visible,
    });
    let mut opacity_keyframes = Vec::new();
    if let Some(fade) = entity.fade_in {
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        opacity_keyframes.extend([
            KeyframeV1 {
                at: lifetime.start,
                easing_to_next: Some(EasingV1::Smooth {}),
                value: 0.0,
            },
            KeyframeV1 {
                at: fade.end,
                easing_to_next: (!entity.opacity_keyframes.is_empty())
                    .then_some(EasingV1::Linear {}),
                value: 1.0,
            },
        ]);
    }
    opacity_keyframes.extend(entity.opacity_keyframes);
    if !opacity_keyframes.is_empty() {
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        let channel_id_prefix = format!("studio-opacity-{scene_order}");
        let channel_id = unused_channel_id(scene, &channel_id_prefix);
        scene.animation_channels.push(AnimationChannelV1::Opacity {
            entity_id: created_id.clone(),
            id: channel_id,
            keyframes: opacity_keyframes,
            provenance_id: provenance_id.to_owned(),
        });
    }
    if has_material_parameter_keyframes {
        let SceneAppearanceV1::Vector { fill, stroke, .. } = appearance.clone() else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        let Some(fill) = fill else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        capabilities.insert(SceneCapabilityV1::FragmentMaterial);
        if entity
            .material_parameter_keyframes
            .iter()
            .any(|keyframe| keyframe.value.texture.is_some())
        {
            capabilities.insert(SceneCapabilityV1::PngImage);
        }
        if entity.material_parameter_keyframes.len() >= 2 {
            let keyframes = entity
                .material_parameter_keyframes
                .into_iter()
                .map(|keyframe| {
                    let mut fill = fill.clone();
                    fill.fragment_material = Some(keyframe.value);
                    KeyframeV1 {
                        at: keyframe.at,
                        easing_to_next: keyframe.easing_to_next,
                        value: VectorAppearanceValueV1 {
                            fill: Some(fill),
                            stroke: stroke.clone(),
                        },
                    }
                })
                .collect();
            capabilities.insert(SceneCapabilityV1::VectorAppearanceAnimation);
            let channel_id =
                unused_channel_id(scene, &format!("studio-material-parameter-{scene_order}"));
            scene
                .animation_channels
                .push(AnimationChannelV1::VectorAppearance {
                    entity_id: created_id.clone(),
                    id: channel_id,
                    keyframes,
                    provenance_id: provenance_id.to_owned(),
                });
        }
    }
    if entity.uniform_scale_keyframes.len() >= 2 {
        let keyframes = entity
            .uniform_scale_keyframes
            .iter()
            .map(|keyframe| KeyframeV1 {
                at: keyframe.at,
                easing_to_next: keyframe.easing_to_next.clone(),
                value: AffineTransformV1 {
                    m11: keyframe.value,
                    m12: 0.0,
                    m21: 0.0,
                    m22: keyframe.value,
                    tx: entity.position.x,
                    ty: entity.position.y,
                },
            })
            .collect();
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-scale-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: created_id.clone(),
                id: channel_id,
                keyframes,
                provenance_id: provenance_id.to_owned(),
            });
    }
    if entity.rotation_keyframes.len() >= 2 {
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-rotation-track-{scene_order}"));
        scene.animation_channels.push(AnimationChannelV1::Rotation {
            entity_id: created_id.clone(),
            id: channel_id,
            keyframes: entity.rotation_keyframes.clone(),
            pivot: entity.position.clone(),
            provenance_id: provenance_id.to_owned(),
        });
    }
    if let Some(at) = entity.appearance_at {
        if !has_material_parameter_keyframes
            && (!close_transform_baseline_value(entity.paint_opacity, 1.0)
                || entity.fill_color.is_some()
                || entity.stroke_color.is_some())
        {
            let mut changed_appearance = appearance.clone();
            let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut changed_appearance else {
                unreachable!("supported Studio creation geometry always uses vector appearance");
            };
            if let Some(color) = &entity.fill_color {
                *fill = Some(FillStyleV1 {
                    color: color.clone(),
                    fragment_material: None,
                    rule: FillRuleV1::NonZero,
                });
            }
            if let Some(color) = &entity.stroke_color {
                let stroke = stroke
                    .as_mut()
                    .expect("Studio shape color admission requires an existing stroke");
                stroke.color = color.clone();
            }
            set_vector_paint_alpha(&mut changed_appearance, entity.paint_opacity)
                .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
            let SceneAppearanceV1::Vector { fill, stroke, .. } = changed_appearance else {
                unreachable!("supported Studio creation geometry always uses vector appearance");
            };
            let value = VectorAppearanceValueV1 { fill, stroke };
            capabilities.insert(SceneCapabilityV1::VectorAppearanceAnimation);
            let channel_id = unused_channel_id(scene, &format!("studio-appearance-{scene_order}"));
            scene
                .animation_channels
                .push(AnimationChannelV1::VectorAppearance {
                    entity_id: created_id.clone(),
                    id: channel_id,
                    keyframes: vec![
                        KeyframeV1 {
                            at,
                            easing_to_next: Some(EasingV1::Linear {}),
                            value: value.clone(),
                        },
                        KeyframeV1 {
                            at: lifetime.end,
                            easing_to_next: None,
                            value,
                        },
                    ],
                    provenance_id: provenance_id.to_owned(),
                });
        }
        if !rotation_is_noop(entity.rotation) {
            let mut rotated = base_transform.clone();
            apply_world_rotation(&mut rotated, entity.rotation, &entity.position);
            capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
            let channel_id = unused_channel_id(scene, &format!("studio-rotation-{scene_order}"));
            scene
                .animation_channels
                .push(AnimationChannelV1::AffineTransform {
                    entity_id: created_id.clone(),
                    id: channel_id,
                    keyframes: vec![
                        KeyframeV1 {
                            at,
                            easing_to_next: Some(EasingV1::Linear {}),
                            value: rotated.clone(),
                        },
                        KeyframeV1 {
                            at: lifetime.end,
                            easing_to_next: None,
                            value: rotated,
                        },
                    ],
                    provenance_id: provenance_id.to_owned(),
                });
        }
    }
    if let Some(step) = entity.instant_transform {
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let mut value = AffineTransformV1 {
            m11: step.scale_x,
            m12: 0.0,
            m21: 0.0,
            m22: step.scale_y,
            tx: step.position.x,
            ty: step.position.y,
        };
        if !rotation_is_noop(step.rotation) {
            apply_world_rotation(&mut value, step.rotation, &step.position);
        }
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
    Ok(())
}

fn validate_studio_logical_group(
    scene: &poietra_scene_ir::SceneIrV1,
    group: &PlannedStudioLogicalGroup,
    created_entity_ids: &BTreeSet<String>,
    root_paint_order: &[String],
    rotation_targets: &BTreeSet<String>,
) -> Result<(BTreeSet<String>, f64, Vec<IntervalV1>), CreateSceneEntitiesError> {
    let child_ids = group
        .child_entity_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if child_ids.len() != group.child_entity_ids.len() || group.child_entity_ids.len() < 2 {
        return Err(CreateSceneEntitiesError::InvalidHierarchy);
    }
    let mut paint_indexes = Vec::with_capacity(group.child_entity_ids.len());
    let mut lifetimes = Vec::new();
    for child_id in &group.child_entity_ids {
        if !created_entity_ids.contains(child_id) || rotation_targets.contains(child_id) {
            return Err(CreateSceneEntitiesError::InvalidHierarchy);
        }
        let child = scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
        // Visibility is a document property, not hierarchy membership. The
        // planner already proves that each child was visible when Group was
        // authored; a later Hide must not invalidate the retained group.
        if child.parent_id.is_some() || matches!(child.geometry, SceneGeometryV1::Group {}) {
            return Err(CreateSceneEntitiesError::InvalidHierarchy);
        }
        paint_indexes.push(
            root_paint_order
                .iter()
                .position(|id| id == child_id)
                .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?,
        );
        lifetimes.extend(child.lifetimes.iter().cloned());
    }
    paint_indexes.sort_unstable();
    if paint_indexes
        .windows(2)
        .any(|pair| pair[1] != pair[0].saturating_add(1))
    {
        return Err(CreateSceneEntitiesError::InvalidHierarchy);
    }
    lifetimes.sort_by(|left, right| left.start.total_cmp(&right.start));
    let mut union = Vec::<IntervalV1>::new();
    for lifetime in lifetimes {
        if let Some(last) = union.last_mut()
            && lifetime.start <= last.end + TIMELINE_ANCHOR_EPSILON
        {
            last.end = last.end.max(lifetime.end);
        } else {
            union.push(lifetime);
        }
    }
    if union != group.lifetimes {
        return Err(CreateSceneEntitiesError::InvalidHierarchy);
    }
    let source_z_index = scene
        .entities
        .iter()
        .find(|entity| entity.id == group.child_entity_ids[0])
        .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?
        .source_z_index;
    Ok((child_ids, source_z_index, union))
}

fn append_studio_logical_groups(
    scene: &mut poietra_scene_ir::SceneIrV1,
    groups: &[PlannedStudioLogicalGroup],
    created_entity_ids: &BTreeSet<String>,
    provenance_id: &str,
) -> Result<(), CreateSceneEntitiesError> {
    let mut roots = scene
        .entities
        .iter()
        .filter(|entity| {
            entity.parent_id.is_none() && !matches!(entity.geometry, SceneGeometryV1::Group {})
        })
        .map(|entity| (entity.id.clone(), entity.source_z_index, entity.scene_order))
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| left.1.total_cmp(&right.1).then(left.2.cmp(&right.2)));
    let root_paint_order = roots.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>();
    let rotation_targets = scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::Rotation { entity_id, .. } => Some(entity_id.clone()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    for group in groups {
        if scene
            .entities
            .iter()
            .any(|entity| entity.id == group.group_id)
        {
            return Err(CreateSceneEntitiesError::InvalidHierarchy);
        }
        let (child_ids, source_z_index, union) = validate_studio_logical_group(
            scene,
            group,
            created_entity_ids,
            &root_paint_order,
            &rotation_targets,
        )?;
        let scene_order = scene
            .entities
            .iter()
            .map(|entity| entity.scene_order)
            .max()
            .and_then(|maximum| maximum.checked_add(1))
            .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
        for entity in &mut scene.entities {
            if child_ids.contains(&entity.id) {
                entity.parent_id = Some(group.group_id.clone());
            }
        }
        scene.entities.push(SceneEntityV1 {
            appearance: SceneAppearanceV1::Group { opacity: 1.0 },
            geometry: SceneGeometryV1::Group {},
            id: group.group_id.clone(),
            lifetimes: union,
            parent_id: None,
            provenance_id: provenance_id.to_owned(),
            scene_order,
            source_z_index,
            transform: AffineTransformV1::identity(),
            visible: true,
        });
    }
    if !groups.is_empty()
        && !scene
            .required_capabilities
            .contains(&SceneCapabilityV1::LogicalGroup)
    {
        scene
            .required_capabilities
            .push(SceneCapabilityV1::LogicalGroup);
        scene.required_capabilities.sort();
    }
    Ok(())
}

impl EngineSessionV1 {
    /// Authorizes normalized Studio duration edits and applies them atomically.
    fn create_scene_entities(
        &mut self,
        command: CreateSceneEntitiesCommand,
    ) -> Result<StudioAuthoringEditResult, CreateSceneEntitiesError> {
        validate_create_scene_entities_command(self, &command)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let creates_browser_outline = command.entities.iter().any(|entity| {
            matches!(
                &entity.geometry,
                CreateSceneEntityGeometry::CubicOutline { .. }
            )
        });
        for insertion in &command.timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        if creates_browser_outline && matches!(candidate.scene.fidelity, FidelityV1::Exact {}) {
            candidate.scene.fidelity = FidelityV1::Approximate {
                evidence: vec![
                    "Studio Text and MathTex use browser-compiled outlines without exact Manim parity evidence."
                        .to_owned(),
                ],
            };
        }
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
        let created_entity_ids = command
            .entities
            .iter()
            .map(|entity| entity.id.clone())
            .collect::<BTreeSet<_>>();

        for (scene_order, entity) in (first_scene_order..).zip(command.entities) {
            let entity_source_z_index = entity.source_z_index.unwrap_or(source_z_index);
            append_created_entity(
                &mut candidate.scene,
                entity,
                &command.provenance.id,
                scene_order,
                entity_source_z_index,
                &mut capabilities,
            )?;
            source_z_index += 1.0;
        }
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(command.provenance.clone());
        append_planned_scene_motions(
            &mut candidate.scene,
            &command.motions,
            &command.provenance.id,
        )?;
        let persistent_remove_projection = if command.persistent_removals.is_empty() {
            StudioPersistentRemoveProjection::default()
        } else {
            apply_persistent_scene_removals(
                &mut candidate.scene,
                &command.persistent_removals,
                &command.provenance.id,
            )?
        };
        append_studio_logical_groups(
            &mut candidate.scene,
            &command.groups,
            &created_entity_ids,
            &command.provenance.id,
        )?;
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = StudioAuthoringEditResult {
            bundle: candidate.clone(),
            creation_projection: None,
            math_tex_transform_projection: None,
            motion_projection: None,
            persistent_remove_projection,
            static_root_projection: None,
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Authorizes complete normalized Studio creation edits and applies one atomic batch.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized edits do not describe the supported
    /// create/position/fade, motion, instant transform, and persistent-remove subset. Every failure
    /// preserves the installed session.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the bounded adapter materializes one already-admitted creation plan into Scene coordinates"
    )]
    pub fn apply_studio_creation_edit(
        &mut self,
        command: ApplyStudioCreationEditCommand,
    ) -> Result<StudioAuthoringEditResult, ApplyStudioCreationEditError> {
        let ApplyStudioCreationEditCommand {
            expected_base_revision,
            frame,
            math_tex_outlines,
            next_revision,
            programs,
            text_outlines,
            viewport,
        } = command;
        if self.scene().source.revision_hash() != expected_base_revision {
            return Err(CreateSceneEntitiesError::StaleBaseRevision.into());
        }
        if next_revision == expected_base_revision {
            return Err(CreateSceneEntitiesError::RevisionDidNotAdvance.into());
        }
        if !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != self.scene().camera.view.frame_width
            || frame.height != self.scene().camera.view.frame_height
        {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }
        let base_scene_source_z_indexes = self
            .scene()
            .entities
            .iter()
            .map(|entity| entity.source_z_index)
            .collect::<Vec<_>>();
        let base_scene_paint_order = self
            .scene()
            .entities
            .iter()
            .filter(|entity| !matches!(entity.geometry, SceneGeometryV1::Group {}))
            .map(|entity| (entity.source_z_index, entity.scene_order))
            .collect::<Vec<_>>();
        let base_source_z_index_start = base_scene_source_z_indexes
            .iter()
            .copied()
            .fold(-1.0_f64, f64::max)
            + 1.0;
        let plan = plan_studio_creation_edits(
            self.scene().duration,
            &programs,
            Some(base_source_z_index_start),
            Some(&base_scene_paint_order),
        )
        .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
        for state in &plan.entities {
            let matching_outline_count = match state.kind {
                StudioAuthoringEntityKind::MathTex => math_tex_outlines
                    .iter()
                    .filter(|outline| {
                        outline.entity_id == state.spec.id
                            && Some(&outline.tex_parts) == state.spec.tex_parts.as_ref()
                    })
                    .count(),
                StudioAuthoringEntityKind::Text => text_outlines
                    .iter()
                    .filter(|outline| {
                        outline.entity_id == state.spec.id
                            && state.current_text_content.as_ref().is_some_and(|content| {
                                outline.text == content.text && outline.layout == content.layout
                            })
                    })
                    .count(),
                StudioAuthoringEntityKind::Arrow
                | StudioAuthoringEntityKind::Circle
                | StudioAuthoringEntityKind::Image
                | StudioAuthoringEntityKind::Line
                | StudioAuthoringEntityKind::Other
                | StudioAuthoringEntityKind::Rectangle => continue,
            };
            if matching_outline_count != 1 {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
        }

        let mut entities = Vec::with_capacity(plan.entities.len());
        let mut persistent_removals = Vec::new();
        for state in &plan.entities {
            let geometry = match state.kind {
                StudioAuthoringEntityKind::Arrow => CreateSceneEntityGeometry::Arrow,
                StudioAuthoringEntityKind::Circle => {
                    let size = studio_authoring_shape_size(state.kind, state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::Circle {
                        radius: size.width / 2.0,
                    }
                }
                StudioAuthoringEntityKind::Image => {
                    let image = state
                        .spec
                        .image
                        .as_ref()
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let asset_exists = self.assets().assets.iter().any(|asset| {
                        asset.id == image.asset.asset_id && asset.sha256 == image.asset.sha256
                    });
                    if !asset_exists {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                    CreateSceneEntityGeometry::Image {
                        asset: image.asset.clone(),
                        local_rect: image.local_rect.clone(),
                        sampler: image.sampler,
                    }
                }
                StudioAuthoringEntityKind::Line => CreateSceneEntityGeometry::Line,
                StudioAuthoringEntityKind::Rectangle => {
                    let size = studio_authoring_shape_size(state.kind, state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::Rectangle {
                        height: size.height,
                        width: size.width,
                    }
                }
                StudioAuthoringEntityKind::MathTex => {
                    let outline = math_tex_outlines
                        .iter()
                        .find(|outline| {
                            outline.entity_id == state.spec.id
                                && Some(&outline.tex_parts) == state.spec.tex_parts.as_ref()
                        })
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::CubicOutline {
                        path: outline.path.clone(),
                    }
                }
                StudioAuthoringEntityKind::Text => {
                    let outline = text_outlines
                        .iter()
                        .find(|outline| {
                            outline.entity_id == state.spec.id
                                && state.current_text_content.as_ref().is_some_and(|content| {
                                    outline.text == content.text && outline.layout == content.layout
                                })
                        })
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let font_size = state
                        .current_text_content
                        .as_ref()
                        .map(|content| content.layout.font_size)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::CubicOutline {
                        path: scale_cubic_path(&outline.path, font_size),
                    }
                }
                StudioAuthoringEntityKind::Other => {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
            };
            let instant_transform = if let Some(at) = state.instant_at {
                let (x_ratio, y_ratio) = match state.kind {
                    StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle => {
                        let initial =
                            studio_authoring_shape_size(state.kind, state.initial_dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        let current =
                            studio_authoring_shape_size(state.kind, state.current_dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        (
                            current.width / initial.width,
                            current.height / initial.height,
                        )
                    }
                    StudioAuthoringEntityKind::Arrow
                    | StudioAuthoringEntityKind::Image
                    | StudioAuthoringEntityKind::Line
                    | StudioAuthoringEntityKind::MathTex
                    | StudioAuthoringEntityKind::Text => (1.0, 1.0),
                    StudioAuthoringEntityKind::Other => {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                };
                Some(CreateSceneEntityInstantTransform {
                    at,
                    position: studio_point_to_scene_point(
                        &state.position,
                        frame,
                        viewport,
                        &self.scene().camera.view.center,
                    ),
                    rotation: state.instant_rotation,
                    scale_x: state.scale * x_ratio,
                    scale_y: state.scale * y_ratio,
                })
            } else {
                None
            };
            if let Some(removal) = &state.persistent_removal {
                persistent_removals.push(removal.clone());
            }
            let color_with_opacity = |value: &str| {
                let mut color = canonical_studio_hex_color(value)
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                color.alpha = state.current_opacity;
                Ok::<_, ApplyStudioCreationEditError>(color)
            };
            let fill_color = state
                .fill_color_override
                .as_deref()
                .map(color_with_opacity)
                .transpose()?;
            let stroke_color = state
                .stroke_color_override
                .as_deref()
                .map(color_with_opacity)
                .transpose()?;
            entities.push(CreateSceneEntity {
                appearance_at: state.appearance_at,
                fade_in: state
                    .fade_interval
                    .as_ref()
                    .map(|interval| CreateSceneEntityFadeIn { end: interval.end }),
                fill_color,
                geometry,
                id: state.spec.id.clone(),
                instant_transform,
                lifetime: state.lifetime.clone(),
                material_parameter_keyframes: state.material_parameter_keyframes.clone(),
                opacity_keyframes: state.opacity_keyframes.clone(),
                paint_opacity: state.current_opacity,
                position: studio_point_to_scene_point(
                    &state.initial_position,
                    frame,
                    viewport,
                    &self.scene().camera.view.center,
                ),
                rotation: state.current_rotation,
                rotation_keyframes: state.rotation_keyframes.clone(),
                scale: 1.0,
                uniform_scale_keyframes: state.uniform_scale_keyframes.clone(),
                source_z_index: state.source_z_index,
                stroke_color,
                visible: state.visible,
            });
        }
        let motions = plan
            .motion_projection
            .motions
            .iter()
            .map(|motion| PlannedSceneMotion {
                control_offset: studio_vector_to_scene_vector(
                    &motion.control_offset,
                    frame,
                    viewport,
                ),
                delta: studio_vector_to_scene_vector(&motion.delta, frame, viewport),
                easing: authored_motion_easing(motion.easing),
                interval: motion.interval.clone(),
                target_entity_ids: vec![motion.target_entity_id.clone()],
            })
            .collect();
        let operation_count = programs
            .iter()
            .map(|program| program.operations.len())
            .sum::<usize>();
        let creation_projection = plan.projection();
        let mut result = self.create_scene_entities(CreateSceneEntitiesCommand {
            entities,
            expected_base_revision,
            groups: plan.groups,
            motions,
            next_revision: next_revision.clone(),
            persistent_removals,
            provenance: ProvenanceRecordV1 {
                evidence: vec![format!(
                    "{} validated Studio Program(s) with {operation_count} operation(s) lowered as one atomic creation/motion/transform/appearance/persistent-remove core command",
                    programs.len()
                )],
                id: format!("studio-create:{next_revision}"),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            timeline_insertions: plan.timeline_insertions,
        })?;
        result.creation_projection = Some(creation_projection);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::{FRAC_PI_2, PI};

    use super::super::tests::{
        NEXT_REVISION, fixture_bundle, imported_bundle, static_imported_bundle,
    };
    use super::super::{
        StudioTextAlignment, StudioTextFontFamily, StudioTextFontWeight, StudioTextLayout,
    };
    use super::*;

    #[test]
    fn property_easing_input_names_expand_to_canonical_scene_easing() {
        let cases = [
            ("linear", EasingV1::Linear {}),
            ("smooth", EasingV1::ManimSmooth {}),
            (
                "ease-in",
                EasingV1::CubicBezier {
                    x1: 0.42,
                    x2: 1.0,
                    y1: 0.0,
                    y2: 1.0,
                },
            ),
            (
                "ease-out",
                EasingV1::CubicBezier {
                    x1: 0.0,
                    x2: 0.58,
                    y1: 0.0,
                    y2: 1.0,
                },
            ),
            (
                "ease-in-out",
                EasingV1::CubicBezier {
                    x1: 0.42,
                    x2: 0.58,
                    y1: 0.0,
                    y2: 1.0,
                },
            ),
        ];

        for (name, expected) in cases {
            let easing: StudioPropertyEasing =
                serde_json::from_str(&format!("\"{name}\"")).unwrap();
            assert_eq!(property_easing(easing), expected);
        }
    }

    fn studio_persistent_remove_edit_input(
        entity_id: &str,
        start: f64,
        end: f64,
    ) -> StudioCreationEditInput {
        StudioCreationEditInput {
            anchor_captured_playhead: start,
            anchor_resolved_seconds: start,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(start),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some(entity_id.to_owned()),
                id: "remove-created".to_owned(),
                interval: IntervalV1 { end, start },
                kind: StudioCreationOperationKind::PersistentRemove { persistent: true },
                origin: StudioAuthoringOrigin::DirectManipulation,
            }],
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: vec!["remove-created".to_owned()],
            transaction_id: "remove-created".to_owned(),
        }
    }

    fn studio_group_lifetime_trim_edit_input(
        entity_ids: &[String],
        at: f64,
    ) -> StudioCreationEditInput {
        let operations = entity_ids
            .iter()
            .enumerate()
            .map(|(index, entity_id)| StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some(entity_id.clone()),
                id: format!("trim-group-lifetime-{index}"),
                interval: IntervalV1 { end: at, start: at },
                kind: StudioCreationOperationKind::PersistentRemove { persistent: true },
                origin: StudioAuthoringOrigin::DirectManipulation,
            })
            .collect::<Vec<_>>();
        StudioCreationEditInput {
            anchor_captured_playhead: at,
            anchor_resolved_seconds: at,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(at),
            },
            intent_count: 1,
            lowering_supported: true,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: operations
                .iter()
                .map(|operation| operation.id.clone())
                .collect(),
            operations,
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            transaction_id: "trim-group-lifetime".to_owned(),
        }
    }

    fn mathtex_fixture_path() -> CubicPathV1 {
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle("mathtex-nested-radical-fraction.json")
                .scene
                .entities
                .remove(0)
                .geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        path
    }

    #[allow(
        clippy::too_many_lines,
        reason = "keeps the complete creation fixture explicit"
    )]
    fn create_command(bundle: &SceneIrBundleV1) -> CreateSceneEntitiesCommand {
        CreateSceneEntitiesCommand {
            entities: vec![
                CreateSceneEntity {
                    appearance_at: None,
                    fade_in: None,
                    fill_color: None,
                    geometry: CreateSceneEntityGeometry::Circle { radius: 0.75 },
                    id: "tx:create/entity:circle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    material_parameter_keyframes: vec![],
                    paint_opacity: 1.0,
                    opacity_keyframes: vec![],
                    position: PointV1 { x: 2.0, y: -1.0 },
                    rotation: 0.0,
                    rotation_keyframes: vec![],
                    scale: 1.25,
                    uniform_scale_keyframes: vec![],
                    source_z_index: None,
                    stroke_color: None,
                    instant_transform: None,
                    visible: true,
                },
                CreateSceneEntity {
                    appearance_at: None,
                    fade_in: Some(CreateSceneEntityFadeIn { end: 0.9 }),
                    fill_color: None,
                    geometry: CreateSceneEntityGeometry::Rectangle {
                        height: 2.0,
                        width: 3.0,
                    },
                    id: "tx:create/entity:rectangle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    material_parameter_keyframes: vec![],
                    paint_opacity: 1.0,
                    opacity_keyframes: vec![],
                    position: PointV1 { x: -2.0, y: 1.0 },
                    rotation: 0.0,
                    rotation_keyframes: vec![],
                    scale: 0.5,
                    uniform_scale_keyframes: vec![],
                    source_z_index: None,
                    stroke_color: None,
                    instant_transform: Some(CreateSceneEntityInstantTransform {
                        at: 1.25,
                        position: PointV1 { x: -1.0, y: 0.5 },
                        rotation: 0.0,
                        scale_x: 0.75,
                        scale_y: 1.0,
                    }),
                    visible: true,
                },
                CreateSceneEntity {
                    appearance_at: None,
                    fade_in: None,
                    fill_color: None,
                    geometry: CreateSceneEntityGeometry::CubicOutline {
                        path: mathtex_fixture_path(),
                    },
                    id: "tx:create/entity:mathtex".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    material_parameter_keyframes: vec![],
                    paint_opacity: 1.0,
                    opacity_keyframes: vec![],
                    position: PointV1 { x: 0.0, y: 1.5 },
                    rotation: 0.0,
                    rotation_keyframes: vec![],
                    scale: 2.0,
                    uniform_scale_keyframes: vec![],
                    source_z_index: None,
                    stroke_color: None,
                    instant_transform: None,
                    visible: true,
                },
            ],
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            groups: vec![],
            motions: vec![],
            next_revision: NEXT_REVISION.to_owned(),
            persistent_removals: vec![],
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio creation batch".to_owned()],
                id: "studio-create".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            timeline_insertions: vec![
                SceneTimelineInsertion {
                    at: 0.5,
                    duration: 0.25,
                },
                SceneTimelineInsertion {
                    at: 0.75,
                    duration: 0.25,
                },
            ],
        }
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one explicit normalized command fixture keeps the accepted wire subset visible"
    )]
    fn studio_creation_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
        let entity_id = "tx:create/entity:circle";
        let create_interval = IntervalV1 {
            end: 0.5,
            start: 0.5,
        };
        let resize_interval = IntervalV1 {
            end: 0.85,
            start: 0.85,
        };
        ApplyStudioCreationEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: bundle.scene.camera.view.frame_height,
                width: bundle.scene.camera.view.frame_width,
            },
            math_tex_outlines: vec![],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                StudioCreationEditInput {
                    anchor_captured_playhead: 0.5,
                    anchor_resolved_seconds: 0.5,
                    anchor_source: SceneEditAnchorSource::Playhead {
                        reference_seconds: Some(0.5),
                    },
                    intent_count: 1,
                    lowering_supported: true,
                    operations: vec![
                        StudioCreationOperation {
                            depends_on: vec![],
                            entity_id: None,
                            id: "create".to_owned(),
                            interval: create_interval.clone(),
                            kind: StudioCreationOperationKind::Create {
                                entity: StudioCreationEntitySpec {
                                    dimensions: StudioAuthoringDimensions {
                                        height: None,
                                        radius: Some(1.0),
                                        width: None,
                                    },
                                    id: entity_id.to_owned(),
                                    image: None,
                                    kind: StudioAuthoringEntityKind::Circle,
                                    layout: None,
                                    lifetime_end: None,
                                    lifetime_start: 0.5,
                                    text: None,
                                    tex_parts: None,
                                },
                            },
                            origin: StudioAuthoringOrigin::StudioDefault,
                        },
                        StudioCreationOperation {
                            depends_on: vec!["create".to_owned()],
                            entity_id: Some(entity_id.to_owned()),
                            id: "position".to_owned(),
                            interval: create_interval,
                            kind: StudioCreationOperationKind::Position {
                                position: Some(PointV1 { x: 320.0, y: 180.0 }),
                            },
                            origin: StudioAuthoringOrigin::StudioDefault,
                        },
                        StudioCreationOperation {
                            depends_on: vec!["position".to_owned()],
                            entity_id: Some(entity_id.to_owned()),
                            id: "fade".to_owned(),
                            interval: IntervalV1 {
                                end: 0.9,
                                start: 0.5,
                            },
                            kind: StudioCreationOperationKind::FadeIn { persistent: true },
                            origin: StudioAuthoringOrigin::StudioDefault,
                        },
                    ],
                    origin: StudioAuthoringOrigin::StudioDefault,
                    requested_execution: SceneEditExecution::Parallel,
                    schedule_edge_count: 4,
                    schedule_mode: SceneEditScheduleMode::DependencyDag,
                    schedule_order: vec![
                        "create".to_owned(),
                        "position".to_owned(),
                        "fade".to_owned(),
                    ],
                    transaction_id: "create".to_owned(),
                },
                StudioCreationEditInput {
                    anchor_captured_playhead: 0.85,
                    anchor_resolved_seconds: 0.85,
                    anchor_source: SceneEditAnchorSource::Playhead {
                        reference_seconds: Some(0.85),
                    },
                    intent_count: 1,
                    lowering_supported: true,
                    operations: vec![StudioCreationOperation {
                        depends_on: vec![],
                        entity_id: Some(entity_id.to_owned()),
                        id: "resize".to_owned(),
                        interval: resize_interval,
                        kind: StudioCreationOperationKind::Resize {
                            from_dimensions: StudioAuthoringDimensions {
                                height: None,
                                radius: Some(1.0),
                                width: None,
                            },
                            from_position: PointV1 { x: 320.0, y: 180.0 },
                            from_scale: 1.0,
                            shape: StudioAuthoringEntityKind::Circle,
                            to_dimensions: StudioAuthoringDimensions {
                                height: None,
                                radius: Some(2.0),
                                width: None,
                            },
                            to_position: PointV1 { x: 360.0, y: 180.0 },
                        },
                        origin: StudioAuthoringOrigin::DirectManipulation,
                    }],
                    origin: StudioAuthoringOrigin::DirectManipulation,
                    requested_execution: SceneEditExecution::Sequence,
                    schedule_edge_count: 0,
                    schedule_mode: SceneEditScheduleMode::Sequence,
                    schedule_order: vec!["resize".to_owned()],
                    transaction_id: "resize".to_owned(),
                },
            ],
            text_outlines: vec![],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn studio_text_creation_command(
        bundle: &SceneIrBundleV1,
        text: &str,
    ) -> ApplyStudioCreationEditCommand {
        let mut command = studio_creation_command(bundle);
        let entity_id = {
            let StudioCreationOperationKind::Create { entity } =
                &mut command.programs[0].operations[0].kind
            else {
                unreachable!();
            };
            entity.kind = StudioAuthoringEntityKind::Text;
            entity.dimensions = StudioAuthoringDimensions::default();
            entity.layout = None;
            entity.text = Some(text.to_owned());
            entity.tex_parts = None;
            entity.id.clone()
        };
        command.text_outlines = vec![StudioCreationTextOutline {
            entity_id,
            layout: StudioTextLayout::default(),
            path: mathtex_fixture_path(),
            text: text.to_owned(),
        }];
        command
    }

    fn studio_image_creation_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
        let asset = bundle
            .assets
            .assets
            .first()
            .expect("the PNG creation fixture must expose one manifest asset");
        let mut command = studio_creation_command(bundle);
        command.programs.truncate(1);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.dimensions = StudioAuthoringDimensions::default();
        entity.image = Some(StudioCreationImageSpec {
            asset: AssetReferenceV1 {
                asset_id: asset.id.clone(),
                sha256: asset.sha256.clone(),
            },
            local_rect: ImageLocalRectV1 {
                bottom: -1.0,
                left: -1.5,
                right: 1.5,
                top: 1.0,
            },
            sampler: ImageSamplerV1::Linear,
        });
        entity.kind = StudioAuthoringEntityKind::Image;
        command
    }

    fn studio_created_motion_edit_input(target_entity_ids: Vec<String>) -> StudioCreationEditInput {
        StudioCreationEditInput {
            anchor_captured_playhead: 1.0,
            anchor_resolved_seconds: 1.0,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(1.0),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StudioCreationOperation {
                depends_on: vec![],
                entity_id: None,
                id: "move-created".to_owned(),
                interval: IntervalV1 {
                    end: 2.0,
                    start: 1.0,
                },
                kind: StudioCreationOperationKind::CreateMotion {
                    control_offset: PointV1 { x: 0.0, y: -160.0 },
                    delta: PointV1 { x: 240.0, y: -80.0 },
                    easing: StudioMotionEasing::Smooth,
                    target_entity_ids,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            }],
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: vec!["move-created".to_owned()],
            transaction_id: "move-created".to_owned(),
        }
    }

    fn add_creation_opacity_segment(
        program: &mut StudioCreationEditInput,
        entity_id: &str,
        start: f64,
        end: f64,
    ) {
        for operation in &mut program.operations {
            operation.origin = StudioAuthoringOrigin::DirectManipulation;
        }
        program.origin = StudioAuthoringOrigin::DirectManipulation;
        program.requested_execution = SceneEditExecution::Sequence;
        program.schedule_mode = SceneEditScheduleMode::Sequence;
        program.operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: "opacity-segment".to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::OpacityKeyframes {
                easing: StudioPropertyEasing::Linear,
                from: Some(1.0),
                to: Some(0.0),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
        program.schedule_order.push("opacity-segment".to_owned());
        program.schedule_edge_count = 6;
    }

    fn add_creation_material_parameter_segment(
        program: &mut StudioCreationEditInput,
        entity_id: &str,
        start: f64,
        end: f64,
    ) {
        for operation in &mut program.operations {
            operation.origin = StudioAuthoringOrigin::DirectManipulation;
        }
        program.origin = StudioAuthoringOrigin::DirectManipulation;
        program.requested_execution = SceneEditExecution::Sequence;
        program.schedule_mode = SceneEditScheduleMode::Sequence;
        program.operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: "material-segment".to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::MaterialParameterKeyframes {
                easing: StudioPropertyEasing::Smooth,
                from: Some(0.35),
                material: FragmentMaterialV1 {
                    parameters: vec![0.35, 8.0],
                    revision: 1,
                    shader_id: "project-wave".to_owned(),
                    texture: None,
                },
                name: "amplitude".to_owned(),
                parameter_index: 0,
                to: Some(0.85),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
        program.schedule_order.push("material-segment".to_owned());
        program.schedule_edge_count = 2 * (program.operations.len() - 1);
    }

    fn add_creation_uniform_scale_segment(
        program: &mut StudioCreationEditInput,
        entity_id: &str,
        start: f64,
        end: f64,
        to: f64,
    ) {
        for operation in &mut program.operations {
            operation.origin = StudioAuthoringOrigin::DirectManipulation;
        }
        program.origin = StudioAuthoringOrigin::DirectManipulation;
        program.requested_execution = SceneEditExecution::Sequence;
        program.schedule_mode = SceneEditScheduleMode::Sequence;
        program.operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: "scale-segment".to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::UniformScaleKeyframes {
                easing: StudioPropertyEasing::EaseInOut,
                from: Some(1.0),
                to: Some(to),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
        program.schedule_order.push("scale-segment".to_owned());
        program.schedule_edge_count = 2 * (program.operations.len() - 1);
    }

    fn add_creation_rotation_segment(
        program: &mut StudioCreationEditInput,
        entity_id: &str,
        start: f64,
        end: f64,
        to: f64,
    ) {
        for operation in &mut program.operations {
            operation.origin = StudioAuthoringOrigin::DirectManipulation;
        }
        program.origin = StudioAuthoringOrigin::DirectManipulation;
        program.requested_execution = SceneEditExecution::Sequence;
        program.schedule_mode = SceneEditScheduleMode::Sequence;
        program.operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: "rotation-segment".to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::RotationKeyframes {
                easing: StudioPropertyEasing::Linear,
                from: Some(0.0),
                to: Some(to),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
        program.schedule_order.push("rotation-segment".to_owned());
        program.schedule_edge_count = 2 * (program.operations.len() - 1);
    }

    fn sampled_material_parameter(
        session: &EngineSessionV1,
        entity_id: &str,
        sample_time: f64,
    ) -> f64 {
        let packet_id = format!("material-parameter-{sample_time}");
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: &packet_id,
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        packet
            .draws
            .iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id: candidate,
                    fill: Some(fill),
                    ..
                } if candidate == entity_id => fill.fragment_material.as_ref(),
                _ => None,
            })
            .unwrap()
            .parameters[0]
    }

    fn studio_created_appearance_edit_input(
        anchor: f64,
        entity_id: &str,
        operation_id: &str,
        kind: StudioCreationOperationKind,
    ) -> StudioCreationEditInput {
        StudioCreationEditInput {
            anchor_captured_playhead: anchor,
            anchor_resolved_seconds: anchor,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(anchor),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some(entity_id.to_owned()),
                id: operation_id.to_owned(),
                interval: IntervalV1 {
                    end: anchor,
                    start: anchor,
                },
                kind,
                origin: StudioAuthoringOrigin::DirectManipulation,
            }],
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: vec![operation_id.to_owned()],
            transaction_id: operation_id.to_owned(),
        }
    }

    fn second_group_resize_creation(first: &StudioCreationEditInput) -> StudioCreationEditInput {
        let entity_id = "tx:second/entity:rectangle";
        let mut creation = first.clone();
        creation.transaction_id = "second".to_owned();
        for operation in &mut creation.operations {
            operation.id = format!("second-{}", operation.id);
            operation.depends_on = operation
                .depends_on
                .iter()
                .map(|dependency| format!("second-{dependency}"))
                .collect();
            if operation.entity_id.is_some() {
                operation.entity_id = Some(entity_id.to_owned());
            }
            match &mut operation.kind {
                StudioCreationOperationKind::Create { entity } => {
                    entity.id = entity_id.to_owned();
                    entity.kind = StudioAuthoringEntityKind::Rectangle;
                    entity.dimensions = StudioAuthoringDimensions {
                        height: Some(1.0),
                        radius: None,
                        width: Some(2.0),
                    };
                }
                StudioCreationOperationKind::Position { position } => {
                    *position = Some(PointV1 { x: 480.0, y: 180.0 });
                }
                StudioCreationOperationKind::FadeIn { .. } => {}
                _ => unreachable!(),
            }
        }
        creation.schedule_order = creation
            .operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        creation
    }

    fn studio_hierarchy_edit_input(
        transaction_id: &str,
        at: f64,
        kind: StudioCreationOperationKind,
    ) -> StudioCreationEditInput {
        let operation_id = format!("{transaction_id}-hierarchy");
        StudioCreationEditInput {
            anchor_captured_playhead: at,
            anchor_resolved_seconds: at,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(at),
            },
            intent_count: 1,
            lowering_supported: false,
            operations: vec![StudioCreationOperation {
                depends_on: vec![],
                entity_id: None,
                id: operation_id.clone(),
                interval: IntervalV1 { end: at, start: at },
                kind,
                origin: StudioAuthoringOrigin::DirectManipulation,
            }],
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: vec![operation_id],
            transaction_id: transaction_id.to_owned(),
        }
    }

    fn bundle_contains_entity(bundle: &SceneIrBundleV1, entity_id: &str) -> bool {
        bundle
            .scene
            .entities
            .iter()
            .any(|entity| entity.id == entity_id)
    }

    fn studio_group_resize_edit_input(targets: &[(&str, PointV1)]) -> StudioCreationEditInput {
        let transform_at = 0.95;
        let mut operations = Vec::new();
        for (index, (entity_id, position)) in targets.iter().enumerate() {
            operations.push(StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some((*entity_id).to_owned()),
                id: format!("group-position-{index}"),
                interval: IntervalV1 {
                    end: transform_at,
                    start: transform_at,
                },
                kind: StudioCreationOperationKind::Position {
                    position: Some(position.clone()),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        }
        for (index, (entity_id, _)) in targets.iter().enumerate() {
            operations.push(StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some((*entity_id).to_owned()),
                id: format!("group-scale-{index}"),
                interval: IntervalV1 {
                    end: transform_at,
                    start: transform_at,
                },
                kind: StudioCreationOperationKind::UniformScale {
                    control_present: false,
                    from: Some(1.0),
                    relative_factor: Some(1.5),
                    to: Some(1.5),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        }
        let schedule_order = operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        StudioCreationEditInput {
            anchor_captured_playhead: transform_at,
            anchor_resolved_seconds: transform_at,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(transform_at),
            },
            intent_count: 1,
            lowering_supported: true,
            operations,
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order,
            transaction_id: "group-resize".to_owned(),
        }
    }

    fn studio_group_rotation_edit_input(
        targets: &[(&str, PointV1)],
        angle_radians: f64,
    ) -> StudioCreationEditInput {
        let transform_at = 0.95;
        let mut operations = Vec::new();
        for (index, (entity_id, position)) in targets.iter().enumerate() {
            operations.push(StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some((*entity_id).to_owned()),
                id: format!("group-position-{index}"),
                interval: IntervalV1 {
                    end: transform_at,
                    start: transform_at,
                },
                kind: StudioCreationOperationKind::Position {
                    position: Some(position.clone()),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        }
        for (index, (entity_id, _)) in targets.iter().enumerate() {
            operations.push(StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some((*entity_id).to_owned()),
                id: format!("group-rotation-{index}"),
                interval: IntervalV1 {
                    end: transform_at,
                    start: transform_at,
                },
                kind: StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(angle_radians),
                    to: Some(angle_radians),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        }
        let schedule_order = operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        StudioCreationEditInput {
            anchor_captured_playhead: transform_at,
            anchor_resolved_seconds: transform_at,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(transform_at),
            },
            intent_count: 1,
            lowering_supported: true,
            operations,
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order,
            transaction_id: "group-rotation".to_owned(),
        }
    }

    fn assert_group_resize_transform(
        channels: &[AnimationChannelV1],
        entity_id: &str,
        expected: &PointV1,
    ) {
        let transform = channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
                _ => None,
            })
            .unwrap();
        assert!((transform.m11 - 1.5).abs() < 1e-12);
        assert!((transform.m22 - 1.5).abs() < 1e-12);
        assert!((transform.tx - expected.x).abs() < 1e-12);
        assert!((transform.ty - expected.y).abs() < 1e-12);
    }

    fn assert_group_rotation_transform(
        channels: &[AnimationChannelV1],
        entity_id: &str,
        expected: &PointV1,
    ) {
        let transform = channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
                _ => None,
            })
            .unwrap();
        assert!(transform.m11.abs() < 1e-12);
        assert!((transform.m12 + 1.0).abs() < 1e-12);
        assert!((transform.m21 - 1.0).abs() < 1e-12);
        assert!(transform.m22.abs() < 1e-12);
        assert!((transform.tx - expected.x).abs() < 1e-12);
        assert!((transform.ty - expected.y).abs() < 1e-12);
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one visible composition test pins ordered projection and the installed static Scene state"
    )]
    fn normalized_creation_composes_static_rotation_and_opacity() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command.programs.extend([
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotate-first",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(std::f64::consts::FRAC_PI_2),
                    to: Some(std::f64::consts::FRAC_PI_2),
                },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "opacity",
                StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotate-second",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(std::f64::consts::FRAC_PI_4),
                    to: Some(std::f64::consts::FRAC_PI_4),
                },
            ),
        ]);
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();

        assert!(matches!(
            &projection.mutations[2].kind,
            StudioCreationProjectedMutationKind::Rotation { from, to }
                if from.abs() < 1e-12 && (*to - std::f64::consts::FRAC_PI_2).abs() < 1e-12
        ));
        assert!(matches!(
            &projection.mutations[3].kind,
            StudioCreationProjectedMutationKind::Opacity { value }
                if (*value - 0.25).abs() < 1e-12
        ));
        assert!(matches!(
            &projection.mutations[4].kind,
            StudioCreationProjectedMutationKind::Rotation { from, to }
                if (*from - std::f64::consts::FRAC_PI_2).abs() < 1e-12
                    && (*to - 3.0 * std::f64::consts::FRAC_PI_4).abs() < 1e-12
        ));
        assert!(
            projection.mutations[2..]
                .iter()
                .all(|mutation| (mutation.interval.start - 0.9).abs() < 1e-12)
        );

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!((created.transform.m11 - 1.0).abs() < 1e-12);
        assert!(created.transform.m12.abs() < 1e-12);
        assert!(created.transform.m21.abs() < 1e-12);
        assert!((created.transform.m22 - 1.0).abs() < 1e-12);
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector { fill: None, stroke: Some(stroke), .. }
                if (stroke.color.alpha - 1.0).abs() < 1e-12
        ));
        let sample = |at| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "created-appearance-sample",
                    sample_time: at,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            let poietra_scene_ir::RenderDrawV1::Path {
                stroke: Some(stroke),
                transform,
                ..
            } = packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == entity_id)
                .unwrap()
            else {
                panic!("created circle must remain a stroked path");
            };
            (transform.clone(), stroke.color.alpha)
        };
        let (before_transform, before_alpha) = sample(0.899_999);
        assert!((before_transform.m11 - 1.0).abs() < 1e-12);
        assert!(before_transform.m12.abs() < 1e-12);
        assert!((before_alpha - 1.0).abs() < 1e-12);

        let (after_transform, after_alpha) = sample(0.9);
        let expected_cosine = (3.0 * std::f64::consts::FRAC_PI_4).cos();
        let expected_sine = (3.0 * std::f64::consts::FRAC_PI_4).sin();
        assert!((after_transform.m11 - expected_cosine).abs() < 1e-12);
        assert!((after_transform.m12 + expected_sine).abs() < 1e-12);
        assert!((after_transform.m21 - expected_sine).abs() < 1e-12);
        assert!((after_transform.m22 - expected_cosine).abs() < 1e-12);
        assert!((after_alpha - 0.25).abs() < 1e-12);

        let identity_bundle = static_imported_bundle();
        let mut identity_command = studio_creation_command(&identity_bundle);
        identity_command.programs.truncate(1);
        identity_command.programs.extend([
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotate-away",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(0.5),
                    to: Some(0.5),
                },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotate-home",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(-0.5),
                    to: Some(-0.5),
                },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "opacity-away",
                StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "opacity-home",
                StudioCreationOperationKind::Opacity { alpha: Some(1.0) },
            ),
        ]);
        let mut identity_session = EngineSessionV1::new(identity_bundle).unwrap();
        let identity_result = identity_session
            .apply_studio_creation_edit(identity_command)
            .unwrap();
        assert!(
            !identity_result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(channel,
                        AnimationChannelV1::AffineTransform { entity_id: animated, .. }
                        | AnimationChannelV1::VectorAppearance { entity_id: animated, .. }
                        if animated == entity_id
                    )
                })
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one temporal sample test pins the complete fill/stroke/opacity composition"
    )]
    fn normalized_creation_applies_shape_colors_only_from_the_appearance_anchor() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command.programs.extend([
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "opacity-before-colors",
                StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "fill-color",
                StudioCreationOperationKind::FillColor {
                    color: Some("#e07a5f".to_owned()),
                },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "stroke-color",
                StudioCreationOperationKind::StrokeColor {
                    color: Some("#81b29a".to_owned()),
                },
            ),
        ]);
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert!(matches!(
            &projection.mutations[2].kind,
            StudioCreationProjectedMutationKind::Opacity { value }
                if (*value - 0.25).abs() < 1e-12
        ));
        assert!(matches!(
            &projection.mutations[3].kind,
            StudioCreationProjectedMutationKind::FillColor { value } if value == "#e07a5f"
        ));
        assert!(matches!(
            &projection.mutations[4].kind,
            StudioCreationProjectedMutationKind::StrokeColor { value } if value == "#81b29a"
        ));
        assert!(
            projection.mutations[2..]
                .iter()
                .all(|mutation| (mutation.interval.start - 0.9).abs() < 1e-12)
        );

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector { fill: Some(fill), stroke: Some(stroke), .. }
                if fill.color.alpha.abs() < 1e-12
                    && (stroke.color.red - 1.0).abs() < 1e-12
                    && (stroke.color.green - 1.0).abs() < 1e-12
                    && (stroke.color.blue - 1.0).abs() < 1e-12
                    && (stroke.color.alpha - 1.0).abs() < 1e-12
        ));
        let sample = |at| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "created-color-sample",
                    sample_time: at,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            let poietra_scene_ir::RenderDrawV1::Path { fill, stroke, .. } = packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == entity_id)
                .unwrap()
            else {
                panic!("created circle must evaluate to one vector path");
            };
            (fill.clone(), stroke.clone().unwrap().color)
        };
        let (before_fill, before_stroke) = sample(0.899_999);
        assert!(before_fill.is_some_and(|fill| fill.color.alpha.abs() < 1e-12));
        assert!((before_stroke.red - 1.0).abs() < 1e-12);
        assert!((before_stroke.green - 1.0).abs() < 1e-12);
        assert!((before_stroke.blue - 1.0).abs() < 1e-12);
        assert!((before_stroke.alpha - 1.0).abs() < 1e-12);

        let (after_fill, after_stroke) = sample(0.9);
        let after_fill = after_fill.expect("fill color edit must enable the shape fill");
        assert!((after_fill.color.red - 224.0 / 255.0).abs() < 1e-12);
        assert!((after_fill.color.green - 122.0 / 255.0).abs() < 1e-12);
        assert!((after_fill.color.blue - 95.0 / 255.0).abs() < 1e-12);
        assert!((after_fill.color.alpha - 0.25).abs() < 1e-12);
        assert!((after_stroke.red - 129.0 / 255.0).abs() < 1e-12);
        assert!((after_stroke.green - 178.0 / 255.0).abs() < 1e-12);
        assert!((after_stroke.blue - 154.0 / 255.0).abs() < 1e-12);
        assert!((after_stroke.alpha - 0.25).abs() < 1e-12);
    }

    #[test]
    fn normalized_creation_applies_persistent_canonical_paint_order() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command.programs.push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "layer-order",
            StudioCreationOperationKind::SourceZIndex {
                document_static: false,
                from_source_z_index: None,
                source_z_index: Some(-10.0),
            },
        ));
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert!(matches!(
            &projection.mutations[2].kind,
            StudioCreationProjectedMutationKind::SourceZIndex { source_z_index }
                if (*source_z_index + 10.0).abs() < 1e-12
        ));

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!((created.source_z_index + 10.0).abs() < f64::EPSILON);
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "created-order-sample",
                sample_time: 1.0,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert_eq!(
            packet
                .draws
                .first()
                .map(poietra_scene_ir::RenderDrawV1::entity_id),
            Some(entity_id)
        );
    }

    #[test]
    #[allow(
        clippy::cast_precision_loss,
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "one end-to-end logical-group paint-order regression scenario"
    )]
    fn normalized_creation_applies_late_group_paint_order_atomically() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command
            .programs
            .push(second_group_resize_creation(&command.programs[0]));
        let first_created_z = bundle
            .scene
            .entities
            .iter()
            .map(|entity| entity.source_z_index)
            .fold(-1.0_f64, f64::max)
            + 1.0;
        command.programs.push(studio_created_appearance_edit_input(
            0.5,
            "tx:create/entity:circle",
            "prior-child-layer-order",
            StudioCreationOperationKind::SourceZIndex {
                document_static: false,
                from_source_z_index: None,
                source_z_index: Some(first_created_z),
            },
        ));
        let child_ids = vec![
            "tx:second/entity:rectangle".to_owned(),
            "tx:create/entity:circle".to_owned(),
        ];
        let group_id = "tx:ordered-group/entity:group".to_owned();
        command.programs.push(studio_hierarchy_edit_input(
            "ordered-group",
            1.0,
            StudioCreationOperationKind::Group {
                child_entity_ids: child_ids.clone(),
                group_id: group_id.clone(),
            },
        ));
        let command_without_order = command.clone();
        let operations = child_ids
            .iter()
            .rev()
            .enumerate()
            .map(|(index, entity_id)| StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some(entity_id.clone()),
                id: format!("order-group-child-{index}"),
                interval: IntervalV1 {
                    end: 1.1,
                    start: 1.1,
                },
                kind: StudioCreationOperationKind::SourceZIndex {
                    document_static: true,
                    from_source_z_index: Some(first_created_z + index as f64),
                    source_z_index: Some(10.0 + index as f64),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            })
            .collect::<Vec<_>>();
        command.programs.push(StudioCreationEditInput {
            anchor_captured_playhead: 1.1,
            anchor_resolved_seconds: 1.1,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(1.1),
            },
            intent_count: 1,
            lowering_supported: false,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: operations
                .iter()
                .map(|operation| operation.id.clone())
                .collect(),
            operations,
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            transaction_id: "order-active-group".to_owned(),
        });

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        let group_order_mutations = projection
            .mutations
            .iter()
            .filter(|mutation| {
                matches!(
                    mutation.kind,
                    StudioCreationProjectedMutationKind::SourceZIndex { .. }
                ) && mutation.transaction_id == "order-active-group"
            })
            .collect::<Vec<_>>();
        assert_eq!(group_order_mutations.len(), 2);
        assert!(group_order_mutations.iter().all(|mutation| {
            projection.entities.iter().any(|entity| {
                entity.entity_id == mutation.entity_id
                    && studio_timeline_semantic_values_match(
                        mutation.interval.start,
                        entity.created_lifetime.start,
                    )
                    && studio_timeline_semantic_values_match(
                        mutation.interval.end,
                        entity.created_lifetime.start,
                    )
            })
        }));
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command.clone()).unwrap();
        for child_id in &child_ids {
            let child = result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .unwrap();
            let expected_z = if child_id == "tx:create/entity:circle" {
                10.0
            } else {
                11.0
            };
            assert_eq!(child.source_z_index, expected_z);
            assert_eq!(child.parent_id.as_deref(), Some(group_id.as_str()));
        }
        let undone = EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(command_without_order)
            .unwrap();
        for (index, child_id) in ["tx:create/entity:circle", "tx:second/entity:rectangle"]
            .iter()
            .enumerate()
        {
            assert_eq!(
                undone
                    .bundle
                    .scene
                    .entities
                    .iter()
                    .find(|entity| entity.id == *child_id)
                    .unwrap()
                    .source_z_index,
                first_created_z + index as f64
            );
        }
        let redone = EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(command.clone())
            .unwrap();
        assert_eq!(redone.bundle, result.bundle);
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "group-order-before-authoring-anchor",
                sample_time: 1.0,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert_eq!(
            packet
                .draws
                .iter()
                .map(poietra_scene_ir::RenderDrawV1::entity_id)
                .filter(|entity_id| child_ids.iter().any(|child_id| child_id == entity_id))
                .collect::<Vec<_>>(),
            vec!["tx:create/entity:circle", "tx:second/entity:rectangle"]
        );

        let mut wrong_from = command.clone();
        for operation in &mut wrong_from.programs.last_mut().unwrap().operations {
            let StudioCreationOperationKind::SourceZIndex {
                from_source_z_index,
                ..
            } = &mut operation.kind
            else {
                unreachable!();
            };
            *from_source_z_index = from_source_z_index.map(|value| value + 1.0);
        }
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &wrong_from.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));

        let mut wrong_default = command.clone();
        let default_operation = wrong_default
            .programs
            .last_mut()
            .unwrap()
            .operations
            .iter_mut()
            .find(|operation| operation.entity_id.as_deref() == Some("tx:second/entity:rectangle"))
            .unwrap();
        let StudioCreationOperationKind::SourceZIndex {
            from_source_z_index,
            source_z_index,
            ..
        } = &mut default_operation.kind
        else {
            unreachable!();
        };
        *from_source_z_index = from_source_z_index.map(|value| value + 1.0);
        *source_z_index = source_z_index.map(|value| value + 1.0);
        assert!(
            project_studio_creation_edits(bundle.scene.duration, &wrong_default.programs).is_ok()
        );
        assert!(matches!(
            EngineSessionV1::new(bundle.clone())
                .unwrap()
                .apply_studio_creation_edit(wrong_default),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));

        let mut wrong_contract = command.clone();
        let StudioCreationOperationKind::SourceZIndex {
            document_static, ..
        } = &mut wrong_contract.programs.last_mut().unwrap().operations[0].kind
        else {
            unreachable!();
        };
        *document_static = false;
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &wrong_contract.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));

        let mut non_uniform = command.clone();
        let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } =
            &mut non_uniform.programs.last_mut().unwrap().operations[0].kind
        else {
            unreachable!();
        };
        *source_z_index = source_z_index.map(|value| value + 0.25);
        assert!(
            project_studio_creation_edits(bundle.scene.duration, &non_uniform.programs).is_ok()
        );
        assert!(
            EngineSessionV1::new(bundle.clone())
                .unwrap()
                .apply_studio_creation_edit(non_uniform)
                .is_ok()
        );

        let mut reversed = command.clone();
        let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } =
            &mut reversed.programs.last_mut().unwrap().operations[0].kind
        else {
            unreachable!();
        };
        *source_z_index = source_z_index.map(|value| value + 2.0);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &reversed.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));

        let mut split = command.clone();
        for (index, operation) in split
            .programs
            .last_mut()
            .unwrap()
            .operations
            .iter_mut()
            .enumerate()
        {
            let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } =
                &mut operation.kind
            else {
                unreachable!();
            };
            *source_z_index = Some(if index == 0 { -100.0 } else { 100.0 });
        }
        assert!(project_studio_creation_edits(bundle.scene.duration, &split.programs).is_ok());
        assert!(matches!(
            EngineSessionV1::new(bundle.clone())
                .unwrap()
                .apply_studio_creation_edit(split),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));

        command.programs.last_mut().unwrap().operations.pop();
        command.programs.last_mut().unwrap().schedule_order.pop();
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }

    #[test]
    fn normalized_creation_applies_static_visibility_without_changing_lifetime_or_opacity() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command.programs.push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "hide-layer",
            StudioCreationOperationKind::Visibility {
                visible: Some(false),
            },
        ));

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert!(matches!(
            &projection.mutations[2].kind,
            StudioCreationProjectedMutationKind::Visibility { visible: false }
        ));

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!(!created.visible);
        assert_eq!(
            created.lifetimes,
            vec![IntervalV1 {
                end: result.bundle.scene.duration,
                start: 0.5
            }]
        );
        assert!(matches!(
            created.appearance,
            SceneAppearanceV1::Vector { opacity, .. } if (opacity - 1.0).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn normalized_creation_rejects_invalid_shape_color_edits() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut uppercase = studio_creation_command(&bundle);
        uppercase.programs.truncate(1);
        uppercase
            .programs
            .push(studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "uppercase-color",
                StudioCreationOperationKind::FillColor {
                    color: Some("#E07A5F".to_owned()),
                },
            ));
        let mut missing_color = studio_creation_command(&bundle);
        missing_color.programs.truncate(1);
        missing_color
            .programs
            .push(studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "missing-color",
                StudioCreationOperationKind::FillColor { color: None },
            ));
        let mut wrong_anchor = studio_creation_command(&bundle);
        wrong_anchor.programs.truncate(1);
        wrong_anchor
            .programs
            .push(studio_created_appearance_edit_input(
                1.0,
                entity_id,
                "wrong-color-anchor",
                StudioCreationOperationKind::StrokeColor {
                    color: Some("#81b29a".to_owned()),
                },
            ));

        let mut line = studio_creation_command(&bundle);
        line.programs.truncate(1);
        for operation in &mut line.programs[0].operations {
            if operation.entity_id.as_deref() == Some(entity_id) {
                operation.entity_id = Some("tx:create/entity:line".to_owned());
            }
        }
        let StudioCreationOperationKind::Create { entity } =
            &mut line.programs[0].operations[0].kind
        else {
            panic!("creation fixture must start with CreateEntity");
        };
        entity.id = "tx:create/entity:line".to_owned();
        entity.kind = StudioAuthoringEntityKind::Line;
        entity.dimensions = StudioAuthoringDimensions::default();
        line.programs.push(studio_created_appearance_edit_input(
            0.5,
            "tx:create/entity:line",
            "line-color",
            StudioCreationOperationKind::StrokeColor {
                color: Some("#81b29a".to_owned()),
            },
        ));

        for command in [uppercase, missing_color, wrong_anchor, line] {
            assert!(matches!(
                project_studio_creation_edits(bundle.scene.duration, &command.programs),
                Err(ProjectStudioCreationEditError::Unsupported)
            ));
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized static transform batch stores exact authored values"
    )]
    fn normalized_creation_composes_single_resize_rotation_and_scale_at_one_anchor() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.push(studio_created_appearance_edit_input(
            0.85,
            entity_id,
            "rotation-after-resize",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(std::f64::consts::FRAC_PI_2),
                to: Some(std::f64::consts::FRAC_PI_2),
            },
        ));
        command.programs.push(studio_created_appearance_edit_input(
            0.85,
            entity_id,
            "scale-after-rotation",
            StudioCreationOperationKind::UniformScale {
                control_present: false,
                from: Some(1.0),
                relative_factor: Some(1.5),
                to: Some(1.5),
            },
        ));
        command.programs.push(studio_created_appearance_edit_input(
            0.85,
            entity_id,
            "second-rotation",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(std::f64::consts::FRAC_PI_2),
                to: Some(std::f64::consts::FRAC_PI_2),
            },
        ));

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert!(matches!(
            projection.mutations.last().map(|mutation| &mutation.kind),
            Some(StudioCreationProjectedMutationKind::Rotation { from, to })
                if (*from - std::f64::consts::FRAC_PI_2).abs() < 1e-12
                    && (*to - std::f64::consts::PI).abs() < 1e-12
        ));

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let transform = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id: target,
                    keyframes,
                    ..
                } if target == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
                _ => None,
            })
            .unwrap();
        assert!((transform.m11 + 3.0).abs() < 1e-12);
        assert!(transform.m12.abs() < 1e-12);
        assert!(transform.m21.abs() < 1e-12);
        assert!((transform.m22 + 3.0).abs() < 1e-12);
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn normalized_creation_rejects_invalid_or_animated_appearance_edits_atomically() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut stale_rotation = studio_creation_command(&bundle);
        stale_rotation.programs.truncate(1);
        stale_rotation
            .programs
            .push(studio_created_appearance_edit_input(
                1.0,
                entity_id,
                "stale-rotation",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.25),
                    relative_delta: Some(0.5),
                    to: Some(0.75),
                },
            ));
        let mut noop_opacity = studio_creation_command(&bundle);
        noop_opacity.programs.truncate(1);
        noop_opacity
            .programs
            .push(studio_created_appearance_edit_input(
                1.0,
                entity_id,
                "noop-opacity",
                StudioCreationOperationKind::Opacity { alpha: Some(1.0) },
            ));
        let mut rotation_at_a_different_static_anchor = studio_creation_command(&bundle);
        rotation_at_a_different_static_anchor
            .programs
            .push(studio_created_appearance_edit_input(
                1.2,
                entity_id,
                "rotation-at-a-different-static-anchor",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(0.5),
                    to: Some(0.5),
                },
            ));
        let mut rotation_with_motion = studio_creation_command(&bundle);
        rotation_with_motion.programs.truncate(1);
        rotation_with_motion
            .programs
            .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
        rotation_with_motion
            .programs
            .push(studio_created_appearance_edit_input(
                1.2,
                entity_id,
                "rotation-with-motion",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(0.5),
                    to: Some(0.5),
                },
            ));

        for command in [
            stale_rotation,
            noop_opacity,
            rotation_at_a_different_static_anchor,
            rotation_with_motion,
        ] {
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
            assert!(matches!(
                session.apply_studio_creation_edit(command),
                Err(ApplyStudioCreationEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &bundle.scene);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn normalized_creation_projects_and_applies_a_line() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let program = &mut command.programs[0];
        for operation in &mut program.operations {
            if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
                operation.entity_id = Some("tx:create/entity:line".to_owned());
            }
        }
        let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
            panic!("creation fixture must start with CreateEntity");
        };
        entity.id = "tx:create/entity:line".to_owned();
        entity.kind = StudioAuthoringEntityKind::Line;
        entity.dimensions = StudioAuthoringDimensions::default();

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.entities[0].kind, StudioAuthoringEntityKind::Line);

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:line")
            .unwrap();
        assert!(matches!(
            &created.geometry,
            SceneGeometryV1::Line {
                start: PointV1 { x: -1.0, y: 0.0 },
                end: PointV1 { x: 1.0, y: 0.0 },
            }
        ));
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn normalized_creation_projects_applies_and_animates_an_arrow() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let program = &mut command.programs[0];
        for operation in &mut program.operations {
            if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
                operation.entity_id = Some("tx:create/entity:arrow".to_owned());
            }
        }
        let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
            panic!("creation fixture must start with CreateEntity");
        };
        entity.id = "tx:create/entity:arrow".to_owned();
        entity.kind = StudioAuthoringEntityKind::Arrow;
        entity.dimensions = StudioAuthoringDimensions::default();
        command.programs.push(studio_created_motion_edit_input(vec![
            "tx:create/entity:arrow".to_owned(),
        ]));

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(
            projection.entities[0].kind,
            StudioAuthoringEntityKind::Arrow
        );
        assert_eq!(projection.motions.len(), 1);

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:arrow")
            .unwrap();
        let SceneGeometryV1::CubicPath { path } = &created.geometry else {
            panic!("Studio Arrow must materialize one cubic-path entity");
        };
        assert_eq!(path.subpaths.len(), 1);
        assert!(path.subpaths[0].closed);
        assert_eq!(path.subpaths[0].start, PointV1 { x: -1.0, y: -0.02 });
        assert_eq!(path.subpaths[0].segments[2].end, PointV1 { x: 1.0, y: 0.0 });
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                fill: Some(_),
                stroke: Some(_),
                ..
            }
        ));
        assert!(
            result
                .bundle
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::CubicPathGeometry)
        );
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::MotionPath { entity_id, .. }
                            if entity_id == "tx:create/entity:arrow"
                    )
                })
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "exact authored intervals and endpoints verify the atomic creation motion"
    )]
    fn normalized_creation_applies_and_samples_a_later_motion() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command
            .programs
            .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        assert!(result.static_root_projection.is_none());
        assert!(
            serde_json::to_value(&result)
                .unwrap()
                .get("staticRootProjection")
                .is_none()
        );
        let motion = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id: target,
                    keyframes,
                    path,
                    ..
                } if target == entity_id => Some((keyframes, path)),
                _ => None,
            })
            .unwrap();

        assert_eq!(result.bundle.scene.duration, base_duration + 1.4);
        assert_eq!(
            motion
                .0
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![1.4, 2.4]
        );
        assert_eq!(motion.1.subpaths[0].start, PointV1 { x: 0.0, y: 0.0 });
        assert_eq!(
            motion.1.subpaths[0].segments[0].end,
            PointV1 { x: 6.0, y: 2.0 }
        );

        let sampled_position = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "created-motion-sample",
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
                .find(|draw| draw.entity_id() == entity_id)
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => PointV1 {
                    x: transform.tx,
                    y: transform.ty,
                },
                _ => panic!("created motion target must remain a path draw"),
            }
        };
        for (time, expected) in [
            (1.4, PointV1 { x: 0.0, y: 0.0 }),
            (1.9, PointV1 { x: 3.0, y: 3.0 }),
            (2.4, PointV1 { x: 6.0, y: 2.0 }),
        ] {
            let sampled = sampled_position(time);
            assert!((sampled.x - expected.x).abs() < 1e-10, "time={time}");
            assert!((sampled.y - expected.y).abs() < 1e-10, "time={time}");
        }
        assert_eq!(session.scene(), &result.bundle.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn normalized_creation_rejects_a_later_mixed_motion_atomically() {
        let bundle = static_imported_bundle();
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command.programs.push(studio_created_motion_edit_input(vec![
            "tx:create/entity:circle".to_owned(),
            "later".to_owned(),
        ]));
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized batch produces exact stored timeline and transform values"
    )]
    fn normalized_arrow_creation_composes_motion_then_scale_and_remove() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            panic!("creation fixture must start with CreateEntity");
        };
        entity.kind = StudioAuthoringEntityKind::Arrow;
        entity.dimensions = StudioAuthoringDimensions::default();
        command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        };
        let mut motion = studio_created_motion_edit_input(vec![entity_id.to_owned()]);
        motion.anchor_captured_playhead = 0.75;
        motion.anchor_resolved_seconds = 0.75;
        motion.anchor_source = SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.75),
        };
        motion.operations[0].interval = IntervalV1 {
            end: 1.75,
            start: 0.75,
        };
        command.programs.insert(1, motion);
        command
            .programs
            .push(studio_persistent_remove_edit_input(entity_id, 1.8, 2.0));
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        assert!(result.motion_projection.is_none());
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        assert_eq!(projection.motions.len(), 1);
        assert!(projection.mutations.iter().any(|mutation| matches!(
            mutation.kind,
            StudioCreationProjectedMutationKind::UniformScale {
                from: 1.0,
                to: 1.5,
                ..
            }
        )));
        assert_eq!(projection.removals.len(), 1);
        assert_eq!(
            result.persistent_remove_projection.removals,
            projection.removals
        );
        assert_eq!(result.bundle.scene.duration, 3.4);
        assert_eq!(result.persistent_remove_projection.removals.len(), 1);
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::MotionPath {
                            entity_id: target,
                            keyframes,
                            ..
                        } if target == entity_id
                            && keyframes[0].at == 1.15
                            && keyframes[1].at == 2.15
                    )
                })
        );
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform {
                            entity_id: target,
                            keyframes,
                            ..
                        } if target == entity_id
                            && keyframes[0].at == 2.25
                            && keyframes[0].value.m11 == 1.5
                            && keyframes[0].value.m22 == 1.5
                    )
                })
        );
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized command produces exact stored authoring values"
    )]
    fn normalized_creation_owns_timeline_and_followup_resize_semantics() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        let result = session
            .apply_studio_creation_edit(studio_creation_command(&bundle))
            .unwrap();
        let result = result.bundle;

        assert_eq!(result.scene.duration, base_duration + 0.4);
        let created = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:circle")
            .unwrap();
        assert!(matches!(
            created.geometry,
            SceneGeometryV1::Circle { radius: 1.0, .. }
        ));
        assert_eq!(
            (
                created.transform.m11,
                created.transform.tx,
                created.transform.ty
            ),
            (1.0, 0.0, 0.0)
        );
        assert!(
            result
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                        if entity_id == "tx:create/entity:circle"
                            && keyframes[0].at == 1.25
                            && keyframes[0].value.m11 == 2.0
                    && keyframes[0].value.m22 == 2.0
                    && keyframes[0].value.tx == 1.0
                    && keyframes[0].value.ty == 0.0
                ))
        );
        assert_eq!(session.scene(), &result.scene);
    }

    #[test]
    fn source_lowering_metadata_does_not_gate_canonical_creation() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs[0].lowering_supported = false;

        let mut session = EngineSessionV1::new(bundle).unwrap();
        assert!(session.apply_studio_creation_edit(command).is_ok());
    }

    #[test]
    fn creation_opacity_track_uses_the_existing_timeline_without_inserting_time() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();

        assert!((result.bundle.scene.duration - (base_duration + 0.4)).abs() < 1e-12);
        assert_eq!(
            result
                .creation_projection
                .as_ref()
                .unwrap()
                .insertions
                .len(),
            1
        );
        let opacity = result
            .creation_projection
            .as_ref()
            .unwrap()
            .mutations
            .iter()
            .find(|mutation| mutation.operation_id == "opacity-segment")
            .unwrap();
        assert!(
            (opacity.interval.start - 1.4).abs() < 1e-12,
            "projected opacity interval: {:?}",
            opacity.interval
        );
        assert!((opacity.interval.end - 1.8).abs() < 1e-12);
        assert!(matches!(
            opacity.kind,
            StudioCreationProjectedMutationKind::OpacityKeyframes {
                easing: EasingV1::Linear {},
                from: 1.0,
                to: 0.0,
            }
        ));
        let channel_keyframes = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Opacity {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert!(
            channel_keyframes
                .iter()
                .zip([0.5, 0.9, 1.4, 1.8])
                .all(|(keyframe, expected)| (keyframe.at - expected).abs() < 1e-12)
        );
        assert_eq!(
            channel_keyframes[2].easing_to_next,
            Some(EasingV1::Linear {})
        );
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "opacity-track-midpoint",
                sample_time: 1.6,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let alpha = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .map(poietra_scene_ir::RenderDrawV1::opacity)
            .unwrap();
        assert!((alpha - 0.5).abs() < 1e-12, "sampled alpha: {alpha}");
    }

    #[test]
    fn creation_uniform_scale_track_uses_the_canonical_affine_evaluator() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 2.0);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();

        let projection = result.creation_projection.as_ref().unwrap();
        let mutation = projection
            .mutations
            .iter()
            .find(|mutation| mutation.operation_id == "scale-segment")
            .unwrap();
        assert!(matches!(
            &mutation.kind,
            StudioCreationProjectedMutationKind::UniformScaleKeyframes {
                easing: EasingV1::CubicBezier {
                    x1: 0.42,
                    x2: 0.58,
                    y1: 0.0,
                    y2: 1.0,
                },
                from: 1.0,
                to: 2.0,
            }
        ));
        let channel = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert_eq!(channel.len(), 2);
        assert_eq!(
            channel[0].easing_to_next,
            Some(EasingV1::CubicBezier {
                x1: 0.42,
                x2: 0.58,
                y1: 0.0,
                y2: 1.0,
            })
        );
        assert!((channel[0].value.m11 - 1.0).abs() < 1e-12);
        assert!((channel[1].value.m11 - 2.0).abs() < 1e-12);

        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "scale-track-midpoint",
                sample_time: f64::midpoint(channel[0].at, channel[1].at),
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let transform = packet
            .draws
            .iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id: candidate,
                    transform,
                    ..
                } if candidate == entity_id => Some(transform),
                _ => None,
            })
            .unwrap();
        assert!((transform.m11 - 1.5).abs() < 1e-12);
        assert!((transform.m22 - 1.5).abs() < 1e-12);
    }

    #[test]
    fn one_uniform_scale_marker_keeps_the_base_without_an_affine_channel() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.0, 1.0);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();

        assert!(
            !result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform {
                            entity_id: candidate,
                            ..
                        } if candidate == entity_id
                    )
                })
        );
    }

    #[test]
    fn creation_rotation_track_uses_scalar_angles_and_an_explicit_pivot() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 5.0 * PI);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let mutation = result
            .creation_projection
            .as_ref()
            .unwrap()
            .mutations
            .iter()
            .find(|mutation| mutation.operation_id == "rotation-segment")
            .unwrap();
        assert!(matches!(
            mutation.kind,
            StudioCreationProjectedMutationKind::RotationKeyframes {
                easing: EasingV1::Linear {},
                from: 0.0,
                to,
            } if (to - 5.0 * PI).abs() < 1e-12
        ));
        let entity = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        let (keyframes, pivot) = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Rotation {
                    entity_id: candidate,
                    keyframes,
                    pivot,
                    ..
                } if candidate == entity_id => Some((keyframes, pivot)),
                _ => None,
            })
            .unwrap();
        assert_eq!(keyframes.len(), 2);
        assert_eq!(keyframes[0].easing_to_next, Some(EasingV1::Linear {}));
        assert!((pivot.x - entity.transform.tx).abs() < 1e-12);
        assert!((pivot.y - entity.transform.ty).abs() < 1e-12);

        let sample_time = keyframes[0].at + (keyframes[1].at - keyframes[0].at) * 0.25;
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "rotation-track-quarter",
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let transform = packet
            .draws
            .iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id: candidate,
                    transform,
                    ..
                } if candidate == entity_id => Some(transform),
                _ => None,
            })
            .unwrap();
        let expected = 1.25 * PI;
        assert!((transform.m11 - expected.cos()).abs() < 1e-12);
        assert!((transform.m12 + expected.sin()).abs() < 1e-12);
        assert!((transform.m21 - expected.sin()).abs() < 1e-12);
        assert!((transform.m22 - expected.cos()).abs() < 1e-12);
        assert!(
            (transform.m11 * transform.m22 - transform.m12 * transform.m21 - 1.0).abs() < 1e-12
        );
    }

    #[test]
    fn rotation_channel_rejects_an_invalid_pivot_or_competing_affine_channel() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 5.0 * PI);
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();

        let mut invalid = result.bundle.scene.clone();
        let pivot = invalid
            .animation_channels
            .iter_mut()
            .find_map(|channel| match channel {
                AnimationChannelV1::Rotation { pivot, .. } => Some(pivot),
                _ => None,
            })
            .expect("expected the rotation channel");
        pivot.x = f64::NAN;
        assert!(poietra_scene_ir::validate_scene_ir_v1(&invalid).is_err());

        let mut conflicting = result.bundle.scene.clone();
        let provenance_id = conflicting
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Rotation { provenance_id, .. } => Some(provenance_id.clone()),
                _ => None,
            })
            .unwrap();
        conflicting
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: entity_id.to_owned(),
                id: "conflicting-affine".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 1.0,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: AffineTransformV1::identity(),
                    },
                    KeyframeV1 {
                        at: 1.4,
                        easing_to_next: None,
                        value: AffineTransformV1::identity(),
                    },
                ],
                provenance_id,
            });
        assert!(
            poietra_scene_ir::validate_scene_ir_v1(&conflicting)
                .unwrap_err()
                .contains_message("duplicate animation channel target")
        );
    }

    #[test]
    fn one_rotation_marker_keeps_the_base_without_a_transform_channel() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.0, 0.0);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();

        assert!(
            !result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::Rotation {
                            entity_id: candidate,
                            ..
                        } if candidate == entity_id
                    )
                })
        );
    }

    #[test]
    fn creation_rotation_and_scale_tracks_are_mutually_exclusive() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 2.0);
        add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, FRAC_PI_2);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
    }

    #[test]
    fn creation_material_parameter_track_emits_vector_appearance_and_coexists_with_opacity() {
        let mut bundle = static_imported_bundle();
        bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::Arrow;
        entity.dimensions = StudioAuthoringDimensions::default();
        add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let material_channel = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::VectorAppearance {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert_eq!(material_channel.len(), 2);
        assert_eq!(
            material_channel[0].easing_to_next,
            Some(EasingV1::ManimSmooth {})
        );
        let first_material = material_channel[0]
            .value
            .fill
            .as_ref()
            .and_then(|fill| fill.fragment_material.as_ref())
            .unwrap();
        let final_material = material_channel[1]
            .value
            .fill
            .as_ref()
            .and_then(|fill| fill.fragment_material.as_ref())
            .unwrap();
        assert_eq!(first_material.shader_id, "project-wave");
        assert_eq!(first_material.parameters, vec![0.35, 8.0]);
        assert_eq!(final_material.parameters, vec![0.85, 8.0]);
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "material-track-midpoint",
                sample_time: 1.6,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let midpoint = packet
            .draws
            .iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id: candidate,
                    fill: Some(fill),
                    ..
                } if candidate == entity_id => fill.fragment_material.as_ref(),
                _ => None,
            })
            .unwrap();
        assert!((midpoint.parameters[0] - 0.60).abs() < 1e-12);
        assert!(result.bundle.scene.animation_channels.iter().any(|channel| {
            matches!(channel, AnimationChannelV1::Opacity { entity_id: candidate, .. } if candidate == entity_id)
        }));
        assert!(matches!(
            result
                .creation_projection
                .as_ref()
                .unwrap()
                .mutations
                .iter()
                .find(|mutation| mutation.operation_id == "material-segment")
                .map(|mutation| &mutation.kind),
            Some(StudioCreationProjectedMutationKind::MaterialParameterKeyframes {
                easing: EasingV1::ManimSmooth {},
                name,
                parameter_index: 0,
                ..
            }) if name == "amplitude"
        ));
    }

    #[test]
    fn creation_material_parameter_track_composes_static_opacity_and_rotation() {
        let mut bundle = static_imported_bundle();
        bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::Arrow;
        entity.dimensions = StudioAuthoringDimensions::default();
        add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        command.programs.extend([
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "opacity",
                StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
            ),
            studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotation",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(FRAC_PI_2),
                    to: Some(FRAC_PI_2),
                },
            ),
        ]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                fill: Some(fill),
                stroke: Some(stroke),
                ..
            } if (fill.color.alpha - 0.25).abs() < 1e-12
                && (stroke.color.alpha - 0.25).abs() < 1e-12
                && fill.fragment_material.is_some()
        ));
        let appearance_channels = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::VectorAppearance {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => Some(keyframes),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(appearance_channels.len(), 1);
        assert!(appearance_channels[0].iter().all(|keyframe| matches!(
            &keyframe.value,
            VectorAppearanceValueV1 {
                fill: Some(fill),
                stroke: Some(stroke),
            } if (fill.color.alpha - 0.25).abs() < 1e-12
                && (stroke.color.alpha - 0.25).abs() < 1e-12
        )));
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform { entity_id: candidate, .. }
                            if candidate == entity_id
                    )
                })
        );
    }

    #[test]
    fn one_material_parameter_marker_sets_the_base_without_an_animation_channel() {
        let mut bundle = static_imported_bundle();
        bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::Arrow;
        entity.dimensions = StudioAuthoringDimensions::default();
        add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        let marker = command.programs[0].operations.last_mut().unwrap();
        marker.interval.end = marker.interval.start;
        let StudioCreationOperationKind::MaterialParameterKeyframes {
            from: Some(from),
            to,
            ..
        } = &mut marker.kind
        else {
            unreachable!();
        };
        *to = Some(*from);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        let SceneAppearanceV1::Vector {
            fill: Some(fill), ..
        } = &created.appearance
        else {
            panic!("created arrow must have a fill");
        };
        assert_eq!(
            fill.fragment_material.as_ref().unwrap().parameters,
            vec![0.35, 8.0]
        );
        assert!(
            !result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::VectorAppearance { entity_id: candidate, .. }
                            if candidate == entity_id
                    )
                })
        );
        assert!(
            result
                .bundle
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::FragmentMaterial)
        );
        assert!((sampled_material_parameter(&session, entity_id, 0.95) - 0.35).abs() < 1e-12);
        assert!((sampled_material_parameter(&session, entity_id, 1.5) - 0.35).abs() < 1e-12);
    }

    #[test]
    fn creation_material_parameter_track_rejects_a_fill_less_shape_without_panicking() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Create(
                CreateSceneEntitiesError::InvalidAppearanceEdit
            ))
        ));
    }

    #[test]
    fn creation_opacity_track_rejects_a_mixed_non_creation_operation() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        let resize = command.programs[1].operations[0].clone();
        add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
        command.programs[0].operations.push(resize);
        command.programs[0].schedule_order.push("resize".to_owned());
        command.programs[0].schedule_edge_count = 8;
        command.programs.truncate(1);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized creation fixture stores exact authored keyframe values"
    )]
    fn normalized_creation_applies_transform_then_persistent_remove() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command
            .programs
            .push(studio_persistent_remove_edit_input(entity_id, 1.4, 1.6));
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();

        assert_eq!(created.lifetimes.last().unwrap().end, 2.0);
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform {
                            entity_id: channel_entity_id,
                            keyframes,
                            ..
                        } if channel_entity_id == entity_id && keyframes[0].at == 1.25
                    )
                })
        );
        let opacity_keyframes = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Opacity {
                    entity_id: channel_entity_id,
                    keyframes,
                    ..
                } if channel_entity_id == entity_id => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert_eq!(opacity_keyframes.len(), 4);
        assert_eq!(opacity_keyframes[1].at, 0.9);
        assert_eq!(
            opacity_keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        );
        assert!((opacity_keyframes[2].at - 1.8).abs() < 1e-9);
        assert_eq!(opacity_keyframes[2].value, 1.0);
        assert_eq!(
            opacity_keyframes[2].easing_to_next,
            Some(EasingV1::Smooth {})
        );
        assert_eq!(opacity_keyframes[3].at, 2.0);
        assert_eq!(opacity_keyframes[3].value, 0.0);
        assert_eq!(result.persistent_remove_projection.removals.len(), 1);
        let projection = &result.persistent_remove_projection.removals[0];
        assert_eq!(projection.operation_id, "remove-created");
        assert_eq!(projection.studio_entity_id, entity_id);
        assert_eq!(projection.scene_entity_id, entity_id);
        let fade_interval = projection.fade_interval.as_ref().unwrap();
        assert!((fade_interval.start - 1.8).abs() < 1e-9);
        assert!((fade_interval.end - 2.0).abs() < 1e-9);
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "the explicit second raw Program keeps same-anchor ordering and lifetime facts visible"
    )]
    fn normalized_creation_rebases_same_anchor_order_lifetimes_and_followup_time() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let mut command = studio_creation_command(&bundle);
        let second_id = "tx:second/entity:rectangle";
        command.programs.push(StudioCreationEditInput {
            anchor_captured_playhead: 0.5,
            anchor_resolved_seconds: 0.5,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(0.5),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![
                StudioCreationOperation {
                    depends_on: vec![],
                    entity_id: None,
                    id: "second-create".to_owned(),
                    interval: IntervalV1 {
                        end: 0.5,
                        start: 0.5,
                    },
                    kind: StudioCreationOperationKind::Create {
                        entity: StudioCreationEntitySpec {
                            dimensions: StudioAuthoringDimensions {
                                height: Some(1.0),
                                radius: None,
                                width: Some(2.0),
                            },
                            id: second_id.to_owned(),
                            image: None,
                            kind: StudioAuthoringEntityKind::Rectangle,
                            layout: None,
                            lifetime_end: Some(1.0),
                            lifetime_start: 0.5,
                            text: None,
                            tex_parts: None,
                        },
                    },
                    origin: StudioAuthoringOrigin::StudioDefault,
                },
                StudioCreationOperation {
                    depends_on: vec!["second-create".to_owned()],
                    entity_id: Some(second_id.to_owned()),
                    id: "second-position".to_owned(),
                    interval: IntervalV1 {
                        end: 0.5,
                        start: 0.5,
                    },
                    kind: StudioCreationOperationKind::Position {
                        position: Some(PointV1 { x: 280.0, y: 180.0 }),
                    },
                    origin: StudioAuthoringOrigin::StudioDefault,
                },
                StudioCreationOperation {
                    depends_on: vec!["second-position".to_owned()],
                    entity_id: Some(second_id.to_owned()),
                    id: "second-fade".to_owned(),
                    interval: IntervalV1 {
                        end: 0.7,
                        start: 0.5,
                    },
                    kind: StudioCreationOperationKind::FadeIn { persistent: true },
                    origin: StudioAuthoringOrigin::StudioDefault,
                },
            ],
            origin: StudioAuthoringOrigin::StudioDefault,
            requested_execution: SceneEditExecution::Parallel,
            schedule_edge_count: 4,
            schedule_mode: SceneEditScheduleMode::DependencyDag,
            schedule_order: vec![
                "second-create".to_owned(),
                "second-position".to_owned(),
                "second-fade".to_owned(),
            ],
            transaction_id: "second".to_owned(),
        });
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let result = result.bundle;
        let first = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:circle")
            .unwrap();
        let second = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == second_id)
            .unwrap();

        assert!((result.scene.duration - (base_duration + 0.6)).abs() < 1e-9);
        assert_eq!(first.scene_order + 1, second.scene_order);
        assert!((first.lifetimes[0].end - (base_duration + 0.6)).abs() < 1e-9);
        assert!((second.lifetimes[0].start - 0.9).abs() < 1e-9);
        assert!((second.lifetimes[0].end - 1.6).abs() < 1e-9);
        assert!(
            result
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                        if entity_id == "tx:create/entity:circle"
                            && (keyframes[0].at - 1.45).abs() < 1e-9
                ))
        );
    }

    #[test]
    fn normalized_creation_applies_one_group_position_and_scale_program() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let first_id = "tx:create/entity:circle";
        let second_id = "tx:second/entity:rectangle";
        let second_creation = second_group_resize_creation(&command.programs[0]);
        command.programs.push(second_creation);
        let targets = [
            (first_id, PointV1 { x: 240.0, y: 180.0 }),
            (second_id, PointV1 { x: 400.0, y: 180.0 }),
        ];
        command
            .programs
            .push(studio_group_resize_edit_input(&targets));
        let expected = targets.map(|(entity_id, position)| {
            (
                entity_id,
                studio_point_to_scene_point(
                    &position,
                    command.frame,
                    command.viewport,
                    &bundle.scene.camera.view.center,
                ),
            )
        });
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let projection = result.creation_projection.as_ref().unwrap();
        assert_eq!(
            projection
                .mutations
                .iter()
                .filter(|mutation| mutation.transaction_id == "group-resize")
                .count(),
            4
        );
        for (entity_id, expected) in expected {
            assert_group_resize_transform(
                &result.bundle.scene.animation_channels,
                entity_id,
                &expected,
            );
        }
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn normalized_creation_applies_one_rigid_group_rotation_program() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let first_id = "tx:create/entity:circle";
        let second_id = "tx:second/entity:rectangle";
        let second_creation = second_group_resize_creation(&command.programs[0]);
        command.programs.push(second_creation);
        let targets = [
            (first_id, PointV1 { x: 400.0, y: 260.0 }),
            (second_id, PointV1 { x: 400.0, y: 100.0 }),
        ];
        command
            .programs
            .push(studio_group_rotation_edit_input(&targets, FRAC_PI_2));
        let expected = targets.map(|(entity_id, position)| {
            (
                entity_id,
                studio_point_to_scene_point(
                    &position,
                    command.frame,
                    command.viewport,
                    &bundle.scene.camera.view.center,
                ),
            )
        });
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let projection = result.creation_projection.as_ref().unwrap();
        assert_eq!(
            projection
                .mutations
                .iter()
                .filter(|mutation| mutation.transaction_id == "group-rotation")
                .count(),
            4
        );
        for (entity_id, expected) in expected {
            assert_group_rotation_transform(
                &result.bundle.scene.animation_channels,
                entity_id,
                &expected,
            );
        }
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    #[allow(clippy::too_many_lines)] // One end-to-end transform/hierarchy regression scenario.
    fn normalized_creation_reuses_one_rust_transform_for_group_resize_and_rotation() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let first_id = "tx:create/entity:circle";
        let second_id = "tx:second/entity:rectangle";
        command
            .programs
            .push(second_group_resize_creation(&command.programs[0]));

        let first_rotation_targets = [
            (first_id, PointV1 { x: 400.0, y: 260.0 }),
            (second_id, PointV1 { x: 400.0, y: 100.0 }),
        ];
        command.programs.push(studio_group_rotation_edit_input(
            &first_rotation_targets,
            FRAC_PI_2,
        ));

        let resize_targets = [
            (first_id, PointV1 { x: 400.0, y: 300.0 }),
            (second_id, PointV1 { x: 400.0, y: 60.0 }),
        ];
        let mut resize = studio_group_resize_edit_input(&resize_targets);
        for operation in &mut resize.operations {
            operation.id = format!("resize-{}", operation.id);
        }
        resize.schedule_order = resize
            .operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        command.programs.push(resize);

        let final_targets = [
            (first_id, PointV1 { x: 520.0, y: 180.0 }),
            (second_id, PointV1 { x: 280.0, y: 180.0 }),
        ];
        let mut second_rotation = studio_group_rotation_edit_input(&final_targets, FRAC_PI_2);
        second_rotation.transaction_id = "group-rotation-2".to_owned();
        for operation in &mut second_rotation.operations {
            operation.id = format!("second-{}", operation.id);
        }
        second_rotation.schedule_order = second_rotation
            .operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        command.programs.push(second_rotation);
        let group_id = "tx:transformed-group/entity:group";
        command.programs.push(studio_hierarchy_edit_input(
            "transformed-group",
            0.95,
            StudioCreationOperationKind::Group {
                child_entity_ids: vec![first_id.to_owned(), second_id.to_owned()],
                group_id: group_id.to_owned(),
            },
        ));

        let expected = final_targets.map(|(entity_id, position)| {
            (
                entity_id,
                studio_point_to_scene_point(
                    &position,
                    command.frame,
                    command.viewport,
                    &bundle.scene.camera.view.center,
                ),
            )
        });
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let projection = result.creation_projection.as_ref().unwrap();

        for (entity_id, expected) in expected {
            let transform = result
                .bundle
                .scene
                .animation_channels
                .iter()
                .find_map(|channel| match channel {
                    AnimationChannelV1::AffineTransform {
                        entity_id: candidate,
                        keyframes,
                        ..
                    } if candidate == entity_id => {
                        keyframes.first().map(|keyframe| &keyframe.value)
                    }
                    _ => None,
                })
                .unwrap();
            assert!((transform.m11 + 1.5).abs() < 1e-12);
            assert!(transform.m12.abs() < 1e-12);
            assert!(transform.m21.abs() < 1e-12);
            assert!((transform.m22 + 1.5).abs() < 1e-12);
            assert!((transform.tx - expected.x).abs() < 1e-12);
            assert!((transform.ty - expected.y).abs() < 1e-12);
            assert!(projection.mutations.iter().any(|mutation| {
                mutation.entity_id == entity_id
                    && mutation.transaction_id == "group-rotation-2"
                    && matches!(
                        mutation.kind,
                        StudioCreationProjectedMutationKind::Rotation { from, to }
                            if (from - FRAC_PI_2).abs() < 1e-12
                                && (to - std::f64::consts::PI).abs() < 1e-12
                    )
            }));
        }
        let group = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == group_id)
            .unwrap();
        assert_eq!(group.transform, AffineTransformV1::identity());
        assert!(result.bundle.scene.entities.iter().any(|entity| {
            entity.id == first_id && entity.parent_id.as_deref() == Some(group_id)
        }));
        assert!(result.bundle.scene.entities.iter().any(|entity| {
            entity.id == second_id && entity.parent_id.as_deref() == Some(group_id)
        }));
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn normalized_creation_replays_group_and_ungroup_history_across_reverse_playheads() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command
            .programs
            .push(second_group_resize_creation(&command.programs[0]));
        let child_ids = vec![
            "tx:create/entity:circle".to_owned(),
            "tx:second/entity:rectangle".to_owned(),
        ];
        let group_id = "tx:studio-group/entity:group".to_owned();
        command.programs.push(studio_hierarchy_edit_input(
            "studio-group",
            1.0,
            StudioCreationOperationKind::Group {
                child_entity_ids: child_ids.clone(),
                group_id: group_id.clone(),
            },
        ));
        let grouped_history = command.clone();

        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let grouped = session.apply_studio_creation_edit(command.clone()).unwrap();
        let group = grouped
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == group_id)
            .unwrap();
        assert_eq!(group.geometry, SceneGeometryV1::Group {});
        assert_eq!(group.appearance, SceneAppearanceV1::Group { opacity: 1.0 });
        assert_eq!(group.transform, AffineTransformV1::identity());
        let maximum_child_end = child_ids
            .iter()
            .filter_map(|child_id| {
                grouped
                    .bundle
                    .scene
                    .entities
                    .iter()
                    .find(|entity| entity.id == *child_id)
                    .and_then(|entity| entity.lifetimes.last())
                    .map(|lifetime| lifetime.end)
            })
            .fold(0.0_f64, f64::max);
        assert_eq!(
            group.lifetimes,
            vec![IntervalV1 {
                start: 0.5,
                end: maximum_child_end,
            }]
        );
        assert!(child_ids.iter().all(|child_id| {
            grouped
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .is_some_and(|entity| entity.parent_id.as_deref() == Some(group_id.as_str()))
        }));

        command.programs.push(studio_hierarchy_edit_input(
            "studio-ungroup",
            0.5,
            StudioCreationOperationKind::Ungroup {
                group_id: group_id.clone(),
            },
        ));
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let ungrouped = session.apply_studio_creation_edit(command.clone()).unwrap();
        assert!(!bundle_contains_entity(&ungrouped.bundle, &group_id));
        assert!(child_ids.iter().all(|child_id| {
            ungrouped
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .is_some_and(|entity| entity.parent_id.is_none())
        }));

        let base = static_imported_bundle();
        let mut undo_session = EngineSessionV1::new(base.clone()).unwrap();
        let undo = undo_session
            .apply_studio_creation_edit(grouped_history)
            .unwrap();
        assert!(bundle_contains_entity(&undo.bundle, &group_id));

        let mut redo_session = EngineSessionV1::new(base).unwrap();
        let redo = redo_session.apply_studio_creation_edit(command).unwrap();
        assert!(!bundle_contains_entity(&redo.bundle, &group_id));
    }

    #[test]
    fn normalized_creation_trims_one_logical_group_lifetime_atomically() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command
            .programs
            .push(second_group_resize_creation(&command.programs[0]));
        let child_ids = vec![
            "tx:create/entity:circle".to_owned(),
            "tx:second/entity:rectangle".to_owned(),
        ];
        let group_id = "tx:lifetime-group/entity:group".to_owned();
        command.programs.push(studio_hierarchy_edit_input(
            "lifetime-group",
            1.0,
            StudioCreationOperationKind::Group {
                child_entity_ids: child_ids.clone(),
                group_id: group_id.clone(),
            },
        ));
        let grouped_history = command.clone();
        command
            .programs
            .push(studio_group_lifetime_trim_edit_input(&child_ids, 1.5));

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.removals.len(), 2);
        assert!(projection.removals.iter().all(|removal| {
            removal.transaction_id == "trim-group-lifetime"
                && child_ids.contains(&removal.studio_entity_id)
                && removal.fade_interval.is_none()
        }));

        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command.clone()).unwrap();
        let group = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == group_id)
            .unwrap();
        let lifetime_end = group.lifetimes[0].end;
        assert!(child_ids.iter().all(|child_id| {
            result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .is_some_and(|entity| {
                    entity.parent_id.as_deref() == Some(group_id.as_str())
                        && entity.lifetimes[0].end == lifetime_end
                })
        }));
        let visible = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "group-before-lifetime-end",
                sample_time: lifetime_end - 1e-6,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert!(child_ids.iter().all(|child_id| {
            visible
                .draws
                .iter()
                .any(|draw| draw.entity_id() == child_id)
        }));
        let hidden = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "group-at-lifetime-end",
                sample_time: lifetime_end,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert!(
            child_ids
                .iter()
                .all(|child_id| { hidden.draws.iter().all(|draw| draw.entity_id() != child_id) })
        );

        let untrimmed = EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(grouped_history)
            .unwrap();
        let untrimmed_group = untrimmed
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == group_id)
            .unwrap();
        assert!(untrimmed_group.lifetimes[0].end > lifetime_end);
        let redone = EngineSessionV1::new(bundle)
            .unwrap()
            .apply_studio_creation_edit(command)
            .unwrap();
        assert_eq!(redone.bundle, result.bundle);
    }

    #[test]
    fn normalized_creation_keeps_group_hierarchy_when_a_later_program_hides_every_child() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command
            .programs
            .push(second_group_resize_creation(&command.programs[0]));
        let child_ids = vec![
            "tx:create/entity:circle".to_owned(),
            "tx:second/entity:rectangle".to_owned(),
        ];
        let group_id = "tx:visible-group/entity:group".to_owned();
        command.programs.push(studio_hierarchy_edit_input(
            "visible-group",
            1.0,
            StudioCreationOperationKind::Group {
                child_entity_ids: child_ids.clone(),
                group_id: group_id.clone(),
            },
        ));
        let operations = child_ids
            .iter()
            .enumerate()
            .map(|(index, entity_id)| StudioCreationOperation {
                depends_on: vec![],
                entity_id: Some(entity_id.clone()),
                id: format!("hide-group-child-{index}"),
                interval: IntervalV1 {
                    end: 1.1,
                    start: 1.1,
                },
                kind: StudioCreationOperationKind::Visibility {
                    visible: Some(false),
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            })
            .collect::<Vec<_>>();
        command.programs.push(StudioCreationEditInput {
            anchor_captured_playhead: 1.1,
            anchor_resolved_seconds: 1.1,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(1.1),
            },
            intent_count: 1,
            lowering_supported: false,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Parallel,
            schedule_order: operations
                .iter()
                .map(|operation| operation.id.clone())
                .collect(),
            operations,
            origin: StudioAuthoringOrigin::DirectManipulation,
            requested_execution: SceneEditExecution::Parallel,
            transaction_id: "hide-visible-group".to_owned(),
        });

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();

        assert!(bundle_contains_entity(&result.bundle, &group_id));
        assert!(child_ids.iter().all(|child_id| {
            result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .is_some_and(|entity| {
                    !entity.visible && entity.parent_id.as_deref() == Some(group_id.as_str())
                })
        }));
        assert_eq!(
            result
                .creation_projection
                .as_ref()
                .unwrap()
                .mutations
                .iter()
                .filter(|mutation| matches!(
                    mutation.kind,
                    StudioCreationProjectedMutationKind::Visibility { visible: false }
                ))
                .count(),
            2
        );
    }

    #[test]
    fn normalized_creation_rejects_grouping_a_rotation_keyframe_target() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        add_creation_rotation_segment(
            &mut command.programs[0],
            "tx:create/entity:circle",
            1.0,
            1.2,
            FRAC_PI_2,
        );
        command.programs.push(second_group_resize_creation(
            &studio_creation_command(&bundle).programs[0],
        ));
        command.programs.push(studio_hierarchy_edit_input(
            "rotation-keyframe-group",
            1.3,
            StudioCreationOperationKind::Group {
                child_entity_ids: vec![
                    "tx:create/entity:circle".to_owned(),
                    "tx:second/entity:rectangle".to_owned(),
                ],
                group_id: "tx:rotation-keyframe-group/entity:group".to_owned(),
            },
        ));

        let mut session = EngineSessionV1::new(bundle).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
    }

    #[test]
    fn normalized_creation_rejects_a_non_rigid_or_partial_group_rotation() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        let first_id = "tx:create/entity:circle";
        let second_id = "tx:second/entity:rectangle";
        let second_creation = second_group_resize_creation(&command.programs[0]);
        command.programs.push(second_creation);
        command.programs.push(studio_group_rotation_edit_input(
            &[
                (first_id, PointV1 { x: 400.0, y: 260.0 }),
                (second_id, PointV1 { x: 401.0, y: 100.0 }),
            ],
            FRAC_PI_2,
        ));
        let mut partial = command.clone();
        let partial_rotation = partial.programs.last_mut().unwrap();
        partial_rotation
            .operations
            .retain(|operation| operation.entity_id.as_deref() == Some(first_id));
        partial_rotation.schedule_order = partial_rotation
            .operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        let mut disjoint = command.clone();
        let disjoint_rotation = disjoint.programs.last_mut().unwrap();
        disjoint_rotation.anchor_captured_playhead = 0.5;
        disjoint_rotation.anchor_resolved_seconds = 0.5;
        disjoint_rotation.anchor_source = SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.5),
        };
        disjoint_rotation.operations.retain(|operation| {
            matches!(operation.kind, StudioCreationOperationKind::Position { .. })
                && operation.entity_id.as_deref() == Some(first_id)
                || matches!(operation.kind, StudioCreationOperationKind::Rotation { .. })
                    && operation.entity_id.as_deref() == Some(second_id)
        });
        for operation in &mut disjoint_rotation.operations {
            operation.interval = IntervalV1 {
                end: 0.5,
                start: 0.5,
            };
        }
        disjoint_rotation.schedule_order = disjoint_rotation
            .operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect();
        let original = bundle.scene.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &original);
        assert!(matches!(
            session.apply_studio_creation_edit(partial),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &original);
        assert!(matches!(
            session.apply_studio_creation_edit(disjoint),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &original);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized command produces exact stored authoring values"
    )]
    fn normalized_creation_accepts_compiled_mathtex_and_folds_uniform_scale() {
        let bundle = static_imported_bundle();
        let mut command = studio_creation_command(&bundle);
        let tex_parts = vec!["E = mc^2".to_owned()];
        let entity_id = {
            let StudioCreationOperationKind::Create { entity } =
                &mut command.programs[0].operations[0].kind
            else {
                unreachable!();
            };
            entity.kind = StudioAuthoringEntityKind::MathTex;
            entity.dimensions = StudioAuthoringDimensions::default();
            entity.tex_parts = Some(tex_parts.clone());
            entity.id.clone()
        };
        command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(2.0),
            relative_factor: Some(1.5),
            to: Some(3.0),
        };
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle("mathtex-nested-radical-fraction.json")
                .scene
                .entities
                .remove(0)
                .geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        command.math_tex_outlines = vec![StudioCreationMathTexOutline {
            entity_id,
            path,
            tex_parts,
        }];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let result = result.bundle;

        let created = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:circle")
            .unwrap();
        assert!(matches!(
            created.geometry,
            SceneGeometryV1::CubicPath { .. }
        ));
        assert!(
            result
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                        if entity_id == "tx:create/entity:circle"
                            && keyframes[0].value.m11 == 1.5
                            && keyframes[0].value.m22 == 1.5
                ))
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one Text vertical-slice test pins projection, geometry, scale, and rotation"
    )]
    fn normalized_creation_accepts_compiled_text_and_existing_instant_followups() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let text = "日本語で動画を作る\nこんにちは";

        let mut scale_command = studio_text_creation_command(&bundle, text);
        scale_command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        };
        let scale_projection =
            project_studio_creation_edits(bundle.scene.duration, &scale_command.programs).unwrap();
        assert_eq!(scale_projection.entities[0].text.as_deref(), Some(text));
        assert!(scale_projection.entities[0].layout.is_none());
        assert!(scale_projection.entities[0].tex_parts.is_none());
        let serialized_projection = serde_json::to_value(&scale_projection).unwrap();
        assert_eq!(serialized_projection["entities"][0]["kind"], "text");
        assert_eq!(serialized_projection["entities"][0]["text"], text);
        assert!(
            serialized_projection["entities"][0]
                .get("texParts")
                .is_none()
        );
        assert!(matches!(
            scale_projection.mutations.last().map(|mutation| &mutation.kind),
            Some(StudioCreationProjectedMutationKind::UniformScale { from, to, .. })
                if (*from - 1.0).abs() < 1e-12 && (*to - 1.5).abs() < 1e-12
        ));
        let mut scale_session = EngineSessionV1::new(bundle.clone()).unwrap();
        let scale_result = scale_session
            .apply_studio_creation_edit(scale_command)
            .unwrap();
        let scaled = scale_result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!(matches!(scaled.geometry, SceneGeometryV1::CubicPath { .. }));
        assert!(matches!(
            scaled.appearance,
            SceneAppearanceV1::Vector {
                fill: Some(_),
                stroke: None,
                ..
            }
        ));
        assert!(
            scale_result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform { entity_id: target, keyframes, .. }
                            if target == entity_id
                                && (keyframes[0].value.m11 - 1.5).abs() < 1e-12
                                && (keyframes[0].value.m22 - 1.5).abs() < 1e-12
                    )
                })
        );

        let mut rotation_command = studio_text_creation_command(&bundle, "Hello, Poietra");
        rotation_command.programs.truncate(1);
        rotation_command
            .programs
            .push(studio_created_appearance_edit_input(
                0.5,
                entity_id,
                "rotate-text",
                StudioCreationOperationKind::Rotation {
                    control_present: false,
                    from: Some(0.0),
                    relative_delta: Some(std::f64::consts::FRAC_PI_4),
                    to: Some(std::f64::consts::FRAC_PI_4),
                },
            ));
        let mut rotation_session = EngineSessionV1::new(bundle).unwrap();
        let rotation_result = rotation_session
            .apply_studio_creation_edit(rotation_command)
            .unwrap();
        assert!(
            rotation_result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::AffineTransform { entity_id: target, .. }
                            if target == entity_id
                    )
                })
        );
    }

    #[test]
    fn normalized_creation_applies_nondefault_text_layout_in_the_initial_entity() {
        let legacy_layout: StudioTextLayout =
            serde_json::from_str(r#"{"alignment":"left","lineHeight":1.2}"#).unwrap();
        assert_eq!(legacy_layout, StudioTextLayout::default());
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_text_creation_command(&bundle, "Before");
        command.programs.truncate(1);
        let creation_lifetime =
            project_studio_creation_edits(bundle.scene.duration, &command.programs)
                .unwrap()
                .entities[0]
                .created_lifetime
                .clone();
        let updated = StudioTextContent {
            layout: StudioTextLayout {
                alignment: StudioTextAlignment::Right,
                font_family: StudioTextFontFamily::Mono,
                font_size: 1.5,
                font_weight: StudioTextFontWeight::Bold,
                line_height: 1.8,
            },
            text: "Wide\ni".to_owned(),
        };
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.layout = Some(updated.layout);
        entity.text = Some(updated.text.clone());
        let updated_path =
            scale_cubic_path(&command.text_outlines[0].path, updated.layout.font_size);
        command.text_outlines[0].layout = updated.layout;
        command.text_outlines[0].text.clone_from(&updated.text);

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.entities[0].layout, Some(updated.layout));
        assert_eq!(
            projection.entities[0].text.as_deref(),
            Some(updated.text.as_str())
        );
        assert!(
            (projection.entities[0].created_lifetime.start - creation_lifetime.start).abs()
                < f64::EPSILON
        );
        assert!(
            (projection.entities[0].created_lifetime.end - creation_lifetime.end).abs()
                < f64::EPSILON
        );

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert_eq!(
            created.geometry,
            SceneGeometryV1::CubicPath { path: updated_path }
        );
        assert_eq!(
            created.lifetimes,
            vec![projection.entities[0].created_lifetime.clone()]
        );
    }

    #[test]
    fn normalized_creation_keeps_text_motion_fade_and_delete_on_the_shared_planner() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_text_creation_command(&bundle, "Move me");
        command.programs.truncate(1);
        command
            .programs
            .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
        command
            .programs
            .push(studio_persistent_remove_edit_input(entity_id, 1.8, 2.0));
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.motions.len(), 1);
        assert_eq!(projection.removals.len(), 1);

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == entity_id)
            .unwrap();
        assert!(
            (created.lifetimes[0].end - projection.removals[0].resulting_lifetime_end).abs()
                < 1e-12
        );
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::MotionPath { entity_id: target, .. }
                            if target == entity_id
                    )
                })
        );
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::Opacity { entity_id: target, .. }
                            if target == entity_id
                    )
                })
        );
    }

    #[test]
    fn normalized_creation_rejects_missing_mismatched_or_empty_text_payloads() {
        let bundle = static_imported_bundle();
        let mut missing_outline = studio_text_creation_command(&bundle, "Hello");
        missing_outline.programs.truncate(1);
        missing_outline.text_outlines.clear();
        let mut mismatched_outline = studio_text_creation_command(&bundle, "Hello");
        mismatched_outline.programs.truncate(1);
        mismatched_outline.text_outlines[0].text = "Goodbye".to_owned();
        for command in [missing_outline, mismatched_outline] {
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
            assert!(matches!(
                session.apply_studio_creation_edit(command),
                Err(ApplyStudioCreationEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &bundle.scene);
        }

        for invalid_text in [
            String::new(),
            "   ".to_owned(),
            "two\r\nlines".to_owned(),
            "tab\tcharacter".to_owned(),
            "Cafe\u{301}".to_owned(),
            ["a"; 9].join("\n"),
            "a".repeat(129),
            "a".repeat(257),
        ] {
            let mut command = studio_text_creation_command(&bundle, &invalid_text);
            command.programs.truncate(1);
            assert!(matches!(
                project_studio_creation_edits(bundle.scene.duration, &command.programs),
                Err(ProjectStudioCreationEditError::Unsupported)
            ));
        }
        for valid_text in [
            "日本語で動画を作る".to_owned(),
            "Caf\u{e9}".to_owned(),
            "こんにちは\nPoietra".to_owned(),
            "a".repeat(128),
        ] {
            let mut command = studio_text_creation_command(&bundle, &valid_text);
            command.programs.truncate(1);
            assert!(
                project_studio_creation_edits(bundle.scene.duration, &command.programs).is_ok()
            );
        }
    }

    #[test]
    fn normalized_creation_rejects_hidden_and_malformed_edits_atomically() {
        let bundle = static_imported_bundle();
        let mut unsupported = studio_creation_command(&bundle);
        unsupported.programs[1].operations[0].kind = StudioCreationOperationKind::Unsupported;
        let mut malformed_schedule = studio_creation_command(&bundle);
        malformed_schedule.programs[0].schedule_order.swap(0, 1);
        let mut malformed_anchor = studio_creation_command(&bundle);
        malformed_anchor.programs[0].anchor_resolved_seconds = -0.5;
        let mut malformed_interval = studio_creation_command(&bundle);
        malformed_interval.programs[1].operations[0].interval.end += 0.1;
        let mut missing_dependency = studio_creation_command(&bundle);
        missing_dependency.programs[0].operations[1].depends_on = vec!["missing".to_owned()];
        let mut duplicate_transaction = studio_creation_command(&bundle);
        duplicate_transaction.programs[1].transaction_id =
            duplicate_transaction.programs[0].transaction_id.clone();
        let mut scale_ratio_mismatch = studio_creation_command(&bundle);
        scale_ratio_mismatch.programs[1].operations[0].kind =
            StudioCreationOperationKind::UniformScale {
                control_present: false,
                from: Some(1.0),
                relative_factor: Some(1.5),
                to: Some(2.0),
            };
        let mut stale_resize_baseline = studio_creation_command(&bundle);
        let StudioCreationOperationKind::Resize { from_scale, .. } =
            &mut stale_resize_baseline.programs[1].operations[0].kind
        else {
            unreachable!();
        };
        *from_scale = 1.25;

        for command in [
            unsupported,
            malformed_schedule,
            malformed_anchor,
            malformed_interval,
            missing_dependency,
            duplicate_transaction,
            scale_ratio_mismatch,
            stale_resize_baseline,
        ] {
            let expected = bundle.scene.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
            assert!(matches!(
                session.apply_studio_creation_edit(command),
                Err(ApplyStudioCreationEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected);
            assert_eq!(session.retained_index_stats().build_count, 1);
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
        let result = result.bundle;

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
    fn creates_one_manifest_backed_image_through_the_canonical_session() {
        let bundle = fixture_bundle("png-alpha-edge-camera.json");
        let command = studio_image_creation_command(&bundle);
        let expected_image = {
            let StudioCreationOperationKind::Create { entity } =
                &command.programs[0].operations[0].kind
            else {
                unreachable!();
            };
            entity.image.clone().unwrap()
        };
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result.bundle.scene.entities.last().unwrap();

        assert_eq!(result.bundle.assets, bundle.assets);
        assert!(
            result
                .bundle
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::PngImage)
        );
        assert!(matches!(
            &created.geometry,
            SceneGeometryV1::Image { asset, local_rect, sampler }
                if asset == &expected_image.asset
                    && local_rect == &expected_image.local_rect
                    && sampler == &expected_image.sampler
        ));
        assert!(matches!(
            created.appearance,
            SceneAppearanceV1::Image { opacity: 1.0 }
        ));
        let projection = result.creation_projection.unwrap();
        assert_eq!(
            projection.entities[0].kind,
            StudioAuthoringEntityKind::Image
        );
        assert_eq!(projection.entities[0].image.as_ref(), Some(&expected_image));
        assert_eq!(session.scene(), &result.bundle.scene);
    }

    #[test]
    fn rejects_an_image_reference_outside_the_installed_manifest_atomically() {
        let bundle = fixture_bundle("png-alpha-edge-camera.json");
        let mut command = studio_image_creation_command(&bundle);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.image.as_mut().unwrap().asset.sha256 = "f".repeat(64);
        let expected = bundle.scene.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &expected);
        assert_eq!(session.retained_index_stats().build_count, 1);
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
    fn creation_projector_rebases_fade_and_motion_from_the_created_position() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command
            .programs
            .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();

        assert_eq!(projection.insertions.len(), 2);
        assert_eq!(projection.motions.len(), 1);
        assert_eq!(projection.motions[0].from, PointV1 { x: 320.0, y: 180.0 });
        assert_eq!(
            projection.motions[0].interval,
            IntervalV1 {
                start: 1.4,
                end: 2.4
            }
        );
        assert!(
            (projection.projected_duration - (bundle.scene.duration + 1.4)).abs() < f64::EPSILON
        );
    }
}
