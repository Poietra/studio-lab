use std::collections::BTreeSet;

use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, EasingV1, FidelityV1, IntervalV1, KeyframeV1, PointV1,
    ProvenanceOriginV1, ProvenanceRecordV1, SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::{Deserialize, Serialize};

use crate::{EngineSessionV1, EvaluationError};

use super::identity::{
    StudioMathTexTransformEntityIdentity, StudioMathTexTransformProjectionEntityIdentity,
    StudioMathTexTransformSourceBinding, resolve_imported_math_tex_transform_source,
    studio_math_tex_transform_identity_is_closed,
};
use super::motion::{
    PlannedSceneMotion, StudioMotionEasing, StudioMotionProjectionInsertion, StudioProjectedMotion,
    append_planned_scene_motions, projected_motion_easing,
};
use super::timeline::{SceneTimelineInsertion, insert_scene_time, shift_interval_for_insertion};
use super::{
    SceneEditAnchorSource, SceneEditExecution, SceneEditOperationFacts, SceneEditScheduleMode,
    StudioAuthoringEditResult, StudioAuthoringEntityKind, StudioAuthoringOrigin,
    StudioAuthoringSize, StudioCreationMathTexOutline, StudioMathTexContent,
    StudioPersistentRemoveProjection, TIMELINE_ANCHOR_EPSILON, scene_edit_anchor_is_closed,
    scene_edit_structure_is_closed, studio_authoring_point_is_finite,
    studio_authoring_size_is_positive, studio_math_tex_content_is_canonical,
    studio_timeline_semantic_values_match, studio_vector_to_scene_vector, unused_channel_id,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMathTexTransformProjectedReplacement {
    pub content: StudioMathTexContent,
    pub interval: IntervalV1,
    pub operation_id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_lifetime: IntervalV1,
    pub target_type: StudioAuthoringEntityKind,
    pub transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMathTexTransformProjection {
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub motions: Vec<StudioProjectedMotion>,
    pub projected_duration: f64,
    pub replacements: Vec<StudioMathTexTransformProjectedReplacement>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedMathTexTransform {
    content: StudioMathTexContent,
    interval: IntervalV1,
    operation_id: String,
    studio_source_entity_id: String,
    target_entity_id: String,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedMathTexTransformMotion {
    control_offset: PointV1,
    delta: PointV1,
    easing: StudioMotionEasing,
    interval: IntervalV1,
    operation_id: String,
    source_interval: IntervalV1,
    target_entity_id: String,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct StudioMathTexTransformPlan {
    first_base_interval: IntervalV1,
    initial_source_entity_id: String,
    maximum_base_end: f64,
    motion: Option<PlannedMathTexTransformMotion>,
    planned: Vec<PlannedMathTexTransform>,
    projection_insertions: Vec<StudioMotionProjectionInsertion>,
    projected_duration: f64,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioMathTexTransformStrategy {
    ReplacementTransform,
    TransformMatchingTex,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioMathTexTransformOperation {
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
    TransformContent {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        replacement: StudioMathTexContent,
        source_entity_id: String,
        strategy: StudioMathTexTransformStrategy,
        target_entity_id: String,
        target_type: Option<String>,
    },
    Unsupported {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioMathTexTransformOperation {
    fn depends_on(&self) -> &[String] {
        match self {
            Self::CreateMotion { depends_on, .. }
            | Self::TransformContent { depends_on, .. }
            | Self::Unsupported { depends_on, .. } => depends_on,
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::CreateMotion { id, .. }
            | Self::TransformContent { id, .. }
            | Self::Unsupported { id, .. } => id,
        }
    }

    fn interval(&self) -> &IntervalV1 {
        match self {
            Self::CreateMotion { interval, .. }
            | Self::TransformContent { interval, .. }
            | Self::Unsupported { interval, .. } => interval,
        }
    }

    fn origin(&self) -> StudioAuthoringOrigin {
        match self {
            Self::CreateMotion { origin, .. }
            | Self::TransformContent { origin, .. }
            | Self::Unsupported { origin, .. } => *origin,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexTransformEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: SceneEditAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioMathTexTransformOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: SceneEditExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: SceneEditScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

pub type StudioMathTexTransformOutline = StudioCreationMathTexOutline;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioMathTexTransformEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub math_tex_outlines: Vec<StudioMathTexTransformOutline>,
    pub next_revision: String,
    pub programs: Vec<StudioMathTexTransformEditInput>,
    pub source_runtime_bindings: Vec<StudioMathTexTransformSourceBinding>,
    pub studio_entities: Vec<StudioMathTexTransformEntityIdentity>,
    pub viewport: StudioAuthoringSize,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioMathTexTransformEditError {
    #[error(
        "the normalized Studio Programs do not authorize one static MathTex transform chain with an optional final motion"
    )]
    Unsupported,
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the MathTex transform must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the authored MathTex transform Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

fn studio_math_tex_transform_edit_input_is_closed(
    program: &StudioMathTexTransformEditInput,
) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| SceneEditOperationFacts {
            depends_on: operation.depends_on(),
            id: operation.id(),
        })
        .collect::<Vec<_>>();
    let identity_edges = program
        .operations
        .windows(2)
        .map(|operations| (operations[0].id(), operations[1].id()))
        .collect::<Vec<_>>();
    program.intent_count == program.operations.len()
        && (1..=3).contains(&program.operations.len())
        && program.requested_execution == SceneEditExecution::Sequence
        && program
            .operations
            .iter()
            .all(|operation| operation.origin() == program.origin)
        && program.schedule_order
            == program
                .operations
                .iter()
                .map(|operation| operation.id().to_owned())
                .collect::<Vec<_>>()
        && scene_edit_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &identity_edges,
        )
}

#[allow(
    clippy::too_many_lines,
    reason = "one small closed planner keeps projection and mutation admission identical"
)]
fn plan_studio_math_tex_transform_edits(
    base_duration: f64,
    programs: &[StudioMathTexTransformEditInput],
    existing_entity_ids: &BTreeSet<&str>,
) -> Result<StudioMathTexTransformPlan, ApplyStudioMathTexTransformEditError> {
    let operation_count = programs
        .iter()
        .map(|program| program.operations.len())
        .sum::<usize>();
    let transform_count = programs
        .iter()
        .flat_map(|program| &program.operations)
        .filter(|operation| {
            matches!(
                operation,
                StudioMathTexTransformOperation::TransformContent { .. }
            )
        })
        .count();
    let motion_count = programs
        .iter()
        .flat_map(|program| &program.operations)
        .filter(|operation| {
            matches!(
                operation,
                StudioMathTexTransformOperation::CreateMotion { .. }
            )
        })
        .count();
    if !base_duration.is_finite()
        || base_duration <= 0.0
        || !(1..=2).contains(&transform_count)
        || motion_count > 1
        || operation_count != transform_count + motion_count
    {
        return Err(ApplyStudioMathTexTransformEditError::Unsupported);
    }

    let mut ordered_programs = (0..programs.len()).collect::<Vec<_>>();
    ordered_programs.sort_by(|left, right| {
        programs[*left]
            .anchor_resolved_seconds
            .total_cmp(&programs[*right].anchor_resolved_seconds)
            .then(left.cmp(right))
    });
    let mut operation_ids = BTreeSet::new();
    let mut target_ids = BTreeSet::new();
    let mut projection_insertions = Vec::with_capacity(programs.len());
    let mut timeline_insertions = Vec::with_capacity(programs.len());
    let mut planned = Vec::with_capacity(operation_count);
    let mut resolved_offset = 0.0;
    let mut projected_duration = base_duration;
    let mut previous_target_id: Option<String> = None;
    let mut previous_interval_end: Option<f64> = None;
    let mut initial_source_entity_id: Option<String> = None;
    let mut first_base_interval: Option<IntervalV1> = None;
    let mut maximum_base_end = 0.0_f64;
    let mut motion = None;

    for program_index in ordered_programs {
        let program = &programs[program_index];
        if !program.lowering_supported
            || program.transaction_id.is_empty()
            || !scene_edit_anchor_is_closed(
                &program.anchor_source,
                program.anchor_captured_playhead,
                program.anchor_resolved_seconds,
                base_duration,
            )
            || !studio_math_tex_transform_edit_input_is_closed(program)
            || !studio_timeline_semantic_values_match(
                program
                    .operations
                    .first()
                    .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?
                    .interval()
                    .start,
                program.anchor_resolved_seconds,
            )
        {
            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
        }
        let maximum_end = program
            .operations
            .iter()
            .map(|operation| operation.interval().end)
            .fold(program.anchor_resolved_seconds, f64::max);
        let insertion_duration = maximum_end - program.anchor_resolved_seconds;
        let resolved_anchor = program.anchor_resolved_seconds + resolved_offset;
        if !insertion_duration.is_finite()
            || insertion_duration <= 0.0
            || !resolved_anchor.is_finite()
            || resolved_anchor > projected_duration + TIMELINE_ANCHOR_EPSILON
        {
            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
        }

        for operation in &program.operations {
            let id = operation.id();
            let interval = operation.interval();
            if id.is_empty()
                || !operation_ids.insert(id)
                || !interval.start.is_finite()
                || !interval.end.is_finite()
                || interval.start < 0.0
                || interval.start >= interval.end
                || interval.end > base_duration
            {
                return Err(ApplyStudioMathTexTransformEditError::Unsupported);
            }
            let resolved_interval = IntervalV1 {
                end: interval.end + resolved_offset,
                start: interval.start + resolved_offset,
            };
            if previous_interval_end.is_some_and(|end| resolved_interval.start < end) {
                return Err(ApplyStudioMathTexTransformEditError::Unsupported);
            }

            match operation {
                StudioMathTexTransformOperation::TransformContent {
                    replacement,
                    source_entity_id,
                    strategy,
                    target_entity_id,
                    target_type,
                    ..
                } => {
                    if motion.is_some()
                        || source_entity_id.is_empty()
                        || target_entity_id.is_empty()
                        || source_entity_id == target_entity_id
                        || *strategy != StudioMathTexTransformStrategy::TransformMatchingTex
                        || target_type.as_deref().is_some_and(|kind| kind != "MathTex")
                        || !studio_math_tex_content_is_canonical(replacement)
                        || !target_ids.insert(target_entity_id.as_str())
                        || existing_entity_ids.contains(target_entity_id.as_str())
                    {
                        return Err(ApplyStudioMathTexTransformEditError::Unsupported);
                    }
                    maximum_base_end = maximum_base_end.max(interval.end);
                    if let Some(previous_target_id) = &previous_target_id {
                        if source_entity_id != previous_target_id {
                            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
                        }
                    } else {
                        initial_source_entity_id = Some(source_entity_id.clone());
                        first_base_interval = Some(interval.clone());
                    }
                    previous_target_id = Some(target_entity_id.clone());
                    planned.push(PlannedMathTexTransform {
                        content: replacement.clone(),
                        interval: resolved_interval.clone(),
                        operation_id: id.to_owned(),
                        studio_source_entity_id: source_entity_id.clone(),
                        target_entity_id: target_entity_id.clone(),
                        transaction_id: program.transaction_id.clone(),
                    });
                }
                StudioMathTexTransformOperation::CreateMotion {
                    control_offset,
                    delta,
                    easing,
                    target_entity_ids,
                    ..
                } => {
                    let final_target_id = previous_target_id
                        .as_ref()
                        .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
                    if motion.is_some()
                        || target_entity_ids.len() != 1
                        || target_entity_ids[0] != *final_target_id
                        || !studio_authoring_point_is_finite(control_offset)
                        || !studio_authoring_point_is_finite(delta)
                        || (control_offset.x == 0.0
                            && control_offset.y == 0.0
                            && delta.x == 0.0
                            && delta.y == 0.0)
                    {
                        return Err(ApplyStudioMathTexTransformEditError::Unsupported);
                    }
                    motion = Some(PlannedMathTexTransformMotion {
                        control_offset: control_offset.clone(),
                        delta: delta.clone(),
                        easing: *easing,
                        interval: resolved_interval.clone(),
                        operation_id: id.to_owned(),
                        source_interval: interval.clone(),
                        target_entity_id: final_target_id.clone(),
                        transaction_id: program.transaction_id.clone(),
                    });
                }
                StudioMathTexTransformOperation::Unsupported { .. } => {
                    return Err(ApplyStudioMathTexTransformEditError::Unsupported);
                }
            }
            previous_interval_end = Some(resolved_interval.end);
        }

        projection_insertions.push(StudioMotionProjectionInsertion {
            at: resolved_anchor,
            duration: insertion_duration,
            transaction_id: program.transaction_id.clone(),
        });
        timeline_insertions.push(SceneTimelineInsertion {
            at: resolved_anchor,
            duration: insertion_duration,
        });
        resolved_offset += insertion_duration;
        projected_duration += insertion_duration;
    }

    Ok(StudioMathTexTransformPlan {
        first_base_interval: first_base_interval
            .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?,
        initial_source_entity_id: initial_source_entity_id
            .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?,
        maximum_base_end,
        motion,
        planned,
        projection_insertions,
        projected_duration,
        timeline_insertions,
    })
}

fn studio_math_tex_transform_projection_from_plan(
    plan: &StudioMathTexTransformPlan,
    inherited_end: f64,
    source_position: Option<&PointV1>,
) -> Result<StudioMathTexTransformProjection, ApplyStudioMathTexTransformEditError> {
    let replacements = plan
        .planned
        .iter()
        .enumerate()
        .map(
            |(index, transform)| StudioMathTexTransformProjectedReplacement {
                content: transform.content.clone(),
                interval: transform.interval.clone(),
                operation_id: transform.operation_id.clone(),
                source_entity_id: transform.studio_source_entity_id.clone(),
                target_entity_id: transform.target_entity_id.clone(),
                target_lifetime: IntervalV1 {
                    end: plan
                        .planned
                        .get(index + 1)
                        .map_or(inherited_end, |next| next.interval.end),
                    start: transform.interval.start,
                },
                target_type: StudioAuthoringEntityKind::MathTex,
                transaction_id: transform.transaction_id.clone(),
            },
        )
        .collect();
    let motions = plan
        .motion
        .as_ref()
        .map(|motion| {
            let from = source_position
                .filter(|position| studio_authoring_point_is_finite(position))
                .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
            if motion.interval.end > inherited_end {
                return Err(ApplyStudioMathTexTransformEditError::Unsupported);
            }
            let to = PointV1 {
                x: from.x + motion.delta.x,
                y: from.y + motion.delta.y,
            };
            let control = PointV1 {
                x: from.x + motion.delta.x / 2.0 + motion.control_offset.x,
                y: from.y + motion.delta.y / 2.0 + motion.control_offset.y,
            };
            if !studio_authoring_point_is_finite(&to) || !studio_authoring_point_is_finite(&control)
            {
                return Err(ApplyStudioMathTexTransformEditError::Unsupported);
            }
            Ok(StudioProjectedMotion {
                control,
                control_offset: motion.control_offset.clone(),
                delta: motion.delta.clone(),
                easing: projected_motion_easing(motion.easing),
                from: from.clone(),
                interval: motion.interval.clone(),
                operation_id: motion.operation_id.clone(),
                source_interval: motion.source_interval.clone(),
                target_entity_id: motion.target_entity_id.clone(),
                to,
                transaction_id: motion.transaction_id.clone(),
            })
        })
        .transpose()?
        .into_iter()
        .collect();
    Ok(StudioMathTexTransformProjection {
        insertions: plan.projection_insertions.clone(),
        motions,
        projected_duration: plan.projected_duration,
        replacements,
    })
}

/// Projects one or two `MathTex` replacements and an optional final-target motion without a snapshot.
///
/// # Errors
///
/// Returns `Unsupported` when the edits, logical source, target identities, or lifetime do not
/// satisfy the same semantic planner used by Scene mutation.
pub fn project_studio_math_tex_transform_edits(
    base_duration: f64,
    programs: &[StudioMathTexTransformEditInput],
    studio_entities: &[StudioMathTexTransformProjectionEntityIdentity],
) -> Result<StudioMathTexTransformProjection, ApplyStudioMathTexTransformEditError> {
    let existing_entity_ids = studio_entities
        .iter()
        .map(|entity| entity.object_graph_key.as_str())
        .collect::<BTreeSet<_>>();
    let plan = plan_studio_math_tex_transform_edits(base_duration, programs, &existing_entity_ids)?;
    let mut matching_sources = studio_entities
        .iter()
        .filter(|entity| entity.object_graph_key == plan.initial_source_entity_id);
    let source = matching_sources
        .next()
        .filter(|entity| {
            studio_math_tex_transform_identity_is_closed(
                entity.provisional,
                entity.entity_type,
                entity.scale,
                entity.source_identity.as_deref(),
            )
        })
        .filter(|_| matching_sources.next().is_none())
        .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
    let source_lifetime = source
        .lifetime
        .first()
        .filter(|_| source.lifetime.len() == 1)
        .filter(|lifetime| {
            lifetime.start.is_finite()
                && lifetime.end.is_finite()
                && lifetime.start <= plan.first_base_interval.start
                && lifetime.end >= plan.maximum_base_end
                && lifetime.start < lifetime.end
        })
        .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
    let mut projected_source_lifetime = source_lifetime.clone();
    for insertion in &plan.timeline_insertions {
        shift_interval_for_insertion(&mut projected_source_lifetime, insertion);
    }
    studio_math_tex_transform_projection_from_plan(
        &plan,
        projected_source_lifetime.end,
        source.position.as_ref(),
    )
}

fn math_tex_fade_out_keyframes(interval: &IntervalV1) -> Vec<KeyframeV1<f64>> {
    vec![
        KeyframeV1 {
            at: interval.start,
            easing_to_next: Some(EasingV1::ManimSmooth {}),
            value: 1.0,
        },
        KeyframeV1 {
            at: interval.end,
            easing_to_next: None,
            value: 0.0,
        },
    ]
}

fn math_tex_replacement_keyframes(
    fade_in: &IntervalV1,
    fade_out: Option<&IntervalV1>,
) -> Vec<KeyframeV1<f64>> {
    let mut keyframes = vec![
        KeyframeV1 {
            at: fade_in.start,
            easing_to_next: Some(EasingV1::ManimSmooth {}),
            value: 0.0,
        },
        KeyframeV1 {
            at: fade_in.end,
            easing_to_next: None,
            value: 1.0,
        },
    ];
    if let Some(fade_out) = fade_out {
        let visible = keyframes
            .last_mut()
            .expect("MathTex replacement has a fade-in endpoint");
        if fade_out.start > visible.at + TIMELINE_ANCHOR_EPSILON {
            visible.easing_to_next = Some(EasingV1::Linear {});
            keyframes.push(KeyframeV1 {
                at: fade_out.start,
                easing_to_next: Some(EasingV1::ManimSmooth {}),
                value: 1.0,
            });
        } else {
            visible.at = fade_out.start;
            visible.easing_to_next = Some(EasingV1::ManimSmooth {});
        }
        keyframes.push(KeyframeV1 {
            at: fade_out.end,
            easing_to_next: None,
            value: 0.0,
        });
    }
    keyframes
}

impl EngineSessionV1 {
    /// Applies one or two imported `MathTex` replacements and an optional final-target motion.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` outside the closed matching-`MathTex` plus final-motion subset. Every
    /// failure preserves the installed Scene.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact normalized scale and one contiguous plan-before-commit path define the closed authoring contract"
    )]
    pub fn apply_studio_math_tex_transform_edit(
        &mut self,
        command: ApplyStudioMathTexTransformEditCommand,
    ) -> Result<StudioAuthoringEditResult, ApplyStudioMathTexTransformEditError> {
        let ApplyStudioMathTexTransformEditCommand {
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
            return Err(ApplyStudioMathTexTransformEditError::StaleBaseRevision);
        }
        if next_revision == expected_base_revision {
            return Err(ApplyStudioMathTexTransformEditError::RevisionDidNotAdvance);
        }
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !scene.animation_channels.is_empty()
            || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || scene
                .provenance
                .iter()
                .any(|record| record.id == format!("studio-math-tex-transform:{next_revision}"))
        {
            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
        }

        let existing_entity_ids = scene
            .entities
            .iter()
            .map(|entity| entity.id.as_str())
            .collect::<BTreeSet<_>>();
        let plan =
            plan_studio_math_tex_transform_edits(scene.duration, &programs, &existing_entity_ids)?;
        if math_tex_outlines.len() != plan.planned.len() {
            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
        }
        let (runtime_entity_id, source_position) = resolve_imported_math_tex_transform_source(
            &plan.initial_source_entity_id,
            &studio_entities,
            &source_runtime_bindings,
        )
        .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
        let source_index = scene
            .entities
            .iter()
            .position(|entity| entity.id == runtime_entity_id)
            .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
        let source = &scene.entities[source_index];
        let source_lifetime = source
            .lifetimes
            .first()
            .filter(|_| source.lifetimes.len() == 1)
            .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
        if source.parent_id.is_some()
            || !matches!(source.geometry, SceneGeometryV1::CubicPath { .. })
            || !matches!(
                &source.appearance,
                SceneAppearanceV1::Vector {
                    fill: Some(_),
                    opacity,
                    stroke: None,
                } if *opacity == 1.0
            )
            || source_lifetime.start > plan.first_base_interval.start
            || source_lifetime.end < plan.maximum_base_end
        {
            return Err(ApplyStudioMathTexTransformEditError::Unsupported);
        }

        let provenance_id = format!("studio-math-tex-transform:{next_revision}");
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        for insertion in &plan.timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        let inherited_end = candidate.scene.entities[source_index].lifetimes[0].end;
        let first_interval = &plan
            .planned
            .first()
            .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?
            .interval;
        candidate.scene.entities[source_index].lifetimes[0].end = first_interval.end;
        provenance_id.clone_into(&mut candidate.scene.entities[source_index].provenance_id);
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec![],
            id: provenance_id.clone(),
            origin: ProvenanceOriginV1::StudioEditProgram,
        });
        if matches!(candidate.scene.fidelity, FidelityV1::Exact {}) {
            candidate.scene.fidelity = FidelityV1::Approximate {
                evidence: vec![
                    "Studio MathTex transforms use browser-compiled replacement outlines."
                        .to_owned(),
                ],
            };
        }

        let template = source.clone();
        let first_scene_order = candidate
            .scene
            .entities
            .iter()
            .map(|entity| entity.scene_order)
            .max()
            .map_or(0, |maximum| maximum + 1);
        let projection = studio_math_tex_transform_projection_from_plan(
            &plan,
            inherited_end,
            source_position.as_ref(),
        )?;
        for (index, transform) in plan.planned.iter().enumerate() {
            let mut matching_outlines = math_tex_outlines.iter().filter(|outline| {
                outline.entity_id == transform.target_entity_id
                    && outline.tex_parts == transform.content.tex_parts
            });
            let outline = matching_outlines
                .next()
                .filter(|_| matching_outlines.next().is_none())
                .ok_or(ApplyStudioMathTexTransformEditError::Unsupported)?;
            let target_lifetime = projection.replacements[index].target_lifetime.clone();
            candidate.scene.entities.push(SceneEntityV1 {
                appearance: template.appearance.clone(),
                geometry: SceneGeometryV1::CubicPath {
                    path: outline.path.clone(),
                },
                id: transform.target_entity_id.clone(),
                lifetimes: vec![target_lifetime.clone()],
                parent_id: None,
                provenance_id: provenance_id.clone(),
                scene_order: first_scene_order + u32::try_from(index).unwrap_or(u32::MAX),
                source_z_index: template.source_z_index,
                transform: template.transform.clone(),
            });
        }

        let source_channel_id = unused_channel_id(&candidate.scene, "studio-math-tex-source");
        candidate
            .scene
            .animation_channels
            .push(AnimationChannelV1::Opacity {
                entity_id: runtime_entity_id,
                id: source_channel_id,
                keyframes: math_tex_fade_out_keyframes(&plan.planned[0].interval),
                provenance_id: provenance_id.clone(),
            });
        for (index, transform) in plan.planned.iter().enumerate() {
            let channel_id =
                unused_channel_id(&candidate.scene, &format!("studio-math-tex-target-{index}"));
            candidate
                .scene
                .animation_channels
                .push(AnimationChannelV1::Opacity {
                    entity_id: transform.target_entity_id.clone(),
                    id: channel_id,
                    keyframes: math_tex_replacement_keyframes(
                        &transform.interval,
                        plan.planned.get(index + 1).map(|next| &next.interval),
                    ),
                    provenance_id: provenance_id.clone(),
                });
        }
        if let Some(motion) = &plan.motion {
            append_planned_scene_motions(
                &mut candidate.scene,
                &[PlannedSceneMotion {
                    control_offset: studio_vector_to_scene_vector(
                        &motion.control_offset,
                        frame,
                        viewport,
                    ),
                    delta: studio_vector_to_scene_vector(&motion.delta, frame, viewport),
                    easing: motion.easing,
                    interval: motion.interval.clone(),
                    target_entity_ids: vec![motion.target_entity_id.clone()],
                }],
                &provenance_id,
            )
            .map_err(|_| ApplyStudioMathTexTransformEditError::Unsupported)?;
        }
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::CubicPathGeometry);
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };

        let result = StudioAuthoringEditResult {
            bundle: candidate.clone(),
            creation_projection: None,
            math_tex_transform_projection: Some(projection),
            motion_projection: None,
            persistent_remove_projection: StudioPersistentRemoveProjection::default(),
            static_root_projection: None,
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use poietra_scene_ir::CubicPathV1;

    use super::super::tests::{
        BASE_REVISION, NEXT_REVISION, fixture_bundle, static_imported_bundle,
    };
    use super::super::{StudioProjectionEasing, studio_math_tex_appearance};
    use super::*;

    pub(in super::super) fn math_tex_fixture_path(name: &str) -> CubicPathV1 {
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle(name).scene.entities.remove(0).geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        path
    }

    pub(in super::super) fn static_imported_math_tex_bundle() -> SceneIrBundleV1 {
        let mut bundle = static_imported_bundle();
        let duration = bundle.scene.duration;
        let source = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        source.appearance = studio_math_tex_appearance();
        source.geometry = SceneGeometryV1::CubicPath {
            path: math_tex_fixture_path("mathtex-nested-radical-fraction.json"),
        };
        source.lifetimes = vec![IntervalV1 {
            end: duration,
            start: 0.0,
        }];
        bundle
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::CubicPathGeometry);
        bundle.scene.required_capabilities.sort();
        bundle.scene.required_capabilities.dedup();
        bundle
    }

    fn math_tex_transform_operation(
        id: &str,
        source_entity_id: &str,
        target_entity_id: &str,
        interval: IntervalV1,
        depends_on: Vec<String>,
        replacement: StudioMathTexContent,
    ) -> StudioMathTexTransformOperation {
        StudioMathTexTransformOperation::TransformContent {
            depends_on,
            id: id.to_owned(),
            interval,
            origin: StudioAuthoringOrigin::RemoteModel,
            replacement,
            source_entity_id: source_entity_id.to_owned(),
            strategy: StudioMathTexTransformStrategy::TransformMatchingTex,
            target_entity_id: target_entity_id.to_owned(),
            target_type: None,
        }
    }

    fn math_tex_transform_motion_operation(
        id: &str,
        target_entity_id: &str,
        interval: IntervalV1,
        depends_on: Vec<String>,
    ) -> StudioMathTexTransformOperation {
        StudioMathTexTransformOperation::CreateMotion {
            control_offset: PointV1 { x: 0.0, y: -160.0 },
            delta: PointV1 { x: 160.0, y: 0.0 },
            depends_on,
            easing: StudioMotionEasing::Smooth,
            id: id.to_owned(),
            interval,
            origin: StudioAuthoringOrigin::RemoteModel,
            target_entity_ids: vec![target_entity_id.to_owned()],
        }
    }

    fn math_tex_transform_edit_input(
        transaction_id: &str,
        anchor: f64,
        operations: Vec<StudioMathTexTransformOperation>,
    ) -> StudioMathTexTransformEditInput {
        let operation_ids = operations
            .iter()
            .map(|operation| operation.id().to_owned())
            .collect::<Vec<_>>();
        let schedule_edge_count = operations
            .iter()
            .map(|operation| operation.depends_on().len())
            .sum::<usize>()
            + operations.len().saturating_sub(1);
        StudioMathTexTransformEditInput {
            anchor_captured_playhead: anchor,
            anchor_resolved_seconds: anchor,
            anchor_source: SceneEditAnchorSource::Playhead {
                reference_seconds: Some(anchor),
            },
            intent_count: operations.len(),
            lowering_supported: true,
            operations,
            origin: StudioAuthoringOrigin::RemoteModel,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: operation_ids,
            transaction_id: transaction_id.to_owned(),
        }
    }

    fn math_tex_transform_command() -> ApplyStudioMathTexTransformEditCommand {
        let first_target = "tx:math-tex-transform/entity:b";
        let second_target = "tx:math-tex-transform/entity:a-prime";
        let first_content = StudioMathTexContent {
            display_lines: vec!["B".to_owned()],
            label: Some("middle".to_owned()),
            tex_parts: vec!["B".to_owned()],
        };
        let second_content = StudioMathTexContent {
            display_lines: vec!["A".to_owned()],
            label: Some("restored".to_owned()),
            tex_parts: vec!["A".to_owned()],
        };
        ApplyStudioMathTexTransformEditCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            frame: StudioAuthoringSize {
                height: 9.0,
                width: 16.0,
            },
            math_tex_outlines: vec![
                StudioMathTexTransformOutline {
                    entity_id: first_target.to_owned(),
                    path: math_tex_fixture_path("real-mathtex-morph-v5.json"),
                    tex_parts: first_content.tex_parts.clone(),
                },
                StudioMathTexTransformOutline {
                    entity_id: second_target.to_owned(),
                    path: math_tex_fixture_path("mathtex-nested-radical-fraction.json"),
                    tex_parts: second_content.tex_parts.clone(),
                },
            ],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![math_tex_transform_edit_input(
                "math-tex-transform",
                0.25,
                vec![
                    math_tex_transform_operation(
                        "transform-a-b",
                        "source:formula",
                        first_target,
                        IntervalV1 {
                            end: 0.75,
                            start: 0.25,
                        },
                        vec![],
                        first_content,
                    ),
                    math_tex_transform_operation(
                        "transform-b-a",
                        first_target,
                        second_target,
                        IntervalV1 {
                            end: 1.25,
                            start: 1.0,
                        },
                        vec!["transform-a-b".to_owned()],
                        second_content,
                    ),
                ],
            )],
            source_runtime_bindings: vec![StudioMathTexTransformSourceBinding {
                runtime_entity_id: "later".to_owned(),
                source_identity_key: "formula".to_owned(),
                source_name: "formula".to_owned(),
            }],
            studio_entities: vec![StudioMathTexTransformEntityIdentity {
                entity_type: StudioAuthoringEntityKind::MathTex,
                object_graph_key: "source:formula".to_owned(),
                position: Some(PointV1 { x: 800.0, y: 450.0 }),
                provisional: false,
                scale: Some(1.0),
                source_identity: Some("formula".to_owned()),
            }],
            viewport: StudioAuthoringSize {
                height: 900.0,
                width: 1600.0,
            },
        }
    }

    fn math_tex_transform_projection_entities(
        duration: f64,
    ) -> Vec<StudioMathTexTransformProjectionEntityIdentity> {
        vec![StudioMathTexTransformProjectionEntityIdentity {
            entity_type: StudioAuthoringEntityKind::MathTex,
            lifetime: vec![IntervalV1 {
                end: duration,
                start: 0.0,
            }],
            object_graph_key: "source:formula".to_owned(),
            position: Some(PointV1 { x: 800.0, y: 450.0 }),
            provisional: false,
            scale: Some(1.0),
            source_identity: Some("formula".to_owned()),
        }]
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized projection stores exact timeline values"
    )]
    fn math_tex_transform_projector_authorizes_one_and_two_step_chains() {
        let command = math_tex_transform_command();
        let duration = static_imported_math_tex_bundle().scene.duration;
        let entities = math_tex_transform_projection_entities(duration);

        let two_step =
            project_studio_math_tex_transform_edits(duration, &command.programs, &entities)
                .unwrap();
        assert_eq!(two_step.projected_duration, duration + 1.0);
        assert_eq!(two_step.replacements.len(), 2);
        assert_eq!(two_step.replacements[0].target_lifetime.end, 1.25);
        assert_eq!(two_step.replacements[1].target_lifetime.end, duration + 1.0);

        let mut one_step_program = command.programs[0].clone();
        one_step_program.intent_count = 1;
        one_step_program.operations.truncate(1);
        one_step_program.schedule_edge_count = 0;
        one_step_program.schedule_order.truncate(1);
        let one_step =
            project_studio_math_tex_transform_edits(duration, &[one_step_program], &entities)
                .unwrap();
        assert_eq!(one_step.projected_duration, duration + 0.5);
        assert_eq!(one_step.replacements.len(), 1);
        assert_eq!(one_step.replacements[0].target_lifetime.end, duration + 0.5);
        assert!(one_step.motions.is_empty());
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized motion projection stores exact presentation and timeline values"
    )]
    fn math_tex_transform_projector_and_apply_authorize_final_replacement_motion() {
        let mut command = math_tex_transform_command();
        let mut operations = command.programs.remove(0).operations;
        operations.push(math_tex_transform_motion_operation(
            "move-restored",
            "tx:math-tex-transform/entity:a-prime",
            IntervalV1 {
                end: 1.75,
                start: 1.5,
            },
            vec!["transform-b-a".to_owned()],
        ));
        command.programs = vec![math_tex_transform_edit_input(
            "math-tex-transform",
            0.25,
            operations,
        )];
        let duration = static_imported_math_tex_bundle().scene.duration;
        let projection = project_studio_math_tex_transform_edits(
            duration,
            &command.programs,
            &math_tex_transform_projection_entities(duration),
        )
        .unwrap();

        assert_eq!(projection.projected_duration, 3.5);
        assert_eq!(projection.insertions.len(), 1);
        assert_eq!(projection.motions.len(), 1);
        assert_eq!(
            projection.motions[0],
            StudioProjectedMotion {
                control: PointV1 { x: 880.0, y: 290.0 },
                control_offset: PointV1 { x: 0.0, y: -160.0 },
                delta: PointV1 { x: 160.0, y: 0.0 },
                easing: StudioProjectionEasing::ManimSmooth,
                from: PointV1 { x: 800.0, y: 450.0 },
                interval: IntervalV1 {
                    end: 1.75,
                    start: 1.5,
                },
                operation_id: "move-restored".to_owned(),
                source_interval: IntervalV1 {
                    end: 1.75,
                    start: 1.5,
                },
                target_entity_id: "tx:math-tex-transform/entity:a-prime".to_owned(),
                to: PointV1 { x: 960.0, y: 450.0 },
                transaction_id: "math-tex-transform".to_owned(),
            }
        );

        let mut session = EngineSessionV1::new(static_imported_math_tex_bundle()).unwrap();
        let result = session
            .apply_studio_math_tex_transform_edit(command)
            .unwrap();
        assert_eq!(result.math_tex_transform_projection.unwrap(), projection);
        assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::MotionPath { entity_id, keyframes, .. }
                            if entity_id == "tx:math-tex-transform/entity:a-prime"
                                && keyframes.first().is_some_and(|keyframe| keyframe.at == 1.5)
                                && keyframes.last().is_some_and(|keyframe| keyframe.at == 1.75)
                    )
                })
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized later-program projection stores exact timeline values"
    )]
    fn math_tex_transform_projector_rebases_a_later_motion_edit() {
        let command = math_tex_transform_command();
        let programs = vec![
            command.programs[0].clone(),
            math_tex_transform_edit_input(
                "move-restored",
                1.5,
                vec![math_tex_transform_motion_operation(
                    "move-restored",
                    "tx:math-tex-transform/entity:a-prime",
                    IntervalV1 {
                        end: 1.75,
                        start: 1.5,
                    },
                    vec![],
                )],
            ),
        ];
        let duration = static_imported_math_tex_bundle().scene.duration;

        let projection = project_studio_math_tex_transform_edits(
            duration,
            &programs,
            &math_tex_transform_projection_entities(duration),
        )
        .unwrap();

        assert_eq!(projection.insertions.len(), 2);
        assert_eq!(projection.projected_duration, 3.25);
        assert_eq!(
            projection.motions[0].interval,
            IntervalV1 {
                end: 2.75,
                start: 2.5,
            }
        );
    }

    #[test]
    fn math_tex_transform_projector_rejects_motion_outside_the_closed_suffix() {
        let command = math_tex_transform_command();
        let transform = command.programs[0].operations[0].clone();
        let target = "tx:math-tex-transform/entity:b";
        let motion = math_tex_transform_motion_operation(
            "move-b",
            target,
            IntervalV1 {
                end: 1.25,
                start: 0.75,
            },
            vec!["transform-a-b".to_owned()],
        );
        let mut reverse_motion = motion.clone();
        let StudioMathTexTransformOperation::CreateMotion { depends_on, .. } = &mut reverse_motion
        else {
            unreachable!();
        };
        depends_on.clear();
        let reverse =
            math_tex_transform_edit_input("reverse", 0.25, vec![reverse_motion, transform.clone()]);

        let mut parallel = math_tex_transform_edit_input(
            "parallel",
            0.25,
            vec![transform.clone(), motion.clone()],
        );
        parallel.requested_execution = SceneEditExecution::Parallel;

        let mut wrong_target = motion.clone();
        let StudioMathTexTransformOperation::CreateMotion {
            target_entity_ids, ..
        } = &mut wrong_target
        else {
            unreachable!();
        };
        target_entity_ids[0] = "source:formula".to_owned();

        let second_motion = math_tex_transform_motion_operation(
            "move-b-again",
            target,
            IntervalV1 {
                end: 1.75,
                start: 1.25,
            },
            vec!["move-b".to_owned()],
        );
        let duration = static_imported_math_tex_bundle().scene.duration;
        let entities = math_tex_transform_projection_entities(duration);
        for programs in [
            vec![reverse],
            vec![parallel],
            vec![math_tex_transform_edit_input(
                "wrong-target",
                0.25,
                vec![transform.clone(), wrong_target],
            )],
            vec![math_tex_transform_edit_input(
                "multiple-motion",
                0.25,
                vec![transform.clone(), motion, second_motion],
            )],
        ] {
            assert!(matches!(
                project_studio_math_tex_transform_edits(duration, &programs, &entities),
                Err(ApplyStudioMathTexTransformEditError::Unsupported)
            ));
        }
    }

    #[test]
    fn math_tex_transform_projector_rejects_invalid_logical_batches() {
        let command = math_tex_transform_command();
        let duration = static_imported_math_tex_bundle().scene.duration;
        let entities = math_tex_transform_projection_entities(duration);

        let missing_source = Vec::new();

        let mut wrong_type = entities.clone();
        wrong_type[0].entity_type = StudioAuthoringEntityKind::Rectangle;

        let mut existing_target = entities.clone();
        existing_target.push(StudioMathTexTransformProjectionEntityIdentity {
            entity_type: StudioAuthoringEntityKind::Other,
            lifetime: vec![],
            object_graph_key: "tx:math-tex-transform/entity:b".to_owned(),
            position: None,
            provisional: false,
            scale: None,
            source_identity: None,
        });

        let mut wrong_strategy = command.programs.clone();
        let StudioMathTexTransformOperation::TransformContent { strategy, .. } =
            &mut wrong_strategy[0].operations[0]
        else {
            unreachable!();
        };
        *strategy = StudioMathTexTransformStrategy::ReplacementTransform;

        let mut broken_chain = command.programs.clone();
        let StudioMathTexTransformOperation::TransformContent {
            source_entity_id, ..
        } = &mut broken_chain[0].operations[1]
        else {
            unreachable!();
        };
        *source_entity_id = "source:formula".to_owned();

        let mut invalid_interval = command.programs.clone();
        let StudioMathTexTransformOperation::TransformContent { interval, .. } =
            &mut invalid_interval[0].operations[0]
        else {
            unreachable!();
        };
        interval.end = interval.start;

        for (programs, candidate_entities) in [
            (command.programs.clone(), missing_source),
            (command.programs.clone(), wrong_type),
            (command.programs.clone(), existing_target),
            (wrong_strategy, entities.clone()),
            (broken_chain, entities.clone()),
            (invalid_interval, entities.clone()),
        ] {
            assert!(matches!(
                project_studio_math_tex_transform_edits(duration, &programs, &candidate_entities,),
                Err(ApplyStudioMathTexTransformEditError::Unsupported)
            ));
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized command and projection store exact working timeline values"
    )]
    fn math_tex_transform_returns_one_correlated_replacement_projection() {
        let mut command = math_tex_transform_command();
        command.math_tex_outlines.truncate(1);
        command.programs[0].intent_count = 1;
        command.programs[0].operations.truncate(1);
        command.programs[0].schedule_edge_count = 0;
        command.programs[0].schedule_order.truncate(1);
        let mut session = EngineSessionV1::new(static_imported_math_tex_bundle()).unwrap();

        let result = session
            .apply_studio_math_tex_transform_edit(command)
            .unwrap();

        assert_eq!(result.bundle.scene.duration, 2.5);
        assert!(result.persistent_remove_projection.removals.is_empty());
        assert!(result.static_root_projection.is_none());
        let projection = result.math_tex_transform_projection.unwrap();
        assert_eq!(projection.projected_duration, 2.5);
        assert_eq!(
            projection.insertions,
            vec![StudioMotionProjectionInsertion {
                at: 0.25,
                duration: 0.5,
                transaction_id: "math-tex-transform".to_owned(),
            }]
        );
        assert_eq!(projection.replacements.len(), 1);
        assert_eq!(
            projection.replacements[0],
            StudioMathTexTransformProjectedReplacement {
                content: StudioMathTexContent {
                    display_lines: vec!["B".to_owned()],
                    label: Some("middle".to_owned()),
                    tex_parts: vec!["B".to_owned()],
                },
                interval: IntervalV1 {
                    start: 0.25,
                    end: 0.75,
                },
                operation_id: "transform-a-b".to_owned(),
                source_entity_id: "source:formula".to_owned(),
                target_entity_id: "tx:math-tex-transform/entity:b".to_owned(),
                target_lifetime: IntervalV1 {
                    start: 0.25,
                    end: 2.5,
                },
                target_type: StudioAuthoringEntityKind::MathTex,
                transaction_id: "math-tex-transform".to_owned(),
            }
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the normalized authoring command stores exact timeline values; one test covers the complete two-step result"
    )]
    fn math_tex_transform_applies_two_step_replacement_with_one_channel_per_identity() {
        let bundle = static_imported_math_tex_bundle();
        let command = math_tex_transform_command();
        assert!(studio_math_tex_transform_edit_input_is_closed(
            &command.programs[0]
        ));
        let SceneGeometryV1::CubicPath { path: source_path } = &bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .geometry
        else {
            unreachable!();
        };
        assert_ne!(
            source_path
                .subpaths
                .iter()
                .map(|subpath| subpath.segments.len())
                .collect::<Vec<_>>(),
            command.math_tex_outlines[0]
                .path
                .subpaths
                .iter()
                .map(|subpath| subpath.segments.len())
                .collect::<Vec<_>>()
        );
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .apply_studio_math_tex_transform_edit(command)
            .unwrap();

        assert_eq!(result.bundle.scene.duration, 3.0);
        assert!(
            !result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(channel, AnimationChannelV1::PathMorph { .. }))
        );
        let expected_lifetimes = [
            (
                "later",
                IntervalV1 {
                    start: 0.0,
                    end: 0.75,
                },
            ),
            (
                "tx:math-tex-transform/entity:b",
                IntervalV1 {
                    start: 0.25,
                    end: 1.25,
                },
            ),
            (
                "tx:math-tex-transform/entity:a-prime",
                IntervalV1 {
                    start: 1.0,
                    end: 3.0,
                },
            ),
        ];
        for (entity_id, lifetime) in expected_lifetimes {
            let entity = result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == entity_id)
                .unwrap();
            assert_eq!(entity.lifetimes, vec![lifetime]);
            assert_eq!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .filter(|channel| channel.entity_id() == Some(entity_id))
                    .count(),
                1
            );
        }
        let middle_keyframes = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Opacity {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "tx:math-tex-transform/entity:b" => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            middle_keyframes
                .iter()
                .map(|keyframe| (keyframe.at, keyframe.value))
                .collect::<Vec<_>>(),
            vec![(0.25, 0.0), (0.75, 1.0), (1.0, 1.0), (1.25, 0.0)]
        );
        assert!(matches!(
            middle_keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        ));
        let projection = result.math_tex_transform_projection.as_ref().unwrap();
        assert_eq!(projection.projected_duration, 3.0);
        assert_eq!(projection.insertions.len(), 1);
        assert_eq!(
            projection.insertions[0].transaction_id,
            "math-tex-transform"
        );
        assert_eq!(
            (
                projection.insertions[0].at,
                projection.insertions[0].duration
            ),
            (0.25, 1.0)
        );
        assert_eq!(projection.replacements.len(), 2);
        assert_eq!(
            projection
                .replacements
                .iter()
                .map(|replacement| (
                    replacement.operation_id.as_str(),
                    replacement.source_entity_id.as_str(),
                    replacement.target_entity_id.as_str(),
                    replacement.content.label.as_deref(),
                    replacement.interval.clone(),
                    replacement.target_lifetime.clone(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "transform-a-b",
                    "source:formula",
                    "tx:math-tex-transform/entity:b",
                    Some("middle"),
                    IntervalV1 {
                        start: 0.25,
                        end: 0.75
                    },
                    IntervalV1 {
                        start: 0.25,
                        end: 1.25
                    },
                ),
                (
                    "transform-b-a",
                    "tx:math-tex-transform/entity:b",
                    "tx:math-tex-transform/entity:a-prime",
                    Some("restored"),
                    IntervalV1 {
                        start: 1.0,
                        end: 1.25
                    },
                    IntervalV1 {
                        start: 1.0,
                        end: 3.0
                    },
                ),
            ]
        );
        assert!(
            projection
                .replacements
                .iter()
                .all(
                    |replacement| replacement.target_type == StudioAuthoringEntityKind::MathTex
                        && replacement.transaction_id == "math-tex-transform"
                )
        );

        let sample_opacity = |entity_id: &str, time: f64| {
            session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "math-tex-transform-sample",
                    sample_time: time,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap()
                .draws
                .into_iter()
                .find(|draw| draw.entity_id() == entity_id)
                .map(|draw| draw.opacity())
        };
        assert!((sample_opacity("later", 0.5).unwrap() - 0.5).abs() < 1e-12);
        assert!(
            (sample_opacity("tx:math-tex-transform/entity:b", 0.5).unwrap() - 0.5).abs() < 1e-12
        );
        assert_eq!(
            sample_opacity("tx:math-tex-transform/entity:b", 0.875),
            Some(1.0)
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the normalized authoring command stores exact timeline values"
    )]
    fn math_tex_transform_stably_rebases_two_same_anchor_edits() {
        let bundle = static_imported_math_tex_bundle();
        let mut command = math_tex_transform_command();
        let first = command.programs[0].operations.remove(0);
        let mut second = command.programs[0].operations.remove(0);
        let StudioMathTexTransformOperation::TransformContent {
            depends_on,
            interval,
            ..
        } = &mut second
        else {
            unreachable!();
        };
        depends_on.clear();
        *interval = IntervalV1 {
            end: 0.75,
            start: 0.25,
        };
        command.programs = vec![
            math_tex_transform_edit_input("first", 0.25, vec![first]),
            math_tex_transform_edit_input("second", 0.25, vec![second]),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .apply_studio_math_tex_transform_edit(command)
            .unwrap();

        assert_eq!(result.bundle.scene.duration, 3.0);
        let middle_keyframes = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::Opacity {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "tx:math-tex-transform/entity:b" => Some(keyframes),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            middle_keyframes
                .iter()
                .map(|keyframe| (keyframe.at, keyframe.value))
                .collect::<Vec<_>>(),
            vec![(0.25, 0.0), (0.75, 1.0), (1.25, 0.0)]
        );
        assert_eq!(
            result
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "tx:math-tex-transform/entity:a-prime")
                .unwrap()
                .lifetimes[0]
                .start,
            0.75
        );
        let projection = result.math_tex_transform_projection.unwrap();
        assert_eq!(
            projection
                .insertions
                .iter()
                .map(|insertion| (
                    insertion.transaction_id.as_str(),
                    insertion.at,
                    insertion.duration,
                ))
                .collect::<Vec<_>>(),
            vec![("first", 0.25, 0.5), ("second", 0.75, 0.5)]
        );
        assert_eq!(projection.replacements[1].interval.start, 0.75);
    }

    #[test]
    fn rejected_math_tex_transform_batches_preserve_the_retained_scene() {
        let mut broken_chain = math_tex_transform_command();
        let StudioMathTexTransformOperation::TransformContent {
            source_entity_id, ..
        } = &mut broken_chain.programs[0].operations[1]
        else {
            unreachable!();
        };
        *source_entity_id = "source:formula".to_owned();

        let mut missing_outline = math_tex_transform_command();
        missing_outline.math_tex_outlines.pop();

        let mut mismatched_outline = math_tex_transform_command();
        mismatched_outline.math_tex_outlines[0].tex_parts = vec!["not B".to_owned()];

        let mut invalid_content = math_tex_transform_command();
        let StudioMathTexTransformOperation::TransformContent { replacement, .. } =
            &mut invalid_content.programs[0].operations[0]
        else {
            unreachable!();
        };
        replacement.display_lines.clear();

        let mut invalid_second = math_tex_transform_command();
        let StudioMathTexTransformOperation::TransformContent { strategy, .. } =
            &mut invalid_second.programs[0].operations[1]
        else {
            unreachable!();
        };
        *strategy = StudioMathTexTransformStrategy::ReplacementTransform;

        for command in [
            broken_chain,
            missing_outline,
            mismatched_outline,
            invalid_content,
            invalid_second,
        ] {
            let bundle = static_imported_math_tex_bundle();
            let mut session = EngineSessionV1::new(bundle).unwrap();
            let before = session.scene().clone();
            assert!(matches!(
                session.apply_studio_math_tex_transform_edit(command),
                Err(ApplyStudioMathTexTransformEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &before);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }
}
