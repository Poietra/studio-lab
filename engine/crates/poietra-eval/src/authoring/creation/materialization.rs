//! Closed-command validation and atomic Scene IR materialization for Studio creation.

use super::path_motion::append_studio_path_motions;
use super::{
    AffineTransformV1, AnimationChannelV1, ApplyStudioCreationEditCommand,
    ApplyStudioCreationEditError, BTreeMap, BTreeSet, ContractVersionV1,
    CreateSceneEntitiesCommand, CreateSceneEntitiesError, CreateSceneEntity,
    CreateSceneEntityAnimatedResize, CreateSceneEntityDrawIn, CreateSceneEntityFadeIn,
    CreateSceneEntityGeometry, CreateSceneEntityInstantTransform, CreateSceneEntityMathTexMorph,
    CreateSceneEntityPathMorph, CreateSceneEntityTextGlyphMorph, CreateSceneEntityTextGlyphOrigin,
    CreateSceneEntityTextMorph, CreateSceneEntityWriteFragment, CreateSceneEntityWriteIn,
    CreateSceneEntityWritePlan, CreateScenePathMotion, CubicPathV1, EasingV1, EngineSessionV1,
    FidelityV1, FillRuleV1, FillStyleV1, FragmentMaterialPaintTargetV1, IntervalV1, KeyframeV1,
    MAX_FRAGMENT_MATERIAL_PARAMETERS_V1, MAX_STROKE_DASH_WORLD_V1, MAX_STUDIO_STROKE_WIDTH_WORLD,
    MIN_STROKE_DASH_WORLD_V1, MIN_STUDIO_STROKE_WIDTH_WORLD, PathTrimParameterizationV1,
    PlannedSceneMotion, PlannedStudioCameraAnimation, PlannedStudioCreationEntity,
    PlannedStudioLogicalGroup, PointV1, ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1,
    SEGMENTED_MATH_TEX_MAX_FRAGMENTS, SEGMENTED_MATH_TEX_MAX_SOURCE_BYTES,
    STUDIO_WRITE_MAX_CUBIC_SEGMENTS, STUDIO_WRITE_MAX_FRAGMENTS, STUDIO_WRITE_OUTLINE_STROKE_WIDTH,
    STUDIO_WRITE_PHASE_BOUNDARY, SceneAppearanceV1, SceneCameraViewV1, SceneCapabilityV1,
    SceneEntityV1, SceneGeometryV1, SceneIrBundleV1, SceneSourceV1, StudioAuthoringDimensions,
    StudioAuthoringEditResult, StudioAuthoringEntityKind, StudioCreationMathTexOutline,
    StudioCreationSegmentedMathTexOutline, StudioCreationSegmentedMathTexRepresentation,
    StudioCreationSegmentedMathTexSourceCorrelation,
    StudioCreationSegmentedMathTexSourceCorrelationKind, StudioCreationShapeState,
    StudioCreationSpatialContext, StudioCreationTextOutline, StudioCreationTextOutlineFragment,
    StudioMaterialParameterTrack, StudioPaintColorProperty, StudioPersistentRemoveProjection,
    StudioTextOutlineSourceCorrelationKind, TIMELINE_ANCHOR_EPSILON, VecDeque,
    VectorAppearanceValueV1, align_cubic_path_morph_chain, append_planned_scene_motions,
    apply_persistent_scene_removals, apply_world_rotation, authored_motion_easing,
    canonical_studio_hex_color, canonical_studio_rectangle_dimensions,
    close_transform_baseline_value, created_geometry_and_appearance, insert_scene_time, is_nfc,
    manim_stroke_width_to_scene_world, plan_studio_creation_edits,
    planned_studio_creation_has_affine_instant, rotation_is_noop, scale_cubic_path,
    set_vector_paint_alpha, studio_arc_parameters, studio_arc_path, studio_authoring_shape_size,
    studio_authoring_size_is_positive, studio_camera_aspects_match, studio_camera_view_is_bounded,
    studio_camera_view_is_within_zoom_bounds, studio_camera_views_match,
    studio_coordinate_system_parameters, studio_coordinate_system_path,
    studio_creation_spec_text_content, studio_creation_supports_stroke_cap,
    studio_creation_supports_stroke_join, studio_creation_supports_stroke_width,
    studio_cubic_bezier_appearance, studio_data_plot_path, studio_ellipse_parameters,
    studio_ellipse_path, studio_math_tex_appearance, studio_point_to_scene_point,
    studio_rectangle_resize_path, studio_regular_polygon_parameters, studio_regular_polygon_path,
    studio_sector_path, studio_shape_transform_path, studio_timeline_semantic_values_match,
    studio_vector_to_scene_vector, unused_channel_id,
};

pub(super) fn create_entity_initial_appearance_end(entity: &CreateSceneEntity) -> Option<f64> {
    entity
        .fade_in
        .as_ref()
        .map(|fade| fade.end)
        .or_else(|| entity.draw_in.as_ref().map(|draw| draw.end))
        .or_else(|| entity.write_in.as_ref().map(|write| write.interval.end))
}

pub(super) fn create_entity_has_initial_solid_glyph_fill(entity: &CreateSceneEntity) -> bool {
    entity.fill_color.is_some()
        && entity.stroke_color.is_none()
        && ((entity.fade_in.is_some()
            && matches!(
                entity.geometry,
                CreateSceneEntityGeometry::CubicOutline { .. }
                    | CreateSceneEntityGeometry::TextOutline { .. }
            ))
            || (entity.write_in.is_some()
                && matches!(entity.geometry, CreateSceneEntityGeometry::LogicalGroup)))
}

pub(super) fn create_entity_has_only_initial_solid_glyph_fill(entity: &CreateSceneEntity) -> bool {
    create_entity_has_initial_solid_glyph_fill(entity)
        && close_transform_baseline_value(entity.paint_opacity, 1.0)
        && rotation_is_noop(entity.rotation)
}

fn create_entity_open_stroke_material_parameter_track_is_valid(entity: &CreateSceneEntity) -> bool {
    !entity.material_parameter_tracks.is_empty()
        && entity
            .material_parameter_tracks
            .iter()
            .all(|track| track.material.texture.is_none())
        && match &entity.geometry {
            CreateSceneEntityGeometry::Line => true,
            CreateSceneEntityGeometry::CubicBezier {
                appearance: SceneAppearanceV1::Vector { fill, stroke, .. },
                path,
            } => {
                fill.is_none()
                    && stroke.is_some()
                    && path.subpaths.len() == 1
                    && !path.subpaths[0].closed
            }
            _ => false,
        }
}

pub(super) fn create_entity_draw_is_valid(entity: &CreateSceneEntity) -> bool {
    entity.draw_in.as_ref().is_none_or(|draw| {
        draw.end.is_finite()
            && draw.end > entity.lifetime.start
            && draw.end <= entity.lifetime.end
            && entity.fade_in.is_none()
            && entity.fill_color.is_none()
            && (entity.material_parameter_tracks.is_empty()
                || create_entity_open_stroke_material_parameter_track_is_valid(entity))
            && matches!(draw.easing, EasingV1::Linear {} | EasingV1::ManimSmooth {})
            && match &entity.geometry {
                CreateSceneEntityGeometry::CubicBezier {
                    appearance: SceneAppearanceV1::Vector { fill, .. },
                    path,
                } => fill.is_none() && path.subpaths.iter().all(|subpath| !subpath.closed),
                _ => true,
            }
            && matches!(
                entity.geometry,
                CreateSceneEntityGeometry::Circle { .. }
                    | CreateSceneEntityGeometry::CubicBezier { .. }
                    | CreateSceneEntityGeometry::Line
                    | CreateSceneEntityGeometry::Rectangle { .. }
                    | CreateSceneEntityGeometry::ShapeOutline { .. }
                    | CreateSceneEntityGeometry::SvgPath { .. }
            )
    })
}

pub(super) fn studio_write_fragment_id_is_portable(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 64
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

pub(super) fn studio_write_path_has_closed_renderable_contours(path: &CubicPathV1) -> bool {
    !path.subpaths.is_empty()
        && path.subpaths.iter().all(|subpath| {
            if !subpath.closed || subpath.segments.is_empty() {
                return false;
            }
            let mut start = &subpath.start;
            for segment in &subpath.segments {
                if *start == segment.control1 && *start == segment.control2 && *start == segment.end
                {
                    return false;
                }
                start = &segment.end;
            }
            true
        })
}

fn canonical_write_plan(fragment_count: usize) -> Option<CreateSceneEntityWritePlan> {
    let fragment_count = u32::try_from(fragment_count).ok()?;
    (fragment_count > 0).then_some(CreateSceneEntityWritePlan {
        fragment_lag_ratio: (4.0 / f64::from(fragment_count)).min(0.2),
        outline_stroke_width: STUDIO_WRITE_OUTLINE_STROKE_WIDTH,
        phase_boundary: STUDIO_WRITE_PHASE_BOUNDARY,
    })
}

pub(super) fn create_entity_write_is_valid(entity: &CreateSceneEntity) -> bool {
    let Some(write) = &entity.write_in else {
        return !matches!(entity.geometry, CreateSceneEntityGeometry::LogicalGroup);
    };
    let plan = write.plan;
    let Some(expected_plan) = canonical_write_plan(write.fragments.len()) else {
        return false;
    };
    let mut fragment_ids = BTreeSet::new();
    let total_segments = write.fragments.iter().try_fold(0_usize, |total, fragment| {
        fragment
            .path
            .subpaths
            .iter()
            .try_fold(total, |subtotal, subpath| {
                subtotal.checked_add(subpath.segments.len())
            })
    });
    matches!(entity.geometry, CreateSceneEntityGeometry::LogicalGroup)
        && entity.draw_in.is_none()
        && entity.fade_in.is_none()
        && studio_timeline_semantic_values_match(write.interval.start, entity.lifetime.start)
        && write.interval.end.is_finite()
        && write.interval.end > write.interval.start
        && write.interval.end <= entity.lifetime.end
        && matches!(write.easing, EasingV1::Linear {})
        && close_transform_baseline_value(plan.fragment_lag_ratio, expected_plan.fragment_lag_ratio)
        && close_transform_baseline_value(plan.phase_boundary, expected_plan.phase_boundary)
        && close_transform_baseline_value(
            plan.outline_stroke_width,
            expected_plan.outline_stroke_width,
        )
        && !write.fragments.is_empty()
        && write.fragments.len() <= STUDIO_WRITE_MAX_FRAGMENTS
        && matches!(total_segments, Some(1..=STUDIO_WRITE_MAX_CUBIC_SEGMENTS))
        && write.fragments.iter().enumerate().all(|(index, fragment)| {
            u32::try_from(index).ok() == Some(fragment.order)
                && fragment.id == format!("fragment-{index:04}")
                && fragment.fill_rule == FillRuleV1::NonZero
                && studio_write_fragment_id_is_portable(&fragment.id)
                && fragment_ids.insert(fragment.id.as_str())
                && fragment.paint.red.to_bits() == 1.0_f64.to_bits()
                && fragment.paint.green.to_bits() == 1.0_f64.to_bits()
                && fragment.paint.blue.to_bits() == 1.0_f64.to_bits()
                && fragment.paint.alpha.to_bits() == 1.0_f64.to_bits()
                && studio_write_path_has_closed_renderable_contours(&fragment.path)
                && ["outline", "fill"]
                    .into_iter()
                    .all(|role| format!("{}/write/{}/{role}", entity.id, fragment.id).len() <= 240)
        })
}

fn math_tex_write_in(
    outline: &StudioCreationSegmentedMathTexOutline,
    source: &str,
    interval: &IntervalV1,
    easing: &EasingV1,
) -> Result<CreateSceneEntityWriteIn, ApplyStudioCreationEditError> {
    let source_end_byte =
        u32::try_from(source.len()).map_err(|_| CreateSceneEntitiesError::InvalidAppearanceEdit)?;
    if source.len() > SEGMENTED_MATH_TEX_MAX_SOURCE_BYTES
        || outline.fragments.len() > SEGMENTED_MATH_TEX_MAX_FRAGMENTS
        || outline.write_plan.representation
            != StudioCreationSegmentedMathTexRepresentation::SeparateOutlineAndFillEntities
        || outline.fragments.iter().any(|fragment| {
            fragment.outline_entity_id != format!("{}:outline", fragment.id)
                || fragment.fill_entity_id != format!("{}:fill", fragment.id)
                || fragment.source_correlation
                    != (StudioCreationSegmentedMathTexSourceCorrelation {
                        kind: StudioCreationSegmentedMathTexSourceCorrelationKind::ExpressionByteRange,
                        source_end_byte,
                        source_start_byte: 0,
                    })
        })
    {
        return Err(CreateSceneEntitiesError::InvalidAppearanceEdit.into());
    }
    Ok(CreateSceneEntityWriteIn {
        easing: easing.clone(),
        fragments: outline
            .fragments
            .iter()
            .map(|fragment| CreateSceneEntityWriteFragment {
                fill_rule: fragment.fill_rule,
                id: fragment.id.clone(),
                order: fragment.order,
                paint: fragment.paint.clone(),
                path: fragment.path.clone(),
            })
            .collect(),
        interval: interval.clone(),
        plan: CreateSceneEntityWritePlan {
            fragment_lag_ratio: outline.write_plan.fragment_lag_ratio,
            outline_stroke_width: outline.write_plan.outline_stroke_width,
            phase_boundary: outline.write_plan.phase_boundary,
        },
    })
}

fn text_write_fragment(
    fragment: &StudioCreationTextOutlineFragment,
    font_size: f64,
) -> CreateSceneEntityWriteFragment {
    CreateSceneEntityWriteFragment {
        fill_rule: FillRuleV1::NonZero,
        id: format!("fragment-{:04}", fragment.order),
        order: fragment.order,
        paint: RgbaColorV1 {
            alpha: 1.0,
            blue: 1.0,
            green: 1.0,
            red: 1.0,
        },
        path: scale_cubic_path(&fragment.path, font_size),
    }
}

fn text_outline_fragments_are_exact(outline: &StudioCreationTextOutline) -> bool {
    let source_keys_match = outline
        .text
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| character.to_string())
        .eq(outline
            .fragments
            .iter()
            .map(|fragment| fragment.source_correlation.key.clone()));
    source_keys_match
        && (1..=STUDIO_WRITE_MAX_FRAGMENTS).contains(&outline.fragments.len())
        && outline
            .fragments
            .iter()
            .enumerate()
            .all(|(index, fragment)| {
                u32::try_from(index).ok() == Some(fragment.order)
                    && !fragment.path.subpaths.is_empty()
                    && fragment.source_correlation.kind
                        == StudioTextOutlineSourceCorrelationKind::NfcScalar
                    && fragment.source_correlation.key.chars().count() == 1
                    && is_nfc(&fragment.source_correlation.key)
            })
        && outline
            .fragments
            .iter()
            .flat_map(|fragment| fragment.path.subpaths.iter())
            .eq(outline.path.subpaths.iter())
}

fn text_write_in(
    outline: &StudioCreationTextOutline,
    font_size: f64,
    interval: &IntervalV1,
    easing: &EasingV1,
) -> Result<CreateSceneEntityWriteIn, ApplyStudioCreationEditError> {
    let plan = canonical_write_plan(outline.fragments.len())
        .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
    Ok(CreateSceneEntityWriteIn {
        easing: easing.clone(),
        fragments: outline
            .fragments
            .iter()
            .map(|fragment| text_write_fragment(fragment, font_size))
            .collect(),
        interval: interval.clone(),
        plan,
    })
}

fn create_entity_paint_color_baseline(
    entity: &CreateSceneEntity,
    property: StudioPaintColorProperty,
) -> Option<RgbaColorV1> {
    let SceneAppearanceV1::Vector { fill, stroke, .. } =
        created_geometry_and_appearance(entity.geometry.clone()).1
    else {
        return None;
    };
    match property {
        StudioPaintColorProperty::FillColor
            if matches!(
                entity.geometry,
                CreateSceneEntityGeometry::CubicBezier { .. }
            ) =>
        {
            fill.map(|fill| fill.color)
        }
        StudioPaintColorProperty::FillColor
            if matches!(
                entity.geometry,
                CreateSceneEntityGeometry::Circle { .. }
                    | CreateSceneEntityGeometry::CubicOutline { .. }
                    | CreateSceneEntityGeometry::Rectangle { .. }
                    | CreateSceneEntityGeometry::ShapeOutline { .. }
                    | CreateSceneEntityGeometry::TextOutline { .. }
            ) =>
        {
            entity.fill_color.clone()
        }
        StudioPaintColorProperty::StrokeColor
            if matches!(
                entity.geometry,
                CreateSceneEntityGeometry::CubicBezier { .. }
            ) && fill.is_none() =>
        {
            stroke.map(|stroke| stroke.color)
        }
        StudioPaintColorProperty::StrokeColor
            if matches!(
                entity.geometry,
                CreateSceneEntityGeometry::Line | CreateSceneEntityGeometry::ShapeOutline { .. }
            ) =>
        {
            entity
                .stroke_color
                .clone()
                .or_else(|| stroke.map(|stroke| stroke.color))
        }
        StudioPaintColorProperty::FillColor | StudioPaintColorProperty::StrokeColor => None,
    }
}

fn create_entity_write_fill_material_parameter_track_is_valid(entity: &CreateSceneEntity) -> bool {
    !entity.material_parameter_tracks.is_empty()
        && entity.write_in.is_some()
        && matches!(entity.geometry, CreateSceneEntityGeometry::LogicalGroup)
        && entity
            .material_parameter_tracks
            .iter()
            .all(|track| track.material.texture.is_none())
}

fn create_entity_paint_color_keyframes_are_valid(entity: &CreateSceneEntity) -> bool {
    entity.paint_color_track.as_ref().is_none_or(|track| {
        let baseline = create_entity_paint_color_baseline(entity, track.property);
        let first_matches_baseline =
            track
                .keyframes
                .first()
                .zip(baseline.as_ref())
                .is_some_and(|(first, baseline)| {
                    first.value.red.to_bits() == baseline.red.to_bits()
                        && first.value.green.to_bits() == baseline.green.to_bits()
                        && first.value.blue.to_bits() == baseline.blue.to_bits()
                });
        (2..=32).contains(&track.keyframes.len())
            && first_matches_baseline
            && entity.material_parameter_tracks.is_empty()
            && entity.write_in.is_none()
            && track.keyframes.iter().enumerate().all(|(index, keyframe)| {
                keyframe.at.is_finite()
                    && keyframe.at >= entity.lifetime.start
                    && keyframe.at <= entity.lifetime.end
                    && [
                        keyframe.value.red,
                        keyframe.value.green,
                        keyframe.value.blue,
                        keyframe.value.alpha,
                    ]
                    .into_iter()
                    .all(|component| component.is_finite() && (0.0..=1.0).contains(&component))
                    && close_transform_baseline_value(keyframe.value.alpha, 1.0)
                    && if index + 1 == track.keyframes.len() {
                        keyframe.easing_to_next.is_none()
                    } else {
                        matches!(
                            keyframe.easing_to_next,
                            Some(EasingV1::Linear {} | EasingV1::ManimSmooth {})
                        )
                    }
            })
            && track
                .keyframes
                .windows(2)
                .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON)
            && create_entity_initial_appearance_end(entity).is_none_or(|appearance_end| {
                track
                    .keyframes
                    .first()
                    .is_none_or(|keyframe| keyframe.at > appearance_end + TIMELINE_ANCHOR_EPSILON)
            })
    })
}

fn create_entity_fragment_material_targets_fill(
    geometry: &CreateSceneEntityGeometry,
) -> Option<bool> {
    let (scene_geometry, appearance, _) = created_geometry_and_appearance(geometry.clone());
    match (&scene_geometry, &appearance) {
        (_, SceneAppearanceV1::Vector { fill: Some(_), .. }) => Some(true),
        (
            SceneGeometryV1::Line { .. },
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            },
        ) => Some(false),
        (
            SceneGeometryV1::CubicPath { path },
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            },
        ) if !path.subpaths.is_empty() && path.subpaths.iter().all(|subpath| !subpath.closed) => {
            Some(false)
        }
        _ => None,
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "keeps the closed creation-property validation gate visible as one atomic predicate"
)]
pub(super) fn create_entity_property_keyframes_are_valid(entity: &CreateSceneEntity) -> bool {
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
    let base_has_material_paint = create_entity_fragment_material_targets_fill(&entity.geometry)
        .is_some()
        || create_entity_write_fill_material_parameter_track_is_valid(entity);
    let mut material_parameter_targets = BTreeSet::new();
    let material_baseline = entity
        .material_parameter_tracks
        .first()
        .map(|track| &track.material);
    let material_is_valid = entity.material_parameter_tracks.len()
        <= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1
        && entity.material_parameter_tracks.iter().all(|track| {
            material_parameter_targets.insert(track.parameter_index)
                && material_baseline.is_some_and(|baseline| baseline == &track.material)
                && track
                    .material
                    .parameters
                    .get(track.parameter_index)
                    .zip(track.keyframes.first())
                    .is_some_and(|(baseline, first)| baseline.to_bits() == first.value.to_bits())
                && !track.material.parameters.is_empty()
                && track.material.parameters.len() <= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1
                && track
                    .material
                    .parameters
                    .iter()
                    .all(|value| value.is_finite())
                && track.keyframes.iter().all(|keyframe| {
                    keyframe.at.is_finite()
                        && keyframe.at >= entity.lifetime.start
                        && keyframe.at <= entity.lifetime.end
                        && keyframe.value.is_finite()
                })
                && track
                    .keyframes
                    .windows(2)
                    .all(|pair| pair[1].at > pair[0].at + TIMELINE_ANCHOR_EPSILON)
        })
        && (entity.material_parameter_tracks.is_empty() || base_has_material_paint);
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
    let starts_after_initial_appearance =
        create_entity_initial_appearance_end(entity).is_none_or(|appearance_end| {
            entity
                .opacity_keyframes
                .first()
                .is_none_or(|keyframe| keyframe.at > appearance_end + TIMELINE_ANCHOR_EPSILON)
                && entity.material_parameter_tracks.iter().all(|track| {
                    track.keyframes.first().is_none_or(|keyframe| {
                        keyframe.at > appearance_end + TIMELINE_ANCHOR_EPSILON
                            || (entity.draw_in.is_some()
                                && create_entity_open_stroke_material_parameter_track_is_valid(
                                    entity,
                                ))
                    })
                })
                && entity
                    .uniform_scale_keyframes
                    .first()
                    .is_none_or(|keyframe| keyframe.at > appearance_end + TIMELINE_ANCHOR_EPSILON)
                && entity
                    .rotation_keyframes
                    .first()
                    .is_none_or(|keyframe| keyframe.at > appearance_end + TIMELINE_ANCHOR_EPSILON)
        });
    opacity_is_valid
        && material_is_valid
        && create_entity_paint_color_keyframes_are_valid(entity)
        && rotation_is_valid
        && scale_is_valid
        && starts_after_initial_appearance
}

pub(super) fn studio_camera_animation_is_valid(
    animation: &PlannedStudioCameraAnimation,
    base_view: &SceneCameraViewV1,
    duration: f64,
) -> bool {
    studio_camera_views_match(&animation.initial_view, base_view)
        && animation.keyframes.len() >= 2
        && animation
            .keyframes
            .iter()
            .enumerate()
            .all(|(index, keyframe)| {
                keyframe.at.is_finite()
                    && keyframe.at >= 0.0
                    && keyframe.at <= duration
                    && studio_camera_view_is_bounded(&keyframe.value)
                    && studio_camera_aspects_match(base_view, &keyframe.value)
                    && studio_camera_view_is_within_zoom_bounds(base_view, &keyframe.value)
                    && (index + 1 == animation.keyframes.len()) == keyframe.easing_to_next.is_none()
            })
        && animation
            .keyframes
            .windows(2)
            .all(|pair| pair[1].at > pair[0].at)
}

pub(super) fn validate_studio_camera_animation_command(
    session: &EngineSessionV1,
    animation: Option<&PlannedStudioCameraAnimation>,
    duration: f64,
) -> Result<(), CreateSceneEntitiesError> {
    if animation.is_some_and(|animation| {
        session
            .scene()
            .animation_channels
            .iter()
            .any(|channel| matches!(channel, AnimationChannelV1::Camera { .. }))
            || !studio_camera_animation_is_valid(animation, &session.scene().camera.view, duration)
    }) {
        return Err(CreateSceneEntitiesError::InvalidCameraAnimation);
    }
    Ok(())
}

#[allow(
    clippy::too_many_lines,
    reason = "the bounded creation admission validates one atomic command without partial side effects"
)]
pub(super) fn validate_create_scene_entities_command(
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
    if command.entities.is_empty()
        && command.camera_animation.is_none()
        && command.scene_background.is_none()
    {
        return Err(CreateSceneEntitiesError::EmptyBatch);
    }
    validate_studio_camera_animation_command(session, command.camera_animation.as_ref(), duration)?;
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
        if let Some(resize) = &entity.animated_resize {
            let transform_is_valid = |transform: &AffineTransformV1| {
                transform.m11.is_finite()
                    && transform.m11 > 0.0
                    && transform.m12 == 0.0
                    && transform.m21 == 0.0
                    && transform.m22.is_finite()
                    && transform.m22 > 0.0
                    && transform.tx.is_finite()
                    && transform.ty.is_finite()
            };
            if !resize.interval.start.is_finite()
                || !resize.interval.end.is_finite()
                || resize.interval.start < entity.lifetime.start
                || resize.interval.end > entity.lifetime.end
                || resize.interval.end <= resize.interval.start
                || !transform_is_valid(&resize.from)
                || !transform_is_valid(&resize.to)
            {
                return Err(CreateSceneEntitiesError::InvalidInstantTransform);
            }
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
        let stroke_width_is_valid = entity.stroke_width_world.is_none_or(|width| {
            width.is_finite()
                && (MIN_STUDIO_STROKE_WIDTH_WORLD..=MAX_STUDIO_STROKE_WIDTH_WORLD).contains(&width)
                && matches!(
                    entity.geometry,
                    CreateSceneEntityGeometry::Circle { .. }
                        | CreateSceneEntityGeometry::Line
                        | CreateSceneEntityGeometry::Rectangle { .. }
                        | CreateSceneEntityGeometry::ShapeOutline { .. }
                )
        });
        let stroke_cap_is_valid = entity.stroke_cap.is_none_or(|_| {
            matches!(
                entity.geometry,
                CreateSceneEntityGeometry::Line | CreateSceneEntityGeometry::ShapeOutline { .. }
            )
        });
        let stroke_dash_is_valid = entity.stroke_dash.is_none_or(|dash| {
            [dash.dash_length, dash.gap_length]
                .into_iter()
                .all(|length| {
                    length.is_finite()
                        && (MIN_STROKE_DASH_WORLD_V1..=MAX_STROKE_DASH_WORLD_V1).contains(&length)
                })
                && match &entity.geometry {
                    CreateSceneEntityGeometry::Line => true,
                    CreateSceneEntityGeometry::CubicBezier {
                        appearance: SceneAppearanceV1::Vector { fill, .. },
                        path,
                    } => fill.is_none() && path.subpaths.iter().all(|subpath| !subpath.closed),
                    _ => false,
                }
        });
        let stroke_join_is_valid = entity.stroke_join.is_none_or(|_| {
            matches!(
                &entity.geometry,
                CreateSceneEntityGeometry::CubicBezier { path, .. }
                    if path.subpaths.first().is_some_and(|subpath| subpath.segments.len() >= 2)
            )
        });
        let has_initial_draw_stroke = entity.draw_in.is_some()
            && entity.fill_color.is_none()
            && entity.stroke_color.is_some()
            && close_transform_baseline_value(entity.paint_opacity, 1.0)
            && rotation_is_noop(entity.rotation);
        let has_only_initial_solid_glyph_fill =
            create_entity_has_only_initial_solid_glyph_fill(entity);
        let appearance_changed = !close_transform_baseline_value(entity.paint_opacity, 1.0)
            || !rotation_is_noop(entity.rotation)
            || has_color_override;
        let unsupported_color_override = match &entity.geometry {
            CreateSceneEntityGeometry::CubicOutline { .. }
            | CreateSceneEntityGeometry::TextOutline { .. }
            | CreateSceneEntityGeometry::LogicalGroup => entity.stroke_color.is_some(),
            CreateSceneEntityGeometry::Arrow
            | CreateSceneEntityGeometry::Circle { .. }
            | CreateSceneEntityGeometry::CubicBezier { .. }
            | CreateSceneEntityGeometry::Line
            | CreateSceneEntityGeometry::Rectangle { .. }
            | CreateSceneEntityGeometry::ShapeOutline { .. }
            | CreateSceneEntityGeometry::SvgPath { .. } => false,
            CreateSceneEntityGeometry::Image { .. } => has_color_override,
        };
        let unsupported_image_paint =
            matches!(entity.geometry, CreateSceneEntityGeometry::Image { .. })
                && (!close_transform_baseline_value(entity.paint_opacity, 1.0)
                    || has_color_override);
        if !entity.paint_opacity.is_finite()
            || !(0.0..=1.0).contains(&entity.paint_opacity)
            || !entity.rotation.is_finite()
            || !colors_are_valid
            || !stroke_width_is_valid
            || !stroke_cap_is_valid
            || !stroke_dash_is_valid
            || !stroke_join_is_valid
            || unsupported_image_paint
            || unsupported_color_override
            || (entity.animated_resize.is_some()
                && (entity.instant_transform.is_some()
                    || !rotation_is_noop(entity.rotation)
                    || !entity.uniform_scale_keyframes.is_empty()
                    || !entity.rotation_keyframes.is_empty()))
            || (!rotation_is_noop(entity.rotation) && entity.instant_transform.is_some())
            || (!entity.uniform_scale_keyframes.is_empty()
                && (!rotation_is_noop(entity.rotation) || entity.instant_transform.is_some()))
            || (!entity.rotation_keyframes.is_empty()
                && (!entity.uniform_scale_keyframes.is_empty()
                    || !rotation_is_noop(entity.rotation)
                    || entity.instant_transform.is_some()))
            || !create_entity_draw_is_valid(entity)
            || !create_entity_write_is_valid(entity)
            || !create_entity_property_keyframes_are_valid(entity)
            || (!entity.material_parameter_tracks.is_empty()
                && has_color_override
                && !create_entity_open_stroke_material_parameter_track_is_valid(entity)
                && !create_entity_write_fill_material_parameter_track_is_valid(entity))
            || (appearance_changed
                && entity.appearance_at.is_none()
                && !has_initial_draw_stroke
                && !has_only_initial_solid_glyph_fill)
            || entity.appearance_at.is_some_and(|at| {
                !at.is_finite()
                    || at < entity.lifetime.start
                    || at >= entity.lifetime.end
                    || create_entity_initial_appearance_end(entity).is_some_and(|end| at < end)
            })
        {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }
    }
    Ok(())
}

pub(super) fn write_fragment_entity_id(root_id: &str, fragment_id: &str, role: &str) -> String {
    format!("{root_id}/write/{fragment_id}/{role}")
}

fn append_text_glyph_channels(
    scene: &mut poietra_scene_ir::SceneIrV1,
    entity_id: &str,
    glyph: &CreateSceneEntityTextGlyphMorph,
    provenance_id: &str,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) {
    if !glyph.path_keyframes.is_empty() {
        capabilities.insert(SceneCapabilityV1::PathMorphAnimation);
        let id = unused_channel_id(scene, &format!("studio-text-morph-{entity_id}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::PathMorph {
                entity_id: entity_id.to_owned(),
                id,
                keyframes: glyph.path_keyframes.clone(),
                provenance_id: provenance_id.to_owned(),
            });
    }
    if !glyph.opacity_keyframes.is_empty() {
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        let id = unused_channel_id(scene, &format!("studio-text-opacity-{entity_id}"));
        scene.animation_channels.push(AnimationChannelV1::Opacity {
            entity_id: entity_id.to_owned(),
            id,
            keyframes: glyph.opacity_keyframes.clone(),
            provenance_id: provenance_id.to_owned(),
        });
    }
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "the helper appends one already-validated retained Write subtree without hidden state"
)]
pub(super) fn append_created_write_fragments(
    scene: &mut poietra_scene_ir::SceneIrV1,
    root_id: &str,
    root_lifetime: &IntervalV1,
    write: CreateSceneEntityWriteIn,
    text_morph: Option<&CreateSceneEntityTextMorph>,
    solid_fill_color: Option<&RgbaColorV1>,
    material_parameter_tracks: &[StudioMaterialParameterTrack],
    provenance_id: &str,
    first_scene_order: u32,
    source_z_index: f64,
    visible: bool,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) -> Result<u32, CreateSceneEntitiesError> {
    let fragment_count = write.fragments.len();
    let trailing_fragment_count = u32::try_from(fragment_count.saturating_sub(1))
        .map_err(|_| CreateSceneEntitiesError::InvalidHierarchy)?;
    let full_length = f64::from(trailing_fragment_count) * write.plan.fragment_lag_ratio + 1.0;
    let write_duration = write.interval.end - write.interval.start;
    let outline_stroke_width = manim_stroke_width_to_scene_world(write.plan.outline_stroke_width);
    let mut scene_order = first_scene_order;

    capabilities.extend([
        SceneCapabilityV1::CubicPathGeometry,
        SceneCapabilityV1::PathTrimAnimation,
        SceneCapabilityV1::VectorAppearanceAnimation,
    ]);
    if !material_parameter_tracks.is_empty() {
        capabilities.insert(SceneCapabilityV1::FragmentMaterial);
        if material_parameter_tracks
            .iter()
            .any(|track| track.keyframes.len() >= 2)
        {
            capabilities.insert(SceneCapabilityV1::FragmentMaterialParameterAnimation);
        }
    }

    for fragment in write.fragments {
        let glyph_morph = text_morph.and_then(|morph| {
            morph.glyphs.iter().find(|glyph| {
                matches!(
                    glyph.origin,
                    CreateSceneEntityTextGlyphOrigin::Initial { order }
                        if order == fragment.order
                )
            })
        });
        let lagged_start = f64::from(fragment.order) * write.plan.fragment_lag_ratio;
        let outline_start = write.interval.start + write_duration * lagged_start / full_length;
        let phase_boundary = write.interval.start
            + write_duration * (lagged_start + write.plan.phase_boundary) / full_length;
        let fragment_end =
            write.interval.start + write_duration * (lagged_start + 1.0) / full_length;
        if !outline_start.is_finite()
            || !phase_boundary.is_finite()
            || !fragment_end.is_finite()
            || outline_start >= phase_boundary
            || phase_boundary >= fragment_end
            || fragment_end > write.interval.end + TIMELINE_ANCHOR_EPSILON
            || phase_boundary >= root_lifetime.end
        {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }

        let outline_id = write_fragment_entity_id(root_id, &fragment.id, "outline");
        let fill_id = write_fragment_entity_id(root_id, &fragment.id, "fill");
        let paint = solid_fill_color
            .cloned()
            .unwrap_or_else(|| fragment.paint.clone());
        let stroke = poietra_scene_ir::StrokeStyleV1 {
            cap: poietra_scene_ir::StrokeCapV1::Butt,
            color: paint.clone(),
            dash_length_world: None,
            fragment_material: None,
            gap_length_world: None,
            join: poietra_scene_ir::StrokeJoinV1::Miter,
            miter_limit: 10.0,
            width_world: outline_stroke_width,
        };
        scene.entities.push(SceneEntityV1 {
            appearance: SceneAppearanceV1::Vector {
                fill: None,
                opacity: 1.0,
                stroke: Some(stroke.clone()),
            },
            geometry: SceneGeometryV1::CubicPath {
                path: fragment.path.clone(),
            },
            id: outline_id.clone(),
            lifetimes: vec![IntervalV1 {
                start: outline_start,
                end: phase_boundary,
            }],
            parent_id: Some(root_id.to_owned()),
            provenance_id: provenance_id.to_owned(),
            scene_order,
            source_z_index,
            transform: AffineTransformV1::identity(),
            visible,
        });
        scene_order = scene_order
            .checked_add(1)
            .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
        scene.animation_channels.push(AnimationChannelV1::PathTrim {
            entity_id: outline_id,
            id: unused_channel_id(scene, &format!("studio-write-outline-{scene_order}")),
            keyframes: vec![
                KeyframeV1 {
                    at: outline_start,
                    easing_to_next: Some(write.easing.clone()),
                    value: 0.0,
                },
                KeyframeV1 {
                    at: phase_boundary,
                    easing_to_next: None,
                    value: 1.0,
                },
            ],
            parameterization: Some(PathTrimParameterizationV1::UniformCubicParameterV1),
            provenance_id: provenance_id.to_owned(),
        });

        let mut transparent_paint = paint.clone();
        transparent_paint.alpha = 0.0;
        let initial_material = material_parameter_tracks
            .first()
            .map(|track| track.material.clone());
        let initial_fill = FillStyleV1 {
            color: transparent_paint,
            fragment_material: initial_material.clone(),
            rule: fragment.fill_rule,
        };
        let final_fill = FillStyleV1 {
            color: paint,
            fragment_material: initial_material,
            rule: fragment.fill_rule,
        };
        scene.entities.push(SceneEntityV1 {
            appearance: SceneAppearanceV1::Vector {
                fill: Some(initial_fill.clone()),
                opacity: 1.0,
                stroke: Some(stroke.clone()),
            },
            geometry: SceneGeometryV1::CubicPath {
                path: glyph_morph
                    .map_or_else(|| fragment.path.clone(), |glyph| glyph.initial_path.clone()),
            },
            id: fill_id.clone(),
            lifetimes: vec![IntervalV1 {
                start: phase_boundary,
                end: root_lifetime.end,
            }],
            parent_id: Some(root_id.to_owned()),
            provenance_id: provenance_id.to_owned(),
            scene_order,
            source_z_index,
            transform: AffineTransformV1::identity(),
            visible,
        });
        scene_order = scene_order
            .checked_add(1)
            .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
        let mut final_stroke = stroke.clone();
        final_stroke.width_world = 0.0;
        let appearance_keyframes = vec![
            KeyframeV1 {
                at: phase_boundary,
                easing_to_next: Some(write.easing.clone()),
                value: VectorAppearanceValueV1 {
                    fill: Some(initial_fill),
                    stroke: Some(stroke),
                },
            },
            KeyframeV1 {
                at: fragment_end,
                easing_to_next: None,
                value: VectorAppearanceValueV1 {
                    fill: Some(final_fill.clone()),
                    stroke: Some(final_stroke.clone()),
                },
            },
        ];
        scene
            .animation_channels
            .push(AnimationChannelV1::VectorAppearance {
                entity_id: fill_id.clone(),
                id: unused_channel_id(scene, &format!("studio-write-fill-{scene_order}")),
                keyframes: appearance_keyframes,
                provenance_id: provenance_id.to_owned(),
            });
        for track in material_parameter_tracks
            .iter()
            .filter(|track| track.keyframes.len() >= 2)
        {
            scene
                .animation_channels
                .push(AnimationChannelV1::FragmentMaterialParameter {
                    entity_id: fill_id.clone(),
                    id: unused_channel_id(
                        scene,
                        &format!(
                            "studio-write-fill-material-{scene_order}-{}",
                            track.parameter_index
                        ),
                    ),
                    keyframes: track.keyframes.clone(),
                    material: track.material.clone(),
                    paint_target: FragmentMaterialPaintTargetV1::Fill,
                    parameter_index: u32::try_from(track.parameter_index)
                        .map_err(|_| CreateSceneEntitiesError::InvalidAppearanceEdit)?,
                    provenance_id: provenance_id.to_owned(),
                });
        }
        if let Some(glyph) = glyph_morph {
            append_text_glyph_channels(scene, &fill_id, glyph, provenance_id, capabilities);
        }
    }
    u32::try_from(fragment_count.saturating_mul(2))
        .map_err(|_| CreateSceneEntitiesError::InvalidHierarchy)
}

pub(super) fn planned_math_tex_morph(
    state: &PlannedStudioCreationEntity,
    outlines: &[StudioCreationMathTexOutline],
) -> Result<Option<CreateSceneEntityMathTexMorph>, ApplyStudioCreationEditError> {
    let Some(first_transform) = state.math_tex_transforms.first() else {
        return Ok(None);
    };
    let initial_parts = state
        .spec
        .tex_parts
        .as_ref()
        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
    let initial = outlines
        .iter()
        .find(|outline| outline.entity_id == state.spec.id && &outline.tex_parts == initial_parts)
        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
    let mut paths = Vec::with_capacity(state.math_tex_transforms.len() + 1);
    paths.push(initial.path.clone());
    for transform in &state.math_tex_transforms {
        let outline = outlines
            .iter()
            .find(|outline| {
                outline.entity_id == transform.target_entity_id
                    && outline.tex_parts == transform.content.tex_parts
            })
            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
        paths.push(outline.path.clone());
    }
    let aligned = align_cubic_path_morph_chain(&paths)
        .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
    let mut keyframes = Vec::with_capacity(state.math_tex_transforms.len() * 2 + 1);
    for (index, transform) in state.math_tex_transforms.iter().enumerate() {
        if index == 0 {
            keyframes.push(KeyframeV1 {
                at: transform.interval.start,
                easing_to_next: Some(transform.easing.clone()),
                value: aligned[0].clone(),
            });
        } else {
            let previous = keyframes
                .last_mut()
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            if transform.interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: transform.interval.start,
                    easing_to_next: Some(transform.easing.clone()),
                    value: aligned[index].clone(),
                });
            } else {
                previous.easing_to_next = Some(transform.easing.clone());
            }
        }
        keyframes.push(KeyframeV1 {
            at: transform.interval.end,
            easing_to_next: None,
            value: aligned[index + 1].clone(),
        });
    }
    Ok(Some(CreateSceneEntityMathTexMorph {
        initial_path: aligned[0].clone(),
        keyframes,
        start: first_transform.interval.start,
    }))
}

#[derive(Clone)]
struct WorkingTextGlyphMorph {
    id: String,
    initial_path: CubicPathV1,
    lifetime_start: f64,
    opacity_steps: Vec<(IntervalV1, EasingV1, f64, f64)>,
    origin: CreateSceneEntityTextGlyphOrigin,
    path_steps: Vec<(IntervalV1, EasingV1, CubicPathV1)>,
    source_key: String,
}

fn initial_text_glyph_morph(
    root_id: &str,
    lifetime_start: f64,
    font_size: f64,
    fragment: &StudioCreationTextOutlineFragment,
) -> WorkingTextGlyphMorph {
    WorkingTextGlyphMorph {
        id: write_fragment_entity_id(root_id, &format!("fragment-{:04}", fragment.order), "fill"),
        initial_path: scale_cubic_path(&fragment.path, font_size),
        lifetime_start,
        opacity_steps: Vec::new(),
        origin: CreateSceneEntityTextGlyphOrigin::Initial {
            order: fragment.order,
        },
        path_steps: Vec::new(),
        source_key: fragment.source_correlation.key.clone(),
    }
}

fn finish_text_glyph_morph(
    glyph: WorkingTextGlyphMorph,
) -> Result<CreateSceneEntityTextGlyphMorph, ApplyStudioCreationEditError> {
    let (initial_path, path_keyframes) =
        text_morph_keyframes(&glyph.initial_path, &glyph.path_steps)?;
    Ok(CreateSceneEntityTextGlyphMorph {
        id: glyph.id,
        initial_path,
        lifetime_start: glyph.lifetime_start,
        opacity_keyframes: text_opacity_keyframes(&glyph.opacity_steps),
        origin: glyph.origin,
        path_keyframes,
    })
}

fn text_morph_keyframes(
    initial: &CubicPathV1,
    steps: &[(IntervalV1, EasingV1, CubicPathV1)],
) -> Result<(CubicPathV1, Vec<KeyframeV1<CubicPathV1>>), ApplyStudioCreationEditError> {
    if steps.is_empty() {
        return Ok((initial.clone(), Vec::new()));
    }
    let mut paths = Vec::with_capacity(steps.len() + 1);
    paths.push(initial.clone());
    paths.extend(steps.iter().map(|(_, _, path)| path.clone()));
    let aligned = align_cubic_path_morph_chain(&paths)
        .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
    let mut keyframes = Vec::<KeyframeV1<CubicPathV1>>::with_capacity(steps.len() * 2);
    for (index, (interval, easing, _)) in steps.iter().enumerate() {
        if let Some(previous) = keyframes.last_mut() {
            if interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: Some(easing.clone()),
                    value: aligned[index].clone(),
                });
            } else {
                previous.easing_to_next = Some(easing.clone());
            }
        } else {
            keyframes.push(KeyframeV1 {
                at: interval.start,
                easing_to_next: Some(easing.clone()),
                value: aligned[index].clone(),
            });
        }
        keyframes.push(KeyframeV1 {
            at: interval.end,
            easing_to_next: None,
            value: aligned[index + 1].clone(),
        });
    }
    Ok((aligned[0].clone(), keyframes))
}

fn text_opacity_keyframes(steps: &[(IntervalV1, EasingV1, f64, f64)]) -> Vec<KeyframeV1<f64>> {
    let mut keyframes = Vec::<KeyframeV1<f64>>::with_capacity(steps.len() * 2);
    for (interval, easing, from, to) in steps {
        if let Some(previous) = keyframes.last_mut() {
            if interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: interval.start,
                    easing_to_next: Some(easing.clone()),
                    value: *from,
                });
            } else {
                previous.easing_to_next = Some(easing.clone());
            }
        } else {
            keyframes.push(KeyframeV1 {
                at: interval.start,
                easing_to_next: Some(easing.clone()),
                value: *from,
            });
        }
        keyframes.push(KeyframeV1 {
            at: interval.end,
            easing_to_next: None,
            value: *to,
        });
    }
    keyframes
}

fn exact_text_outline<'a>(
    outlines: &'a [StudioCreationTextOutline],
    entity_id: &str,
    text: &str,
    layout: &super::StudioTextLayout,
) -> Option<&'a StudioCreationTextOutline> {
    let mut matching = outlines.iter().filter(|outline| {
        outline.entity_id == entity_id && outline.text == text && &outline.layout == layout
    });
    matching
        .next()
        .filter(|outline| matching.next().is_none() && text_outline_fragments_are_exact(outline))
}

pub(super) fn planned_text_morph(
    state: &PlannedStudioCreationEntity,
    outlines: &[StudioCreationTextOutline],
) -> Result<Option<CreateSceneEntityTextMorph>, ApplyStudioCreationEditError> {
    if state.text_transforms.is_empty() {
        return Ok(None);
    }
    let initial_content = studio_creation_spec_text_content(&state.spec)
        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
    let initial_outline = exact_text_outline(
        outlines,
        &state.spec.id,
        &initial_content.text,
        &initial_content.layout,
    )
    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
    let font_size = initial_content.layout.font_size;
    let mut glyphs = initial_outline
        .fragments
        .iter()
        .map(|fragment| {
            initial_text_glyph_morph(&state.spec.id, state.lifetime.start, font_size, fragment)
        })
        .collect::<Vec<_>>();
    let mut active = (0..glyphs.len()).collect::<Vec<_>>();
    for (transform_index, transform) in state.text_transforms.iter().enumerate() {
        let target = exact_text_outline(
            outlines,
            &transform.target_entity_id,
            &transform.content.text,
            &transform.content.layout,
        )
        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
        let mut sources = BTreeMap::<String, VecDeque<usize>>::new();
        for index in &active {
            sources
                .entry(glyphs[*index].source_key.clone())
                .or_default()
                .push_back(*index);
        }
        let mut matched = BTreeSet::new();
        let mut next_active = Vec::with_capacity(target.fragments.len());
        for fragment in &target.fragments {
            let key = &fragment.source_correlation.key;
            if let Some(source_index) = sources.get_mut(key).and_then(VecDeque::pop_front) {
                glyphs[source_index].path_steps.push((
                    transform.interval.clone(),
                    transform.easing.clone(),
                    scale_cubic_path(&fragment.path, font_size),
                ));
                matched.insert(source_index);
                next_active.push(source_index);
            } else {
                let index = glyphs.len();
                glyphs.push(WorkingTextGlyphMorph {
                    id: format!(
                        "{}/text-transform/{transform_index:04}/fragment-{:04}/fill",
                        state.spec.id, fragment.order
                    ),
                    initial_path: scale_cubic_path(&fragment.path, font_size),
                    lifetime_start: transform.interval.start,
                    opacity_steps: vec![(
                        transform.interval.clone(),
                        transform.easing.clone(),
                        0.0,
                        1.0,
                    )],
                    origin: CreateSceneEntityTextGlyphOrigin::TransformTarget {
                        order: fragment.order,
                        transform_index,
                    },
                    path_steps: Vec::new(),
                    source_key: key.clone(),
                });
                next_active.push(index);
            }
        }
        for source_index in active {
            if !matched.contains(&source_index) {
                glyphs[source_index].opacity_steps.push((
                    transform.interval.clone(),
                    transform.easing.clone(),
                    1.0,
                    0.0,
                ));
            }
        }
        active = next_active;
    }
    let glyphs = glyphs
        .into_iter()
        .map(finish_text_glyph_morph)
        .collect::<Result<Vec<_>, ApplyStudioCreationEditError>>()?;
    Ok(Some(CreateSceneEntityTextMorph { glyphs }))
}

pub(super) fn studio_creation_shape_path(
    shape: StudioCreationShapeState,
) -> Result<CubicPathV1, ApplyStudioCreationEditError> {
    studio_shape_transform_path(shape.kind, shape.dimensions)
        .ok_or(ApplyStudioCreationEditError::Unsupported)
}

fn rectangle_resize_requires_path_geometry(state: &PlannedStudioCreationEntity) -> bool {
    state.kind == StudioAuthoringEntityKind::Rectangle
        && (state
            .initial_dimensions
            .corner_radius
            .is_some_and(|radius| radius > 0.0)
            || state
                .current_dimensions
                .corner_radius
                .is_some_and(|radius| radius > 0.0)
            || state.animated_resize.as_ref().is_some_and(|resize| {
                resize
                    .from_dimensions
                    .corner_radius
                    .is_some_and(|radius| radius > 0.0)
                    || resize
                        .to_dimensions
                        .corner_radius
                        .is_some_and(|radius| radius > 0.0)
            }))
}

pub(super) fn planned_shape_morph(
    state: &PlannedStudioCreationEntity,
) -> Result<Option<CreateSceneEntityPathMorph>, ApplyStudioCreationEditError> {
    let Some(first) = state.shape_transforms.first() else {
        if !rectangle_resize_requires_path_geometry(state) {
            return Ok(None);
        }
        let initial = studio_rectangle_resize_path(state.initial_dimensions)
            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
        let (initial_path, keyframes) = if let Some(resize) = &state.animated_resize {
            let from = studio_rectangle_resize_path(resize.from_dimensions)
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            let to = studio_rectangle_resize_path(resize.to_dimensions)
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            let keyframes = vec![
                KeyframeV1 {
                    at: resize.interval.start,
                    easing_to_next: Some(EasingV1::ManimSmooth {}),
                    value: from.clone(),
                },
                KeyframeV1 {
                    at: resize.interval.end,
                    easing_to_next: None,
                    value: to,
                },
            ];
            (from, keyframes)
        } else if state.has_position_or_resize_instant
            && state.current_dimensions != state.initial_dimensions
        {
            let at = state
                .instant_at
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            let target = studio_rectangle_resize_path(state.current_dimensions)
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            let keyframes = vec![
                KeyframeV1 {
                    at,
                    easing_to_next: Some(EasingV1::Linear {}),
                    value: target.clone(),
                },
                KeyframeV1 {
                    at: state.lifetime.end,
                    easing_to_next: None,
                    value: target,
                },
            ];
            (initial, keyframes)
        } else {
            return Ok(None);
        };
        return Ok(Some(CreateSceneEntityPathMorph {
            initial_path,
            keyframes,
        }));
    };
    let mut paths = Vec::with_capacity(state.shape_transforms.len() + 1);
    paths.push(studio_creation_shape_path(first.from)?);
    for transform in &state.shape_transforms {
        paths.push(studio_creation_shape_path(transform.to)?);
    }
    let aligned = align_cubic_path_morph_chain(&paths)
        .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
    let mut keyframes = Vec::with_capacity(state.shape_transforms.len() * 2 + 1);
    for (index, transform) in state.shape_transforms.iter().enumerate() {
        if index == 0 {
            keyframes.push(KeyframeV1 {
                at: transform.interval.start,
                easing_to_next: Some(transform.easing.clone()),
                value: aligned[0].clone(),
            });
        } else {
            let previous = keyframes
                .last_mut()
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            if transform.interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: transform.interval.start,
                    easing_to_next: Some(transform.easing.clone()),
                    value: aligned[index].clone(),
                });
            } else {
                previous.easing_to_next = Some(transform.easing.clone());
            }
        }
        keyframes.push(KeyframeV1 {
            at: transform.interval.end,
            easing_to_next: None,
            value: aligned[index + 1].clone(),
        });
    }
    Ok(Some(CreateSceneEntityPathMorph {
        initial_path: aligned[0].clone(),
        keyframes,
    }))
}

pub(super) fn planned_cubic_bezier_path_morph(
    state: &PlannedStudioCreationEntity,
) -> Result<Option<CreateSceneEntityPathMorph>, ApplyStudioCreationEditError> {
    let Some(first) = state.path_morphs.first() else {
        return Ok(None);
    };
    let mut paths = Vec::with_capacity(state.path_morphs.len() + 1);
    paths.push(CubicPathV1 {
        subpaths: vec![first.from_path.clone()],
    });
    for morph in &state.path_morphs {
        paths.push(CubicPathV1 {
            subpaths: vec![morph.to_path.clone()],
        });
    }
    let aligned = align_cubic_path_morph_chain(&paths)
        .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
    let mut keyframes = Vec::with_capacity(state.path_morphs.len() * 2 + 1);
    for (index, morph) in state.path_morphs.iter().enumerate() {
        if index == 0 {
            keyframes.push(KeyframeV1 {
                at: morph.interval.start,
                easing_to_next: Some(morph.easing.clone()),
                value: aligned[0].clone(),
            });
        } else {
            let previous = keyframes
                .last_mut()
                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
            if morph.interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: morph.interval.start,
                    easing_to_next: Some(morph.easing.clone()),
                    value: aligned[index].clone(),
                });
            } else {
                previous.easing_to_next = Some(morph.easing.clone());
            }
        }
        keyframes.push(KeyframeV1 {
            at: morph.interval.end,
            easing_to_next: None,
            value: aligned[index + 1].clone(),
        });
    }
    Ok(Some(CreateSceneEntityPathMorph {
        initial_path: aligned[0].clone(),
        keyframes,
    }))
}

#[allow(
    clippy::too_many_lines,
    reason = "one append path keeps base entity and its three optional canonical channels together"
)]
pub(super) fn append_created_entity(
    scene: &mut poietra_scene_ir::SceneIrV1,
    entity: CreateSceneEntity,
    provenance_id: &str,
    scene_order: u32,
    source_z_index: f64,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) -> Result<u32, CreateSceneEntitiesError> {
    let write_in = entity.write_in.clone();
    let math_tex_morph = entity.math_tex_morph.clone();
    let text_morph = entity.text_morph.clone();
    let path_morph = entity.path_morph.clone();
    let shape_morph = entity.shape_morph.clone();
    let solid_fill_color = entity.fill_color.clone();
    let paint_color_track = entity.paint_color_track.clone();
    let has_initial_solid_glyph_fill = create_entity_has_initial_solid_glyph_fill(&entity);
    let has_material_parameter_tracks = !entity.material_parameter_tracks.is_empty();
    let has_write_fill_material_parameter_track =
        create_entity_write_fill_material_parameter_track_is_valid(&entity);
    let write_material_parameter_tracks = if has_write_fill_material_parameter_track {
        entity.material_parameter_tracks.clone()
    } else {
        Vec::new()
    };
    let has_open_stroke_material_parameter_track =
        create_entity_open_stroke_material_parameter_track_is_valid(&entity);
    let material_targets_fill =
        if has_material_parameter_tracks && !has_write_fill_material_parameter_track {
            Some(
                create_entity_fragment_material_targets_fill(&entity.geometry)
                    .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?,
            )
        } else {
            None
        };
    let (geometry, mut appearance, capability) = created_geometry_and_appearance(entity.geometry);
    let is_logical_group = matches!(&geometry, SceneGeometryV1::Group {});
    if let Some(color) = &entity.fill_color {
        if let SceneAppearanceV1::Vector { fill, .. } = &mut appearance {
            let mut base_color = color.clone();
            if !has_initial_solid_glyph_fill {
                base_color.alpha = 0.0;
            }
            *fill = Some(FillStyleV1 {
                color: base_color,
                fragment_material: None,
                rule: FillRuleV1::NonZero,
            });
        } else if !matches!(&appearance, SceneAppearanceV1::Group { .. }) || write_in.is_none() {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }
    }
    if (entity.draw_in.is_some() || has_open_stroke_material_parameter_track)
        && let Some(color) = &entity.stroke_color
    {
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        stroke.color = color.clone();
    }
    if let Some(width_world) = entity.stroke_width_world {
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        stroke.width_world = width_world;
    }
    if let Some(cap) = entity.stroke_cap {
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        stroke.cap = cap;
    }
    if let Some(join) = entity.stroke_join {
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        stroke.join = join;
        stroke.miter_limit = 10.0;
    }
    if let Some(dash) = entity.stroke_dash {
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut appearance
        else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        stroke.dash_length_world = Some(dash.dash_length);
        stroke.gap_length_world = Some(dash.gap_length);
    }
    if let Some(first) = entity
        .material_parameter_tracks
        .first()
        .filter(|_| !has_write_fill_material_parameter_track)
    {
        let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut appearance else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        if material_targets_fill == Some(true) {
            let Some(fill) = fill else {
                return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
            };
            fill.fragment_material = Some(first.material.clone());
        } else if let Some(stroke) = stroke {
            stroke.fragment_material = Some(first.material.clone());
        } else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }
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
        visible: is_logical_group || entity.visible,
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
    if let Some(draw) = entity.draw_in {
        capabilities.insert(SceneCapabilityV1::PathTrimAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-draw-{scene_order}"));
        scene.animation_channels.push(AnimationChannelV1::PathTrim {
            entity_id: created_id.clone(),
            id: channel_id,
            keyframes: vec![
                KeyframeV1 {
                    at: lifetime.start,
                    easing_to_next: Some(draw.easing),
                    value: 0.0,
                },
                KeyframeV1 {
                    at: draw.end,
                    easing_to_next: None,
                    value: 1.0,
                },
            ],
            parameterization: Some(PathTrimParameterizationV1::UniformCubicParameterV1),
            provenance_id: provenance_id.to_owned(),
        });
    }
    if has_material_parameter_tracks && !has_write_fill_material_parameter_track {
        let SceneAppearanceV1::Vector { fill, stroke, .. } = appearance.clone() else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        if fill.is_none() && stroke.is_none() {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        }
        capabilities.insert(SceneCapabilityV1::FragmentMaterial);
        if entity
            .material_parameter_tracks
            .iter()
            .any(|track| track.material.texture.is_some())
        {
            capabilities.insert(SceneCapabilityV1::PngImage);
        }
        for track in entity
            .material_parameter_tracks
            .into_iter()
            .filter(|track| track.keyframes.len() >= 2)
        {
            capabilities.insert(SceneCapabilityV1::FragmentMaterialParameterAnimation);
            let channel_id = unused_channel_id(
                scene,
                &format!(
                    "studio-material-parameter-{scene_order}-{}",
                    track.parameter_index
                ),
            );
            scene
                .animation_channels
                .push(AnimationChannelV1::FragmentMaterialParameter {
                    entity_id: created_id.clone(),
                    id: channel_id,
                    keyframes: track.keyframes,
                    material: track.material,
                    paint_target: if material_targets_fill == Some(true) {
                        FragmentMaterialPaintTargetV1::Fill
                    } else {
                        FragmentMaterialPaintTargetV1::Stroke
                    },
                    parameter_index: u32::try_from(track.parameter_index)
                        .map_err(|_| CreateSceneEntitiesError::InvalidAppearanceEdit)?,
                    provenance_id: provenance_id.to_owned(),
                });
        }
    }
    if let Some(track) = &paint_color_track {
        let mut settled_appearance = appearance.clone();
        let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut settled_appearance else {
            return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
        };
        if let Some(color) = &entity.fill_color {
            if let Some(fill) = fill {
                fill.color = color.clone();
            } else {
                *fill = Some(FillStyleV1 {
                    color: color.clone(),
                    fragment_material: None,
                    rule: FillRuleV1::NonZero,
                });
            }
        }
        if let Some(color) = &entity.stroke_color {
            let stroke = stroke
                .as_mut()
                .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
            stroke.color = color.clone();
        }
        set_vector_paint_alpha(&mut settled_appearance, entity.paint_opacity)
            .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
        let SceneAppearanceV1::Vector { fill, stroke, .. } = settled_appearance else {
            unreachable!("the matched appearance remains vector-valued");
        };
        let settled_value = VectorAppearanceValueV1 { fill, stroke };
        let mut keyframes =
            Vec::with_capacity(track.keyframes.len() + usize::from(entity.appearance_at.is_some()));
        if let Some(at) = entity.appearance_at
            && track
                .keyframes
                .first()
                .is_some_and(|keyframe| keyframe.at > at + TIMELINE_ANCHOR_EPSILON)
        {
            keyframes.push(KeyframeV1 {
                at,
                easing_to_next: Some(EasingV1::Linear {}),
                value: settled_value.clone(),
            });
        }
        for keyframe in &track.keyframes {
            let mut value = settled_value.clone();
            let paint = match track.property {
                StudioPaintColorProperty::FillColor => {
                    value.fill.as_mut().map(|fill| &mut fill.color)
                }
                StudioPaintColorProperty::StrokeColor => {
                    value.stroke.as_mut().map(|stroke| &mut stroke.color)
                }
            }
            .ok_or(CreateSceneEntitiesError::InvalidAppearanceEdit)?;
            paint.red = keyframe.value.red;
            paint.green = keyframe.value.green;
            paint.blue = keyframe.value.blue;
            keyframes.push(KeyframeV1 {
                at: keyframe.at,
                easing_to_next: keyframe.easing_to_next.clone(),
                value,
            });
        }
        capabilities.insert(SceneCapabilityV1::VectorAppearanceAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-paint-color-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::VectorAppearance {
                entity_id: created_id.clone(),
                id: channel_id,
                keyframes,
                provenance_id: provenance_id.to_owned(),
            });
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
        if paint_color_track.is_none()
            && !has_material_parameter_tracks
            && (!close_transform_baseline_value(entity.paint_opacity, 1.0)
                || entity.fill_color.is_some()
                || entity.stroke_color.is_some())
        {
            let mut changed_appearance = appearance.clone();
            if let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut changed_appearance {
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
                    unreachable!("the matched appearance remains vector-valued");
                };
                let value = VectorAppearanceValueV1 { fill, stroke };
                capabilities.insert(SceneCapabilityV1::VectorAppearanceAnimation);
                let channel_id =
                    unused_channel_id(scene, &format!("studio-appearance-{scene_order}"));
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
            } else if matches!(changed_appearance, SceneAppearanceV1::Group { .. })
                && entity.fill_color.is_none()
                && entity.stroke_color.is_none()
            {
                capabilities.insert(SceneCapabilityV1::OpacityAnimation);
                let channel_id =
                    unused_channel_id(scene, &format!("studio-group-opacity-{scene_order}"));
                scene.animation_channels.push(AnimationChannelV1::Opacity {
                    entity_id: created_id.clone(),
                    id: channel_id,
                    keyframes: vec![
                        KeyframeV1 {
                            at,
                            easing_to_next: Some(EasingV1::Linear {}),
                            value: entity.paint_opacity,
                        },
                        KeyframeV1 {
                            at: lifetime.end,
                            easing_to_next: None,
                            value: entity.paint_opacity,
                        },
                    ],
                    provenance_id: provenance_id.to_owned(),
                });
            } else {
                return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
            }
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
                entity_id: created_id.clone(),
                id: channel_id,
                keyframes,
                provenance_id: provenance_id.to_owned(),
            });
    }
    if let Some(resize) = entity.animated_resize {
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-resize-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: created_id.clone(),
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: resize.interval.start,
                        easing_to_next: Some(EasingV1::ManimSmooth {}),
                        value: resize.from,
                    },
                    KeyframeV1 {
                        at: resize.interval.end,
                        easing_to_next: None,
                        value: resize.to,
                    },
                ],
                provenance_id: provenance_id.to_owned(),
            });
    }
    let write_leaf_count = if let Some(write) = write_in {
        let write_lifetime = IntervalV1 {
            end: math_tex_morph
                .as_ref()
                .map_or(lifetime.end, |morph| morph.start),
            start: lifetime.start,
        };
        append_created_write_fragments(
            scene,
            &created_id,
            &write_lifetime,
            write,
            text_morph.as_ref(),
            solid_fill_color.as_ref(),
            &write_material_parameter_tracks,
            provenance_id,
            scene_order
                .checked_add(1)
                .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?,
            source_z_index,
            entity.visible,
            capabilities,
        )?
    } else {
        0
    };
    let text_morph_leaf_count = if let Some(morph) = &text_morph {
        let mut count = 0_u32;
        let color = solid_fill_color.clone().unwrap_or(RgbaColorV1 {
            alpha: 1.0,
            blue: 1.0,
            green: 1.0,
            red: 1.0,
        });
        for glyph in &morph.glyphs {
            let CreateSceneEntityTextGlyphOrigin::TransformTarget {
                order,
                transform_index,
            } = glyph.origin
            else {
                continue;
            };
            let expected_suffix =
                format!("/text-transform/{transform_index:04}/fragment-{order:04}/fill");
            if glyph.id.len() > 240
                || !glyph.id.ends_with(&expected_suffix)
                || glyph.lifetime_start < lifetime.start
                || glyph.lifetime_start >= lifetime.end
            {
                return Err(CreateSceneEntitiesError::InvalidAppearanceEdit);
            }
            let target_scene_order = scene_order
                .checked_add(1)
                .and_then(|order| order.checked_add(write_leaf_count))
                .and_then(|order| order.checked_add(count))
                .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
            scene.entities.push(SceneEntityV1 {
                appearance: SceneAppearanceV1::Vector {
                    fill: Some(FillStyleV1 {
                        color: color.clone(),
                        fragment_material: None,
                        rule: FillRuleV1::NonZero,
                    }),
                    opacity: 1.0,
                    stroke: None,
                },
                geometry: SceneGeometryV1::CubicPath {
                    path: glyph.initial_path.clone(),
                },
                id: glyph.id.clone(),
                lifetimes: vec![IntervalV1 {
                    end: lifetime.end,
                    start: glyph.lifetime_start,
                }],
                parent_id: Some(created_id.clone()),
                provenance_id: provenance_id.to_owned(),
                scene_order: target_scene_order,
                source_z_index,
                transform: AffineTransformV1::identity(),
                visible: entity.visible,
            });
            append_text_glyph_channels(scene, &glyph.id, glyph, provenance_id, capabilities);
            count = count
                .checked_add(1)
                .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
        }
        capabilities.insert(SceneCapabilityV1::CubicPathGeometry);
        count
    } else {
        0
    };
    let morph_leaf_count = if let Some(morph) = math_tex_morph {
        capabilities.insert(SceneCapabilityV1::PathMorphAnimation);
        let target_id = if is_logical_group {
            let id = format!("{created_id}/math-tex-morph");
            let mut morph_appearance = studio_math_tex_appearance();
            if let (
                Some(color),
                SceneAppearanceV1::Vector {
                    fill: Some(fill), ..
                },
            ) = (&solid_fill_color, &mut morph_appearance)
            {
                fill.color = color.clone();
            }
            scene.entities.push(SceneEntityV1 {
                appearance: morph_appearance,
                geometry: SceneGeometryV1::CubicPath {
                    path: morph.initial_path,
                },
                id: id.clone(),
                lifetimes: vec![IntervalV1 {
                    end: lifetime.end,
                    start: morph.start,
                }],
                parent_id: Some(created_id.clone()),
                provenance_id: provenance_id.to_owned(),
                scene_order: scene_order
                    .checked_add(1)
                    .and_then(|order| order.checked_add(write_leaf_count))
                    .and_then(|order| order.checked_add(text_morph_leaf_count))
                    .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?,
                source_z_index,
                transform: AffineTransformV1::identity(),
                visible: entity.visible,
            });
            id
        } else {
            created_id.clone()
        };
        let channel_id = unused_channel_id(scene, &format!("studio-math-tex-morph-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::PathMorph {
                entity_id: target_id,
                id: channel_id,
                keyframes: morph.keyframes,
                provenance_id: provenance_id.to_owned(),
            });
        u32::from(is_logical_group)
    } else {
        0
    };
    if let Some(morph) = shape_morph {
        capabilities.insert(SceneCapabilityV1::PathMorphAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-shape-morph-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::PathMorph {
                entity_id: created_id.clone(),
                id: channel_id,
                keyframes: morph.keyframes,
                provenance_id: provenance_id.to_owned(),
            });
    }
    if let Some(morph) = path_morph {
        capabilities.insert(SceneCapabilityV1::PathMorphAnimation);
        let channel_id = unused_channel_id(scene, &format!("studio-path-morph-{scene_order}"));
        scene
            .animation_channels
            .push(AnimationChannelV1::PathMorph {
                entity_id: created_id,
                id: channel_id,
                keyframes: morph.keyframes,
                provenance_id: provenance_id.to_owned(),
            });
    }
    1_u32
        .checked_add(write_leaf_count)
        .and_then(|count| count.checked_add(text_morph_leaf_count))
        .and_then(|count| count.checked_add(morph_leaf_count))
        .ok_or(CreateSceneEntitiesError::InvalidHierarchy)
}

pub(super) fn validate_studio_logical_group(
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
        if child.parent_id.is_some() {
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

pub(super) fn append_studio_logical_groups(
    scene: &mut poietra_scene_ir::SceneIrV1,
    groups: &[PlannedStudioLogicalGroup],
    created_entity_ids: &BTreeSet<String>,
    provenance_id: &str,
) -> Result<(), CreateSceneEntitiesError> {
    let mut roots = scene
        .entities
        .iter()
        .filter(|entity| entity.parent_id.is_none())
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

pub(super) fn append_planned_studio_camera_animation(
    scene: &mut poietra_scene_ir::SceneIrV1,
    animation: Option<PlannedStudioCameraAnimation>,
    provenance_id: &str,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) {
    let Some(animation) = animation else {
        return;
    };
    let channel_id = unused_channel_id(scene, "studio-camera");
    scene.animation_channels.push(AnimationChannelV1::Camera {
        id: channel_id,
        keyframes: animation.keyframes,
        provenance_id: provenance_id.to_owned(),
    });
    capabilities.insert(SceneCapabilityV1::CameraAnimation);
}

pub(super) fn creates_browser_outline(entities: &[CreateSceneEntity]) -> bool {
    entities.iter().any(|entity| {
        matches!(
            &entity.geometry,
            CreateSceneEntityGeometry::CubicOutline { .. }
                | CreateSceneEntityGeometry::TextOutline { .. }
        ) || entity.write_in.is_some()
    })
}

impl EngineSessionV1 {
    /// Authorizes normalized Studio duration edits and applies them atomically.
    #[allow(
        clippy::too_many_lines,
        reason = "one atomic Studio materialization keeps candidate construction and commit together"
    )]
    pub(super) fn create_scene_entities(
        &mut self,
        command: CreateSceneEntitiesCommand,
    ) -> Result<StudioAuthoringEditResult, CreateSceneEntitiesError> {
        validate_create_scene_entities_command(self, &command)?;
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let creates_browser_outline = creates_browser_outline(&command.entities);
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

        let mut next_scene_order = first_scene_order;
        for entity in command.entities {
            let entity_source_z_index = entity.source_z_index.unwrap_or(source_z_index);
            let appended_entity_count = append_created_entity(
                &mut candidate.scene,
                entity,
                &command.provenance.id,
                next_scene_order,
                entity_source_z_index,
                &mut capabilities,
            )?;
            next_scene_order = next_scene_order
                .checked_add(appended_entity_count)
                .ok_or(CreateSceneEntitiesError::InvalidHierarchy)?;
            source_z_index += 1.0;
        }
        append_planned_studio_camera_animation(
            &mut candidate.scene,
            command.camera_animation,
            &command.provenance.id,
            &mut capabilities,
        );
        candidate.scene.camera.background = command
            .scene_background
            .unwrap_or(candidate.scene.camera.background);
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(command.provenance.clone());
        append_planned_scene_motions(
            &mut candidate.scene,
            &command.motions,
            &command.provenance.id,
        )?;
        append_studio_path_motions(
            &mut candidate.scene,
            &command.path_motions,
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
            segmented_math_tex_outlines,
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
        if plan.scene_background.is_some()
            && (!matches!(
                &self.scene().source,
                SceneSourceV1::StudioEditProgram { .. }
            ) || !self.scene().provenance.iter().any(|record| {
                record.id == "studio-native-document"
                    && record.origin == ProvenanceOriginV1::StudioEditProgram
            }))
        {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }
        if plan.camera_animation.as_ref().is_some_and(|animation| {
            !studio_camera_views_match(&animation.initial_view, &self.scene().camera.view)
                || self
                    .scene()
                    .animation_channels
                    .iter()
                    .any(|channel| matches!(channel, AnimationChannelV1::Camera { .. }))
        }) {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }
        for state in &plan.entities {
            match state.kind {
                StudioAuthoringEntityKind::MathTex => {
                    let needs_full_outline =
                        state.write_interval.is_none() || !state.math_tex_transforms.is_empty();
                    let initial_count = needs_full_outline.then(|| {
                        math_tex_outlines
                            .iter()
                            .filter(|outline| {
                                outline.entity_id == state.spec.id
                                    && Some(&outline.tex_parts) == state.spec.tex_parts.as_ref()
                            })
                            .count()
                    });
                    let targets_are_exact = state.math_tex_transforms.iter().all(|transform| {
                        math_tex_outlines
                            .iter()
                            .filter(|outline| {
                                outline.entity_id == transform.target_entity_id
                                    && outline.tex_parts == transform.content.tex_parts
                            })
                            .count()
                            == 1
                    });
                    if initial_count.is_some_and(|count| count != 1) || !targets_are_exact {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                    if state.write_interval.is_none() {
                        continue;
                    }
                    let source = state
                        .spec
                        .tex_parts
                        .as_ref()
                        .map(|parts| parts.join(" "))
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let segmented_count = segmented_math_tex_outlines
                        .iter()
                        .filter(|outline| {
                            outline.entity_id == state.spec.id && outline.source == source
                        })
                        .count();
                    if segmented_count != 1 {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                }
                StudioAuthoringEntityKind::Text => {
                    let initial = studio_creation_spec_text_content(&state.spec)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    if exact_text_outline(
                        &text_outlines,
                        &state.spec.id,
                        &initial.text,
                        &initial.layout,
                    )
                    .is_none()
                        || state.text_transforms.iter().any(|transform| {
                            exact_text_outline(
                                &text_outlines,
                                &transform.target_entity_id,
                                &transform.content.text,
                                &transform.content.layout,
                            )
                            .is_none()
                        })
                    {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                }
                StudioAuthoringEntityKind::Arc
                | StudioAuthoringEntityKind::Arrow
                | StudioAuthoringEntityKind::Axes
                | StudioAuthoringEntityKind::Circle
                | StudioAuthoringEntityKind::CubicBezier
                | StudioAuthoringEntityKind::DataPlot
                | StudioAuthoringEntityKind::Ellipse
                | StudioAuthoringEntityKind::Image
                | StudioAuthoringEntityKind::Line
                | StudioAuthoringEntityKind::NumberLine
                | StudioAuthoringEntityKind::NumberPlane
                | StudioAuthoringEntityKind::Other
                | StudioAuthoringEntityKind::Rectangle
                | StudioAuthoringEntityKind::RegularPolygon
                | StudioAuthoringEntityKind::Sector
                | StudioAuthoringEntityKind::SvgPath => {}
            }
        }

        let mut entities = Vec::with_capacity(plan.entities.len());
        let mut persistent_removals = Vec::new();
        for state in &plan.entities {
            let math_tex_morph = planned_math_tex_morph(state, &math_tex_outlines)?;
            let text_morph = planned_text_morph(state, &text_outlines)?;
            let path_morph = planned_cubic_bezier_path_morph(state)?;
            let shape_morph = planned_shape_morph(state)?;
            let geometry = match state.kind {
                StudioAuthoringEntityKind::Arc => {
                    let (radius, angles) = studio_arc_parameters(state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::ShapeOutline {
                        path: studio_arc_path(radius, angles),
                    }
                }
                StudioAuthoringEntityKind::Arrow => CreateSceneEntityGeometry::Arrow,
                StudioAuthoringEntityKind::Axes
                | StudioAuthoringEntityKind::NumberLine
                | StudioAuthoringEntityKind::NumberPlane => {
                    let (width, height, coordinates) =
                        studio_coordinate_system_parameters(state.kind, state.initial_dimensions)
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let path =
                        studio_coordinate_system_path(state.kind, width, height, coordinates)
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::ShapeOutline { path }
                }
                StudioAuthoringEntityKind::DataPlot => {
                    let series = state
                        .spec
                        .data_series
                        .as_ref()
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let path = studio_data_plot_path(state.initial_dimensions, series)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::ShapeOutline { path }
                }
                StudioAuthoringEntityKind::Circle => {
                    if let Some(morph) = &shape_morph {
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: morph.initial_path.clone(),
                        }
                    } else {
                        let size =
                            studio_authoring_shape_size(state.kind, state.initial_dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        CreateSceneEntityGeometry::Circle {
                            radius: size.width / 2.0,
                        }
                    }
                }
                StudioAuthoringEntityKind::CubicBezier => {
                    let curve = state
                        .cubic_bezier
                        .as_ref()
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::CubicBezier {
                        appearance: studio_cubic_bezier_appearance(&curve.spec),
                        path: path_morph
                            .as_ref()
                            .map_or_else(|| curve.path.clone(), |morph| morph.initial_path.clone()),
                    }
                }
                StudioAuthoringEntityKind::Ellipse => {
                    if let Some(morph) = &shape_morph {
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: morph.initial_path.clone(),
                        }
                    } else {
                        let (width, height) = studio_ellipse_parameters(state.initial_dimensions)
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: studio_ellipse_path(width, height),
                        }
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
                    if let Some(morph) = &shape_morph {
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: morph.initial_path.clone(),
                        }
                    } else {
                        let dimensions =
                            canonical_studio_rectangle_dimensions(state.initial_dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        if dimensions.corner_radius.is_some_and(|radius| radius > 0.0) {
                            CreateSceneEntityGeometry::ShapeOutline {
                                path: studio_creation_shape_path(StudioCreationShapeState {
                                    dimensions,
                                    kind: StudioAuthoringEntityKind::Rectangle,
                                })?,
                            }
                        } else {
                            let size = studio_authoring_shape_size(state.kind, dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                            CreateSceneEntityGeometry::Rectangle {
                                height: size.height,
                                width: size.width,
                            }
                        }
                    }
                }
                StudioAuthoringEntityKind::RegularPolygon => {
                    if let Some(morph) = &shape_morph {
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: morph.initial_path.clone(),
                        }
                    } else {
                        let (sides, radius) =
                            studio_regular_polygon_parameters(state.initial_dimensions)
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        CreateSceneEntityGeometry::ShapeOutline {
                            path: studio_regular_polygon_path(sides, radius),
                        }
                    }
                }
                StudioAuthoringEntityKind::Sector => {
                    let (radius, angles) = studio_arc_parameters(state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::ShapeOutline {
                        path: studio_sector_path(radius, angles),
                    }
                }
                StudioAuthoringEntityKind::SvgPath => {
                    let svg = state
                        .svg_path
                        .as_ref()
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::SvgPath {
                        appearance: svg.appearance.clone(),
                        path: svg.path.clone(),
                    }
                }
                StudioAuthoringEntityKind::MathTex | StudioAuthoringEntityKind::Text
                    if state.write_interval.is_some() =>
                {
                    CreateSceneEntityGeometry::LogicalGroup
                }
                StudioAuthoringEntityKind::MathTex => {
                    if let Some(morph) = &math_tex_morph {
                        CreateSceneEntityGeometry::CubicOutline {
                            path: morph.initial_path.clone(),
                        }
                    } else {
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
                }
                StudioAuthoringEntityKind::Text => {
                    let initial = studio_creation_spec_text_content(&state.spec)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let outline = exact_text_outline(
                        &text_outlines,
                        &state.spec.id,
                        &initial.text,
                        &initial.layout,
                    )
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::TextOutline {
                        path: scale_cubic_path(&outline.path, initial.layout.font_size),
                    }
                }
                StudioAuthoringEntityKind::Other => {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
            };
            let rounded_rectangle = rectangle_resize_requires_path_geometry(state);
            let animated_resize = state
                .animated_resize
                .as_ref()
                .map(|resize| {
                    let path_dimensions = state
                        .shape_path_dimensions
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let base_size = studio_authoring_shape_size(resize.shape, path_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    let transform = |dimensions: StudioAuthoringDimensions, position: &PointV1| {
                        let size = studio_authoring_shape_size(resize.shape, dimensions)
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        let position = studio_point_to_scene_point(
                            position,
                            frame,
                            viewport,
                            &self.scene().camera.view.center,
                        );
                        let (scale_x, scale_y) = if rounded_rectangle {
                            (state.scale, state.scale)
                        } else {
                            (
                                state.scale * size.width / base_size.width,
                                state.scale * size.height / base_size.height,
                            )
                        };
                        Ok::<_, ApplyStudioCreationEditError>(AffineTransformV1 {
                            m11: scale_x,
                            m12: 0.0,
                            m21: 0.0,
                            m22: scale_y,
                            tx: position.x,
                            ty: position.y,
                        })
                    };
                    Ok::<_, ApplyStudioCreationEditError>(CreateSceneEntityAnimatedResize {
                        interval: resize.interval.clone(),
                        from: transform(resize.from_dimensions, &resize.from_position)?,
                        to: transform(resize.to_dimensions, &resize.to_position)?,
                    })
                })
                .transpose()?;
            let instant_transform = if let Some(at) = state
                .instant_at
                .filter(|_| planned_studio_creation_has_affine_instant(state))
            {
                let (x_ratio, y_ratio) = if rounded_rectangle {
                    (1.0, 1.0)
                } else {
                    match state.kind {
                        StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::Rectangle => {
                            let current_shape = state
                                .current_shape
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                            let path_dimensions = state
                                .shape_path_dimensions
                                .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                            let initial =
                                studio_authoring_shape_size(current_shape.kind, path_dimensions)
                                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                            let current = studio_authoring_shape_size(
                                current_shape.kind,
                                state.current_dimensions,
                            )
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                            (
                                current.width / initial.width,
                                current.height / initial.height,
                            )
                        }
                        StudioAuthoringEntityKind::Arc
                        | StudioAuthoringEntityKind::Arrow
                        | StudioAuthoringEntityKind::Axes
                        | StudioAuthoringEntityKind::CubicBezier
                        | StudioAuthoringEntityKind::DataPlot
                        | StudioAuthoringEntityKind::Ellipse
                        | StudioAuthoringEntityKind::Image
                        | StudioAuthoringEntityKind::Line
                        | StudioAuthoringEntityKind::MathTex
                        | StudioAuthoringEntityKind::NumberLine
                        | StudioAuthoringEntityKind::NumberPlane
                        | StudioAuthoringEntityKind::RegularPolygon
                        | StudioAuthoringEntityKind::Sector
                        | StudioAuthoringEntityKind::SvgPath
                        | StudioAuthoringEntityKind::Text => (1.0, 1.0),
                        StudioAuthoringEntityKind::Other => {
                            return Err(ApplyStudioCreationEditError::Unsupported);
                        }
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
            let stroke_width_world = state.stroke_width_world_override;
            if stroke_width_world.is_some() && !studio_creation_supports_stroke_width(state.kind) {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            let stroke_cap = state.stroke_cap_override;
            if stroke_cap.is_some() && !studio_creation_supports_stroke_cap(state.kind) {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            let stroke_dash = state.stroke_dash_override;
            let stroke_join = state.stroke_join_override;
            if stroke_join.is_some() && !studio_creation_supports_stroke_join(state) {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            let write_in = match (&state.write_interval, &state.write_easing) {
                (Some(interval), Some(easing)) => Some(match state.kind {
                    StudioAuthoringEntityKind::MathTex => {
                        let source = state
                            .spec
                            .tex_parts
                            .as_ref()
                            .map(|parts| parts.join(" "))
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        let outline = segmented_math_tex_outlines
                            .iter()
                            .find(|outline| {
                                outline.entity_id == state.spec.id && outline.source == source
                            })
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        math_tex_write_in(outline, &source, interval, easing)?
                    }
                    StudioAuthoringEntityKind::Text => {
                        let content = studio_creation_spec_text_content(&state.spec)
                            .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        let outline = exact_text_outline(
                            &text_outlines,
                            &state.spec.id,
                            &content.text,
                            &content.layout,
                        )
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                        text_write_in(outline, content.layout.font_size, interval, easing)?
                    }
                    _ => return Err(ApplyStudioCreationEditError::Unsupported),
                }),
                (None, None) => None,
                (Some(_), None) | (None, Some(_)) => {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
            };
            entities.push(CreateSceneEntity {
                animated_resize,
                appearance_at: state.appearance_at,
                draw_in: state
                    .draw_interval
                    .as_ref()
                    .zip(state.draw_easing.as_ref())
                    .map(|(interval, easing)| CreateSceneEntityDrawIn {
                        easing: easing.clone(),
                        end: interval.end,
                    }),
                fade_in: state
                    .fade_interval
                    .as_ref()
                    .map(|interval| CreateSceneEntityFadeIn { end: interval.end }),
                fill_color,
                geometry,
                id: state.spec.id.clone(),
                instant_transform,
                lifetime: state.lifetime.clone(),
                material_parameter_tracks: state.material_parameter_tracks.clone(),
                math_tex_morph,
                opacity_keyframes: state.opacity_keyframes.clone(),
                paint_color_track: state.paint_color_track.clone(),
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
                path_morph,
                shape_morph,
                stroke_color,
                stroke_cap,
                stroke_dash,
                stroke_join,
                stroke_width_world,
                text_morph,
                visible: state.visible,
                write_in,
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
                initial_position: Some(studio_point_to_scene_point(
                    &motion.from,
                    frame,
                    viewport,
                    &self.scene().camera.view.center,
                )),
                interval: motion.interval.clone(),
                orient_to_path: motion.orient_to_path,
                target_entity_ids: vec![motion.target_entity_id.clone()],
            })
            .collect();
        let spatial_context = StudioCreationSpatialContext {
            camera_center: self.scene().camera.view.center.clone(),
            frame,
            viewport,
        };
        let path_motions = plan
            .path_motions
            .iter()
            .map(|motion| CreateScenePathMotion {
                easing: motion.easing,
                interval: motion.interval.clone(),
                path_entity_id: motion.path_entity_id.clone(),
                pixel_size_world: PointV1 {
                    x: frame.width / viewport.width,
                    y: frame.height / viewport.height,
                },
                target_entity_id: motion.target_entity_id.clone(),
            })
            .collect();
        let operation_count = programs
            .iter()
            .map(|program| program.operations.len())
            .sum::<usize>();
        let creation_projection = plan
            .projection(Some(spatial_context))
            .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
        let mut result = self.create_scene_entities(CreateSceneEntitiesCommand {
            camera_animation: plan.camera_animation,
            entities,
            expected_base_revision,
            groups: plan.groups,
            motions,
            path_motions,
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
            scene_background: plan.scene_background,
            timeline_insertions: plan.timeline_insertions,
        })?;
        result.creation_projection = Some(creation_projection);
        Ok(result)
    }
}
