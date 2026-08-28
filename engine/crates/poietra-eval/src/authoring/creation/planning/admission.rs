//! Program-family classification and closed-contract admission for Studio creation edits.

use super::super::{
    BTreeSet, ProjectStudioCreationEditError, SceneEditExecution, SceneEditScheduleMode,
    StudioAuthoringOrigin, StudioCreationEditInput, StudioCreationOperation,
    StudioCreationOperationKind, StudioCreationTimelinePlan, StudioPaintColorProperty,
    StudioPropertyEasing, TIMELINE_ANCHOR_EPSILON, closed_studio_material_parameter_track,
    closed_studio_opacity_track, closed_studio_rotation_track, closed_studio_uniform_scale_track,
    plan_studio_creation_timeline, studio_timeline_semantic_values_match,
};
use super::canonical_studio_hex_color;

const MIN_STUDIO_PAINT_COLOR_KEYFRAMES: usize = 2;
const MAX_STUDIO_PAINT_COLOR_KEYFRAMES: usize = 32;

pub(super) struct StudioCreationAdmission {
    pub(super) background_programs: Vec<usize>,
    pub(super) camera_programs: Vec<usize>,
    pub(super) create_programs: Vec<usize>,
    pub(super) followup_programs: Vec<usize>,
    pub(super) hierarchy_programs: Vec<usize>,
    pub(super) material_parameter_programs: Vec<usize>,
    pub(super) content_transform_programs: Vec<usize>,
    pub(super) opacity_programs: Vec<usize>,
    pub(super) paint_color_programs: Vec<usize>,
    pub(super) rotation_programs: Vec<usize>,
    pub(super) timeline: StudioCreationTimelinePlan,
    pub(super) uniform_scale_programs: Vec<usize>,
}

pub(super) fn closed_studio_paint_color_track(
    program: &StudioCreationEditInput,
) -> Option<(
    &str,
    StudioPaintColorProperty,
    Vec<&StudioCreationOperation>,
)> {
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
                StudioCreationOperationKind::PaintColorKeyframes { .. }
            )
            .then_some(operation)
        })
        .collect::<Vec<_>>();
    if !(MIN_STUDIO_PAINT_COLOR_KEYFRAMES - 1..=MAX_STUDIO_PAINT_COLOR_KEYFRAMES - 1)
        .contains(&operations.len())
    {
        return None;
    }
    let first = *operations.first()?;
    let entity_id = first.entity_id.as_deref()?;
    let property = match &first.kind {
        StudioCreationOperationKind::PaintColorKeyframes { property, .. } => *property,
        _ => return None,
    };
    if first.interval.start + TIMELINE_ANCHOR_EPSILON < program.anchor_resolved_seconds {
        return None;
    }
    for (index, operation) in operations.iter().enumerate() {
        let (easing, from, to) = match &operation.kind {
            StudioCreationOperationKind::PaintColorKeyframes {
                easing,
                from: Some(from),
                property: candidate_property,
                to: Some(to),
            } if *candidate_property == property => (easing, from, to),
            _ => return None,
        };
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.as_deref() != Some(entity_id)
            || !matches!(
                easing,
                StudioPropertyEasing::Linear | StudioPropertyEasing::Smooth
            )
            || canonical_studio_hex_color(from).is_none()
            || canonical_studio_hex_color(to).is_none()
            || operation.interval.end <= operation.interval.start + TIMELINE_ANCHOR_EPSILON
        {
            return None;
        }
        if let Some(previous) = index.checked_sub(1).and_then(|prior| operations.get(prior)) {
            let previous_to = match &previous.kind {
                StudioCreationOperationKind::PaintColorKeyframes {
                    property: candidate_property,
                    to: Some(previous_to),
                    ..
                } if *candidate_property == property => previous_to,
                _ => return None,
            };
            if !studio_timeline_semantic_values_match(
                previous.interval.end,
                operation.interval.start,
            ) || previous_to != from
            {
                return None;
            }
        }
    }
    Some((entity_id, property, operations))
}

#[allow(
    clippy::too_many_lines,
    reason = "one admission pass keeps cross-family closed-contract checks together"
)]
pub(super) fn admit_studio_creation_programs(
    base_duration: f64,
    programs: &[StudioCreationEditInput],
) -> Result<StudioCreationAdmission, ProjectStudioCreationEditError> {
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
    let camera_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::AnimateCamera { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    let background_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::SceneBackground { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    if create_programs.is_empty() && camera_programs.is_empty() && background_programs.is_empty() {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    if background_programs.len() > 1 {
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
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::WriteIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::PaintColorKeyframes { .. }
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
    let paint_color_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::PaintColorKeyframes { .. }
                )
            })
        })
        .collect::<Vec<_>>();
    let mut paint_color_entity_ids = BTreeSet::new();
    for index in &paint_color_programs {
        let program = &programs[*index];
        let Some((entity_id, _, _)) = closed_studio_paint_color_track(program) else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let creates_target = program.operations.iter().any(|operation| {
            matches!(
                &operation.kind,
                StudioCreationOperationKind::Create { entity } if entity.id == entity_id
            )
        });
        let contains_only_creation_scaffold_or_compatible_tracks =
            program.operations.iter().all(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::Create { .. }
                        | StudioCreationOperationKind::Position { .. }
                        | StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::PaintColorKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        if !creates_target
            || !contains_only_creation_scaffold_or_compatible_tracks
            || !paint_color_entity_ids.insert(entity_id.to_owned())
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
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::WriteIn { .. }
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
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::WriteIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::PaintColorKeyframes { .. }
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
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::WriteIn { .. }
                        | StudioCreationOperationKind::OpacityKeyframes { .. }
                        | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                        | StudioCreationOperationKind::PaintColorKeyframes { .. }
                        | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                        | StudioCreationOperationKind::RotationKeyframes { .. }
                )
            });
        if !creates_target || !contains_only_creation_scaffold_or_property_tracks {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
    }
    let content_transform_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| {
            programs[*index].operations.iter().any(|operation| {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::TransformContent { .. }
                )
            })
        })
        .collect::<Vec<_>>();
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
                && !paint_color_programs.contains(index)
                && !material_parameter_programs.contains(index)
                && !uniform_scale_programs.contains(index)
                && !rotation_programs.contains(index)
                && !content_transform_programs.contains(index)
                && !hierarchy_programs.contains(index)
                && !camera_programs.contains(index)
                && !background_programs.contains(index)
                && !timeline.duration_program_indices.contains(index)
        })
        .collect::<Vec<_>>();

    Ok(StudioCreationAdmission {
        background_programs,
        camera_programs,
        create_programs,
        followup_programs,
        hierarchy_programs,
        material_parameter_programs,
        content_transform_programs,
        opacity_programs,
        paint_color_programs,
        rotation_programs,
        timeline,
        uniform_scale_programs,
    })
}
