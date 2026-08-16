use poietra_scene_ir::{
    IntervalV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1, SceneGeometryV1, SceneIrBundleV1,
};
use serde::{Deserialize, Serialize};

use crate::EngineSessionV1;

use super::transform::{
    RotateSceneEntityCommand, ScaleAboutPivot, SetSubtreeVectorPaintAlphaCommand,
    TransformSceneEntityAtTimeCommand, TransformSceneEntityCommand, TransformSceneEntityIntent,
    rotation_is_noop,
};
use super::{
    SceneEditAnchorSource, SceneEditExecution, SceneEditScheduleMode, StudioAuthoringOrigin,
    StudioAuthoringSize, close_transform_baseline_value, studio_authoring_point_is_finite,
    studio_authoring_size_is_positive, studio_point_to_scene_point,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioBoundEntityEditPhase {
    Construction,
    Settled,
}

impl StudioBoundEntityEditPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Construction => "construction",
            Self::Settled => "settled",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioBoundEntityEditCapabilities {
    pub paint_opacity: bool,
    pub rotation: bool,
    pub uniform_scale: bool,
}

/// Integration-verified authority facts for one Studio entity bound to one Scene root.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioBoundEntityEditCandidate {
    pub base_center: PointV1,
    pub base_opacity: Option<f64>,
    pub capabilities: StudioBoundEntityEditCapabilities,
    pub evidence_id: String,
    pub phase: StudioBoundEntityEditPhase,
    pub scene_entity_id: String,
    pub source_anchor: f64,
    pub studio_entity_id: String,
}

pub type StudioBoundEntityExecution = SceneEditExecution;
pub type StudioBoundEntityScheduleMode = SceneEditScheduleMode;
pub type StudioBoundEntityAnchorSource = SceneEditAnchorSource;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioBoundEntityOperation {
    Move {
        depends_on: Vec<String>,
        entity_id: String,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        position: Option<PointV1>,
    },
    Opacity {
        alpha: Option<f64>,
        depends_on: Vec<String>,
        entity_id: String,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
    Rotation {
        control_present: bool,
        depends_on: Vec<String>,
        entity_id: String,
        from: Option<f64>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        relative_delta: Option<f64>,
        to: Option<f64>,
    },
    UniformScale {
        control_present: bool,
        depends_on: Vec<String>,
        entity_id: String,
        from: Option<f64>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        relative_factor: Option<f64>,
        to: Option<f64>,
    },
    Unsupported {
        depends_on: Vec<String>,
        entity_id: Option<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioBoundEntityOperation {
    fn depends_on(&self) -> &[String] {
        match self {
            Self::Move { depends_on, .. }
            | Self::Opacity { depends_on, .. }
            | Self::Rotation { depends_on, .. }
            | Self::UniformScale { depends_on, .. }
            | Self::Unsupported { depends_on, .. } => depends_on,
        }
    }

    fn entity_id(&self) -> Option<&str> {
        match self {
            Self::Move { entity_id, .. }
            | Self::Opacity { entity_id, .. }
            | Self::Rotation { entity_id, .. }
            | Self::UniformScale { entity_id, .. } => Some(entity_id),
            Self::Unsupported { entity_id, .. } => entity_id.as_deref(),
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Move { id, .. }
            | Self::Opacity { id, .. }
            | Self::Rotation { id, .. }
            | Self::UniformScale { id, .. }
            | Self::Unsupported { id, .. } => id,
        }
    }

    fn interval(&self) -> &IntervalV1 {
        match self {
            Self::Move { interval, .. }
            | Self::Opacity { interval, .. }
            | Self::Rotation { interval, .. }
            | Self::UniformScale { interval, .. }
            | Self::Unsupported { interval, .. } => interval,
        }
    }

    fn origin(&self) -> StudioAuthoringOrigin {
        match self {
            Self::Move { origin, .. }
            | Self::Opacity { origin, .. }
            | Self::Rotation { origin, .. }
            | Self::UniformScale { origin, .. }
            | Self::Unsupported { origin, .. } => *origin,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioBoundEntityEditInput {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioBoundEntityAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioBoundEntityOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: StudioBoundEntityExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioBoundEntityScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

/// One complete normalized Studio request plus integration-verified binding candidates.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioBoundEntityEditCommand {
    pub candidates: Vec<StudioBoundEntityEditCandidate>,
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub next_revision: String,
    pub programs: Vec<StudioBoundEntityEditInput>,
    pub viewport: StudioAuthoringSize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioBoundEntityProjection {
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub mutation: StudioBoundEntityProjectionMutation,
    pub operation_id: String,
    pub studio_entity_id: String,
    pub transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioBoundEntityProjectionMutation {
    Position { value: PointV1 },
    Opacity { value: f64 },
    Rotation { from: f64, to: f64 },
    UniformScale { from: f64, to: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioBoundEntityEditResult {
    pub bundle: SceneIrBundleV1,
    pub projection: StudioBoundEntityProjection,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioBoundEntityEditError {
    #[error("the normalized Studio Programs do not authorize one bound root entity edit")]
    Unsupported,
    #[error("the authorized bound root entity edit could not be applied: {0}")]
    MutationRejected(String),
}

impl ApplyStudioBoundEntityEditError {
    fn mutation_rejected(error: impl std::fmt::Display) -> Self {
        Self::MutationRejected(error.to_string())
    }
}

#[derive(Clone, Debug, PartialEq)]
enum StudioBoundEntityEdit {
    Move(PointV1),
    Opacity(f64),
    Rotation { delta: f64, from: f64, to: f64 },
    UniformScale { factor: f64, from: f64, to: f64 },
}

impl StudioBoundEntityEdit {
    fn kind(&self) -> &'static str {
        match self {
            Self::Move(_) => "move",
            Self::Opacity(_) => "opacity",
            Self::Rotation { .. } => "rotation",
            Self::UniformScale { .. } => "resize",
        }
    }

    fn evidence(&self, phase: StudioBoundEntityEditPhase) -> String {
        match self {
            Self::Move(_) => format!(
                "Studio {} position request projected onto one verified source-bound root",
                phase.as_str()
            ),
            Self::Opacity(_) => "Studio construction-time absolute opacity request projected onto static vector paints in one verified source-bound root".to_owned(),
            Self::Rotation { .. } => "Studio construction-time planar rotation request projected onto one verified source-bound root".to_owned(),
            Self::UniformScale { .. } => format!(
                "Studio {} uniform resize request projected onto one verified source-bound root",
                phase.as_str()
            ),
        }
    }

    fn projection(
        &self,
        program: &StudioBoundEntityEditInput,
        candidate: &StudioBoundEntityEditCandidate,
        operation: &StudioBoundEntityOperation,
    ) -> StudioBoundEntityProjection {
        let mutation = match self {
            Self::Move(value) => StudioBoundEntityProjectionMutation::Position {
                value: value.clone(),
            },
            Self::Opacity(value) => StudioBoundEntityProjectionMutation::Opacity { value: *value },
            Self::Rotation { from, to, .. } => StudioBoundEntityProjectionMutation::Rotation {
                from: *from,
                to: *to,
            },
            Self::UniformScale { from, to, .. } => {
                StudioBoundEntityProjectionMutation::UniformScale {
                    from: *from,
                    to: *to,
                }
            }
        };
        StudioBoundEntityProjection {
            interval: operation.interval().clone(),
            mutation,
            operation_id: operation.id().to_owned(),
            studio_entity_id: candidate.studio_entity_id.clone(),
            transaction_id: program.transaction_id.clone(),
        }
    }
}

fn studio_bound_entity_edit_input_is_closed(program: &StudioBoundEntityEditInput) -> bool {
    let Some(operation) = program.operations.first() else {
        return false;
    };
    program.operations.len() == 1
        && program.schedule_order.len() == 1
        && program.schedule_order[0] == operation.id()
}

fn studio_bound_entity_anchor_matches(
    source: &StudioBoundEntityAnchorSource,
    expected: f64,
) -> bool {
    match source {
        StudioBoundEntityAnchorSource::Absolute {
            seconds: Some(seconds),
        } => close_transform_baseline_value(*seconds, expected),
        StudioBoundEntityAnchorSource::Playhead {
            reference_seconds: Some(reference_seconds),
        } => close_transform_baseline_value(*reference_seconds, expected),
        StudioBoundEntityAnchorSource::Absolute { seconds: None }
        | StudioBoundEntityAnchorSource::Playhead {
            reference_seconds: None,
        }
        | StudioBoundEntityAnchorSource::Unsupported => false,
    }
}

fn twelve_significant_digits(value: f64) -> Option<f64> {
    value
        .is_finite()
        .then(|| format!("{value:.11e}").parse::<f64>().ok())
        .flatten()
}

fn resolve_studio_bound_entity_edit(
    program: &StudioBoundEntityEditInput,
    candidate: &StudioBoundEntityEditCandidate,
) -> Option<StudioBoundEntityEdit> {
    let operation = program.operations.first()?;
    let interval = operation.interval();
    if program.intent_count != 1
        || program.transaction_id.is_empty()
        || !program.lowering_supported
        || program.origin != StudioAuthoringOrigin::DirectManipulation
        || program.requested_execution != StudioBoundEntityExecution::Parallel
        || program.schedule_mode != StudioBoundEntityScheduleMode::Parallel
        || program.schedule_edge_count != 0
        || !studio_bound_entity_edit_input_is_closed(program)
        || !close_transform_baseline_value(
            program.anchor_captured_playhead,
            candidate.source_anchor,
        )
        || !close_transform_baseline_value(program.anchor_resolved_seconds, candidate.source_anchor)
        || !studio_bound_entity_anchor_matches(&program.anchor_source, candidate.source_anchor)
        || operation.entity_id() != Some(candidate.studio_entity_id.as_str())
        || !operation.depends_on().is_empty()
        || !close_transform_baseline_value(interval.start, candidate.source_anchor)
        || !close_transform_baseline_value(interval.end, candidate.source_anchor)
        || operation.origin() != StudioAuthoringOrigin::DirectManipulation
    {
        return None;
    }

    match operation {
        StudioBoundEntityOperation::Move {
            position: Some(position),
            ..
        } if studio_authoring_point_is_finite(position) => {
            Some(StudioBoundEntityEdit::Move(position.clone()))
        }
        StudioBoundEntityOperation::Opacity {
            alpha: Some(alpha), ..
        } if candidate.phase == StudioBoundEntityEditPhase::Construction
            && candidate.capabilities.paint_opacity
            && alpha.is_finite()
            && (0.0..=1.0).contains(alpha)
            && candidate.base_opacity.is_none_or(|base_opacity| {
                !close_transform_baseline_value(*alpha, base_opacity)
            }) =>
        {
            Some(StudioBoundEntityEdit::Opacity(*alpha))
        }
        StudioBoundEntityOperation::Rotation {
            control_present,
            from: Some(from),
            relative_delta: Some(relative_delta),
            to: Some(to),
            ..
        } if candidate.phase == StudioBoundEntityEditPhase::Construction
            && candidate.capabilities.rotation
            && !control_present
            && from.is_finite()
            && to.is_finite()
            && relative_delta.is_finite()
            && close_transform_baseline_value(*from, 0.0)
            && (*to - *from - *relative_delta).abs() < 0.000_001
            && !rotation_is_noop(*relative_delta) =>
        {
            Some(StudioBoundEntityEdit::Rotation {
                delta: *relative_delta,
                from: *from,
                to: *to,
            })
        }
        StudioBoundEntityOperation::UniformScale {
            control_present,
            from: Some(from),
            relative_factor: Some(relative_factor),
            to: Some(to),
            ..
        } if candidate.capabilities.uniform_scale
            && !control_present
            && from.is_finite()
            && to.is_finite()
            && relative_factor.is_finite()
            && *from > 0.0
            && *to > 0.0
            && *relative_factor > 0.0
            && close_transform_baseline_value(*from, 1.0)
            && twelve_significant_digits(*relative_factor) != Some(1.0)
            && close_transform_baseline_value(*to / *from, *relative_factor) =>
        {
            Some(StudioBoundEntityEdit::UniformScale {
                factor: *relative_factor,
                from: *from,
                to: *to,
            })
        }
        StudioBoundEntityOperation::Move { .. }
        | StudioBoundEntityOperation::Opacity { .. }
        | StudioBoundEntityOperation::Rotation { .. }
        | StudioBoundEntityOperation::UniformScale { .. }
        | StudioBoundEntityOperation::Unsupported { .. } => None,
    }
}

impl EngineSessionV1 {
    /// Authorizes one complete normalized Studio edit of one verified bound Scene root.
    ///
    /// Integration supplies every normalized edit and every candidate it has independently
    /// verified. This method owns closed-subset admission, unique target binding, viewport
    /// conversion, phase-specific mutation selection, and provenance construction.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the request is outside the closed edit subset, or the concrete
    /// canonical mutation error. Every failure preserves the installed Scene and retained index.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact camera-frame correlation and one visible atomic admission/dispatch path preserve the endpoint authority contract"
    )]
    pub fn apply_studio_bound_entity_edit(
        &mut self,
        command: ApplyStudioBoundEntityEditCommand,
    ) -> Result<StudioBoundEntityEditResult, ApplyStudioBoundEntityEditError> {
        let ApplyStudioBoundEntityEditCommand {
            candidates,
            expected_base_revision,
            frame,
            next_revision,
            programs,
            viewport,
        } = command;
        let scene = self.scene();
        if !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.len() != 1
            || candidates.is_empty()
        {
            return Err(ApplyStudioBoundEntityEditError::Unsupported);
        }

        let program = &programs[0];
        let operation = program
            .operations
            .first()
            .ok_or(ApplyStudioBoundEntityEditError::Unsupported)?;
        let studio_entity_id = operation
            .entity_id()
            .ok_or(ApplyStudioBoundEntityEditError::Unsupported)?;
        let mut matching_candidates = candidates
            .iter()
            .filter(|candidate| candidate.studio_entity_id == studio_entity_id);
        let candidate = matching_candidates
            .next()
            .filter(|candidate| {
                candidate.source_anchor.is_finite()
                    && studio_authoring_point_is_finite(&candidate.base_center)
                    && candidate
                        .base_opacity
                        .is_none_or(|alpha| alpha.is_finite() && (0.0..=1.0).contains(&alpha))
            })
            .ok_or(ApplyStudioBoundEntityEditError::Unsupported)?;
        if matching_candidates.next().is_some() {
            return Err(ApplyStudioBoundEntityEditError::Unsupported);
        }
        if candidates
            .iter()
            .filter(|other| other.scene_entity_id == candidate.scene_entity_id)
            .count()
            != 1
        {
            return Err(ApplyStudioBoundEntityEditError::Unsupported);
        }
        let edit = resolve_studio_bound_entity_edit(program, candidate)
            .ok_or(ApplyStudioBoundEntityEditError::Unsupported)?;
        let projection = edit.projection(program, candidate, operation);
        let target = scene
            .entities
            .iter()
            .find(|entity| entity.id == candidate.scene_entity_id)
            .filter(|entity| entity.parent_id.is_none())
            .filter(|entity| matches!(entity.geometry, SceneGeometryV1::Group {}))
            .ok_or(ApplyStudioBoundEntityEditError::Unsupported)?;
        let target_id = target.id.clone();
        let base_center = studio_point_to_scene_point(
            &candidate.base_center,
            frame,
            viewport,
            &scene.camera.view.center,
        );
        let provenance = ProvenanceRecordV1 {
            evidence: vec![
                edit.evidence(candidate.phase),
                format!("source binding {}", candidate.evidence_id),
                format!("authorized operation {}", operation.id()),
            ],
            id: format!(
                "studio-bound-endpoint-{}-{}:{next_revision}",
                candidate.phase.as_str(),
                edit.kind()
            ),
            origin: ProvenanceOriginV1::StudioEditProgram,
        };

        let bundle = match edit {
            StudioBoundEntityEdit::Move(position) => {
                let target_center = studio_point_to_scene_point(
                    &position,
                    frame,
                    viewport,
                    &scene.camera.view.center,
                );
                let delta = PointV1 {
                    x: target_center.x - base_center.x,
                    y: target_center.y - base_center.y,
                };
                match candidate.phase {
                    StudioBoundEntityEditPhase::Construction => self
                        .transform_scene_entity(TransformSceneEntityCommand {
                            entity_id: target_id,
                            expected_base_revision,
                            intent: TransformSceneEntityIntent::Relative { delta, scale: None },
                            next_revision,
                            provenance,
                        })
                        .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
                    StudioBoundEntityEditPhase::Settled => self
                        .transform_scene_entity_at_time(TransformSceneEntityAtTimeCommand {
                            at: candidate.source_anchor,
                            delta,
                            entity_id: target_id,
                            expected_base_revision,
                            next_revision,
                            provenance,
                            scale: None,
                        })
                        .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
                }
            }
            StudioBoundEntityEdit::UniformScale { factor, .. } => {
                let scale = Some(ScaleAboutPivot {
                    pivot: base_center,
                    x_factor: factor,
                    y_factor: factor,
                });
                match candidate.phase {
                    StudioBoundEntityEditPhase::Construction => self
                        .transform_scene_entity(TransformSceneEntityCommand {
                            entity_id: target_id,
                            expected_base_revision,
                            intent: TransformSceneEntityIntent::Relative {
                                delta: PointV1 { x: 0.0, y: 0.0 },
                                scale,
                            },
                            next_revision,
                            provenance,
                        })
                        .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
                    StudioBoundEntityEditPhase::Settled => self
                        .transform_scene_entity_at_time(TransformSceneEntityAtTimeCommand {
                            at: candidate.source_anchor,
                            delta: PointV1 { x: 0.0, y: 0.0 },
                            entity_id: target_id,
                            expected_base_revision,
                            next_revision,
                            provenance,
                            scale,
                        })
                        .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
                }
            }
            StudioBoundEntityEdit::Rotation {
                delta: angle_radians,
                ..
            } => self
                .rotate_scene_entity(RotateSceneEntityCommand {
                    angle_radians,
                    entity_id: target_id,
                    expected_base_revision,
                    next_revision,
                    pivot: base_center,
                    provenance,
                })
                .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
            StudioBoundEntityEdit::Opacity(alpha) => self
                .set_subtree_vector_paint_alpha(SetSubtreeVectorPaintAlphaCommand {
                    alpha,
                    expected_base_revision,
                    next_revision,
                    provenance,
                    root_entity_id: target_id,
                })
                .map_err(ApplyStudioBoundEntityEditError::mutation_rejected),
        }?;
        Ok(StudioBoundEntityEditResult { bundle, projection })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use poietra_scene_ir::{
        AffineTransformV1, AnimationChannelV1, EasingV1, KeyframeV1, SceneAppearanceV1,
        SceneCapabilityV1,
    };

    use super::super::tests::{NEXT_REVISION, imported_bundle};
    use super::*;

    fn bound_entity_bundle() -> SceneIrBundleV1 {
        let mut bundle = imported_bundle();
        let root_index = bundle
            .scene
            .entities
            .iter()
            .position(|entity| entity.id == "later")
            .unwrap();
        let mut child = bundle.scene.entities[root_index].clone();
        child.id = "bound-child".to_owned();
        child.parent_id = Some("later".to_owned());
        child.scene_order = 3;
        child.transform = AffineTransformV1::identity();
        let root = &mut bundle.scene.entities[root_index];
        root.appearance = SceneAppearanceV1::Group { opacity: 1.0 };
        root.geometry = SceneGeometryV1::Group {};
        root.transform = AffineTransformV1::identity();
        bundle.scene.entities.push(child);
        let mut capabilities = bundle
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::LogicalGroup);
        bundle.scene.required_capabilities = capabilities.into_iter().collect();
        bundle
    }

    #[derive(Clone, Copy)]
    enum BoundEntityTestEdit {
        Move,
        Opacity,
        Rotation,
        Scale,
        Unsupported,
    }

    impl BoundEntityTestEdit {
        fn operation(self, anchor: f64) -> StudioBoundEntityOperation {
            let depends_on = Vec::new();
            let entity_id = "source:later".to_owned();
            let id = "bound-edit".to_owned();
            let interval = IntervalV1 {
                end: anchor,
                start: anchor,
            };
            let origin = StudioAuthoringOrigin::DirectManipulation;
            match self {
                Self::Move => StudioBoundEntityOperation::Move {
                    depends_on,
                    entity_id,
                    id,
                    interval,
                    origin,
                    position: Some(PointV1 { x: 400.0, y: 220.0 }),
                },
                Self::Opacity => StudioBoundEntityOperation::Opacity {
                    alpha: Some(0.25),
                    depends_on,
                    entity_id,
                    id,
                    interval,
                    origin,
                },
                Self::Rotation => StudioBoundEntityOperation::Rotation {
                    control_present: false,
                    depends_on,
                    entity_id,
                    from: Some(0.0),
                    id,
                    interval,
                    origin,
                    relative_delta: Some(0.5),
                    to: Some(0.5),
                },
                Self::Scale => StudioBoundEntityOperation::UniformScale {
                    control_present: false,
                    depends_on,
                    entity_id,
                    from: Some(1.0),
                    id,
                    interval,
                    origin,
                    relative_factor: Some(1.5),
                    to: Some(1.5),
                },
                Self::Unsupported => StudioBoundEntityOperation::Unsupported {
                    depends_on,
                    entity_id: Some(entity_id),
                    id,
                    interval,
                    origin,
                },
            }
        }

        fn provenance_kind(self) -> &'static str {
            match self {
                Self::Move => "move",
                Self::Opacity => "opacity",
                Self::Rotation => "rotation",
                Self::Scale => "resize",
                Self::Unsupported => "unsupported",
            }
        }

        fn projection_mutation(self) -> StudioBoundEntityProjectionMutation {
            match self {
                Self::Move => StudioBoundEntityProjectionMutation::Position {
                    value: PointV1 { x: 400.0, y: 220.0 },
                },
                Self::Opacity => StudioBoundEntityProjectionMutation::Opacity { value: 0.25 },
                Self::Rotation => {
                    StudioBoundEntityProjectionMutation::Rotation { from: 0.0, to: 0.5 }
                }
                Self::Scale => {
                    StudioBoundEntityProjectionMutation::UniformScale { from: 1.0, to: 1.5 }
                }
                Self::Unsupported => unreachable!(),
            }
        }
    }

    fn studio_bound_entity_edit_command(
        bundle: &SceneIrBundleV1,
        phase: StudioBoundEntityEditPhase,
        edit: BoundEntityTestEdit,
    ) -> ApplyStudioBoundEntityEditCommand {
        let source_anchor = match phase {
            StudioBoundEntityEditPhase::Construction => 0.0,
            StudioBoundEntityEditPhase::Settled => 1.0,
        };
        ApplyStudioBoundEntityEditCommand {
            candidates: vec![StudioBoundEntityEditCandidate {
                base_center: PointV1 { x: 320.0, y: 180.0 },
                base_opacity: Some(1.0),
                capabilities: StudioBoundEntityEditCapabilities {
                    paint_opacity: phase == StudioBoundEntityEditPhase::Construction,
                    rotation: phase == StudioBoundEntityEditPhase::Construction,
                    uniform_scale: true,
                },
                evidence_id: "binding-1".to_owned(),
                phase,
                scene_entity_id: "later".to_owned(),
                source_anchor,
                studio_entity_id: "source:later".to_owned(),
            }],
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: 9.0,
                width: 16.0,
            },
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StudioBoundEntityEditInput {
                anchor_captured_playhead: source_anchor,
                anchor_resolved_seconds: source_anchor,
                anchor_source: StudioBoundEntityAnchorSource::Absolute {
                    seconds: Some(source_anchor),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![edit.operation(source_anchor)],
                origin: StudioAuthoringOrigin::DirectManipulation,
                requested_execution: StudioBoundEntityExecution::Parallel,
                schedule_edge_count: 0,
                schedule_mode: StudioBoundEntityScheduleMode::Parallel,
                schedule_order: vec!["bound-edit".to_owned()],
                transaction_id: "bound-edit".to_owned(),
            }],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn assert_bound_entity_effect(
        result: &SceneIrBundleV1,
        phase: StudioBoundEntityEditPhase,
        edit: BoundEntityTestEdit,
    ) {
        let root = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        match (phase, edit) {
            (StudioBoundEntityEditPhase::Construction, BoundEntityTestEdit::Move) => {
                assert!((root.transform.tx - 2.0).abs() < 1e-12);
                assert!((root.transform.ty + 1.0).abs() < 1e-12);
            }
            (StudioBoundEntityEditPhase::Construction, BoundEntityTestEdit::Scale) => {
                assert!((root.transform.m11 - 1.5).abs() < 1e-12);
                assert!((root.transform.m22 - 1.5).abs() < 1e-12);
            }
            (StudioBoundEntityEditPhase::Construction, BoundEntityTestEdit::Rotation) => {
                assert!((root.transform.m11 - 0.5_f64.cos()).abs() < 1e-12);
                assert!((root.transform.m12 + 0.5_f64.sin()).abs() < 1e-12);
                assert!((root.transform.m21 - 0.5_f64.sin()).abs() < 1e-12);
                assert!((root.transform.m22 - 0.5_f64.cos()).abs() < 1e-12);
            }
            (StudioBoundEntityEditPhase::Construction, BoundEntityTestEdit::Opacity) => {
                let child = result
                    .scene
                    .entities
                    .iter()
                    .find(|entity| entity.id == "bound-child")
                    .unwrap();
                let SceneAppearanceV1::Vector { fill, stroke, .. } = &child.appearance else {
                    panic!("bound fixture child must retain vector paint");
                };
                let alphas = [
                    fill.as_ref().map(|paint| paint.color.alpha),
                    stroke.as_ref().map(|paint| paint.color.alpha),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
                assert!(!alphas.is_empty());
                assert!(alphas.iter().all(|alpha| (*alpha - 0.25).abs() < 1e-12));
            }
            (
                StudioBoundEntityEditPhase::Settled,
                BoundEntityTestEdit::Move | BoundEntityTestEdit::Scale,
            ) => {
                let keyframes = result
                    .scene
                    .animation_channels
                    .iter()
                    .find_map(|channel| match channel {
                        AnimationChannelV1::AffineTransform {
                            entity_id,
                            keyframes,
                            provenance_id,
                            ..
                        } if entity_id == "later"
                            && provenance_id.starts_with("studio-bound-endpoint-settled-") =>
                        {
                            Some(keyframes)
                        }
                        _ => None,
                    })
                    .expect("settled edits must create one canonical transform channel");
                assert_eq!(keyframes.len(), 2);
                assert!((keyframes[0].at - 1.0).abs() < 1e-12);
                match edit {
                    BoundEntityTestEdit::Move => {
                        assert!((keyframes[0].value.tx - 2.0).abs() < 1e-12);
                        assert!((keyframes[0].value.ty + 1.0).abs() < 1e-12);
                    }
                    BoundEntityTestEdit::Scale => {
                        assert!((keyframes[0].value.m11 - 1.5).abs() < 1e-12);
                        assert!((keyframes[0].value.m22 - 1.5).abs() < 1e-12);
                    }
                    _ => unreachable!(),
                }
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn applies_the_six_bound_entity_endpoint_edits_through_one_authority() {
        let cases = [
            (
                StudioBoundEntityEditPhase::Construction,
                BoundEntityTestEdit::Move,
            ),
            (
                StudioBoundEntityEditPhase::Construction,
                BoundEntityTestEdit::Scale,
            ),
            (
                StudioBoundEntityEditPhase::Construction,
                BoundEntityTestEdit::Rotation,
            ),
            (
                StudioBoundEntityEditPhase::Construction,
                BoundEntityTestEdit::Opacity,
            ),
            (
                StudioBoundEntityEditPhase::Settled,
                BoundEntityTestEdit::Move,
            ),
            (
                StudioBoundEntityEditPhase::Settled,
                BoundEntityTestEdit::Scale,
            ),
        ];

        for (phase, edit) in cases {
            let bundle = bound_entity_bundle();
            let command = studio_bound_entity_edit_command(&bundle, phase, edit);
            let anchor = command.programs[0].anchor_resolved_seconds;
            let mut session = EngineSessionV1::new(bundle).unwrap();

            let result = session.apply_studio_bound_entity_edit(command).unwrap();

            let provenance_id = format!(
                "studio-bound-endpoint-{}-{}:{NEXT_REVISION}",
                phase.as_str(),
                edit.provenance_kind()
            );
            assert_eq!(result.bundle.scene.source.revision_hash(), NEXT_REVISION);
            assert!(
                result
                    .bundle
                    .scene
                    .provenance
                    .iter()
                    .any(|record| record.id == provenance_id)
            );
            assert_eq!(
                result.projection,
                StudioBoundEntityProjection {
                    interval: IntervalV1 {
                        end: anchor,
                        start: anchor,
                    },
                    mutation: edit.projection_mutation(),
                    operation_id: "bound-edit".to_owned(),
                    studio_entity_id: "source:later".to_owned(),
                    transaction_id: "bound-edit".to_owned(),
                }
            );
            assert_bound_entity_effect(&result.bundle, phase, edit);
            assert_eq!(session.retained_index_stats().build_count, 2);
        }
    }

    #[test]
    fn rejects_unsupported_or_ambiguous_bound_entity_edits_atomically() {
        for case in 0..8 {
            let mut bundle = bound_entity_bundle();
            let edit = match case {
                0 => BoundEntityTestEdit::Unsupported,
                6 => BoundEntityTestEdit::Scale,
                7 => BoundEntityTestEdit::Rotation,
                _ => BoundEntityTestEdit::Move,
            };
            let mut command = studio_bound_entity_edit_command(
                &bundle,
                StudioBoundEntityEditPhase::Construction,
                edit,
            );
            if case == 1 || case == 2 {
                let mut duplicate = command.candidates[0].clone();
                if case == 2 {
                    duplicate.studio_entity_id = "source:alias".to_owned();
                }
                command.candidates.push(duplicate);
            } else if case == 3 {
                command.programs[0]
                    .operations
                    .push(BoundEntityTestEdit::Scale.operation(0.0));
                command.programs[0]
                    .schedule_order
                    .push("bound-edit".to_owned());
            } else if case == 4 {
                command.expected_base_revision = "f".repeat(64);
            } else if case == 5 {
                let provenance_id = bundle.scene.provenance[0].id.clone();
                bundle
                    .scene
                    .animation_channels
                    .push(AnimationChannelV1::AffineTransform {
                        entity_id: "later".to_owned(),
                        id: "existing-transform".to_owned(),
                        keyframes: vec![
                            KeyframeV1 {
                                at: 0.0,
                                easing_to_next: Some(EasingV1::Linear {}),
                                value: AffineTransformV1::identity(),
                            },
                            KeyframeV1 {
                                at: bundle.scene.duration,
                                easing_to_next: None,
                                value: AffineTransformV1::identity(),
                            },
                        ],
                        provenance_id,
                    });
                let mut capabilities = bundle
                    .scene
                    .required_capabilities
                    .iter()
                    .copied()
                    .collect::<BTreeSet<_>>();
                capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
                bundle.scene.required_capabilities = capabilities.into_iter().collect();
            } else if case == 6 {
                if let StudioBoundEntityOperation::UniformScale { from, to, .. } =
                    &mut command.programs[0].operations[0]
                {
                    *from = Some(2.0);
                    *to = Some(3.0);
                }
            } else if case == 7 {
                if let StudioBoundEntityOperation::Rotation { from, to, .. } =
                    &mut command.programs[0].operations[0]
                {
                    *from = Some(0.25);
                    *to = Some(0.75);
                }
            }
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle).unwrap();

            assert!(session.apply_studio_bound_entity_edit(command).is_err());
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }
}
