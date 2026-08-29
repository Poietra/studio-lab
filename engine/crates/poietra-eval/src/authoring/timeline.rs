use std::collections::BTreeSet;

use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, IntervalV1, KeyframeV1, ProvenanceOriginV1,
    ProvenanceRecordV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::{Deserialize, Serialize};

use crate::{EngineSessionV1, EvaluationError};

use super::{
    SceneEditAnchorSource, SceneEditExecution, SceneEditOperationFacts, SceneEditScheduleMode,
    StudioAuthoringOrigin, TIMELINE_ANCHOR_EPSILON, scene_edit_anchor_is_closed,
    scene_edit_structure_is_closed, studio_timeline_semantic_values_match,
};

/// One insertion into an existing Scene timeline.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct SceneTimelineInsertion {
    pub(super) at: f64,
    pub(super) duration: f64,
}

/// One ordered mutation in an atomic Scene timeline edit.
#[derive(Clone, Debug, PartialEq)]
enum SceneTimelineEdit {
    InsertWait(SceneTimelineInsertion),
    TrimSceneDuration {
        at: f64,
        removed_duration: f64,
        target_duration: f64,
    },
}

/// One profile-free Studio command that atomically edits Scene time.
#[derive(Clone, Debug, PartialEq)]
struct EditSceneTimelineCommand {
    edits: Vec<SceneTimelineEdit>,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioTimelineEventKind {
    Play,
    Wait,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioTimelinePurpose {
    SceneDuration,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioTimelineOperation {
    InsertWait {
        depends_on: Vec<String>,
        event_kind: StudioTimelineEventKind,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        purpose: Option<StudioTimelinePurpose>,
    },
    TrimSceneDuration {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
    },
    Unsupported {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioTimelineOperation {
    fn depends_on(&self) -> &[String] {
        match self {
            Self::InsertWait { depends_on, .. }
            | Self::TrimSceneDuration { depends_on, .. }
            | Self::Unsupported { depends_on, .. } => depends_on,
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::InsertWait { id, .. }
            | Self::TrimSceneDuration { id, .. }
            | Self::Unsupported { id, .. } => id,
        }
    }

    fn origin(&self) -> StudioAuthoringOrigin {
        match self {
            Self::InsertWait { origin, .. }
            | Self::TrimSceneDuration { origin, .. }
            | Self::Unsupported { origin, .. } => *origin,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioTimelineEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: SceneEditAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioTimelineOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: SceneEditExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: SceneEditScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioTimelineEditCommand {
    pub expected_base_revision: String,
    pub next_revision: String,
    pub programs: Vec<StudioTimelineEditInput>,
}

/// One input edit projected into the working timeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTimelineEditProjection {
    pub operation_id: String,
    pub transaction_id: String,
    pub working_anchor: f64,
    pub working_interval: IntervalV1,
}

/// One authorized wait contribution consumed by a timeline removal.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTimelineWaitReduction {
    pub operation_id: String,
    pub removed_duration: f64,
}

/// One ordered time-axis transform produced by a normalized timeline edit.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioTimelineEditTransform {
    Insert {
        interval: IntervalV1,
        operation_id: String,
    },
    Remove {
        interval: IntervalV1,
        operation_id: String,
        wait_reductions: Vec<StudioTimelineWaitReduction>,
    },
}

/// Pure projection of normalized timeline edits from source time into working time.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTimelineProjection {
    pub program_projections: Vec<StudioTimelineEditProjection>,
    pub projected_duration: f64,
    pub transforms: Vec<StudioTimelineEditTransform>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct StudioTimelinePlan {
    edits: Vec<SceneTimelineEdit>,
    operation_ids: Vec<String>,
    pub(super) projection: StudioTimelineProjection,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioTimelineEditError {
    #[error(
        "the normalized Studio Programs do not authorize one static authorable Scene timeline edit"
    )]
    Unsupported,
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the timeline edit must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error(
        "a wait insertion must have a finite positive duration and start inside the current Scene"
    )]
    InvalidInsertion,
    #[error(
        "a trim must consume waits inserted earlier in the same command and resolve to targetDuration"
    )]
    InvalidTrim,
    #[error("the timeline edit provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the edited Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

pub(super) fn shift_interval_for_insertion(
    interval: &mut IntervalV1,
    insertion: &SceneTimelineInsertion,
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
    insertion: &SceneTimelineInsertion,
) {
    for keyframe in keyframes {
        if keyframe.at >= insertion.at - TIMELINE_ANCHOR_EPSILON {
            keyframe.at += insertion.duration;
        }
    }
}

pub(super) fn insert_scene_time(
    scene: &mut poietra_scene_ir::SceneIrV1,
    insertion: &SceneTimelineInsertion,
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
            | AnimationChannelV1::Rotation { keyframes, .. }
            | AnimationChannelV1::PathTrim { keyframes, .. }
            | AnimationChannelV1::MotionPath { keyframes, .. }
            | AnimationChannelV1::FragmentMaterialParameter { keyframes, .. }
            | AnimationChannelV1::ScenePostEffectParameter { keyframes, .. } => {
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

pub(super) fn time_after_removal(time: f64, start: f64, end: f64) -> f64 {
    if time <= start + TIMELINE_ANCHOR_EPSILON {
        time.min(start)
    } else if time >= end - TIMELINE_ANCHOR_EPSILON {
        time - (end - start)
    } else {
        start
    }
}

fn remove_scene_time(scene: &mut poietra_scene_ir::SceneIrV1, start: f64, end: f64) {
    for entity in &mut scene.entities {
        for lifetime in &mut entity.lifetimes {
            lifetime.start = time_after_removal(lifetime.start, start, end);
            lifetime.end = time_after_removal(lifetime.end, start, end);
        }
    }
    for channel in &mut scene.animation_channels {
        match channel {
            AnimationChannelV1::AffineTransform { keyframes, .. } => {
                for keyframe in keyframes {
                    keyframe.at = time_after_removal(keyframe.at, start, end);
                }
            }
            AnimationChannelV1::Opacity { keyframes, .. }
            | AnimationChannelV1::Rotation { keyframes, .. }
            | AnimationChannelV1::PathTrim { keyframes, .. }
            | AnimationChannelV1::MotionPath { keyframes, .. }
            | AnimationChannelV1::FragmentMaterialParameter { keyframes, .. }
            | AnimationChannelV1::ScenePostEffectParameter { keyframes, .. } => {
                for keyframe in keyframes {
                    keyframe.at = time_after_removal(keyframe.at, start, end);
                }
            }
            AnimationChannelV1::PathMorph { keyframes, .. } => {
                for keyframe in keyframes {
                    keyframe.at = time_after_removal(keyframe.at, start, end);
                }
            }
            AnimationChannelV1::VectorAppearance { keyframes, .. } => {
                for keyframe in keyframes {
                    keyframe.at = time_after_removal(keyframe.at, start, end);
                }
            }
            AnimationChannelV1::Camera { keyframes, .. } => {
                for keyframe in keyframes {
                    keyframe.at = time_after_removal(keyframe.at, start, end);
                }
            }
        }
    }
    scene.duration -= end - start;
}

fn studio_timeline_intervals_overlap(left: &IntervalV1, right: &IntervalV1) -> bool {
    left.start < right.end
        && left.end > right.start
        && !studio_timeline_semantic_values_match(left.start, right.end)
        && !studio_timeline_semantic_values_match(left.end, right.start)
}

fn studio_timeline_edit_input_is_closed(program: &StudioTimelineEditInput) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| SceneEditOperationFacts {
            depends_on: operation.depends_on(),
            id: operation.id(),
        })
        .collect::<Vec<_>>();
    program.intent_count == 1
        && program.operations.len() == 1
        && program.requested_execution == SceneEditExecution::Sequence
        && scene_edit_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &[],
        )
}

fn plan_wait_suffix_removal(
    inserted_waits: &mut Vec<IntervalV1>,
    at: f64,
    removed_duration: f64,
) -> Result<Vec<IntervalV1>, ApplyStudioTimelineEditError> {
    if !at.is_finite() || !removed_duration.is_finite() || removed_duration <= 0.0 {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    let mut remaining = removed_duration;
    let mut removal_cursor = inserted_waits
        .last()
        .map(|wait| wait.end)
        .ok_or(ApplyStudioTimelineEditError::InvalidTrim)?;
    if !studio_timeline_semantic_values_match(removal_cursor, at) {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    let mut removals = Vec::new();
    while !studio_timeline_semantic_values_match(remaining, 0.0) {
        let Some(wait) = inserted_waits.last() else {
            return Err(ApplyStudioTimelineEditError::InvalidTrim);
        };
        let available = wait.end - wait.start;
        if available <= 0.0 {
            inserted_waits.pop();
            continue;
        }
        if !studio_timeline_semantic_values_match(wait.end, removal_cursor) {
            return Err(ApplyStudioTimelineEditError::InvalidTrim);
        }
        let removed = available.min(remaining);
        let removal_end = wait.end;
        let removal_start = removal_end - removed;
        removals.push(IntervalV1 {
            end: removal_end,
            start: removal_start,
        });
        for wait in inserted_waits.iter_mut() {
            wait.start = time_after_removal(wait.start, removal_start, removal_end);
            wait.end = time_after_removal(wait.end, removal_start, removal_end);
        }
        inserted_waits.retain(|wait| wait.end > wait.start);
        removal_cursor = removal_start;
        remaining = (remaining - removed).max(0.0);
    }
    Ok(removals)
}

pub(super) fn validate_studio_timeline_edits(
    base_duration: f64,
    programs: &[StudioTimelineEditInput],
) -> Result<(), ApplyStudioTimelineEditError> {
    if !base_duration.is_finite() || base_duration <= 0.0 || programs.is_empty() {
        return Err(ApplyStudioTimelineEditError::Unsupported);
    }
    let mut unique_operation_ids = BTreeSet::new();
    for program in programs {
        let SceneEditAnchorSource::Absolute { seconds: Some(_) } = &program.anchor_source else {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        };
        let Some(operation) = program.operations.first() else {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        };
        if !scene_edit_anchor_is_closed(
            &program.anchor_source,
            program.anchor_captured_playhead,
            program.anchor_resolved_seconds,
            base_duration,
        ) || program.transaction_id.is_empty()
            || !program.lowering_supported
            || program.origin != StudioAuthoringOrigin::StudioDefault
            || !studio_timeline_edit_input_is_closed(program)
            || operation.origin() != StudioAuthoringOrigin::StudioDefault
            || operation.id().is_empty()
            || !unique_operation_ids.insert(operation.id())
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
    }
    Ok(())
}

fn ordered_studio_timeline_edits(programs: &[StudioTimelineEditInput]) -> Vec<(f64, usize)> {
    let mut ordered = programs
        .iter()
        .enumerate()
        .map(|(index, program)| {
            let SceneEditAnchorSource::Absolute {
                seconds: Some(source_seconds),
            } = &program.anchor_source
            else {
                unreachable!("timeline anchor was admitted above")
            };
            (*source_seconds, index)
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|(left_anchor, left_index), (right_anchor, right_index)| {
        left_anchor
            .total_cmp(right_anchor)
            .then(left_index.cmp(right_index))
    });
    ordered
}

pub(super) struct StudioTimelinePlanningState {
    edits: Vec<SceneTimelineEdit>,
    inserted_waits: Vec<IntervalV1>,
    operation_ids: Vec<String>,
    projected_duration: f64,
    resolved_offset: f64,
    transforms: Vec<StudioTimelineEditTransform>,
    wait_balances: Vec<StudioTimelineWaitBalance>,
}

struct StudioTimelineWaitBalance {
    operation_id: String,
    remaining_duration: f64,
}

impl StudioTimelinePlanningState {
    pub(super) fn new(base_duration: f64, program_count: usize) -> Self {
        Self {
            edits: Vec::with_capacity(program_count),
            inserted_waits: Vec::new(),
            operation_ids: Vec::with_capacity(program_count),
            projected_duration: base_duration,
            resolved_offset: 0.0,
            transforms: Vec::with_capacity(program_count),
            wait_balances: Vec::with_capacity(program_count),
        }
    }

    /// Adds a non-duration authoring insertion to the same time-axis state.
    ///
    /// Creation and motion Programs own their own projection records, so this
    /// insertion deliberately does not appear in the duration transform list.
    /// It still advances the shared offset and forms a barrier that a later
    /// duration trim cannot cross.
    pub(super) fn project_authoring_insertion(
        &mut self,
        at: f64,
        duration: f64,
    ) -> Result<SceneTimelineInsertion, ApplyStudioTimelineEditError> {
        let projected_duration = self.projected_duration + duration;
        let resolved_offset = self.resolved_offset + duration;
        if !at.is_finite()
            || at < 0.0
            || at > self.projected_duration + TIMELINE_ANCHOR_EPSILON
            || !duration.is_finite()
            || duration <= 0.0
            || !projected_duration.is_finite()
            || !resolved_offset.is_finite()
        {
            return Err(ApplyStudioTimelineEditError::InvalidInsertion);
        }
        self.projected_duration = projected_duration;
        self.resolved_offset = resolved_offset;
        Ok(SceneTimelineInsertion { at, duration })
    }

    pub(super) fn resolved_offset(&self) -> f64 {
        self.resolved_offset
    }

    pub(super) fn projected_duration(&self) -> f64 {
        self.projected_duration
    }

    pub(super) fn last_transform(&self) -> Option<&StudioTimelineEditTransform> {
        self.transforms.last()
    }

    fn project_insert_wait(
        &mut self,
        event_kind: StudioTimelineEventKind,
        id: &str,
        interval: &IntervalV1,
        purpose: Option<StudioTimelinePurpose>,
        source_seconds: f64,
        working_anchor: f64,
    ) -> Result<IntervalV1, ApplyStudioTimelineEditError> {
        let duration = interval.end - interval.start;
        if event_kind != StudioTimelineEventKind::Wait
            || purpose != Some(StudioTimelinePurpose::SceneDuration)
            || !studio_timeline_semantic_values_match(interval.start, source_seconds)
            || interval.end <= interval.start
            || !duration.is_finite()
            || duration <= 0.0
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        let insertion_interval = IntervalV1 {
            end: working_anchor + duration,
            start: working_anchor,
        };
        let projected_duration = self.projected_duration + duration;
        let resolved_offset = self.resolved_offset + duration;
        if working_anchor < 0.0
            || working_anchor > self.projected_duration
            || !insertion_interval.end.is_finite()
            || !projected_duration.is_finite()
            || !resolved_offset.is_finite()
            || self
                .inserted_waits
                .iter()
                .any(|wait| studio_timeline_intervals_overlap(&insertion_interval, wait))
        {
            return Err(ApplyStudioTimelineEditError::InvalidInsertion);
        }
        self.edits
            .push(SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: working_anchor,
                duration,
            }));
        self.inserted_waits.push(insertion_interval.clone());
        self.operation_ids.push(id.to_owned());
        self.projected_duration = projected_duration;
        self.resolved_offset = resolved_offset;
        self.transforms.push(StudioTimelineEditTransform::Insert {
            interval: insertion_interval.clone(),
            operation_id: id.to_owned(),
        });
        self.wait_balances.push(StudioTimelineWaitBalance {
            operation_id: id.to_owned(),
            remaining_duration: duration,
        });
        Ok(insertion_interval)
    }

    fn project_trim(
        &mut self,
        id: &str,
        interval: &IntervalV1,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: &[String],
        working_anchor: f64,
    ) -> Result<IntervalV1, ApplyStudioTimelineEditError> {
        if !studio_timeline_semantic_values_match(interval.start, interval.end)
            || !studio_timeline_semantic_values_match(
                interval.start,
                working_anchor - self.resolved_offset,
            )
            || wait_operation_ids.len() != self.wait_balances.len()
            || wait_operation_ids
                .iter()
                .zip(self.wait_balances.iter().rev())
                .any(|(actual, expected)| actual != &expected.operation_id)
            || !removed_duration.is_finite()
            || removed_duration < 0.1 - TIMELINE_ANCHOR_EPSILON
            || (removed_duration > self.resolved_offset
                && !studio_timeline_semantic_values_match(removed_duration, self.resolved_offset))
            || !target_duration.is_finite()
            || target_duration < 0.1
            || !studio_timeline_semantic_values_match(
                self.projected_duration - removed_duration,
                target_duration,
            )
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        plan_wait_suffix_removal(&mut self.inserted_waits, working_anchor, removed_duration)?;
        let mut remaining = removed_duration;
        let mut wait_reductions = Vec::new();
        for wait in self.wait_balances.iter_mut().rev() {
            if remaining == 0.0 {
                break;
            }
            let removed = wait.remaining_duration.min(remaining);
            if removed > 0.0 {
                wait_reductions.push(StudioTimelineWaitReduction {
                    operation_id: wait.operation_id.clone(),
                    removed_duration: removed,
                });
            }
            wait.remaining_duration = (wait.remaining_duration - removed).max(0.0);
            if studio_timeline_semantic_values_match(wait.remaining_duration, 0.0) {
                wait.remaining_duration = 0.0;
            }
            remaining = (remaining - removed).max(0.0);
        }
        if !studio_timeline_semantic_values_match(remaining, 0.0) {
            return Err(ApplyStudioTimelineEditError::InvalidTrim);
        }
        self.edits.push(SceneTimelineEdit::TrimSceneDuration {
            at: working_anchor,
            removed_duration,
            target_duration,
        });
        self.operation_ids.push(id.to_owned());
        self.transforms.push(StudioTimelineEditTransform::Remove {
            interval: IntervalV1 {
                end: working_anchor,
                start: working_anchor - removed_duration,
            },
            operation_id: id.to_owned(),
            wait_reductions,
        });
        self.projected_duration -= removed_duration;
        self.resolved_offset -= removed_duration;
        if self.resolved_offset.abs() < TIMELINE_ANCHOR_EPSILON {
            self.resolved_offset = 0.0;
        }
        Ok(IntervalV1 {
            end: working_anchor,
            start: working_anchor,
        })
    }

    pub(super) fn project_edit(
        &mut self,
        program: &StudioTimelineEditInput,
        source_seconds: f64,
    ) -> Result<StudioTimelineEditProjection, ApplyStudioTimelineEditError> {
        let working_anchor = source_seconds + self.resolved_offset;
        if !working_anchor.is_finite() || self.resolved_offset < -TIMELINE_ANCHOR_EPSILON {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        let operation = &program.operations[0];
        let working_interval = match operation {
            StudioTimelineOperation::InsertWait {
                event_kind,
                id,
                interval,
                purpose,
                ..
            } => self.project_insert_wait(
                *event_kind,
                id,
                interval,
                *purpose,
                source_seconds,
                working_anchor,
            )?,
            StudioTimelineOperation::TrimSceneDuration {
                id,
                interval,
                removed_duration,
                target_duration,
                wait_operation_ids,
                ..
            } => self.project_trim(
                id,
                interval,
                *removed_duration,
                *target_duration,
                wait_operation_ids,
                working_anchor,
            )?,
            StudioTimelineOperation::Unsupported { .. } => {
                return Err(ApplyStudioTimelineEditError::Unsupported);
            }
        };
        Ok(StudioTimelineEditProjection {
            operation_id: operation.id().to_owned(),
            transaction_id: program.transaction_id.clone(),
            working_anchor,
            working_interval,
        })
    }

    pub(super) fn finish(
        self,
        program_projections: Vec<StudioTimelineEditProjection>,
    ) -> StudioTimelinePlan {
        StudioTimelinePlan {
            edits: self.edits,
            operation_ids: self.operation_ids,
            projection: StudioTimelineProjection {
                program_projections,
                projected_duration: self.projected_duration,
                transforms: self.transforms,
            },
        }
    }
}

fn plan_studio_timeline_edits(
    base_duration: f64,
    programs: &[StudioTimelineEditInput],
) -> Result<StudioTimelinePlan, ApplyStudioTimelineEditError> {
    validate_studio_timeline_edits(base_duration, programs)?;
    let ordered_programs = ordered_studio_timeline_edits(programs);
    let mut program_projections = vec![None; programs.len()];
    let mut state = StudioTimelinePlanningState::new(base_duration, programs.len());
    for (source_seconds, program_index) in ordered_programs {
        program_projections[program_index] =
            Some(state.project_edit(&programs[program_index], source_seconds)?);
    }
    let program_projections = program_projections
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(ApplyStudioTimelineEditError::Unsupported)?;
    Ok(state.finish(program_projections))
}

/// Projects normalized timeline edits without reading or mutating an Engine session.
///
/// # Errors
///
/// Returns the same closed-contract admission error used by timeline mutation.
pub fn project_studio_timeline_edits(
    base_duration: f64,
    programs: &[StudioTimelineEditInput],
) -> Result<StudioTimelineProjection, ApplyStudioTimelineEditError> {
    Ok(plan_studio_timeline_edits(base_duration, programs)?.projection)
}

fn trim_inserted_waits(
    scene: &mut poietra_scene_ir::SceneIrV1,
    inserted_waits: &mut Vec<IntervalV1>,
    at: f64,
    removed_duration: f64,
    target_duration: f64,
) -> Result<(), ApplyStudioTimelineEditError> {
    let resolved_duration = scene.duration - removed_duration;
    if !at.is_finite()
        || !removed_duration.is_finite()
        || removed_duration <= 0.0
        || !target_duration.is_finite()
        || target_duration <= 0.0
        || !resolved_duration.is_finite()
        || !studio_timeline_semantic_values_match(resolved_duration, target_duration)
    {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    for removal in plan_wait_suffix_removal(inserted_waits, at, removed_duration)? {
        let removal_start = removal.start;
        let removal_end = removal.end;
        remove_scene_time(scene, removal_start, removal_end);
    }
    if !studio_timeline_semantic_values_match(scene.duration, target_duration) {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    scene.duration = target_duration;
    Ok(())
}

impl EngineSessionV1 {
    /// Authorizes normalized Studio duration edits and applies them atomically.
    ///
    /// Source anchors are ordered stably and rebased through earlier waits and trims before the
    /// existing Scene timeline primitive is invoked. The caller must send every edit and map
    /// every non-timeline operation to `Unsupported`; this method owns admission of the complete
    /// edit.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized edits do not describe the closed static
    /// authorable-Scene duration subset, or the timeline primitive error when mutation fails.
    pub fn apply_studio_timeline_edit(
        &mut self,
        command: ApplyStudioTimelineEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioTimelineEditError> {
        let ApplyStudioTimelineEditCommand {
            expected_base_revision,
            next_revision,
            programs,
        } = command;
        let scene = self.scene();
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
                | SceneSourceV1::StudioEditProgram { .. }
        ) || !scene.animation_channels.is_empty()
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        let plan = plan_studio_timeline_edits(scene.duration, &programs)?;

        self.edit_scene_timeline(EditSceneTimelineCommand {
            edits: plan.edits,
            expected_base_revision,
            next_revision: next_revision.clone(),
            provenance: ProvenanceRecordV1 {
                evidence: plan
                    .operation_ids
                    .iter()
                    .map(|operation_id| format!("authorized operation {operation_id}"))
                    .collect(),
                id: format!("studio-imported-timeline:{next_revision}"),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        })
    }

    /// Atomically applies ordered wait insertions and duration trims.
    ///
    /// A trim can consume only the suffix of waits inserted earlier in this command. Removing
    /// that inserted interval maps later lifetimes and keyframes back toward their source times.
    /// If this would violate a Scene invariant, whole-bundle validation rejects the command
    /// without changing the installed session.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene, assets, and retained index.
    fn edit_scene_timeline(
        &mut self,
        command: EditSceneTimelineCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioTimelineEditError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(ApplyStudioTimelineEditError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(ApplyStudioTimelineEditError::RevisionDidNotAdvance);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(ApplyStudioTimelineEditError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let mut inserted_waits: Vec<IntervalV1> = Vec::new();
        for edit in &command.edits {
            match edit {
                SceneTimelineEdit::InsertWait(insertion) => {
                    if !insertion.at.is_finite()
                        || insertion.at < 0.0
                        || insertion.at > candidate.scene.duration
                        || !insertion.duration.is_finite()
                        || insertion.duration <= 0.0
                        || !(candidate.scene.duration + insertion.duration).is_finite()
                        || inserted_waits.iter().any(|wait| {
                            studio_timeline_intervals_overlap(
                                &IntervalV1 {
                                    end: insertion.at + insertion.duration,
                                    start: insertion.at,
                                },
                                wait,
                            )
                        })
                    {
                        return Err(ApplyStudioTimelineEditError::InvalidInsertion);
                    }
                    insert_scene_time(&mut candidate.scene, insertion);
                    inserted_waits.push(IntervalV1 {
                        end: insertion.at + insertion.duration,
                        start: insertion.at,
                    });
                }
                SceneTimelineEdit::TrimSceneDuration {
                    at,
                    removed_duration,
                    target_duration,
                } => trim_inserted_waits(
                    &mut candidate.scene,
                    &mut inserted_waits,
                    *at,
                    *removed_duration,
                    *target_duration,
                )?,
            }
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
    use poietra_scene_ir::{EasingV1, RuntimeTraceVersionV1, SceneCapabilityV1};

    use super::super::tests::{
        BASE_REVISION, NEXT_REVISION, fixture_bundle, imported_bundle, static_imported_bundle,
    };
    use super::*;

    fn timeline_bundle() -> SceneIrBundleV1 {
        let mut bundle = imported_bundle();
        bundle.scene.duration = 12.0;
        for entity in &mut bundle.scene.entities {
            entity.lifetimes = vec![IntervalV1 {
                end: 12.0,
                start: 0.0,
            }];
        }
        bundle.scene.entities[0].lifetimes[0].end = 8.0;
        let AnimationChannelV1::Opacity { keyframes, .. } = &mut bundle.scene.animation_channels[0]
        else {
            panic!("shared fixture must contain an opacity channel");
        };
        let mut final_keyframe = keyframes.pop().unwrap();
        final_keyframe.at = 12.0;
        keyframes.push(KeyframeV1 {
            at: 8.0,
            easing_to_next: Some(EasingV1::Smooth {}),
            value: 0.5,
        });
        keyframes.push(final_keyframe);
        bundle
    }

    fn timeline_command(edits: Vec<SceneTimelineEdit>) -> EditSceneTimelineCommand {
        EditSceneTimelineCommand {
            edits,
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio timeline edit".to_owned()],
                id: "studio-timeline-edit".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn studio_timeline_wait_edit_input(
        id: &str,
        source_seconds: f64,
        duration: f64,
    ) -> StudioTimelineEditInput {
        StudioTimelineEditInput {
            anchor_captured_playhead: source_seconds,
            anchor_resolved_seconds: source_seconds,
            anchor_source: SceneEditAnchorSource::Absolute {
                seconds: Some(source_seconds),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StudioTimelineOperation::InsertWait {
                depends_on: vec![],
                event_kind: StudioTimelineEventKind::Wait,
                id: id.to_owned(),
                interval: IntervalV1 {
                    end: source_seconds + duration,
                    start: source_seconds,
                },
                origin: StudioAuthoringOrigin::StudioDefault,
                purpose: Some(StudioTimelinePurpose::SceneDuration),
            }],
            origin: StudioAuthoringOrigin::StudioDefault,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: vec![id.to_owned()],
            transaction_id: id.to_owned(),
        }
    }

    fn studio_timeline_trim_edit_input(
        id: &str,
        source_seconds: f64,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
    ) -> StudioTimelineEditInput {
        StudioTimelineEditInput {
            anchor_captured_playhead: source_seconds,
            anchor_resolved_seconds: source_seconds,
            anchor_source: SceneEditAnchorSource::Absolute {
                seconds: Some(source_seconds),
            },
            intent_count: 1,
            lowering_supported: true,
            operations: vec![StudioTimelineOperation::TrimSceneDuration {
                depends_on: vec![],
                id: id.to_owned(),
                interval: IntervalV1 {
                    end: source_seconds,
                    start: source_seconds,
                },
                origin: StudioAuthoringOrigin::StudioDefault,
                removed_duration,
                target_duration,
                wait_operation_ids,
            }],
            origin: StudioAuthoringOrigin::StudioDefault,
            requested_execution: SceneEditExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: SceneEditScheduleMode::Sequence,
            schedule_order: vec![id.to_owned()],
            transaction_id: id.to_owned(),
        }
    }

    fn studio_timeline_command(bundle: &SceneIrBundleV1) -> ApplyStudioTimelineEditCommand {
        let source_seconds = 0.5;
        ApplyStudioTimelineEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                studio_timeline_wait_edit_input("wait-1", source_seconds, 1.0),
                studio_timeline_trim_edit_input(
                    "trim-1",
                    source_seconds,
                    0.5,
                    bundle.scene.duration + 0.5,
                    vec!["wait-1".to_owned()],
                ),
                studio_timeline_wait_edit_input("wait-2", source_seconds, 1.0),
            ],
        }
    }

    fn rejected_studio_timeline_edit(
        bundle: SceneIrBundleV1,
        command: ApplyStudioTimelineEditCommand,
    ) -> ApplyStudioTimelineEditError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.apply_studio_timeline_edit(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    #[test]
    fn studio_timeline_authority_rebases_same_anchor_wait_trim_wait_in_input_order() {
        let bundle = static_imported_bundle();
        let expected_duration = bundle.scene.duration + 1.5;
        let mut command = studio_timeline_command(&bundle);
        command.programs[1].anchor_captured_playhead = bundle.scene.duration + 1.0;
        let projection =
            project_studio_timeline_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(
            projection.program_projections,
            vec![
                StudioTimelineEditProjection {
                    operation_id: "wait-1".to_owned(),
                    transaction_id: "wait-1".to_owned(),
                    working_anchor: 0.5,
                    working_interval: IntervalV1 {
                        end: 1.5,
                        start: 0.5,
                    },
                },
                StudioTimelineEditProjection {
                    operation_id: "trim-1".to_owned(),
                    transaction_id: "trim-1".to_owned(),
                    working_anchor: 1.5,
                    working_interval: IntervalV1 {
                        end: 1.5,
                        start: 1.5,
                    },
                },
                StudioTimelineEditProjection {
                    operation_id: "wait-2".to_owned(),
                    transaction_id: "wait-2".to_owned(),
                    working_anchor: 1.0,
                    working_interval: IntervalV1 {
                        end: 2.0,
                        start: 1.0,
                    },
                },
            ]
        );
        assert_eq!(
            projection.transforms,
            vec![
                StudioTimelineEditTransform::Insert {
                    interval: IntervalV1 {
                        end: 1.5,
                        start: 0.5,
                    },
                    operation_id: "wait-1".to_owned(),
                },
                StudioTimelineEditTransform::Remove {
                    interval: IntervalV1 {
                        end: 1.5,
                        start: 1.0,
                    },
                    operation_id: "trim-1".to_owned(),
                    wait_reductions: vec![StudioTimelineWaitReduction {
                        operation_id: "wait-1".to_owned(),
                        removed_duration: 0.5,
                    }],
                },
                StudioTimelineEditTransform::Insert {
                    interval: IntervalV1 {
                        end: 2.0,
                        start: 1.0,
                    },
                    operation_id: "wait-2".to_owned(),
                },
            ]
        );
        assert!((projection.projected_duration - expected_duration).abs() < f64::EPSILON);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_timeline_edit(command).unwrap();

        assert!((result.scene.duration - expected_duration).abs() < f64::EPSILON);
        assert_eq!(
            result.scene.provenance.last(),
            Some(&ProvenanceRecordV1 {
                evidence: vec![
                    "authorized operation wait-1".to_owned(),
                    "authorized operation trim-1".to_owned(),
                    "authorized operation wait-2".to_owned(),
                ],
                id: format!("studio-imported-timeline:{NEXT_REVISION}"),
                origin: ProvenanceOriginV1::StudioEditProgram,
            })
        );
        assert_eq!(result.scene.source.revision_hash(), NEXT_REVISION);
        assert_eq!(session.scene(), &result.scene);
    }

    #[test]
    fn studio_timeline_authority_accepts_a_static_studio_edit_program_scene() {
        let mut bundle = static_imported_bundle();
        bundle.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: BASE_REVISION.to_owned(),
        };
        let expected_duration = bundle.scene.duration + 1.5;
        let command = studio_timeline_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_timeline_edit(command).unwrap();

        assert!((result.scene.duration - expected_duration).abs() < f64::EPSILON);
        assert!(matches!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram { ref revision_hash, .. } if revision_hash == NEXT_REVISION
        ));
    }

    #[test]
    fn studio_timeline_authority_normalizes_decimal_trim_offset_before_the_next_edit() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let source_anchor = 0.5;
        let command = ApplyStudioTimelineEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                studio_timeline_wait_edit_input("wait-a", source_anchor, 0.3),
                studio_timeline_wait_edit_input("wait-b", source_anchor, 0.6),
                studio_timeline_trim_edit_input(
                    "trim-all",
                    source_anchor,
                    0.9,
                    base_duration,
                    vec!["wait-b".to_owned(), "wait-a".to_owned()],
                ),
                studio_timeline_wait_edit_input("wait-c", source_anchor, 0.2),
            ],
        };
        let projection = project_studio_timeline_edits(base_duration, &command.programs).unwrap();
        assert!((projection.projected_duration - (base_duration + 0.2)).abs() < 1e-9);
        assert!((projection.program_projections[3].working_anchor - source_anchor).abs() < 1e-9);
        let StudioTimelineEditTransform::Remove {
            operation_id,
            wait_reductions,
            ..
        } = &projection.transforms[2]
        else {
            panic!("the third timeline transform must remove the authorized wait suffix")
        };
        assert_eq!(operation_id, "trim-all");
        assert_eq!(wait_reductions.len(), 2);
        assert_eq!(wait_reductions[0].operation_id, "wait-b");
        assert!((wait_reductions[0].removed_duration - 0.6).abs() < 1e-9);
        assert_eq!(wait_reductions[1].operation_id, "wait-a");
        assert!((wait_reductions[1].removed_duration - 0.3).abs() < 1e-9);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_timeline_edit(command).unwrap();

        assert!((result.scene.duration - (base_duration + 0.2)).abs() < 1e-9);
    }

    #[test]
    fn studio_timeline_projection_rejects_a_trim_outside_the_inserted_wait_suffix() {
        let bundle = static_imported_bundle();
        let separated_waits = vec![
            studio_timeline_wait_edit_input("wait", 0.5, 1.0),
            studio_timeline_trim_edit_input(
                "trim",
                0.5004,
                1.0,
                bundle.scene.duration,
                vec!["wait".to_owned()],
            ),
        ];
        assert!(matches!(
            project_studio_timeline_edits(bundle.scene.duration, &separated_waits),
            Err(ApplyStudioTimelineEditError::InvalidTrim)
        ));

        let over_trimmed = vec![
            studio_timeline_wait_edit_input("wait", 0.5, 1.0),
            studio_timeline_trim_edit_input(
                "trim",
                0.5,
                1.0004,
                bundle.scene.duration - 0.0004,
                vec!["wait".to_owned()],
            ),
        ];
        assert!(matches!(
            project_studio_timeline_edits(bundle.scene.duration, &over_trimmed),
            Err(ApplyStudioTimelineEditError::Unsupported)
        ));
        let command = ApplyStudioTimelineEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            programs: separated_waits,
        };
        assert!(matches!(
            rejected_studio_timeline_edit(bundle, command),
            ApplyStudioTimelineEditError::InvalidTrim
        ));
    }

    #[test]
    fn studio_timeline_authority_rejects_invalid_normalized_facts_atomically() {
        let bundle = static_imported_bundle();
        let mut cases = Vec::new();

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].anchor_resolved_seconds += 0.0001;
        cases.push(("resolved anchor", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].anchor_source = SceneEditAnchorSource::Absolute {
            seconds: Some(-0.5),
        };
        cases.push(("negative source anchor", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].lowering_supported = false;
        cases.push(("unsupported lowering", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].origin = StudioAuthoringOrigin::RemoteModel;
        cases.push(("program origin", command));

        let mut command = studio_timeline_command(&bundle);
        let StudioTimelineOperation::InsertWait { origin, .. } =
            &mut command.programs[0].operations[0]
        else {
            unreachable!();
        };
        *origin = StudioAuthoringOrigin::DirectManipulation;
        cases.push(("operation origin", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].schedule_order[0] = "foreign-operation".to_owned();
        cases.push(("open schedule", command));

        let mut command = studio_timeline_command(&bundle);
        let StudioTimelineOperation::InsertWait { depends_on, .. } =
            &mut command.programs[0].operations[0]
        else {
            unreachable!();
        };
        *depends_on = vec!["missing-operation".to_owned()];
        cases.push(("missing dependency", command));

        let mut command = studio_timeline_command(&bundle);
        let StudioTimelineOperation::InsertWait { id, .. } = &mut command.programs[2].operations[0]
        else {
            unreachable!();
        };
        id.clone_from(&"wait-1".to_owned());
        command.programs[2].schedule_order[0] = "wait-1".to_owned();
        cases.push(("duplicate operation ID", command));

        let mut command = studio_timeline_command(&bundle);
        let StudioTimelineOperation::TrimSceneDuration {
            wait_operation_ids, ..
        } = &mut command.programs[1].operations[0]
        else {
            unreachable!();
        };
        *wait_operation_ids = vec!["foreign-wait".to_owned()];
        cases.push(("foreign wait authority", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0]
            .operations
            .push(StudioTimelineOperation::Unsupported {
                depends_on: vec![],
                id: "ignored-suffix".to_owned(),
                interval: IntervalV1 {
                    end: 0.5,
                    start: 0.5,
                },
                origin: StudioAuthoringOrigin::StudioDefault,
            });
        command.programs[0]
            .schedule_order
            .push("ignored-suffix".to_owned());
        command.programs[0].schedule_edge_count = 1;
        cases.push(("hidden suffix operation", command));

        let mut command = studio_timeline_command(&bundle);
        let interval = match &command.programs[2].operations[0] {
            StudioTimelineOperation::InsertWait { interval, .. } => interval.clone(),
            _ => unreachable!(),
        };
        command.programs[2].operations[0] = StudioTimelineOperation::Unsupported {
            depends_on: vec![],
            id: "wait-2".to_owned(),
            interval,
            origin: StudioAuthoringOrigin::StudioDefault,
        };
        cases.push(("mixed operation", command));

        let mut command = studio_timeline_command(&bundle);
        let StudioTimelineOperation::TrimSceneDuration {
            removed_duration, ..
        } = &mut command.programs[1].operations[0]
        else {
            unreachable!();
        };
        *removed_duration = 0.01;
        cases.push(("sub-minimum trim", command));

        for (case, command) in cases {
            assert!(
                matches!(
                    rejected_studio_timeline_edit(bundle.clone(), command),
                    ApplyStudioTimelineEditError::Unsupported
                ),
                "{case}"
            );
        }
    }

    #[test]
    fn studio_timeline_authority_requires_one_static_server_snapshot() {
        let mut runtime_trace = static_imported_bundle();
        runtime_trace.scene.source = SceneSourceV1::ImportedManimRuntimeTrace {
            runtime_config_hash: "a".repeat(64),
            source_hash: "b".repeat(64),
            trace_digest: BASE_REVISION.to_owned(),
            trace_version: RuntimeTraceVersionV1::V3,
        };
        let runtime_command = studio_timeline_command(&runtime_trace);
        assert!(matches!(
            rejected_studio_timeline_edit(runtime_trace, runtime_command),
            ApplyStudioTimelineEditError::Unsupported
        ));

        let mut animated = static_imported_bundle();
        let animated_fixture = fixture_bundle("shared-circle-opacity.json");
        animated.scene.animation_channels = animated_fixture.scene.animation_channels;
        animated.scene.required_capabilities = animated_fixture.scene.required_capabilities;
        let animated_command = studio_timeline_command(&animated);
        assert!(matches!(
            rejected_studio_timeline_edit(animated, animated_command),
            ApplyStudioTimelineEditError::Unsupported
        ));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "timeline edits produce exact stored authoring times"
    )]
    fn inserts_a_wait_and_trims_only_its_suffix_from_the_same_command() {
        let bundle = timeline_bundle();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 3.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 10.0,
                removed_duration: 1.0,
                target_duration: 14.0,
            },
        ]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.edit_scene_timeline(command.clone()).unwrap();

        assert_eq!(result.scene.duration, 14.0);
        assert_eq!(
            result.scene.entities[0].lifetimes,
            vec![IntervalV1 {
                start: 0.0,
                end: 10.0,
            }]
        );
        assert!(
            result.scene.entities[1..]
                .iter()
                .all(|entity| entity.lifetimes
                    == vec![IntervalV1 {
                        start: 0.0,
                        end: 14.0
                    }])
        );
        assert!(matches!(
            &result.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if keyframes[0].at == 0.0
                    && keyframes[1].at == 10.0
                    && keyframes[2].at == 14.0
        ));
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn timeline_wait_insertion_shifts_lifetimes_and_every_channel_time() {
        let bundle = timeline_bundle();
        let command = timeline_command(vec![SceneTimelineEdit::InsertWait(
            SceneTimelineInsertion {
                at: 7.0,
                duration: 3.0,
            },
        )]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.edit_scene_timeline(command).unwrap();

        assert!((result.scene.duration - 15.0).abs() < f64::EPSILON);
        assert!((result.scene.entities[0].lifetimes[0].end - 11.0).abs() < f64::EPSILON);
        assert!(
            result.scene.entities[1..]
                .iter()
                .all(|entity| { (entity.lifetimes[0].end - 15.0).abs() < f64::EPSILON })
        );
        assert!(matches!(
            &result.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if (keyframes[1].at - 11.0).abs() < f64::EPSILON
                    && (keyframes[2].at - 15.0).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn timeline_wait_insertion_shifts_scene_post_effect_parameter_keyframes() {
        let mut bundle = timeline_bundle();
        bundle.scene.post_effects = vec![poietra_scene_ir::ScenePostEffectV1 {
            parameters: vec![1.0],
            revision: poietra_scene_ir::RGB_SPLIT_POST_EFFECT_SHADER_REVISION,
            shader_id: poietra_scene_ir::RGB_SPLIT_POST_EFFECT_SHADER_ID.to_owned(),
            texture: None,
        }];
        bundle
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::ScenePostEffect);
        bundle.scene.required_capabilities.sort_unstable();
        bundle
            .scene
            .animation_channels
            .push(AnimationChannelV1::ScenePostEffectParameter {
                id: "scene-post-effect-parameter:0".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: 1.0,
                    },
                    KeyframeV1 {
                        at: 8.0,
                        easing_to_next: None,
                        value: 2.0,
                    },
                ],
                parameter_index: 0,
                provenance_id: bundle.scene.provenance[0].id.clone(),
                revision: poietra_scene_ir::RGB_SPLIT_POST_EFFECT_SHADER_REVISION,
                shader_id: poietra_scene_ir::RGB_SPLIT_POST_EFFECT_SHADER_ID.to_owned(),
            });
        let command = timeline_command(vec![SceneTimelineEdit::InsertWait(
            SceneTimelineInsertion {
                at: 7.0,
                duration: 3.0,
            },
        )]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.edit_scene_timeline(command).unwrap();

        assert!(matches!(
            result.scene.animation_channels.last(),
            Some(AnimationChannelV1::ScenePostEffectParameter { keyframes, .. })
                if keyframes[0].at.to_bits() == 0.0_f64.to_bits()
                    && keyframes[1].at.to_bits() == 11.0_f64.to_bits()
        ));
    }

    #[test]
    fn trim_beyond_waits_in_the_same_command_is_rejected_atomically() {
        let bundle = timeline_bundle();
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 3.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 10.0,
                removed_duration: 4.0,
                target_duration: 11.0,
            },
        ]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.edit_scene_timeline(command),
            Err(ApplyStudioTimelineEditError::InvalidTrim)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    fn trim_at_a_different_source_anchor_is_rejected_atomically() {
        let bundle = timeline_bundle();
        let expected_scene = bundle.scene.clone();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 3.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 9.5,
                removed_duration: 1.0,
                target_duration: 14.0,
            },
        ]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.edit_scene_timeline(command),
            Err(ApplyStudioTimelineEditError::InvalidTrim)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    fn trim_across_disjoint_waits_is_rejected_atomically() {
        let bundle = timeline_bundle();
        let expected_scene = bundle.scene.clone();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 2.0,
                duration: 1.0,
            }),
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 8.0,
                duration: 1.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 9.0,
                removed_duration: 2.0,
                target_duration: 12.0,
            },
        ]);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        assert!(matches!(
            session.edit_scene_timeline(command),
            Err(ApplyStudioTimelineEditError::InvalidTrim)
        ));
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }

    #[test]
    fn decimal_waits_can_be_trimmed_without_floating_point_residue() {
        let mut session = EngineSessionV1::new(timeline_bundle()).unwrap();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 0.1,
            }),
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.1,
                duration: 0.1,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 7.2,
                removed_duration: 0.2,
                target_duration: 12.0,
            },
        ]);

        let result = session.edit_scene_timeline(command).unwrap();
        assert!((result.scene.duration - 12.0).abs() < TIMELINE_ANCHOR_EPSILON);
    }

    #[test]
    fn sub_epsilon_overlapping_wait_insertion_is_rejected_atomically() {
        let mut session = EngineSessionV1::new(timeline_bundle()).unwrap();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 1.0,
            }),
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.9996,
                duration: 1.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 8.9996,
                removed_duration: 1.5,
                target_duration: 12.5,
            },
        ]);

        assert!(matches!(
            session.edit_scene_timeline(command),
            Err(ApplyStudioTimelineEditError::InvalidInsertion)
        ));
    }
}
