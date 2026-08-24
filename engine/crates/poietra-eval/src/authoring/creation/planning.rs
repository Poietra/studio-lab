//! Complete-batch planning from admitted Studio creation operations to a closed creation plan.

use super::{
    BTreeMap, BTreeSet, IntervalV1, KeyframeV1, MAX_STUDIO_STROKE_WIDTH_WORLD,
    MIN_STUDIO_STROKE_WIDTH_WORLD, PersistentSceneRemoval, PlannedStudioAnimatedResize,
    PlannedStudioCameraClip, PlannedStudioCreationEntity, PlannedStudioLogicalGroup,
    PlannedStudioMathTexTransform, PlannedStudioMotion, PlannedStudioShapeTransform,
    ProjectStudioCreationEditError, RgbaColorV1, SceneAppearanceV1, SceneEditExecution,
    SceneEditScheduleMode, StudioAuthoringDimensions, StudioAuthoringEntityKind,
    StudioAuthoringOrigin, StudioCreationEditInput, StudioCreationOperation,
    StudioCreationOperationKind, StudioCreationPlan, StudioCreationProjectedMutation,
    StudioCreationProjectedMutationKind, StudioCreationShapeState, StudioMathTexTransformStrategy,
    StudioMotionPlan, StudioMotionProjectionTarget, StudioPaintColorProperty,
    StudioPaintColorTrack, StudioPropertyEasing, TIMELINE_ANCHOR_EPSILON,
    close_transform_baseline_value, closed_studio_creation_motion_operations,
    closed_studio_group_layer_order, closed_studio_group_rotation,
    closed_studio_material_parameter_track, closed_studio_opacity_track,
    closed_studio_rotation_track, closed_studio_uniform_scale_track, interval_is_exact_point,
    motion_easing, normalize_studio_cubic_bezier, normalize_studio_svg_path_asset,
    plan_studio_creation_timeline, planned_studio_camera_animation, project_studio_motion_plan,
    property_easing, rotation_is_noop, shift_interval_for_insertion, shift_studio_creation_time,
    studio_arc_parameters, studio_authoring_point_is_finite, studio_authoring_shape_size,
    studio_camera_aspects_match, studio_camera_view_is_bounded,
    studio_camera_view_is_within_zoom_bounds, studio_camera_views_match,
    studio_coordinate_system_parameters, studio_creation_initial_appearance_end,
    studio_creation_motion_is_compatible, studio_creation_spec_text_content,
    studio_creation_supports_stroke_color_track, studio_creation_supports_stroke_width,
    studio_cubic_bezier_dimensions_are_canonical, studio_cubic_bezier_is_canonical,
    studio_data_series_is_valid, studio_ellipse_parameters, studio_math_tex_content_is_canonical,
    studio_regular_polygon_parameters, studio_shape_transform_path,
    studio_text_content_is_canonical, studio_timeline_semantic_values_match,
};

const MIN_STUDIO_PAINT_COLOR_KEYFRAMES: usize = 2;
const MAX_STUDIO_PAINT_COLOR_KEYFRAMES: usize = 32;

fn closed_studio_paint_color_track(
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

fn studio_shape_transform_pair_is_supported(
    from: StudioCreationShapeState,
    to: StudioCreationShapeState,
) -> bool {
    if studio_shape_transform_path(from.kind, from.dimensions).is_none()
        || studio_shape_transform_path(to.kind, to.dimensions).is_none()
    {
        return false;
    }
    from.kind != to.kind
        || (from.kind == StudioAuthoringEntityKind::RegularPolygon
            && from.dimensions.sides != to.dimensions.sides)
}

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one creation planner owns complete batch admission, ordering, and logical state"
)]
pub(super) fn plan_studio_creation_edits(
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
    let math_tex_transform_programs = timeline
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
                && !math_tex_transform_programs.contains(index)
                && !hierarchy_programs.contains(index)
                && !camera_programs.contains(index)
                && !background_programs.contains(index)
                && !timeline.duration_program_indices.contains(index)
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
                StudioCreationOperationKind::DrawIn {
                    easing,
                    from: Some(from),
                    to: Some(to),
                } => {
                    operation
                        .entity_id
                        .as_deref()
                        .is_none_or(|entity_id| !program_created_ids.contains(entity_id))
                        || !matches!(
                            easing,
                            StudioPropertyEasing::Linear | StudioPropertyEasing::Smooth
                        )
                        || !close_transform_baseline_value(*from, 0.0)
                        || !close_transform_baseline_value(*to, 1.0)
                        || !studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
                        || !operation.interval.end.is_finite()
                        || operation.interval.end <= operation.interval.start
                }
                StudioCreationOperationKind::WriteIn { easing } => {
                    operation
                        .entity_id
                        .as_deref()
                        .is_none_or(|entity_id| !program_created_ids.contains(entity_id))
                        || !matches!(easing, StudioPropertyEasing::Linear)
                        || !studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
                        || !operation.interval.end.is_finite()
                        || operation.interval.end <= operation.interval.start
                }
                StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::PaintColorKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. } => operation
                    .entity_id
                    .as_deref()
                    .is_none_or(|entity_id| !program_created_ids.contains(entity_id)),
                StudioCreationOperationKind::SceneBackground { .. }
                | StudioCreationOperationKind::DrawIn { .. }
                | StudioCreationOperationKind::TransformContent { .. }
                | StudioCreationOperationKind::TransformShape { .. }
                | StudioCreationOperationKind::AnimateCamera { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::StrokeCap { .. }
                | StudioCreationOperationKind::StrokeWidth { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::InsertWait { .. }
                | StudioCreationOperationKind::TrimSceneDuration { .. }
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
                | StudioCreationOperationKind::DrawIn { .. }
                | StudioCreationOperationKind::WriteIn { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::PaintColorKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                    if operation
                        .entity_id
                        .as_deref()
                        .is_some_and(|entity_id| scheduled_created_ids.contains(entity_id)) => {}
                StudioCreationOperationKind::SceneBackground { .. }
                | StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::DrawIn { .. }
                | StudioCreationOperationKind::WriteIn { .. }
                | StudioCreationOperationKind::TransformContent { .. }
                | StudioCreationOperationKind::TransformShape { .. }
                | StudioCreationOperationKind::AnimateCamera { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::PaintColorKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::StrokeCap { .. }
                | StudioCreationOperationKind::StrokeWidth { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::InsertWait { .. }
                | StudioCreationOperationKind::TrimSceneDuration { .. }
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
                    StudioAuthoringEntityKind::Arc
                        | StudioAuthoringEntityKind::Arrow
                        | StudioAuthoringEntityKind::Axes
                        | StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::CubicBezier
                        | StudioAuthoringEntityKind::DataPlot
                        | StudioAuthoringEntityKind::Ellipse
                        | StudioAuthoringEntityKind::Image
                        | StudioAuthoringEntityKind::Line
                        | StudioAuthoringEntityKind::MathTex
                        | StudioAuthoringEntityKind::NumberLine
                        | StudioAuthoringEntityKind::NumberPlane
                        | StudioAuthoringEntityKind::Rectangle
                        | StudioAuthoringEntityKind::RegularPolygon
                        | StudioAuthoringEntityKind::Sector
                        | StudioAuthoringEntityKind::SvgPath
                        | StudioAuthoringEntityKind::Text
                )
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            create_records.push((*program_index, operation_index));
        }
    }

    let mut ranked_mutations = Vec::new();
    let scene_background = if let Some(program_index) = background_programs.first().copied() {
        let program = &programs[program_index];
        if program.origin != StudioAuthoringOrigin::StudioDefault
            || program.lowering_supported
            || program.requested_execution != SceneEditExecution::Parallel
            || program.schedule_mode != SceneEditScheduleMode::Parallel
            || program.schedule_edge_count != 0
            || program.intent_count != 1
            || program.operations.len() != 1
            || program.schedule_order != [program.operations[0].id.clone()]
            || !studio_timeline_semantic_values_match(program.anchor_captured_playhead, 0.0)
            || !studio_timeline_semantic_values_match(program.anchor_resolved_seconds, 0.0)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let operation = &program.operations[0];
        let StudioCreationOperationKind::SceneBackground { color: Some(color) } = &operation.kind
        else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let background =
            canonical_studio_hex_color(color).ok_or(ProjectStudioCreationEditError::Unsupported)?;
        if operation.origin != StudioAuthoringOrigin::StudioDefault
            || operation.entity_id.is_some()
            || !operation.depends_on.is_empty()
            || !interval_is_exact_point(&operation.interval)
            || !studio_timeline_semantic_values_match(operation.interval.start, 0.0)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        ranked_mutations.push((
            timeline.ranks[program_index],
            0,
            StudioCreationProjectedMutation {
                entity_id: String::new(),
                interval: operation.interval.clone(),
                kind: StudioCreationProjectedMutationKind::SceneBackground {
                    value: color.clone(),
                },
                operation_id: operation.id.clone(),
                transaction_id: program.transaction_id.clone(),
            },
        ));
        Some(background)
    } else {
        None
    };
    let mut camera_clips = Vec::with_capacity(camera_programs.len());
    for program_index in &camera_programs {
        let program = &programs[*program_index];
        if program.origin != StudioAuthoringOrigin::DirectManipulation
            || program.requested_execution != SceneEditExecution::Sequence
            || program.schedule_mode != SceneEditScheduleMode::Sequence
            || program.schedule_edge_count != 0
            || program.intent_count != 1
            || program.operations.len() != 1
            || program.schedule_order != [program.operations[0].id.clone()]
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let operation = &program.operations[0];
        let StudioCreationOperationKind::AnimateCamera {
            easing,
            from_view,
            to_view,
        } = &operation.kind
        else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let initial_view = camera_clips
            .first()
            .map_or(from_view, |first: &PlannedStudioCameraClip| {
                &first.from_view
            });
        if operation.origin != StudioAuthoringOrigin::DirectManipulation
            || operation.entity_id.is_some()
            || !operation.depends_on.is_empty()
            || !matches!(
                easing,
                StudioPropertyEasing::Linear | StudioPropertyEasing::Smooth
            )
            || !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            )
            || !operation.interval.end.is_finite()
            || operation.interval.end <= operation.interval.start
            || !studio_camera_view_is_bounded(from_view)
            || !studio_camera_view_is_bounded(to_view)
            || !studio_camera_aspects_match(from_view, to_view)
            || !studio_camera_aspects_match(initial_view, from_view)
            || !studio_camera_view_is_within_zoom_bounds(initial_view, from_view)
            || !studio_camera_view_is_within_zoom_bounds(initial_view, to_view)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let interval = IntervalV1 {
            end: operation.interval.end + timeline.offsets[*program_index],
            start: operation.interval.start + timeline.offsets[*program_index],
        };
        if !interval.start.is_finite()
            || !interval.end.is_finite()
            || interval.end > timeline.projected_duration + TIMELINE_ANCHOR_EPSILON
            || camera_clips
                .last()
                .is_some_and(|prior: &PlannedStudioCameraClip| {
                    interval.start < prior.interval.end - TIMELINE_ANCHOR_EPSILON
                        || !studio_camera_views_match(&prior.to_view, from_view)
                        || !studio_camera_aspects_match(&prior.from_view, from_view)
                })
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let easing = property_easing(*easing);
        camera_clips.push(PlannedStudioCameraClip {
            easing: easing.clone(),
            from_view: from_view.clone(),
            interval: interval.clone(),
            to_view: to_view.clone(),
        });
        ranked_mutations.push((
            timeline.ranks[*program_index],
            0,
            StudioCreationProjectedMutation {
                entity_id: String::new(),
                interval,
                kind: StudioCreationProjectedMutationKind::AnimateCamera {
                    easing,
                    from_view: from_view.clone(),
                    to_view: to_view.clone(),
                },
                operation_id: operation.id.clone(),
                transaction_id: program.transaction_id.clone(),
            },
        ));
    }
    let camera_animation = planned_studio_camera_animation(&camera_clips);
    let mut entities = Vec::with_capacity(create_records.len());
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
        let cubic_bezier = if spec.kind == StudioAuthoringEntityKind::CubicBezier {
            let source = spec
                .cubic_bezier
                .as_ref()
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let normalized = normalize_studio_cubic_bezier(source)?;
            if !studio_cubic_bezier_is_canonical(source, &normalized)
                || !studio_cubic_bezier_dimensions_are_canonical(
                    spec.dimensions,
                    normalized.dimensions,
                )
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            Some(normalized)
        } else {
            None
        };
        let svg_path = if spec.kind == StudioAuthoringEntityKind::SvgPath {
            let svg = spec
                .svg
                .as_ref()
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            Some(normalize_studio_svg_path_asset(&svg.source)?)
        } else {
            None
        };
        let native_payload_presence_is_valid = (spec.kind == StudioAuthoringEntityKind::DataPlot)
            == spec.data_series.is_some()
            && (spec.kind == StudioAuthoringEntityKind::CubicBezier) == spec.cubic_bezier.is_some()
            && (spec.kind == StudioAuthoringEntityKind::SvgPath) == spec.svg.is_some();
        let creation_payload_is_valid = native_payload_presence_is_valid
            && match spec.kind {
                StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_authoring_shape_size(spec.kind, spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::RegularPolygon => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_regular_polygon_parameters(spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::Ellipse => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_ellipse_parameters(spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::Arc | StudioAuthoringEntityKind::Sector => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_arc_parameters(spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::Axes
                | StudioAuthoringEntityKind::NumberLine
                | StudioAuthoringEntityKind::NumberPlane => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_coordinate_system_parameters(spec.kind, spec.dimensions).is_some()
                }
                StudioAuthoringEntityKind::DataPlot => {
                    spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && studio_coordinate_system_parameters(spec.kind, spec.dimensions).is_some()
                        && spec.data_series.as_ref().is_some_and(|series| {
                            studio_data_series_is_valid(series, spec.dimensions)
                        })
                }
                StudioAuthoringEntityKind::Arrow | StudioAuthoringEntityKind::Line => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && spec.dimensions == StudioAuthoringDimensions::default()
                }
                StudioAuthoringEntityKind::MathTex => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.dimensions.angles.is_none()
                        && spec.dimensions.coordinate_system.is_none()
                        && spec.dimensions.sides.is_none()
                        && spec.tex_parts.as_ref().is_some_and(|parts| {
                            !parts.is_empty() && parts.iter().all(|part| !part.trim().is_empty())
                        })
                }
                StudioAuthoringEntityKind::Text => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.tex_parts.is_none()
                        && initial_text_content
                            .as_ref()
                            .is_some_and(studio_text_content_is_canonical)
                        && spec.dimensions == StudioAuthoringDimensions::default()
                }
                StudioAuthoringEntityKind::Image => {
                    spec.cubic_bezier.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
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
                StudioAuthoringEntityKind::SvgPath => {
                    spec.cubic_bezier.is_none()
                        && spec.image.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && svg_path
                            .as_ref()
                            .is_some_and(|asset| spec.dimensions == asset.dimensions)
                }
                StudioAuthoringEntityKind::CubicBezier => {
                    spec.image.is_none()
                        && spec.svg.is_none()
                        && spec.text.is_none()
                        && spec.layout.is_none()
                        && spec.tex_parts.is_none()
                        && cubic_bezier.is_some()
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
        let draws = program
            .operations
            .iter()
            .filter(|operation| operation.entity_id.as_deref() == Some(spec.id.as_str()))
            .filter_map(|operation| match &operation.kind {
                StudioCreationOperationKind::DrawIn { easing, .. } => Some((operation, *easing)),
                _ => None,
            })
            .collect::<Vec<_>>();
        let writes = program
            .operations
            .iter()
            .filter(|operation| operation.entity_id.as_deref() == Some(spec.id.as_str()))
            .filter_map(|operation| match &operation.kind {
                StudioCreationOperationKind::WriteIn { easing } => Some((operation, *easing)),
                _ => None,
            })
            .collect::<Vec<_>>();
        if positions.len() != 1
            || fades.len() > 1
            || draws.len() > 1
            || writes.len() > 1
            || fades.len() + draws.len() + writes.len() > 1
        {
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
        let mut draw_interval = draws.first().map(|(draw, _)| IntervalV1 {
            end: draw.interval.end + program_offset,
            start: draw.interval.start + program_offset,
        });
        if let Some(draw) = &mut draw_interval {
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(draw, insertion);
                }
            }
        }
        if draw_interval.as_ref().is_some_and(|draw| {
            !matches!(
                spec.kind,
                StudioAuthoringEntityKind::Arc
                    | StudioAuthoringEntityKind::Axes
                    | StudioAuthoringEntityKind::Circle
                    | StudioAuthoringEntityKind::CubicBezier
                    | StudioAuthoringEntityKind::DataPlot
                    | StudioAuthoringEntityKind::Ellipse
                    | StudioAuthoringEntityKind::Line
                    | StudioAuthoringEntityKind::NumberLine
                    | StudioAuthoringEntityKind::NumberPlane
                    | StudioAuthoringEntityKind::Rectangle
                    | StudioAuthoringEntityKind::RegularPolygon
                    | StudioAuthoringEntityKind::Sector
                    | StudioAuthoringEntityKind::SvgPath
            ) || (spec.kind == StudioAuthoringEntityKind::SvgPath
                && !svg_path.as_ref().is_some_and(|asset| {
                    matches!(
                        &asset.appearance,
                        SceneAppearanceV1::Vector {
                            fill: None,
                            stroke: Some(_),
                            ..
                        }
                    )
                }))
                || !studio_timeline_semantic_values_match(draw.start, lifetime.start)
                || draw.end > lifetime.end
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let draw_easing = draws.first().map(|(_, easing)| property_easing(*easing));
        if let (Some((draw, _)), Some(interval), Some(easing)) =
            (draws.first(), draw_interval.as_ref(), draw_easing.as_ref())
        {
            let draw_order = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &draw.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                draw_order,
                StudioCreationProjectedMutation {
                    entity_id: spec.id.clone(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::DrawIn {
                        easing: easing.clone(),
                        from: 0.0,
                        to: 1.0,
                    },
                    operation_id: draw.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
        }
        let mut write_interval = writes.first().map(|(write, _)| IntervalV1 {
            end: write.interval.end + program_offset,
            start: write.interval.start + program_offset,
        });
        if let Some(write) = &mut write_interval {
            for (rank, insertion) in &timeline.ranked_insertions {
                if *rank > program_rank {
                    shift_interval_for_insertion(write, insertion);
                }
            }
        }
        if write_interval.as_ref().is_some_and(|write| {
            spec.kind != StudioAuthoringEntityKind::MathTex
                || !studio_timeline_semantic_values_match(write.start, lifetime.start)
                || write.end > lifetime.end
        }) {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let write_easing = writes.first().map(|(_, easing)| property_easing(*easing));
        if let (Some((write, _)), Some(interval), Some(easing)) = (
            writes.first(),
            write_interval.as_ref(),
            write_easing.as_ref(),
        ) {
            let write_order = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &write.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                write_order,
                StudioCreationProjectedMutation {
                    entity_id: spec.id.clone(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::WriteIn {
                        easing: easing.clone(),
                        from: 0.0,
                        to: 1.0,
                    },
                    operation_id: write.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
        }
        entities.push(PlannedStudioCreationEntity {
            animated_resize: None,
            appearance_at: None,
            create_operation_id: create_operation.id.clone(),
            creation_program_rank: program_rank,
            cubic_bezier,
            creation_transaction_id: program.transaction_id.clone(),
            current_dimensions: spec.dimensions,
            current_shape: matches!(
                spec.kind,
                StudioAuthoringEntityKind::Circle
                    | StudioAuthoringEntityKind::Ellipse
                    | StudioAuthoringEntityKind::Rectangle
                    | StudioAuthoringEntityKind::RegularPolygon
            )
            .then_some(StudioCreationShapeState {
                dimensions: spec.dimensions,
                kind: spec.kind,
            }),
            current_text_content: initial_text_content,
            fill_color_override: None,
            current_opacity: 1.0,
            current_rotation: 0.0,
            draw_easing,
            draw_interval,
            stroke_color_override: None,
            stroke_cap_override: None,
            stroke_width_world_override: None,
            fade_interval,
            has_position_or_resize_instant: false,
            initial_dimensions: spec.dimensions,
            initial_position: initial_position.clone(),
            instant_at: None,
            instant_rotation: 0.0,
            kind: spec.kind,
            lifetime,
            material_parameter_keyframes: Vec::new(),
            math_tex_transforms: Vec::new(),
            opacity_keyframes: Vec::new(),
            paint_color_track: None,
            persistent_removal: None,
            position: initial_position.clone(),
            rotation_keyframes: Vec::new(),
            scale: 1.0,
            shape_path_dimensions: matches!(
                spec.kind,
                StudioAuthoringEntityKind::Circle
                    | StudioAuthoringEntityKind::Ellipse
                    | StudioAuthoringEntityKind::Rectangle
                    | StudioAuthoringEntityKind::RegularPolygon
            )
            .then_some(spec.dimensions),
            shape_transforms: Vec::new(),
            uniform_scale_keyframes: Vec::new(),
            source_z_index: None,
            spec: spec.clone(),
            svg_path,
            visible: true,
            write_easing,
            write_interval,
        });
    }

    let mut math_tex_transform_target_ids = created_ids
        .iter()
        .map(|id| (*id).to_owned())
        .collect::<BTreeSet<_>>();
    let mut math_tex_transform_root_by_identity = created_ids
        .iter()
        .map(|id| ((*id).to_owned(), (*id).to_owned()))
        .collect::<BTreeMap<_, _>>();
    let mut current_math_tex_transform_identity = created_ids
        .iter()
        .map(|id| ((*id).to_owned(), (*id).to_owned()))
        .collect::<BTreeMap<_, _>>();
    for program_index in math_tex_transform_programs {
        let program = &programs[program_index];
        if program.operations.len() != 1
            || program.schedule_order != [program.operations[0].id.clone()]
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let operation = &program.operations[0];
        let StudioCreationOperationKind::TransformContent {
            easing,
            replacement,
            source_entity_id,
            strategy,
            target_entity_id,
            target_type,
        } = &operation.kind
        else {
            return Err(ProjectStudioCreationEditError::Unsupported);
        };
        let entity_id = operation
            .entity_id
            .as_deref()
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let source_root_id = math_tex_transform_root_by_identity
            .get(source_entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        let interval = IntervalV1 {
            end: operation.interval.end + timeline.offsets[program_index],
            start: operation.interval.start + timeline.offsets[program_index],
        };
        if state.creation_program_rank >= program_rank
            || state.kind != StudioAuthoringEntityKind::MathTex
            || operation.origin != StudioAuthoringOrigin::DirectManipulation
            || source_root_id != entity_id
            || current_math_tex_transform_identity.get(entity_id) != Some(source_entity_id)
            || *strategy != StudioMathTexTransformStrategy::ReplacementTransform
            || target_type.as_deref().is_some_and(|kind| kind != "MathTex")
            || !target_entity_id.starts_with(&format!("tx:{}/entity:", program.transaction_id))
            || !math_tex_transform_target_ids.insert(target_entity_id.clone())
            || !studio_math_tex_content_is_canonical(replacement)
            || !matches!(
                easing,
                StudioPropertyEasing::Linear | StudioPropertyEasing::Smooth
            )
            || !studio_timeline_semantic_values_match(
                operation.interval.start,
                program.anchor_resolved_seconds,
            )
            || interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
            || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
            || interval.end <= interval.start
            || studio_creation_initial_appearance_end(state)
                .is_some_and(|end| interval.start < end - TIMELINE_ANCHOR_EPSILON)
            || state
                .math_tex_transforms
                .last()
                .is_some_and(|prior| interval.start < prior.interval.end - TIMELINE_ANCHOR_EPSILON)
            || state.persistent_removal.as_ref().is_some_and(|removal| {
                interval.end > removal.interval.start + TIMELINE_ANCHOR_EPSILON
            })
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let planned = PlannedStudioMathTexTransform {
            content: replacement.clone(),
            easing: property_easing(*easing),
            interval: interval.clone(),
            operation_id: operation.id.clone(),
            source_entity_id: source_entity_id.clone(),
            target_entity_id: target_entity_id.clone(),
            transaction_id: program.transaction_id.clone(),
        };
        math_tex_transform_root_by_identity.insert(target_entity_id.clone(), entity_id.to_owned());
        current_math_tex_transform_identity.insert(entity_id.to_owned(), target_entity_id.clone());
        ranked_mutations.push((
            program_rank,
            0,
            StudioCreationProjectedMutation {
                entity_id: entity_id.to_owned(),
                interval,
                kind: StudioCreationProjectedMutationKind::MathTexTransform {
                    content: planned.content.clone(),
                    easing: planned.easing.clone(),
                    source_entity_id: planned.source_entity_id.clone(),
                    target_entity_id: planned.target_entity_id.clone(),
                },
                operation_id: planned.operation_id.clone(),
                transaction_id: planned.transaction_id.clone(),
            },
        ));
        state.math_tex_transforms.push(planned);
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| interval.start <= end + TIMELINE_ANCHOR_EPSILON)
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| interval.start <= end + TIMELINE_ANCHOR_EPSILON)
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| interval.start <= end + TIMELINE_ANCHOR_EPSILON)
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| interval.start <= end + TIMELINE_ANCHOR_EPSILON)
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
    let mut oriented_entity_ids = BTreeSet::new();
    let mut spun_entity_ids = BTreeSet::new();
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
            let operation_count = operations.len();
            let mut parallel_bucket_start: Option<f64> = None;
            let mut parallel_targets = BTreeSet::new();
            for operation in operations {
                let StudioCreationOperationKind::CreateMotion {
                    control_offset,
                    delta,
                    easing,
                    orient_to_path,
                    rotation_delta_radians,
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
                let spin_requested = rotation_delta_radians.is_some();
                let planned_rotation_delta = rotation_delta_radians
                    .as_ref()
                    .copied()
                    .filter(|delta| delta.is_finite() && *delta != 0.0);
                if spin_requested != planned_rotation_delta.is_some()
                    || (planned_rotation_delta.is_some() || *orient_to_path)
                        && (operation_count != 1 || target_entity_ids.len() != 1)
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
                let projected_interval = IntervalV1 {
                    end: operation.interval.end + timeline.offsets[program_index],
                    start: operation.interval.start + timeline.offsets[program_index],
                };
                planned_motions.push(PlannedStudioMotion {
                    base_interval: operation.interval.clone(),
                    control_offset: control_offset.clone(),
                    delta: delta.clone(),
                    easing: *easing,
                    interval: projected_interval.clone(),
                    operation_id: operation.id.clone(),
                    orient_to_path: *orient_to_path,
                    parallel: program.requested_execution == SceneEditExecution::Parallel,
                    target_entity_ids: target_entity_ids.clone(),
                    transaction_id: program.transaction_id.clone(),
                });
                if *orient_to_path && !oriented_entity_ids.insert(target_entity_ids[0].clone()) {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
                if let Some(rotation_delta_radians) = planned_rotation_delta {
                    let entity_id = &target_entity_ids[0];
                    let state = entities
                        .iter_mut()
                        .find(|state| state.spec.id == *entity_id)
                        .ok_or(ProjectStudioCreationEditError::Unsupported)?;
                    if !spun_entity_ids.insert(entity_id.clone())
                        || !state.rotation_keyframes.is_empty()
                        || !state.uniform_scale_keyframes.is_empty()
                        || state.persistent_removal.is_some()
                    {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    let easing = motion_easing(*easing);
                    state.rotation_keyframes = vec![
                        KeyframeV1 {
                            at: projected_interval.start,
                            easing_to_next: Some(easing.clone()),
                            value: 0.0,
                        },
                        KeyframeV1 {
                            at: projected_interval.end,
                            easing_to_next: None,
                            value: rotation_delta_radians,
                        },
                    ];
                    let schedule_index = program
                        .schedule_order
                        .iter()
                        .position(|operation_id| operation_id == &operation.id)
                        .ok_or(ProjectStudioCreationEditError::Unsupported)?;
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.clone(),
                            interval: projected_interval,
                            kind: StudioCreationProjectedMutationKind::RotationKeyframes {
                                easing,
                                from: 0.0,
                                to: rotation_delta_radians,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
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
        let contains_shape_transform = program.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                StudioCreationOperationKind::TransformShape { .. }
            )
        });
        if contains_shape_transform
            && (program.origin != StudioAuthoringOrigin::DirectManipulation
                || program.requested_execution != SceneEditExecution::Sequence
                || program.schedule_mode != SceneEditScheduleMode::Sequence
                || program.schedule_edge_count != 0
                || program.intent_count != 1
                || program.operations.len() != 1
                || program.schedule_order != [program.operations[0].id.clone()])
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
                                | StudioAuthoringEntityKind::Ellipse
                                | StudioAuthoringEntityKind::MathTex
                                | StudioAuthoringEntityKind::Rectangle
                                | StudioAuthoringEntityKind::RegularPolygon
                                | StudioAuthoringEntityKind::Sector
                                | StudioAuthoringEntityKind::Text
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
                    let initial_solid_glyph_fill =
                        studio_creation_supports_solid_glyph_fill(state.kind)
                            && (state.fade_interval.is_some() || state.write_interval.is_some());
                    if !initial_solid_glyph_fill {
                        record_planned_studio_creation_appearance(state, instant_at)?;
                    }
                    state.fill_color_override = Some(color.clone());
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: if initial_solid_glyph_fill {
                                IntervalV1 {
                                    end: state.lifetime.start,
                                    start: state.lifetime.start,
                                }
                            } else {
                                instant_interval
                            },
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
                            StudioAuthoringEntityKind::Arc
                                | StudioAuthoringEntityKind::Arrow
                                | StudioAuthoringEntityKind::Axes
                                | StudioAuthoringEntityKind::Circle
                                | StudioAuthoringEntityKind::CubicBezier
                                | StudioAuthoringEntityKind::DataPlot
                                | StudioAuthoringEntityKind::Ellipse
                                | StudioAuthoringEntityKind::Line
                                | StudioAuthoringEntityKind::NumberLine
                                | StudioAuthoringEntityKind::NumberPlane
                                | StudioAuthoringEntityKind::Rectangle
                                | StudioAuthoringEntityKind::RegularPolygon
                                | StudioAuthoringEntityKind::Sector
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
                    let initial_draw_stroke = state.draw_interval.is_some();
                    if !initial_draw_stroke {
                        record_planned_studio_creation_appearance(state, instant_at)?;
                    }
                    state.stroke_color_override = Some(color.clone());
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: if initial_draw_stroke {
                                IntervalV1 {
                                    end: state.lifetime.start,
                                    start: state.lifetime.start,
                                }
                            } else {
                                instant_interval
                            },
                            kind: StudioCreationProjectedMutationKind::StrokeColor {
                                value: color.clone(),
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::StrokeWidth {
                    width_world: Some(width_world),
                } if operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && studio_creation_supports_stroke_width(state.kind)
                    && width_world.is_finite()
                    && (MIN_STUDIO_STROKE_WIDTH_WORLD..=MAX_STUDIO_STROKE_WIDTH_WORLD)
                        .contains(width_world)
                    && state.stroke_width_world_override != Some(*width_world)
                    && studio_timeline_semantic_values_match(
                        operation.interval.start,
                        program.anchor_resolved_seconds,
                    )
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
                    state.stroke_width_world_override = Some(*width_world);
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: IntervalV1 {
                                start: state.lifetime.start,
                                end: state.lifetime.start,
                            },
                            kind: StudioCreationProjectedMutationKind::StrokeWidth {
                                value: *width_world,
                            },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::StrokeCap { cap: Some(cap) }
                    if operation.origin == StudioAuthoringOrigin::DirectManipulation
                        && state.kind == StudioAuthoringEntityKind::Line
                        && state.stroke_cap_override != Some(*cap)
                        && studio_timeline_semantic_values_match(
                            operation.interval.start,
                            program.anchor_resolved_seconds,
                        )
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
                    state.stroke_cap_override = Some(*cap);
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval: IntervalV1 {
                                start: state.lifetime.start,
                                end: state.lifetime.start,
                            },
                            kind: StudioCreationProjectedMutationKind::StrokeCap { value: *cap },
                            operation_id: operation.id.clone(),
                            transaction_id: program.transaction_id.clone(),
                        },
                    ));
                }
                StudioCreationOperationKind::TransformShape {
                    easing,
                    from_dimensions,
                    from_shape,
                    to_dimensions,
                    to_shape,
                } if operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && entity_id == state.spec.id
                    && state.current_shape
                        == Some(StudioCreationShapeState {
                            dimensions: *from_dimensions,
                            kind: *from_shape,
                        })
                    && state.shape_path_dimensions == Some(*from_dimensions)
                    && studio_shape_transform_pair_is_supported(
                        StudioCreationShapeState {
                            dimensions: *from_dimensions,
                            kind: *from_shape,
                        },
                        StudioCreationShapeState {
                            dimensions: *to_dimensions,
                            kind: *to_shape,
                        },
                    )
                    && matches!(
                        easing,
                        StudioPropertyEasing::Linear | StudioPropertyEasing::Smooth
                    )
                    && operation.interval.end.is_finite()
                    && operation.interval.end > operation.interval.start
                    && state.persistent_removal.is_none() =>
                {
                    let interval = IntervalV1 {
                        end: operation.interval.end + timeline.offsets[program_index],
                        start: operation.interval.start + timeline.offsets[program_index],
                    };
                    if interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                        || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                        || studio_creation_initial_appearance_end(state)
                            .is_some_and(|end| interval.start < end - TIMELINE_ANCHOR_EPSILON)
                        || state.shape_transforms.last().is_some_and(|prior| {
                            interval.start < prior.interval.end - TIMELINE_ANCHOR_EPSILON
                        })
                    {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    let from = StudioCreationShapeState {
                        dimensions: *from_dimensions,
                        kind: *from_shape,
                    };
                    let to = StudioCreationShapeState {
                        dimensions: *to_dimensions,
                        kind: *to_shape,
                    };
                    let easing = property_easing(*easing);
                    state.shape_transforms.push(PlannedStudioShapeTransform {
                        easing: easing.clone(),
                        from,
                        interval: interval.clone(),
                        operation_id: operation.id.clone(),
                        to,
                        transaction_id: program.transaction_id.clone(),
                    });
                    state.current_dimensions = *to_dimensions;
                    state.current_shape = Some(to);
                    state.shape_path_dimensions = Some(*to_dimensions);
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval,
                            kind: StudioCreationProjectedMutationKind::ShapeTransform {
                                easing,
                                from_dimensions: *from_dimensions,
                                from_shape: *from_shape,
                                to_dimensions: *to_dimensions,
                                to_shape: *to_shape,
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
                } if state
                    .current_shape
                    .is_some_and(|current| current.kind == *shape)
                    && operation.origin == StudioAuthoringOrigin::DirectManipulation
                    && matches!(
                        shape,
                        StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle
                    )
                    && rotation_is_noop(state.instant_rotation)
                    && *from_dimensions == state.current_dimensions
                    && studio_authoring_shape_size(*shape, *from_dimensions).is_some()
                    && studio_authoring_point_is_finite(from_position)
                    && close_transform_baseline_value(from_position.x, state.position.x)
                    && close_transform_baseline_value(from_position.y, state.position.y)
                    && from_scale.is_finite()
                    && *from_scale > 0.0
                    && close_transform_baseline_value(*from_scale, state.scale)
                    && studio_authoring_shape_size(*shape, *to_dimensions).is_some()
                    && studio_authoring_point_is_finite(to_position) =>
                {
                    let animated =
                        operation.interval.end > operation.interval.start + TIMELINE_ANCHOR_EPSILON;
                    let interval = if animated {
                        let mut interval = IntervalV1 {
                            end: operation.interval.end + timeline.offsets[program_index],
                            start: operation.interval.start + timeline.offsets[program_index],
                        };
                        for (rank, insertion) in &timeline.ranked_insertions {
                            if *rank > timeline.ranks[program_index] {
                                shift_interval_for_insertion(&mut interval, insertion);
                            }
                        }
                        interval
                    } else {
                        if !studio_timeline_semantic_values_match(
                            operation.interval.end,
                            program.anchor_resolved_seconds,
                        ) {
                            return Err(ProjectStudioCreationEditError::Unsupported);
                        }
                        instant_interval
                    };
                    if animated {
                        if program.origin != StudioAuthoringOrigin::DirectManipulation
                            || program.requested_execution != SceneEditExecution::Sequence
                            || program.schedule_mode != SceneEditScheduleMode::Sequence
                            || program.schedule_edge_count != 0
                            || program.intent_count != 1
                            || program.operations.len() != 1
                            || program.schedule_order != [operation.id.clone()]
                            || interval.start < state.lifetime.start - TIMELINE_ANCHOR_EPSILON
                            || interval.end > state.lifetime.end + TIMELINE_ANCHOR_EPSILON
                            || studio_creation_initial_appearance_end(state)
                                .is_some_and(|end| interval.start < end - TIMELINE_ANCHOR_EPSILON)
                            || state.instant_at.is_some()
                            || state.animated_resize.is_some()
                            || !state.shape_transforms.is_empty()
                            || !state.uniform_scale_keyframes.is_empty()
                            || !state.rotation_keyframes.is_empty()
                            || !rotation_is_noop(state.current_rotation)
                            || !rotation_is_noop(state.instant_rotation)
                            || state.persistent_removal.is_some()
                        {
                            return Err(ProjectStudioCreationEditError::Unsupported);
                        }
                        state.animated_resize = Some(PlannedStudioAnimatedResize {
                            from_dimensions: *from_dimensions,
                            from_position: from_position.clone(),
                            interval: interval.clone(),
                            shape: *shape,
                            to_dimensions: *to_dimensions,
                            to_position: to_position.clone(),
                        });
                    } else {
                        record_planned_studio_creation_instant(state, instant_at)?;
                        state.has_position_or_resize_instant = true;
                    }
                    state.current_dimensions = *to_dimensions;
                    state.current_shape = Some(StudioCreationShapeState {
                        dimensions: *to_dimensions,
                        kind: *shape,
                    });
                    state.position = to_position.clone();
                    ranked_mutations.push((
                        timeline.ranks[program_index],
                        schedule_index,
                        StudioCreationProjectedMutation {
                            entity_id: entity_id.to_owned(),
                            interval,
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
                | StudioCreationOperationKind::SceneBackground { .. }
                | StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::DrawIn { .. }
                | StudioCreationOperationKind::WriteIn { .. }
                | StudioCreationOperationKind::TransformContent { .. }
                | StudioCreationOperationKind::TransformShape { .. }
                | StudioCreationOperationKind::AnimateCamera { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Rotation { .. }
                | StudioCreationOperationKind::Opacity { .. }
                | StudioCreationOperationKind::SourceZIndex { .. }
                | StudioCreationOperationKind::Visibility { .. }
                | StudioCreationOperationKind::OpacityKeyframes { .. }
                | StudioCreationOperationKind::MaterialParameterKeyframes { .. }
                | StudioCreationOperationKind::PaintColorKeyframes { .. }
                | StudioCreationOperationKind::UniformScaleKeyframes { .. }
                | StudioCreationOperationKind::RotationKeyframes { .. }
                | StudioCreationOperationKind::FillColor { .. }
                | StudioCreationOperationKind::StrokeColor { .. }
                | StudioCreationOperationKind::StrokeCap { .. }
                | StudioCreationOperationKind::StrokeWidth { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Group { .. }
                | StudioCreationOperationKind::Ungroup { .. }
                | StudioCreationOperationKind::InsertWait { .. }
                | StudioCreationOperationKind::TrimSceneDuration { .. }
                | StudioCreationOperationKind::Unsupported => {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
            }
        }
    }

    for program_index in paint_color_programs {
        let program = &programs[program_index];
        let (entity_id, property, track_operations) = closed_studio_paint_color_track(program)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let state = entities
            .iter_mut()
            .find(|state| state.spec.id == entity_id)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        let program_rank = timeline.ranks[program_index];
        let baseline = match property {
            StudioPaintColorProperty::FillColor
                if matches!(
                    state.kind,
                    StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::Ellipse
                        | StudioAuthoringEntityKind::MathTex
                        | StudioAuthoringEntityKind::Rectangle
                        | StudioAuthoringEntityKind::RegularPolygon
                        | StudioAuthoringEntityKind::Text
                ) =>
            {
                state.fill_color_override.as_deref()
            }
            StudioPaintColorProperty::StrokeColor
                if studio_creation_supports_stroke_color_track(state.kind) =>
            {
                Some(state.stroke_color_override.as_deref().unwrap_or("#ffffff"))
            }
            StudioPaintColorProperty::FillColor | StudioPaintColorProperty::StrokeColor => None,
        };
        let baseline_color = baseline
            .and_then(canonical_studio_hex_color)
            .ok_or(ProjectStudioCreationEditError::Unsupported)?;
        if state.creation_program_rank > program_rank
            || (state.creation_program_rank == program_rank
                && state.creation_transaction_id != program.transaction_id)
            || state.paint_color_track.is_some()
            || !state.material_parameter_keyframes.is_empty()
            || state.write_interval.is_some()
            || state.persistent_removal.is_some()
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut projected = Vec::with_capacity(track_operations.len());
        for operation in track_operations {
            let StudioCreationOperationKind::PaintColorKeyframes {
                easing,
                from: Some(from),
                property: operation_property,
                to: Some(to),
            } = &operation.kind
            else {
                unreachable!();
            };
            if *operation_property != property {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| interval.start <= end + TIMELINE_ANCHOR_EPSILON)
            {
                return Err(ProjectStudioCreationEditError::Unsupported);
            }
            let schedule_index = program
                .schedule_order
                .iter()
                .position(|operation_id| operation_id == &operation.id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let from_color = canonical_studio_hex_color(from)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let to_color = canonical_studio_hex_color(to)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            ranked_mutations.push((
                program_rank,
                schedule_index,
                StudioCreationProjectedMutation {
                    entity_id: entity_id.to_owned(),
                    interval: interval.clone(),
                    kind: StudioCreationProjectedMutationKind::PaintColorKeyframes {
                        easing: property_easing(*easing),
                        from: from.clone(),
                        property,
                        to: to.clone(),
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                },
            ));
            projected.push((interval, *easing, from_color, to_color));
        }
        if projected
            .first()
            .is_none_or(|(_, _, from, _)| from != &baseline_color)
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        let mut keyframes = Vec::with_capacity(projected.len() + 1);
        for (index, (interval, easing, from, to)) in projected.iter().enumerate() {
            if index == 0 {
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: Some(property_easing(*easing)),
                    value: from.clone(),
                });
            }
            keyframes.push(KeyframeV1 {
                at: interval.end,
                easing_to_next: projected
                    .get(index + 1)
                    .map(|(_, next_easing, _, _)| property_easing(*next_easing)),
                value: to.clone(),
            });
        }
        state.paint_color_track = Some(StudioPaintColorTrack {
            keyframes,
            property,
        });
    }

    if spun_entity_ids
        .iter()
        .chain(&oriented_entity_ids)
        .any(|entity_id| {
            planned_motions
                .iter()
                .filter(|motion| motion.target_entity_ids.iter().any(|id| id == entity_id))
                .count()
                != 1
        })
    {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }

    for state in &entities {
        if (state.animated_resize.is_some()
            && (state.instant_at.is_some()
                || !state.shape_transforms.is_empty()
                || !state.uniform_scale_keyframes.is_empty()
                || !state.rotation_keyframes.is_empty()
                || !rotation_is_noop(state.current_rotation)
                || !rotation_is_noop(state.instant_rotation)))
            || (!state.rotation_keyframes.is_empty()
                && (!state.uniform_scale_keyframes.is_empty()
                    || state.instant_at.is_some()
                    || !rotation_is_noop(state.current_rotation)
                    || !rotation_is_noop(state.instant_rotation)))
            || (!state.uniform_scale_keyframes.is_empty()
                && (state.instant_at.is_some()
                    || !rotation_is_noop(state.current_rotation)
                    || !rotation_is_noop(state.instant_rotation)))
            || (spun_entity_ids.contains(&state.spec.id) && state.persistent_removal.is_some())
            || (!rotation_is_noop(state.current_rotation) && state.instant_at.is_some())
            || (!rotation_is_noop(state.instant_rotation) && state.instant_at.is_none())
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if state.appearance_at.is_some_and(|at| {
            at < state.lifetime.start
                || at >= state.lifetime.end
                || studio_creation_initial_appearance_end(state).is_some_and(|end| at < end)
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
                || studio_creation_initial_appearance_end(state)
                    .is_some_and(|end| removal.interval.start < end)
                || state
                    .instant_at
                    .is_some_and(|at| removal.interval.start < at)
                || state.math_tex_transforms.last().is_some_and(|transform| {
                    removal.interval.start < transform.interval.end - TIMELINE_ANCHOR_EPSILON
                })
                || state.shape_transforms.last().is_some_and(|transform| {
                    removal.interval.start < transform.interval.end - TIMELINE_ANCHOR_EPSILON
                })
                || state.animated_resize.as_ref().is_some_and(|resize| {
                    removal.interval.start < resize.interval.end - TIMELINE_ANCHOR_EPSILON
                }))
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

    if entities.iter().any(|state| {
        state.draw_interval.is_some()
            && (state.fill_color_override.is_some()
                || !state.material_parameter_keyframes.is_empty()
                || groups
                    .iter()
                    .any(|group| group.child_entity_ids.contains(&state.spec.id)))
    }) {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }

    for motion in &planned_motions {
        for entity_id in &motion.target_entity_ids {
            let state = entities
                .iter()
                .find(|state| state.spec.id == *entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            if (!state.rotation_keyframes.is_empty() && !spun_entity_ids.contains(entity_id))
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
                    position: state.position.clone(),
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
        camera_animation,
        duration_trim_barrier_operation_ids: timeline.duration_trim_barrier_operation_ids,
        entities,
        groups,
        motion_projection,
        mutations: ranked_mutations
            .into_iter()
            .map(|(_, _, mutation)| mutation)
            .collect(),
        scene_background,
        timeline_insertions: timeline
            .ranked_insertions
            .into_iter()
            .map(|(_, insertion)| insertion)
            .collect(),
        timeline_projection: timeline.timeline_projection,
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

pub(super) fn canonical_studio_hex_color(value: &str) -> Option<RgbaColorV1> {
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

fn studio_creation_supports_solid_glyph_fill(kind: StudioAuthoringEntityKind) -> bool {
    matches!(
        kind,
        StudioAuthoringEntityKind::MathTex | StudioAuthoringEntityKind::Text
    )
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
